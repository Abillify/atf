// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/src/reranker-client.ts
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type pino from "pino";
import { retryWithBackoff, type CircuitBreaker } from "./retry.js";
import { injectTraceHeaders } from "./trace-context.js";
import { recordUsage } from "./usage-context.js";

export interface RerankerClientConfig {
  /**
   * Full URL of the reranker endpoint (e.g. "http://localhost:8080/rerank").
   * No path suffix is appended automatically — configure the exact URL you want.
   * If it starts with 'bedrock' (e.g. 'bedrock' or 'bedrock://us-east-1'), Bedrock client will be used.
   */
  rerankUrl: string;
  /** Reranker model name, e.g. "bge-reranker-v2-m3" or "cohere.rerank-v3-5:0". */
  rerankModel: string;
  /**
   * Which endpoint to use:
   *
   * "rerank" (default) — POST to rerankUrl
   *   Native cross-encoder endpoint. Works with Infinity (michaelf34/infinity),
   *   llama-server (--pooling rank --reranking), and TEI. Returns relevance_score
   *   or score per document, sigmoid-normalized to [0, 1].
   *
   * "embeddings" — POST to rerankUrl
   *   Ollama-compatible fallback. Auto-detects the model's mode from the response:
   *   - 1-dim output → rank-pooling cross-encoder (sigmoid score)
   *   - N-dim output → bi-encoder (dot-product + min-max normalization)
   *   Mode is cached after the first successful call to avoid repeated probing.
   */
  endpoint: "embeddings" | "rerank";
  /**
   * Separator inserted between query and document in the cross-encoder pair.
   * Only used in "embeddings" mode. Defaults to "\n".
   */
  separator: string;
  /**
   * Name of the JSON field used to pass documents in native rerank requests.
   * TEI expects "texts"; OpenAI-compatible servers expect "documents".
   * Default: "texts".
   */
  documentsField: string;
  logger: pino.Logger;
  /** Abort fetch calls after this many milliseconds. Default: 30 000. */
  timeoutMs?: number;
  /** Optional circuit breaker shared across all calls from this client. */
  circuitBreaker?: CircuitBreaker;
  inputTokenCost?: number;
  outputTokenCost?: number;
}

export interface RerankScore {
  /** Index into the original documents array this score belongs to. */
  index: number;
  /** Relevance score in [0, 1]. */
  score: number;
}

export interface RerankError {
  code: "RERANK_UNREACHABLE" | "RERANK_HTTP_ERROR" | "RERANK_INVALID_RESPONSE";
  message: string;
  cause?: unknown;
}

export type RerankResponse =
  | {
      ok: true;
      result: RerankScore[];
      usage?: { inputTokens: number; outputTokens: number; cost?: number };
    }
  | { ok: false; error: RerankError };

export interface RerankerClient {
  /**
   * Score each document against the query using the configured reranker model.
   *
   * Supports two endpoint modes (set via `RerankerClientConfig.endpoint`):
   *
   * **"rerank" mode** (default — Infinity, llama-server, TEI):
   *   POST /rerank — native cross-encoder endpoint. Auto-detects response format:
   *   - TEI: direct array [ { "index": 0, "score": 0.9 }, ... ]
   *   - OpenAI-compatible: { "results": [ { "index": 0, "relevance_score": 1.2 }, ... ] }
   *   TEI also does not accept a "model" field — detected automatically on first call.
   *
   * **"embeddings" mode** (Ollama-compatible fallback):
   *   POST /v1/embeddings — auto-detects the model's output dimensionality:
   *   - 1-dim → rank-pooling cross-encoder (sigmoid of the raw logit)
   *   - N-dim → bi-encoder (dot-product between query and doc embeddings,
   *             min-max normalized to [0, 1])
   *
   *   Detection is performed once on first call and cached for the lifetime of
   *   the client instance.
   */
  rerank(query: string, documents: string[]): Promise<RerankResponse>;
}

// ─── Math helpers ────────────────────────────────────────────────────────────

