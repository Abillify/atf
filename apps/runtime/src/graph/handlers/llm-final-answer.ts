// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Final-answer contract & pre-tool-call preamble constants.
 *
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged. Owns the marker-delimited final-answer extraction contract and
 * the bounded preamble lookahead limits.
 */

// ---------------------------------------------------------------------------
// Pre-tool-call preamble: bounded lookahead
// ---------------------------------------------------------------------------

/**
 * Max time (ms) after the first preamble delta before we give up waiting for
 * a tool call and resolve the buffered text as the real answer.
 */
export const PREAMBLE_MAX_MS = 400;

/** Max buffered preamble characters before forcing resolution as content. */
export const PREAMBLE_MAX_CHARS = 200;

/** Matches a sentence-ending boundary at the end of the buffered preamble. */
export const PREAMBLE_SENTENCE_BOUNDARY_RE = /[.!?][\s"'”)\]]*$/;

/**
 * Default visible answer used when `config.emptyResponseFallback` is enabled and
 * every attempt (and fallback candidate) came back with an empty completion —
 * no visible text, no salvageable reasoning, no tool call. Overridable per node
 * via `config.emptyResponseFallbackText`. Kept short and neutral so a downstream
 * synthesizer treats the step as "produced nothing" rather than choking on it.
 */
export const DEFAULT_EMPTY_RESPONSE_FALLBACK =
  "(No answer was produced for this step.)";

export interface FinalAnswerContractConfig {
  startMarker: string;
  endMarker: string;
  streamAfterStartMarker?: boolean;
}

export type FinalAnswerExtraction =
  | { ok: true; answer: string }
  | {
      ok: false;
      reason:
        | "missing_start_marker"
        | "missing_end_marker"
        | "duplicate_start_marker"
        | "duplicate_end_marker"
        | "misordered_markers"
        | "empty_final_answer"
        | "placeholder_final_answer";
    };

/** Rejects marker content that can never be a useful final answer. */
export function isFinalAnswerPlaceholder(answer: string): boolean {
  // Models occasionally wrap a placeholder in an inline or fenced Markdown code
  // span. Strip only the outer backticks so normal Markdown prose is untouched.
  const normalized = answer
    .trim()
    .replace(/^`+\s*/u, "")
    .replace(/\s*`+$/u, "")
    .replace(/\s+/gu, "");
  return /^(?:\.\.\.|…|[-–—]+)$/u.test(normalized);
}

/**
 * Live output is irreversible. Delay symbol-only candidates until the end
 * marker, where the full contract can reject placeholders such as `...`.
 * Short legitimate answers (for example "Ja.") still stream as soon as a
 * letter or digit arrives; symbol-only answers remain valid but are emitted
 * once their complete marker pair is verified.
 */
export function hasFinalAnswerStreamingSubstance(answer: string): boolean {
  return /[\p{L}\p{N}]/u.test(answer);
}

/**
 * Extract exactly one non-empty, non-placeholder answer enclosed by the configured markers.
 * Anything before/after the pair is deliberately discarded: it may be model
 * planning emitted through the ordinary content channel rather than a native
 * reasoning channel. Ambiguous output fails closed instead of guessing which
 * segment is safe to show.
 */
export function extractFinalAnswer(
  raw: string,
  contract: FinalAnswerContractConfig,
): FinalAnswerExtraction {
  const start = raw.indexOf(contract.startMarker);
  if (start === -1) return { ok: false, reason: "missing_start_marker" };
  if (raw.indexOf(contract.startMarker, start + 1) !== -1) {
    return { ok: false, reason: "duplicate_start_marker" };
  }

  const firstEnd = raw.indexOf(contract.endMarker);
  const end = raw.indexOf(
    contract.endMarker,
    start + contract.startMarker.length,
  );
  if (end === -1) return { ok: false, reason: "missing_end_marker" };
  if (firstEnd !== end) return { ok: false, reason: "misordered_markers" };
  if (raw.indexOf(contract.endMarker, end + 1) !== -1) {
    return { ok: false, reason: "duplicate_end_marker" };
  }

  const answer = raw.slice(start + contract.startMarker.length, end).trim();
  if (answer.length === 0) {
    return { ok: false, reason: "empty_final_answer" };
  }
  return isFinalAnswerPlaceholder(answer)
    ? { ok: false, reason: "placeholder_final_answer" }
    : { ok: true, answer };
}

export function longestMarkerPrefixSuffix(
  text: string,
  markers: readonly string[],
): number {
  let longest = 0;
  for (const marker of markers) {
    const max = Math.min(text.length, marker.length - 1);
    for (let length = max; length > longest; length--) {
      if (text.endsWith(marker.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}
