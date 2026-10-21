// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — finding text helpers.

 * Pure (closure-free) helpers that condense, deduplicate and phrase the
 * worker output the harness carries forward, plus the final-answer and
 * stop-status phrasing. Extracted verbatim from loop.ts (Req 13.6).
 *
 * @module agent-harness/loop-findings
 */

import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { isRagContextMessage } from "../exec-runtime.js";
import type { AgentState } from "../graph-engine.js";
import { isContextLengthError } from "../context-length-retry.js";
import type { StopReason, Task } from "./types.js";

/**
 * Hard cap (chars) on a single condensed finding carried into the shared
 * context per iteration. Even with the worker-side repetition guard, a
 * defensive ceiling here guarantees the shared context grows by a BOUNDED
 * amount per delegation — so a degenerate or unusually verbose worker output
 * can never explode the context that the planner / next worker / synthesizer
 * receive (the root cause of the empty-response failure on a small KV cache).
 * ~4000 chars ≈ 1000 tokens; ample for a condensed, cited finding.
 */
const CONDENSED_FINDING_MAX = 6000;

/**
 * Applies the {@link CONDENSED_FINDING_MAX} ceiling to a worker's condensed
 * finding before it is carried into the shared context. Text within the limit
 * is returned unchanged; longer text is truncated with a visible marker so the
 * downstream model knows the finding was clipped. Exported for unit testing.
 */
export function capCondensedFinding(
  text: string,
  max: number = CONDENSED_FINDING_MAX,
): string {
  return text.length > max ? `${text.slice(0, max)}\n[…gekuerzt]` : text;
}

/**
 * Phrases the deterministic, natural-language research and decision status of a
 * completed step.
 *
 * Deliberately without an LLM: this sentence is the fallback when the progress
 * narrator is disabled, fails, or has no dependable basis. It may therefore
 * only restate runtime-confirmed facts (observed phase, counted search passes,
 * ledger updates, new findings) and must never claim a domain relevance
 * decision that only the worker made. Exported for unit testing.
 */
export function describeResearchPhase(input: {
  modes: Array<"summary" | "discovery" | "original">;
  newFindingCount: number;
  citationCount: number;
  coverageProgress: number;
  observedSearchPasses: number;
  stagnantIterations?: number;
  maxStagnantIterations?: number;
}): string {
  const phase = input.modes.includes("original")
    ? "The original review of this step is complete; the passages read have been evaluated."
    : input.modes.includes("discovery")
      ? "The targeted search of this step is complete; qualifying hits are recorded as candidates for original review."
      : input.modes.includes("summary")
        ? "The summary triage of this batch is complete; the per-document relevance decision is recorded in the coverage ledger."
        : "The research step is complete.";
  const evidence =
    input.newFindingCount > 0
      ? ` It produced ${input.newFindingCount === 1 ? "one new evidence-backed finding" : `${input.newFindingCount} new evidence-backed findings`} with ${input.citationCount} source reference(s).`
      : input.coverageProgress > 0
        ? ` No standalone textual finding was required; ${input.coverageProgress} document decision(s) were committed.`
        : input.stagnantIterations !== undefined && input.stagnantIterations > 0
          ? ` No new finding and no new decision emerged (${input.stagnantIterations}/${input.maxStagnantIterations ?? "no limit"} passes without progress).`
          : " No new standalone finding emerged.";
  const searches =
    input.observedSearchPasses > 0
      ? ` ${input.observedSearchPasses} search pass(es) were confirmed runtime-side.`
      : "";
  return `${phase}${evidence}${searches}`;
}

export function compactStatusText(value: string, max = 180): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Handler — internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable summary from the completed tasks' results.
 * Used to assemble the AIMessage content on every exit path.
 */
