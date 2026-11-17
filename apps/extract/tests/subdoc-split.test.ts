// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * tests/subdoc-split.test.ts
 *
 * Unit tests for the contract-2.5 sub-document split planner.
 */

import { describe, expect, test } from "vitest";
import type { OutlineNode } from "@atf/extract-contract";
import {
  CHARS_PER_CHUNK,
  estimateChunks,
  planSubdocSplit,
  slugifyChapterTitle,
  subdocSplitPlanOf,
  SUBDOC_SPLIT_KEY,
  type SubdocSplitOptions,
} from "../src/jobs/subdoc-split.js";

function outline(nodes: Array<Partial<OutlineNode> & { title: string }>): OutlineNode[] {
  return nodes.map((n, i) => ({
    level: n.level ?? 1,
    title: n.title,
    pageStart: n.pageStart ?? i + 1,
    ...(n.pageEnd !== undefined ? { pageEnd: n.pageEnd } : {}),
  })) as OutlineNode[];
}

/** Uniform character count per page. */
function flatChars(pages: number, chars = CHARS_PER_CHUNK): Map<number, number> {
  const map = new Map<number, number>();
  for (let p = 1; p <= pages; p++) map.set(p, chars);
  return map;
}

function expectContiguous(parts: { firstPage: number; lastPage: number }[], from: number, to: number): void {
  let expected = from;
  for (const part of parts) {
    expect(part.firstPage).toBe(expected);
    expect(part.lastPage).toBeGreaterThanOrEqual(part.firstPage);
    expected = part.lastPage + 1;
  }
  expect(expected - 1).toBe(to);
}

describe("estimateChunks", () => {
  test("zero characters is zero chunks", () => {
    expect(estimateChunks(0)).toBe(0);
  });
  test("a partial page of text is still one chunk", () => {
    expect(estimateChunks(1)).toBe(1);
    expect(estimateChunks(CHARS_PER_CHUNK)).toBe(1);
  });
  test("rounds up", () => {
    expect(estimateChunks(CHARS_PER_CHUNK + 1)).toBe(2);
    expect(estimateChunks(CHARS_PER_CHUNK * 3)).toBe(3);
  });
});

