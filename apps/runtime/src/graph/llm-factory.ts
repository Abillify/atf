// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LLM Provider Factory
 *
 * Creates a Vercel AI SDK `LanguageModel` instance from a `LlmConfig` and the
 * central `AppConfig`. All API keys and base URLs are sourced exclusively from
 * `AppConfig` — never hardcoded.
 *
 * Requirements: 5.1, 5.2, 5.5, 5.6, 5.7
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAzure } from "@ai-sdk/azure";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel, EmbeddingModel } from "ai";
import type { LlmConfig } from "../types/flow.js";
import type { AppConfig, EmbeddingConfig } from "../config/index.js";
import { getModelCapabilities } from "./model-capabilities.js";
import {
  configuredProviderNames,
  getProviderInstance,
  PROVIDER_PROTOCOLS,
  type ProviderInstance,
  resolveProviderProtocol,
} from "../config/providers.js";
import { parseBedrockByokCredentials } from "./tenant-provider-keys.js";
import { egressFetch, egressFetchWithoutKeepAlive } from "../security/egress.js";
import { createLlmTransportFetch } from "./llm-transport.js";

// ---------------------------------------------------------------------------
// reasoning_content fetch interceptor
// ---------------------------------------------------------------------------

/**
 * Merges `chat_template_kwargs` into an outgoing OpenAI-compatible request body.
 *
 * This is the explicit, per-request equivalent of LM Studio's "Think" UI switch
 * (and vLLM's reasoning toggle): the field is forwarded to the server's Jinja
 * chat template, where hybrid-reasoning models read e.g. `enable_thinking` to
 * turn their thinking channel on/off. The Vercel AI SDK's `@ai-sdk/openai`
 * provider has no typed passthrough for it, so we inject it at the fetch layer.
 *
 * `body` is the raw request body (a JSON string for these providers). Returns a
 * possibly-rewritten body; on any parse failure the input is returned unchanged
 * so a non-JSON body can never break the request.
 */
type FetchBody = NonNullable<Parameters<typeof fetch>[1]>["body"];

export function injectChatTemplateKwargs(
  body: FetchBody,
  kwargs: Record<string, unknown>,
): FetchBody {
  if (typeof body !== "string" || Object.keys(kwargs).length === 0) return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const existing =
      parsed.chat_template_kwargs !== null &&
      typeof parsed.chat_template_kwargs === "object"
        ? (parsed.chat_template_kwargs as Record<string, unknown>)
        : {};
    parsed.chat_template_kwargs = { ...existing, ...kwargs };
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Sets a top-level `reasoning_effort` field on an outgoing OpenAI-compatible
 * request body.
 *
 * This is the field LM Studio actually honors to control a hybrid model's
 * thinking channel — including turning it OFF with `"none"`. It is NOT
 * equivalent to {@link injectChatTemplateKwargs}: LM Studio's OpenAI endpoint
 * silently ignores request-level `chat_template_kwargs` (its "Enable Thinking"
 * switch is internal load-time state), whereas the standard OpenAI-style
 * `reasoning_effort` is applied per request. vLLM/Ollama honor
 * `chat_template_kwargs`; LM Studio honors `reasoning_effort`. We inject both
 * so a single flow config works across OpenAI-compatible servers.
 *
 * On any parse failure the input is returned unchanged so a non-JSON body can
 * never break the request.
 */
export function injectReasoningEffort(
  body: FetchBody,
  effort: string,
): FetchBody {
  if (typeof body !== "string" || effort.length === 0) return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    parsed.reasoning_effort = effort;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Merges arbitrary top-level fields into an outgoing OpenAI-compatible request
 * body. This is the generic, per-request passthrough for inference knobs the
 * Vercel AI SDK does not model as typed `streamText` params but that
 * OpenAI-compatible servers honor — most importantly the anti-repetition
 * penalties for local models:
 *
 *   - `repeat_penalty`  — llama.cpp / LM Studio native (the most effective knob
 *                         against degenerate repetition loops).
 *   - `frequency_penalty`, `presence_penalty` — OpenAI-standard, also honored
 *                         by LM Studio / vLLM.
 *   - `top_k`, `min_p`, … — any other server-honored sampling field.
 *
 * Sourced from a node's `parameters.extraBody` object and injected at the fetch
 * layer (like {@link injectReasoningEffort}) so one flow config works across
 * LM Studio / Ollama / vLLM without the SDK needing a typed field for each. The
 * fields are written verbatim onto the request body (snake_case, as the servers
 * expect). Existing keys are overwritten; the AI SDK never sees `extraBody`
 * itself (the LLM handler only reads `temperature`/`maxTokens` from parameters),
 * so it cannot leak as a literal request field except via this injector.
 *
 * On any parse failure the input is returned unchanged so a non-JSON body can
 * never break the request.
 */
export function injectExtraBody(
  body: FetchBody,
  fields: Record<string, unknown>,
): FetchBody {
  if (typeof body !== "string" || Object.keys(fields).length === 0) return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const [k, v] of Object.entries(fields)) parsed[k] = v;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Reports whether an outgoing OpenAI-compatible request asks for a machine-
 * readable JSON answer (`response_format` of `json_schema` or `json_object`).
 *
 * Used to scope {@link recoverReasoningOnlyJson} to exactly the requests whose
 * ONLY acceptable payload is the generated JSON, so promoting a reasoning-only
 * response can never leak chain-of-thought into a conversational answer.
 */
export function requestsStructuredJson(body: FetchBody): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed = JSON.parse(body) as {
      response_format?: { type?: unknown } | null;
    };
    const type = parsed.response_format?.type;
    return type === "json_schema" || type === "json_object";
  } catch {
    return false;
  }
}

