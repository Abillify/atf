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
 * Active default ratio, seeded from the `CHARS_PER_TOKEN` env var at startup
 * via {@link setDefaultCharsPerToken}. The exported constant above stays the
 * factory default; this mutable value is what the estimator actually uses.
 */
let defaultCharsPerToken = CHARS_PER_TOKEN;

function isValidCharsPerToken(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 8;
}

/**
 * Overrides the process-wide default characters-per-token ratio (called once
 * at startup from the loaded config). Values outside 1.0–8.0 are ignored so a
 * bad env value can never distort the estimate.
 */
export function setDefaultCharsPerToken(value: number): void {
  if (isValidCharsPerToken(value)) defaultCharsPerToken = value;
}

/**
 * Resolves the characters-per-token ratio for an LLM config: the per-model
 * `charsPerToken` field wins over the process-wide default (env var).
 */
export function charsPerTokenFor(llm?: { charsPerToken?: number }): number {
  return isValidCharsPerToken(llm?.charsPerToken)
    ? llm.charsPerToken
    : defaultCharsPerToken;
}

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

/**
 * Conservative token reservation for one multimodal image part.
 *
 * Provider SDKs transmit an inline data URL as image input, not as ordinary
 * prompt text. Counting its base64 bytes at CHARS_PER_TOKEN can overestimate a
 * single screenshot by hundreds of thousands of tokens and collapse the
 * completion allowance to one token. Actual visual-token accounting is
 * provider/model dependent, so reserve a bounded value instead. The image
 * payload itself remains untouched in the model request.
 */
export const IMAGE_PART_ESTIMATE_TOKENS = 8_192;

function serializedTokenEstimate(content: unknown): number {
  try {
    return estimateTokensFromText(JSON.stringify(content) ?? "");
  } catch {
    return 0;
  }
}

/** Estimates text and multimodal content without treating image bytes as text. */
function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokensFromText(content);
  if (content === null || content === undefined) return 0;
  if (!Array.isArray(content)) return serializedTokenEstimate(content);

  let total = 0;
  for (const raw of content) {
    const part = raw as { type?: string; text?: string; mediaType?: string };
    if (
      part.type === "image" ||
      part.type === "image_url" ||
      (part.type === "file" &&
        (part.mediaType === "image" ||
          part.mediaType?.startsWith("image/")))
    ) {
      total += IMAGE_PART_ESTIMATE_TOKENS;
      continue;
    }
    if (typeof part.text === "string") {
      total += estimateTokensFromText(part.text);
      continue;
    }
    total += serializedTokenEstimate(raw);
  }
  return total;
}

