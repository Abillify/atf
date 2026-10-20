// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type pino from "pino";
import { retryWithBackoff, type CircuitBreaker } from "./retry.js";
import { injectTraceHeaders } from "./trace-context.js";
import { recordUsage } from "./usage-context.js";

export interface HydeClientConfig {
  /**
   * URL of the chat-completions server. If it starts with 'bedrock' (e.g. 'bedrock' or 'bedrock://us-east-1'), Bedrock client will be used.
   */
  url: string;
  model: string;
  /**
   * Maximum tokens for the generated hypothetical document.
   * Shorter = faster, longer = more context.  Default: 256.
   */
  maxTokens?: number;
  /**
   * Enable model thinking/reasoning for OpenAI-compatible requests.
   * Ignored on the Bedrock code path. Default: false.
   */
  enableThinking?: boolean;
  /**
   * Optional Bearer token. When set, sent as `Authorization: Bearer <token>`
   * on the HTTP request (OpenAI-compatible servers such as aiperator).
   * Ignored on the Bedrock code path.
   */
  token?: string | null;
  /**
   * System prompt used when generating the hypothetical document.
   * If omitted, a sensible default is used.
   */
  systemPrompt?: string;
  logger: pino.Logger;
  timeoutMs?: number;
  /** Optional circuit breaker shared across all calls from this client. */
  circuitBreaker?: CircuitBreaker;
  inputTokenCost?: number;
  outputTokenCost?: number;
  /**
   * How long a generated hypothetical document is reused for the identical
   * query, in ms (HYDE_CACHE_TTL_SECONDS). 0/undefined disables the cache.
   * The expansion is one LLM round-trip in front of every embedding, and
   * agentic callers repeat the same query within a run. Only successful
   * results are cached; concurrent identical requests share one call.
   */
  cacheTtlMs?: number;
  /** Upper bound of cached expansions (oldest evicted first). Default 256. */
  cacheMaxEntries?: number;
}

export interface HydeError {
  code:
    | "HYDE_UNREACHABLE"
    | "HYDE_HTTP_ERROR"
    | "HYDE_INVALID_RESPONSE"
    | "HYDE_TIMEOUT";
  message: string;
  cause?: unknown;
}

export type HydeResponse =
  | {
      ok: true;
      result: string;
      usage?: { inputTokens: number; outputTokens: number; cost: number };
    }
  | { ok: false; error: HydeError };

export interface HydeClient {
  /**
   * Generate a hypothetical document that would answer `query`.
   * The returned text is then embedded and used as the search vector instead
   * of the raw query (HyDE — Hypothetical Document Embeddings, Gao et al. 2022).
   */
  expand(query: string): Promise<HydeResponse>;
}

const DEFAULT_SYSTEM_PROMPT =
  "Write a short document (2–4 sentences) that directly answers the following query. " +
  "Be factual and precise. Do not include the question itself.";

