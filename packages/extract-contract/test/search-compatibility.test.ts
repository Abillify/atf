// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The contract is only worth anything if the consumer actually understands it.
 *
 * These tests run serialized output through Search's real parser
 * (`apps/search/src/document-structure.ts`) rather than a local reimplementation
 * of it, and assert the four things that silently degrade an index when they go
 * wrong:
 *
 *   1. page markers become page spans, so chunks are citable;
 *   2. figure ids survive Search's normalisation *unrenamed*, so an uploaded
 *      crop stays bound to the chunk that references it;
 *   3. asset ids computed here equal the ones Search derives;
 *   4. HTML tables reach Search with their merged cells intact.
 *
 * Both pipelines this contract replaces failed at least one of these, and every
 * failure was invisible in the conversion output.
 */

import { describe, expect, test } from "bun:test";
import {
  normalizeDocumentStructure,
  pagesForRange,
} from "../../../apps/search/src/document-structure.js";
import {
  buildDocumentAssetId,
  collectFigures,
  serializeDocument,
} from "../src/v1/index.js";
import { REFERENCE, document, figure, page } from "./fixtures.js";

function structuredDocument() {
  return document({
    pages: [
      page(1, {
        markdown: "# Einleitung\n\nGerät auspacken.\n\n![figure_p1-f1]",
        summary: "Seite 1 beschreibt die Einleitung.",
        figures: [figure(1, 1, { description: "Ablaufdiagramm der Inbetriebnahme." })],
      }),
      page(2, {
        markdown: "## Aufbau\n\nText ohne Abbildung.",
        summary: "Seite 2 beschreibt den Aufbau.",
      }),
      page(3, {
        markdown: "![figure_p3-f1]\n\n![figure_p3-f2]",
        summary: "Seite 3 zeigt zwei Diagramme.",
        figures: [
          figure(3, 1, { description: "Erstes Diagramm.", bbox: [0.05, 0.1, 0.45, 0.4] }),
          figure(3, 2, { description: "Zweites Diagramm.", bbox: [0.55, 0.1, 0.95, 0.4] }),
        ],
      }),
    ],
  });
}

