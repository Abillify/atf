// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * summary-client.ts
 *
 * LLM-based document summarization for ingest-time context prefix generation.
 *
 * When SUMMARY_MODEL is configured, the client generates a short summary of
 * each document via a chat-completions call. The summary is stored in the
 * `prefix` column of chunk 0, replacing the mechanical text-slice
 * approach of CHUNK_CONTEXT_PREFIX_SIZE.
 *
 * Activating per request: X-Summarize: true
 *
 * The summary is used as the context prefix for all non-first chunks
 * (prepended to their embedding input) and stored in chunk 0's
 * `prefix` column for later retrieval / brief ranking.
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type pino from "pino";
import { retryWithBackoff, type CircuitBreaker } from "./retry.js";
import { injectTraceHeaders } from "./trace-context.js";
import { recordUsage } from "./usage-context.js";

export interface SummaryClientConfig {
  /**
   * URL of the chat-completions server. If it starts with 'bedrock' (e.g. 'bedrock' or 'bedrock://us-east-1'), Bedrock client will be used.
   */
  url: string;
  model: string;
  /** Maximum tokens for the generated summary. Default: 256. */
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
  /** System prompt for summary generation. */
  systemPrompt?: string;
  logger: pino.Logger;
  timeoutMs?: number;
  /** Maximum number of concurrent summarization requests. Default: 4. */
  maxConcurrency?: number;
  /** Optional circuit breaker shared across all calls from this client. */
  circuitBreaker?: CircuitBreaker;
  inputTokenCost?: number;
  outputTokenCost?: number;
}

export interface SummaryError {
  code:
    | "SUMMARY_UNREACHABLE"
    | "SUMMARY_HTTP_ERROR"
    | "SUMMARY_INVALID_RESPONSE"
    | "SUMMARY_TIMEOUT";
  message: string;
  cause?: unknown;
}

export type SummaryResponse =
  | {
      ok: true;
      result: string;
      usage?: { inputTokens: number; outputTokens: number; cost: number };
    }
  | { ok: false; error: SummaryError };

export interface SummaryClient {
  /**
   * Generate a short summary of `text` suitable for use as a context prefix.
   * The summary is stored in chunk 0's `prefix` column and prepended
   * to the embedding input of all subsequent chunks.
   */
  summarize(text: string): Promise<SummaryResponse>;
  /**
   * Generate ONE short sentence placing `excerpt` within its document, given
   * the surrounding `context` (title / section path / page summary). Used by
   * the batch worker's CONTEXTUAL_CHUNK_LLM stage (Requirement 11.6) to enrich
   * a chunk's contextual embedding header. Reuses the SUMMARY_* text-LLM — no
   * separate endpoint. Same failure surface as {@link summarize}: on error the
   * caller degrades to the header without the sentence.
   */
  placeInContext(excerpt: string, context: string): Promise<SummaryResponse>;
}

const DEFAULT_SYSTEM_PROMPT =
  "Write a concise summary (2–4 sentences) of the following document. " +
  "Focus on the main topic, key points, and purpose. " +
  "Do not include meta-commentary about the document itself. " +
  "Always write the summary in the same language as the source document " +
  "(e.g. a German document gets a German summary, an English document an " +
  "English summary). Detect the language from the document text itself, " +
  "not from these instructions.";

/**
 * System prompt for the CONTEXTUAL_CHUNK_LLM placement sentence (Req 11.6).
 * Asks for exactly ONE short sentence situating the excerpt in the document,
 * given the header context the user message carries. Language-following mirrors
 * DEFAULT_SYSTEM_PROMPT so a German document gets a German sentence.
 */
const PLACEMENT_SYSTEM_PROMPT =
  "You situate a short excerpt within its larger document for retrieval. " +
  "Given the excerpt and its context (title, section, page summary), write " +
  "EXACTLY ONE short sentence stating what this excerpt is about and where it " +
  "sits in the document. Do not summarise the whole document, do not add " +
  "meta-commentary, output only the sentence. Write it in the same language as " +
  "the excerpt (a German excerpt gets a German sentence).";

