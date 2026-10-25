// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * bbox-snap.test.ts
 *
 * Deterministic figure-bbox refinement — S4.
 *
 * The snapping + regionText/labels core is a pure function of a candidate box,
 * an optional page image and an optional S2 analysis, so these tests drive it
 * with synthetic inputs and no poppler present. sharp is used only to author a
 * synthetic page image (a white page with a black rectangle) for the ink trim.
 *
 * Covers:
 *  - 3 % expansion clamps to the page
 *  - ink trim shrinks an over-boxed region to the black rectangle inside it
 *  - an all-white region keeps the expanded box (never collapses to zero)
 *  - text-block alignment grows the box to include an overlapping caption line
 *  - regionText collects only the words whose centre is inside, in reading order
 *  - labels dedupe + normalise regionText lines
 *  - empty geometry / no image degrade gracefully (no throw, no region text)
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { BBox } from "@atf/extract-contract/v2";
import type {
  AnalyzedLine,
  AnalyzedWord,
  PageAnalysis,
} from "../src/pipeline/bbox-layout.js";
import {
  EXPAND_FRACTION,
  alignToTextBlocks,
  collectRegionText,
  deriveLabels,
  expandBBox,
  snapFigureBBox,
  trimToInk,
} from "../src/pipeline/bbox-snap.js";

/** A word with a normalised box built from its `[x1,y1,x2,y2]`. */
function word(text: string, bbox: BBox): AnalyzedWord {
  return { text, bbox };
}

/** Roll a list of words into a line with a union bbox (like the S2 parser). */
function line(words: AnalyzedWord[]): AnalyzedLine {
  const x1 = Math.min(...words.map((w) => w.bbox[0]));
  const y1 = Math.min(...words.map((w) => w.bbox[1]));
  const x2 = Math.max(...words.map((w) => w.bbox[2]));
  const y2 = Math.max(...words.map((w) => w.bbox[3]));
  return {
    words,
    bbox: [x1, y1, x2, y2],
    text: words.map((w) => w.text).join(" "),
    height: y2 - y1,
  };
}

/** Assemble a minimal PageAnalysis from lines, deriving blocks = one per line. */
function analysisOf(lines: AnalyzedLine[]): PageAnalysis {
  return {
    page: 1,
    size: { widthPt: 600, heightPt: 800 },
    blocks: lines.map((l) => ({ lines: [l], bbox: l.bbox, text: l.text })),
    lines,
    words: lines.flatMap((l) => l.words),
    headingCandidates: [],
  };
}

/**
 * Render a white page image with a single filled black rectangle, given in
 * normalised page coordinates. Returns the PNG bytes and pixel dimensions —
 * exactly the `{ buffer, width, height }` shape `trimToInk`/`snapFigureBBox`
 * consume.
 */
async function whitePageWithRect(
  width: number,
  height: number,
  rect: BBox,
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const left = Math.round(rect[0] * width);
  const top = Math.round(rect[1] * height);
  const rw = Math.round((rect[2] - rect[0]) * width);
  const rh = Math.round((rect[3] - rect[1]) * height);
  const black = await sharp({
    create: { width: rw, height: rh, channels: 3, background: "#000000" },
  })
    .png()
    .toBuffer();
  const buffer = await sharp({
    create: { width, height, channels: 3, background: "#ffffff" },
  })
    .composite([{ input: black, left, top }])
    .png()
    .toBuffer();
  return { buffer, width, height };
}

describe("expandBBox", () => {
  it("grows each side by 3 % of the box's own dimensions", () => {
    // A 0.2 × 0.2 box centred at (0.5,0.5): each side grows by 0.2 * 0.03 = 0.006.
    const out = expandBBox([0.4, 0.4, 0.6, 0.6]);
    expect(out[0]).toBeCloseTo(0.394, 6);
    expect(out[1]).toBeCloseTo(0.394, 6);
    expect(out[2]).toBeCloseTo(0.606, 6);
    expect(out[3]).toBeCloseTo(0.606, 6);
    expect(EXPAND_FRACTION).toBe(0.03);
  });

  it("clamps the expansion to the page edges", () => {
    const out = expandBBox([0, 0, 1, 1]);
    expect(out).toEqual([0, 0, 1, 1]);
  });
});

describe("trimToInk", () => {
  it("shrinks an over-boxed region to the black rectangle inside it", async () => {
    // A black rectangle occupying [0.3,0.3,0.7,0.7] on a 400×400 white page.
    const image = await whitePageWithRect(400, 400, [0.3, 0.3, 0.7, 0.7]);
    // Box the whole page; the trim should pull in to roughly the rectangle.
    const trimmed = await trimToInk([0, 0, 1, 1], image);
    expect(trimmed[0]).toBeCloseTo(0.3, 1);
    expect(trimmed[1]).toBeCloseTo(0.3, 1);
    expect(trimmed[2]).toBeCloseTo(0.7, 1);
    expect(trimmed[3]).toBeCloseTo(0.7, 1);
    // And it genuinely shrank all four edges inward.
    expect(trimmed[0]).toBeGreaterThan(0);
    expect(trimmed[2]).toBeLessThan(1);
  });

  it("keeps the box when the region is all white (never collapses)", async () => {
    const image = await whitePageWithRect(200, 200, [0.4, 0.4, 0.6, 0.6]);
    // A box over a white corner, away from the rectangle.
    const box: BBox = [0.05, 0.05, 0.2, 0.2];
    const trimmed = await trimToInk(box, image);
    expect(trimmed).toEqual(box);
  });

  it("returns the box unchanged when the image has no dimensions", async () => {
    const box: BBox = [0.1, 0.1, 0.4, 0.4];
    const out = await trimToInk(box, { buffer: new Uint8Array(), width: 0, height: 0 });
    expect(out).toEqual(box);
  });
});