/**
 * Repairs a NON-STREAMING chat completion whose generated JSON arrived in the
 * REASONING channel instead of `message.content`.
 *
 * Verified against the LM Studio build serving `qwen/qwen3.6-35b-a3b`: when the
 * model's thinking channel is active, a `response_format: json_schema` request
 * comes back with `content: ""` and the complete document in
 * `message.reasoning_content` (`completion_tokens_details.reasoning_tokens`
 * equal to the whole completion). The AI SDK then sees empty text and throws
 * `NoObjectGeneratedError: could not parse the response.` — the exact failure the
 * `userstory-cr` flow hit on every attempt, discarding a usable document.
 *
 * Thinking is normally disabled for these nodes (`reasoning_effort: "none"` /
 * `enable_thinking: false`), but that is a request hint the server may ignore —
 * LM Studio's thinking switch is also load-time state. So the recovery is done
 * here, where the wire response is still intact, rather than relying on the
 * server honouring the hint.
 *
 * Deliberately narrow: only `choices[].message` entries with empty/absent
 * `content` are touched, and only for requests that asked for structured JSON
 * (see {@link requestsStructuredJson}). Anything else is returned unchanged.
 *
 * @returns the rewritten payload, or `null` when nothing needed changing.
 */
export function recoverReasoningOnlyJson(payload: unknown): unknown | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const root = payload as { choices?: unknown };
  if (!Array.isArray(root.choices)) return null;
  let changed = false;
  for (const choice of root.choices) {
    if (choice === null || typeof choice !== "object") continue;
    const message = (choice as { message?: unknown }).message;
    if (message === null || typeof message !== "object") continue;
    const msg = message as {
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
    };
    const content = msg.content;
    const hasContent = typeof content === "string" && content.trim() !== "";
    if (hasContent) continue;
    const recovered =
      typeof msg.reasoning_content === "string" &&
      msg.reasoning_content.trim() !== ""
        ? msg.reasoning_content
        : typeof msg.reasoning === "string" && msg.reasoning.trim() !== ""
          ? msg.reasoning
          : undefined;
    if (recovered === undefined) continue;
    msg.content = recovered;
    delete msg.reasoning_content;
    delete msg.reasoning;
    changed = true;
  }
  return changed ? payload : null;
}

