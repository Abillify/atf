// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/page-classifier.ts
 *
 * Deterministic page classification and the sharp-backed page-image statistics
 * it needs — the second half of the `analyzed` (S2) stage (design §5 S2; task
 * 2.2, requirement 7.2).
 *
 * ## Why this exists
 *
 * Once S2 (`page-analyzer.ts`) has the geometry — every word, line and block
 * with a normalised bbox, plus the page size — the pipeline can decide *what
 * kind of page this is* without spending a model call. That decision drives
 * everything after it:
 *
 *   - a `text` page with no table/figure candidates can take the text fast-path
 *     (task 2.9) and skip vision entirely,
 *   - a `drawing` (a plan) is tiled at high DPI (task 5.1) rather than sent as
 *     one downscaled image,
 *   - a `scan` (no text layer, mostly ink) must go through vision/OCR,
 *   - a `mixed` page (text plus substantial non-text ink) keeps the full vision
 *     pass.
 *
 * ## The three signals (design §5 S2)
 *
 *   1. **Text density** — words per unit of page area, from the S2 analysis. A
 *      body-text page is dense; a plan or a scan has few or no text-layer words.
 *   2. **Format / size** — the page's physical size in points. A page with a
 *      long edge past A3 is very likely a plan/poster, which nudges toward
 *      `drawing`.
 *   3. **Ink ratio outside the text blocks** — the fraction of dark pixels on
 *      the rendered page that do *not* fall inside a text block's bbox. This is
 *      the sharp statistic: lots of ink where there is no text layer means
 *      graphics (a drawing) or a scanned raster (a scan); little means clean
 *      body text.
 *
 * ## Purity
 *
 * {@link classifyPage} is a pure function of a {@link ClassificationInput}: the
 * S2 analysis, the page size and a precomputed ink ratio. The sharp call that
 * produces the ink ratio lives in {@link computeInkRatioOutsideBlocks} and is
 * kept separate so the classifier itself can be unit-tested with synthetic
 * numbers and no image at all.
 */

import sharp from "sharp";
import type { BBox } from "@atf/extract-contract/v2";
import type { PageAnalysis } from "../pipeline/bbox-layout.js";

/** The four page classes carried on the v2 page record's `class` field. */
export type PageClass = "text" | "scan" | "drawing" | "mixed";

/** One inch is 72 PostScript points. */
const POINTS_PER_INCH = 72;

/**
 * A3's long edge in points (420 mm ≈ 16.54 in). A page whose long edge exceeds
 * this is large-format (design §5 S2, requirement 2.7): a plan or a poster,
 * which biases classification toward `drawing`.
 *
 * Exported because the tiling stage (design §5 S6, task 5.1) uses the exact same
 * threshold to decide whether a page is large enough to split into overlapping
 * tiles — the two decisions must agree on what "over A3" means.
 */
export const A3_LONG_EDGE_PT = (420 / 25.4) * POINTS_PER_INCH;

/** The pixel value below which a greyscale pixel counts as "ink" (dark). */
const INK_THRESHOLD = 128;

/** The longer edge, in pixels, the ink raster is downscaled to before counting. */
const INK_SAMPLE_LONG_EDGE = 512;

/**
 * The tunable thresholds for {@link classifyPage}. Defaults are chosen against
 * ordinary office documents (A4 body text) and plan sets; a deployment can
 * override them without touching the decision logic.
 */
export interface ClassificationThresholds {
  /**
   * Words per square inch below which a page has effectively no text layer.
   * A body-text A4 page runs into the hundreds; a scan or a vector plan with no
   * text layer is ~0.
   */
  minTextDensityPerIn2: number;
  /**
   * Words per square inch above which a page is text-dominant. Between this and
   * {@link minTextDensityPerIn2} the ink ratio decides text-vs-mixed.
   */
  denseTextPerIn2: number;
  /**
   * Ink-outside-blocks ratio above which the non-text content is substantial
   * enough to matter (graphics, a scan, or a figure-heavy page).
   */
  highInkRatio: number;
  /**
   * Ink ratio above which a page with no text layer is a raster scan rather
   * than a sparse vector drawing. A scanned page is ink almost everywhere
   * (paper texture, full-page content); a vector plan is mostly white with
   * concentrated linework.
   */
  scanInkRatio: number;
}

