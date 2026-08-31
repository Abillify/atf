// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decides whether an LLM node must call a tool before it may answer.
 *
 * Two very different requirements share one mechanism:
 *
 *  - `requireToolUse: true` is a **contract**: the flow author states that a
 *    text-only answer is worthless (e.g. a researcher node whose findings must
 *    come from a real retrieval). Violating it has to fail the node — emitting
 *    ungrounded prose would be worse than an error.
 *
 *  - `requireToolUseWhenSelected: true` is a **heuristic**: force a tool call
 *    only because semantic tool selection found something plausibly relevant.
 *    The signal comes from an embedding score, not from the author, so it can
 *    be wrong — and when it is wrong, the user must still get an answer.
 *
 * Keeping the two apart is what stops a noisy embedding match from turning a
 * harmless "retry" into a failed turn (trace c44d1214: query "retry" selected
 * `parking/reassign_booking` at 0.49, the model refused to call it three times,
 * and the whole execution ended in `error` with nothing shown to the user).
 *
 * Pure and dependency-free so the policy can be tested without a provider.
 */

/**
 * Phrases that carry no domain intent of their own. A hit here means the turn's
 * meaning lives entirely in the preceding conversation, so an embedding match
 * against the phrase itself says nothing about which tool is appropriate.
 *
 * Deliberately exact-match (after normalisation) rather than substring:
 * "test" must match, "test the parking export" must not.
 */
const NO_INTENT_PHRASES: ReadonlySet<string> = new Set([
  // Retries / acknowledgements of a previous failure
  "test",
  "retry",
  "again",
  "try again",
  "nochmal",
  "noch mal",
  "noch einmal",
  "erneut",
  "wieder",
  "weiter",
  "mach weiter",
  "und",
  "na und",
  // Greetings
  "hi",
  "hey",
  "hallo",
  "halo",
  "huhu",
  "moin",
  "servus",
  "gruezi",
  "guten morgen",
  "guten tag",
  "guten abend",
  "hello",
  "good morning",
  // Acknowledgements
  "ok",
  "okay",
  "oki",
  "alles klar",
  "verstanden",
  "danke",
  "danke dir",
  "vielen dank",
  "thanks",
  "thank you",
  "thx",
  "ja",
  "nein",
  "yes",
  "no",
]);

/**
 * The "try it again" family, which is too productive for a phrase list:
 * versuch/versuche/versuchs/versucht/probier/probiere/probiers/probiert,
 * optionally followed by "es"/"das"/"mal", then a repetition adverb.
 */
const RETRY_PHRASE_RE =
  /^(?:versuch(?:e|s|t|es)?|probier(?:e|s|t|es)?)(?:\s+(?:es|das|mal))*(?:\s+(?:nochmal|noch\s*mal|noch\s+einmal|erneut|wieder|neu))?$/u;

/** Longer utterances always carry some intent of their own. */
const MAX_NO_INTENT_WORDS = 3;

/**
 * Normalises a user turn for phrase matching: case-folded, punctuation- and
 * emoji-trimmed, whitespace-collapsed.
 */
export function normalizeUserPhrase(query: string): string {
  return query
    .normalize("NFC")
    .toLocaleLowerCase("de-DE")
    .replace(/[\p{P}\p{S}\p{Emoji_Presentation}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * True when the turn is a bare retry, greeting or acknowledgement — i.e. text
 * whose embedding similarity to any tool description is noise.
 */
export function isNoIntentFollowUp(query: string): boolean {
  const normalized = normalizeUserPhrase(query);
  if (normalized === "") return true;
  // The regex is fully anchored and made only of retry-family words, so it can
  // safely match a longer utterance ("versuch es noch einmal") than the phrase
  // list, where a word cap is what keeps "test" from also matching "test the
  // parking export".
  if (RETRY_PHRASE_RE.test(normalized)) return true;
  const words = normalized.split(" ");
  if (words.length > MAX_NO_INTENT_WORDS) return false;
  return NO_INTENT_PHRASES.has(normalized);
}

/** The subset of an llm node's config this policy reads. */
export interface RequireToolUseConfig {
  requireToolUse?: boolean;
  requireToolUseWhenSelected?: boolean;
  requireToolUseWhenSelectedMinScore?: number;
}

export interface RequireToolUseInput {
  config: RequireToolUseConfig | undefined;
  /** Semantic hits that were actually bound to a callable AI-SDK tool key. */
  selectedBoundToolCount: number;
  /** Best score among those bound hits; -Infinity when there were none. */
  selectedBoundToolBestScore: number;
  /** The newest user turn, used to reject intent-free queries. */
  query: string;
  /**
   * A server-validated continuation of a previous read-only intent. This is
   * intentionally distinct from semantic selection: it must never originate
   * from a model-proposed or user-supplied tool reference.
   */
  safeRetryToolOverride?: boolean;
}

export interface RequireToolUseDecision {
  /** Force `toolChoice: "required"` on the first step. */
  required: boolean;
  /**
   * Whether an unmet requirement must fail the node. False for the heuristic
   * mode: after the nudges are exhausted the model's text is released instead,
   * because a wrong guess about relevance must not cost the user their answer.
   */
  mandatory: boolean;
  /** Why the decision came out the way it did (diagnostics only). */
  reason:
    | "config_contract"
    | "safe_retry_override"
    | "semantic_selection"
    | "disabled"
    | "no_bound_tool"
    | "score_below_threshold"
    | "no_intent_query";
}

/** Threshold used when the flow does not configure one. */
export const DEFAULT_REQUIRE_TOOL_USE_MIN_SCORE = 0.5;

/**
 * Resolves the effective requirement. Note the asymmetry between the two
 * inputs: the semantic *visibility* threshold (`toolSelection.minScore`) is
 * intentionally permissive so the model gets to see borderline tools, while
 * making a call *mandatory* needs a stronger signal — hence a separate,
 * higher threshold plus the intent check.
 */
export function decideRequireToolUse(
  input: RequireToolUseInput,
): RequireToolUseDecision {
  const config = input.config;
  if (config?.requireToolUse === true) {
    return { required: true, mandatory: true, reason: "config_contract" };
  }
  if (input.safeRetryToolOverride === true) {
    // The override comes from a static allowlist and an earlier user request in
    // this exact conversation. Unlike an embedding hit it is deterministic,
    // and it is a read-only retry, so release no ungrounded replacement text.
    return { required: true, mandatory: true, reason: "safe_retry_override" };
  }
  if (config?.requireToolUseWhenSelected !== true) {
    return { required: false, mandatory: false, reason: "disabled" };
  }
  if (input.selectedBoundToolCount <= 0) {
    return { required: false, mandatory: false, reason: "no_bound_tool" };
  }
  const configured = config.requireToolUseWhenSelectedMinScore;
  const threshold =
    typeof configured === "number" && Number.isFinite(configured)
      ? configured
      : DEFAULT_REQUIRE_TOOL_USE_MIN_SCORE;
  if (!(input.selectedBoundToolBestScore >= threshold)) {
    return {
      required: false,
      mandatory: false,
      reason: "score_below_threshold",
    };
  }
  if (isNoIntentFollowUp(input.query)) {
    return { required: false, mandatory: false, reason: "no_intent_query" };
  }
  return { required: true, mandatory: false, reason: "semantic_selection" };
}
