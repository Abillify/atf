// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Prompt prefix stability tracking (`src/graph/prompt-prefix-stability.ts`)
 *
 * Answers one question per LLM call: **did this request reuse the previous
 * request's prompt prefix byte-for-byte, or did we force a full re-prefill?**
 *
 * Why this exists alongside `usage.cachedInputTokens`:
 *
 * - Remote providers (Anthropic, Bedrock, OpenAI) report prompt-cache reads, so
 *   their hit rate is directly observable. Local OpenAI-compatible servers
 *   (LM Studio, llama.cpp, vLLM, Ollama) mostly report NOTHING — yet they are
 *   exactly where prefix reuse matters most, because their KV cache turns a
 *   stable prefix into a near-zero prefill instead of a discount.
 * - `promptTokens` is useless as a proxy: an unstable prefix bills the same
 *   token count, it just recomputes all of them.
 *
 * So we measure the property the caches actually key on — a byte-identical
 * leading run of messages — locally, without provider cooperation.
 *
 * The ideal state is `appendOnly: true`: the previous request's messages are an
 * exact prefix of the current one, and everything new is appended at the end.
 * Every KV/prompt cache reuses the whole shared prefix in that case. The two
 * failure shapes this surfaces:
 *
 * - `firstDivergenceIndex === 0` — the SYSTEM message changed. Worst case: the
 *   entire prompt re-prefills every turn. Usually caused by injecting volatile
 *   state (timestamps, live tool/server status, per-request tool selection)
 *   into the system prompt.
 * - `firstDivergenceIndex > 0` — history was rewritten mid-array (a message was
 *   dropped, deduplicated, summarised, or edited in place). Everything from
 *   that index on re-prefills.
 *
 * All comparison logic is pure and unit-testable; only {@link PromptPrefixTracker}
 * holds (bounded) state.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { ModelMessage } from "ai";

/**
 * Max distinct prompt streams tracked at once. Each entry holds only
 * fingerprints (a hash + role + length per message), not message content, so
 * the footprint is small — but it still must be bounded in a long-lived server.
 * Evicted least-recently-observed first; an evicted stream simply reports no
 * comparison on its next call rather than a wrong one.
 */
export const PREFIX_TRACKER_MAX_STREAMS = 500;

/** Per-message fingerprint used for prefix comparison. */
export interface MessageFingerprint {
  /** Stable digest of role + content. */
  hash: string;
  role: string;
  /** Serialized content length, used to weight the reuse ratio by size. */
  chars: number;
}

export interface PrefixStabilityReport {
  previousMessages: number;
  currentMessages: number;
  /** Leading messages that are byte-identical to the previous request. */
  stableMessages: number;
  /** Serialized characters inside the stable prefix. */
  stableChars: number;
  /** Serialized characters in the whole current request. */
  currentChars: number;
  /**
   * `stableChars / currentChars`, rounded to 4 decimals. 1 means the entire
   * current prompt was already present (only possible when nothing was added);
   * 0 means not even the system message survived.
   */
  reuseRatio: number;
  /**
   * Index of the first message that differs from the previous request, or `-1`
   * when the previous request is an exact prefix of this one (the good case).
   */
  firstDivergenceIndex: number;
  /** Role of the first diverging message, when there is one. */
  firstDivergenceRole?: string;
  /**
   * True when the previous message list is an exact leading prefix of the
   * current one — i.e. the conversation only grew at the end. This is the
   * property prompt/KV caches need; anything else invalidates from the
   * divergence point onward.
   */
  appendOnly: boolean;
}

/**
 * Serializes a message's content for hashing.
 *
 * `providerOptions` is deliberately EXCLUDED: cache-control breakpoints
 * (`applyAnthropicPromptCache` / `applyBedrockPromptCache`) are metadata about
 * caching, not part of the cached token stream, and they legitimately move
 * between turns. Including them would report a divergence on every turn and
 * mask the real signal.
 */
function serializeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const part = raw as { type?: string; text?: string };
      if (typeof part.text === "string") {
        parts.push(`${part.type ?? "text"}:${part.text}`);
      } else {
        // Non-text parts (images, files, tool calls/results): hash their shape.
        try {
          parts.push(JSON.stringify(raw));
        } catch {
          parts.push(String(part.type ?? "unknown"));
        }
      }
    }
    return parts.join("\u0000");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Builds the fingerprint for a single message. */
