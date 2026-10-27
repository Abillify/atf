// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * bbox-snap.ts
 *
 * Deterministic figure-bbox refinement — stage **S4 "refined"** in the per-page
 * sequence `analyzed(S2) → vision1(S3) → refined(S4) → …`.
 *
 * ## Why this exists
 *
 * Pass 1 (S3) proposes a figure bbox by eye. A model-drawn box is usually close
 * but rarely tight: it clips a caption line, leaves a white margin, or drifts a
 * few percent off the ink. S4 corrects it *without a model*, using two sources
 * that are already computed for free:
 *
 *   - the **rendered page image** (the pixels), to trim the box to where the
 *     ink actually is, and
 *   - the **S2 text geometry** ({@link PageAnalysis}: blocks, lines, words with
 *     normalised bboxes from `pdftotext -bbox-layout`), to align the box to the
 *     edges of adjacent text blocks and to pull the verbatim words inside it.
 *
 * For vector BPMN, vector plans and text-layer PDFs those words ARE the labels
 * at no model cost — the highest-value lever against the "wrong/empty figure
 * text" defect. They land on the v2 `figure` block as
 * {@link SnapResult.regionText} and {@link SnapResult.labels}.
 *
 * ## The algorithm ({@link snapFigureBBox})
 *
 *   1. Start from the Pass-1 bbox (normalised `[x1,y1,x2,y2]` in `[0,1]`).
 *   2. Expand 3 % on each side, clamped to the page.
 *   3. Trim to ink: inspect the expanded region of the page image and shrink to
 *      the non-white bounding area. An effectively empty (white) region keeps
 *      the expanded box — never collapse to zero.
 *   4. Align to text: grow the box outward to the union of any S2 block/line
 *      that *substantially* overlaps it, so a clipped caption/label row is taken
 *      whole, without swallowing a far-away block.
 *   5. `regionText`: the S2 words whose centre lies inside the snapped box, in
 *      reading order (top-to-bottom, then left-to-right), joined per line.
 *   6. `labels`: `regionText` split into lines, trimmed, whitespace-collapsed,
 *      empties dropped, deduplicated (case-preserving).
 *
 * Every step degrades gracefully: no image → skip the ink trim; no S2 geometry
 * (a scan, or poppler without `-bbox-layout`) → skip alignment and leave
 * `regionText`/`labels` undefined. The function never throws and never fails a
 * page ("graceful degradation").
 *
 * ## Purity
 *
 * The geometry and text core is a pure function of its inputs — a candidate
 * bbox, an optional page image buffer and an optional {@link PageAnalysis}. It
 * shells out to nothing; the only side channel is sharp decoding the image
 * buffer it is handed. That keeps it unit-testable against a synthetic image and
 * a synthetic analysis with no poppler present.
 */

import sharp from "sharp";
import type { BBox } from "@atf/extract-contract/v2";
import type { AnalyzedBlock, AnalyzedLine, AnalyzedWord, PageAnalysis } from "./bbox-layout.js";

/** Fraction of each side to grow the Pass-1 box by before trimming. */
export const EXPAND_FRACTION = 0.03;

/**
 * A pixel counts as "ink" when any channel is at least this far below pure
 * white (0–255). Anti-aliased edges and faint scanner grey sit just under
 * white; 24 keeps them as ink without treating JPEG noise on a white page as
 * content.
 */
const INK_THRESHOLD = 24;

/**
 * How much of a text block must fall inside the box for S4 to snap the box out
 * to include the whole block. High enough that a caption line mostly inside the
 * figure is pulled in, low enough to ignore a block the box only grazes.
 */
const BLOCK_OVERLAP_MIN = 0.6;

/** The maximum a single alignment step may grow one edge, in normalised units.
 * A guard so aligning to a block that happens to span the page cannot balloon
 * the box across the whole page; a caption/label row is a few percent tall. */
const MAX_ALIGN_GROWTH = 0.15;