describe("slugifyChapterTitle", () => {
  test("replaces the reference separator", () => {
    expect(slugifyChapterTitle("Kapitel 1/2 Übersicht")).toBe("Kapitel 1|2 Übersicht");
  });
  test("collapses whitespace and trims", () => {
    expect(slugifyChapterTitle("  Tief   \n Durch  ")).toBe("Tief Durch");
  });
  test("caps length", () => {
    expect(slugifyChapterTitle("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
  test("empty falls back", () => {
    expect(slugifyChapterTitle("   ")).toBe("kapitel");
  });
});

describe("planSubdocSplit", () => {
  const noOutline: OutlineNode[] = [];

  test("returns null for a degenerate page range", () => {
    expect(
      planSubdocSplit({ outline: noOutline, firstPage: 5, lastPage: 5, maxChunks: 1, charsPerPage: flatChars(10) }),
    ).toBeNull();
  });

  test("returns null when maxChunks is below 1", () => {
    expect(
      planSubdocSplit({ outline: noOutline, firstPage: 1, lastPage: 10, maxChunks: 0, charsPerPage: flatChars(10) }),
    ).toBeNull();
  });

  test("returns null when the document fits the budget", () => {
    expect(
      planSubdocSplit({ outline: noOutline, firstPage: 1, lastPage: 10, maxChunks: 10, charsPerPage: flatChars(10) }),
    ).toBeNull();
  });

  test("splits at page boundaries without an outline", () => {
    const plan = planSubdocSplit({
      outline: noOutline,
      firstPage: 1,
      lastPage: 10,
      maxChunks: 4,
      charsPerPage: flatChars(10),
    });
    expect(plan).not.toBeNull();
    expect(plan?.subdocuments.length).toBeGreaterThan(1);
    expectContiguous(plan?.subdocuments ?? [], 1, 10);
    expect(plan?.subdocuments.map((s) => s.suffix)).toEqual(["teil-1", "teil-2", "teil-3"]);
  });

  test("splits at chapter boundaries when an outline exists", () => {
    const plan = planSubdocSplit({
      outline: outline([
        { title: "Einleitung", pageStart: 1, pageEnd: 3 },
        { title: "Hauptteil", pageStart: 4, pageEnd: 8 },
        { title: "Anhang", pageStart: 9, pageEnd: 10 },
      ]),
      firstPage: 1,
      lastPage: 10,
      maxChunks: 5,
      charsPerPage: flatChars(10),
    });
    expect(plan).not.toBeNull();
    expect(plan?.subdocuments.map((s) => s.suffix)).toEqual(["Einleitung", "Hauptteil", "Anhang"]);
    expectContiguous(plan?.subdocuments ?? [], 1, 10);
  });

  test("packs small chapters until the budget is reached", () => {
    const plan = planSubdocSplit({
      outline: outline([
        { title: "A", pageStart: 1, pageEnd: 2 },
        { title: "B", pageStart: 3, pageEnd: 4 },
        { title: "C", pageStart: 5, pageEnd: 6 },
        { title: "D", pageStart: 7, pageEnd: 8 },
      ]),
      firstPage: 1,
      lastPage: 8,
      maxChunks: 4,
      charsPerPage: flatChars(8),
    });
    expect(plan).not.toBeNull();
    // Each chapter is 2 chunks, so two fit into the budget of 4: chapters
    // pack pairwise in reading order.
    expect(plan?.subdocuments.map((s) => s.suffix)).toEqual(["A", "C"]);
    expect(plan?.subdocuments[0]?.lastPage).toBe(4);
    expectContiguous(plan?.subdocuments ?? [], 1, 8);
  });

  test("cuts an oversized chapter at page boundaries with numbered suffixes", () => {
    const plan = planSubdocSplit({
      outline: outline([
        { title: "Kurzes", pageStart: 1, pageEnd: 2 },
        { title: "Riesiges", pageStart: 3, pageEnd: 12 },
      ]),
      firstPage: 1,
      lastPage: 12,
      maxChunks: 4,
      charsPerPage: flatChars(12),
    });
    expect(plan).not.toBeNull();
    expect(plan?.subdocuments[0]?.suffix).toBe("Kurzes");
    expect(plan?.subdocuments[1]?.suffix).toBe("Riesiges");
    expect(plan?.subdocuments[2]?.suffix).toBe("Riesiges-2");
    expectContiguous(plan?.subdocuments ?? [], 1, 12);
  });

  test("gap pages between chapters join the preceding chapter", () => {
    const plan = planSubdocSplit({
      outline: outline([
        { title: "A", pageStart: 1, pageEnd: 5 },
        { title: "B", pageStart: 8, pageEnd: 12 },
        { title: "C", pageStart: 13, pageEnd: 15 },
      ]),
      firstPage: 1,
      lastPage: 15,
      maxChunks: 5,
      // The gap pages 6–7 are empty (e.g. full-page figures), so they still
      // fit into A's budget.
      charsPerPage: new Map([
        ...[1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15].map((p) => [p, CHARS_PER_CHUNK] as const),
        [6, 0],
        [7, 0],
      ]),
    });
    expect(plan).not.toBeNull();
    expect(plan?.subdocuments.map((s) => s.suffix)).toEqual(["A", "B", "C"]);
    // Pages 6–7 (gap after A) join A, page 13 starts C without a gap.
    expect(plan?.subdocuments[0]?.lastPage).toBe(7);
    expect(plan?.subdocuments[1]?.lastPage).toBe(12);
    expectContiguous(plan?.subdocuments ?? [], 1, 15);
  });

  test("preamble pages join the first chapter, trailing pages the last", () => {
    const plan = planSubdocSplit({
      outline: outline([
        { title: "Erstes", pageStart: 3, pageEnd: 5 },
        { title: "Letztes", pageStart: 8, pageEnd: 9 },
      ]),
      firstPage: 1,
      lastPage: 12,
      maxChunks: 3,
      charsPerPage: flatChars(12),
    });
    expect(plan).not.toBeNull();
    expectContiguous(plan?.subdocuments ?? [], 1, 12);
    expect(plan?.subdocuments[0]?.firstPage).toBe(1);
    expect(plan?.subdocuments[0]?.suffix).toBe("Erstes");
    expect(plan?.subdocuments[plan.subdocuments.length - 1]?.lastPage).toBe(12);
  });

  test("only the top outline level forms chapters", () => {
    const plan = planSubdocSplit({
      outline: outline([
        { title: "Teil", level: 1, pageStart: 1, pageEnd: 10 },
        { title: "Kapitel A", level: 2, pageStart: 1, pageEnd: 5 },
        { title: "Kapitel B", level: 2, pageStart: 6, pageEnd: 10 },
      ]),
      firstPage: 1,
      lastPage: 10,
      maxChunks: 5,
      charsPerPage: flatChars(10),
    });
    expect(plan).not.toBeNull();
    // The single level-1 node forms one oversized chapter, cut at page
    // boundaries; the level-2 nodes are ignored.
    expect(plan?.subdocuments.map((s) => s.suffix)).toEqual(["Teil", "Teil-2"]);
    expectContiguous(plan?.subdocuments ?? [], 1, 10);
  });

  test("honours a windowed page range", () => {
    const plan = planSubdocSplit({
      outline: outline([
        { title: "Vorher", pageStart: 1, pageEnd: 4 },
        { title: "Fenster", pageStart: 5, pageEnd: 12 },
      ]),
      firstPage: 6,
      lastPage: 12,
      maxChunks: 3,
      charsPerPage: flatChars(12),
    });
    expect(plan).not.toBeNull();
    expect(plan?.subdocuments[0]?.firstPage).toBe(6);
    expectContiguous(plan?.subdocuments ?? [], 6, 12);
  });

  test("duplicate titles get unique suffixes", () => {
    const plan = planSubdocSplit({
      outline: outline([
        { title: "Update", pageStart: 1, pageEnd: 4 },
        { title: "Update", pageStart: 5, pageEnd: 8 },
        { title: "Update", pageStart: 9, pageEnd: 12 },
      ]),
      firstPage: 1,
      lastPage: 12,
      maxChunks: 3,
      charsPerPage: flatChars(12),
    });
    expect(plan).not.toBeNull();
    const suffixes = plan?.subdocuments.map((s) => s.suffix) ?? [];
    expect(new Set(suffixes).size).toBe(suffixes.length);
  });
});

describe("subdocSplitPlanOf", () => {
  test("absent config yields null", () => {
    expect(subdocSplitPlanOf({})).toBeNull();
  });

  test("a valid frozen plan round-trips", () => {
    const plan = {
      maxChunks: 40,
      subdocuments: [
        { suffix: "A", firstPage: 1, lastPage: 5 },
        { suffix: "B", firstPage: 6, lastPage: 9 },
      ],
    };
    expect(subdocSplitPlanOf({ [SUBDOC_SPLIT_KEY]: plan })).toEqual(plan);
  });

  test("malformed entries are rejected", () => {
    expect(subdocSplitPlanOf({ [SUBDOC_SPLIT_KEY]: { maxChunks: "x", subdocuments: [] } })).toBeNull();
    expect(
      subdocSplitPlanOf({
        [SUBDOC_SPLIT_KEY]: { maxChunks: 4, subdocuments: [{ suffix: "A", firstPage: 1, lastPage: 2 }] },
      }),
    ).toBeNull();
    expect(
      subdocSplitPlanOf({
        [SUBDOC_SPLIT_KEY]: {
          maxChunks: 4,
          subdocuments: [
            { suffix: "A", firstPage: 1, lastPage: 2 },
            { suffix: "", firstPage: 3, lastPage: 4 },
            { suffix: "C", firstPage: 0, lastPage: 5 },
          ],
        },
      }),
    ).toBeNull();
  });
});

describe("SubdocSplitOptions typing", () => {
  test("charsPerPage map may omit pages", () => {
    const opts: SubdocSplitOptions = {
      outline: [],
      firstPage: 1,
      lastPage: 4,
      maxChunks: 1,
      charsPerPage: new Map([
        [1, 5000],
        [3, 5000],
      ]),
    };
    const plan = planSubdocSplit(opts);
    expect(plan).not.toBeNull();
    expectContiguous(plan?.subdocuments ?? [], 1, 4);
  });
});