export function assembleResult(tasks: Task[]): string {
  const completed = tasks.filter((t) => t.status === "completed");
  if (completed.length === 0) {
    return "No tasks were completed.";
  }
  return completed
    .map((t) => `[${t.id}] ${t.description}: ${t.result ?? "(done)"}`)
    .join("\n");
}

/**
 * Summarizes a delegate update into a short result string stored on the task.
 * Picks the last AI message content if available, otherwise falls back to a
 * generic marker.
 */
export function summarizeDelegateResult(update: Partial<AgentState>): string {
  if (update.messages) {
    const msgs = Array.isArray(update.messages)
      ? update.messages
      : [update.messages];
    // Find the last message with content
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg && typeof (msg as { content?: unknown }).content === "string") {
        const text = (msg as { content: string }).content;
        if (text.length > 0) {
          // Truncate to keep progress compact
          return text.length > 200 ? `${text.slice(0, 200)}\u2026` : text;
        }
      }
    }
  }
  return "(completed)";
}

/**
 * Returns true when a message is a non-empty AI (assistant) answer — used to
 * collect the real responder output for the harness's final user-facing
 * message, while excluding injected RAG/context SystemMessages and tool
 * messages that delegated nodes also emit.
 */
export function isAiAnswer(msg: BaseMessage): boolean {
  if (msg === null || typeof msg !== "object") return false;
  const getType =
    (msg as { getType?: () => string }).getType ??
    (msg as { _getType?: () => string })._getType;
  const type =
    msg instanceof AIMessage
      ? "ai"
      : typeof getType === "function"
        ? getType.call(msg)
        : undefined;
  if (type !== "ai") return false;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content.trim().length > 0;
  return Array.isArray(content) && content.length > 0;
}

/** Flattens a single message's content into plain text (handles part arrays). */
export function messageText(m: BaseMessage): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string"
          ? p
          : p !== null &&
              typeof p === "object" &&
              "text" in (p as Record<string, unknown>)
            ? String((p as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

export const DEFAULT_COVERAGE_WORKER_CONTEXT_MAX_CHARS = 60_000;
export const DEFAULT_VERIFICATION_CONTEXT_MAX_CHARS = 180_000;
const CONTEXT_TRUNCATION_MARKER = "\n[…context budgeted]";

export function messageChars(messages: readonly BaseMessage[]): number {
  return messages.reduce((total, message) => total + messageText(message).length, 0);
}

/**
 * Keeps every message role represented while sharing a hard character budget
 * evenly. This is used only for stable request context and compact findings;
 * the authoritative coverage assignment/manifest is never truncated here.
 */
export function budgetHarnessMessages(
  messages: readonly BaseMessage[],
  maxChars: number,
): BaseMessage[] {
  const textual = messages.filter((message) => messageText(message) !== "");
  if (messageChars(textual) <= maxChars) return [...textual];
  if (textual.length === 0 || maxChars <= 0) return [];

  const perMessage = Math.floor(maxChars / textual.length);
  if (perMessage <= 0) return [];
  return textual.map((message) => {
    const text = messageText(message);
    const capped =
      text.length <= perMessage
        ? text
        : perMessage <= CONTEXT_TRUNCATION_MARKER.length
          ? text.slice(0, perMessage)
          : `${text.slice(
              0,
              perMessage - CONTEXT_TRUNCATION_MARKER.length,
            )}${CONTEXT_TRUNCATION_MARKER}`;
    const type = message._getType();
    if (type === "system") return new SystemMessage(capped);
    if (type === "human") return new HumanMessage(capped);
    return new AIMessage(capped);
  });
}

export function coverageRequestMessages(messages: readonly BaseMessage[]): BaseMessage[] {
  return messages.filter((message) => {
    const type = message._getType();
    if (type !== "system" && type !== "human") return false;
    return !(type === "system" && isRagContextMessage(messageText(message)));
  });
}

/**
 * Text of the latest human message (text parts only, whitespace-normalized),
 * used as the summary rerank query. "" when there is none.
 */
export function latestHumanText(messages: readonly BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined || message._getType() !== "human") continue;
    const text = messageText(message).replace(/\s+/gu, " ").trim();
    if (text !== "") return text;
  }
  return "";
}

