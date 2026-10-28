// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { trimTrailingSlashes } from "@atf/security-kit";

/**
 * client.ts
 *
 * The vision model client: one OpenAI-compatible chat completion per page,
 * carrying the rendered page image and its text layer.
 *
 * ## Two retry axes, deliberately separate
 *
 * A page can fail for two unrelated reasons and conflating them makes both
 * handled badly:
 *
 *   **Transient failure** — connection reset, 502 from a loading model, empty
 *   choices array. Retried in place with exponential backoff and jitter. The
 *   request was fine; the world was not.
 *
 *   **Output truncation** — `finish_reason: "length"`. Retrying identically
 *   produces the identical truncation, so this escalates to the next larger
 *   token budget from `VISION_MAX_TOKEN_VARIANTS`. Starting at the largest budget
 *   instead would make every page slower and, on some servers, reserve KV cache
 *   that is never used.
 *
 * Truncation matters more than it looks. A cut-off response loses the tail of the
 * page silently — the `<markdown>` section simply ends — so a page that looks
 * successful is missing its last third. That is why it is a distinct signal all
 * the way out to `/metrics` (`extract_vision_truncations_total`) rather than being
 * folded into a generic failure count.
 *
 * ## Exhaustion is not failure
 *
 * When the largest budget still truncates, the partial response is returned with
 * `truncated: true` rather than thrown away. A page that is 80% transcribed and
 * flagged is more useful than no page, and the caller records the warning on the
 * page so it is visible rather than merely lost.
 */

import type { Logger } from "pino";
import { visionUnavailable } from "../errors.js";
import { injectTraceHeaders } from "../trace-context.js";
import { toDataUrl } from "../pipeline/raster.js";
import {
  PAGE_SYSTEM_PROMPT,
  buildPageUserPrompt,
  buildFigureUserPrompt,
  pass2SystemPrompt,
  type PromptHeadingCandidate,
  type PrevPageContext,
} from "./prompts.js";
import {
  PAGE_RESPONSE_FORMAT,
  pageJsonToTagText,
  parsePageJson,
  pass2ResponseFormat,
  type ResponseFormat,
} from "./schema.js";

export interface VisionClientConfig {
  /** Base URL; `/v1/chat/completions` is appended. */
  visionUrl: string;
  visionModel: string;
  visionApiKey: string | null;
  /** Per-request timeout in ms. 0 disables. */
  visionTimeoutMs: number;
  visionTemperature: number;
  visionTopP: number;
  /** Ascending output budgets, escalated on truncation. */
  visionMaxTokenVariants: number[];
  /** Transient-failure retries per budget. */
  visionMaxRetries: number;
  visionReasoningEffort: string | null;
  /**
   * Capability flag: the provider enforces `response_format: json_schema`
   * Fail-closed — off unless the operator says
   * the backend supports it, mirroring the runtime's model-capability rules.
   * When a request carrying the field is rejected anyway, the client drops it
   * for the rest of the process and continues unstructured.
   */
  visionSupportsJsonSchema: boolean;
}

export interface VisionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface VisionPageResult {
  /** Raw response text, for `parseVisionPage`. */
  raw: string;
  usage: VisionUsage;
  /** Total requests made, including retries and escalations. */
  requests: number;
  /** True when even the largest budget was exhausted. */
  truncated: boolean;
  /** The budget that produced the returned response. */
  maxTokens: number;
}

export interface AnalyzePageInput {
  page: number;
  pageCount: number;
  rawText: string;
  image: { buffer: Uint8Array; mimeType: string };
  /**
   * Numbered-heading candidates for this page from the deterministic S2
   * analysis. Passed to the Pass-1 prompt as a hint
   * so the model confirms the outline rather than reinventing it. Optional: the
   * legacy sync path and a page S2 could not analyse simply omit it.
   */
  headingCandidates?: readonly PromptHeadingCandidate[] | undefined;
  /**
   * Bounded context carried over from the previous page (heading chain, last
   * table header). Lets a mid-section or mid-table page place itself without the
   * whole document in context.
   */
  prevPage?: PrevPageContext | undefined;
  /** Aborts the request when the client disconnects. */
  signal?: AbortSignal | undefined;
}

