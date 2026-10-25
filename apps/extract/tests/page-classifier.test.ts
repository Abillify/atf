// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * page-classifier.test.ts
 *
 * Deterministic page classification `text | scan | drawing | mixed` (task 2.2,
 * ). The classifier itself is a pure function of precomputed
 * signals, so most cases are driven with synthetic numbers and no image; a
 * separate block exercises the sharp-backed ink-ratio helper against synthetic
 * rasters authored inline (no fixtures).
 *
 * Covers:
 *  - a text page (dense text, low ink outside blocks) → "text"
 *  - a scan (no text layer, high ink) → "scan"
 *  - a drawing (little text, high ink, large format) → "drawing"
 *  - a mixed page (dense text AND high ink outside blocks) → "mixed"
 *  - the ink-ratio helper counts dark pixels outside text blocks on a real raster
 */

import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { BBox } from "@atf/extract-contract/v2";
import {
  DEFAULT_THRESHOLDS,
  classifyPage,
  computeInkRatioOutsideBlocks,
  type ClassificationInput,
} from "../src/jobs/page-classifier.js";

/** An A4 page in points (595×842), the common case. */
const A4 = { widthPt: 595, heightPt: 842 };
/** A large-format sheet: A1 landscape (~2384×1684 pt), long edge well past A3. */
const A1 = { widthPt: 2384, heightPt: 1684 };

function classify(input: Partial<ClassificationInput>): string {
  return classifyPage({
    wordCount: 0,
    size: A4,
    inkRatioOutsideBlocks: null,
    ...input,
  }).class;
}

describe("classifyPage", () => {
  it("classifies a dense text page with little ink outside blocks as text", () => {
    // ~400 words on an A4 page (~48 in²) → density ~8.3/in²… bump to clearly
    // dense: 2000 words → ~42/in², above denseTextPerIn2.
    expect(
      classify({ wordCount: 2000, size: A4, inkRatioOutsideBlocks: 0.01 }),
    ).toBe("text");
  });

  it("classifies a page with no text layer and high ink as a scan", () => {
    expect(
      classify({ wordCount: 0, size: A4, inkRatioOutsideBlocks: 0.6 }),
    ).toBe("scan");
  });

  it("classifies a large-format page with little text and high ink as a drawing", () => {
    // A plan: a handful of text-layer labels on a big sheet, concentrated ink.
    expect(
      classify({ wordCount: 30, size: A1, inkRatioOutsideBlocks: 0.1 }),
    ).toBe("drawing");
  });

  it("classifies a dense text page with substantial non-text ink as mixed", () => {
    // Body text plus a large embedded diagram: dense words AND high ink outside.
    expect(
      classify({ wordCount: 2000, size: A4, inkRatioOutsideBlocks: 0.2 }),
    ).toBe("mixed");
  });

  it("treats a no-text-layer, low-ink small page as a scan (vision handles it)", () => {
    expect(
      classify({ wordCount: 0, size: A4, inkRatioOutsideBlocks: 0.0 }),
    ).toBe("scan");
  });

  it("treats a no-text-layer large sheet with no ink signal as a drawing", () => {
    expect(
      classify({ wordCount: 0, size: A1, inkRatioOutsideBlocks: null }),
    ).toBe("drawing");
  });

  it("leans on density and format when no ink ratio is available", () => {
    // No image (ink null): dense text is still text; large sparse is drawing.
    expect(classify({ wordCount: 2000, size: A4, inkRatioOutsideBlocks: null })).toBe("text");
    expect(classify({ wordCount: 20, size: A1, inkRatioOutsideBlocks: null })).toBe("drawing");
  });

  it("exposes the density and large-format signals it decided on", () => {
    const result = classifyPage({ wordCount: 2000, size: A4, inkRatioOutsideBlocks: 0.01 });
    expect(result.textDensity).toBeGreaterThan(DEFAULT_THRESHOLDS.denseTextPerIn2);
    expect(result.largeFormat).toBe(false);
    const plan = classifyPage({ wordCount: 30, size: A1, inkRatioOutsideBlocks: 0.1 });
    expect(plan.largeFormat).toBe(true);
  });
});

// ── sharp ink-ratio helper against synthetic rasters ────────────────────────

/**
 * Build a PNG where a rectangle (in normalised coordinates) is filled black and
 * the rest is white. Lets us assert the ink-outside-blocks count exactly.
 */
async function pngWithBlackRect(
  width: number,
  height: number,
  rect: BBox,
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3, 255);
  const x1 = Math.floor(rect[0] * width);
  const y1 = Math.floor(rect[1] * height);
  const x2 = Math.floor(rect[2] * width);
  const y2 = Math.floor(rect[3] * height);
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const o = (y * width + x) * 3;
      raw[o] = 0;
      raw[o + 1] = 0;
      raw[o + 2] = 0;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("computeInkRatioOutsideBlocks", () => {
  it("reports near-zero when all the ink lies inside the text blocks", async () => {
    // A black band in the top-left quadrant, declared as a text block.
    const block: BBox = [0, 0, 0.5, 0.5];
    const png = await pngWithBlackRect(200, 200, block);
    const ratio = await computeInkRatioOutsideBlocks(png, [block]);
    expect(ratio).not.toBeNull();
    expect(ratio ?? 1).toBeLessThan(0.02);
  });

  it("reports substantial ink when the black region is outside every block", async () => {
    // The same black region, but no block covers it: all that ink is "outside".
    const inkRect: BBox = [0, 0, 0.5, 0.5];
    const png = await pngWithBlackRect(200, 200, inkRect);
    const ratio = await computeInkRatioOutsideBlocks(png, []);
    expect(ratio).not.toBeNull();
    // ~a quarter of the page is black and all outside blocks.
    expect(ratio ?? 0).toBeGreaterThan(0.2);
  });

  it("returns null for an undecodable image rather than throwing", async () => {
    const ratio = await computeInkRatioOutsideBlocks(Buffer.from("not an image"), []);
    expect(ratio).toBeNull();
  });
});

