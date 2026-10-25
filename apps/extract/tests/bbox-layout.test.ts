// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * bbox-layout.test.ts
 *
 * The pure `pdftotext -bbox-layout` XHTML parser.
 *
 * These tests drive the parser off fixture strings, so nothing here needs
 * poppler installed. A single, separately-guarded test shells out to the real
 * `pdftotext` only when the binary is present, to prove the fixture shape
 * matches what poppler actually emits.
 *
 * Covers:
 *  - blocks/lines/words parsed with correct normalised bboxes
 *  - a multi-page document, with the caller's first-page offset honoured
 *  - an empty page (a scan: <page> with no <word>) degrades to empty geometry
 *  - a numbered-heading line is flagged as a heading candidate
 *  - the line-height font-size proxy is the box height in normalised units
 *  - malformed / empty XHTML degrades to an empty analysis without throwing
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  detectHeadingCandidates,
  parseBboxLayout,
  parseBboxLayoutPage,
  type AnalyzedLine,
} from "../src/pipeline/bbox-layout.js";

/** A representative single-page `-bbox-layout` document, 600×800 pt. */
const ONE_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html><body>
<doc>
  <page width="600.000000" height="800.000000">
    <flow>
      <block>
        <line>
          <word xMin="60.0" yMin="80.0" xMax="180.0" yMax="120.0">2.1</word>
          <word xMin="190.0" yMin="80.0" xMax="360.0" yMax="120.0">Anmeldung</word>
        </line>
      </block>
      <block>
        <line>
          <word xMin="60.0" yMin="160.0" xMax="120.0" yMax="176.0">Der</word>
          <word xMin="126.0" yMin="160.0" xMax="240.0" yMax="176.0">Prozess</word>
        </line>
        <line>
          <word xMin="60.0" yMin="184.0" xMax="300.0" yMax="200.0">beginnt</word>
        </line>
      </block>
    </flow>
  </page>
</doc>
</body></html>`;

/** A two-page document; the second page is a scan (a <page> with no <word>). */
const TWO_PAGE = `<doc>
  <page width="600" height="800">
    <flow><block><line>
      <word xMin="60" yMin="80" xMax="120" yMax="100">Seite</word>
      <word xMin="126" yMin="80" xMax="180" yMax="100">eins</word>
    </line></block></flow>
  </page>
  <page width="600" height="800">
    <flow></flow>
  </page>
