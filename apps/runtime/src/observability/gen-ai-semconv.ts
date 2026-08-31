// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OpenTelemetry GenAI semantic conventions (`src/observability/gen-ai-semconv.ts`)
 *
 * The platform already emits custom flow/node spans via {@link Tracer}. This
 * module annotates the LLM spans with the OpenTelemetry **GenAI semantic
 * conventions** (the `gen_ai.*` attribute namespace), so traces are understood
 * out-of-the-box by GenAI-aware backends — Langfuse, Arize Phoenix, Datadog LLM
 * Observability, Grafana Tempo's GenAI views — instead of requiring per-vendor
 * custom mapping.
 *
 * Reference: OpenTelemetry "Semantic conventions for generative AI" (the
 * `gen_ai.system`, `gen_ai.request.*`, `gen_ai.response.*`, `gen_ai.usage.*`
 * attributes and the `{operation} {model}` span-name convention).
 *
 * Pure helpers over the existing {@link Span} contract — no new dependency and
 * no hot-path cost beyond setting a few attributes (and nothing at all when the
 * tracer is the no-op).
 *
 * No `any` at module boundaries.
 */

import type { Span, Tracer, SpanContext } from "./tracing.js";
import { resolveProviderProtocol } from "../config/providers.js";

/** Stable attribute keys from the OTel GenAI semantic conventions. */
export const GEN_AI_ATTRS = {
  system: "gen_ai.system",
  operationName: "gen_ai.operation.name",
  requestModel: "gen_ai.request.model",
  requestTemperature: "gen_ai.request.temperature",
  requestMaxTokens: "gen_ai.request.max_tokens",
  responseModel: "gen_ai.response.model",
  responseFinishReasons: "gen_ai.response.finish_reasons",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  // Not part of the spec but widely consumed by cost-aware backends.
  usageCost: "gen_ai.usage.cost",
  /**
   * Prompt-cache read tokens — the portion of `input_tokens` the provider
   * served from a warm cache instead of re-prefilling. Not in the OTel spec
   * yet; this is the key Langfuse / OpenLLMetry / Datadog LLM Observability
   * consume, so cache effectiveness is visible in the same trace view as cost.
   *
   * Without this attribute there is no way to verify that a prompt-stability
   * change actually landed: an unstable system prefix produces identical
   * `input_tokens` whether it hit the cache or not.
   */
  usageCachedInputTokens: "gen_ai.usage.cache_read_input_tokens",
} as const;

/**
 * Maps an internal provider reference to the conventional `gen_ai.system` value.
 *
 * A named endpoint is first resolved to its wire protocol, so a deployment that
 * calls its vLLM box `gpuvllm` still reports the standard `openai` system value
 * and stays comparable in dashboards. An unresolvable name is passed through
 * unchanged rather than guessed at.
 */
export function genAiSystem(provider: string): string {
  switch (resolveProviderProtocol(provider) ?? provider) {
    case "openai":
      return "openai";
    case "google":
      return "gcp.gemini";
    case "azure":
      return "azure.ai.openai";
    case "bedrock":
      return "aws.bedrock";
    case "anthropic":
      return "anthropic";
    case "ollama":
      return "ollama";
    default:
      return provider;
  }
}

export type GenAiOperation = "chat" | "text_completion" | "embeddings";

export interface GenAiRequest {
  provider: string;
  model: string;
  operation?: GenAiOperation;
  temperature?: number;
  maxTokens?: number;
}

export interface GenAiResponse {
  /** Model id actually used (may differ from requested, e.g. after fallback). */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Subset of `inputTokens` the provider served from its prompt cache. A value
   * near `inputTokens` means the request's prefix was reused; a persistent 0 on
   * a cache-capable model means the prefix is changing between turns.
   */
  cachedInputTokens?: number;
  finishReasons?: string[];
  cost?: number;
}

/**
 * Conventional span name: `"{operation} {model}"` (e.g. `chat gpt-4o-mini`).
 * GenAI backends key their UIs off this shape.
 */
export function genAiSpanName(
  operation: GenAiOperation,
  model: string,
): string {
  return `${operation} ${model}`;
}

/** Sets the request-side `gen_ai.*` attributes on a span. */
export function setGenAiRequestAttributes(span: Span, req: GenAiRequest): void {
  const operation = req.operation ?? "chat";
  span.setAttribute(GEN_AI_ATTRS.system, genAiSystem(req.provider));
  span.setAttribute(GEN_AI_ATTRS.operationName, operation);
  span.setAttribute(GEN_AI_ATTRS.requestModel, req.model);
  if (req.temperature !== undefined) {
    span.setAttribute(GEN_AI_ATTRS.requestTemperature, req.temperature);
  }
  if (req.maxTokens !== undefined) {
    span.setAttribute(GEN_AI_ATTRS.requestMaxTokens, req.maxTokens);
  }
}

/** Sets the response-side `gen_ai.*` attributes on a span. */
export function setGenAiResponseAttributes(
  span: Span,
  res: GenAiResponse,
): void {
  if (res.model !== undefined)
    span.setAttribute(GEN_AI_ATTRS.responseModel, res.model);
  if (res.inputTokens !== undefined) {
    span.setAttribute(GEN_AI_ATTRS.usageInputTokens, res.inputTokens);
  }
  if (res.outputTokens !== undefined) {
    span.setAttribute(GEN_AI_ATTRS.usageOutputTokens, res.outputTokens);
  }
  // Emitted even when 0: "cache-capable model, zero cache reads" is the signal
  // that a prompt-stability regression has landed, and an absent attribute is
  // indistinguishable from "provider reports no cache data at all".
  if (res.cachedInputTokens !== undefined) {
    span.setAttribute(
      GEN_AI_ATTRS.usageCachedInputTokens,
      res.cachedInputTokens,
    );
  }
  if (res.finishReasons !== undefined && res.finishReasons.length > 0) {
    // OTel arrays are serialised; join for the single-value attribute model here.
    span.setAttribute(
      GEN_AI_ATTRS.responseFinishReasons,
      res.finishReasons.join(","),
    );
  }
  if (res.cost !== undefined) {
    span.setAttribute(GEN_AI_ATTRS.usageCost, res.cost);
  }
}

/**
 * Starts a GenAI-convention LLM span (client kind, conventional name + request
 * attributes). Returns the no-op span when tracing is disabled, so callers can
 * use it unconditionally.
 */
export function startLlmSpan(
  tracer: Tracer,
  req: GenAiRequest,
  parent?: SpanContext,
): Span {
  const operation = req.operation ?? "chat";
  const span = tracer.startSpan(genAiSpanName(operation, req.model), {
    kind: "client",
    ...(parent !== undefined ? { parent } : {}),
  });
  setGenAiRequestAttributes(span, req);
  return span;
}
