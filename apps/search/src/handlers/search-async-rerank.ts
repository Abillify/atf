// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/src/handlers/search-async-rerank.ts
//
// SSE-based async reranking.
//
// When the client sends `X-Rerank: async`, the handler:
//   1. Immediately returns HTTP 200 with Content-Type: text/event-stream
//   2. Sends `event: results` with the vector-search results (same shape as
//      the normal /search JSON response) — the client can start using these
//      right away, with zero reranking latency.
//   3. Runs the cross-encoder reranker in the background.
//   4. Sends `event: rerank` with the updated scores once available.
//   5. Sends `event: done` and closes the stream.
//
// On any reranker failure the stream still closes cleanly after `event: results`
// (with an optional `event: rerank_error` carrying the reason), so the client
// always gets at least the vector-search results.
//
// SSE event shapes
// ────────────────
// event: results
// data: { "results": SearchResult[] }
//
// event: rerank
// data: { "scores": Array<{ "id": string, "score": number, "vector_score": number }> }
//
// event: rerank_error
// data: { "error": string }
//
// event: done
// data: {}

import type pino from "pino";
import type { RerankerClient } from "../reranker-client.js";
import type { SearchResult } from "../postgres-client.js";
import type { Response } from "express";
import { getUsageContext } from "../usage-context.js";
import { buildRerankDocument } from "../rerank-context.js";

/** Serialise one SSE frame. */
function sseFrame(event: string, data: unknown, id?: string): string {
  const dataStr = JSON.stringify(data);
  return (id ? `id: ${id}\n` : "") + `event: ${event}\ndata: ${dataStr}\n\n`;
}

/** Write an SSE frame and flush if the underlying socket supports it. */
function writeFrame(
  res: Response,
  event: string,
  data: unknown,
  id?: string,
): void {
  res.write(sseFrame(event, data, id));
  // Express 5 / Node http.ServerResponse: flush if available (compression middleware).
  if (typeof (res as unknown as { flush?: () => void }).flush === "function") {
    (res as unknown as { flush: () => void }).flush();
  }
}

export interface AsyncRerankHandlerDeps {
  rerankerClient: RerankerClient;
  candidateMultiplier: number;
  logger: pino.Logger;
}

/**
 * Run the async-rerank SSE flow.
 *
 * Called by the search handler when `X-Rerank: async` is detected and a
 * reranker client is available. Takes ownership of the response — the caller
 * must not write to `res` after this returns.
 */
export async function runAsyncRerankStream(
  res: Response,
  query: string,
  candidates: SearchResult[],
  limit: number,
  deps: AsyncRerankHandlerDeps,
): Promise<void> {
  const { rerankerClient, logger } = deps;

  // Set SSE headers.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.status(200);

  // Event 1: immediate vector-search results (trimmed to requested limit).
  const initialResults = candidates.slice(0, limit);
  writeFrame(res, "results", { results: initialResults });

  // Nothing to rerank — close immediately.
  if (candidates.length <= 1) {
    writeFrame(res, "done", {});
    res.end();
    return;
  }

  // Event 2: rerank scores (async).
  try {
    // Context-enriched rerank input (title, section path, unit type + content,
    // capped at 1024 tokens) — same as the synchronous path (Req 13.1/13.2).
    const documents = candidates.map((r) => buildRerankDocument(r));
    const rerankResponse = await rerankerClient.rerank(query, documents);

    if (!rerankResponse.ok) {
      logger.warn({ error: rerankResponse.error }, "Async reranker failed");
      writeFrame(res, "rerank_error", { error: rerankResponse.error.message });
    } else {
      const reranked = rerankResponse.result
        .filter((s) => s.index >= 0 && s.index < candidates.length)
        .map((s) => {
          const original = candidates[s.index] as SearchResult;
          return {
            id: original.id,
            score: s.score,
            vector_score:
              typeof original.score === "number"
                ? original.score
                : parseFloat(original.score as unknown as string),
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (reranked.length === 0) {
        logger.warn("Async reranker returned no usable scores");
        writeFrame(res, "rerank_error", {
          error: "Reranker returned no usable scores",
        });
      } else {
        logger.debug({ count: reranked.length }, "Async rerank scores ready");
        writeFrame(res, "rerank", { scores: reranked });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "Unexpected error during async reranking");
    writeFrame(res, "rerank_error", { error: msg });
  }

  const usage = getUsageContext();
  if (usage) {
    writeFrame(res, "usage", {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_cost: usage.cost,
    });
  }

  writeFrame(res, "done", {});
  res.end();
}