/**
 * Input to a Pass-2 figure transcription. The crop is
 * rendered at `FIGURE_DPI` by the caller; `regionText` is the poppler text
 * inside the figure's box. `kind` selects the per-kind system
 * prompt; a kind with no Pass-2 prompt is a caller error (the runner gates on
 * `FIGURE_PASS2_KINDS` before ever calling this).
 */
export interface AnalyzeFigureInput {
  /** The page the figure sits on, for logging. */
  page: number;
  /** The figure's document-unique id, for logging. */
  figureId: string;
  /** The figure's kind; selects the per-kind Pass-2 system prompt. */
  kind: string;
  /** The verbatim text-layer words inside the figure's box. */
  regionText: string;
  /** The figure's caption, when Pass 1 supplied one. */
  caption?: string | undefined;
  /** The high-resolution crop, rendered at FIGURE_DPI. */
  image: { buffer: Uint8Array; mimeType: string };
  /** Aborts the request when the client disconnects. */
  signal?: AbortSignal | undefined;
}

export interface VisionFigureResult {
  /** Raw response text, for the per-format parser in `response.ts`. */
  raw: string;
  usage: VisionUsage;
  /** Total requests made, including retries and escalations. */
  requests: number;
  /** True when even the largest budget was exhausted. */
  truncated: boolean;
  /** The budget that produced the returned response. */
  maxTokens: number;
}

export interface VisionClient {
  analyzePage(input: AnalyzePageInput): Promise<VisionPageResult>;
  /**
   * Run Pass 2 on a single figure crop. Reuses the
   * same endpoint, retry axes and budget escalation as {@link analyzePage} —
   * only the messages differ (a per-kind system prompt plus the figure user
   * prompt). Returns the model's raw response for the per-format parser.
   */
  analyzeFigure(input: AnalyzeFigureInput): Promise<VisionFigureResult>;
  /** Reachability probe for `/health`. Never throws. */
  probe(): Promise<{ available: boolean; error?: string }>;
}

/** An OpenAI-compatible chat message, the unit both passes build. */
type ChatMessage = { role: "system" | "user"; content: unknown };

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

