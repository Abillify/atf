// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Context-window resolution and token estimation (`src/graph/context-window.ts`)
 *
 * Answers "how much room does this model actually have, and how much of it are
 * we about to use?" — the prerequisite for every window-relative decision
 * (tool-result budgets, compression triggers). Without it those mechanisms can
 * only use absolute constants, which are either wasteful on a large model or
 * request-rejecting on a small local one.
 *
 * Two deliberate design choices:
 *
 * 1. **`undefined` means unknown, and unknown is never guessed.** A model id
 *    alone cannot reveal the window of a locally loaded model — the `openai`
 *    provider is also how this codebase reaches LM Studio / vLLM / llama.cpp,
 *    where the window is set at load time. Callers must fall back to absolute
 *    defaults rather than inventing a number: guessing too high produces
 *    oversized requests the provider rejects outright.
 *
 * 2. **Estimation is intentionally coarse (~4 chars/token) and biased low.**
 *    Running a real tokenizer per provider would add a heavy dependency and
 *    still be wrong for whichever model is not covered. Under-estimating means a
 *    budget mechanism engages slightly later (a mild, recoverable miss);
 *    over-estimating means it engages when it did not need to, silently
 *    degrading context for no reason.
 *
 * No `any` at module boundaries.
 */

import type { ModelMessage } from "ai";
import type { LlmConfig } from "../types/flow.js";
import { getModelCapabilities } from "./model-capabilities.js";
import { estimateTokensFromText } from "../observability/cost.js";

/**
 * Characters per token for the coarse estimator. Matches
 * `estimateTokensFromText` in the cost module — kept as a named export so
 * budget code can convert a token window into a character budget without
 * re-deriving the ratio.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Tokens kept free for provider chat templates, tool schemas and estimator
 * error. Those bytes are not fully represented by the portable message
 * estimator, so reserving a small fixed margin prevents boundary overflows.
 */
export const CONTEXT_OUTPUT_SAFETY_TOKENS = 1_024;

/**
 * Per-message overhead in tokens for role markers / chat-template scaffolding.
 * Small and provider-dependent; included so a long conversation of short turns
 * is not badly under-counted.
 */
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Reads an explicit `contextLength` override from a node's llm parameters.
 *
 * This is the authoritative source for local models, where the window is a
 * deployment fact the operator knows and the model id does not carry. Like
 * `extraBody` / `reasoningEffort` / `chatTemplateKwargs`, the key is consumed by
 * the engine and never forwarded to the provider as an inference parameter.
 *
 * Rejects non-positive and non-integer values so a typo cannot produce a
 * zero-sized window (which would make every budget collapse to its floor).
 */
export function readContextLengthOverride(
  llmConfig: Pick<LlmConfig, "parameters"> | undefined,
): number | undefined {
  const raw = llmConfig?.parameters?.contextLength;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const value = Math.floor(raw);
  return value > 0 ? value : undefined;
}

/**
 * Resolves the effective context window for a model.
 *
 * Precedence: explicit `llm.parameters.contextLength` → capability registry →
 * `undefined` (unknown).
 */
export function resolveContextWindow(
  llmConfig: Pick<LlmConfig, "provider" | "model" | "parameters"> | undefined,
): number | undefined {
  if (llmConfig === undefined) return undefined;
  const override = readContextLengthOverride(llmConfig);
  if (override !== undefined) return override;
  return getModelCapabilities(llmConfig.provider, llmConfig.model).contextLength;
}

/**
 * Usable INPUT budget in tokens: the window minus the output reservation.
 *
 * The provider carves `maxTokens` of completion space out of the SAME window, so
 * a threshold computed against the raw window lets a conversation sail past the
 * real input limit and get rejected. Mirrors the effective-window arithmetic in
 * Hermes's compaction trigger.
 *
 * Returns `undefined` when the window is unknown. When the reservation would
 * consume the whole window (a misconfigured `maxTokens`), the raw window is
 * returned rather than a non-positive number.
 */