/**
 * Wraps the native fetch for OpenAI-compatible endpoints (LM Studio, Ollama,
 * vLLM). Two responsibilities:
 *
 *  1. Request: when `chatTemplateKwargs` and/or `reasoningEffort` are set, merge
 *     them into the request body. `chat_template_kwargs`
 *     (see {@link injectChatTemplateKwargs}) toggles thinking on vLLM/Ollama;
 *     the top-level `reasoning_effort` (see {@link injectReasoningEffort}) is
 *     what LM Studio honors (`"none"` disables thinking). Both are injected so
 *     one flow config works across OpenAI-compatible servers, independent of
 *     prompt hacks like `/no_think` (model-specific and unreliable, e.g. Gemma).
 *  2. Response: SSE chunks that carry hidden reasoning (`delta.reasoning_content`
 *     OR the newer `delta.reasoning`, e.g. recent LM Studio builds + Qwen3.x)
 *     are rewritten to `delta.content` before the Vercel AI SDK parser sees
 *     them. The SDK ignores unknown delta fields, so without this the model's
 *     thinking tokens are silently dropped.
 *
 * The response transform is streaming-safe: it processes one SSE line at a time
 * and never buffers more than a single line, so TTFT is unaffected.
 */
function makeReasoningFetch(
  chatTemplateKwargs?: Record<string, unknown>,
  reasoningEffort?: string,
  extraBody?: Record<string, unknown>,
  baseFetch: typeof fetch = egressFetch,
): typeof fetch {
  const fn = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let body = init?.body;
    if (body != null) {
      if (
        chatTemplateKwargs !== undefined &&
        Object.keys(chatTemplateKwargs).length > 0
      ) {
        body = injectChatTemplateKwargs(body, chatTemplateKwargs);
      }
      if (reasoningEffort !== undefined && reasoningEffort.length > 0) {
        body = injectReasoningEffort(body, reasoningEffort);
      }
      if (extraBody !== undefined && Object.keys(extraBody).length > 0) {
        body = injectExtraBody(body, extraBody);
      }
    }
    const effectiveInit =
      init?.body != null && body !== init.body ? { ...init, body } : init;
    const response = await baseFetch(input, effectiveInit);
    const responseBody = response.body;
    if (!responseBody) return response;

    const ct = response.headers.get("content-type") ?? "";

    // Non-streaming JSON answer to a structured-output request: rescue a
    // document the server delivered in the reasoning channel with an empty
    // `content` (see recoverReasoningOnlyJson). Everything else — including
    // every free-form non-streaming completion — passes through untouched.
    if (!ct.includes("text/event-stream")) {
      if (
        response.ok &&
        ct.includes("application/json") &&
        requestsStructuredJson(body ?? null)
      ) {
        const raw = await response.text();
        try {
          const parsed: unknown = JSON.parse(raw);
          const repaired = recoverReasoningOnlyJson(parsed);
          if (repaired !== null) {
            return new Response(JSON.stringify(repaired), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          }
        } catch {
          /* not JSON after all — fall through and hand back the original text */
        }
        return new Response(raw, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const transformedStream = new ReadableStream({
      async start(controller) {
        const reader = responseBody.getReader();
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buf.trim().length > 0)
                controller.enqueue(encoder.encode(buf));
              controller.close();
              break;
            }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? ""; // keep incomplete last line

            for (const line of lines) {
              if (!line.startsWith("data: ")) {
                controller.enqueue(encoder.encode(`${line}\n`));
                continue;
              }
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode(`${line}\n`));
                continue;
              }
              try {
                const parsed = JSON.parse(payload) as {
                  choices?: Array<{
                    delta?: {
                      reasoning_content?: string;
                      reasoning?: string;
                      content?: string | null;
                    };
                  }>;
                };
                const delta = parsed.choices?.[0]?.delta;
                // Providers disagree on the hidden-reasoning delta field name:
                //   • `reasoning_content` — DeepSeek, older LM Studio, vLLM.
                //   • `reasoning`         — newer LM Studio builds and Qwen3.x
                //                           (the field is configurable in
                //                           LM Studio's "Response reasoning key").
                // Accept either so local thinking models keep surfacing their
                // chain-of-thought regardless of the server's chosen key.
                const reasoningText =
                  delta?.reasoning_content ?? delta?.reasoning;
                if (
                  delta != null &&
                  reasoningText != null &&
                  (delta.content == null || delta.content === "")
                ) {
                  // Rewrite the reasoning field → content with sentinel prefix
                  // so graph-engine routes it to onReasoning instead of the
                  // content stream. No external callback — single emission path.
                  delta.content = `\x00r${reasoningText}`;
                  delete (delta as Record<string, unknown>).reasoning_content;
                  delete (delta as Record<string, unknown>).reasoning;
                }
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(parsed)}\n`),
                );
              } catch {
                controller.enqueue(encoder.encode(`${line}\n`));
              }
            }
          }
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(transformedStream, {
      status: response.status,
      headers: response.headers,
    });
  };
  return fn as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Model-specific parameter filtering
// ---------------------------------------------------------------------------

/**
 * Strips LLM inference parameters that are unsupported or deprecated for the
 * given (provider, model), avoiding runtime errors like "`temperature` is
 * deprecated for this model". The set of unsupported parameters is sourced from
 * the capability registry ({@link getModelCapabilities}.unsupportedParameters)
 * rather than a hardcoded model list, so a new quirk is a registry table row.
 *
 * @param parameters - Raw parameters from the flow node config (may be undefined).
 * @param provider   - Resolved provider id.
 * @param model      - Resolved model ID string.
 * @returns A new parameters object with unsupported keys removed, or `undefined`
 *          when the input was `undefined` and no parameters are needed.
 */
export function filterLlmParameters(
  parameters: Record<string, unknown> | undefined,
  provider: string,
  model: string,
): Record<string, unknown> | undefined {
  if (parameters === undefined) return undefined;
  const unsupported = [
    ...getModelCapabilities(provider, model).unsupportedParameters,
    // Runtime-only declaration used by fail-closed multimodal dispatch. It is
    // never a provider inference parameter.
    "visionInput",
  ];
  const rest = { ...parameters };
  let changed = false;
  for (const key of unsupported) {
    if (key in rest) {
      delete rest[key];
      changed = true;
    }
  }
  return changed ? rest : parameters;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a provider reference resolves to no wire protocol: it is neither a
 * name declared in `PROVIDERS` nor a built-in protocol name.
 *
 * The `provider` property contains the exact value that was passed in so
 * callers can include it in diagnostic messages / SSE error chunks.
 */
export class UnknownProviderError extends Error {
  constructor(public readonly provider: string) {
    const configured = configuredProviderNames();
    super(
      `Unknown LLM provider: "${provider}". Configured PROVIDERS names: ` +
        `${configured.join(", ") || "(none)"}; built-in protocols: ` +
        `${PROVIDER_PROTOCOLS.join(", ")}`,
    );
    this.name = "UnknownProviderError";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Optional per-call overrides for {@link createLlmProvider}. */
export interface LlmProviderOptions {
  /**
   * API key to use for this call, overriding the single key in {@link AppConfig}.
   */
  apiKey?: string;
  /**
   * Outbound fetch for providers routed through the reasoning interceptor.
   * Defaults to the process-wide Egress_Guard (SSRF-safe; keep-alive per
   * {@link resolveLlmKeepAlive}); tests may inject a stub, which then serves
   * both the first try and the single connect-retry. Streaming responses are
   * passed through untouched.
   */
  fetch?: typeof fetch;
}

/**
 * Whether provider requests reuse sockets: the instance's `keepAlive`
 * override wins over `LLM_HTTP_KEEP_ALIVE`; default true.
 */
export function resolveLlmKeepAlive(
  instance: Pick<ProviderInstance, "keepAlive"> | undefined,
  appConfig: Pick<AppConfig, "llmHttpKeepAlive">,
): boolean {
  return instance?.keepAlive ?? appConfig.llmHttpKeepAlive ?? true;
}

/**
 * Picks the real egress fetches for {@link createLlmTransportFetch}: the first
 * try reuses sockets only when `keepAlive` is on; the single connect-retry
 * always uses a fresh connection. A test `override` serves both.
 */
export function selectLlmTransportFetches(
  keepAlive: boolean,
  override?: typeof fetch,
): { primary: typeof fetch; fresh: typeof fetch } {
  return {
    primary:
      override ?? (keepAlive ? egressFetch : egressFetchWithoutKeepAlive),
    fresh: override ?? egressFetchWithoutKeepAlive,
  };
}

/**
 * Creates and returns a Vercel AI SDK `LanguageModel` for the given LLM
 * configuration.
 *
 * `config.provider` is either a NAME from `PROVIDERS` (whose instance supplies
 * the endpoint and credentials) or a bare protocol name (which falls back to the
 * legacy per-protocol AppConfig fields). The resolved PROTOCOL selects the SDK
 * client below, so several named instances can share one protocol — that is what
 * makes two vLLM servers, or vLLM alongside LM Studio, expressible.
 *
 * @param config    - The per-node (or global fallback) LLM configuration.
 * @param appConfig - The application configuration carrying API keys / URLs.
 * @param options   - Optional per-call overrides (e.g. a pooled API key).
 * @returns A `LanguageModel` instance ready for use with `streamText` / `generateText`.
 * @throws {UnknownProviderError} If `config.provider` resolves to no protocol.
 */
export function createLlmProvider(
  config: LlmConfig,
  appConfig: AppConfig,
  options?: LlmProviderOptions,
): LanguageModel {
  const overrideKey = options?.apiKey;
  const instance = getProviderInstance(config.provider);
  // Outbound transport for the reasoning interceptor: the process-wide
  // Egress_Guard by default (SSRF-safe), overridable in tests. Keep-alive is
  // configurable; the single connect-retry always uses a fresh connection.
  const keepAlive = resolveLlmKeepAlive(instance, appConfig);
  const baseFetch = createLlmTransportFetch({
    ...selectLlmTransportFetches(keepAlive, options?.fetch),
    provider: config.provider,
    model: config.model,
    keepAlive,
  });
  const protocol = resolveProviderProtocol(config.provider);
  if (protocol === undefined) throw new UnknownProviderError(config.provider);
  // Optional `chat_template_kwargs` (e.g. `{ enable_thinking: false }`) sourced
  // from the node's llm parameters, forwarded into the request body for the
  // OpenAI-compatible providers (LM Studio / Ollama / vLLM). Non-object values
  // are ignored. Never sent by the AI SDK itself — injected at the fetch layer.
  const rawKwargs = config.parameters?.chatTemplateKwargs;
  const chatTemplateKwargs =
    rawKwargs !== null &&
    typeof rawKwargs === "object" &&
    !Array.isArray(rawKwargs)
      ? (rawKwargs as Record<string, unknown>)
      : undefined;
  // Optional `reasoning_effort` (e.g. `"none"` to disable thinking) sourced from
  // the node's llm parameters, injected as a top-level request-body field for
  // the OpenAI-compatible providers. This is the field LM Studio honors (it
  // ignores `chat_template_kwargs`). Non-string/empty values are ignored.
  const rawEffort = config.parameters?.reasoningEffort;
  const reasoningEffort =
    typeof rawEffort === "string" && rawEffort.length > 0
      ? rawEffort
      : undefined;
  // Optional `extraBody` (e.g. `{ repeat_penalty: 1.15, frequency_penalty: 0.4 }`)
  // sourced from the node's llm parameters, merged verbatim into the request
  // body for the OpenAI-compatible providers. This is how anti-repetition
  // penalties and other server-honored sampling knobs reach LM Studio / Ollama /
  // vLLM (the AI SDK has no typed passthrough for e.g. `repeat_penalty`).
  // Non-object values are ignored.
  const rawExtra = config.parameters?.extraBody;
  const extraBody =
    rawExtra !== null &&
    typeof rawExtra === "object" &&
    !Array.isArray(rawExtra)
      ? (rawExtra as Record<string, unknown>)
      : undefined;
  switch (protocol) {
    case "openai": {
      // A self-hosted OpenAI-compatible server (vLLM / LM Studio / llama.cpp)
      // usually ignores the key but the SDK requires one, so a named instance
      // with a URL and no key gets a placeholder. Without an instance nothing is
      // passed and the SDK applies its own documented env defaults.
      const apiKey =
        overrideKey ??
        instance?.apiKey ??
        (instance?.url !== undefined ? "local" : undefined);
      const openai = createOpenAI({
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(instance?.url !== undefined ? { baseURL: instance.url } : {}),
        fetch: makeReasoningFetch(
          chatTemplateKwargs,
          reasoningEffort,
          extraBody,
          baseFetch,
        ),
      } as Parameters<typeof createOpenAI>[0]);
      // Use the Chat Completions API (`/v1/chat/completions`) explicitly rather
      // than the SDK's default Responses API (`/v1/responses`). The Responses
      // API sends conversation items under a top-level `input` field; OpenAI-
      // compatible servers (LM Studio / vLLM / llama.cpp) and gateways that back
      // local models implement chat completions reliably but mishandle the
      // Responses `input` items on tool-call round-trips — surfacing as
      // "Invalid type for 'input'" after the first tool step. Chat completions
      // also matches the SSE shape the reasoning-fetch interceptor rewrites
      // (`choices[].delta.reasoning_content`), so local thinking tokens survive.
      return openai.chat(config.model);
    }

    case "google": {
      const apiKey = overrideKey ?? instance?.apiKey;
      const google = createGoogleGenerativeAI({
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      return google(config.model);
    }

    case "ollama": {
      // ollama-ai-provider had no release compatible with @ai-sdk/provider ≥3.
      // Ollama exposes a fully OpenAI-compatible endpoint at /v1, so we use
      // @ai-sdk/openai instead. The instance URL is the host (a trailing /api or
      // /v1 is normalised away before appending /v1) so a config written for the
      // native endpoint keeps working. The reasoning-fetch shim is applied so
      // local reasoning models (qwen3, deepseek-r1, …) surface thinking tokens.
      const rawBase = instance?.url ?? "http://localhost:11434";
      const host = rawBase.replace(/\/(api|v1)\/?$/, "").replace(/\/$/, "");
      const openai = createOpenAI({
        baseURL: `${host}/v1`,
        // Ollama accepts any non-empty value.
        apiKey: instance?.apiKey ?? "ollama",
        fetch: makeReasoningFetch(
          chatTemplateKwargs,
          reasoningEffort,
          extraBody,
          baseFetch,
        ),
      } as Parameters<typeof createOpenAI>[0]);
      // Chat Completions API explicitly (see the openai case above): Ollama's
      // OpenAI-compatible surface is `/v1/chat/completions`, and the reasoning-
      // fetch interceptor expects the chat-completions SSE delta shape.
      return openai.chat(config.model);
    }

    case "azure": {
      // Azure OpenAI — the model field is the *deployment* name. Auth/endpoint
      // come from the named instance (resource name or explicit base URL).
      const apiKey = overrideKey ?? instance?.apiKey;
      const resourceName = instance?.resourceName;
      const baseURL = instance?.url;
      const apiVersion = instance?.apiVersion;
      const azure = createAzure({
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(resourceName !== undefined ? { resourceName } : {}),
        ...(baseURL !== undefined ? { baseURL } : {}),
        ...(apiVersion !== undefined ? { apiVersion } : {}),
      });
      return azure(config.model);
    }

    case "bedrock": {
      // Bedrock BYOK is an atomic JSON credential bundle. Never combine a
      // tenant access key with a platform secret/session credential.
      const tenantCredentials =
        overrideKey === undefined
          ? undefined
          : parseBedrockByokCredentials(overrideKey);
      if (overrideKey !== undefined && tenantCredentials === undefined) {
        throw new Error(
          "Bedrock BYOK must be a JSON object containing accessKeyId and secretAccessKey.",
        );
      }
      const region = instance?.region;
      // A named instance's static credentials are an atomic bundle, exactly like
      // a BYOK bundle: both halves or neither, so a half-formed identity is never
      // sent. With neither, the SDK falls back to the ambient AWS chain.
      const instanceCredentials =
        instance?.accessKeyId !== undefined &&
        instance.secretAccessKey !== undefined
          ? {
              accessKeyId: instance.accessKeyId,
              secretAccessKey: instance.secretAccessKey,
              ...(instance.sessionToken !== undefined
                ? { sessionToken: instance.sessionToken }
                : {}),
            }
          : undefined;
      const bedrock = createAmazonBedrock({
        ...(region !== undefined ? { region } : {}),
        ...(tenantCredentials ?? instanceCredentials ?? {}),
      });
      return bedrock(config.model);
    }

    case "anthropic": {
      // Anthropic Claude — model field is the Anthropic model ID
      // (e.g. "claude-3-5-sonnet-latest"). Auth comes from the named instance or
      // a pooled/BYOK key passed via options.
      const apiKey = overrideKey ?? instance?.apiKey;
      const anthropic = createAnthropic({
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(instance?.url !== undefined ? { baseURL: instance.url } : {}),
      });
      return anthropic(config.model);
    }

    default: {
      // TypeScript exhaustiveness check — `protocol` is `never` here when every
      // member of ProviderProtocol is handled above.
      const exhaustiveCheck: never = protocol;
      throw new UnknownProviderError(String(exhaustiveCheck));
    }
  }
}

// ---------------------------------------------------------------------------
// Embedding factory (semantic cache / RAG)
// ---------------------------------------------------------------------------

/**
 * Creates a Vercel AI SDK `EmbeddingModel<string>` for the given embedding
 * configuration. Credentials/URLs come exclusively from {@link AppConfig}.
 *
 * @throws {UnknownProviderError} If the provider is not embedding-capable here.
 */
export function createEmbeddingProvider(
  config: EmbeddingConfig,
  _appConfig: AppConfig,
): EmbeddingModel {
  const instance = getProviderInstance(config.provider);
  const protocol = resolveProviderProtocol(config.provider);
  if (protocol === undefined) throw new UnknownProviderError(config.provider);
  switch (protocol) {
    case "openai": {
      const apiKey =
        instance?.apiKey ?? (instance?.url !== undefined ? "local" : undefined);
      const openai = createOpenAI({
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(instance?.url !== undefined ? { baseURL: instance.url } : {}),
      });
      return openai.embedding(config.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({
        ...(instance?.apiKey !== undefined ? { apiKey: instance.apiKey } : {}),
      });
      return google.embedding(config.model);
    }
    case "ollama": {
      // See createLlmProvider's ollama case: normalise any trailing /api|/v1
      // path before appending /v1 for the OpenAI-compatible endpoint.
      const rawBase = instance?.url ?? "http://localhost:11434";
      const host = rawBase.replace(/\/(api|v1)\/?$/, "").replace(/\/$/, "");
      const openai = createOpenAI({
        baseURL: `${host}/v1`,
        apiKey: instance?.apiKey ?? "ollama",
      });
      return openai.embedding(config.model);
    }
    default:
      // azure / bedrock / anthropic have no embedding client wired here.
      throw new UnknownProviderError(config.provider);
  }
}
