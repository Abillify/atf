// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * query-limits.ts
 *
 * Query-cost bounds shared by every search entry point (`/search`,
 * `/v2/search`, the MCP `search` tool and the transaction evidence tools).
 *
 * An unbounded query text is a denial-of-service lever: the lexical list
 * turns every token into a `to_tsquery` operand (hundreds of OR terms cost
 * seconds of DB CPU), and HyDE / reranker inputs are sent at full length.
 * `SEARCH_MAX_QUERY_CHARS` bounds the query text; `LEXICAL_MAX_TERMS` bounds
 * the lexical operand list. Both degrade gracefully — long queries are cut,
 * never rejected — so flows that append context to the query keep working.
 */

/** Default for `SEARCH_MAX_QUERY_CHARS`. */
export const DEFAULT_MAX_QUERY_CHARS = 400;

/** Upper bound on the number of lexical (tsquery) operands per query. */
export const LEXICAL_MAX_TERMS = 32;

/**
 * Cut `query` to at most `maxChars` characters. The cut happens at the last
 * space before the limit so words are not split mid-token; when that space
 * would discard more than half the budget, the limit is applied as a hard
 * cut instead. Reports whether the query was shortened so the response can
 * surface it (`query_truncated` / `X-Query-Truncated`).
 */
export function clampQuery(
  query: string,
  maxChars: number,
): { query: string; truncated: boolean } {
  if (query.length <= maxChars) return { query, truncated: false };
  let cut = query.lastIndexOf(" ", maxChars);
  if (cut < maxChars / 2) cut = maxChars;
  return { query: query.slice(0, cut).trimEnd(), truncated: true };
}

/**
 * Deterministically reduce `tokens` to at most `max` operands: longest
 * tokens first (length is a cheap proxy for rarity — short tokens are the
 * ones that match everything and add cost without selectivity), ties broken
 * by first occurrence. The selection is restored to occurrence order so the
 * emitted tsquery stays stable for the same query text. Duplicates are
 * assumed removed by the caller.
 */
export function selectLexicalOperands(
  tokens: readonly string[],
  max = LEXICAL_MAX_TERMS,
): string[] {
  if (tokens.length <= max) return [...tokens];
  return tokens
    .map((token, index) => ({ token, index }))
    .sort((a, b) => b.token.length - a.token.length || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.token);
}
