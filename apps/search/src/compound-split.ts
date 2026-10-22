// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * compound-split.ts
 *
 * Pure query-side splitting of long German compounds (FTS_COMPOUND_SPLIT).
 * The German stemmer keeps compounds as a single lexeme, so a query for
 * `Arbeitsplatz` never matches an indexed `Kommissionierarbeitsplatz`. With
 * the feature on, every query token of at least COMPOUND_MIN_TOKEN_LENGTH
 * characters is checked against the collection lexicon (see
 * fts-lexicon-cache.ts): the smallest cut where BOTH sides are known lexicon
 * words wins, and the matched lexemes are added to the lexical OR list only —
 * the AND list (T-010 all-terms ranking) keeps its exact-match semantics.
 */

/** Query tokens shorter than this are never split. */
export const COMPOUND_MIN_TOKEN_LENGTH = 10;

/** Lexemes shorter than this never count as a compound side. */
export const COMPOUND_MIN_PART_LENGTH = 4;

/** Longest Flexionsendung (inflection ending) still accepted after a lexeme. */
export const COMPOUND_MAX_SUFFIX_LENGTH = 3;

/** Minimum cut offset from both ends of the token. */
const MIN_CUT = 4;

/**
 * The longest word in `lexicon` that `part` consists of plus at most
 * COMPOUND_MAX_SUFFIX_LENGTH extra characters (a Flexionsendung). Lexemes
 * shorter than COMPOUND_MIN_PART_LENGTH never match.
 */
function matchLexeme(part: string, lexicon: Set<string>): string | undefined {
  if (part.length < COMPOUND_MIN_PART_LENGTH) return undefined;
  // A lexeme may be missing at most COMPOUND_MAX_SUFFIX_LENGTH trailing
  // characters of the part (the Flexionsendung), so the shortest candidate
  // worth checking is the part minus that ending.
  const minLen = Math.max(
    COMPOUND_MIN_PART_LENGTH,
    part.length - COMPOUND_MAX_SUFFIX_LENGTH,
  );
  for (let len = part.length; len >= minLen; len--) {
    const candidate = part.slice(0, len);
    if (lexicon.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Match the left side of a cut. Besides the plain prefix match, a left side
 * ending in `s` may stand for the lexeme without that `s` (genitive/compound
 * linking s, e.g. `Arbeits` for `Arbeit` is NOT accepted — only forms whose
 * shortened version is itself a known lexeme).
 */
function matchLeft(part: string, lexicon: Set<string>): string | undefined {
  const direct = matchLexeme(part, lexicon);
  if (direct) return direct;
  if (part.endsWith("s")) {
    const shortened = part.slice(0, -1);
    if (
      shortened.length >= COMPOUND_MIN_PART_LENGTH &&
      lexicon.has(shortened)
    ) {
      return shortened;
    }
  }
  return undefined;
}

/**
 * Split one lowercased query token against the collection lexicon.
 *
 * Returns the two matched lexicon words for the smallest valid cut (cut
 * offsets 4..length-4), or `[]` when the token is too short or no cut has
 * BOTH sides matching — an ambiguous token is then left alone entirely.
 * Returns lexicon words (real lexemes), not the raw trimmed parts.
 */
export function splitCompound(
  token: string,
  lexicon: Set<string>,
): string[] {
  const t = token.toLowerCase();
  if (t.length < COMPOUND_MIN_TOKEN_LENGTH) return [];
  for (let i = MIN_CUT; i <= t.length - MIN_CUT; i++) {
    const left = matchLeft(t.slice(0, i), lexicon);
    if (!left) continue;
    const right = matchLexeme(t.slice(i), lexicon);
    if (!right) continue;
    return left === right ? [left] : [left, right];
  }
  return [];
}

/**
 * Compound parts for every word token of `queryText` (same tokenisation as
 * the lexical query builders). Tokens already present in the query are not
 * repeated; the result preserves token order and is de-duplicated.
 */
export function compoundPartsForQuery(
  queryText: string,
  lexicon: Set<string>,
): string[] {
  const parts: string[] = [];
  const seen = new Set(parts);
  const tokens = queryText.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  for (const raw of tokens) {
    const lower = raw.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    for (const part of splitCompound(lower, lexicon)) {
      if (!seen.has(part)) {
        seen.add(part);
        parts.push(part);
      }
    }
  }
  return parts;
}
