// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Conversation history compression (`src/graph/history-compression.ts`)
 *
 * Keeps a long conversation inside the model's context window without the
 * information loss of a hard turn-count cut (`trimConversationHistory`, which is
 * also opt-in and therefore off by default).
 *
 * ## Where this runs, and why that shapes the design
 *
 * `AgentStateAnnotation.messages` uses an APPEND-ONLY reducer
 * (`left.concat(right)`), so a node cannot rewrite history in state. Compression
 * is therefore a per-request transform applied while assembling the prompt — the
 * same place `deduplicateRagContext` and `trimConversationHistory` already act.
 *
 * That has one sharp consequence: a naive LLM summary would be recomputed every
 * turn, and because generation is non-deterministic the summary bytes would
 * differ each time — invalidating the prompt-cache prefix on every single turn,
 * which costs far more than the compression saves. The fix is
 * {@link SummaryCache}: a summary is keyed by a fingerprint of the exact message
 * range it covers. History being append-only, that range is unchanged on the
 * next turn, so the cached summary is reused verbatim and the prefix stays
 * stable. A new summary is only produced when the covered range actually
 * changes — making compression a rare, deliberate cache invalidation rather than
 * a per-turn one.
 *
 * ## Two stages, cheapest first
 *
 * 1. **Deterministic pre-pass** ({@link dedupeRepeatedToolResults}) — no model
 *    call, no config, no risk: identical repeated tool results collapse to a
 *    back-reference. Reading the same document three times should cost one copy.
 * 2. **Summarising compaction** ({@link compressHistory}) — only when estimated
 *    pressure exceeds the trigger. Head and tail are preserved verbatim; the
 *    middle is replaced by a summary.
 *
 * ## Role validity without synthetic messages
 *
 * The window boundaries are snapped to USER message indices, so the summary can
 * be prefixed onto the first surviving tail message instead of being injected as
 * a new turn. Nothing is inserted, no two same-role messages become adjacent,
 * and no tool message is orphaned from the assistant turn that requested it —
 * which matters because strict providers (Bedrock Converse) reject both.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { ModelMessage } from "ai";
import {
  estimateMessagesTokens,
  type ContextPressure,
} from "./context-window.js";

// ---------------------------------------------------------------------------
// Trigger thresholds
// ---------------------------------------------------------------------------

/** Default share of the usable input budget at which compaction fires. */
export const DEFAULT_THRESHOLD_RATIO = 0.5;

/**
 * Windows below this size get the raised threshold below. At 512K+ a 50% trigger
 * already leaves ample post-compaction headroom.
 */
export const SMALL_CTX_WINDOW_LIMIT = 512_000;

/**
 * Threshold FLOOR for small windows. Compacting a 32K local model at 50% throws
 * away half of the only context it has; the useful behaviour is to ride most of
 * the window and compact late. Raise-only: an explicitly higher configured value
 * always wins.
 */
export const SMALL_CTX_THRESHOLD_RATIO = 0.75;

/**
 * Absolute ceiling on the trigger. Above this the request would be rejected by
 * the provider before compaction ever fired, so it must stay below 1.0.
 */
export const MAX_TRIGGER_RATIO = 0.85;

/**
 * Applies the small-window floor to a configured threshold ratio, then clamps to
 * {@link MAX_TRIGGER_RATIO}. Raise-only with respect to the configured value.
 */
export function effectiveThresholdRatio(
  contextLength: number | undefined,
  configured: number = DEFAULT_THRESHOLD_RATIO,
): number {
  const base =
    Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_THRESHOLD_RATIO;
  const floored =
    contextLength !== undefined &&
    contextLength > 0 &&
    contextLength < SMALL_CTX_WINDOW_LIMIT
      ? Math.max(base, SMALL_CTX_THRESHOLD_RATIO)
      : base;
  return Math.min(floored, MAX_TRIGGER_RATIO);
}

/**
 * Whether the assembled prompt is over the compaction threshold.
 *
 * Returns `false` when the window is unknown: without a window there is no
 * meaningful ratio, and compacting on a guess would degrade context for no
 * demonstrated reason. Unknown-window deployments are bounded by the tool-result
 * budget instead.
 */
