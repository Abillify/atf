// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type pino from "pino";
import { retryWithBackoff, type CircuitBreaker } from "./retry.js";
import { injectTraceHeaders } from "./trace-context.js";
import { recordUsage } from "./usage-context.js";

export interface SparseEmbeddingClientConfig {
  /** If it starts with 'bedrock' (e.g. 'bedrock' or 'bedrock://us-east-1'), Bedrock client will be used. */
  url: string;
  model: string;
  /**
   * Vocabulary size of the SPLADE model (e.g. 30522 for BERT-based models).
   * Required to format the pgvector sparsevec type.
   */
  vocabSize: number;
  /**
   * Minimum absolute weight to keep when converting dense SPLADE output to
   * sparse format.  Values below this are treated as zero.
   */
  threshold?: number;
  logger: pino.Logger;
  timeoutMs?: number;
  /** Optional circuit breaker shared across all calls from this client. */
  circuitBreaker?: CircuitBreaker;
  inputTokenCost?: number;
  outputTokenCost?: number;
}

export interface SparseVector {
  /** Non-zero indices (0-based). */
  indices: number[];
  /** Corresponding weights, same order as `indices`. */
  values: number[];
  /** Total vocabulary dimension. */
  dim: number;
}

/**
 * Format a SparseVector as a pgvector sparsevec literal: `{1:0.5,45:1.2}/30522`.
 *
 * `SparseVector.indices` are 0-based (array positions of the dense source);
 * pgvector `sparsevec` literals use 1-based indices, so the conversion
 * happens here at the database boundary.
 */
export function sparseVectorToPg(sv: SparseVector): string {
  if (sv.indices.length === 0) return `{}/${sv.dim}`;
  const pairs = sv.indices
    .map((idx, i) => `${idx + 1}:${sv.values[i]}`)
    .join(",");
  return `{${pairs}}/${sv.dim}`;
}

export interface SparseEmbeddingError {
  code:
    | "SPARSE_UNREACHABLE"
    | "SPARSE_HTTP_ERROR"
    | "SPARSE_INVALID_RESPONSE"
    | "SPARSE_TIMEOUT";
  message: string;
  cause?: unknown;
}

export type SparseEmbeddingResponse =
  | {
      ok: true;
      result: SparseVector;
      usage?: { inputTokens: number; outputTokens: number; cost: number };
    }
  | { ok: false; error: SparseEmbeddingError };

export type SparseEmbeddingBatchResponse =
  | {
      ok: true;
      result: SparseVector[];
      usage?: { inputTokens: number; outputTokens: number; cost: number };
    }
  | { ok: false; error: SparseEmbeddingError };

export interface SparseEmbeddingClient {
  embedSparse(text: string): Promise<SparseEmbeddingResponse>;
  embedSparseBatch(texts: string[]): Promise<SparseEmbeddingBatchResponse>;
}