describe("Search parses the canonical form", () => {
  const source = structuredDocument();
  const markdown = serializeDocument(source);
  const parsed = normalizeDocumentStructure(markdown, REFERENCE);

  test("recovers one page span per page, in order", () => {
    expect(parsed.pageSpans.map((span) => span.page)).toEqual([1, 2, 3]);
  });

  test("maps a character range back to the right page", () => {
    const secondSpan = parsed.pageSpans[1];
    expect(secondSpan).toBeDefined();
    if (secondSpan === undefined) return;
    expect(pagesForRange(parsed.pageSpans, secondSpan.charStart, secondSpan.charEnd - 1)).toEqual({
      pageStart: 2,
      pageEnd: 2,
    });
    // A chunk that straddles a page boundary reports both ends.
    const firstSpan = parsed.pageSpans[0];
    expect(firstSpan).toBeDefined();
    if (firstSpan === undefined) return;
    expect(
      pagesForRange(parsed.pageSpans, firstSpan.charEnd - 1, secondSpan.charEnd - 1),
    ).toEqual({ pageStart: 1, pageEnd: 2 });
  });

  test("keeps every figure id exactly as emitted", () => {
    // The regression this guards: per-page ids restarting at 0 made Search
    // rename collisions to "0-2"/"0-3", which orphaned the uploaded crop.
    expect(parsed.figures.map((f) => f.id)).toEqual(["p1-f1", "p3-f1", "p3-f2"]);
  });

  test("derives the same asset ids the producer uploads under", () => {
    const produced = collectFigures(source);
    expect(parsed.figures.map((f) => f.assetId)).toEqual(produced.map((f) => f.assetId));
    for (const parsedFigure of parsed.figures) {
      expect(parsedFigure.assetId).toBe(buildDocumentAssetId(REFERENCE, parsedFigure.id));
    }
  });

  test("attributes each figure to the page it was serialized under", () => {
    expect(parsed.figures.map((f) => f.page)).toEqual([1, 3, 3]);
  });

  test("recovers figure geometry", () => {
    expect(parsed.figures[0]?.bbox).toEqual([0.1, 0.2, 0.6, 0.75]);
    expect(parsed.figures[1]?.bbox).toEqual([0.05, 0.1, 0.45, 0.4]);
    expect(parsed.figures[2]?.bbox).toEqual([0.55, 0.1, 0.95, 0.4]);
  });

  test("recovers figure descriptions as retrievable text", () => {
    expect(parsed.figures.map((f) => f.description)).toEqual([
      "Ablaufdiagramm der Inbetriebnahme.",
      "Erstes Diagramm.",
      "Zweites Diagramm.",
    ]);
  });

  test("attributes each page summary to its own page (defect D1)", () => {
    // Search no longer concatenates every <summary> into one document-wide
    // chain and prepends it to every chunk (defect D1). Each summary is bound
    // to the page whose marker precedes it, so a chunk carries only the context
    // of the pages it covers. The document-level `embeddedSummary` fallback is
    // therefore empty here — no summary sat before the first page marker.
    expect(parsed.embeddedSummary).toBeUndefined();
    expect(parsed.pageSummaries.get(1)).toBe("Seite 1 beschreibt die Einleitung.");
    expect(parsed.pageSummaries.get(2)).toBe("Seite 2 beschreibt den Aufbau.");
    expect(parsed.pageSummaries.get(3)).toBe("Seite 3 zeigt zwei Diagramme.");
  });

  test("leaves no structural markup in the indexed body", () => {
    expect(parsed.content).not.toContain("<figure");
    expect(parsed.content).not.toContain("<figures");
    expect(parsed.content).not.toContain("<summary");
    expect(parsed.content).not.toContain("![figure_");
  });

  test("keeps the body text but strips the page markers (Requirement 2.3)", () => {
    // The body text of every page survives into the indexed content…
    expect(parsed.content).toContain("Gerät auspacken.");
    expect(parsed.content).toContain("Text ohne Abbildung.");
    // …but the `## Seite N` markers and `---` separators are removed from the
    // embedding/full-text body (Requirement 2.3). The page numbers they carried
    // live on in the page spans instead, which the span test above pins.
    expect(parsed.content).not.toMatch(/##\s+Seite\s+\d+/);
    expect(parsed.content).not.toMatch(/^\s*-{3,}\s*$/m);
  });
});

describe("Search normalises HTML tables from the canonical form", () => {
  test("expands merged cells into a rectangular Markdown table", () => {
    // Emitting a pipe table directly would throw the rowspan away before Search
    // ever sees it, so the contract carries HTML and lets Search expand it.
    const table = [
      "<table>",
      '<tr><th rowspan="2">Merkmal</th><th>Einheit</th></tr>',
      "<tr><th>Bereich</th></tr>",
      "<tr><td>Länge</td><td>mm</td></tr>",
      "</table>",
    ].join("\n");
    const source = document({ pages: [page(1, { markdown: table, summary: undefined })] });
    const parsed = normalizeDocumentStructure(serializeDocument(source), REFERENCE);

    expect(parsed.content).not.toContain("<table");
    expect(parsed.content).toContain("| Merkmal | Einheit |");
    expect(parsed.content).toContain("| --- | --- |");
    // The rowspan cell is repeated into the row it spans into.
    expect(parsed.content).toContain("| Merkmal | Bereich |");
    expect(parsed.content).toContain("| Länge | mm |");
  });
});

describe("structure flags Search honours", () => {
  const source = structuredDocument();
  const markdown = serializeDocument(source);

  test("figureChunks off drops the entries but keeps the body", () => {
    const parsed = normalizeDocumentStructure(markdown, REFERENCE, { figureChunks: false });
    expect(parsed.figures).toEqual([]);
    expect(parsed.content).toContain("Gerät auspacken.");
  });

  test("pageMarkers off drops the spans", () => {
    const parsed = normalizeDocumentStructure(markdown, REFERENCE, { pageMarkers: false });
    expect(parsed.pageSpans).toEqual([]);
  });

  test("normalizeTables off leaves the HTML in place", () => {
    const source2 = document({
      pages: [page(1, { markdown: "<table><tr><td>a</td></tr></table>", summary: undefined })],
    });
    const parsed = normalizeDocumentStructure(serializeDocument(source2), REFERENCE, {
      normalizeTables: false,
    });
    expect(parsed.content).toContain("<table>");
  });
});

describe("a full-page diagram still lands on its own page", () => {
  test("figures block before an empty body keeps the page attribution", () => {
    // Serializing figures after the body would attribute this figure to page 1,
    // because Search looks backwards for the nearest page marker.
    const source = document({
      pages: [
        page(1, { markdown: "Nur Text auf Seite 1.", summary: undefined }),
        page(2, { markdown: "", summary: undefined, figures: [figure(2, 1)] }),
      ],
    });
    const parsed = normalizeDocumentStructure(serializeDocument(source), REFERENCE);
    expect(parsed.figures).toHaveLength(1);
    expect(parsed.figures[0]?.page).toBe(2);
    expect(parsed.figures[0]?.id).toBe("p2-f1");
  });
});