/** The outcome of refining one figure bbox. */
export interface SnapResult {
  /** The snapped, normalised bbox `[x1,y1,x2,y2]` in `[0,1]`. */
  bbox: BBox;
  /**
   * The verbatim text-layer words inside the snapped box, in reading order,
   * joined single-spaced within a line and newline-separated between lines.
   * Undefined when no S2 geometry was available (a scan / no `-bbox-layout`).
   */
  regionText?: string;
  /** `regionText` split to lines, normalised and deduplicated. Undefined with no geometry. */
  labels?: string[];
}

/** Clamp a normalised coordinate into `[0,1]`. */
function clamp01(n: number): number {
  return Math.min(Math.max(n, 0), 1);
}

/** A finite, positive-area, in-page normalised box. */
function isUsableBox(bbox: BBox): boolean {
  const [x1, y1, x2, y2] = bbox;
  return (
    [x1, y1, x2, y2].every((v) => Number.isFinite(v)) &&
    x2 > x1 &&
    y2 > y1
  );
}

/**
 * Expand a normalised bbox by {@link EXPAND_FRACTION} on each side, clamped to
 * the page. The growth is a fraction of each dimension, so a wide-but-short
 * figure grows more horizontally than vertically — the same relative margin on
 * both axes, which is what "3 %" means for a box, not 3 % of the page.
 */
export function expandBBox(bbox: BBox, fraction: number = EXPAND_FRACTION): BBox {
  const [x1, y1, x2, y2] = bbox;
  const dx = (x2 - x1) * fraction;
  const dy = (y2 - y1) * fraction;
  return [clamp01(x1 - dx), clamp01(y1 - dy), clamp01(x2 + dx), clamp01(y2 + dy)];
}

/** The overlap ratio of `box` covered by its intersection with `other` (0..1). */
function overlapRatioOf(box: BBox, other: BBox): number {
  const ix1 = Math.max(box[0], other[0]);
  const iy1 = Math.max(box[1], other[1]);
  const ix2 = Math.min(box[2], other[2]);
  const iy2 = Math.min(box[3], other[3]);
  const iw = ix2 - ix1;
  const ih = iy2 - iy1;
  if (iw <= 0 || ih <= 0) return 0;
  const area = (other[2] - other[0]) * (other[3] - other[1]);
  if (area <= 0) return 0;
  return (iw * ih) / area;
}

/** The union of two boxes. */
function unionBox(a: BBox, b: BBox): BBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/** True when the word's centre lies inside the box. */
function centreInside(word: AnalyzedWord, box: BBox): boolean {
  const cx = (word.bbox[0] + word.bbox[2]) / 2;
  const cy = (word.bbox[1] + word.bbox[3]) / 2;
  return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
}

/**
 * Trim a normalised box to the ink inside it, by inspecting the corresponding
 * region of a rendered page image.
 *
 * The box is resolved to pixels, that region is extracted and decoded to raw
 * greyscale, and the bounding rectangle of the non-white pixels is measured and
 * mapped back to normalised page coordinates. A region that is effectively
 * white (a figure the model over-boxed, or one the ink trim cannot see) keeps
 * the input box unchanged — the ink trim only ever shrinks, and never to zero.
 *
 * Never throws: any sharp/decoding failure returns the input box, so a page is
 * never failed over an unreadable image.
 *
 * @param bbox   The (expanded) normalised box to trim.
 * @param image  The rendered page image bytes and pixel dimensions.
 */
