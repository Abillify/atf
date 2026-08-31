// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit test for the unified, document-stable [n] citation numbering
 * (`buildGroundingSections`, src/graph/rag-grounding.ts) — the logic behind the
 * `tool` node's grounding block.
 *
 * Proves that:
 *   - `get_summaries` documents become citation objects (every akte document is
 *     a citable source [n]);
 *   - the COLLECTION OVERVIEW and RELEVANT PASSAGES share ONE numbering keyed
 *     by the document `base_ref`, so a document in both carries the SAME [n];
 *   - the emitted citation order is overview order (position i == [i+1]), with
 *     a search score merged over a summary's 0;
 *   - a search-only input (no summaries) falls back to score-desc order.
 */

import { describe, test, expect } from "bun:test";
import { buildGroundingSections, buildCitationEntries } from "../rag-grounding.js";
import type { RagChunk, RagSummary } from "../reranker.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

function summary(reference: string, title: string, text: string): RagSummary {
  return { reference, title, url: "", summary: text };
}

function chunk(baseRef: string, title: string, content: string, score: number): RagChunk {
  return { id: baseRef, title, url: "", content, retrievalScore: score, baseRef };
}

describe("buildGroundingSections — unified [n] numbering", () => {
  test("search + summaries share ONE document-stable numbering", () => {
    const summaries = [
      summary("/akte/A", "Doc A", "Summary A"),
      summary("/akte/B", "Doc B", "Summary B"),
      summary("/akte/C", "Doc C", "Summary C"),
    ];
    // Search hits on B (0.9) and A (0.5) — same documents as the overview.
    const chunks = [
      chunk("/akte/B", "Doc B", "Passage from B.", 0.9),
      chunk("/akte/A", "Doc A", "Passage from A.", 0.5),
    ];

    const { orderedCitations, sections } = buildGroundingSections(
      chunks,
      summaries,
      3,
    );

    // Every summarised document is a citation, in overview (path) order.
    expect(orderedCitations.map((c) => c.title)).toEqual([
      "Doc A",
      "Doc B",
      "Doc C",
    ]);
    // Position i is citation [i+1]; Doc B's score is the search score (0.9)
    // merged over the summary's 0.
    expect(at(orderedCitations, 0).similarity_score).toBeCloseTo(0.5, 5); // A
    expect(at(orderedCitations, 1).similarity_score).toBeCloseTo(0.9, 5); // B
    expect(at(orderedCitations, 2).similarity_score).toBe(0); // C (summary only)

    const text = sections.join("\n\n---\n\n");
    // Overview numbered in path order.
    expect(text).toContain("[1] Doc A (Ref: /akte/A)");
    expect(text).toContain("[2] Doc B (Ref: /akte/B)");
    expect(text).toContain("[3] Doc C (Ref: /akte/C)");

    // Passages carry the SAME [n] as the overview (document-stable, base_ref).
    const passages = text.slice(text.indexOf("RELEVANT PASSAGES"));
    expect(passages).toContain("[2] Doc B");
    expect(passages).toContain("[1] Doc A");
    // Doc C has no passage (summary only) — not in the passages section.
    expect(passages).not.toContain("Doc C");
    // Passages displayed most-relevant-first: B (0.9) before A (0.5).
    expect(passages.indexOf("[2] Doc B")).toBeLessThan(
      passages.indexOf("[1] Doc A"),
    );
  });

  test("pagination-capped overview reports the true total and offset", () => {
    const summaries = [summary("/akte/A", "Doc A", "Summary A")];
    const { sections } = buildGroundingSections([], summaries, 329);
    const overview = at(sections, 0);
    expect(overview).toContain("first 1 of TOTAL 329 documents");
    expect(overview).toContain("offset=1");
  });

  test("search-only input (no summaries) falls back to score-desc [n]", () => {
    const chunks = [
      chunk("/akte/A", "Doc A", "Passage A.", 0.5),
      chunk("/akte/B", "Doc B", "Passage B.", 0.9),
    ];
    const { orderedCitations, sections } = buildGroundingSections(chunks, [], 0);

    // Score-desc: Doc B (0.9) is [1], Doc A (0.5) is [2].
    expect(orderedCitations.map((c) => c.title)).toEqual(["Doc B", "Doc A"]);
    // No overview section — only the passages section is produced.
    expect(sections).toHaveLength(1);
    const text = at(sections, 0);
    expect(text).not.toContain("COLLECTION OVERVIEW —");
    const passages = text.slice(text.indexOf("RELEVANT PASSAGES"));
    expect(passages.indexOf("[1] Doc B")).toBeLessThan(
      passages.indexOf("[2] Doc A"),
    );
  });

  test("empty input yields no citations and no sections", () => {
    const { orderedCitations, orderedKeys, sections } = buildGroundingSections(
      [],
      [],
      0,
    );
    expect(orderedCitations).toHaveLength(0);
    expect(orderedKeys).toHaveLength(0);
    expect(sections).toHaveLength(0);
  });

  test("orderedKeys align 1:1 with orderedCitations (base_ref keys)", () => {
    const summaries = [
      summary("/akte/A", "Doc A", "Summary A"),
      summary("/akte/B", "Doc B", "Summary B"),
    ];
    const chunks = [chunk("/akte/B", "Doc B", "Passage B.", 0.9)];
    const { orderedKeys, orderedCitations } = buildGroundingSections(
      chunks,
      summaries,
      2,
    );
    expect(orderedKeys).toEqual(["/akte/A", "/akte/B"]);
    expect(orderedCitations).toHaveLength(2);
  });
});

