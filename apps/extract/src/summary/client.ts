// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * summary/client.ts
 *
 * The text-LLM client for the summary hierarchy (design §5 S7 step 5, §9a.2;
 * task 2.7, requirement 9.5). One OpenAI-compatible chat completion per
 * summary — no image, just a system prompt and the text to condense.
 *
 * ## Why its own module and not the vision client
 *
 * The vision client (`vision/client.ts`) carries a page image and escalates a
 * token budget on truncation; a summary is plain text and a fixed budget. But
 * the *transport* is the same shape — an OpenAI chat completion against a vLLM
 * endpoint — so this client mirrors its structure deliberately: the same
 * `injectTraceHeaders`, the same transient-vs-permanent split, the same
 * exponential backoff with jitter, the same per-request timeout that also
 * honours the caller's abort signal. Keeping it a separate module means the
 * summary pass depends only on the text model, and a deployment can point
 * `SUMMARY_URL` at a different endpoint than `VISION_URL`.
 *
 * ## Transient vs permanent
 *
 * A connection reset, a timeout, a 5xx, a 429, or an empty completion is a
 * {@link TransientSummaryFailure}: retried in place with backoff, and — when
 * the retries are exhausted — surfaced to the caller so the summary *stage*
 * pauses the job on dependency rather than failing the document (the summary
 * pass is optional; a text-LLM outage must not lose the pages already produced).
 * A 4xx other than 408/429 is a caller error (bad model name, unsupported
 * field) and throws {@link ExtractError} so it is not retried into the ground.
 *
 * ## Summaries are optional
 *
 * This client is only constructed when `SUMMARY_URL` is configured. When it is
 * not, the generator is never created and the summary hierarchy is skipped
 * cleanly — see `summary/generator.ts` and the runner wiring.
 */

import type { Logger } from "pino";
import type { SummaryConfig } from "../config.js";
import { ExtractError } from "../errors.js";
import { injectTraceHeaders } from "../trace-context.js";
import {
  buildSummaryUserPrompt,
  summarySystemPrompt,
  type SummaryScope,
} from "./prompts.js";

/** Token usage reported by the model (0 when the server omits it). */
export interface SummaryUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** What one summarisation call produces. */
export interface SummaryResult {
  /** The summary text, trimmed. */
  text: string;
  usage: SummaryUsage;
  /** Total requests made, including retries. */
  requests: number;
}

/** Input to {@link SummaryClient.summarize}. */
export interface SummarizeInput {
  scope: SummaryScope;
  /** The title path of the section/chapter, when known. */
  title?: string | undefined;
  /** The text to summarise (page summaries + block text, or lower-level summaries). */
  content: string;
  /** Aborts the request when the job is cancelled / the client disconnects. */
  signal?: AbortSignal | undefined;
}

export interface SummaryClient {
  /** Generate one summary. Throws {@link TransientSummaryFailure} or {@link ExtractError}. */
  summarize(input: SummarizeInput): Promise<SummaryResult>;
  /** Reachability probe for `/health`. Never throws. */
  probe(): Promise<{ available: boolean; error?: string }>;
}

/** A failure worth retrying in place, as opposed to a permanent rejection. */
export class TransientSummaryFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientSummaryFailure";
  }
}