/** Defaults tuned for office documents and plan sets. */
export const DEFAULT_THRESHOLDS: ClassificationThresholds = {
  minTextDensityPerIn2: 2,
  denseTextPerIn2: 20,
  highInkRatio: 0.06,
  scanInkRatio: 0.35,
};

/** Everything {@link classifyPage} needs, all precomputed and side-effect-free. */
export interface ClassificationInput {
  /** Word count from the S2 analysis (`analysis.words.length`). */
  wordCount: number;
  /** Page size in points, from the S2 analysis. */
  size: { widthPt: number; heightPt: number };
  /**
   * Fraction in `[0,1]` of dark pixels on the rendered page that lie *outside*
   * any text block, from {@link computeInkRatioOutsideBlocks}. `null` when no
   * rendered image was available (e.g. the analysis had no geometry); the
   * classifier then leans on text density and format alone.
   */
  inkRatioOutsideBlocks: number | null;
}

/** The classification result, with the signals that produced it (for logs). */
export interface Classification {
  class: PageClass;
  /** Words per square inch, or `null` when the page size is unknown. */
  textDensity: number | null;
  inkRatioOutsideBlocks: number | null;
  largeFormat: boolean;
}

/** The page's area in square inches, or `null` when its size is unusable. */
function areaIn2(size: { widthPt: number; heightPt: number }): number | null {
  const wIn = size.widthPt / POINTS_PER_INCH;
  const hIn = size.heightPt / POINTS_PER_INCH;
  if (!(wIn > 0) || !(hIn > 0)) return null;
  return wIn * hIn;
}

/** True when the page's longer edge exceeds A3 — a plan/poster candidate. */
function isLargeFormat(size: { widthPt: number; heightPt: number }): boolean {
  const longEdge = Math.max(size.widthPt, size.heightPt);
  return longEdge > A3_LONG_EDGE_PT;
}

/**
 * Classify a page as `text | scan | drawing | mixed` from its text density,
 * format and ink ratio (design §5 S2, requirement 7.2). Pure and deterministic.
 *
 * The decision tree, in order:
 *
 *   1. **No text layer** (density below `minTextDensityPerIn2`, or size unknown
 *      with no words): the page's content is all in the pixels. Very high ink
 *      → `scan`; otherwise → `drawing` (a vector plan with a thin text layer,
 *      or a large-format page). With no ink signal at all, a large-format page
 *      is `drawing`, else `scan` (a blank/near-blank page with no text is most
 *      safely handled by vision).
 *   2. **Dense text** (density above `denseTextPerIn2`): body text. If there is
 *      also substantial ink outside the blocks it is `mixed` (text plus a
 *      diagram/figure), else `text`.
 *   3. **Sparse text** (between the two density thresholds): some text, but not
 *      body-text density. A large format or high ink → `drawing`/`mixed`; low
 *      ink → `text`.
 */
export function classifyPage(
  input: ClassificationInput,
  thresholds: ClassificationThresholds = DEFAULT_THRESHOLDS,
): Classification {
  const area = areaIn2(input.size);
  const density = area !== null ? input.wordCount / area : null;
  const largeFormat = isLargeFormat(input.size);
  const ink = input.inkRatioOutsideBlocks;

  const result = (cls: PageClass): Classification => ({
    class: cls,
    textDensity: density,
    inkRatioOutsideBlocks: ink,
    largeFormat,
  });

  // ── 1. No usable text layer ──────────────────────────────────────────────
  const hasText = density !== null && density >= thresholds.minTextDensityPerIn2;
  if (!hasText) {
    if (ink !== null && ink >= thresholds.scanInkRatio) return result("scan");
    if (ink !== null && ink >= thresholds.highInkRatio) return result("drawing");
    // No/low ink and no text: a large sheet is a (blank-ish) plan; otherwise
    // there is nothing deterministic to lean on, so vision handles it as a scan.
    return result(largeFormat ? "drawing" : "scan");
  }

  const highInk = ink !== null && ink >= thresholds.highInkRatio;

  // ── 2. Dense body text ───────────────────────────────────────────────────
  if (density !== null && density >= thresholds.denseTextPerIn2) {
    return result(highInk ? "mixed" : "text");
  }

  // ── 3. Sparse text: some words, but not body-text density ────────────────
  if (largeFormat) return result("drawing");
  if (highInk) return result("mixed");
  return result("text");
}