describe("buildCitationEntries", () => {
  test("merges a search hit into its summary entry by base_ref (one [n])", () => {
    const entries = buildCitationEntries(
      [chunk("/akte/A", "Doc A", "Passage A.", 0.8)],
      [summary("/akte/A", "Doc A", "Summary A")],
    );
    // Same document → ONE entry, keyed by base_ref, score from the search hit.
    expect(entries).toHaveLength(1);
    expect(at(entries, 0).key).toBe("/akte/A");
    expect(at(entries, 0).citation.similarity_score).toBeCloseTo(0.8, 5);
  });

  test("adds chapter breadcrumbs to display titles while root references stay plain", () => {
    const summaryRef =
      "ExampleCorp - Multiple Documents.pdf/5. Specification/3. 5.3 IT Specification/2. 5.3.2 Requirements";
    const searchRef =
      "Search.pdf/5. Specification/3. 5.3 IT Specification/2. 5.3.2 Requirements";
    const entries = buildCitationEntries(
      [chunk(searchRef, "Search.pdf", "Search passage.", 0.9)],
      [
        summary(summaryRef, "ExampleCorp - Multiple Documents.pdf", "Summary"),
        summary("/examplecorp/Root.pdf", "Root.pdf", "Root summary"),
      ],
    );

    expect(at(entries, 0).citation.title).toBe(
      "ExampleCorp - Multiple Documents.pdf",
    );
    expect(at(entries, 0).citation.displayTitle).toBe(
      "ExampleCorp - Multiple Documents.pdf — 5. Specification › 3. 5.3 IT Specification › 2. 5.3.2 Requirements",
    );
    expect(at(entries, 1).citation.displayTitle).toBe("Root.pdf");
    expect(at(entries, 2).citation.displayTitle).toBe(
      "Search.pdf — 5. Specification › 3. 5.3 IT Specification › 2. 5.3.2 Requirements",
    );
  });

  test("summaries lead, search-only hits append", () => {
    const entries = buildCitationEntries(
      [chunk("/akte/Z", "Doc Z", "Passage Z.", 0.9)],
      [summary("/akte/A", "Doc A", "Summary A")],
    );
    expect(entries.map((e) => e.key)).toEqual(["/akte/A", "/akte/Z"]);
  });
});

describe("buildGroundingSections — overview stays under the prompt budget", () => {
  // OVERVIEW_CHAR_BUDGET is 40_000 chars in rag-grounding.ts.
  const OVERVIEW_CHAR_BUDGET = 40_000;

  function bigSummaries(n: number): RagSummary[] {
    const body = "Synthetische Zusammenfassung mit Beispieldaten. ".repeat(10);
    return Array.from({ length: n }, (_, i) =>
      summary(
        `/ExampleRecords/Records Part 1/Quality Records/` +
          `CASE-001_Alice Example_Correspondence/CASE-001-${i}-long-reference.pdf`,
        `CASE-001-${i}-long-reference.pdf`,
        body,
      ),
    );
  }

  test("bounds the injected overview and points to pagination for the rest (329 docs)", () => {
    const summaries = bigSummaries(329);
    const { sections, orderedCitations } = buildGroundingSections(
      [],
      summaries,
      329,
    );
    const overviewSection = at(sections, 0);

    // The overview text must stay bounded (budget + a small header allowance),
    // NOT scale with the 329 documents.
    expect(overviewSection.length).toBeLessThan(OVERVIEW_CHAR_BUDGET + 2_000);

    // It must be flagged as truncated and instruct pagination via offset.
    expect(overviewSection).toContain("TRUNCATED");
    expect(overviewSection).toMatch(/offset=\d+/);

    // Truncating the inline overview must NOT drop citations: every document
    // remains a citable source [n] (independent of what is shown inline).
    expect(orderedCitations).toHaveLength(329);
  });

  test("lists all documents (no pagination note) when everything fits the budget", () => {
    const summaries = bigSummaries(5);
    const { sections } = buildGroundingSections([], summaries, 5);
    const overviewSection = at(sections, 0);
    expect(overviewSection).toContain("ALL 5 recorded");
    expect(overviewSection).not.toContain("TRUNCATED");
  });
});
