// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * query-limits.ts — the query-cost bounds shared by every search entry point.
 *
 * Pins the two decisions:
 *   1. clampQuery cuts (never rejects) an over-long query at the last space
 *      before the limit, with a hard cut when the space would be past the
 *      halfway point of the budget.
 *   2. selectLexicalOperands keeps at most LEXICAL_MAX_TERMS tokens, longest
 *      first (rarity proxy, ties by first occurrence), restored to
 *      occurrence order.
 */

import { describe, expect, it } from "vitest";
import {
  clampQuery,
  DEFAULT_MAX_QUERY_CHARS,
  LEXICAL_MAX_TERMS,
  selectLexicalOperands,
} from "../src/query-limits.js";

describe("clampQuery", () => {
  it("hard-cuts a query without spaces to exactly maxChars", () => {
    const { query, truncated } = clampQuery("a".repeat(500), 400);
    expect(truncated).toBe(true);
    expect(query).toBe("a".repeat(400));
    expect(query.length).toBe(400);
  });

  it("cuts at the last space before the limit", () => {
    // 10 words of 9 chars + spaces: "aaaaaaaaa aaaaaaaaa ..." — the 400-char
    // window ends inside the 40th word, whose preceding space is at 399.
    const words = Array.from({ length: 60 }, (_, i) => `w${String(i).padStart(4, "0")}`);
    const full = words.join(" ");
    const { query, truncated } = clampQuery(full, 40);
    expect(truncated).toBe(true);
    expect(query.length).toBeLessThanOrEqual(40);
    expect(query).toBe(full.slice(0, full.lastIndexOf(" ", 40)).trimEnd());
    // The cut never splits a word: the result ends at a word boundary.
    expect(full.startsWith(query)).toBe(true);
    expect(full[query.length]).toBe(" ");
  });

  it("leaves a short query unchanged", () => {
    const { query, truncated } = clampQuery("mietvertrag kuendigung", 400);
    expect(truncated).toBe(false);
    expect(query).toBe("mietvertrag kuendigung");
  });

  it("falls back to a hard cut when the last space is before half the budget", () => {
    // One 500-char "word" (no spaces at all): the space search finds nothing,
    // so the limit itself is the cut.
    const { query, truncated } = clampQuery("x".repeat(500), 400);
    expect(truncated).toBe(true);
    expect(query).toBe("x".repeat(400));
  });

  it("DEFAULT_MAX_QUERY_CHARS is 400", () => {
    expect(DEFAULT_MAX_QUERY_CHARS).toBe(400);
  });
});

describe("selectLexicalOperands", () => {
  it("keeps the 32 longest of 40 tokens, in occurrence order", () => {
    // 40 distinct tokens with strictly increasing lengths: the 8 shortest
    // (indices 0..7) must drop out.
    const tokens = Array.from({ length: 40 }, (_, i) => "t" + "z".repeat(i));
    const kept = selectLexicalOperands(tokens);
    expect(kept.length).toBe(LEXICAL_MAX_TERMS);
    expect(kept).toEqual(tokens.slice(8));
  });

  it("breaks length ties by first occurrence", () => {
    // All tokens the same length: the first 32 occurrences win, in order.
    const tokens = Array.from({ length: 40 }, (_, i) => `tok${String(i).padStart(2, "0")}`);
    const kept = selectLexicalOperands(tokens);
    expect(kept).toEqual(tokens.slice(0, LEXICAL_MAX_TERMS));
  });

  it("restores occurrence order after the longest-first selection", () => {
    // Long tokens scattered through the query: selection is longest-first,
    // output is occurrence order.
    const tokens = ["ab", "longtoken1", "cd", "longtoken2", "ef", "longtoken3"];
    const kept = selectLexicalOperands(tokens, 3);
    expect(kept).toEqual(["longtoken1", "longtoken2", "longtoken3"]);
  });

  it("passes through a list at or below the cap", () => {
    const tokens = ["alpha", "beta", "gamma"];
    expect(selectLexicalOperands(tokens)).toEqual(tokens);
    const capped = Array.from({ length: LEXICAL_MAX_TERMS }, (_, i) => `w${i}`);
    expect(selectLexicalOperands(capped)).toEqual(capped);
  });
});
