// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Repetition guard (`src/graph/repetition-guard.ts`)
 *
 * Pure, dependency-free detection of degenerate generation loops. Extracted
 * into a leaf module (like `rag-grounding.ts`) so it is unit-testable without
 * importing the node-handler barrel (`handlers/index.ts`), which has an
 * init-order cycle via `graph-engine`.
 *
 * Small local models (e.g. qwen via LM Studio, with thinking enabled and low
 * temperature) can fall into a loop that emits the same block thousands of
 * times, never calling a tool. In a synthetic long-running research trace this
 * wasted ~20 min of generation and — via the harness carryForward — exploded the shared
 * context until the next node overflowed its (100k) context window and returned
 * an empty response. The LLM handler feeds generated text here mid-stream to
 * detect the loop early, then aborts the upstream generation and truncates the
 * output to the first (non-repeated) block.
 */

/**
 * Length (chars) of the tail probe compared against earlier text. Long enough
 * that an ordinary repeated phrase (a name, a heading) does not trigger, short
 * enough to catch a loop within a few hundred emitted chars.
 */
export const REPETITION_PROBE_LEN = 120;
/** Do not scan for repetition until the generated text reaches this length. */
export const REPETITION_MIN_TEXT = 600;
/**
 * How many non-overlapping occurrences of the tail probe must exist for the
 * text to be classified as a degenerate loop. A legitimate answer effectively
 * never repeats an identical 120-char block four times near its tail; a stuck
 * model repeats it endlessly.
 */
export const REPETITION_THRESHOLD = 4;
/** Re-run the (cheap) scan only after this many new chars have been generated. */
export const REPETITION_CHECK_INTERVAL = 400;

/**
 * Detects a degenerate repetition loop at the tail of generated text.
 *
 * Takes the last {@link REPETITION_PROBE_LEN} chars as a probe and counts its
 * non-overlapping occurrences in the whole text. When the probe recurs at least
 * {@link REPETITION_THRESHOLD} times the text is a loop; `safeLen` is the end of
 * the probe's FIRST occurrence, i.e. a truncation point that keeps the initial
 * (non-repeated) content and drops the runaway tail.
 *
 * Runs in O(n) over the current text and is meant to be invoked only every
 * {@link REPETITION_CHECK_INTERVAL} chars, so the amortised cost is negligible —
 * and because callers abort on the first positive, the text stays small.
 *
 * @param text - The text generated so far (visible content or reasoning).
 * @returns `{ loop, safeLen }` — `loop` true when a repetition loop is detected;
 *          `safeLen` the char length to truncate to (defaults to `text.length`).
 */
export function detectRepeatedTail(text: string): {
  loop: boolean;
  safeLen: number;
} {
  const n = text.length;
  if (n < REPETITION_MIN_TEXT) return { loop: false, safeLen: n };
  const probe = text.slice(n - REPETITION_PROBE_LEN);
  // Ignore whitespace-dominated probes (e.g. long runs of newlines) — those are
  // not meaningful repetition and would false-positive.
  if (probe.trim().length < REPETITION_PROBE_LEN / 2) {
    return { loop: false, safeLen: n };
  }
  let idx = text.indexOf(probe);
  let count = 0;
  let firstEnd = -1;
  while (idx !== -1) {
    count += 1;
    if (firstEnd === -1) firstEnd = idx + REPETITION_PROBE_LEN;
    // Non-overlapping: jump past this occurrence.
    idx = text.indexOf(probe, idx + REPETITION_PROBE_LEN);
  }
  if (count >= REPETITION_THRESHOLD) {
    return { loop: true, safeLen: firstEnd > 0 ? firstEnd : n };
  }
  return { loop: false, safeLen: n };
}