/** Coarse token estimate for a single message, including role overhead. */
export function estimateMessageTokens(message: ModelMessage): number {
  const bodyTokens = estimateContentTokens(
    (message as { content?: unknown }).content,
  );
  const toolCalls = (message as { toolCalls?: unknown }).toolCalls;
  const extraTokens =
    toolCalls === undefined ? 0 : estimateContentTokens(toolCalls);
  return bodyTokens + extraTokens + PER_MESSAGE_OVERHEAD_TOKENS;
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

// ---------------------------------------------------------------------------
// Deterministic prompt truncation (hard cap against the output-token clamp)
// ---------------------------------------------------------------------------

/**
 * Share of a truncated message's surviving budget spent on the head; the rest
 * is kept from the tail. Mirrors `tool-result-budget`'s HEAD_SHARE: a large
 * carried-forward context usually leads with scope/instructions and closes with
 * the decisive findings, so keeping both ends beats a head-only cut.
 */
const TRUNCATION_HEAD_SHARE = 0.7;

/**
 * Smallest surviving size for a single truncated message. Below this the
 * head/tail split is not worth the elision marker, so the message is cut whole
 * to the marker only. ~2k chars ≈ 500 tokens.
 */
const MIN_TRUNCATED_MESSAGE_CHARS = 2_000;

/** Outcome of {@link truncateMessagesToWindow}. */
export interface ContextTruncation {
  /** The (possibly rewritten) message list to send to the provider. */
  messages: ModelMessage[];
  /** True when at least one message was shortened. */
  truncated: boolean;
  /** Total characters elided across all shortened messages. */
  removedChars: number;
  /** Number of messages that were shortened. */
  truncatedMessages: number;
  /** Estimated prompt tokens after truncation. */
  estimatedTokensAfter: number;
  /** Estimated prompt tokens before truncation. */
  estimatedTokensBefore: number;
}

/** Builds the deterministic marker inserted where content was elided. */
function elisionMarker(removedChars: number): string {
  return `\n\n[… ${removedChars} Zeichen aus dem Kontext gekürzt, um das Modell-Context-Window einzuhalten …]\n\n`;
}

/**
 * Shortens one string to `keepChars`, preserving head and tail around a
 * deterministic elision marker. Returns the original when it already fits or
 * when the surviving budget is too small to be worth splitting (then it is cut
 * to the marker plus a head slice). Pure function of (text, keepChars).
 */
function truncateText(text: string, keepChars: number): string {
  if (text.length <= keepChars) return text;
  const removed = text.length - keepChars;
  const marker = elisionMarker(removed);
  if (keepChars < MIN_TRUNCATED_MESSAGE_CHARS) {
    return text.slice(0, Math.max(0, keepChars)) + marker;
  }
  const budget = keepChars - marker.length;
  if (budget <= 0) return marker;
  const headChars = Math.floor(budget * TRUNCATION_HEAD_SHARE);
  const tailChars = budget - headChars;
  return text.slice(0, headChars) + marker + text.slice(text.length - tailChars);
}

/**
 * Deterministically shrinks an assembled prompt so its estimated size stays
 * within the model's usable input budget, instead of letting the output-token
 * allowance collapse to 1 (the failure mode where `clampMaxOutputTokens` floors
 * `maxOutputTokens` at 1 and the model can emit nothing — no final-answer
 * marker, no verifier pass signal).
 *
 * Design (mirrors `tool-result-budget`):
 * - **Deterministic.** A pure function of (messages, window, reservation): the
 *   same input truncates to the same bytes on every retry, so it does not break
 *   provider prompt-cache reuse.
 * - **Newest-first retention.** The LAST message (the current task/question) is
 *   never touched; older, larger string messages are cut first. A synthesizer's
 *   oversized carried-forward context is exactly such an earlier message.
 * - **String content only.** Image parts and tool-call structures are left
 *   intact — images are budgeted separately and cutting their bytes as text
 *   would corrupt them without reliably reclaiming window.
 *
 * Returns the original list unchanged (`truncated: false`) when the window is
 * unknown or the prompt already fits — the same "never guess a window" rule the
 * rest of this module follows.
 */
export function truncateMessagesToWindow(
  messages: ModelMessage[],
  llmConfig:
    | Pick<LlmConfig, "provider" | "model" | "parameters" | "charsPerToken">
    | undefined,
  maxOutputTokens: number | undefined,
  safetyTokens = CONTEXT_OUTPUT_SAFETY_TOKENS,
): ContextTruncation {
  const estimatedTokensBefore = estimateMessagesTokens(messages);
  const contextLength = resolveContextWindow(llmConfig);
  const unchanged: ContextTruncation = {
    messages,
    truncated: false,
    removedChars: 0,
    truncatedMessages: 0,
    estimatedTokensAfter: estimatedTokensBefore,
    estimatedTokensBefore,
  };

  if (contextLength === undefined || contextLength <= 0) return unchanged;

  const reservation =
    typeof maxOutputTokens === "number" &&
    Number.isFinite(maxOutputTokens) &&
    maxOutputTokens > 0
      ? Math.floor(maxOutputTokens)
      : 0;
  const safety =
    Number.isFinite(safetyTokens) && safetyTokens > 0
      ? Math.floor(safetyTokens)
      : 0;

  // Token budget the prompt must fit into so the configured output allowance
  // survives intact. Floored at 1 so a pathological reservation cannot make the
  // target non-positive.
  const targetInputTokens = Math.max(1, contextLength - reservation - safety);
  if (estimatedTokensBefore <= targetInputTokens) return unchanged;

  // How many prompt tokens (hence chars) must go. Bias the char target low by
  // using the same coarse ratio the estimator uses, so one pass is enough.
  const tokensToRemove = estimatedTokensBefore - targetInputTokens;
  let charsToRemove = tokensToRemove * charsPerTokenFor(llmConfig);

  const next = [...messages];
  let removedChars = 0;
  let truncatedMessages = 0;

  // Never touch the final message (the current task/question). Cut earlier
  // string messages, largest first, until the target is met. "Largest first"
  // is deterministic (stable by size then original index) and reclaims the most
  // window per edited message.
  const lastIndex = next.length - 1;
  const candidates = next
    .map((message, index) => ({ index, message }))
    .filter(
      ({ index, message }) =>
        index !== lastIndex && typeof message.content === "string",
    )
    .sort((a, b) => {
      const lenA = (a.message.content as string).length;
      const lenB = (b.message.content as string).length;
      if (lenB !== lenA) return lenB - lenA;
      return a.index - b.index;
    });

  for (const { index, message } of candidates) {
    if (charsToRemove <= 0) break;
    const content = message.content as string;
    // Keep at least the floor so a shortened message still carries a usable
    // head/tail rather than collapsing to nothing.
    const keepChars = Math.max(
      MIN_TRUNCATED_MESSAGE_CHARS,
      content.length - charsToRemove,
    );
    if (keepChars >= content.length) continue;
    const shortened = truncateText(content, keepChars);
    const removed = content.length - shortened.length;
    if (removed <= 0) continue;
    next[index] = { ...message, content: shortened } as ModelMessage;
    removedChars += removed;
    truncatedMessages += 1;
    charsToRemove -= removed;
  }

  if (truncatedMessages === 0) return unchanged;

  const estimatedTokensAfter = estimateMessagesTokens(next);
  return {
    messages: next,
    truncated: true,
    removedChars,
    truncatedMessages,
    estimatedTokensAfter,
    estimatedTokensBefore,
  };
}
