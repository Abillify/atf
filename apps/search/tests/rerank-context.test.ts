// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import pino from "pino";
import {
  applyMinScore,
  retrievalScoreKind,
  buildRerankDocument,
  diversifyResults,
  groupResultsBySection,
  groupResultsV2,
  fitRerankInputs,
  sectionPathString,
  unitType,
  RERANK_MAX_TOKENS,
  CHARS_PER_TOKEN,
  DEFAULT_SECTION_CAP,
} from "../src/rerank-context.js";
import { rerankResultsWithStatus } from "../src/handlers/search.js";
import type { SearchResult } from "../src/postgres-client.js";
import type { RerankerClient, RerankResponse } from "../src/reranker-client.js";
import type { TokenCounter } from "../src/token-counter.js";

const instant = new Date("2026-03-01T00:00:00.000Z");
const silent = pino({ level: "silent" });

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: overrides.id ?? "1",
    score: overrides.score ?? 0.9,
    content: overrides.content ?? "some content",
    metadata: overrides.metadata ?? {},
    reference: overrides.reference ?? "doc#0",
    base_ref: overrides.base_ref ?? "doc",
    created: instant,
    modified: instant,
    valid_from: null,
    effective_valid_from: instant,
    ...overrides,
  };
}

// ─── buildRerankDocument (Requirement 13.2) ──────────────────────────────────

describe("buildRerankDocument", () => {
  it("includes title, section path, type, and content", () => {
    const doc = buildRerankDocument(
      result({
        title: "WMS Pflichtenheft",
        content: "Der Wareneingang wird über Maske WE01 gebucht.",
        metadata: { unit_type: "chunk", section_path: ["3", "3.2 Wareneingang"] },
      }),
    );
    expect(doc).toContain("Title: WMS Pflichtenheft");
    expect(doc).toContain("Section: 3 / 3.2 Wareneingang");
    expect(doc).toContain("Type: chunk");
    expect(doc).toContain("Der Wareneingang wird über Maske WE01 gebucht.");
    // Header comes before the content.
    expect(doc.indexOf("Title:")).toBeLessThan(doc.indexOf("Der Wareneingang"));
  });

  it("reads section path from evidence when metadata has none", () => {
    const doc = buildRerankDocument(
      result({
        evidence: {
          reference: "doc#0",
          root_document_id: "doc",
          section_path: ["A", "B"],
        },
      }),
    );
    expect(doc).toContain("Section: A / B");
  });

  it("truncates the content to <= 1024 tokens while keeping the header", () => {
    const longContent = "x".repeat(RERANK_MAX_TOKENS * CHARS_PER_TOKEN * 3);
    const doc = buildRerankDocument(
      result({
        title: "Big Doc",
        content: longContent,
        metadata: { unit_type: "table", section_path: ["Anhang"] },
      }),
    );
    const maxChars = RERANK_MAX_TOKENS * CHARS_PER_TOKEN;
    // Whole document stays within the char budget (~1024 tokens).
    expect(doc.length).toBeLessThanOrEqual(maxChars);
    // Header survived truncation.
    expect(doc).toContain("Title: Big Doc");
    expect(doc).toContain("Section: Anhang");
    expect(doc).toContain("Type: table");
    // Content was actually cut (it started far longer than the budget).
    expect(doc.length).toBeLessThan(longContent.length);
  });

  it("respects a custom maxTokens argument", () => {
    const doc = buildRerankDocument(
      result({ content: "y".repeat(1000) }),
      10,
    );
    expect(doc.length).toBeLessThanOrEqual(10 * CHARS_PER_TOKEN);
  });

  it("degrades to content-only for a legacy row without title/section/type", () => {
    const doc = buildRerankDocument(
      result({ title: undefined, content: "just content", metadata: {} }),
    );
    expect(doc).toBe("just content");
  });

  it("extracts section path and unit type helpers defensively", () => {
    expect(sectionPathString(result({ metadata: {} }))).toBe("");
    expect(unitType(result({ metadata: {} }))).toBeUndefined();
    expect(
      unitType(result({ metadata: { unit_type: "figure" } })),
    ).toBe("figure");
  });
});