export function shouldCompress(
  pressure: ContextPressure,
  thresholdRatio: number,
): boolean {
  if (pressure.utilization === undefined) return false;
  return pressure.utilization >= thresholdRatio;
}

// ---------------------------------------------------------------------------
// Stage 1 — deterministic pre-pass
// ---------------------------------------------------------------------------

/** Minimum tool-result length worth deduplicating (below this the marker costs more). */
const DEDUPE_MIN_CHARS = 400;

interface ToolResultPartLike {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  output?: { type?: string; value?: unknown };
}

function readToolResultText(part: ToolResultPartLike): string | undefined {
  const output = part.output;
  if (output === undefined || output === null) return undefined;
  if (output.type === "text") {
    return typeof output.value === "string" ? output.value : undefined;
  }
  if (output.type === "json") {
    try {
      return JSON.stringify(output.value) ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface DedupeStats {
  /** Tool results replaced by a back-reference. */
  collapsed: number;
  charsSaved: number;
}

/**
 * Collapses repeated IDENTICAL tool results to a back-reference, keeping the
 * NEWEST full copy.
 *
 * Motivating pattern: an agent loop reads the same file or runs the same query
 * several times across a conversation, and every copy is re-sent on every
 * subsequent request. Only the newest copy carries information the model has not
 * already been shown in that exact form.
 *
 * Deterministic (content-hash based) and idempotent — an already-collapsed
 * back-reference is short enough to fall under {@link DEDUPE_MIN_CHARS} and is
 * never re-collapsed, so repeated application yields identical bytes and the
 * prompt prefix stays cacheable.
 *
 * Returns the same array reference when nothing changed.
 */
export function dedupeRepeatedToolResults(
  messages: ModelMessage[],
): { messages: ModelMessage[]; stats: DedupeStats } {
  const stats: DedupeStats = { collapsed: 0, charsSaved: 0 };

  interface Located {
    msgIdx: number;
    partIdx: number;
    text: string;
    hash: string;
    toolName?: string;
  }
  const located: Located[] = [];

  for (const [m, msg] of messages.entries()) {
    if (msg.role !== "tool") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const [p, rawPart] of content.entries()) {
      const part = rawPart as ToolResultPartLike;
      if (part.type !== "tool-result") continue;
      const text = readToolResultText(part);
      if (text === undefined || text.length < DEDUPE_MIN_CHARS) continue;
      located.push({
        msgIdx: m,
        partIdx: p,
        text,
        hash: crypto.createHash("sha1").update(text).digest("hex"),
        ...(typeof part.toolName === "string" ? { toolName: part.toolName } : {}),
      });
    }
  }
  if (located.length < 2) return { messages, stats };

  // Walk backwards so the NEWEST occurrence of each hash is the one kept.
  const seen = new Set<string>();
  const replacements = new Map<number, Map<number, string>>();
  for (const entry of located.toReversed()) {
    if (!seen.has(entry.hash)) {
      seen.add(entry.hash);
      continue;
    }
    const tool = entry.toolName ?? "tool";
    const backRef =
      `[Identical earlier \`${tool}\` result omitted — this call returned ` +
      `exactly the same ${entry.text.length} characters as a later call in ` +
      `this conversation, whose full output is still present below.]`;
    const perMessage = replacements.get(entry.msgIdx) ?? new Map();
    perMessage.set(entry.partIdx, backRef);
    replacements.set(entry.msgIdx, perMessage);
    stats.collapsed++;
    stats.charsSaved += entry.text.length - backRef.length;
  }

  if (replacements.size === 0) return { messages, stats };

  const out = [...messages];
  for (const [msgIdx, parts] of replacements) {
    const msg = out[msgIdx];
    if (msg === undefined) continue; // unreachable: msgIdx came from a valid messages[] index
    const content = [...(msg.content as unknown[])];
    for (const [partIdx, text] of parts) {
      const part = content[partIdx] as ToolResultPartLike;
      content[partIdx] = { ...part, output: { type: "text", value: text } };
    }
    out[msgIdx] = { ...msg, content } as ModelMessage;
  }
  return { messages: out, stats };
}

// ---------------------------------------------------------------------------
// Stage 2 — window selection
// ---------------------------------------------------------------------------

/** Leading non-system turns kept verbatim (the task's original framing). */
export const PROTECT_FIRST_TURNS = 1;

/** Share of the usable input budget reserved for the verbatim tail. */
export const TAIL_BUDGET_RATIO = 0.35;

/** Minimum user turns kept verbatim at the tail, regardless of the token budget. */
export const MIN_TAIL_TURNS = 2;

export interface CompressionWindow {
  /** Exclusive end of the verbatim head. */
  headEnd: number;
  /** Inclusive start of the verbatim tail; always a `user` message index. */
  tailStart: number;
}

/** Indices of every `user` message, in order. */
function userIndices(messages: ModelMessage[]): number[] {
  const out: number[] = [];
  for (const [i, msg] of messages.entries()) {
    if (msg.role === "user") out.push(i);
  }
  return out;
}

/**
 * Chooses the `[headEnd, tailStart)` range to summarise.
 *
 * Both boundaries land on user-message indices, which is what allows the summary
 * to be prefixed onto `messages[tailStart]` rather than injected as an extra
 * turn — no role adjacency is created and no tool message is separated from its
 * assistant turn.
 *
 * The tail is selected by TOKEN budget walking backwards, with
 * {@link MIN_TAIL_TURNS} as a hard floor so a run of unusually bulky recent
 * turns cannot leave the model with no recent context at all.
 *
 * Returns `undefined` when there is nothing worth compressing (too few turns, or
 * the head and tail already meet).
 */
export function selectCompressionWindow(
  messages: ModelMessage[],
  tailTokenBudget: number,
  protectFirstTurns: number = PROTECT_FIRST_TURNS,
  minTailTurns: number = MIN_TAIL_TURNS,
): CompressionWindow | undefined {
  const users = userIndices(messages);
  // Need enough user turns to have a head, a middle and a tail.
  if (users.length < protectFirstTurns + minTailTurns + 1) return undefined;

  // Head ends at the user turn following the protected leading turns.
  const headEnd = users[protectFirstTurns];
  if (headEnd === undefined) return undefined; // unreachable given the length check above

  // Tail: walk user turns backwards while the token budget allows, honouring the
  // minimum-turn floor.
  const lastUser = users[users.length - 1];
  if (lastUser === undefined) return undefined; // unreachable: users.length > 0
  let tailStart = lastUser;
  let accumulated = estimateMessagesTokens(messages.slice(tailStart));
  let turnsKept = 1;
  for (const candidate of users.slice(0, -1).toReversed()) {
    if (candidate <= headEnd) break;
    const segment = estimateMessagesTokens(
      messages.slice(candidate, tailStart),
    );
    const withinBudget = accumulated + segment <= tailTokenBudget;
    if (!withinBudget && turnsKept >= minTailTurns) break;
    accumulated += segment;
    tailStart = candidate;
    turnsKept++;
  }

  if (tailStart <= headEnd) return undefined;
  // Nothing meaningful in the middle.
  if (tailStart - headEnd < 2) return undefined;
  return { headEnd, tailStart };
}

// ---------------------------------------------------------------------------
// Summary cache
// ---------------------------------------------------------------------------

/** Max threads holding a cached summary. Bounded for a long-lived server. */
export const SUMMARY_CACHE_MAX_THREADS = 300;

/**
 * Fingerprints a message range so a cached summary can be proven to still cover
 * exactly the same content. Hashes roles and serialised content — anything that
 * would change what a summary should say.
 */
export function fingerprintRange(messages: ModelMessage[]): string {
  const hash = crypto.createHash("sha1");
  for (const m of messages) {
    hash.update(String((m as { role?: unknown }).role ?? ""));
    hash.update("\u0001");
    const content = (m as { content?: unknown }).content;
    hash.update(
      typeof content === "string" ? content : safeStringify(content),
    );
    hash.update("\u0002");
  }
  return hash.digest("hex");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Per-thread cache of the most recent summary and the range it covers.
 *
 * The fingerprint check is what makes summarising compatible with prompt
 * caching: as long as the summarised range is byte-identical to last turn's, the
 * SAME summary text is emitted, so the assembled prompt is unchanged and the
 * provider/KV cache still matches.
 */
export class SummaryCache {
  private readonly entries = new Map<
    string,
    { fingerprint: string; summary: string }
  >();

  constructor(private readonly maxThreads = SUMMARY_CACHE_MAX_THREADS) {}

  get(key: string, fingerprint: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.fingerprint !== fingerprint) {
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.summary;
  }

  set(key: string, fingerprint: string, summary: string): void {
    this.entries.delete(key);
    this.entries.set(key, { fingerprint, summary });
    while (this.entries.size > this.maxThreads) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Process-wide summary cache used by the LLM node handler. */
export const summaryCache = new SummaryCache();

// ---------------------------------------------------------------------------
// Anti-thrash breaker
// ---------------------------------------------------------------------------

/**
 * How long automatic compaction stays blocked after an ineffective or failed
 * attempt. Long enough that a genuinely incompressible conversation is not
 * calling a summariser on every turn; short enough that a conversation which has
 * since grown compressible material recovers well before it hits the hard limit.
 */
export const ANTI_THRASH_COOLDOWN_MS = 300_000;

/**
 * Bounded per-thread cooldown registry. A failed or pointless compaction is a
 * wasted model call; without a breaker a conversation that cannot be compressed
 * would pay for one on every single turn.
 */
export class CompressionBreaker {
  private readonly blockedUntil = new Map<string, number>();

  constructor(
    private readonly cooldownMs = ANTI_THRASH_COOLDOWN_MS,
    private readonly maxKeys = SUMMARY_CACHE_MAX_THREADS,
  ) {}

  isBlocked(key: string, now: number = Date.now()): boolean {
    const until = this.blockedUntil.get(key);
    if (until === undefined) return false;
    if (until <= now) {
      this.blockedUntil.delete(key);
      return false;
    }
    return true;
  }

  trip(key: string, now: number = Date.now()): void {
    this.blockedUntil.delete(key);
    this.blockedUntil.set(key, now + this.cooldownMs);
    while (this.blockedUntil.size > this.maxKeys) {
      const oldest = this.blockedUntil.keys().next();
      if (oldest.done === true) break;
      this.blockedUntil.delete(oldest.value);
    }
  }

  reset(key: string): void {
    this.blockedUntil.delete(key);
  }
}

/** Process-wide breaker used by the LLM node handler. */
export const compressionBreaker = new CompressionBreaker();

// ---------------------------------------------------------------------------
// Summary placement
// ---------------------------------------------------------------------------

/** Framing that stops the summary from reading as a fresh instruction. */
export const SUMMARY_PREFIX =
  "[CONTEXT SUMMARY — REFERENCE ONLY] Earlier turns of this conversation were " +
  "compacted into the summary below to stay within the context window. Treat it " +
  "as background, NOT as a new request: everything it describes was already " +
  "handled. Respond only to the message that follows it.";

/**
 * Replaces `[headEnd, tailStart)` with `summary`, prefixed onto the first tail
 * message.
 *
 * No message is inserted — the summary rides along on an existing user turn — so
 * role alternation is preserved exactly as it was.
 */
export function applySummary(
  messages: ModelMessage[],
  window: CompressionWindow,
  summary: string,
): ModelMessage[] {
  const tailHead = messages[window.tailStart];
  if (tailHead === undefined) return messages;

  const block = `${SUMMARY_PREFIX}\n\n${summary.trim()}\n\n[END OF SUMMARY]`;
  const content = tailHead.content;

  let nextContent: ModelMessage["content"];
  if (typeof content === "string") {
    nextContent = `${block}\n\n${content}`;
  } else if (Array.isArray(content)) {
    nextContent = [
      { type: "text", text: block },
      ...content,
    ] as ModelMessage["content"];
  } else {
    return messages;
  }

  return [
    ...messages.slice(0, window.headEnd),
    { ...tailHead, content: nextContent } as ModelMessage,
    ...messages.slice(window.tailStart + 1),
  ];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Produces a summary for a message range. Injected so tests need no network. */
export type Summarizer = (
  middle: ModelMessage[],
) => Promise<string | undefined>;

export interface CompressHistoryOptions {
  /** Cache/breaker key — a (conversation, node) pair. */
  key: string;
  /** Usable input budget in tokens; `undefined` disables summarising compaction. */
  inputBudget?: number;
  /** Compaction trigger as a share of `inputBudget`. */
  thresholdRatio: number;
  summarize: Summarizer;
  cache?: SummaryCache;
  breaker?: CompressionBreaker;
  now?: number;
}

export interface CompressHistoryResult {
  messages: ModelMessage[];
  /** Deterministic pre-pass statistics (always populated). */
  dedupe: DedupeStats;
  /** Whether a summary replaced part of the history. */
  summarized: boolean;
  /** Whether the cached summary was reused (no model call, prefix preserved). */
  summaryFromCache: boolean;
  /** Estimated tokens before and after. */
  tokensBefore: number;
  tokensAfter: number;
  /** Summary bytes used in the prompt, exposed for durable provenance. */
  summary?: string;
  /** Message-index range replaced by the summary. */
  sourceHeadEnd?: number;
  sourceTailStart?: number;
  /** Set when compaction was wanted but skipped, with the reason. */
  skipped?:
    | "under-threshold"
    | "unknown-window"
    | "cooldown"
    | "no-window"
    | "summarizer-failed"
    | "ineffective";
}

/**
 * Runs the deterministic pre-pass, then summarising compaction when the prompt is
 * over the trigger.
 *
 * The pre-pass runs unconditionally: it costs nothing, never loses information
 * the model has not already seen in identical form, and often removes enough that
 * the trigger is no longer met.
 */
export async function compressHistory(
  messages: ModelMessage[],
  options: CompressHistoryOptions,
): Promise<CompressHistoryResult> {
  const tokensBefore = estimateMessagesTokens(messages);
  const cache = options.cache ?? summaryCache;
  const breaker = options.breaker ?? compressionBreaker;
  const now = options.now ?? Date.now();

  // Stage 1 — always.
  const deduped = dedupeRepeatedToolResults(messages);
  let current = deduped.messages;

  const base: CompressHistoryResult = {
    messages: current,
    dedupe: deduped.stats,
    summarized: false,
    summaryFromCache: false,
    tokensBefore,
    tokensAfter: estimateMessagesTokens(current),
  };

  const budget = options.inputBudget;
  if (budget === undefined || budget <= 0) {
    return { ...base, skipped: "unknown-window" };
  }

  // Re-measure AFTER the pre-pass: dedup alone frequently brings a conversation
  // back under the trigger, and a summariser call avoided is the cheapest win.
  if (base.tokensAfter < budget * options.thresholdRatio) {
    return { ...base, skipped: "under-threshold" };
  }

  if (breaker.isBlocked(options.key, now)) {
    return { ...base, skipped: "cooldown" };
  }

  const window = selectCompressionWindow(
    current,
    Math.floor(budget * TAIL_BUDGET_RATIO),
  );
  if (window === undefined) {
    // Nothing summarisable (e.g. one enormous turn). Trip the breaker so this is
    // not recomputed every turn.
    breaker.trip(options.key, now);
    return { ...base, skipped: "no-window" };
  }

  const middle = current.slice(window.headEnd, window.tailStart);
  const fingerprint = fingerprintRange(middle);

  // Cache hit → identical summary bytes → prompt prefix survives.
  const cached = cache.get(options.key, fingerprint);
  let summary = cached;
  if (summary === undefined) {
    try {
      summary = await options.summarize(middle);
    } catch {
      summary = undefined;
    }
    if (summary === undefined || summary.trim() === "") {
      breaker.trip(options.key, now);
      return { ...base, skipped: "summarizer-failed" };
    }
    cache.set(options.key, fingerprint, summary);
  }

  const compacted = applySummary(current, window, summary);
  const tokensAfter = estimateMessagesTokens(compacted);

  // A summary that did not actually shrink anything is worse than none: it costs
  // a model call and replaces verbatim history with a paraphrase.
  if (tokensAfter >= base.tokensAfter) {
    breaker.trip(options.key, now);
    return { ...base, skipped: "ineffective" };
  }

  current = compacted;
  return {
    messages: current,
    dedupe: deduped.stats,
    summarized: true,
    summaryFromCache: cached !== undefined,
    tokensBefore,
    tokensAfter,
    summary,
    sourceHeadEnd: window.headEnd,
    sourceTailStart: window.tailStart,
  };
}