export function createSummaryClient(
  config: SummaryClientConfig,
): SummaryClient {
  const {
    url,
    model,
    maxTokens = 256,
    enableThinking = false,
    token,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    logger,
    timeoutMs = 120_000,
    maxConcurrency = 4,
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

  // Simple semaphore to cap parallel requests to the summary server.
  let active = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < maxConcurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  }

  function release(): void {
    const next = queue.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  }

  async function doSummarize(
    text: string,
    promptOverride?: string,
  ): Promise<SummaryResponse> {
    const activePrompt = promptOverride ?? systemPrompt;
    if (bedrockClient) {
      const controller = new AbortController();
      const timer =
        timeoutMs > 0
          ? setTimeout(() => controller.abort(), timeoutMs)
          : undefined;
      try {
        const command = new ConverseCommand({
          modelId: model,
          messages: [{ role: "user", content: [{ text: text }] }],
          system: activePrompt ? [{ text: activePrompt }] : undefined,
          inferenceConfig: {
            maxTokens: maxTokens,
            temperature: 0.0,
          },
        });
        const res = await bedrockClient.send(command, {
          abortSignal: controller.signal,
        });
        const text_result = res.output?.message?.content?.[0]?.text;
        if (typeof text_result !== "string" || text_result.trim() === "") {
          return {
            ok: false,
            error: {
              code: "SUMMARY_INVALID_RESPONSE",
              message: "Bedrock response missing text content",
            },
          };
        }
        const inputTokens = res.usage?.inputTokens ?? Math.ceil(text.length / 4) + Math.ceil(activePrompt.length / 4);
        const outputTokens = res.usage?.outputTokens ?? Math.ceil(text_result.length / 4);
        const cost = (inputTokens * inputTokenCost + outputTokens * outputTokenCost) / 1_000_000;
        recordUsage(inputTokens, outputTokens, cost, model);
        logger.debug(
          { inputLen: text.length, summaryLen: text_result.length, inputTokens, outputTokens, cost },
          "Bedrock summary generated",
        );
        return { ok: true, result: text_result.trim(), usage: { inputTokens, outputTokens, cost } };
      } catch (cause) {
        clearTimeout(timer);
        const isTimeout = cause instanceof Error && cause.name === "AbortError";
        logger.debug({ cause }, "Bedrock summary call failed");
        return {
          ok: false,
          error: {
            code: isTimeout ? "SUMMARY_TIMEOUT" : "SUMMARY_HTTP_ERROR",
            message: isTimeout
              ? `Bedrock summary request timed out after ${timeoutMs}ms`
              : `Bedrock summary request failed: ${cause instanceof Error ? cause.message : cause}`,
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
            { role: "system", content: activePrompt },
            { role: "user", content: text },
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
      logger.debug({ cause }, "Summary server unreachable");
      return {
        ok: false,
        error: {
          code: isTimeout ? "SUMMARY_TIMEOUT" : "SUMMARY_UNREACHABLE",
          message: isTimeout
            ? `Summary request timed out after ${timeoutMs}ms`
            : `Summary server not reachable at ${url}`,
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
          code: "SUMMARY_HTTP_ERROR",
          message: `Summary server returned HTTP ${response.status}: ${body.slice(0, 200)}`,
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
          code: "SUMMARY_INVALID_RESPONSE",
          message: "Summary server returned invalid JSON",
          cause,
        },
      };
    }

    const text_result = (
      data as { choices?: Array<{ message?: { content?: string } }> }
    )?.choices?.[0]?.message?.content;

    if (typeof text_result !== "string" || text_result.trim() === "") {
      logger.warn(
        { rawResponse: JSON.stringify(data).slice(0, 500) },
        "Summary response missing text content",
      );
      return {
        ok: false,
        error: {
          code: "SUMMARY_INVALID_RESPONSE",
          message: "Summary response missing text content",
        },
      };
    }

    let inputTokens = 0;
    let outputTokens = 0;
    const estimatedInputTokens = Math.ceil(text.length / 4) + Math.ceil(activePrompt.length / 4);
    const estimatedOutputTokens = Math.ceil(text_result.length / 4);
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
      { inputLen: text.length, summaryLen: text_result.length, inputTokens, outputTokens, cost },
      "Summary generated",
    );
    return { ok: true, result: text_result.trim(), usage: { inputTokens, outputTokens, cost } };
  }

  async function run(
    text: string,
    promptOverride?: string,
  ): Promise<SummaryResponse> {
    await acquire();
    try {
      return await retryWithBackoff(
        () => doSummarize(text, promptOverride),
        (res) =>
          !res.ok &&
          (res.error.code === "SUMMARY_UNREACHABLE" ||
            res.error.code === "SUMMARY_TIMEOUT"),
        3,
        100,
        circuitBreaker,
      );
    } finally {
      release();
    }
  }

  return {
    summarize(text: string): Promise<SummaryResponse> {
      return run(text);
    },
    placeInContext(excerpt: string, context: string): Promise<SummaryResponse> {
      // The context and the excerpt travel together in the user message so the
      // model has the header context (title/section/summary) alongside the text.
      const userMessage =
        `Context:\n${context}\n\nExcerpt:\n${excerpt}`.trim();
      return run(userMessage, PLACEMENT_SYSTEM_PROMPT);
    },
  };
}