export function createSparseEmbeddingClient(
  config: SparseEmbeddingClientConfig,
): SparseEmbeddingClient {
  const {
    url,
    model,
    vocabSize,
    logger,
    timeoutMs = 30_000,
    circuitBreaker,
    inputTokenCost = 0,
    outputTokenCost = 0,
  } = config;
  const threshold = config.threshold ?? 0.0001;
  // url is used as-is — no path suffix is appended automatically.
  const endpoint = url;

  const isBedrock = url?.startsWith("bedrock") ?? false;
  let bedrockClient: BedrockRuntimeClient | null = null;
  if (isBedrock && url) {
    let region: string | undefined;
    if (url.includes("://")) {
      region = url.split("://")[1]?.split("/")[0] || undefined;
    }
    bedrockClient = new BedrockRuntimeClient({ region });
  }

  function denseToSparse(dense: number[]): SparseVector {
    const indices: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < dense.length; i++) {
      const v = dense[i] as number;
      if (Math.abs(v) > threshold) {
        indices.push(i);
        values.push(v);
      }
    }
    return { indices, values, dim: vocabSize };
  }

  async function callEmbeddings(
    input: string | string[],
  ): Promise<SparseEmbeddingBatchResponse> {
    if (bedrockClient) {
      const controller = new AbortController();
      const timer =
        timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;
      try {
        const texts = Array.isArray(input) ? input : [input];
        let denseVectors: number[][];
        let inputTokens = 0;
        let outputTokens = 0;
        if (model.startsWith("cohere.")) {
          const res = await bedrockClient.send(
            new InvokeModelCommand({
              modelId: model,
              contentType: "application/json",
              accept: "application/json",
              body: JSON.stringify({
                texts,
                input_type: "search_document",
              }),
            }),
            { abortSignal: controller.signal as any },
          );
          const resBody = JSON.parse(new TextDecoder().decode(res.body));
          denseVectors = resBody.embeddings;
          inputTokens =
            resBody.response_metadata?.token_count ??
            texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0);
        } else {
          denseVectors = await Promise.all(
            texts.map(async (text) => {
              const res = await bedrockClient!.send(
                new InvokeModelCommand({
                  modelId: model,
                  contentType: "application/json",
                  accept: "application/json",
                  body: JSON.stringify({
                    inputText: text,
                  }),
                }),
                { abortSignal: controller.signal as any },
              );
              const resBody = JSON.parse(new TextDecoder().decode(res.body));
              if (typeof resBody.inputTextTokenCount === "number") {
                inputTokens += resBody.inputTextTokenCount;
              } else {
                inputTokens += Math.ceil(text.length / 4);
              }
              return resBody.embedding;
            }),
          );
        }
        const vectors = denseVectors.map(denseToSparse);
        const cost =
          (inputTokens * inputTokenCost + outputTokens * outputTokenCost) /
          1_000_000;
        recordUsage(inputTokens, outputTokens, cost, model);
        logger.debug(
          { count: vectors.length, vocabSize, inputTokens, cost },
          "Bedrock sparse embeddings generated",
        );
        return {
          ok: true,
          result: vectors,
          usage: { inputTokens, outputTokens, cost },
        };
      } catch (cause) {
        clearTimeout(timer);
        const isTimeout = cause instanceof Error && cause.name === "AbortError";
        logger.debug({ cause }, "Bedrock sparse embedding call failed");
        return {
          ok: false,
          error: {
            code: isTimeout ? "SPARSE_TIMEOUT" : "SPARSE_UNREACHABLE",
            message: isTimeout
              ? `Bedrock sparse embedding timed out after ${timeoutMs}ms`
              : `Bedrock sparse embedding failed: ${cause instanceof Error ? cause.message : cause}`,
            cause,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    }
    const controller = new AbortController();
    // timeoutMs=0 disables the timeout (useful for local dev with slow models).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;

    let response: Response;
    try {
      const fetchHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      injectTraceHeaders(fetchHeaders);
      response = await fetch(endpoint, {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify({ model, input }),
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      const isTimeout = cause instanceof Error && cause.name === "AbortError";
      logger.debug({ cause }, "Sparse embedding server unreachable");
      return {
        ok: false,
        error: {
          code: isTimeout ? "SPARSE_TIMEOUT" : "SPARSE_UNREACHABLE",
          message: isTimeout
            ? `Sparse embedding timed out after ${timeoutMs}ms`
            : `Sparse embedding server not reachable at ${url}`,
          cause,
        },
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        error: {
          code: "SPARSE_HTTP_ERROR",
          message: `Sparse embedding server returned HTTP ${response.status}: ${body.slice(0, 200)}`,
        },
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: "SPARSE_INVALID_RESPONSE",
          message: "Sparse server returned invalid JSON",
          cause,
        },
      };
    }

    if (
      typeof data !== "object" ||
      data === null ||
      !("data" in data) ||
      !Array.isArray((data as Record<string, unknown>)["data"])
    ) {
      return {
        ok: false,
        error: {
          code: "SPARSE_INVALID_RESPONSE",
          message: 'Sparse server response missing "data" array',
        },
      };
    }

    const rows = (data as { data: unknown[] }).data;
    const indexed = rows.map((row, i) => ({
      idx:
        typeof (row as { index?: unknown }).index === "number"
          ? (row as { index: number }).index
          : i,
      row,
    }));
    indexed.sort((a, b) => a.idx - b.idx);

    const vectors: SparseVector[] = [];
    for (const { row, idx } of indexed) {
      if (
        typeof row !== "object" ||
        row === null ||
        !("embedding" in row) ||
        !Array.isArray((row as { embedding: unknown }).embedding)
      ) {
        return {
          ok: false,
          error: {
            code: "SPARSE_INVALID_RESPONSE",
            message: `data[${idx}].embedding missing`,
          },
        };
      }
      const dense = (row as { embedding: number[] }).embedding;
      vectors.push(denseToSparse(dense));
    }

    let inputTokens = 0;
    let outputTokens = 0;
    const estimatedInputTokens = (Array.isArray(input) ? input : [input]).reduce(
      (acc, t) => acc + Math.ceil(t.length / 4),
      0,
    );
    if (typeof data === "object" && data !== null && "usage" in data) {
      const usageObj = (
        data as {
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        }
      ).usage;
      inputTokens = usageObj?.prompt_tokens ?? estimatedInputTokens;
      outputTokens = usageObj?.completion_tokens ?? 0;
    } else {
      inputTokens = estimatedInputTokens;
    }
    const cost =
      (inputTokens * inputTokenCost + outputTokens * outputTokenCost) /
      1_000_000;
    recordUsage(inputTokens, outputTokens, cost, model);

    logger.debug(
      { count: vectors.length, vocabSize, inputTokens, cost },
      "Sparse embeddings generated",
    );
    return {
      ok: true,
      result: vectors,
      usage: { inputTokens, outputTokens, cost },
    };
  }

  function isRetryable(res: SparseEmbeddingBatchResponse): boolean {
    return (
      !res.ok &&
      (res.error.code === "SPARSE_UNREACHABLE" ||
        res.error.code === "SPARSE_TIMEOUT")
    );
  }

  return {
    async embedSparse(text) {
      const res = await retryWithBackoff(
        () => callEmbeddings(text),
        isRetryable,
        3,
        100,
        circuitBreaker,
      );
      if (!res.ok) return res;
      const sv = res.result[0];
      if (!sv)
        return {
          ok: false,
          error: {
            code: "SPARSE_INVALID_RESPONSE",
            message: "Empty data array",
          },
        };
      return {
        ok: true,
        result: sv,
        usage: res.usage,
      };
    },

    async embedSparseBatch(texts) {
      if (texts.length === 0) return { ok: true, result: [] };
      return retryWithBackoff(
        () => callEmbeddings(texts),
        isRetryable,
        3,
        100,
        circuitBreaker,
      );
    },
  };
}