export function createHydeClient(config: HydeClientConfig): HydeClient {
  const {
    url,
    model,
    maxTokens = 256,
    enableThinking = false,
    token,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    logger,
    timeoutMs = 30_000,
    circuitBreaker,
    inputTokenCost = 0,
    outputTokenCost = 0,
  } = config;

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

  async function doExpand(query: string): Promise<HydeResponse> {
    if (bedrockClient) {
      const controller = new AbortController();
      const timer =
        timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;
      try {
        const command = new ConverseCommand({
          modelId: model,
          messages: [{ role: "user", content: [{ text: query }] }],
          system: systemPrompt ? [{ text: systemPrompt }] : undefined,
          inferenceConfig: {
            maxTokens: maxTokens,
            temperature: 0.0,
          },
        });
        const res = await bedrockClient.send(command, {
          abortSignal: controller.signal,
        });
        const text = res.output?.message?.content?.[0]?.text;
        if (typeof text !== "string" || text.trim() === "") {
          return {
            ok: false,
            error: {
              code: "HYDE_INVALID_RESPONSE",
              message: "Bedrock response missing text content",
            },
          };
        }
        const inputTokens = res.usage?.inputTokens ?? Math.ceil(query.length / 4) + Math.ceil(systemPrompt.length / 4);
        const outputTokens = res.usage?.outputTokens ?? Math.ceil(text.length / 4);
        const cost = (inputTokens * inputTokenCost + outputTokens * outputTokenCost) / 1_000_000;
        recordUsage(inputTokens, outputTokens, cost, model);
        logger.debug(
          { queryLen: query.length, hydeLen: text.length, inputTokens, outputTokens, cost },
          "Bedrock HyDE expansion generated",
        );
        return { ok: true, result: text, usage: { inputTokens, outputTokens, cost } };
      } catch (cause) {
        clearTimeout(timer);
        const isTimeout = cause instanceof Error && cause.name === "AbortError";
        logger.debug({ cause }, "Bedrock HyDE call failed");
        return {
          ok: false,
          error: {
            code: isTimeout ? "HYDE_TIMEOUT" : "HYDE_HTTP_ERROR",
            message: isTimeout
              ? `Bedrock HyDE request timed out after ${timeoutMs}ms`
              : `Bedrock HyDE request failed: ${cause instanceof Error ? cause.message : cause}`,
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
      if (token) fetchHeaders["Authorization"] = `Bearer ${token}`;
      injectTraceHeaders(fetchHeaders);
      response = await fetch(endpoint, {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: query },
          ],
          max_tokens: maxTokens,
          chat_template_kwargs: { enable_thinking: enableThinking },
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      const isTimeout = cause instanceof Error && cause.name === "AbortError";
      logger.debug({ cause }, "HyDE server unreachable");
      return {
        ok: false,
        error: {
          code: isTimeout ? "HYDE_TIMEOUT" : "HYDE_UNREACHABLE",
          message: isTimeout
            ? `HyDE request timed out after ${timeoutMs}ms`
            : `HyDE server not reachable at ${url}`,
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
          code: "HYDE_HTTP_ERROR",
          message: `HyDE server returned HTTP ${response.status}: ${body.slice(0, 200)}`,
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
          code: "HYDE_INVALID_RESPONSE",
          message: "HyDE server returned invalid JSON",
          cause,
        },
      };
    }

    const text = (
      data as { choices?: Array<{ message?: { content?: string } }> }
    )?.choices?.[0]?.message?.content;

    if (typeof text !== "string" || text.trim() === "") {
      return {
        ok: false,
        error: {
          code: "HYDE_INVALID_RESPONSE",
          message: "HyDE response missing text content",
        },
      };
    }

    let inputTokens = 0;
    let outputTokens = 0;
    const estimatedInputTokens = Math.ceil(query.length / 4) + Math.ceil(systemPrompt.length / 4);
    const estimatedOutputTokens = Math.ceil(text.length / 4);
    if (typeof data === "object" && data !== null && "usage" in data) {
      const usageObj = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      inputTokens = usageObj?.prompt_tokens ?? estimatedInputTokens;
      outputTokens = usageObj?.completion_tokens ?? estimatedOutputTokens;
    } else {
      inputTokens = estimatedInputTokens;
      outputTokens = estimatedOutputTokens;
    }
    const cost = (inputTokens * inputTokenCost + outputTokens * outputTokenCost) / 1_000_000;
    recordUsage(inputTokens, outputTokens, cost, model);

    logger.debug(
      { queryLen: query.length, hydeLen: text.length, inputTokens, outputTokens, cost },
      "HyDE expansion generated",
    );
    return { ok: true, result: text, usage: { inputTokens, outputTokens, cost } };
  }

  function expandUncached(query: string): Promise<HydeResponse> {
    return retryWithBackoff(
      () => doExpand(query),
      (res) =>
        !res.ok &&
        (res.error.code === "HYDE_UNREACHABLE" ||
          res.error.code === "HYDE_TIMEOUT"),
      3,
      100,
      circuitBreaker,
    );
  }

  const cacheTtlMs = Math.max(0, config.cacheTtlMs ?? 0);
  if (cacheTtlMs === 0) return { expand: expandUncached };

  // Process-local, bounded, time-limited. The expansion depends on the query
  // text only (no tenant data goes in), so a hit is safe for any caller.
  const maxEntries = Math.max(1, config.cacheMaxEntries ?? 256);
  const cache = new Map<string, { text: string; expiresAt: number }>();
  const inFlight = new Map<string, Promise<HydeResponse>>();
  return {
    async expand(query: string): Promise<HydeResponse> {
      const now = Date.now();
      const hit = cache.get(query);
      if (hit !== undefined) {
        if (hit.expiresAt > now) {
          // Re-insert: Map order doubles as LRU order.
          cache.delete(query);
          cache.set(query, hit);
          return { ok: true, result: hit.text };
        }
        cache.delete(query);
      }
      const pending = inFlight.get(query);
      if (pending !== undefined) {
        // Same query already being expanded: share the call, and the cost.
        const shared = await pending;
        return shared.ok ? { ok: true, result: shared.result } : shared;
      }
      const call = expandUncached(query);
      inFlight.set(query, call);
      try {
        const res = await call;
        if (res.ok) {
          cache.set(query, { text: res.result, expiresAt: Date.now() + cacheTtlMs });
          while (cache.size > maxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
        }
        return res;
      } finally {
        inFlight.delete(query);
      }
    },
  };
}
