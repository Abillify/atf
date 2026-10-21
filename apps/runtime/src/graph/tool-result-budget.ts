// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-result size budget (`src/graph/tool-result-budget.ts`)
 *
 * Bounds how much tool output reaches the model — per individual result and per
 * turn — instead of letting it accumulate unbounded.
 *
 * Why this matters more than it looks: inside one `streamText` agent loop, every
 * tool step replays the ENTIRE accumulated message list, so a 60k-char document
 * read on step 2 is re-sent on steps 3…N. With `maxToolSteps: 14` that single
 * result is billed and re-prefilled a dozen times. Across turns the same content
 * then sits in the checkpointed history forever. Before this module the only
 * truncation in the system was `TOOL_IO_LIMIT` in the monitoring path, which
 * never touched what the model actually received.
 *
 * Three properties the implementation is built around:
 *
 * 1. **Deterministic.** Capping is a pure function of (content, budget). The same
 *    result therefore caps to the same bytes on every replay step and again when
 *    persisted to history — so bounding output does NOT introduce a prompt-cache
 *    divergence. A size-dependent or timestamped marker would break this.
 * 2. **Newest-first retention.** When the per-turn budget runs out, the OLDEST
 *    results are demoted, never the newest. The model is usually working on the
 *    most recent retrieval; discarding that to keep stale output would be
 *    backwards.
 * 3. **Head AND tail preserved.** Tool output frequently puts the payload at the
 *    top and the decisive part (totals, error lines, "N more results") at the
 *    bottom. Head-only truncation reliably hides failures.
 *
 * The marker text is explicit and actionable: the model is told how much was
 * elided and that it should re-issue the call with narrower arguments. That is
 * the deliberate alternative to a retrievable-handle mechanism (a new tool on
 * every request, which is a permanent schema cost); MCP tools generally accept
 * `limit`/`offset`/`query` narrowing already.
 *
 * No `any` at module boundaries.
 */

import type { ModelMessage } from "ai";
import type { BaseMessage } from "@langchain/core/messages";
import { ToolMessage } from "@langchain/core/messages";
import { charsPerTokenFor } from "./context-window.js";

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/**
 * Absolute caps, used when the model's context window is unknown. Also act as a
 * CEILING on the window-scaled values, so a very large model behaves exactly as
 * it did before this module existed.
 */
export const DEFAULT_RESULT_MAX_CHARS = 100_000;
export const DEFAULT_TURN_BUDGET_CHARS = 200_000;

/**
 * Fractions of the context window a single result / a whole turn's results may
 * occupy. Well under 1.0 because tool output is not the only tenant of the
 * window — the system prompt, tool schemas, conversation history and the model's
 * own completion all compete for the same space.
 */
const PER_RESULT_WINDOW_FRACTION = 0.15;
const PER_TURN_WINDOW_FRACTION = 0.3;

/**
 * Floors so a small model still receives a usable amount of output rather than a
 * budget that truncates everything into uselessness.
 */
const MIN_RESULT_MAX_CHARS = 8_000;
const MIN_TURN_BUDGET_CHARS = 16_000;

/**
 * Size of the aggressive "demoted" preview applied to older results once the
 * per-turn budget is exhausted. Split head/tail; roughly 1.5k chars ≈ 375 tokens,
 * enough to identify what the call returned without carrying the payload.
 */
export const DEMOTED_HEAD_CHARS = 1_100;
export const DEMOTED_TAIL_CHARS = 400;

/** Share of a per-result cap spent on the head (the rest goes to the tail). */
const HEAD_SHARE = 0.7;

export interface ToolResultBudget {
  /** Max characters for a single tool result. */
  perResultChars: number;
  /** Max characters for all tool results in the message list combined. */
  perTurnChars: number;
}

/**
 * Scales the budget to a model's context window.
 *
 * Unknown window (`undefined`) yields the absolute defaults — the same
 * "don't guess" rule the context-window module follows, because guessing small
 * would silently degrade a large model and guessing large would break a small
 * one.
 */