/** Convenience: classify straight from an S2 {@link PageAnalysis} + ink ratio. */
export function classifyFromAnalysis(
  analysis: PageAnalysis,
  inkRatioOutsideBlocks: number | null,
  thresholds: ClassificationThresholds = DEFAULT_THRESHOLDS,
): Classification {
  return classifyPage(
    {
      wordCount: analysis.words.length,
      size: analysis.size,
      inkRatioOutsideBlocks,
    },
    thresholds,
  );
}

/** What the runner knows about a rendered page when it resolves its size. */
export interface RenderedPageFacts {
  image: { width: number; height: number };
  /** The renderer's physical page size in points, when it reported one. */
  sizePt?: { widthPt: number; heightPt: number } | undefined;
  /** The DPI the image was actually rendered at, when reported. */
  dpi?: number | undefined;
}

/**
 * The page's physical size in points (requirement 2.7, design §5 S2/S6). In
 * order of authority: the renderer's `pdfinfo` size, the S2 `-bbox-layout`
 * page size, and finally the image pixels converted back at the DPI the image
 * was rendered at (`fallbackDpi` when the renderer did not report one).
 *
 * Pixels must never be read as points: a 200-DPI A4 render is ~1654×2339 px,
 * which read as points is "larger than A3" and would tile every page.
 */
export function resolvePageSizePt(
  rendered: RenderedPageFacts,
  analysis: Pick<PageAnalysis, "size"> | null,
  fallbackDpi: number,
): { widthPt: number; heightPt: number } {
  const reported = rendered.sizePt;
  if (reported !== undefined && reported.widthPt > 0 && reported.heightPt > 0) {
    return { widthPt: reported.widthPt, heightPt: reported.heightPt };
  }
  if (analysis !== null && analysis.size.widthPt > 0 && analysis.size.heightPt > 0) {
    return { widthPt: analysis.size.widthPt, heightPt: analysis.size.heightPt };
  }
  const dpi = rendered.dpi !== undefined && rendered.dpi > 0 ? rendered.dpi : fallbackDpi > 0 ? fallbackDpi : 72;
  return {
    widthPt: Math.max(1, (Math.max(1, rendered.image.width) * POINTS_PER_INCH) / dpi),
    heightPt: Math.max(1, (Math.max(1, rendered.image.height) * POINTS_PER_INCH) / dpi),
  };
}

/** Everything {@link classifyRenderedPage} needs about one page. */
export interface RenderedPageClassificationInput {
  /** The rendered page image (PNG bytes) for the ink statistic. */
  imageBuffer: Uint8Array;
  /** The page's text layer; empty for a scan. */
  rawText: string;
  /** True when the page had no text layer. */
  usedOcr: boolean;
  /** The page's physical size in points ({@link resolvePageSizePt}). */
  sizePt: { widthPt: number; heightPt: number };
  /** The page's S2 analysis, or null when S2 is unavailable. */
  analysis: PageAnalysis | null;
}

