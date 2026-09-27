// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for removing page markers and separators from the indexing body while
 * keeping the page ranges intact (defect D6, Requirement 2.3).
 *
 * The page number lives in the `## Seite N` marker, so the page spans MUST be
 * built from the marked-up body first. Stripping the markers then shifts every
 * following character to the left; stripPageMarkers rebuilds an offset mapping
 * so a chunk's char range still resolves to the correct page via pagesForRange.
 *
 * The chunker separately must not treat `## Seite N` as a heading boundary:
 * page markers are pagination furniture, not document structure.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  extractPageSpans,
  normalizeDocumentStructure,
  pagesForRange,
  stripPageMarkers,
} from "../src/document-structure.js";
import { getHeadingLevel, findHeadings } from "../src/chunker.js";

/** Build a Markdown body of `pageCount` pages with a page marker + separator. */
function buildPagedBody(pageCount: number): string {
  const pages: string[] = [];
  for (let page = 1; page <= pageCount; page++) {
    pages.push(
      [`## Seite ${page}`, "", `Inhalt von Seite ${page} mit Fließtext.`].join(
        "\n",
      ),
    );
  }
  return pages.join("\n\n---\n\n");
}

describe("stripPageMarkers", () => {
  it("removes `## Seite N` markers and `---` separators from the body", () => {
    const body = buildPagedBody(3);
    const { content } = stripPageMarkers(body, extractPageSpans(body));
    expect(content).not.toMatch(/##\s+Seite\s+\d+/);
    expect(content).not.toMatch(/^\s*-{3,}\s*$/m);
    // The page text itself survives.
    for (let page = 1; page <= 3; page++) {
      expect(content).toContain(`Inhalt von Seite ${page}`);
    }
  });

  it("keeps every page's char range resolving to the right page after stripping", () => {
    const body = buildPagedBody(4);
    const { content, spans } = stripPageMarkers(body, extractPageSpans(body));
    // Each page's text still maps back to its own page number via the remapped
    // spans — the offset mapping stayed consistent with the stripped body.
    for (let page = 1; page <= 4; page++) {
      const needle = `Inhalt von Seite ${page}`;
      const at = content.indexOf(needle);
      expect(at).toBeGreaterThanOrEqual(0);
      const { pageStart, pageEnd } = pagesForRange(spans, at, at + needle.length);
      expect(pageStart).toBe(page);
      expect(pageEnd).toBe(page);
    }
  });

  it("leaves a body without page markers unchanged apart from whitespace trim", () => {
    const body = "Nur Fließtext ohne Seitenmarker.";
    const { content, spans } = stripPageMarkers(body, extractPageSpans(body));
    expect(content).toBe(body);
    expect(spans).toEqual([]);
  });

  it("does not remove a `---` that sits inside a single page's prose", () => {
    const body = ["## Seite 1", "", "Vorher --- nachher in einer Zeile."].join(
      "\n",
    );
    const { content } = stripPageMarkers(body, extractPageSpans(body));
    expect(content).toContain("Vorher --- nachher");
  });

  it("keeps setext underlines and horizontal rules inside a page", () => {
    const body = [
      "## Seite 1",
      "",
      "Kapitel Eins",
      "---",
      "",
      "Absatz A.",
      "",
      "---",
      "",
      "Absatz B.",
      "",
      "---",
      "",
      "## Seite 2",
      "",
      "Zweite Seite.",
    ].join("\n");
    const { content, spans } = stripPageMarkers(body, extractPageSpans(body));
    // Setext underline directly under its heading line survives.
    expect(content).toContain("Kapitel Eins\n---\n\nAbsatz A.");
    // The in-page horizontal rule survives; only the page separator goes.
    expect(content).toContain("Absatz A.\n\n---\n\nAbsatz B.");
    expect(content).toContain("Absatz B.\n\nZweite Seite.");
    const at = content.indexOf("Absatz B.");
    expect(pagesForRange(spans, at, at + 9)).toEqual({ pageStart: 1, pageEnd: 1 });
    const second = content.indexOf("Zweite Seite.");
    expect(pagesForRange(spans, second, second + 5)).toEqual({
      pageStart: 2,
      pageEnd: 2,
    });
  });

  it("keeps a trailing horizontal rule before the page separator", () => {
    const body = "## Seite 1\n\nText.\n\n---\n\n---\n\n## Seite 2\n\nMehr.";
    const { content } = stripPageMarkers(body, extractPageSpans(body));
    expect(content).toBe("Text.\n\n---\n\nMehr.");
  });

  it("assigns pages that start with a table delimiter row correctly", () => {
    // Extra blank lines force the whitespace collapse path (the former anchor
    // search replaced `---` with spaces and missed `|---|` lines).
    const body = [
      "## Seite 1",
      "",
      "",
      "",
      "Einleitung.",
      "",
      "",
      "",
      "---",
      "",
      "## Seite 2",
      "",
      "|---|---|",
      "| a | b |",
      "",
      "---",
      "",
      "## Seite 3",
      "",
      "Kapitel",
      "---",
      "Text drei.",
    ].join("\n");
    const { content, spans } = stripPageMarkers(body, extractPageSpans(body));
    expect(content).toContain("|---|---|");
    expect(content).toContain("Kapitel\n---\nText drei.");
    const find = (needle: string) => {
      const at = content.indexOf(needle);
      expect(at).toBeGreaterThanOrEqual(0);
      return pagesForRange(spans, at, at + needle.length);
    };
    expect(find("Einleitung.")).toEqual({ pageStart: 1, pageEnd: 1 });
    expect(find("|---|---|")).toEqual({ pageStart: 2, pageEnd: 2 });
    expect(find("| a | b |")).toEqual({ pageStart: 2, pageEnd: 2 });
    expect(find("Kapitel")).toEqual({ pageStart: 3, pageEnd: 3 });
    expect(find("Text drei.")).toEqual({ pageStart: 3, pageEnd: 3 });
    expect(spans.at(-1)?.charEnd).toBe(content.length);
  });

  it("strips an empty page's separator and keeps a preamble", () => {
    const body = "Vorspann.\n\n## Seite 1\n\n---\n\n## Seite 2\n\nInhalt.";
    const { content, spans } = stripPageMarkers(body, extractPageSpans(body));
    expect(content).toBe("Vorspann.\n\nInhalt.");
    const at = content.indexOf("Inhalt.");
    expect(pagesForRange(spans, at, at + 7)).toEqual({ pageStart: 2, pageEnd: 2 });
    const pre = content.indexOf("Vorspann.");
    expect(pagesForRange(spans, pre, pre + 9)).toEqual({});
  });
});

describe("normalizeDocumentStructure: markers stripped from indexing body", () => {
  it("strips page markers and separators from the embedding/full-text body", () => {
    const structure = normalizeDocumentStructure(
      buildPagedBody(3),
      "specs/handbuch.pdf",
    );
    expect(structure.content).not.toMatch(/##\s+Seite\s+\d+/);
    expect(structure.content).not.toMatch(/^\s*-{3,}\s*$/m);
    expect(structure.content).toContain("Inhalt von Seite 2");
  });

  it("preserves the page ranges of every chunk-sized slice after stripping", () => {
    const structure = normalizeDocumentStructure(
      buildPagedBody(5),
      "specs/handbuch.pdf",
    );
    for (let page = 1; page <= 5; page++) {
      const needle = `Inhalt von Seite ${page}`;
      const at = structure.content.indexOf(needle);
      const { pageStart, pageEnd } = pagesForRange(
        structure.pageSpans,
        at,
        at + needle.length,
      );
      expect(pageStart).toBe(page);
      expect(pageEnd).toBe(page);
    }
  });

  it("keeps the page marker off the structure when pageMarkers is disabled", () => {
    const structure = normalizeDocumentStructure(
      buildPagedBody(2),
      "specs/handbuch.pdf",
      { pageMarkers: false },
    );
    // With pageMarkers off there are no spans; the marker text stays verbatim.
    expect(structure.pageSpans).toEqual([]);
    expect(structure.content).toContain("## Seite 1");
  });
});

describe("chunker: page markers are not heading boundaries (defect D6)", () => {
  it("does not classify `## Seite N` as a heading", () => {
    expect(getHeadingLevel("## Seite 12")).toBe(0);
    expect(getHeadingLevel("## Page 12")).toBe(0);
    expect(getHeadingLevel("# Seite 3")).toBe(0);
    expect(getHeadingLevel("## seite 7")).toBe(0);
  });

  it("still classifies real headings that merely mention a page", () => {
    expect(getHeadingLevel("## Seitenlayout")).toBe(2);
    expect(getHeadingLevel("## Seite der Anmeldung")).toBe(2);
    expect(getHeadingLevel("# Einleitung")).toBe(1);
  });

  it("skips page markers when scanning for headings", () => {
    const text = "## Seite 1\nFließtext.\n## Anmeldung\nMehr Text.";
    const headings = findHeadings(text, 0);
    // Only the real heading `## Anmeldung` is reported, not the page marker.
    expect(headings).toEqual([{ position: 22, level: 2 }]);
  });
});

describe("Property: stripping never invents or drops page numbers", () => {
  /**
   * **Validates: Requirement 2.3**
   *
   * For any paged body, stripPageMarkers keeps exactly the same set of page
   * numbers (one span per marker) and every span still resolves to its page.
   */
  it("preserves the page set and per-page resolution across page counts", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (pageCount) => {
        const body = buildPagedBody(pageCount);
        const spansBefore = extractPageSpans(body).map((s) => s.page);
        const { content, spans } = stripPageMarkers(body, extractPageSpans(body));
        expect(spans.map((s) => s.page)).toEqual(spansBefore);
        expect(content).not.toMatch(/##\s+Seite\s+\d+/);
        for (let page = 1; page <= pageCount; page++) {
          const needle = `Inhalt von Seite ${page}`;
          const at = content.indexOf(needle);
          const { pageStart } = pagesForRange(spans, at, at + needle.length);
          expect(pageStart).toBe(page);
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe("Property: in-page `---` lines never shift page assignment", () => {
  /**
   * **Validates: Requirement 2.3**
   *
   * Pages whose content contains horizontal rules, setext underlines, table
   * delimiter rows and extra blank lines keep every content line on its page,
   * and those `---` lines survive stripping.
   */
  it("maps every unique content line to its own page", () => {
    const filler = fc.constantFrom("---", "|---|---|", "", "", "Titel\n---");
    fc.assert(
      fc.property(
        fc.array(fc.array(filler, { maxLength: 4 }), { minLength: 1, maxLength: 8 }),
        (pages) => {
          const body = pages
            .map((extra, index) =>
              [`## Seite ${index + 1}`, "", ...extra, `Zeile-${index + 1}.`, ...extra].join(
                "\n",
              ),
            )
            .join("\n\n---\n\n");
          const { content, spans } = stripPageMarkers(body, extractPageSpans(body));
          pages.forEach((extra, index) => {
            const needle = `Zeile-${index + 1}.`;
            const at = content.indexOf(needle);
            expect(at).toBeGreaterThanOrEqual(0);
            expect(pagesForRange(spans, at, at + needle.length)).toEqual({
              pageStart: index + 1,
              pageEnd: index + 1,
            });
            if (extra.includes("|---|---|")) expect(content).toContain("|---|---|");
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