export async function trimToInk(
  bbox: BBox,
  image: { buffer: Uint8Array; width: number; height: number },
): Promise<BBox> {
  if (!isUsableBox(bbox)) return bbox;
  const { width, height } = image;
  if (!(width > 0) || !(height > 0)) return bbox;

  // Resolve to integer pixels, clamped to the page, at least 1px each side.
  const left = Math.max(0, Math.floor(bbox[0] * width));
  const top = Math.max(0, Math.floor(bbox[1] * height));
  const right = Math.min(width, Math.ceil(bbox[2] * width));
  const bottom = Math.min(height, Math.ceil(bbox[3] * height));
  const regionW = right - left;
  const regionH = bottom - top;
  if (regionW < 1 || regionH < 1) return bbox;

  let raw: { data: Buffer; info: { width: number; height: number } };
  try {
    const out = await sharp(image.buffer)
      .extract({ left, top, width: regionW, height: regionH })
      // Flatten transparency onto white so an alpha figure is not read as ink,
      // then reduce to one greyscale channel: ink is "darker than white".
      .flatten({ background: "#ffffff" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    raw = { data: out.data, info: { width: out.info.width, height: out.info.height } };
  } catch {
    // An unreadable region is not a page failure: keep the box as given.
    return bbox;
  }

  const { data } = raw;
  const rw = raw.info.width;
  const rh = raw.info.height;
  // Channels per pixel after greyscale is 1, but be defensive if a build keeps
  // more; derive it from the buffer length.
  const channels = Math.max(1, Math.floor(data.length / (rw * rh || 1)));

  let minX = rw;
  let minY = rh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rh; y++) {
    const rowBase = y * rw * channels;
    for (let x = 0; x < rw; x++) {
      const v = data[rowBase + x * channels] ?? 255;
      if (v <= 255 - INK_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Effectively empty (white) region: keep the expanded box, do not collapse.
  if (maxX < minX || maxY < minY) return bbox;

  // Map the ink rectangle (pixels within the extracted region) back to the
  // page's normalised space. `+1` on the maxes makes the rectangle inclusive.
  const inkLeft = (left + minX) / width;
  const inkTop = (top + minY) / height;
  const inkRight = (left + maxX + 1) / width;
  const inkBottom = (top + maxY + 1) / height;

  const trimmed: BBox = [
    clamp01(Math.max(bbox[0], inkLeft)),
    clamp01(Math.max(bbox[1], inkTop)),
    clamp01(Math.min(bbox[2], inkRight)),
    clamp01(Math.min(bbox[3], inkBottom)),
  ];
  // Guard degenerate results (all-ink or rounding) — never return a zero box.
  return isUsableBox(trimmed) ? trimmed : bbox;
}

/**
 * Grow a box outward to the union of any S2 block (or bare line, for a page
 * whose blocks were not grouped) that substantially overlaps it, so a figure
 * that clips a caption or a label row takes the whole line.
 *
 * "Substantially" is {@link BLOCK_OVERLAP_MIN} of the block's own area inside
 * the box: a caption mostly inside the figure is pulled in; a body block the
 * box merely grazes is left alone. Each edge may grow by at most
 * {@link MAX_ALIGN_GROWTH} in one step, so aligning to a block that spans the
 * page cannot balloon the box across the page.
 *
 * Pure and deterministic; with no blocks/lines it returns the box unchanged.
 */
export function alignToTextBlocks(
  bbox: BBox,
  analysis: Pick<PageAnalysis, "blocks" | "lines">,
): BBox {
  const regions: Array<AnalyzedBlock | AnalyzedLine> =
    analysis.blocks.length > 0 ? analysis.blocks : analysis.lines;
  let box = bbox;
  for (const region of regions) {
    if (overlapRatioOf(box, region.bbox) < BLOCK_OVERLAP_MIN) continue;
    const grown = unionBox(box, region.bbox);
    // Clamp each edge's growth so one oversized block cannot swallow the page.
    const clamped: BBox = [
      Math.max(grown[0], box[0] - MAX_ALIGN_GROWTH),
      Math.max(grown[1], box[1] - MAX_ALIGN_GROWTH),
      Math.min(grown[2], box[2] + MAX_ALIGN_GROWTH),
      Math.min(grown[3], box[3] + MAX_ALIGN_GROWTH),
    ];
    box = [clamp01(clamped[0]), clamp01(clamped[1]), clamp01(clamped[2]), clamp01(clamped[3])];
  }
  return box;
}

/**
 * Collect the text-layer words whose centre lies inside the box, in reading
 * order, grouped by their S2 line so the join preserves line breaks.
 *
 * Reading order is top-to-bottom then left-to-right: lines are ordered by their
 * top edge, and within a line by the word's left edge (the S2 word order is
 * already left-to-right, but a defensive sort keeps it robust). Words on lines
 * outside the box but whose own centre falls inside (rare, e.g. a rotated word)
 * are gathered into a trailing pseudo-line so nothing inside the box is lost.
 *
 * Returns an empty string when no word's centre is inside the box.
 */
export function collectRegionText(
  bbox: BBox,
  analysis: Pick<PageAnalysis, "lines">,
): string {
  const lines: Array<{ top: number; left: number; text: string }> = [];
  for (const line of analysis.lines) {
    const inside = line.words.filter((w) => centreInside(w, bbox));
    if (inside.length === 0) continue;
    const ordered = [...inside].sort((a, b) => a.bbox[0] - b.bbox[0]);
    const text = ordered
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text === "") continue;
    // Order lines by their top edge, tie-break on the leftmost word.
    const top = Math.min(...ordered.map((w) => w.bbox[1]));
    const left = Math.min(...ordered.map((w) => w.bbox[0]));
    lines.push({ top, left, text });
  }
  lines.sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top));
  return lines.map((l) => l.text).join("\n");
}

/**
 * Derive `labels` from `regionText`: split to lines, trim each, collapse
 * internal whitespace, drop empties, then deduplicate preserving the first
 * occurrence's casing and order. Case-preserving dedup keeps "Anmeldung" and
 * "anmeldung" apart deliberately — a label's casing is part of its identity.
 */
export function deriveLabels(regionText: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const rawLine of regionText.split("\n")) {
    const label = rawLine.replace(/\s+/g, " ").trim();
    if (label === "" || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * Refine one Pass-1 figure bbox (S4). Expands, trims to ink (when a page image
 * is given), aligns to overlapping text blocks and collects `regionText` /
 * `labels` (when S2 geometry is given). Returns the snapped box and, when
 * geometry was available, the region text and labels.
 *
 * Degrades on every axis: without an image the ink trim is skipped and the
 * expanded box is used; without geometry alignment is skipped and
 * `regionText`/`labels` are left undefined. Never throws.
 *
 * @param bbox      The Pass-1 normalised bbox.
 * @param opts.image     The rendered page image, for the ink trim. Optional.
 * @param opts.analysis  The S2 page geometry, for alignment + region text. Optional.
 */
export async function snapFigureBBox(
  bbox: BBox,
  opts: {
    image?: { buffer: Uint8Array; width: number; height: number } | null;
    analysis?: PageAnalysis | null;
  } = {},
): Promise<SnapResult> {
  const image = opts.image ?? null;
  const analysis = opts.analysis ?? null;

  // A degenerate input box cannot be snapped; return it untouched (with region
  // text still collected if geometry is present and it somehow contains words).
  if (!isUsableBox(bbox)) {
    return { bbox };
  }

  // 1–2: expand.
  let box = expandBBox(bbox);

  // 3: trim to ink (only with an image; failures keep the expanded box).
  if (image !== null) {
    box = await trimToInk(box, image);
  }

  // 4: align to text blocks (only with geometry).
  const hasGeometry = analysis !== null && (analysis.lines.length > 0 || analysis.blocks.length > 0);
  if (hasGeometry) {
    box = alignToTextBlocks(box, analysis);
  }

  // 5–6: region text + labels (only with geometry; a scan yields neither).
  if (analysis !== null && analysis.lines.length > 0) {
    const regionText = collectRegionText(box, analysis);
    const labels = deriveLabels(regionText);
    return {
      bbox: box,
      ...(regionText !== "" ? { regionText } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    };
  }

  return { bbox: box };
}
