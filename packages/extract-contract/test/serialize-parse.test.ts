// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  PAGE_SEPARATOR,
  buildDocumentAssetId,
  buildFigureId,
  parseDocument,
  serializeDocument,
  serializePage,
} from "../src/v1/index.js";
import { REFERENCE, document, figure, page } from "./fixtures.js";

describe("serializePage", () => {
  test("emits marker, summary, figures, body — in that order", () => {
    const output = serializePage(page(1, { figures: [figure(1, 1)] }));
    const markerAt = output.indexOf("## Seite 1");
    const summaryAt = output.indexOf("<summary>");
    const figuresAt = output.indexOf("<figures>");
    const bodyAt = output.indexOf("# Einleitung");
    expect(markerAt).toBe(0);
    expect(summaryAt).toBeGreaterThan(markerAt);
    expect(figuresAt).toBeGreaterThan(summaryAt);
    expect(bodyAt).toBeGreaterThan(figuresAt);
  });

  test("keeps the figures block before an empty body", () => {
    // A full-page diagram has no text. The figures block must still land after
    // this page's marker, or Search attributes the figure to the previous page.
    const output = serializePage(
      page(4, { markdown: "", summary: undefined, figures: [figure(4, 1)] }),
    );
    expect(output.split("\n")).toEqual([
      "## Seite 4",
      "",
      "<figures>",
      '<figure id="p4-f1" bbox="[0.1000, 0.2000, 0.6000, 0.7500]" page="4">Ablaufdiagramm p4-f1 mit einem Entscheidungspunkt.</figure>',
      "</figures>",
    ]);
    expect(output.indexOf("<figure ")).toBeGreaterThan(output.indexOf("## Seite 4"));
  });

  test("omits blocks that were switched off", () => {
    const input = page(1, {
      figures: [figure(1, 1)],
      markdown: "Text\n\n![figure_p1-f1]\n\nMehr",
    });
    const bare = serializePage(input, {
      includeSummary: false,
      includeFigures: false,
      includePlaceholders: false,
    });
    expect(bare).not.toContain("<summary>");
    expect(bare).not.toContain("<figures>");
    expect(bare).not.toContain("![figure_");
    expect(bare).toContain("Text");
    expect(bare).toContain("Mehr");
  });

  test("respects the page label", () => {
    expect(serializePage(page(2), { pageLabel: "Page" })).toStartWith("## Page 2");
  });
});

describe("serializeDocument", () => {
  test("joins pages with the separator and no trailing one", () => {
    const output = serializeDocument(document());
    expect(output.split(PAGE_SEPARATOR)).toHaveLength(2);
    expect(output.endsWith("---")).toBe(false);
    expect(output.trimEnd()).toBe(output);
  });

  test("sorts pages by number regardless of input order", () => {
    const output = serializeDocument(document({ pages: [page(3), page(1), page(2)] }));
    expect(output.indexOf("## Seite 1")).toBeLessThan(output.indexOf("## Seite 2"));
    expect(output.indexOf("## Seite 2")).toBeLessThan(output.indexOf("## Seite 3"));
  });

  test("handles a zero-page document", () => {
    expect(serializeDocument(document({ pages: [] }))).toBe("");
  });
});