export function effectiveInputBudget(
  contextLength: number | undefined,
  maxOutputTokens?: number,
): number | undefined {
  if (contextLength === undefined || contextLength <= 0) return undefined;
  const reservation =
    typeof maxOutputTokens === "number" &&
    Number.isFinite(maxOutputTokens) &&
    maxOutputTokens > 0
      ? Math.floor(maxOutputTokens)
      : 0;
  const budget = contextLength - reservation;
  return budget > 0 ? budget : contextLength;
}

/** Serialises a message's content to text for estimation purposes. */
function serializeForEstimate(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const part = raw as { type?: string; text?: string };
      if (typeof part.text === "string") {
        parts.push(part.text);
        continue;
      }
      try {
        parts.push(JSON.stringify(raw) ?? "");
      } catch {
        /* unserialisable part — contributes nothing */
      }
    }
    return parts.join("\n");
  }
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "";
  }
}

/** Coarse token estimate for a single message, including role overhead. */
export function estimateMessageTokens(message: ModelMessage): number {
  const body = serializeForEstimate((message as { content?: unknown }).content);
  const toolCalls = (message as { toolCalls?: unknown }).toolCalls;
  const extra =
    toolCalls === undefined ? "" : serializeForEstimate(toolCalls);
  return (
    estimateTokensFromText(body) +
    estimateTokensFromText(extra) +
    PER_MESSAGE_OVERHEAD_TOKENS
  );
}

/** Coarse token estimate for a whole message list. */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/**
 * Bounds a configured completion reservation to the room left by the current
 * prompt. The calculation is repeated at every provider attempt and tool-loop
 * step because both retry guidance and tool results grow the prompt after the
 * initial request was assembled.
 *
 * Unknown context windows preserve the configured value. A one-token floor
 * keeps the provider request valid when the estimated prompt has already
 * consumed the available window; callers may then rely on their normal
 * provider-error/fallback path instead of sending an invalid zero allowance.
 */
export function clampMaxOutputTokens(
  messages: ModelMessage[],
  llmConfig: Pick<LlmConfig, "provider" | "model" | "parameters"> | undefined,
  configuredMaxOutputTokens: number | undefined,
  safetyTokens = CONTEXT_OUTPUT_SAFETY_TOKENS,
): number | undefined {
  if (
    configuredMaxOutputTokens === undefined ||
    !Number.isFinite(configuredMaxOutputTokens) ||
    configuredMaxOutputTokens <= 0
  ) {
    return configuredMaxOutputTokens;
  }

  const configured = Math.floor(configuredMaxOutputTokens);
  const contextLength = resolveContextWindow(llmConfig);
  if (contextLength === undefined) return configured;

  const safety =
    Number.isFinite(safetyTokens) && safetyTokens > 0
      ? Math.floor(safetyTokens)
      : 0;
  const available = Math.max(
    1,
    contextLength - estimateMessagesTokens(messages) - safety,
  );
  return Math.min(configured, available);
}

/** Result of comparing an estimated prompt size against a model's window. */
export interface ContextPressure {
  /** Estimated prompt tokens. */
  estimatedTokens: number;
  /** Resolved window, or undefined when unknown. */
  contextLength?: number;
  /** Usable input budget (window minus output reservation), when known. */
  inputBudget?: number;
  /**
   * `estimatedTokens / inputBudget`, or `undefined` when the window is unknown.
   * Values > 1 mean the request is expected to be rejected.
   */
  utilization?: number;
}

/**
 * Measures how much of a model's usable input budget an assembled prompt is
 * expected to consume. Returns `utilization: undefined` for unknown windows so
 * callers can distinguish "no pressure" from "cannot tell".
 */
export function measureContextPressure(
  messages: ModelMessage[],
  llmConfig: Pick<LlmConfig, "provider" | "model" | "parameters"> | undefined,
  maxOutputTokens?: number,
): ContextPressure {
  const estimatedTokens = estimateMessagesTokens(messages);
  const contextLength = resolveContextWindow(llmConfig);
  const inputBudget = effectiveInputBudget(contextLength, maxOutputTokens);
  return {
    estimatedTokens,
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(inputBudget !== undefined ? { inputBudget } : {}),
    ...(inputBudget !== undefined && inputBudget > 0
      ? {
          utilization:
            Math.round((estimatedTokens / inputBudget) * 10_000) / 10_000,
        }
      : {}),
  };
}