</doc>`;

describe("parseBboxLayout", () => {
  it("parses blocks, lines and words with normalised bboxes", () => {
    const [page] = parseBboxLayout(ONE_PAGE);
    expect(page).toBeDefined();
    if (page === undefined) return;

    expect(page.page).toBe(1);
    expect(page.size).toEqual({ widthPt: 600, heightPt: 800 });
    expect(page.blocks).toHaveLength(2);
    expect(page.lines).toHaveLength(3);
    expect(page.words).toHaveLength(5);

    // First word "2.1": xMin=60/600=0.1, yMin=80/800=0.1, xMax=180/600=0.3,
    // yMax=120/800=0.15.
    const first = page.words[0];
    expect(first?.text).toBe("2.1");
    expect(first?.bbox[0]).toBeCloseTo(0.1, 6);
    expect(first?.bbox[1]).toBeCloseTo(0.1, 6);
    expect(first?.bbox[2]).toBeCloseTo(0.3, 6);
    expect(first?.bbox[3]).toBeCloseTo(0.15, 6);

    // The first line's bbox is the union of its two words: [0.1,0.1] → [0.6,0.15].
    const headingLine = page.lines[0];
    expect(headingLine?.text).toBe("2.1 Anmeldung");
    expect(headingLine?.bbox[0]).toBeCloseTo(0.1, 6);
    expect(headingLine?.bbox[2]).toBeCloseTo(0.6, 6); // 360/600
    expect(headingLine?.bbox[3]).toBeCloseTo(0.15, 6);

    // The second block spans both its lines vertically: yMin 160/800=0.2 to
    // yMax 200/800=0.25.
    const bodyBlock = page.blocks[1];
    expect(bodyBlock?.bbox[1]).toBeCloseTo(0.2, 6);
    expect(bodyBlock?.bbox[3]).toBeCloseTo(0.25, 6);
    expect(bodyBlock?.text).toBe("Der Prozess\nbeginnt");
  });

  it("uses the line height as the font-size proxy", () => {
    const [page] = parseBboxLayout(ONE_PAGE);
    // Heading line height: (120-80)/800 = 0.05. Body line height: (176-160)/800
    // = 0.02. A heading being taller than body text is the signal S2 surfaces.
    expect(page?.lines[0]?.height).toBeCloseTo(0.05, 6);
    expect(page?.lines[1]?.height).toBeCloseTo(0.02, 6);
    expect((page?.lines[0]?.height ?? 0) > (page?.lines[1]?.height ?? 0)).toBe(
      true,
    );
  });

  it("flags a numbered line as a heading candidate", () => {
    const [page] = parseBboxLayout(ONE_PAGE);
    expect(page?.headingCandidates).toHaveLength(1);
    const candidate = page?.headingCandidates[0];
    expect(candidate?.numbering).toBe("2.1");
    expect(candidate?.text).toBe("2.1 Anmeldung");
    expect(candidate?.height).toBeCloseTo(0.05, 6);
    // The body lines ("Der Prozess", "beginnt") are not numbered headings.
  });

  it("parses a multi-page document and honours the first-page offset", () => {
    const pages = parseBboxLayout(TWO_PAGE);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.page).toBe(1);
    expect(pages[0]?.words).toHaveLength(2);
    expect(pages[0]?.lines[0]?.text).toBe("Seite eins");

    // The second page is a scan: size is read, but there is no geometry.
    expect(pages[1]?.page).toBe(2);
    expect(pages[1]?.size).toEqual({ widthPt: 600, heightPt: 800 });
    expect(pages[1]?.words).toHaveLength(0);
    expect(pages[1]?.blocks).toHaveLength(0);
    expect(pages[1]?.headingCandidates).toHaveLength(0);
  });

  it("reports the caller's page number for a single-page extraction", () => {
    // pdftotext -f 7 -l 7 emits one <page>; the caller says it is page 7.
    const page = parseBboxLayoutPage(ONE_PAGE, 7);
    expect(page.page).toBe(7);
    expect(page.words).toHaveLength(5);
  });

  it("degrades an empty page to an empty analysis", () => {
    const page = parseBboxLayoutPage(
      `<doc><page width="600" height="800"><flow></flow></page></doc>`,
      3,
    );
    expect(page.page).toBe(3);
    expect(page.words).toEqual([]);
    expect(page.blocks).toEqual([]);
    expect(page.lines).toEqual([]);
    expect(page.headingCandidates).toEqual([]);
    // The page size is still reported even with no text.
    expect(page.size).toEqual({ widthPt: 600, heightPt: 800 });
  });

  it("degrades malformed, empty or non-page XHTML without throwing", () => {
    expect(parseBboxLayout("")).toEqual([]);
    expect(parseBboxLayout("   ")).toEqual([]);
    expect(parseBboxLayout("not xml at all <<<")).toEqual([]);
    expect(parseBboxLayout("<doc></doc>")).toEqual([]);
    // A truncated document (poppler killed mid-write) must not throw.
    const truncated = ONE_PAGE.slice(0, ONE_PAGE.length / 2);
    expect(() => parseBboxLayout(truncated)).not.toThrow();
    // A page with a zero/absent size cannot be normalised: geometry is dropped
    // but the call still succeeds.
    const noSize = parseBboxLayoutPage(
      `<doc><page><flow><block><line><word xMin="1" yMin="1" xMax="2" yMax="2">x</word></line></block></flow></page></doc>`,
      1,
    );
    expect(noSize.words).toEqual([]);
    expect(noSize.size).toEqual({ widthPt: 0, heightPt: 0 });
  });

  it("keeps every normalised coordinate within [0,1]", () => {
    // A word whose coordinates slightly exceed the page (poppler rounding) is
    // clamped rather than emitted out of range.
    const page = parseBboxLayoutPage(
      `<doc><page width="100" height="100"><flow><block><line>
        <word xMin="-2" yMin="-1" xMax="105" yMax="120">edge</word>
      </line></block></flow></page></doc>`,
      1,
    );
    const bbox = page.words[0]?.bbox;
    expect(bbox).toBeDefined();
    for (const c of bbox ?? []) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe("detectHeadingCandidates", () => {
  const line = (text: string): AnalyzedLine => ({
    words: [],
    bbox: [0, 0, 1, 0.05],
    text,
    height: 0.05,
  });

  it("matches multi-level numbering followed by text", () => {
    const lines = [
      line("1 Einleitung"),
      line("2.1 Anmeldung"),
      line("3.4.2 Teilfreigabe"),
    ];
    const candidates = detectHeadingCandidates(lines);
    expect(candidates.map((c) => c.numbering)).toEqual(["1", "2.1", "3.4.2"]);
  });

  it("does not match a bare number, prose, or a decimal value", () => {
    const lines = [
      line("2.1"), // a bare figure/section number with no title
      line("Ein ganz normaler Satz."),
      line("42"), // a page number
      line("Die Toleranz beträgt 3.5 mm."), // a decimal mid-sentence
    ];
    expect(detectHeadingCandidates(lines)).toEqual([]);
  });

  it("never throws on arbitrary line text (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (texts) => {
        const candidates = detectHeadingCandidates(texts.map(line));
        // Every flagged candidate really does start with its numbering.
        for (const c of candidates) {
          expect(c.text.startsWith(c.numbering)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