describe("parseDocument", () => {
  test("recovers pages, summaries and figures", () => {
    const source = document({
      pages: [
        page(1, { figures: [figure(1, 1), figure(1, 2)] }),
        page(2, { figures: [figure(2, 1)] }),
      ],
    });
    const parsed = parseDocument(serializeDocument(source), REFERENCE);

    expect(parsed.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(parsed.pages[0]?.summary).toBe("Seite 1 beschreibt den Aufbau.");
    expect(parsed.figures.map((f) => f.id)).toEqual(["p1-f1", "p1-f2", "p2-f1"]);
    expect(parsed.figures[0]?.bbox).toEqual([0.1, 0.2, 0.6, 0.75]);
    expect(parsed.preamble).toBe("");
    expect(parsed.warnings).toEqual([]);
  });

  test("recomputes asset ids from the supplied reference", () => {
    const parsed = parseDocument(
      serializeDocument(document({ pages: [page(1, { figures: [figure(1, 1)] })] })),
      "other-reference",
    );
    expect(parsed.figures[0]?.assetId).toBe(buildDocumentAssetId("other-reference", "p1-f1"));
  });

  test("leaves the body free of structural markup", () => {
    const parsed = parseDocument(
      serializeDocument(document({ pages: [page(1, { figures: [figure(1, 1)] })] })),
      REFERENCE,
    );
    const body = parsed.pages[0]?.markdown ?? "";
    expect(body).not.toContain("<figure");
    expect(body).not.toContain("<figures");
    expect(body).not.toContain("<summary");
    expect(body).not.toContain("## Seite");
  });

  test("reports rather than throws on a truncated document", () => {
    const parsed = parseDocument("Vorspann ohne Marker\n\n## Seite 1\n\nInhalt", REFERENCE);
    expect(parsed.preamble).toBe("Vorspann ohne Marker");
    expect(parsed.warnings.join(" ")).toContain("before the first page marker");
    expect(parsed.pages).toHaveLength(1);
  });

  test("returns no pages for markerless input", () => {
    const parsed = parseDocument("Nur Text", REFERENCE);
    expect(parsed.pages).toEqual([]);
    expect(parsed.preamble).toBe("Nur Text");
  });

  test("flags a duplicated page", () => {
    const parsed = parseDocument(`## Seite 1\n\nA${PAGE_SEPARATOR}## Seite 1\n\nB`, REFERENCE);
    expect(parsed.warnings.join(" ")).toContain("Page 1 appears more than once");
  });

  test("flags a placeholder with no figure entry", () => {
    const parsed = parseDocument("## Seite 1\n\n![figure_p1-f9]\n\nText", REFERENCE);
    expect(parsed.warnings.join(" ")).toContain('references figure "p1-f9"');
  });

  test("flags a figure without a parsable bbox", () => {
    const parsed = parseDocument(
      '## Seite 1\n\n<figures>\n<figure id="p1-f1" page="1">Beschreibung</figure>\n</figures>\n\nText',
      REFERENCE,
    );
    expect(parsed.figures[0]?.bbox).toBeUndefined();
    expect(parsed.warnings.join(" ")).toContain("no parsable bbox");
  });

  test("detects the page label the document used", () => {
    expect(parseDocument("## Page 1\n\nText", REFERENCE).pageLabel).toBe("Page");
    expect(parseDocument("## Seite 1\n\nText", REFERENCE).pageLabel).toBe("Seite");
  });

  describe("legacy documents", () => {
    // The shape produced by an earlier extraction pipeline, before this contract
    // existed: figures numbered per page starting at 0, unquoted comma-separated
    // attributes, a "None" placeholder for figure-free pages, absolute pixel
    // bboxes. Parsing it is what makes an existing corpus re-ingestable.
    const legacy = [
      "## Seite 1",
      "",
      "<figures>",
      "<figure id=0, bbox=[120, 340, 480, 720]>Erstes Diagramm</figure>",
      "<figure id=1, bbox=[120, 760, 480, 900]>Zweites Diagramm</figure>",
      "</figures>",
      "",
      "Text der ersten Seite ![figure_0] und ![figure_1].",
      "",
      "---",
      "",
      "## Seite 2",
      "",
      "<figures>None</figures>",
      "",
      "Text der zweiten Seite.",
    ].join("\n");

    test("re-derives document-unique ids for per-page numbering", () => {
      const parsed = parseDocument(legacy, REFERENCE);
      // id=0 on page 1 and id=0 on another page would collide; the parser
      // rebuilds them from the page instead of trusting the legacy value.
      expect(parsed.figures.map((f) => f.id)).toEqual(["p1-f1", "p1-f2"]);
      expect(parsed.figures[0]?.assetId).toBe(buildDocumentAssetId(REFERENCE, "p1-f1"));
    });

    test("drops the None placeholder and keeps the body", () => {
      const parsed = parseDocument(legacy, REFERENCE);
      expect(parsed.pages[1]?.markdown).toBe("Text der zweiten Seite.");
      expect(parsed.pages[1]?.figures).toEqual([]);
    });

    test("keeps absolute pixel bboxes visible as out-of-range", () => {
      // Clamped to [0,1], so a legacy pixel box becomes [1,1,1,1] and fails
      // validation loudly rather than silently cropping a 1×1 pixel.
      const parsed = parseDocument(legacy, REFERENCE);
      expect(parsed.figures[0]?.bbox).toEqual([1, 1, 1, 1]);
    });
  });

  test("recovers a bare figure emitted outside the figures wrapper", () => {
    const parsed = parseDocument(
      '## Seite 1\n\n<figure id="p1-f1" bbox="[0, 0, 1, 1]" page="1">Allein</figure>\n\nText',
      REFERENCE,
    );
    expect(parsed.figures.map((f) => f.id)).toEqual(["p1-f1"]);
    expect(parsed.pages[0]?.markdown).toBe("Text");
  });

  test("keeps HTML tables in the body for Search to normalise", () => {
    const table = '<table>\n<tr><th colspan="2">Kopf</th></tr>\n<tr><td>a</td><td>b</td></tr>\n</table>';
    const parsed = parseDocument(`## Seite 1\n\n${table}`, REFERENCE);
    expect(parsed.pages[0]?.markdown).toContain("<table>");
    expect(parsed.pages[0]?.markdown).toContain('colspan="2"');
  });
});

describe("round trip", () => {
  /**
   * Body text that cannot be confused with structure. The interesting failures
   * come from content that happens to look like a marker, so those are covered
   * by validation tests instead — here the property is exact preservation.
   */
  const safeBody = fc
    .array(
      fc.stringMatching(/^[A-Za-zÄÖÜäöüß0-9 ,.;:()!?-]{1,60}$/).filter((s) => s.trim() !== ""),
      { minLength: 1, maxLength: 6 },
    )
    .map((lines) => lines.join("\n\n"));

  const safeSummary = fc
    .stringMatching(/^[A-Za-zÄÖÜäöüß0-9 ,.;:()!?-]{1,80}$/)
    .filter((s) => s.trim() !== "");

  test("serialize → parse preserves pages, bodies and summaries", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ body: safeBody, summary: safeSummary }), {
          minLength: 1,
          maxLength: 5,
        }),
        (rawPages) => {
          const pages = rawPages.map((raw, index) =>
            page(index + 1, { markdown: raw.body, summary: raw.summary }),
          );
          const source = document({ pages });
          const parsed = parseDocument(serializeDocument(source), REFERENCE);

          expect(parsed.pages).toHaveLength(pages.length);
          expect(parsed.warnings).toEqual([]);
          parsed.pages.forEach((parsedPage, index) => {
            const original = pages[index];
            if (original === undefined) throw new Error(`missing page ${index}`);
            expect(parsedPage.page).toBe(original.page);
            expect(parsedPage.markdown).toBe(original.markdown.trim());
            expect(parsedPage.summary).toBe(original.summary?.replace(/\s+/g, " ").trim());
          });
        },
      ),
      { numRuns: 60 },
    );
  });

  test("serialize → parse preserves figure identity and geometry", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            x1: fc.double({ min: 0, max: 0.4, noNaN: true }),
            y1: fc.double({ min: 0, max: 0.4, noNaN: true }),
            x2: fc.double({ min: 0.6, max: 1, noNaN: true }),
            y2: fc.double({ min: 0.6, max: 1, noNaN: true }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (boxes) => {
          const figures = boxes.map((box, index) =>
            figure(1, index + 1, {
              bbox: [
                Number.parseFloat(box.x1.toFixed(4)),
                Number.parseFloat(box.y1.toFixed(4)),
                Number.parseFloat(box.x2.toFixed(4)),
                Number.parseFloat(box.y2.toFixed(4)),
              ],
            }),
          );
          const source = document({ pages: [page(1, { figures })] });
          const parsed = parseDocument(serializeDocument(source), REFERENCE);

          expect(parsed.figures.map((f) => f.id)).toEqual(
            figures.map((_, index) => buildFigureId(1, index + 1)),
          );
          parsed.figures.forEach((parsedFigure, index) => {
            const original = figures[index];
            if (original === undefined) throw new Error(`missing figure ${index}`);
            expect(parsedFigure.bbox).toEqual(original.bbox);
            expect(parsedFigure.assetId).toBe(original.assetId);
            expect(parsedFigure.page).toBe(1);
          });
        },
      ),
      { numRuns: 60 },
    );
  });
});