export function budgetForContextWindow(
  contextLength?: number,
  charsPerToken?: number,
): ToolResultBudget {
  if (
    contextLength === undefined ||
    !Number.isFinite(contextLength) ||
    contextLength <= 0
  ) {
    return {
      perResultChars: DEFAULT_RESULT_MAX_CHARS,
      perTurnChars: DEFAULT_TURN_BUDGET_CHARS,
    };
  }

  const windowChars = contextLength * charsPerTokenFor({ charsPerToken });
  return {
    // Clamp between the floor and the historical default: large models stay
    // byte-identical to pre-budget behaviour, small models shrink.
    perResultChars: Math.max(
      MIN_RESULT_MAX_CHARS,
      Math.min(
        Math.floor(windowChars * PER_RESULT_WINDOW_FRACTION),
        DEFAULT_RESULT_MAX_CHARS,
      ),
    ),
    perTurnChars: Math.max(
      MIN_TURN_BUDGET_CHARS,
      Math.min(
        Math.floor(windowChars * PER_TURN_WINDOW_FRACTION),
        DEFAULT_TURN_BUDGET_CHARS,
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Text capping
// ---------------------------------------------------------------------------

/** Builds the elision marker. Deterministic for a given (elided, tool) pair. */
function elisionMarker(elidedChars: number, toolName?: string): string {
  const call =
    toolName !== undefined && toolName !== ""
      ? `call \`${toolName}\` again`
      : "call the tool again";
  return (
    `\n\n[... ${elidedChars} characters elided to stay within the context ` +
    `budget. The middle of this output was removed; the beginning and end are ` +
    `shown. If you need the elided part, ${call} with narrower arguments ` +
    `(e.g. a more specific query, a smaller limit, or a page/offset).]\n\n`
  );
}

export interface CapResult {
  content: string;
  truncated: boolean;
  /** Length of the input before capping. */
  originalChars: number;
}

/**
 * Caps a tool-result string to `maxChars`, keeping the head and the tail and
 * replacing the middle with an explicit marker.
 *
 * The marker counts against `maxChars`, so the returned content is ALWAYS
 * `<= maxChars`. That is what makes the function idempotent, and idempotence is
 * a correctness requirement rather than a nicety: `prepareStep` re-caps the
 * whole message list on every tool step, so a result whose capped form exceeded
 * its own cap would be re-capped (and re-shortened) on each step — rewriting
 * bytes the model has already been shown and invalidating the prompt-cache
 * prefix every single step.
 *
 * The marker length is budgeted against `originalChars` (the widest possible
 * elided-count string) rather than the final count, so the reserve can never be
 * too small. The result may come out a few characters under `maxChars`, which is
 * the safe direction.
 *
 * When `maxChars` cannot fit the marker plus meaningful head/tail text, falls
 * back to a plain head-only cut — a marker longer than the content it replaces
 * would be absurd.
 */
export function capToolResultText(
  content: string,
  maxChars: number,
  toolName?: string,
  headShare: number = HEAD_SHARE,
): CapResult {
  const originalChars = content.length;
  if (maxChars <= 0 || originalChars <= maxChars) {
    return { content, truncated: false, originalChars };
  }

  // Reserve room for the marker using the longest count string it could render.
  const markerReserve = elisionMarker(originalChars, toolName).length;
  const contentBudget = maxChars - markerReserve;

  const head = Math.floor(contentBudget * headShare);
  const tail = contentBudget - head;

  // Degenerate budget: after reserving the marker there is no meaningful text
  // left on both sides. A plain cut is more useful than a marker-only result.
  if (contentBudget <= 0 || head <= 0 || tail <= 0) {
    return {
      content: content.slice(0, maxChars),
      truncated: true,
      originalChars,
    };
  }

  const elided = originalChars - head - tail;
  const marker = elisionMarker(elided, toolName);

  return {
    content: content.slice(0, head) + marker + content.slice(originalChars - tail),
    truncated: true,
    originalChars,
  };
}

// ---------------------------------------------------------------------------
// Tool-result content access (AI SDK ModelMessage shape)
// ---------------------------------------------------------------------------

interface ToolResultPartLike {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  output?: { type?: string; value?: unknown };
}

/**
 * Extracts a tool-result part's payload as text, or `undefined` when the shape
 * is not a text/json output we can safely rewrite.
 *
 * `json` outputs are serialised: once a payload must be truncated it is no
 * longer valid JSON anyway, so it is re-emitted as text rather than as a
 * structurally broken object.
 */
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

export interface ToolResultBudgetStats {
  /** Tool results inspected. */
  inspected: number;
  /** Results shortened by the per-result cap. */
  cappedByResult: number;
  /** Results demoted to a short preview by the per-turn cap. */
  demotedByTurn: number;
  /** Characters removed in total. */
  charsSaved: number;
}

export interface ToolResultBudgetOutcome {
  messages: ModelMessage[];
  stats: ToolResultBudgetStats;
}

/**
 * Applies the budget to every tool result in a message list.
 *
 * Two passes, in this order:
 *
 * 1. **Per-result cap** — any single result over `perResultChars` is head/tail
 *    capped. This alone bounds the pathological case (one huge document read).
 * 2. **Per-turn budget** — walking from the NEWEST result backwards, results are
 *    kept at their post-pass-1 size while the running total fits
 *    `perTurnChars`. Once it no longer fits, every remaining (older) result is
 *    demoted to a short head/tail preview. The newest result is always kept at
 *    its pass-1 size even if it alone exceeds the turn budget — demoting the
 *    output the model just requested would make the loop unable to progress.
 *
 * Pure: returns a new array (the same reference when nothing changed, so callers
 * can cheaply detect a no-op).
 */
export function applyToolResultBudget(
  messages: ModelMessage[],
  budget: ToolResultBudget,
): ToolResultBudgetOutcome {
  const stats: ToolResultBudgetStats = {
    inspected: 0,
    cappedByResult: 0,
    demotedByTurn: 0,
    charsSaved: 0,
  };

  // Locate every tool-result part: (message index, part index, text, toolName).
  interface Located {
    msgIdx: number;
    partIdx: number;
    text: string;
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
      if (text === undefined) continue;
      located.push({
        msgIdx: m,
        partIdx: p,
        text,
        ...(typeof part.toolName === "string" ? { toolName: part.toolName } : {}),
      });
    }
  }

  if (located.length === 0) return { messages, stats };
  stats.inspected = located.length;

  // Pass 1 — per-result cap.
  const capped = located.map((loc) => {
    const result = capToolResultText(
      loc.text,
      budget.perResultChars,
      loc.toolName,
    );
    if (result.truncated) {
      stats.cappedByResult++;
      stats.charsSaved += result.originalChars - result.content.length;
    }
    return { ...loc, text: result.content };
  });

  // Pass 2 — per-turn budget, newest first.
  let running = 0;
  let exhausted = false;
  const final = new Array<Located>(capped.length);
  for (const [i, entry] of [...capped.entries()].reverse()) {
    const isNewest = i === capped.length - 1;

    if (exhausted) {
      final[i] = demote(entry);
      continue;
    }

    // The newest result is always admitted: it is what the model just asked for.
    if (isNewest) {
      running += entry.text.length;
      final[i] = entry;
      if (running >= budget.perTurnChars) exhausted = true;
      continue;
    }

    if (running + entry.text.length <= budget.perTurnChars) {
      running += entry.text.length;
      final[i] = entry;
      continue;
    }

    exhausted = true;
    final[i] = demote(entry);
  }

  function demote(entry: Located): Located {
    const previewMax = DEMOTED_HEAD_CHARS + DEMOTED_TAIL_CHARS;
    if (entry.text.length <= previewMax) return entry;
    const result = capToolResultText(
      entry.text,
      previewMax,
      entry.toolName,
      DEMOTED_HEAD_CHARS / previewMax,
    );
    if (result.truncated) {
      stats.demotedByTurn++;
      stats.charsSaved += result.originalChars - result.content.length;
    }
    return { ...entry, text: result.content };
  }

  // Nothing changed → return the original reference.
  const changed = final.some((entry, i) => {
    const orig = located[i];
    return orig === undefined || entry.text !== orig.text;
  });
  if (!changed) return { messages, stats };

  // Rebuild only the touched messages/parts.
  const out = [...messages];
  const byMessage = new Map<number, Located[]>();
  for (const [i, entry] of final.entries()) {
    const orig = located[i];
    if (orig !== undefined && entry.text === orig.text) continue;
    const list = byMessage.get(entry.msgIdx) ?? [];
    list.push(entry);
    byMessage.set(entry.msgIdx, list);
  }

  for (const [msgIdx, entries] of byMessage) {
    const msg = out[msgIdx];
    if (msg === undefined) continue; // unreachable: msgIdx came from a valid messages[] index
    const content = [...(msg.content as unknown[])];
    for (const entry of entries) {
      const part = content[entry.partIdx] as ToolResultPartLike;
      content[entry.partIdx] = {
        ...part,
        output: { type: "text", value: entry.text },
      };
    }
    out[msgIdx] = { ...msg, content } as ModelMessage;
  }

  return { messages: out, stats };
}

// ---------------------------------------------------------------------------
// Persistence boundary (LangChain BaseMessage shape)
// ---------------------------------------------------------------------------

/**
 * Applies the same budget to the `ToolMessage`s of a `BaseMessage[]` before they
 * are persisted into `state.messages`.
 *
 * Why this must mirror {@link applyToolResultBudget} exactly rather than being a
 * looser variant: the intra-turn path caps what the model SEES, this path caps
 * what the next turn REPLAYS. If the persisted copy were longer than the capped
 * copy the model was shown, the next turn would present a different (longer)
 * version of a message the model already processed — a mid-array rewrite that
 * both invalidates the prompt-cache prefix and hands the model output it never
 * saw in that form. Both paths therefore run the same two passes over the same
 * result sequence, which yields identical text.
 *
 * Only `ToolMessage`s with string content are considered; anything else passes
 * through untouched. Returns the same array reference when nothing changed.
 */
export function applyToolResultBudgetToHistory(
  messages: BaseMessage[],
  budget: ToolResultBudget,
): { messages: BaseMessage[]; stats: ToolResultBudgetStats } {
  const stats: ToolResultBudgetStats = {
    inspected: 0,
    cappedByResult: 0,
    demotedByTurn: 0,
    charsSaved: 0,
  };

  interface Located {
    idx: number;
    text: string;
    toolName?: string;
  }
  const located: Located[] = [];
  for (const [i, msg] of messages.entries()) {
    if (msg._getType() !== "tool") continue;
    const content = msg.content;
    if (typeof content !== "string") continue;
    const name = (msg as { name?: unknown }).name;
    located.push({
      idx: i,
      text: content,
      ...(typeof name === "string" && name !== "" ? { toolName: name } : {}),
    });
  }
  if (located.length === 0) return { messages, stats };
  stats.inspected = located.length;

  // Pass 1 — per-result cap.
  const capped = located.map((loc) => {
    const r = capToolResultText(loc.text, budget.perResultChars, loc.toolName);
    if (r.truncated) {
      stats.cappedByResult++;
      stats.charsSaved += r.originalChars - r.content.length;
    }
    return { ...loc, text: r.content };
  });

  // Pass 2 — per-turn budget, newest first (identical policy to the AI SDK path).
  const previewMax = DEMOTED_HEAD_CHARS + DEMOTED_TAIL_CHARS;
  const demote = (entry: Located): Located => {
    if (entry.text.length <= previewMax) return entry;
    const r = capToolResultText(
      entry.text,
      previewMax,
      entry.toolName,
      DEMOTED_HEAD_CHARS / previewMax,
    );
    if (r.truncated) {
      stats.demotedByTurn++;
      stats.charsSaved += r.originalChars - r.content.length;
    }
    return { ...entry, text: r.content };
  };

  let running = 0;
  let exhausted = false;
  const final = new Array<Located>(capped.length);
  for (const [i, entry] of [...capped.entries()].reverse()) {
    if (exhausted) {
      final[i] = demote(entry);
      continue;
    }
    if (i === capped.length - 1) {
      running += entry.text.length;
      final[i] = entry;
      if (running >= budget.perTurnChars) exhausted = true;
      continue;
    }
    if (running + entry.text.length <= budget.perTurnChars) {
      running += entry.text.length;
      final[i] = entry;
      continue;
    }
    exhausted = true;
    final[i] = demote(entry);
  }

  const changed = final.some((e, i) => {
    const orig = located[i];
    return orig === undefined || e.text !== orig.text;
  });
  if (!changed) return { messages, stats };

  const out = [...messages];
  for (const [i, entry] of final.entries()) {
    const orig = located[i];
    if (orig !== undefined && entry.text === orig.text) continue;
    const original = messages[entry.idx] as ToolMessage | undefined;
    if (original === undefined) continue; // unreachable: entry.idx came from a valid messages[] index
    out[entry.idx] = new ToolMessage({
      content: entry.text,
      tool_call_id: original.tool_call_id,
      ...(entry.toolName !== undefined ? { name: entry.toolName } : {}),
    });
  }
  return { messages: out, stats };
}