export function fingerprintMessage(message: ModelMessage): MessageFingerprint {
  const role = String((message as { role?: unknown }).role ?? "unknown");
  const body = serializeContent((message as { content?: unknown }).content);
  // Tool calls live outside `content` on assistant messages in some shapes and
  // are part of what the model re-reads, so they belong in the fingerprint.
  const toolCalls = (message as { toolCalls?: unknown }).toolCalls;
  const extra = toolCalls === undefined ? "" : safeStringify(toolCalls);
  const payload = `${role}\u0001${body}\u0001${extra}`;
  return {
    hash: crypto.createHash("sha1").update(payload).digest("hex"),
    role,
    chars: body.length + extra.length,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Builds fingerprints for a whole message list. */
export function fingerprintMessages(
  messages: ModelMessage[],
): MessageFingerprint[] {
  return messages.map(fingerprintMessage);
}

/**
 * Compares two fingerprint lists and reports how much of the leading prefix is
 * byte-identical. Pure.
 */
export function comparePrefix(
  previous: MessageFingerprint[],
  current: MessageFingerprint[],
): PrefixStabilityReport {
  const currentChars = current.reduce((sum, f) => sum + f.chars, 0);

  let stableMessages = 0;
  let stableChars = 0;
  const limit = Math.min(previous.length, current.length);
  while (stableMessages < limit) {
    const prev = previous[stableMessages];
    const curr = current[stableMessages];
    if (prev === undefined || curr === undefined || prev.hash !== curr.hash) {
      break;
    }
    stableChars += curr.chars;
    stableMessages++;
  }

  // A divergence exists only when the previous list did NOT run out first. If
  // it did, the previous request is an exact prefix of this one — append-only.
  const diverged = stableMessages < previous.length;
  const firstDivergenceIndex = diverged ? stableMessages : -1;
  const divergingRole =
    diverged && stableMessages < current.length
      ? current[stableMessages]?.role
      : diverged
        ? previous[stableMessages]?.role
        : undefined;

  return {
    previousMessages: previous.length,
    currentMessages: current.length,
    stableMessages,
    stableChars,
    currentChars,
    reuseRatio:
      currentChars > 0
        ? Math.round((stableChars / currentChars) * 10_000) / 10_000
        : 0,
    firstDivergenceIndex,
    ...(divergingRole !== undefined
      ? { firstDivergenceRole: divergingRole }
      : {}),
    appendOnly: !diverged,
  };
}

/**
 * Bounded, in-process tracker of the last prompt shape per stream.
 *
 * A "stream" is a (conversation, node) pair — each node in a flow builds its own
 * prompt, so mixing them would report constant divergence. Callers build the key
 * with {@link streamKey}.
 *
 * Not durable and not shared across replicas by design: this is a diagnostic
 * for the CURRENT process's behaviour, and a cross-replica comparison would be
 * meaningless anyway (the KV cache is local to the inference server the replica
 * talks to).
 */
export class PromptPrefixTracker {
  private readonly last = new Map<string, MessageFingerprint[]>();

  constructor(
    private readonly maxStreams: number = PREFIX_TRACKER_MAX_STREAMS,
  ) {}

  /**
   * Records the current prompt for `key` and returns how it compares to the
   * previous one. Returns `undefined` on the first observation of a stream
   * (nothing to compare against yet).
   */
  observe(
    key: string,
    messages: ModelMessage[],
  ): PrefixStabilityReport | undefined {
    const current = fingerprintMessages(messages);
    const previous = this.last.get(key);

    // Re-insert so Map iteration order reflects recency (used for eviction).
    this.last.delete(key);
    this.last.set(key, current);

    while (this.last.size > this.maxStreams) {
      const oldest = this.last.keys().next();
      if (oldest.done === true) break;
      this.last.delete(oldest.value);
    }

    if (previous === undefined) return undefined;
    return comparePrefix(previous, current);
  }

  /** Drops a stream's history (e.g. when a conversation is deleted). */
  forget(key: string): void {
    this.last.delete(key);
  }

  /** Number of tracked streams — for tests and diagnostics. */
  get size(): number {
    return this.last.size;
  }
}

/**
 * Builds the tracker key for a (conversation, node, model) triple.
 *
 * The model is part of the key because switching models (routing, fallback)
 * moves the request to a different cache entirely — comparing across them would
 * report a spurious divergence rather than a real regression.
 */
export function streamKey(
  conversationId: string | undefined,
  nodeId: string,
  modelKey: string,
): string {
  return `${conversationId ?? "-"}::${nodeId}::${modelKey}`;
}

/**
 * Process-wide tracker used by the LLM node handler.
 *
 * A module singleton rather than a per-request object because the comparison is
 * inherently ACROSS requests: turn N's prompt is compared to turn N-1's, which
 * arrived on a different request. Bounded by {@link PREFIX_TRACKER_MAX_STREAMS}.
 */
export const promptPrefixTracker = new PromptPrefixTracker();
