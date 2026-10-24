// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * decompose-client.ts
 *
 * Optional model-based question decomposition for `retrieve_for_answer`
 * (MCP) and `POST /v2/retrieve`. One chat-completions call asks a model to
 * cut a question into short search queries. Anything unusable — a timeout,
 * an unreachable or failing server, an answer that is not a JSON array of
 * usable strings — yields `undefined`, and the caller falls back to the
 * rule-based split. The feature is off until RETRIEVE_DECOMPOSE_URL and
 * RETRIEVE_DECOMPOSE_MODEL are configured.
 *
 * The answer cache follows the HyDE client: process-local, bounded,
 * time-limited, keyed by tenant so hits are never shared across tenants.
 */

import type pino from "pino";
import { z } from "zod";
import { scopedCacheKey } from "./query-cache.js";
import { injectTraceHeaders } from "./trace-context.js";
import { recordUsage } from "./usage-context.js";

export interface DecomposeClientConfig {
  /** Full chat-completions URL (RETRIEVE_DECOMPOSE_URL). */
  url: string;
  /** Model id for the decomposition call (RETRIEVE_DECOMPOSE_MODEL). */
  model: string;
  /**
   * Optional Bearer token. When set, sent as `Authorization: Bearer <token>`
   * on the HTTP request (RETRIEVE_DECOMPOSE_TOKEN).
   */
  token?: string | null;
  logger: pino.Logger;
  /** Per-call timeout in ms (RETRIEVE_DECOMPOSE_TIMEOUT_MS). Default 4000. */
  timeoutMs?: number;
  /** Completion cap in tokens (RETRIEVE_DECOMPOSE_MAX_TOKENS). Default 200. */
  maxTokens?: number;
  /**
   * How long a decomposition result is reused for the identical tenant,
   * sub-query limit and question, in ms. 0 disables the cache. The same TTL
   * knob as the HyDE expansion cache (HYDE_CACHE_TTL_SECONDS).
   */
  cacheTtlMs?: number;
  /** Upper bound of cached decompositions (oldest evicted first). Default 256. */
  cacheMaxEntries?: number;
}

export interface DecomposeClient {
  /**
   * Model-generated search queries covering `question` — at most
   * `maxSubqueries` long, duplicates removed — or `undefined` when the call
   * failed or its answer is unusable. `tenantId` is the caller's tenant; the
   * cache binds entries to it so hits are never shared across tenants.
   */
  decompose(
    question: string,
    maxSubqueries: number,
    tenantId?: string,
  ): Promise<string[] | undefined>;
}

/** The model must answer with a JSON array of strings, each a usable query. */
const answerSchema = z.array(z.string().min(3).max(200));

function systemPrompt(maxSubqueries: number): string {
  return `Split the user's question into at most ${maxSubqueries} short, self-contained search queries that together cover it. Keep the user's language and identifiers verbatim. Answer with a JSON array of strings only.`;
}

/**
 * Parse a chat-completions answer into sub-queries: a JSON array of strings
 * of 3–200 characters, trimmed, duplicates removed, at most `maxSubqueries`.
 * `null` when the answer is unusable in any way.
 */
function parseAnswer(content: unknown, maxSubqueries: number): string[] | null {
  if (typeof content !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const checked = answerSchema.safeParse(parsed);
  if (!checked.success) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of checked.data) {
    const text = part.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxSubqueries) break;
  }
  return out.length > 0 ? out : null;
}

export function createDecomposeClient(
  config: DecomposeClientConfig,
): DecomposeClient {
  const {
    url,
    model,
    token = null,
    logger,
    timeoutMs = 4000,
    maxTokens = 200,
  } = config;

  async function callModel(
    question: string,
    maxSubqueries: number,
  ): Promise<string[] | undefined> {
    const controller = new AbortController();
    // timeoutMs=0 disables the timeout (useful for local dev with slow models).
    const timer =
      timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    let response: Response;
    try {
      const fetchHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) fetchHeaders["Authorization"] = `Bearer ${token}`;
      injectTraceHeaders(fetchHeaders);
      response = await fetch(url, {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt(maxSubqueries) },
            { role: "user", content: question },
          ],
          max_tokens: maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      logger.debug({ cause }, "Decomposition model unreachable");
      return undefined;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      logger.debug(
        { status: response.status },
        "Decomposition model returned an HTTP error",
      );
      return undefined;
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (cause) {
      logger.debug({ cause }, "Decomposition model returned invalid JSON");
      return undefined;
    }

    const shaped = data as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = shaped?.choices?.[0]?.message?.content;
    const parts = parseAnswer(content, maxSubqueries);
    if (parts === null) {
      logger.debug("Decomposition model answer unusable");
      return undefined;
    }
    const prompt = systemPrompt(maxSubqueries);
    const inputTokens =
      shaped.usage?.prompt_tokens ??
      Math.ceil((question.length + prompt.length) / 4);
    const outputTokens =
      shaped.usage?.completion_tokens ?? Math.ceil((content?.length ?? 0) / 4);
    recordUsage(inputTokens, outputTokens, 0, model);
    logger.debug(
      { questionLen: question.length, parts: parts.length },
      "Decomposition model answer used",
    );
    return parts;
  }

  const cacheTtlMs = Math.max(0, config.cacheTtlMs ?? 600_000);
  if (cacheTtlMs === 0) {
    return {
      decompose: (question, maxSubqueries) =>
        callModel(question, maxSubqueries),
    };
  }

  // Process-local, bounded, time-limited — like the HyDE expansion cache.
  // The key binds tenant and sub-query limit to the question text, so one
  // tenant cannot observe from latency whether another tenant asked the same
  // question, and a different limit is a different answer.
  const maxEntries = Math.max(1, config.cacheMaxEntries ?? 256);
  const cache = new Map<string, { parts: string[]; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string[] | undefined>>();
  return {
    async decompose(
      question,
      maxSubqueries,
      tenantId?: string,
    ): Promise<string[] | undefined> {
      const now = Date.now();
      // sha256 over tenantId, maxSubqueries and question, NUL-separated
      const key = scopedCacheKey(
        tenantId,
        `${maxSubqueries}\u0000${question}`,
      );
      const hit = cache.get(key);
      if (hit !== undefined) {
        if (hit.expiresAt > now) {
          // Re-insert: Map order doubles as LRU order.
          cache.delete(key);
          cache.set(key, hit);
          return hit.parts;
        }
        cache.delete(key);
      }
      const pending = inFlight.get(key);
      if (pending !== undefined) {
        // Same question already being decomposed: share the call, and the cost.
        return pending;
      }
      const call = callModel(question, maxSubqueries);
      inFlight.set(key, call);
      try {
        const parts = await call;
        if (parts !== undefined) {
          cache.set(key, {
            parts,
            expiresAt: Date.now() + cacheTtlMs,
          });
          while (cache.size > maxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
        return parts;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