// ── real page size and the tiling gate ──

describe("resolvePageSizePt / classifyRenderedPage / tiling gate", async () => {
  const { resolvePageSizePt, classifyRenderedPage } = await import("../src/jobs/page-classifier.js");
  const { shouldTilePage, planTiles } = await import("../src/pipeline/tiling.js");
  const tiling = { tileTargetPixels: 2000, overlapFraction: 0.1, maxTiles: 16, maxPixels: 40_000_000 };

  /** Would the runner actually split this page into tiles? */
  function tiles(pageClass: "text" | "scan" | "drawing" | "mixed", size: { widthPt: number; heightPt: number }): boolean {
    return shouldTilePage(pageClass, size) && !planTiles(size, tiling).singleTile;
  }

  it("never reads pixels as points: a 200-DPI A4 render resolves to A4", () => {
    const size = resolvePageSizePt({ image: { width: 1654, height: 2339 } }, null, 200);
    expect(size.widthPt).toBeCloseTo(595.4, 0);
    expect(size.heightPt).toBeCloseTo(842, 0);
    // The renderer's reported size (pdfinfo) wins over the pixels …
    expect(
      resolvePageSizePt({ image: { width: 10, height: 10 }, sizePt: { widthPt: 2384, heightPt: 3370 } }, null, 200),
    ).toEqual({ widthPt: 2384, heightPt: 3370 });
    // … and the actual (adaptive) render DPI is used for the pixel fallback.
    const a0 = resolvePageSizePt({ image: { width: 1414, height: 2000 }, dpi: 42.7 }, null, 200);
    expect(Math.max(a0.widthPt, a0.heightPt)).toBeGreaterThan(3000);
  });

  it("does not tile a normal A4 page, but tiles an A0 sheet", () => {
    const a4 = resolvePageSizePt({ image: { width: 1654, height: 2339 } }, null, 200);
    expect(tiles("text", a4)).toBe(false);
    expect(tiles("drawing", a4)).toBe(false); // even a drawing on A4 is one tile
    expect(tiles("text", { widthPt: 2384, heightPt: 3370 })).toBe(true);
    expect(tiles("drawing", { widthPt: 2384, heightPt: 3370 })).toBe(true);
  });

  it("classifies with the ink outside the S2 blocks when geometry is present", async () => {
    // A page whose only ink sits in the lower half, outside a top text block.
    const raw = Buffer.alloc(64 * 64, 255);
    for (let y = 40; y < 60; y++) for (let x = 4; x < 60; x++) raw[y * 64 + x] = 0;
    const png = await sharp(raw, { raw: { width: 64, height: 64, channels: 1 } }).png().toBuffer();
    const words = Array.from({ length: 400 }, (_, i) => ({
      text: `w${i}`,
      bbox: [0.05, 0.05, 0.1, 0.1] as BBox,
    }));
    const line = { words, bbox: [0.05, 0.05, 0.95, 0.3] as BBox, text: "…", height: 0.02 };
    const analysis = {
      page: 1,
      size: { widthPt: 595, heightPt: 842 },
      blocks: [{ lines: [line], bbox: line.bbox, text: "…" }],
      lines: [line],
      words,
      headingCandidates: [],
    };
    const mixed = await classifyRenderedPage({
      imageBuffer: png,
      rawText: "…",
      usedOcr: false,
      sizePt: { widthPt: 595, heightPt: 842 },
      analysis,
    });
    expect(mixed.class).toBe("mixed");
    expect(mixed.inkRatioOutsideBlocks).toBeGreaterThan(0.06);

    // Without geometry a text page gets no ink signal (its own text ink would
    // count as "outside") and classifies on density alone.
    const text = await classifyRenderedPage({
      imageBuffer: png,
      rawText: "wort ".repeat(400),
      usedOcr: false,
      sizePt: { widthPt: 595, heightPt: 842 },
      analysis: null,
    });
    expect(text.inkRatioOutsideBlocks).toBeNull();
    expect(text.class).toBe("text");

    // A page with no text layer uses the whole-page ink: a dense raster is a scan.
    const dark = await sharp(Buffer.alloc(64 * 64, 20), { raw: { width: 64, height: 64, channels: 1 } })
      .png()
      .toBuffer();
    const scan = await classifyRenderedPage({
      imageBuffer: dark,
      rawText: "",
      usedOcr: true,
      sizePt: { widthPt: 595, heightPt: 842 },
      analysis: null,
    });
    expect(scan.class).toBe("scan");
  });
});