/** Sleep with jitter, so retries from concurrent pages do not synchronise. */
function backoffDelay(attempt: number): number {
  const base = Math.min(8_000, 250 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A failure worth retrying in place, as opposed to a permanent rejection. */
class TransientVisionFailure extends Error {}

/**
 * The provider refused the `response_format: json_schema` field itself.
 * Carries the response body so the fallback log shows what the
 * server actually complained about.
 */
class StructuredOutputRejected extends Error {
  readonly body: string;

  constructor(body: string) {
    super("The vision provider rejected the structured-output request format");
    this.body = body;
  }
}

/** The model stopped because it ran out of output budget. */
class TruncatedVisionResponse extends Error {
  readonly partial: string;
  readonly usage: VisionUsage;

  constructor(partial: string, usage: VisionUsage) {
    super("The model response was cut off by the token budget");
    this.partial = partial;
    this.usage = usage;
  }
}

export function createVisionClient(
  config: VisionClientConfig,
  logger: Logger,
): VisionClient {
  const endpoint = `${trimTrailingSlashes(config.visionUrl)}/v1/chat/completions`;
  const budgets =
    config.visionMaxTokenVariants.length > 0
      ? config.visionMaxTokenVariants
      : [8192];

  // Capability state. Starts from the operator's flag; a provider
  // that rejects the field despite the flag flips this off for the rest of the
  // process, so one mis-declared capability costs one wasted request per pass
  // rather than failing every page.
  let schemaAccepted = config.visionSupportsJsonSchema;

  function headers(): Record<string, string> {
    const result: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (config.visionApiKey !== null) {
      result["authorization"] = `Bearer ${config.visionApiKey}`;
    }
    injectTraceHeaders(result);
    return result;
  }

  /**
   * Build a chat-completion body from a ready messages array. `responseFormat`
   * is only included when the schema capability is still on; a provider that
   * rejects it is handled by {@link requestOnce}, which retries without it.
   */
  function buildBody(
    messages: ChatMessage[],
    maxTokens: number,
    responseFormat: ResponseFormat | undefined,
  ): Record<string, unknown> {
    return {
      model: config.visionModel,
      messages,
      max_tokens: maxTokens,
      temperature: config.visionTemperature,
      top_p: config.visionTopP,
      // Only sent when configured: strict servers reject unknown fields, so an
      // unconditional chat_template_kwargs breaks every request against them.
      ...(config.visionReasoningEffort !== null
        ? {
            chat_template_kwargs: {
              reasoning_effort: config.visionReasoningEffort,
            },
          }
        : {}),
      // Same reasoning: `response_format` rides only on the capability flag,
      // and requestOnce drops it for the process if the server rejects it.
      ...(responseFormat !== undefined && schemaAccepted
        ? { response_format: responseFormat }
        : {}),
    };
  }

  /** The Pass-1 page messages: system prompt + user prompt + page image. */
  function pageMessages(input: AnalyzePageInput): ChatMessage[] {
    return [
      { role: "system", content: PAGE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildPageUserPrompt({
              page: input.page,
              pageCount: input.pageCount,
              rawText: input.rawText,
              headingCandidates: input.headingCandidates,
              prevPage: input.prevPage,
            }),
          },
          {
            type: "image_url",
            image_url: {
              url: toDataUrl(input.image.buffer, input.image.mimeType),
              // "high" keeps the server from downscaling a page to a thumbnail,
              // which makes table text unreadable regardless of RENDER_DPI.
              detail: "high",
            },
          },
        ],
      },
    ];
  }

  /** The Pass-2 figure messages: per-kind system prompt + user prompt + crop. */
  function figureMessages(input: AnalyzeFigureInput): ChatMessage[] {
    const system = pass2SystemPrompt(input.kind);
    if (system === undefined) {
      // Defensive: the runner gates on FIGURE_PASS2_KINDS, so a kind with no
      // prompt should never reach here. Fail loudly rather than send a request
      // with an empty system prompt.
      throw visionUnavailable(
        `No Pass-2 prompt for figure kind "${input.kind}"`,
        {
          page: input.page,
        },
      );
    }
    return [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildFigureUserPrompt({
              kind: input.kind,
              regionText: input.regionText,
              caption: input.caption,
            }),
          },
          {
            type: "image_url",
            image_url: {
              url: toDataUrl(input.image.buffer, input.image.mimeType),
              detail: "high",
            },
          },
        ],
      },
    ];
  }

  /**
   * One request, with the structured-output transport fallback layered over
   * {@link sendOnce} and {@link parseCompletion}. Throws
   * TransientVisionFailure or TruncatedVisionResponse.
   */
  async function requestOnce(
    messages: ChatMessage[],
    maxTokens: number,
    ctx: { page: number; signal?: AbortSignal | undefined },
    responseFormat?: ResponseFormat | undefined,
  ): Promise<{ raw: string; usage: VisionUsage; extraRequests: number }> {
    try {
      const response = await sendOnce(messages, maxTokens, ctx, responseFormat);
      const parsed = await parseCompletion(response, ctx, responseFormat);
      return { ...parsed, extraRequests: 0 };
    } catch (error) {
      // Transport-level fallback: the provider rejected the
      // response_format field itself — a 4xx naming it, which is exactly how
      // vLLM and llama.cpp answer an unsupported structured-output request
      // despite the operator's capability flag. Drop the field for the whole
      // process and retry once without it; the existing tag/JSON parsers
      // handle the unstructured answer as before.
      if (
        responseFormat !== undefined &&
        schemaAccepted &&
        error instanceof StructuredOutputRejected
      ) {
        schemaAccepted = false;
        logger.warn(
          { page: ctx.page, rejected: error.body.slice(0, 300) },
          "Vision provider rejected response_format json_schema; falling back to unstructured requests",
        );
        const retry = await requestOnce(messages, maxTokens, ctx, undefined);
        // The rejected attempt was paid for too, so it counts as an extra.
        return { ...retry, extraRequests: retry.extraRequests + 1 };
      }
      throw error;
    }
  }

  /**
   * The HTTP exchange itself: build the body, send it with the timeout and
   * abort wiring, and hand the raw response back. Split out so the
   * structured-output fallback can retry the whole exchange without the
   * `response_format` field.
   */
  async function sendOnce(
    messages: ChatMessage[],
    maxTokens: number,
    ctx: { page: number; signal?: AbortSignal | undefined },
    responseFormat: ResponseFormat | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout =
      config.visionTimeoutMs > 0
        ? setTimeout(
            () => controller.abort(new Error("timeout")),
            config.visionTimeoutMs,
          )
        : null;
    const onExternalAbort = (): void =>
      controller.abort(new Error("client disconnected"));
    ctx.signal?.addEventListener("abort", onExternalAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(buildBody(messages, maxTokens, responseFormat)),
        signal: controller.signal,
      });
    } catch (error) {
      // A client disconnect is not the model's fault and must not be retried;
      // everything else at this layer is a network condition and is.
      if (ctx.signal?.aborted === true) {
        throw visionUnavailable("The request was aborted by the client", {
          page: ctx.page,
        });
      }
      throw new TransientVisionFailure(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onExternalAbort);
    }

    return response;
  }

  /** Translate an HTTP response into a raw completion or a typed failure. */
  async function parseCompletion(
    response: Response,
    ctx: { page: number; signal?: AbortSignal | undefined },
    responseFormat: ResponseFormat | undefined,
  ): Promise<{ raw: string; usage: VisionUsage }> {
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Transport-level fallback: a 4xx that names the structured-
      // output field is the provider saying it cannot do json_schema, however
      // the capability flag was set. Signal that distinctly — requestOnce
      // retries once without the field and turns the capability off for the
      // process. A 4xx that does not mention it (bad model name, refused
      // image) is the ordinary permanent failure below.
      if (
        responseFormat !== undefined &&
        schemaAccepted &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429 &&
        /response_format|json_schema|structured output/i.test(body)
      ) {
        throw new StructuredOutputRejected(body);
      }
      // 4xx other than 408/429 means the request itself is wrong — a bad model
      // name, an unsupported field, an image the server refuses. Retrying is
      // pointless and hides the real message.
      const retryable =
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429;
      const message = `The vision endpoint returned HTTP ${response.status}: ${body.slice(0, 500)}`;
      if (retryable) throw new TransientVisionFailure(message);
      throw visionUnavailable(message, {
        page: ctx.page,
        status: response.status,
      });
    }

    let payload: ChatResponse;
    try {
      payload = (await response.json()) as ChatResponse;
    } catch (error) {
      throw new TransientVisionFailure(
        `The vision response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const usage: VisionUsage = {
      promptTokens: toInt(payload.usage?.prompt_tokens),
      completionTokens: toInt(payload.usage?.completion_tokens),
      totalTokens: toInt(payload.usage?.total_tokens),
    };

    const choice = payload.choices?.[0];
    const content =
      typeof choice?.message?.content === "string"
        ? choice.message.content
        : "";

    if (choice?.finish_reason === "length") {
      throw new TruncatedVisionResponse(content, usage);
    }
    if (content.trim() === "") {
      // An empty completion with a normal finish reason is a server-side hiccup
      // often enough to be worth one more try.
      throw new TransientVisionFailure(
        "The vision endpoint returned no content",
      );
    }

    return { raw: content, usage };
  }

  /**
   * The shared request loop for both passes: the two retry axes (transient
   * retry in place, truncation escalation to the next budget) and the
   * exhaustion-is-not-failure return. Both `analyzePage` and `analyzeFigure`
   * differ only in the messages they build, so both funnel through here.
   */
  async function runWithEscalation(
    messages: ChatMessage[],
    ctx: { page: number; signal?: AbortSignal | undefined; what: string },
    responseFormat?: ResponseFormat | undefined,
  ): Promise<VisionPageResult> {
    const usageTotal: VisionUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    let requests = 0;
    let lastTransient: Error | null = null;
    let lastTruncation: TruncatedVisionResponse | null = null;

    const addUsage = (usage: VisionUsage): void => {
      usageTotal.promptTokens += usage.promptTokens;
      usageTotal.completionTokens += usage.completionTokens;
      usageTotal.totalTokens += usage.totalTokens;
    };

    for (const [budgetIndex, maxTokens] of budgets.entries()) {
      // Transient retries are per budget: escalating resets the counter, because
      // a truncation is not evidence that the endpoint is unhealthy.
      for (let attempt = 0; attempt <= config.visionMaxRetries; attempt++) {
        if (ctx.signal?.aborted === true) {
          throw visionUnavailable("The request was aborted by the client", {
            page: ctx.page,
          });
        }
        requests++;
        try {
          const result = await requestOnce(
            messages,
            maxTokens,
            ctx,
            responseFormat,
          );
          // A structured-output rejection costs one extra request, reported here.
          requests += result.extraRequests;
          addUsage(result.usage);
          return {
            raw: result.raw,
            usage: usageTotal,
            requests,
            truncated: false,
            maxTokens,
          };
        } catch (error) {
          if (error instanceof TruncatedVisionResponse) {
            addUsage(error.usage);
            lastTruncation = error;
            logger.warn(
              {
                page: ctx.page,
                what: ctx.what,
                maxTokens,
                nextBudget: budgets[budgetIndex + 1] ?? null,
                partialLength: error.partial.length,
              },
              "Vision response hit the token budget; escalating",
            );
            break; // next budget
          }
          if (error instanceof TransientVisionFailure) {
            lastTransient = error;
            if (attempt < config.visionMaxRetries) {
              const delay = backoffDelay(attempt);
              logger.warn(
                {
                  page: ctx.page,
                  what: ctx.what,
                  attempt: attempt + 1,
                  delayMs: Math.round(delay),
                  err: error.message,
                },
                "Vision request failed; retrying",
              );
              await sleep(delay);
              continue;
            }
            break; // budgets loop decides whether anything is left to try
          }
          throw error; // ExtractError — permanent
        }
      }
      // A transient exhaustion on this budget will recur on the next one, so stop.
      if (lastTruncation === null && lastTransient !== null) break;
      lastTransient = null;
    }

    if (lastTruncation !== null) {
      // Exhausted every budget. Return the partial response rather than nothing:
      // a flagged 80% result beats a missing one, and the flag reaches the
      // warnings and /metrics.
      logger.error(
        { page: ctx.page, what: ctx.what, largestBudget: budgets.at(-1) ?? 0 },
        "Vision response was still truncated at the largest token budget",
      );
      return {
        raw: lastTruncation.partial,
        usage: usageTotal,
        requests,
        truncated: true,
        maxTokens: budgets.at(-1) ?? 0,
      };
    }

    throw visionUnavailable(
      `The vision endpoint failed after ${requests} attempt(s): ${lastTransient?.message ?? "unknown error"}`,
      { page: ctx.page, requests },
    );
  }

  async function analyzePage(
    input: AnalyzePageInput,
  ): Promise<VisionPageResult> {
    const result = await runWithEscalation(
      pageMessages(input),
      {
        page: input.page,
        signal: input.signal,
        what: "page",
      },
      PAGE_RESPONSE_FORMAT,
    );
    // Payload-level fallback: a schema-conforming response is
    // re-rendered into the tag format so parseVisionPage — placeholder
    // rewriting, renumbering, table detection — consumes it unchanged. A
    // response that is not conforming JSON passes through untouched and the
    // tag parser does what it has always done. The transport changed, the
    // pipeline did not.
    if (!schemaAccepted) return result;
    const structured = parsePageJson(result.raw);
    return structured === null
      ? result
      : { ...result, raw: pageJsonToTagText(structured) };
  }

  async function analyzeFigure(
    input: AnalyzeFigureInput,
  ): Promise<VisionFigureResult> {
    // No payload conversion here: the per-kind Pass-2 parsers in response.ts
    // already expect a JSON object, so a schema-conforming response flows
    // straight into parseTranscription.
    return runWithEscalation(
      figureMessages(input),
      {
        page: input.page,
        signal: input.signal,
        what: `figure ${input.figureId} (${input.kind})`,
      },
      pass2ResponseFormat(input.kind),
    );
  }

  async function probe(): Promise<{ available: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      // The models listing is the cheapest endpoint every OpenAI-compatible
      // server exposes; a chat completion would spend tokens on a health check.
      const response = await fetch(
        `${trimTrailingSlashes(config.visionUrl)}/v1/models`,
        {
          headers: headers(),
          signal: controller.signal,
        },
      );
      if (response.ok) return { available: true };
      return { available: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { analyzePage, analyzeFigure, probe };
}