interface ChatChoice {
  message?: { content?: unknown };
  finish_reason?: unknown;
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

function toInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Sleep with jitter, so retries from concurrent summaries do not synchronise. */
function backoffDelay(attempt: number): number {
  const base = Math.min(8_000, 250 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSummaryClient(config: SummaryConfig, logger: Logger): SummaryClient {
  // The URL is used as-is (no suffix appended), mirroring Search's summary
  // client: deployments point SUMMARY_URL straight at /v1/chat/completions.
  const endpoint = config.url;
  const modelsUrl = deriveModelsUrl(config.url);

  function headers(): Record<string, string> {
    const result: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (config.apiKey !== null) result["authorization"] = `Bearer ${config.apiKey}`;
    injectTraceHeaders(result);
    return result;
  }

  function buildBody(input: SummarizeInput): Record<string, unknown> {
    return {
      model: config.model,
      messages: [
        { role: "system", content: summarySystemPrompt(input.scope) },
        {
          role: "user",
          content: buildSummaryUserPrompt({
            scope: input.scope,
            title: input.title,
            content: input.content,
          }),
        },
      ],
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      stream: false,
      // Only sent when configured: strict servers reject unknown fields, so an
      // unconditional chat_template_kwargs breaks every request against them.
      ...(config.reasoningEffort !== null
        ? { chat_template_kwargs: { reasoning_effort: config.reasoningEffort } }
        : {}),
    };
  }

  /** One request. Throws TransientSummaryFailure or ExtractError. */
  async function requestOnce(input: SummarizeInput): Promise<SummaryResult> {
    const controller = new AbortController();
    const timeout =
      config.timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error("timeout")), config.timeoutMs)
        : null;
    const onExternalAbort = (): void => controller.abort(new Error("client disconnected"));
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(buildBody(input)),
        signal: controller.signal,
      });
    } catch (error) {
      if (input.signal?.aborted === true) {
        throw new ExtractError("VISION_UNAVAILABLE", "The summary request was aborted by the client");
      }
      throw new TransientSummaryFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onExternalAbort);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const retryable =
        response.status >= 500 || response.status === 408 || response.status === 429;
      const message = `The summary endpoint returned HTTP ${response.status}: ${body.slice(0, 500)}`;
      if (retryable) throw new TransientSummaryFailure(message);
      // A 4xx (bad model name, unsupported field) is permanent; retrying hides it.
      throw new ExtractError("VISION_UNAVAILABLE", message, { status: response.status });
    }

    let payload: ChatResponse;
    try {
      payload = (await response.json()) as ChatResponse;
    } catch (error) {
      throw new TransientSummaryFailure(
        `The summary response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const usage: SummaryUsage = {
      promptTokens: toInt(payload.usage?.prompt_tokens),
      completionTokens: toInt(payload.usage?.completion_tokens),
      totalTokens: toInt(payload.usage?.total_tokens),
    };
    const choice = payload.choices?.[0];
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (content.trim() === "") {
      // An empty completion with a normal finish reason is a server-side hiccup
      // often enough to be worth another try.
      throw new TransientSummaryFailure("The summary endpoint returned no content");
    }
    return { text: content.trim(), usage, requests: 1 };
  }

  async function summarize(input: SummarizeInput): Promise<SummaryResult> {
    const usageTotal: SummaryUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let requests = 0;
    let lastTransient: Error | null = null;

    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      if (input.signal?.aborted === true) {
        throw new ExtractError("VISION_UNAVAILABLE", "The summary request was aborted by the client");
      }
      requests++;
      try {
        const result = await requestOnce(input);
        usageTotal.promptTokens += result.usage.promptTokens;
        usageTotal.completionTokens += result.usage.completionTokens;
        usageTotal.totalTokens += result.usage.totalTokens;
        return { text: result.text, usage: usageTotal, requests };
      } catch (error) {
        if (error instanceof TransientSummaryFailure) {
          lastTransient = error;
          if (attempt < config.maxRetries) {
            const delay = backoffDelay(attempt);
            logger.warn(
              { scope: input.scope, attempt: attempt + 1, delayMs: Math.round(delay), err: error.message },
              "Summary request failed; retrying",
            );
            await sleep(delay);
            continue;
          }
          break;
        }
        throw error; // ExtractError — permanent
      }
    }

    throw new TransientSummaryFailure(
      `The summary endpoint failed after ${requests} attempt(s): ${lastTransient?.message ?? "unknown error"}`,
    );
  }

  async function probe(): Promise<{ available: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(modelsUrl, { headers: headers(), signal: controller.signal });
      if (response.ok) return { available: true };
      return { available: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { summarize, probe };
}

/**
 * Derive a `/v1/models` probe URL from a chat-completions URL. Handles the
 * common `.../v1/chat/completions` shape by swapping the tail; otherwise falls
 * back to appending `/v1/models` to the origin.
 */
function deriveModelsUrl(chatUrl: string): string {
  const marker = "/chat/completions";
  if (chatUrl.endsWith(marker)) return `${chatUrl.slice(0, -marker.length)}/models`;
  try {
    const u = new URL(chatUrl);
    return `${u.origin}/v1/models`;
  } catch {
    return chatUrl;
  }
}