/** Clamp an already-normalized score to the public [0, 1] contract. */
function clampScore(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Numerically stable logistic sigmoid: maps a raw logit to (0, 1). */
function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Dot product of two equal-length vectors. */
function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/**
 * Min-max normalize an array of scores to [0, 1].
 * If all scores are identical the function returns 1.0 for every element
 * (the documents are equally relevant — no information to rank on).
 */
function minMaxNormalize(scores: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  const range = max - min;
  if (range === 0) return scores.map(() => 1.0);
  return scores.map((s) => (s - min) / range);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

interface EmbeddingRow {
  index?: number;
  embedding: number[];
}

/**
 * Call the embeddings endpoint and return the embedding rows, sorted by their
 * `index` field (ascending). Auto-detects response format:
 *   - OpenAI-compatible: { "data": [ { "embedding": [...] }, ... ] }
 *   - TEI direct array:  [ { "embedding": [...] }, ... ]
 */
async function fetchEmbeddings(
  url: string,
  model: string,
  inputs: string | string[],
  timeoutMs: number,
): Promise<
  | {
      ok: true;
      rows: EmbeddingRow[];
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { ok: false; error: RerankError }
> {
  const controller = new AbortController();
  // timeoutMs=0 disables the timeout (useful for local dev with slow models).
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  let response: Response;
  try {
    const fetchHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    injectTraceHeaders(fetchHeaders);
    response = await fetch(url, {
      method: "POST",
      headers: fetchHeaders,
      body: JSON.stringify({ model, input: inputs }),
      signal: controller.signal,
    });
  } catch (cause) {
    clearTimeout(timer);
    const isTimeout = cause instanceof Error && cause.name === "AbortError";
    return {
      ok: false,
      error: {
        code: "RERANK_UNREACHABLE",
        message: isTimeout
          ? `Reranker timed out after ${timeoutMs}ms`
          : `Reranker not reachable at ${url}`,
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
        code: "RERANK_HTTP_ERROR",
        message: `Reranker returned HTTP ${response.status}: ${body.slice(0, 200)}`,
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
        code: "RERANK_INVALID_RESPONSE",
        message: "Reranker returned invalid JSON",
        cause,
      },
    };
  }

  // Auto-detect response format:
  //   - OpenAI-compatible: { "object": "list", "data": [...] }
  //   - TEI / direct array:  [ { "embedding": [...] }, ... ]
  let rawRows: Array<{ index?: number; embedding?: unknown }>;
  if (Array.isArray(data)) {
    rawRows = data as Array<{ index?: number; embedding?: unknown }>;
  } else if (
    typeof data === "object" &&
    data !== null &&
    "data" in data &&
    Array.isArray((data as Record<string, unknown>)["data"])
  ) {
    rawRows = (data as { data: Array<{ index?: number; embedding?: unknown }> })
      .data;
  } else {
    return {
      ok: false,
      error: {
        code: "RERANK_INVALID_RESPONSE",
        message:
          'Reranker response is neither a direct array nor an object with a "data" array',
      },
    };
  }

  const rows: EmbeddingRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!Array.isArray(row?.embedding)) {
      return {
        ok: false,
        error: {
          code: "RERANK_INVALID_RESPONSE",
          message: `data[${i}].embedding is not an array`,
        },
      };
    }
    rows.push({
      index: typeof row?.index === "number" ? row.index : i,
      embedding: row.embedding as number[],
    });
  }

  rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  let inputTokens = 0;
  let outputTokens = 0;
  const estimatedInputTokens = (Array.isArray(inputs) ? inputs : [inputs]).reduce(
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

  return {
    ok: true,
    rows,
    usage: { inputTokens, outputTokens },
  };
}

// ─── Client factory ───────────────────────────────────────────────────────────

export function createFallbackRerankerClient(
  primary: RerankerClient,
  fallback: RerankerClient,
  logger: pino.Logger,
): RerankerClient {
  return {
    async rerank(query: string, documents: string[]): Promise<RerankResponse> {
      const primaryResult = await primary.rerank(query, documents);
      if (primaryResult.ok && primaryResult.result.length > 0) {
        return primaryResult;
      }

      if (primaryResult.ok) {
        logger.debug(
          "Primary reranker returned no results; trying fallback reranker",
        );
      } else {
        logger.warn(
          { code: primaryResult.error.code },
          "Primary reranker failed; trying fallback reranker",
        );
      }

      const fallbackResult = await fallback.rerank(query, documents);
      if (!fallbackResult.ok) {
        logger.warn(
          { code: fallbackResult.error.code },
          "Fallback reranker failed; preserving retrieval order",
        );
        return fallbackResult;
      }
      if (fallbackResult.result.length === 0) {
        logger.debug(
          "Fallback reranker returned no results; preserving retrieval order",
        );
      }
      return fallbackResult;
    },
  };
}

export function createRerankerClient(
  config: RerankerClientConfig,
): RerankerClient {
  const {
    rerankUrl,
    rerankModel,
    separator,
    endpoint,
    documentsField = "texts",
    logger,
    timeoutMs = 30_000,
    circuitBreaker,
    inputTokenCost = 0,
    outputTokenCost = 0,
  } = config;
  // rerankUrl is used as-is for both modes — configure the exact endpoint URL.

  const isBedrock = rerankUrl?.startsWith("bedrock") ?? false;
  let bedrockClient: BedrockRuntimeClient | null = null;
  if (isBedrock && rerankUrl) {
    let region: string | undefined;
    if (rerankUrl.includes("://")) {
      region = rerankUrl.split("://")[1]?.split("/")[0] || undefined;
    }
    bedrockClient = new BedrockRuntimeClient({ region });
  }

  // Cached mode after first successful "embeddings" probe (null = not yet detected).
  let detectedMode: "rank-pooling" | "bi-encoder" | null = null;

  function isRetryable(res: RerankResponse): boolean {
    return !res.ok && res.error.code === "RERANK_UNREACHABLE";
  }

  const RERANK_BATCH_SIZE = 16;

  return {
    async rerank(query: string, documents: string[]): Promise<RerankResponse> {
      if (documents.length === 0) {
        return { ok: true, result: [] };
      }

      if (bedrockClient) {
        const invokeBedrock = async (): Promise<RerankResponse> => {
          const controller = new AbortController();
          const timer =
            timeoutMs > 0
              ? setTimeout(() => controller.abort(), timeoutMs)
              : undefined;
          try {
            const res = await bedrockClient.send(
              new InvokeModelCommand({
                modelId: rerankModel,
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify({
                  api_version: 2,
                  query,
                  documents,
                  top_n: documents.length,
                }),
              }),
              { abortSignal: controller.signal as any },
            );
            const resBody = JSON.parse(new TextDecoder().decode(res.body));
            const results = resBody.results as Array<{
              index: number;
              relevance_score: number;
            }>;
            const scores = results.map((r) => ({
              index: r.index,
              score: sigmoid(r.relevance_score),
            }));
            const inputTokens =
              resBody.meta?.tokens?.input_tokens ??
              Math.ceil(query.length / 4) +
                documents.reduce((acc, d) => acc + Math.ceil(d.length / 4), 0);
            const outputTokens = resBody.meta?.tokens?.output_tokens ?? 0;
            const cost =
              (inputTokens * inputTokenCost + outputTokens * outputTokenCost) /
              1_000_000;
            recordUsage(inputTokens, outputTokens, cost, rerankModel);
            logger.debug(
              { count: scores.length, inputTokens, outputTokens, cost },
              "Bedrock rerank completed",
            );
            return {
              ok: true,
              result: scores,
              usage: { inputTokens, outputTokens, cost },
            };
          } catch (cause) {
            const isTimeout =
              cause instanceof Error && cause.name === "AbortError";
            logger.debug({ cause }, "Bedrock rerank failed");
            return {
              ok: false,
              error: {
                code: isTimeout ? "RERANK_UNREACHABLE" : "RERANK_HTTP_ERROR",
                message: isTimeout
                  ? `Bedrock reranker timed out after ${timeoutMs}ms`
                  : `Bedrock reranker failed: ${cause instanceof Error ? cause.message : cause}`,
                cause,
              },
            };
          } finally {
            clearTimeout(timer);
          }
        };
        return retryWithBackoff(
          invokeBedrock,
          isRetryable,
          3,
          100,
          circuitBreaker,
        );
      }

      // Split into batches of RERANK_BATCH_SIZE to avoid overloading the server.
      if (documents.length > RERANK_BATCH_SIZE) {
        const allScores: RerankScore[] = [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCost = 0;
        let hasUsage = false;
        for (
          let offset = 0;
          offset < documents.length;
          offset += RERANK_BATCH_SIZE
        ) {
          const batch = documents.slice(offset, offset + RERANK_BATCH_SIZE);
          const batchResult = await rerankBatch(query, batch, offset);
          if (!batchResult.ok) return batchResult;
          allScores.push(...batchResult.result);
          if (batchResult.usage) {
            hasUsage = true;
            totalInputTokens += batchResult.usage.inputTokens;
            totalOutputTokens += batchResult.usage.outputTokens;
            totalCost += batchResult.usage.cost ?? 0;
          }
        }
        return {
          ok: true,
          result: allScores,
          ...(hasUsage
            ? {
                usage: {
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  cost: totalCost,
                },
              }
            : {}),
        };
      }

      return rerankBatch(query, documents, 0);
    },
  };

  async function rerankBatch(
    query: string,
    documents: string[],
    indexOffset: number,
  ): Promise<RerankResponse> {
    // Helper to shift returned score indices back to global positions.
    function applyOffset(res: RerankResponse): RerankResponse {
      if (!res.ok) return res;
      if (res.usage) {
        const inputTokens = res.usage.inputTokens;
        const outputTokens = res.usage.outputTokens;
        const cost =
          (inputTokens * inputTokenCost + outputTokens * outputTokenCost) /
          1_000_000;
        recordUsage(inputTokens, outputTokens, cost, rerankModel);
        return {
          ok: true,
          result: res.result.map((s) => ({
            ...s,
            index: s.index + indexOffset,
          })),
          usage: { inputTokens, outputTokens, cost },
        };
      }
      return {
        ok: true,
        result: res.result.map((s) => ({ ...s, index: s.index + indexOffset })),
      };
    }

    // ── /v1/rerank mode (Infinity, llama-server, TEI) ──────────────────────
    if (endpoint === "rerank") {
      const res = await retryWithBackoff(
        () =>
          rerankViaNativeEndpoint(
            rerankUrl,
            rerankModel,
            query,
            documents,
            documentsField,
            logger,
            timeoutMs,
          ),
        isRetryable,
        3,
        100,
        circuitBreaker,
      );
      return applyOffset(res);
    }

    // ── /v1/embeddings mode — use cached mode if already detected ──────────
    if (detectedMode === "rank-pooling") {
      const res = await retryWithBackoff(
        () =>
          rerankViaRankPooling(
            rerankUrl,
            rerankModel,
            query,
            documents,
            separator,
            logger,
            timeoutMs,
          ),
        isRetryable,
        3,
        100,
        circuitBreaker,
      );
      return applyOffset(res);
    }
    if (detectedMode === "bi-encoder") {
      const res = await retryWithBackoff(
        () =>
          rerankViaBiEncoder(
            rerankUrl,
            rerankModel,
            query,
            documents,
            logger,
            timeoutMs,
          ),
        isRetryable,
        3,
        100,
        circuitBreaker,
      );
      return applyOffset(res);
    }

    // ── First call: probe with query only to detect mode ───────────────────
    const probe = await fetchEmbeddings(
      rerankUrl,
      rerankModel,
      query,
      timeoutMs,
    );
    if (!probe.ok) {
      logger.debug({ error: probe.error }, "Reranker mode probe failed");
      return { ok: false, error: probe.error };
    }

    const probeDim = probe.rows[0]?.embedding.length ?? 0;

    if (probeDim === 1) {
      detectedMode = "rank-pooling";
      logger.debug(
        { mode: "rank-pooling" },
        "Reranker mode detected and cached",
      );
      const res = await rerankViaRankPooling(
        rerankUrl,
        rerankModel,
        query,
        documents,
        separator,
        logger,
        timeoutMs,
      );
      return applyOffset(res);
    }

    // Bi-encoder: reuse the query vector we already have from the probe.
    detectedMode = "bi-encoder";
    logger.debug(
      { dim: probeDim, mode: "bi-encoder" },
      "Reranker mode detected and cached",
    );
    const queryVec = probe.rows[0]!.embedding;
    const res = await rerankViaBiEncoderWithQueryVec(
      rerankUrl,
      rerankModel,
      queryVec,
      documents,
      logger,
      timeoutMs,
    );
    return applyOffset(res);
  }
}

// ─── /v1/rerank implementation ────────────────────────────────────────────────

/**
 * POST to a native rerank endpoint. Supports two response formats:
 *   - OpenAI-compatible: { "results": [ { "index": 0, "relevance_score": 1.2 }, ... ] }
 *   - TEI direct array:  [ { "index": 0, "score": 0.9 }, ... ]
 */
async function rerankViaNativeEndpoint(
  url: string,
  model: string,
  query: string,
  documents: string[],
  documentsField: string,
  logger: pino.Logger,
  timeoutMs: number,
): Promise<RerankResponse> {
  const controller = new AbortController();
  // timeoutMs=0 disables the timeout (useful for local dev with slow models).
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

  let response: Response;
  try {
    const fetchHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    injectTraceHeaders(fetchHeaders);
    response = await fetch(url, {
      method: "POST",
      headers: fetchHeaders,
      body: JSON.stringify({ model, query, [documentsField]: documents }),
      signal: controller.signal,
    });
  } catch (cause) {
    clearTimeout(timer);
    const isTimeout = cause instanceof Error && cause.name === "AbortError";
    logger.debug({ cause }, "Reranker unreachable");
    return {
      ok: false,
      error: {
        code: "RERANK_UNREACHABLE",
        message: isTimeout
          ? `Reranker timed out after ${timeoutMs}ms`
          : `Reranker not reachable at ${url}`,
        cause,
      },
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.debug({ status: response.status, body }, "Reranker HTTP error");
    return {
      ok: false,
      error: {
        code: "RERANK_HTTP_ERROR",
        message: `Reranker returned HTTP ${response.status}: ${body.slice(0, 200)}`,
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
        code: "RERANK_INVALID_RESPONSE",
        message: "Reranker returned invalid JSON",
        cause,
      },
    };
  }

  // Auto-detect response format:
  //   - OpenAI-compatible: { "results": [{ "index": 0, "relevance_score": 1.2 }, ...] }
  //   - TEI direct array:  [ { "index": 0, "score": 0.9 }, ... ]
  let rows: Array<{
    index?: number;
    relevance_score?: unknown;
    score?: unknown;
  }>;
  if (Array.isArray(data)) {
    rows = data as typeof rows;
  } else if (
    typeof data === "object" &&
    data !== null &&
    "results" in data &&
    Array.isArray((data as Record<string, unknown>)["results"])
  ) {
    rows = (
      data as { results: Array<{ index?: number; relevance_score?: unknown }> }
    ).results;
  } else {
    return {
      ok: false,
      error: {
        code: "RERANK_INVALID_RESPONSE",
        message:
          'Reranker response is neither a direct array nor an object with a "results" array',
      },
    };
  }

  const scores: RerankScore[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // TEI uses "score"; OpenAI-compatible uses "relevance_score"
    const rawScore = row?.score ?? row?.relevance_score;
    if (typeof rawScore !== "number") {
      return {
        ok: false,
        error: {
          code: "RERANK_INVALID_RESPONSE",
          message: `results[${i}] has no numeric "score" or "relevance_score"`,
        },
      };
    }
    scores.push({
      index: typeof row?.index === "number" ? row.index : i,
      score:
        typeof row?.score === "number"
          ? clampScore(row.score)
          : sigmoid(rawScore),
    });
  }

  let inputTokens =
    Math.ceil(query.length / 4) +
    documents.reduce((acc, d) => acc + Math.ceil(d.length / 4), 0);
  let outputTokens = 0;
  if (typeof data === "object" && data !== null && "meta" in data) {
    const metaObj = (
      data as {
        meta?: {
          tokens?: { input_tokens?: number; output_tokens?: number };
        };
      }
    ).meta;
    if (metaObj?.tokens) {
      inputTokens = metaObj.tokens.input_tokens ?? inputTokens;
      outputTokens = metaObj.tokens.output_tokens ?? outputTokens;
    }
  }

  logger.debug(
    { count: scores.length, mode: "native-rerank", inputTokens, outputTokens },
    "Reranker scored documents",
  );
  return {
    ok: true,
    result: scores,
    usage: { inputTokens, outputTokens },
  };
}

// ─── /v1/embeddings rank-pooling mode ────────────────────────────────────────

async function rerankViaRankPooling(
  embeddingsUrl: string,
  rerankModel: string,
  query: string,
  documents: string[],
  separator: string,
  logger: pino.Logger,
  timeoutMs: number,
): Promise<RerankResponse> {
  const inputs = documents.map((doc) => `${query}${separator}${doc}`);
  const batchResult = await fetchEmbeddings(
    embeddingsUrl,
    rerankModel,
    inputs,
    timeoutMs,
  );
  if (!batchResult.ok) return { ok: false, error: batchResult.error };

  const scores: RerankScore[] = batchResult.rows.map((row) => ({
    index: row.index ?? 0,
    score: sigmoid(row.embedding[0] as number),
  }));

  logger.debug(
    { count: scores.length, mode: "rank-pooling" },
    "Reranker scored documents",
  );
  return { ok: true, result: scores, usage: batchResult.usage };
}

// ─── /v1/embeddings bi-encoder mode ──────────────────────────────────────────

async function rerankViaBiEncoder(
  embeddingsUrl: string,
  rerankModel: string,
  query: string,
  documents: string[],
  logger: pino.Logger,
  timeoutMs: number,
): Promise<RerankResponse> {
  const queryResult = await fetchEmbeddings(
    embeddingsUrl,
    rerankModel,
    query,
    timeoutMs,
  );
  if (!queryResult.ok) return { ok: false, error: queryResult.error };
  const queryVec = queryResult.rows[0]?.embedding;
  if (!queryVec) {
    return {
      ok: false,
      error: {
        code: "RERANK_INVALID_RESPONSE",
        message: "Empty query embedding",
      },
    };
  }
  return rerankViaBiEncoderWithQueryVec(
    embeddingsUrl,
    rerankModel,
    queryVec,
    documents,
    logger,
    timeoutMs,
    queryResult.usage,
  );
}

async function rerankViaBiEncoderWithQueryVec(
  embeddingsUrl: string,
  rerankModel: string,
  queryVec: number[],
  documents: string[],
  logger: pino.Logger,
  timeoutMs: number,
  queryUsage?: { inputTokens: number; outputTokens: number },
): Promise<RerankResponse> {
  const docResult = await fetchEmbeddings(
    embeddingsUrl,
    rerankModel,
    documents,
    timeoutMs,
  );
  if (!docResult.ok) return { ok: false, error: docResult.error };

  const dim = queryVec.length;
  const docVec = docResult.rows[0]?.embedding;
  if (docVec && docVec.length !== dim) {
    return {
      ok: false,
      error: {
        code: "RERANK_INVALID_RESPONSE",
        message: `Query embedding dim (${dim}) does not match document dim (${docVec.length})`,
      },
    };
  }

  const rawScores = docResult.rows.map((row) => dot(queryVec, row.embedding));
  const normalized = minMaxNormalize(rawScores);

  const scores: RerankScore[] = docResult.rows.map((row, i) => ({
    index: row.index ?? i,
    score: normalized[i] as number,
  }));

  const inputTokens =
    (queryUsage?.inputTokens ?? 0) + (docResult.usage?.inputTokens ?? 0);
  const outputTokens =
    (queryUsage?.outputTokens ?? 0) + (docResult.usage?.outputTokens ?? 0);

  logger.debug(
    { count: scores.length, mode: "bi-encoder", inputTokens, outputTokens },
    "Reranker scored documents",
  );
  return {
    ok: true,
    result: scores,
    usage: { inputTokens, outputTokens },
  };
}