// ─── diversifyResults per-section cap ───────────────────

describe("diversifyResults — per-section cap", () => {
  it("caps hits per section keeping the highest-scoring ones", () => {
    const sec = ["Kapitel 1"];
    const results = [
      result({ id: "a", score: 0.9, metadata: { section_path: sec } }),
      result({ id: "b", score: 0.8, metadata: { section_path: sec } }),
      result({ id: "c", score: 0.7, metadata: { section_path: sec } }),
      result({ id: "d", score: 0.6, metadata: { section_path: sec } }),
      result({ id: "e", score: 0.5, metadata: { section_path: sec } }),
    ];
    const out = diversifyResults(results, { perSectionCap: 3 });
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("uses DEFAULT_SECTION_CAP when no cap is given", () => {
    const sec = ["S"];
    const results = Array.from({ length: DEFAULT_SECTION_CAP + 2 }, (_, i) =>
      result({
        id: String(i),
        score: 1 - i * 0.1,
        metadata: { section_path: sec },
      }),
    );
    expect(diversifyResults(results)).toHaveLength(DEFAULT_SECTION_CAP);
  });

  it("does not cap hits that have no section path", () => {
    const results = [
      result({ id: "a", score: 0.9, metadata: {} }),
      result({ id: "b", score: 0.8, metadata: {} }),
      result({ id: "c", score: 0.7, metadata: {} }),
      result({ id: "d", score: 0.6, metadata: {} }),
    ];
    expect(diversifyResults(results, { perSectionCap: 2 })).toHaveLength(4);
  });

  it("caps each section independently", () => {
    const results = [
      result({ id: "a1", score: 0.9, metadata: { section_path: ["A"] } }),
      result({ id: "a2", score: 0.8, metadata: { section_path: ["A"] } }),
      result({ id: "a3", score: 0.7, metadata: { section_path: ["A"] } }),
      result({ id: "b1", score: 0.6, metadata: { section_path: ["B"] } }),
      result({ id: "b2", score: 0.5, metadata: { section_path: ["B"] } }),
    ];
    const out = diversifyResults(results, { perSectionCap: 2 });
    expect(out.map((r) => r.id)).toEqual(["a1", "a2", "b1", "b2"]);
  });

  /**
   * The cap bucket is document-scoped: "Einleitung" in ten different manuals
   * is ten different sections. Previously the bucket key was the bare section
   * path, so the cap applied ACROSS documents and nine of ten manuals lost
   * their intro hits entirely.
   */
  it("caps the same section path per document, not across documents", () => {
    const results = [
      result({
        id: "d1",
        score: 0.9,
        base_ref: "manual-1",
        reference: "manual-1#0",
        metadata: { section_path: ["Einleitung"] },
      }),
      result({
        id: "d2",
        score: 0.8,
        base_ref: "manual-2",
        reference: "manual-2#0",
        metadata: { section_path: ["Einleitung"] },
      }),
      result({
        id: "d3",
        score: 0.7,
        base_ref: "manual-3",
        reference: "manual-3#0",
        metadata: { section_path: ["Einleitung"] },
      }),
      result({
        id: "d1b",
        score: 0.6,
        base_ref: "manual-1",
        reference: "manual-1#1",
        metadata: { section_path: ["Einleitung"] },
      }),
      result({
        id: "d2b",
        score: 0.5,
        base_ref: "manual-2",
        reference: "manual-2#1",
        metadata: { section_path: ["Einleitung"] },
      }),
    ];
    const out = diversifyResults(results, { perSectionCap: 1 });
    // One hit per document survives; the extra manual-1/manual-2 hits drop.
    expect(out.map((r) => r.id)).toEqual(["d1", "d2", "d3"]);
  });

  it("falls back to reference when base_ref is missing for the cap bucket", () => {
    const results = [
      result({
        id: "a",
        score: 0.9,
        base_ref: "",
        reference: "doc-a#0",
        metadata: { section_path: ["S"] },
      }),
      result({
        id: "b",
        score: 0.8,
        base_ref: "",
        reference: "doc-b#0",
        metadata: { section_path: ["S"] },
      }),
    ];
    expect(diversifyResults(results, { perSectionCap: 1 })).toHaveLength(2);
  });

  it("preserves score order of survivors", () => {
    const out = diversifyResults(
      [
        result({ id: "a", score: 0.9, metadata: { section_path: ["A"] } }),
        result({ id: "b", score: 0.8, metadata: { section_path: ["B"] } }),
      ],
      { perSectionCap: 5 },
    );
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

// ─── diversifyResults table/figure collapse ──────────────────────────────────

describe("diversifyResults — collapse same table/figure", () => {
  it("collapses multiple hits of the same table_id to the highest score", () => {
    const results = [
      result({ id: "t-low", score: 0.5, metadata: { table_id: "T1" } }),
      result({ id: "t-high", score: 0.9, metadata: { table_id: "T1" } }),
      result({ id: "t-mid", score: 0.7, metadata: { table_id: "T1" } }),
    ];
    const out = diversifyResults(results);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("t-high");
  });

  it("collapses multiple hits of the same figure_id to the highest score", () => {
    const results = [
      result({ id: "f-a", score: 0.4, evidence: { reference: "r", root_document_id: "d", figure_id: "F9" } }),
      result({ id: "f-b", score: 0.8, evidence: { reference: "r", root_document_id: "d", figure_id: "F9" } }),
    ];
    const out = diversifyResults(results);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("f-b");
  });

  /**
   * `table_id` / `figure_id` are assigned per document by Extract, so two data
   * sheets that both carry "T1" / "F1" are different objects. The collapse key
   * used to be the bare id, so the lower-scoring document silently lost its hit.
   */
  it("does not collapse the same table_id across different documents", () => {
    const results = [
      result({
        id: "a-t1",
        score: 0.9,
        base_ref: "sheet-a",
        reference: "sheet-a#0",
        metadata: { table_id: "T1" },
      }),
      result({
        id: "b-t1",
        score: 0.6,
        base_ref: "sheet-b",
        reference: "sheet-b#0",
        metadata: { table_id: "T1" },
      }),
    ];
    const out = diversifyResults(results, { perSectionCap: 0 });
    expect(out.map((r) => r.id)).toEqual(["a-t1", "b-t1"]);
  });

  it("does not collapse the same figure_id across different documents", () => {
    const results = [
      result({
        id: "a-f1",
        score: 0.9,
        base_ref: "sheet-a",
        reference: "sheet-a#0",
        metadata: { figure_id: "F1" },
      }),
      result({
        id: "b-f1",
        score: 0.6,
        base_ref: "sheet-b",
        reference: "sheet-b#0",
        metadata: { figure_id: "F1" },
      }),
    ];
    const out = diversifyResults(results, { perSectionCap: 0 });
    expect(out.map((r) => r.id)).toEqual(["a-f1", "b-f1"]);
  });

  it("still collapses the same table_id within one document when other documents share the id", () => {
    const results = [
      result({
        id: "a-low",
        score: 0.5,
        base_ref: "sheet-a",
        reference: "sheet-a#1",
        metadata: { table_id: "T1" },
      }),
      result({
        id: "b-only",
        score: 0.7,
        base_ref: "sheet-b",
        reference: "sheet-b#0",
        metadata: { table_id: "T1" },
      }),
      result({
        id: "a-high",
        score: 0.9,
        base_ref: "sheet-a",
        reference: "sheet-a#0",
        metadata: { table_id: "T1" },
      }),
    ];
    const out = diversifyResults(results, { perSectionCap: 0 });
    expect(out.map((r) => r.id).sort()).toEqual(["a-high", "b-only"]);
  });

  it("falls back to reference when base_ref is missing for the collapse key", () => {
    const results = [
      result({
        id: "x",
        score: 0.9,
        base_ref: "",
        reference: "doc-x#0",
        metadata: { table_id: "T1" },
      }),
      result({
        id: "y",
        score: 0.8,
        base_ref: "",
        reference: "doc-y#0",
        metadata: { table_id: "T1" },
      }),
    ];
    expect(diversifyResults(results, { perSectionCap: 0 })).toHaveLength(2);
  });

  it("keeps distinct tables/figures separate and never mutates inputs", () => {
    const results = [
      result({ id: "t1a", score: 0.9, metadata: { table_id: "T1" } }),
      result({ id: "t1b", score: 0.6, metadata: { table_id: "T1" } }),
      result({ id: "t2", score: 0.7, metadata: { table_id: "T2" } }),
      result({ id: "f1", score: 0.5, metadata: { figure_id: "F1" } }),
    ];
    const snapshot = JSON.stringify(results);
    const out = diversifyResults(results, { perSectionCap: 0 });
    expect(out.map((r) => r.id).sort()).toEqual(["f1", "t1a", "t2"]);
    // Inputs untouched.
    expect(JSON.stringify(results)).toBe(snapshot);
  });
});

// ─── groupResultsBySection (Requirement 13.6) ────────────────────────────────

describe("groupResultsBySection", () => {
  it("groups results by section path, ordered by best score", () => {
    const results = [
      result({ id: "a", score: 0.6, metadata: { section_path: ["A"] } }),
      result({ id: "b", score: 0.9, metadata: { section_path: ["B", "B.1"] } }),
      result({ id: "a2", score: 0.7, metadata: { section_path: ["A"] } }),
    ];
    const groups = groupResultsBySection(results);
    expect(groups).toHaveLength(2);
    // Section B has the top score (0.9) so it comes first.
    expect(groups[0]?.section_path).toBe("B / B.1");
    expect(groups[0]?.score).toBe(0.9);
    expect(groups[1]?.section_path).toBe("A");
    expect(groups[1]?.results.map((r) => r.id)).toEqual(["a", "a2"]);
  });

  it("groups pathless hits under the empty key", () => {
    const groups = groupResultsBySection([
      result({ id: "x", score: 0.5, metadata: {} }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.section_path).toBe("");
  });
});

// ─── Reranker receives context-enriched documents (Req 13.1/13.2) ────────────

describe("rerankResultsWithStatus feeds context-enriched documents", () => {
  it("sends title/section/type + content to the reranker, not raw content", async () => {
    let captured: string[] = [];
    const fakeReranker: RerankerClient = {
      async rerank(_query, documents): Promise<RerankResponse> {
        captured = documents;
        return {
          ok: true,
          result: documents.map((_d, index) => ({ index, score: 1 - index * 0.1 })),
        };
      },
    };
    const results = [
      result({
        id: "1",
        content: "Wareneingang buchen",
        title: "WMS",
        metadata: { unit_type: "chunk", section_path: ["3.2"] },
      }),
      result({
        id: "2",
        content: "Auslagerung",
        title: "WMS",
        metadata: { unit_type: "table", table_id: "T5", section_path: ["4.1"] },
      }),
    ];

    const outcome = await rerankResultsWithStatus(
      fakeReranker,
      "wie wird der wareneingang gebucht?",
      results,
      silent,
    );

    expect(outcome.applied).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain("Title: WMS");
    expect(captured[0]).toContain("Section: 3.2");
    expect(captured[0]).toContain("Type: chunk");
    expect(captured[0]).toContain("Wareneingang buchen");
    expect(captured[1]).toContain("Type: table");
    expect(captured[1]).toContain("Section: 4.1");
  });

  it("falls back cleanly when the reranker fails (context change is transparent)", async () => {
    const failing: RerankerClient = {
      async rerank(): Promise<RerankResponse> {
        return {
          ok: false,
          error: { code: "RERANK_UNREACHABLE", message: "down" },
        };
      },
    };
    const results = [result({ id: "1" }), result({ id: "2" })];
    const outcome = await rerankResultsWithStatus(failing, "q", results, silent);
    expect(outcome.applied).toBe(false);
    expect(outcome.fallbackReason).toBe("failed");
    expect(outcome.results).toBe(results);
  });
});

// ─── groupResultsV2 (group_by: document | section, Requirement 13.6) ─────────
describe("groupResultsV2", () => {
  const unit = (id: string, score: number, page: number, section: string | null, baseRef = "doc"): SearchResult =>
    result({
      id,
      score,
      base_ref: baseRef,
      reference: `${baseRef}#${id}`,
      content: `content-${id}`,
      metadata: {
        unit_id: `u-${id}`,
        page_start: page,
        ...(section ? { section_id: section, section_path: [section] } : {}),
      },
    });

  it("none returns the input unchanged", () => {
    const input = [unit("a", 0.9, 1, "s1")];
    expect(groupResultsV2(input, "none")).toBe(input);
  });

  it("section: merges per (document, section_id), best score, content in document order", () => {
    const grouped = groupResultsV2(
      [unit("late", 0.9, 9, "s1"), unit("other", 0.8, 3, "s2"), unit("early", 0.5, 2, "s1")],
      "section",
    );
    expect(grouped).toHaveLength(2);
    const s1 = grouped[0];
    if (s1 === undefined) throw new Error("expected a group");
    expect(s1.score).toBe(0.9);
    // Representative = best-scoring hit; content ordered by page.
    expect(s1.id).toBe("late");
    expect(s1.content).toBe("content-early\n\ncontent-late");
    expect(s1.group).toEqual({ by: "section", key: "s1", count: 2, unit_ids: ["u-early", "u-late"] });
    expect(grouped[1]?.group?.key).toBe("s2");
  });

  it("section: the same section id in two documents never merges; sectionless hits stay solo", () => {
    const grouped = groupResultsV2(
      [unit("a", 0.9, 1, "s1", "doc-a"), unit("b", 0.8, 1, "s1", "doc-b"), unit("c", 0.7, 1, null), unit("d", 0.6, 2, null)],
      "section",
    );
    expect(grouped).toHaveLength(4);
    expect(grouped.every((g) => g.group?.count === 1)).toBe(true);
  });

  it("document: merges per base_ref and orders groups by best score", () => {
    const grouped = groupResultsV2(
      [unit("a2", 0.4, 5, "s1", "doc-a"), unit("b1", 0.7, 1, "s1", "doc-b"), unit("a1", 0.6, 1, "s2", "doc-a")],
      "document",
    );
    expect(grouped.map((g) => g.base_ref)).toEqual(["doc-b", "doc-a"]);
    expect(grouped[1]?.content).toBe("content-a1\n\ncontent-a2");
    expect(grouped[1]?.score).toBe(0.6);
    expect(grouped[1]?.group).toMatchObject({ by: "document", key: "doc-a", count: 2 });
  });

  it("never mutates its inputs", () => {
    const a = unit("a", 0.9, 2, "s1");
    const b = unit("b", 0.5, 1, "s1");
    const snapshot = JSON.stringify([a, b]);
    groupResultsV2([a, b], "section");
    expect(JSON.stringify([a, b])).toBe(snapshot);
  });
});

// ─── fitRerankInputs (tokenizer-aware cap, Requirement 13.2) ─────────────────
describe("fitRerankInputs", () => {
  /** A fake tokenizer: 1 token per 2 chars (denser than the 4-chars heuristic). */
  const denseCounter = (): TokenCounter & { calls: number } => {
    const c = {
      calls: 0,
      cacheSize: 0,
      async count(text: string) {
        return Math.ceil(text.length / 2);
      },
      async countBatch(texts: string[]) {
        c.calls++;
        return texts.map((t) => Math.ceil(t.length / 2));
      },
    };
    return c;
  };

  it("returns the input unchanged without a counter", async () => {
    const input = [result({ content: "x".repeat(10_000) })];
    expect(await fitRerankInputs(input, null)).toBe(input);
  });

  it("trims content so the rerank document fits the measured token budget", async () => {
    const counter = denseCounter();
    const long = result({ id: "long", title: "T", content: "y".repeat(10_000), metadata: { unit_type: "chunk" } });
    const short = result({ id: "short", content: "kurz" });
    const fitted = await fitRerankInputs([long, short], counter, 100);
    const doc = buildRerankDocument(fitted[0] ?? long, 100);
    expect(Math.ceil(doc.length / 2)).toBeLessThanOrEqual(100);
    // Header survives; only content shrinks. Short docs are the same object.
    expect(doc.startsWith("Title: T")).toBe(true);
    expect(fitted[1]).toBe(short);
    expect(fitted[0]?.id).toBe("long");
    // Input never mutated.
    expect(long.content.length).toBe(10_000);
  });

  it("keeps the heuristic-capped input when the counter fails", async () => {
    const failing: TokenCounter = {
      cacheSize: 0,
      count: async () => 0,
      countBatch: async () => {
        throw new Error("tokenize down");
      },
    };
    const input = [result({ content: "z".repeat(10_000) })];
    const fitted = await fitRerankInputs(input, failing, 100);
    expect(fitted[0]).toBe(input[0]);
  });
});

// ─── applyMinScore (task 6.10, Requirement 4.8) ──────────────────────────────

describe("applyMinScore", () => {
  const rerankAt = (value: number) => ({ value, kind: "rerank" as const });

  it("passes results through untouched when there is no threshold", () => {
    const input = [result({ score: 0.1 }), result({ score: 0.9 })];
    for (const threshold of [null, undefined]) {
      const outcome = applyMinScore(input, threshold, "rerank");
      expect(outcome.results).toBe(input);
      expect(outcome.abstention).toBeUndefined();
    }
  });

  it("keeps results at or above the threshold on the matching scale", () => {
    const input = [
      result({ id: "a", score: 0.9 }),
      result({ id: "b", score: 0.75 }),
      result({ id: "c", score: 0.74 }),
    ];
    const outcome = applyMinScore(input, rerankAt(0.75), "rerank");
    expect(outcome.results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(outcome.abstention).toEqual({
      threshold: 0.75,
      score_kind: "rerank",
      score_scale: "rerank",
      threshold_scale: "rerank",
      candidates: 3,
      kept: 2,
      abstain: false,
    });
  });

  it("abstains when every result falls below the threshold", () => {
    const input = [result({ score: 0.5 }), result({ score: 0.4 })];
    const outcome = applyMinScore(input, { value: 0.6, kind: "cosine" }, "cosine");
    expect(outcome.results).toEqual([]);
    expect(outcome.abstention).toMatchObject({ abstain: true, kept: 0, candidates: 2, score_kind: "retrieval" });
  });

  it("skips a threshold set for another scale instead of filtering on it", () => {
    // MIN_RERANK_SCORE=0.3 against RRF scores (≈0.016) would drop everything.
    const input = [result({ id: "a", score: 0.0164 }), result({ id: "b", score: 0.0159 })];
    for (const scale of ["rrf", "cosine", "fts"] as const) {
      const outcome = applyMinScore(input, rerankAt(0.3), scale);
      expect(outcome.results).toBe(input);
      expect(outcome.abstention).toEqual({
        threshold: 0.3,
        score_kind: "retrieval",
        score_scale: scale,
        threshold_scale: "rerank",
        skipped: "scale_mismatch",
        candidates: 2,
        kept: 2,
        abstain: false,
      });
    }
  });

  it("emits an abstention signal for an empty candidate list", () => {
    const outcome = applyMinScore([], rerankAt(0.5), "rerank");
    expect(outcome.results).toEqual([]);
    expect(outcome.abstention).toMatchObject({ candidates: 0, kept: 0, abstain: true });
  });
});

describe("retrievalScoreKind", () => {
  it("names the scale of each search mode", () => {
    expect(retrievalScoreKind({ ftsOnly: true, hybrid: false })).toBe("fts");
    expect(retrievalScoreKind({ ftsOnly: false, hybrid: true })).toBe("rrf");
    expect(retrievalScoreKind({ ftsOnly: false, hybrid: false })).toBe("cosine");
  });
});