describe("alignToTextBlocks", () => {
  it("grows the box to include a substantially overlapping caption line", () => {
    // A figure box, and a caption line sitting just below it, mostly inside.
    const caption = line([
      word("Abbildung", [0.3, 0.61, 0.45, 0.64]),
      word("1", [0.46, 0.61, 0.48, 0.64]),
    ]);
    const analysis = analysisOf([caption]);
    // Box covers most of the caption's area (its y spans 0.61–0.64, box to 0.63).
    const out = alignToTextBlocks([0.3, 0.3, 0.7, 0.63], analysis);
    // The bottom edge should have grown down to include the whole caption line.
    expect(out[3]).toBeCloseTo(0.64, 6);
    // The other edges are unchanged (caption is within them).
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[2]).toBeCloseTo(0.7, 6);
  });

  it("ignores a block the box only grazes", () => {
    // A block far below, barely touching the box.
    const far = line([word("Fußzeile", [0.3, 0.9, 0.7, 0.95])]);
    const analysis = analysisOf([far]);
    const box: BBox = [0.3, 0.3, 0.7, 0.6];
    const out = alignToTextBlocks(box, analysis);
    expect(out).toEqual(box);
  });
});

describe("collectRegionText", () => {
  it("collects only the words whose centre is inside, in reading order", () => {
    // Two lines inside the box (top then bottom), one word outside to the right.
    const top = line([
      word("Start", [0.32, 0.35, 0.4, 0.38]),
      word("Knoten", [0.42, 0.35, 0.55, 0.38]),
    ]);
    const bottom = line([word("Ende", [0.33, 0.5, 0.42, 0.53])]);
    const outside = line([word("Rand", [0.85, 0.35, 0.95, 0.38])]);
    const analysis = analysisOf([bottom, outside, top]); // deliberately unordered
    const text = collectRegionText([0.3, 0.3, 0.7, 0.6], analysis);
    // Top line first (smaller y), then the bottom line; "Rand" is excluded.
    expect(text).toBe("Start Knoten\nEnde");
  });

  it("returns empty string when no word centre is inside the box", () => {
    const analysis = analysisOf([line([word("weit", [0.9, 0.9, 0.95, 0.93])])]);
    expect(collectRegionText([0.1, 0.1, 0.3, 0.3], analysis)).toBe("");
  });
});

describe("deriveLabels", () => {
  it("dedupes and normalises region-text lines, preserving order and casing", () => {
    const regionText = "  Start \n\nStart\nEnde  Knoten\nStart\nENDE";
    expect(deriveLabels(regionText)).toEqual(["Start", "Ende Knoten", "ENDE"]);
  });

  it("returns an empty array for empty region text", () => {
    expect(deriveLabels("")).toEqual([]);
    expect(deriveLabels("   \n  ")).toEqual([]);
  });
});

describe("snapFigureBBox", () => {
  it("expands, ink-trims, aligns, and collects region text end to end", async () => {
    // Page: a black rectangle where the figure sits (including its caption row),
    // plus the caption line's text geometry. The Pass-1 box clips the caption's
    // bottom, so alignment must grow the box down to take the whole line.
    const image = await whitePageWithRect(400, 400, [0.3, 0.3, 0.68, 0.66]);
    const caption = line([
      word("Prozess", [0.32, 0.6, 0.45, 0.65]),
      word("A", [0.46, 0.6, 0.5, 0.65]),
    ]);
    const nodeText = line([word("Start", [0.35, 0.4, 0.45, 0.44])]);
    const analysis = analysisOf([nodeText, caption]);

    const result = await snapFigureBBox([0.32, 0.32, 0.66, 0.62], { image, analysis });

    expect(result.bbox[0]).toBeGreaterThan(0);
    expect(result.bbox[2]).toBeLessThan(1);
    // The caption line was pulled in by alignment, so its words appear.
    expect(result.regionText).toContain("Start");
    expect(result.regionText).toContain("Prozess A");
    expect(result.labels).toContain("Start");
    expect(result.labels).toContain("Prozess A");
  });

  it("degrades gracefully with no image (skips ink trim) and no geometry", async () => {
    const result = await snapFigureBBox([0.4, 0.4, 0.6, 0.6], {});
    // Just the expanded box, no region text/labels.
    expect(result.bbox[0]).toBeCloseTo(0.394, 6);
    expect(result.bbox[2]).toBeCloseTo(0.606, 6);
    expect(result.regionText).toBeUndefined();
    expect(result.labels).toBeUndefined();
  });

  it("degrades gracefully for a scan (empty geometry) with an image", async () => {
    const image = await whitePageWithRect(200, 200, [0.3, 0.3, 0.7, 0.7]);
    const empty: PageAnalysis = analysisOf([]);
    const result = await snapFigureBBox([0.25, 0.25, 0.75, 0.75], {
      image,
      analysis: empty,
    });
    // Ink trim still applies; no region text because there is no text layer.
    expect(result.regionText).toBeUndefined();
    expect(result.labels).toBeUndefined();
    expect(result.bbox[2]).toBeLessThanOrEqual(0.75);
  });

  it("returns a degenerate input box untouched without throwing", async () => {
    const result = await snapFigureBBox([0.5, 0.5, 0.5, 0.5], {});
    expect(result.bbox).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(result.regionText).toBeUndefined();
  });
});