/**
 * Classify a rendered page with all three signals the runner can produce
 * (design §5 S2, requirement 7.2):
 *
 *   - word count: the S2 words when the analysis has geometry, else the text
 *     layer's whitespace-separated words (0 for an OCR page);
 *   - size: the real page size in points;
 *   - ink outside the text blocks: measured against the S2 block boxes when
 *     there is geometry; for a page with no text layer at all, against no
 *     blocks (all ink counts — the scan-vs-drawing signal). A text page with no
 *     geometry gets `null`: its text ink would be counted as "outside", which
 *     would misclassify ordinary body text as `mixed`.
 *
 * Never throws; a decode failure leaves the ink signal `null`.
 */
export async function classifyRenderedPage(
  input: RenderedPageClassificationInput,
  thresholds: ClassificationThresholds = DEFAULT_THRESHOLDS,
): Promise<Classification> {
  const { analysis } = input;
  const hasGeometry = analysis !== null && analysis.blocks.length > 0 && analysis.words.length > 0;
  const text = input.rawText.trim();
  const wordCount = hasGeometry
    ? analysis.words.length
    : input.usedOcr || text === ""
      ? 0
      : text.split(/\s+/).length;
  let ink: number | null = null;
  if (hasGeometry) {
    ink = await computeInkRatioOutsideBlocks(
      input.imageBuffer,
      analysis.blocks.map((b) => b.bbox),
    );
  } else if (input.usedOcr || text === "") {
    ink = await computeInkRatioOutsideBlocks(input.imageBuffer, []);
  }
  return classifyPage({ wordCount, size: input.sizePt, inkRatioOutsideBlocks: ink }, thresholds);
}

/**
 * Compute the fraction of dark ("ink") pixels on a rendered page image that lie
 * *outside* every text block (design §5 S2). This is the sharp statistic the
 * classifier's third signal needs.
 *
 * The page is decoded to greyscale and downscaled so the count is cheap and
 * DPI-independent (a 100-page document does not decode 100 full-resolution
 * rasters). Each dark pixel is tested against the text-block bboxes — which are
 * in normalised `[0,1]` space, exactly the space we sample in — and counted as
 * "ink outside" when it falls in no block. The result is
 * `inkOutside / totalPixels`, so a clean body-text page (ink only inside the
 * text blocks) reports near zero, and a plan or scan (ink everywhere, little or
 * no text layer) reports high.
 *
 * Never throws: a decode failure yields `null`, and the classifier then leans
 * on text density and format alone (graceful degradation, matching S2).
 *
 * @param pngBuffer  The rendered page image (any sharp-decodable format).
 * @param blocks     Text-block bboxes in normalised `[0,1]` space (from S2).
 */
export async function computeInkRatioOutsideBlocks(
  pngBuffer: Uint8Array,
  blocks: readonly BBox[],
  options: { sampleLongEdge?: number; inkThreshold?: number } = {},
): Promise<number | null> {
  const sampleLongEdge = options.sampleLongEdge ?? INK_SAMPLE_LONG_EDGE;
  const inkThreshold = options.inkThreshold ?? INK_THRESHOLD;
  try {
    const { data, info } = await sharp(pngBuffer, { limitInputPixels: false })
      .greyscale()
      // Downscale so the longer edge is at most `sampleLongEdge`; never upscale.
      .resize({
        width: sampleLongEdge,
        height: sampleLongEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const total = width * height;
    if (total <= 0) return null;

    let inkOutside = 0;
    for (let index = 0; index < data.length; index++) {
      const value = data[index] ?? 255;
      if (value >= inkThreshold) continue; // not ink
      // Pixel centre in normalised space.
      const px = ((index % width) + 0.5) / width;
      const py = (Math.floor(index / width) + 0.5) / height;
      if (!pointInAnyBlock(px, py, blocks)) inkOutside += 1;
    }
    return inkOutside / total;
  } catch {
    return null;
  }
}

/** True when a normalised point falls inside any of the block bboxes. */
function pointInAnyBlock(
  px: number,
  py: number,
  blocks: readonly BBox[],
): boolean {
  for (const b of blocks) {
    if (px >= b[0] && px <= b[2] && py >= b[1] && py <= b[3]) return true;
  }
  return false;
}
