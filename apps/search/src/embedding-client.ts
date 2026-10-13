// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type pino from "pino";
import { retryWithBackoff, type CircuitBreaker } from "./retry.js";
import { injectTraceHeaders } from "./trace-context.js";
import { recordUsage } from "./usage-context.js";

export interface EmbeddingClientConfig {
  /**
   * Full URL of the embeddings endpoint (e.g. "http://localhost:8080/v1/embeddings").
   * No path suffix is appended automatically — configure the exact URL you want.
   * If it starts with 'bedrock' (e.g. 'bedrock' or 'bedrock://us-east-1'), Bedrock client will be used.
   */
  embedUrl: string;
  embedModel: string;
  /**
   * Name of the JSON field used to pass texts in embedding requests.
   * TEI expects "inputs"; OpenAI-compatible servers expect "input".
   * Default: "inputs".
   */
  inputField?: string;
  logger: pino.Logger;
  timeoutMs?: number;
  /** Optional circuit breaker shared across all calls from this client. */
  circuitBreaker?: CircuitBreaker;
  /**
   * Optional function that returns the current request's correlation ID.
   * When provided, the ID is forwarded in the X-Request-Id header on every
   * outbound call so downstream service logs can be correlated.
   */
  getRequestId?: () => string | undefined;
  inputTokenCost?: number;
  outputTokenCost?: number;
}

export interface EmbeddingResult {
  vector: number[];
  usage?: { inputTokens: number; outputTokens: number; cost: number };
}

export interface EmbeddingBatchResult {
  vectors: number[][];
  usage?: { inputTokens: number; outputTokens: number; cost: number };
}

export interface EmbeddingError {
  code:
    | "LLM_UNREACHABLE"
    | "LLM_HTTP_ERROR"
    | "LLM_INVALID_RESPONSE"
    | "LLM_TIMEOUT";
  message: string;
  cause?: unknown;
}

export type EmbeddingResponse =
  | { ok: true; result: EmbeddingResult }
  | { ok: false; error: EmbeddingError };

export type EmbeddingBatchResponse =
  | { ok: true; result: EmbeddingBatchResult }
  | { ok: false; error: EmbeddingError };

export interface EmbeddingClient {
  embed(text: string, signal?: AbortSignal): Promise<EmbeddingResponse>;
  /**
   * Embed multiple texts in a single HTTP round-trip.
   * The returned vectors are in the same order as the input texts.
   */
  embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatchResponse>;
}

function invalidEmbeddingError(message: string): EmbeddingError {
  return { code: "LLM_INVALID_RESPONSE", message };
}