/**
 * Minimum trimmed length for a line to be eligible for cross-line
 * deduplication. Short/structural lines (headings, bullets like "- …", blank
 * lines) are kept verbatim to preserve formatting; only substantial content
 * lines are collapsed when they recur identically.
 */
const DEDUPE_MIN_LINE_LEN = 40;

/**
 * Collapses degenerate duplication inside a carried finding.
 *
 * Small local thinking models (the trace that motivated this) restate their
 * FULL findings block in both their reasoning channel and their visible answer,
 * so the merged worker text carries the same substantial lines two or more
 * times. Left intact, that duplicated block is exactly the pattern that pushes
 * the next node (synthesizer) into a repetition loop — the same identical block
 * appearing several times in-context is the classic degeneration trigger.
 *
 * This removes later occurrences of an already-seen substantial line
 * (>= {@link DEDUPE_MIN_LINE_LEN} chars, trimmed), keeping the FIRST occurrence
 * and preserving order. Short/structural lines and blanks pass through so
 * legitimate formatting (headings, bullets, citations) is untouched; runs of
 * blank lines left behind are collapsed. Exported for unit testing.
 */
export function collapseDuplicateLines(text: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const norm = line.trim();
    if (norm.length >= DEDUPE_MIN_LINE_LEN) {
      if (seen.has(norm)) continue;
      seen.add(norm);
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Minimum token count before fuzzy cross-task deduplication is attempted. */
const FINDING_DEDUPE_MIN_TOKENS = 24;

/** Builds stable word trigrams while ignoring citation-number differences. */
function findingShingles(text: string): Set<string> {
  const tokens =
    text
      .toLocaleLowerCase("de-DE")
      .replace(/\[\d+\]/g, " ")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const shingles = new Set<string>();
  for (let i = 0; i <= tokens.length - 3; i++) {
    shingles.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return shingles;
}

/**
 * Detects a near-identical finding produced by a different harness task.
 *
 * Exact whitespace-normalised equality also covers short findings. Longer
 * findings use trigram Jaccard similarity plus a length-ratio guard: this drops
 * repeated full syntheses with minor framing changes, but keeps a short new
 * detail that merely overlaps a larger prior report.
 */
export function areNearDuplicateFindings(a: string, b: string): boolean {
  const normalizeFinding = (text: string): string =>
    text
      .toLocaleLowerCase("de-DE")
      .replace(/\[\d+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedA = normalizeFinding(a);
  const normalizedB = normalizeFinding(b);
  if (normalizedA === normalizedB) return true;

  const evidenceKeys = (text: string): string[] =>
    [...new Set(text.match(/\[\d+\]|\[Ref:\s*[^\]]+\]/gi) ?? [])]
      .map((key) => key.toLocaleLowerCase("de-DE"))
      .sort();
  const coverageKey = (text: string): string | undefined => {
    const line = text
      .split("\n")
      .find((candidate) =>
        candidate.trim().toLocaleUpperCase("de-DE").startsWith("ABGEDECKT:"),
      );
    return line === undefined ? undefined : normalizeFinding(line);
  };
  const evidenceA = evidenceKeys(a);
  const evidenceB = evidenceKeys(b);
  const coverageA = coverageKey(a);
  const coverageB = coverageKey(b);
  const hypothesisKeys = (text: string): string[] =>
    text
      .split("\n")
      .filter((line) =>
        /^\s*[-*]\s*\[(AKTIV|BESTAETIGT|BESTÄTIGT|VERWORFEN)\]/iu.test(line),
      )
      .map(normalizeFinding)
      .sort();
  const hypothesesA = hypothesisKeys(a);
  const hypothesesB = hypothesisKeys(b);
  const hypothesisStateChanged =
    hypothesesA.length !== hypothesesB.length ||
    hypothesesA.some((key, index) => key !== hypothesesB[index]);
  // A hypothesis transition is research progress even when coverage and source
  // stay identical; never let generic text similarity erase it.
  if (
    (hypothesesA.length > 0 || hypothesesB.length > 0) &&
    hypothesisStateChanged
  ) {
    return false;
  }
  if (
    coverageA !== undefined &&
    coverageA === coverageB &&
    evidenceA.length > 0 &&
    evidenceA.length === evidenceB.length &&
    evidenceA.every((key, index) => key === evidenceB[index])
  ) {
    return true;
  }

  const wordsA = normalizedA.match(/[\p{L}\p{N}]+/gu) ?? [];
  const wordsB = normalizedB.match(/[\p{L}\p{N}]+/gu) ?? [];
  const lengthRatio =
    Math.min(wordsA.length, wordsB.length) /
    Math.max(wordsA.length, wordsB.length);
  if (lengthRatio < 0.75) return false;

  if (
    wordsA.length < FINDING_DEDUPE_MIN_TOKENS ||
    wordsB.length < FINDING_DEDUPE_MIN_TOKENS
  ) {
    // Short findings do not have enough trigrams for the long-text detector.
    // Token-set Jaccard catches the same compact result with a changed heading,
    // citation number, or minor framing while retaining genuinely new details.
    if (wordsA.length < 4 || wordsB.length < 4) return false;
    const setA = new Set(wordsA);
    const setB = new Set(wordsB);
    let intersection = 0;
    for (const word of setA) {
      if (setB.has(word)) intersection += 1;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 && intersection / union >= 0.78;
  }

  const shinglesA = findingShingles(a);
  const shinglesB = findingShingles(b);
  if (shinglesA.size === 0 || shinglesB.size === 0) return false;
  let intersection = 0;
  for (const shingle of shinglesA) {
    if (shinglesB.has(shingle)) intersection += 1;
  }
  const union = shinglesA.size + shinglesB.size - intersection;
  return union > 0 && intersection / union >= 0.72;
}

/**
 * Extracts the worker's textual findings from a delegate update for the
 * `carryForward: "condensed"` strategy. Concatenates the text of EVERY AI
 * (assistant) message with non-empty content — not just the last — so a worker
 * that splits its findings across several assistant turns (e.g. an interim
 * finding before a tool call and a final summary after) does not silently lose
 * the earlier findings (and, critically, the source citations `[n]` they
 * carry). Ordered as produced; returns "" when the worker produced no text.
 *
 * Two dedup layers guard against the repetition that pushed the downstream
 * synthesizer into a loop (trace fbf8500d): a fully identical assistant turn is
 * dropped as a whole, and {@link collapseDuplicateLines} removes repeated
 * substantial lines within the joined result (e.g. a thinking model that echoes
 * its entire findings block in both reasoning and answer).
 */
export function isEmptyResponseFallback(message: BaseMessage): boolean {
  const additionalKwargs = (
    message as { additional_kwargs?: Record<string, unknown> }
  ).additional_kwargs;
  return additionalKwargs?.aiperator_empty_response_fallback === true;
}

export function isTerminalBudgetErrorText(text: string): boolean {
  return /BudgetExceededError|Transaction budget exceeded/iu.test(text);
}

export function isSubstantiveFinding(
  text: string,
  requiredMarkers: string[] = [],
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Runtime/resource failures are never research findings, even if a model
  // wraps them in the flow's required marker structure. This is a defensive
  // boundary; typed terminal errors should normally prevent such text from
  // reaching the harness at all.
  if (isTerminalBudgetErrorText(trimmed) || isContextLengthError(trimmed)) {
    return false;
  }
  const saysNoNewFinding = trimmed
    .toLocaleUpperCase("de-DE")
    .includes("KEIN NEUER BEFUND");
  const containsHypothesisUpdate =
    /^\s*[-*]\s*\[(AKTIV|BESTAETIGT|BESTÄTIGT|VERWORFEN)\]/imu.test(trimmed);
  if (saysNoNewFinding && !containsHypothesisUpdate) return false;

  const lines = trimmed.split("\n");
  const normalizedMarkers = requiredMarkers.map((required) =>
    required.toLocaleUpperCase("de-DE"),
  );
  const markerIndexes = normalizedMarkers.map((normalized) =>
    lines.findIndex((line) =>
      line.trim().toLocaleUpperCase("de-DE").startsWith(normalized),
    ),
  );
  if (markerIndexes.some((index) => index < 0)) return false;
  if (
    markerIndexes.some(
      (index, position) =>
        position > 0 && index <= (markerIndexes[position - 1] ?? -1),
    )
  ) {
    return false;
  }

  for (const [markerPosition, required] of requiredMarkers.entries()) {
    const markerIndex = markerIndexes[markerPosition] ?? -1;
    const markerLine = lines[markerIndex]?.trim() ?? "";
    const inlineValue = markerLine.slice(required.length).trim();
    const nextMarkerIndex =
      markerIndexes
        .filter((index) => index > markerIndex)
        .sort((a, b) => a - b)[0] ?? lines.length;
    const followingValue = lines
      .slice(markerIndex + 1, nextMarkerIndex)
      .find((line) => line.trim().length > 0)
      ?.trim();
    if (inlineValue.length === 0 && followingValue === undefined) return false;
  }
  return true;
}

export function finalAiAnswerText(msgs: readonly BaseMessage[]): string {
  for (let index = msgs.length - 1; index >= 0; index -= 1) {
    const message = msgs[index];
    if (message === undefined || !isAiAnswer(message)) continue;
    const text = messageText(message).trim();
    if (text !== "" && !isEmptyResponseFallback(message)) return text;
  }
  return "";
}

export function condensedFindingText(msgs: BaseMessage[]): string {
  const parts: string[] = [];
  const seenParts = new Set<string>();
  for (const m of msgs) {
    if (!isAiAnswer(m) || isEmptyResponseFallback(m)) continue;
    const text = messageText(m).trim();
    if (text === "") continue;
    // Drop a byte-identical assistant turn (normalised on whitespace) so a
    // reasoning-copy + answer-copy of the same block does not survive twice.
    const key = text.replace(/\s+/g, " ");
    if (seenParts.has(key)) continue;
    seenParts.add(key);
    parts.push(text);
  }
  return collapseDuplicateLines(parts.join("\n\n"));
}

/**
 * Produces a status message string for a given stop reason.
 */
export function statusMessageFor(reason: StopReason): string {
  switch (reason) {
    case "completed":
      return "All tasks completed successfully.";
    case "no-tasks":
      return "No actionable tasks were produced by the planner.";
    case "iteration-limit":
      return "Stopped: iteration limit reached.";
    case "stagnation-limit":
      return "Stopped: no new research finding was produced in consecutive passes.";
    case "budget-limit":
      return "Stopped: the shared execution budget was exhausted.";
    case "cost-limit":
      return "Stopped: cost limit reached.";
    case "time-limit":
      return "Stopped: time limit reached.";
    case "planning-failure":
      return "Stopped: planner failed to produce a valid task list.";
    case "coverage-seed-failure":
      return "Stopped: coverage queue could not be seeded from a complete document overview.";
    case "coverage-provenance-failure":
      return "Stopped: a successful discovery search returned unparseable provenance.";
    case "exhausted":
      return "Stopped: all remaining tasks failed or no viable targets remain.";
    case "depth-limit":
      return "Stopped: harness nesting exceeded the delegation depth limit.";
    case "verification-failed":
      return "Stopped: the work completed but the verifier did not confirm the result.";
  }
}