function validateVectors(
  vectors: number[][],
  expectedCount: number,
  expectedDimension?: number,
): EmbeddingError | null {
  if (vectors.length !== expectedCount) {
    return invalidEmbeddingError(
      `Embedding response returned ${vectors.length} vectors for ${expectedCount} inputs`,
    );
  }
  if (expectedCount === 0) return null;

  const dimension = vectors[0]?.length ?? 0;
  if (dimension === 0) {
    return invalidEmbeddingError("Embedding response returned an empty vector");
  }
  if (expectedDimension !== undefined && dimension !== expectedDimension) {
    return invalidEmbeddingError(
      `Embedding response dimension ${dimension} does not match expected dimension ${expectedDimension}`,
    );
  }
  for (const [vectorIndex, vector] of vectors.entries()) {
    if (vector.length !== dimension) {
      return invalidEmbeddingError(
        `Embedding response vector ${vectorIndex} has inconsistent dimension ${vector.length}; expected ${dimension}`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      return invalidEmbeddingError(
        `Embedding response vector ${vectorIndex} contains a non-finite value`,
      );
    }
  }
  return null;
}

/**
 * Decorates two complete embedding clients with primary-first failover.
 * A batch is always served wholly by one client; caller cancellation never
 * starts fallback work.
 */
export function createFallbackEmbeddingClient(
  primary: EmbeddingClient,
  fallback: EmbeddingClient,
  logger: pino.Logger,
  expectedDimension?: number,
): EmbeddingClient {
  function logFallback(reason: string, inputCount: number): void {
    logger.warn(
      { reason, inputCount },
      "Primary embedding provider failed; trying fallback embedding provider",
    );
  }

  return {
    async embed(text: string, signal?: AbortSignal): Promise<EmbeddingResponse> {
      const primaryResult = await primary.embed(text, signal);
      const primaryError = primaryResult.ok
        ? validateVectors([primaryResult.result.vector], 1, expectedDimension)
        : primaryResult.error;
      if (primaryError === null) return primaryResult;
      if (signal?.aborted) return { ok: false, error: primaryError };

      logFallback(primaryError.code, 1);
      const fallbackResult = await fallback.embed(text, signal);
      if (!fallbackResult.ok) return fallbackResult;
      const fallbackError = validateVectors(
        [fallbackResult.result.vector],
        1,
        expectedDimension,
      );
      if (fallbackError !== null) {
        logger.warn(
          { reason: fallbackError.code, inputCount: 1 },
          "Fallback embedding provider returned an invalid response",
        );
        return { ok: false, error: fallbackError };
      }
      return fallbackResult;
    },

    async embedBatch(
      texts: string[],
      signal?: AbortSignal,
    ): Promise<EmbeddingBatchResponse> {
      const primaryResult = await primary.embedBatch(texts, signal);
      const primaryError = primaryResult.ok
        ? validateVectors(
            primaryResult.result.vectors,
            texts.length,
            expectedDimension,
          )
        : primaryResult.error;
      if (primaryError === null) return primaryResult;
      if (signal?.aborted) return { ok: false, error: primaryError };

      logFallback(primaryError.code, texts.length);
      const fallbackResult = await fallback.embedBatch(texts, signal);
      if (!fallbackResult.ok) return fallbackResult;
      const fallbackError = validateVectors(
        fallbackResult.result.vectors,
        texts.length,
        expectedDimension,
      );
      if (fallbackError !== null) {
        logger.warn(
          { reason: fallbackError.code, inputCount: texts.length },
          "Fallback embedding provider returned an invalid response",
        );
        return { ok: false, error: fallbackError };
      }
      return fallbackResult;
    },
  };
}

export function createEmbeddingClient(
  config: EmbeddingClientConfig,
): EmbeddingClient {
  const {
    embedUrl,
    embedModel,
    inputField = "inputs",
    logger,
    timeoutMs = 30_000,
    circuitBreaker,
    getRequestId,
    inputTokenCost = 0,
    outputTokenCost = 0,
  } = config;
  // embedUrl is used as-is — no path suffix is appended automatically.
  const url = embedUrl;

  const isBedrock = embedUrl?.startsWith("bedrock") ?? false;
  let bedrockClient: BedrockRuntimeClient | null = null;
  if (isBedrock && embedUrl) {
    let region: string | undefined;
    if (embedUrl.includes("://")) {
      region = embedUrl.split("://")[1]?.split("/")[0] || undefined;
    }
    bedrockClient = new BedrockRuntimeClient({ region });
  }

  async function callEmbeddings(
    input: string | string[],
    externalSignal?: AbortSignal,
  ): Promise<EmbeddingBatchResponse> {
    if (externalSignal?.aborted) {
      return { ok: false, error: { code: "LLM_TIMEOUT", message: "Embedding request aborted" } };
    }
    if (bedrockClient) {
      const controller = new AbortController();
      const signal = externalSignal
        ? AbortSignal.any([controller.signal, externalSignal])
        : controller.signal;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;
      try {
        const texts = Array.isArray(input) ? input : [input];
        let vectors: number[][];
        let inputTokens = 0;
        const outputTokens = 0;
        if (embedModel.startsWith("cohere.")) {
          const res = await bedrockClient.send(
            new InvokeModelCommand({
              modelId: embedModel,
              contentType: "application/json",
              accept: "application/json",
              body: JSON.stringify({
                texts,
                input_type: "search_document",
              }),
            }),
            { abortSignal: signal },
          );
          const resBody = JSON.parse(new TextDecoder().decode(res.body));
          vectors = resBody.embeddings;
          inputTokens =
            resBody.response_metadata?.token_count ??
            texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0);
        } else {
          // Titan or other models requiring single inputs
          vectors = await Promise.all(
            texts.map(async (text) => {
              const res = await bedrockClient.send(
                new InvokeModelCommand({
                  modelId: embedModel,
                  contentType: "application/json",
                  accept: "application/json",
                  body: JSON.stringify({
                    inputText: text,
                  }),
                }),
                { abortSignal: signal },
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
        const cost =
          (inputTokens * inputTokenCost + outputTokens * outputTokenCost) /
          1_000_000;
        recordUsage(inputTokens, outputTokens, cost, embedModel);
        logger.debug(
          { count: vectors.length, dim: vectors[0]?.length, inputTokens, cost },
          "Bedrock embeddings generated",
        );
        return {
          ok: true,
          result: {
            vectors,
            usage: { inputTokens, outputTokens, cost },
          },
        };
      } catch (cause) {
        clearTimeout(timer);
        const isTimeout = cause instanceof Error && cause.name === "AbortError";
        logger.debug({ cause }, "Bedrock embedding call failed");
        return {
          ok: false,
          error: {
            code: isTimeout ? "LLM_TIMEOUT" : "LLM_HTTP_ERROR",
            message: isTimeout
              ? `Bedrock embedding request timed out after ${timeoutMs}ms`
              : `Bedrock embedding request failed: ${cause instanceof Error ? cause.message : cause}`,
            cause,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    }
    const controller = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal;
    // timeoutMs=0 disables the timeout (useful for local dev with slow models).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const reqId = getRequestId?.();
    if (reqId) headers["X-Request-Id"] = reqId;
    // Forward W3C Trace Context and correlation ID so downstream service logs
    // can be joined with the application log entry for this request.
    injectTraceHeaders(headers);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: embedModel, [inputField]: input }),
        signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      const isTimeout = cause instanceof Error && cause.name === "AbortError";
      logger.debug({ cause }, "Embedding server unreachable");
      return {
        ok: false,
        error: {
          code: isTimeout ? "LLM_TIMEOUT" : "LLM_UNREACHABLE",
          message: isTimeout
            ? `Embedding request timed out after ${timeoutMs}ms`
            : `Embedding server is not reachable at ${embedUrl}`,
          cause,
        },
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.debug({ status: response.status, body }, "LLM HTTP error");
      return {
        ok: false,
        error: {
          code: "LLM_HTTP_ERROR",
          message: `LLM returned HTTP ${response.status}`,
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
          code: "LLM_INVALID_RESPONSE",
          message: "LLM returned invalid JSON",
          cause,
        },
      };
    }

    // Auto-detect response format:
    //   - OpenAI-compatible: { "object": "list", "data": [...] }
    //   - TEI / direct array:  [ { "embedding": [...] }, ... ]
    let rows: unknown[];
    if (Array.isArray(data)) {
      // Direct array format (e.g. TEI)
      rows = data;
    } else if (
      typeof data === "object" &&
      data !== null &&
      "data" in data &&
      Array.isArray((data as Record<string, unknown>)["data"])
    ) {
      // Wrapped object format (e.g. OpenAI-compatible)
      rows = (data as { data: unknown[] }).data;
    } else {
      return {
        ok: false,
        error: {
          code: "LLM_INVALID_RESPONSE",
          message:
            'LLM response is neither a direct array nor an object with a "data" array',
        },
      };
    }

    if (rows.length === 0) {
      return {
        ok: false,
        error: {
          code: "LLM_INVALID_RESPONSE",
          message: "LLM returned empty data array",
        },
      };
    }
    const vectors: number[][] = [];

    // Sort by index to ensure correct order when server reorders.
    // Each row is either:
    //   - an object with { embedding: number[], index?: number }  (OpenAI-compatible)
    //   - a plain number[]  (TEI direct-array format)
    const indexed = rows.map((row, i) => ({
      idx:
        !Array.isArray(row) &&
        typeof (row as { index?: unknown }).index === "number"
          ? (row as { index: number }).index
          : i,
      row,
    }));
    indexed.sort((a, b) => a.idx - b.idx);

    for (const { row, idx } of indexed) {
      // TEI direct-array: each row is already a number[]
      if (Array.isArray(row)) {
        vectors.push(row as number[]);
        continue;
      }
      // OpenAI-compatible: { embedding: number[] }
      if (
        typeof row !== "object" ||
        row === null ||
        !("embedding" in row) ||
        !Array.isArray((row as { embedding: unknown }).embedding)
      ) {
        return {
          ok: false,
          error: {
            code: "LLM_INVALID_RESPONSE",
            message: `LLM response data[${idx}].embedding is missing or not an array`,
          },
        };
      }
      vectors.push((row as { embedding: number[] }).embedding);
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
    recordUsage(inputTokens, outputTokens, cost, embedModel);

    logger.debug(
      { count: vectors.length, dim: vectors[0]?.length, inputTokens, cost },
      "Embeddings generated",
    );
    return {
      ok: true,
      result: {
        vectors,
        usage: { inputTokens, outputTokens, cost },
      },
    };
  }

  function isRetryable(res: EmbeddingBatchResponse): boolean {
    return (
      !res.ok &&
      (res.error.code === "LLM_UNREACHABLE" || res.error.code === "LLM_TIMEOUT")
    );
  }

  return {
    async embed(text: string, signal?: AbortSignal): Promise<EmbeddingResponse> {
      // Caller-owned cancellation is not downstream unhealthiness: do not retry
      // it and do not let it increment/open the process-wide circuit breaker.
      const batchResult = await retryWithBackoff(
        () => callEmbeddings(text, signal),
        (result) => !signal?.aborted && isRetryable(result),
        3,
        100,
        signal ? undefined : circuitBreaker,
      );
      if (!batchResult.ok) return batchResult;
      const vector = batchResult.result.vectors[0];
      if (!vector) {
        return {
          ok: false,
          error: {
            code: "LLM_INVALID_RESPONSE",
            message: "LLM returned empty data array",
          },
        };
      }
      return { ok: true, result: { vector, usage: batchResult.result.usage } };
    },

    async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingBatchResponse> {
      if (texts.length === 0) return { ok: true, result: { vectors: [] } };
      return retryWithBackoff(
        () => callEmbeddings(texts, signal),
        (result) => !signal?.aborted && isRetryable(result),
        3,
        100,
        signal ? undefined : circuitBreaker,
      );
    },
  };
}
