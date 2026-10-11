// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/tiling.ts
 *
 * Deterministic tile geometry for large-format pages — the pure half of stage
 * **S6 "tiled"** (design §5 S6, task 5.1, requirements 8.5, 14.4).
 *
 * ## Why this exists
 *
 * A construction plan (a `drawing` page) or any sheet whose long edge is past A3
 * cannot be transcribed as one downscaled image: at the pixel ceiling the small
 * dimensions, part numbers and legend text on an A0 plan collapse below what the
 * model can read. So S6 splits such a page into an N×M grid of overlapping
 * tiles, transcribes each tile against its own region, and merges the results
 * (`tile-merge.ts`). The tiles are also stored as `tile` assets and become the
 * substrate the research zoom serves from (design §5 S6 "basis for the
 * zoom").
 *
 * ## What is deterministic here
 *
 * Everything: the tile-count, the per-tile bounding boxes and the render DPI are
 * a pure function of the page size (in points), the tile target pixels and the
 * pixel ceiling. That determinism is the whole point — a tile's checkpoint is
 * keyed on its bbox and DPI (task 5.1 mirrors the `figure2` stage), and the
 * tile bytes reproduce on demand from the content-addressed source, so a resume
 * must recompute the identical grid.
 *
 * ## The grid
 *
 *   1. **Tile count.** The page's long/short edge in pixels at `FIGURE_DPI` is
 *      divided by the tile's target long-edge pixels to get the number of
 *      columns and rows, each at least 1. The count is then capped so
 *      `cols × rows ≤ maxTiles` (a budget guard — a vast plan does not spawn
 *      hundreds of model calls), keeping the aspect ratio.
 *   2. **DPI.** Each tile covers `1/cols × 1/rows` of the page. The render DPI
 *      is chosen so a single tile's area stays under the pixel ceiling, exactly
 *      like {@link adaptiveRenderDpi} does for a whole page but applied to the
 *      tile's smaller extent — so tiles are rendered SHARPER than the whole
 *      page, which is the entire reason to tile.
 *   3. **Overlap.** Adjacent tiles overlap by `overlapFraction` (default 10 %)
 *      of a tile's own width/height, so a symbol or a dimension straddling a
 *      seam appears whole in at least one tile. The merge step dedupes the
 *      doubled content in the overlap band.
 *
 * A page that already fits under the tile target in both dimensions yields a
 * single tile covering `[0,0,1,1]` — i.e. "no tiling", the normal-page case —
 * so callers can always ask for a plan and get back either one tile or many
 * without a separate branch.
 */

import type { BBox } from "@atf/extract-contract/v2";
import type { PageClass } from "../jobs/page-classifier.js";
import { A3_LONG_EDGE_PT } from "../jobs/page-classifier.js";

/** One inch is 72 PostScript points, matching the raster/render helpers. */
const POINTS_PER_INCH = 72;

/**
 * The nominal DPI at which `tileTargetPixels` denotes a tile's physical edge.
 * This is only used to size the grid (how many tiles across a page's inches):
 * it maps the pixel target to a physical tile edge so the tile count is a
 * function of the page's physical size, not of a render DPI. 150 DPI is the
 * "overview at model DPI" reference from design §5 S6, a touch below the
 * whole-page render target so an A0 plan yields a handful of tiles rather than
 * a single downscaled image. The tiles are then RENDERED sharper (see
 * {@link tileDpi}); this constant never bounds the render resolution.
 */
const TILE_REFERENCE_DPI = 150;

/** A page size in PostScript points. */
export interface PageSizePt {
  widthPt: number;
  heightPt: number;
}

/** The knobs that shape the grid; all defaulted from config by the caller. */
export interface TilingOptions {
  /**
   * The long edge, in pixels, a single tile's render aims at. Drives both the
   * tile count (page pixels / this) and the per-tile DPI. Larger → fewer,
   * higher-resolution tiles.
   */
  tileTargetPixels: number;
  /** Fraction (0–0.5) of a tile's own extent adjacent tiles overlap by. */
  overlapFraction: number;
  /** Hard ceiling on `cols × rows`, a budget guard against a vast plan. */
  maxTiles: number;
  /** Hard pixel ceiling on a single tile's rendered area (`RENDER_MAX_PIXELS`). */
  maxPixels: number;
  /** DPI floor so a genuinely vast tile still renders legibly, not a thumbnail. */
  minDpi?: number;
}

/** One tile of the grid: its position, id and normalised page-region bbox. */
export interface Tile {
  /** Zero-based column and row in the grid. */
  col: number;
  row: number;
  /**
   * Stable, human-readable tile id, e.g. `p37-r0c1`. Combined with the page in
   * the checkpoint key and the `tile:` asset local id (`tile:p37-r0c1`).
   */
  tileId: string;
  /** The tile's region of the page in normalised `[x1,y1,x2,y2]` coordinates. */
  bbox: BBox;
}

/** The full grid: the tiles plus the render DPI and the grid dimensions. */
export interface TileGrid {
  cols: number;
  rows: number;
  /** DPI each tile is rendered at (higher than the whole-page DPI). */
  dpi: number;
  tiles: Tile[];
  /** True when the grid is a single full-page tile (i.e. the page is not tiled). */
  singleTile: boolean;
}

/**
 * True when a page should be tiled (design §5 S6, requirement 8.5): it is
 * classified as a `drawing`, or its long edge exceeds A3. Pure and matches the
 * classifier's own large-format threshold so the two never disagree.
 */
export function shouldTilePage(pageClass: PageClass | undefined, size: PageSizePt): boolean {
  if (pageClass === "drawing") return true;
  const longEdge = Math.max(size.widthPt, size.heightPt);
  return longEdge > A3_LONG_EDGE_PT;
}

/** The page's long/short edge in inches; `null` when the size is unusable. */
function edgesInInches(size: PageSizePt): { longIn: number; shortIn: number } | null {
  const widthIn = size.widthPt / POINTS_PER_INCH;
  const heightIn = size.heightPt / POINTS_PER_INCH;
  if (!(widthIn > 0) || !(heightIn > 0)) return null;
  return { longIn: Math.max(widthIn, heightIn), shortIn: Math.min(widthIn, heightIn) };
}

/**
 * Plan the tile grid for a page (design §5 S6, task 5.1). Deterministic: the
 * same page size and options always yield the same grid.
 *
 * A page that fits under the tile target in both dimensions — or has an
 * unusable size — returns a single full-page tile (`singleTile: true`), so a
 * normal-sized page never actually splits even when it is routed through the
 * tiling stage.
 */
export function planTiles(size: PageSizePt, options: TilingOptions): TileGrid {
  const {
    tileTargetPixels,
    overlapFraction,
    maxTiles,
    maxPixels,
    minDpi = 72,
  } = options;

  const edges = edgesInInches(size);
  // No usable size, or the target/limits are degenerate: fall back to one tile.
  if (edges === null || tileTargetPixels <= 0 || maxTiles < 1) {
    return singleTileGrid(size, { maxPixels, minDpi });
  }

  const widthIn = size.widthPt / POINTS_PER_INCH;
  const heightIn = size.heightPt / POINTS_PER_INCH;

  // How many tiles each axis wants so a tile's long edge lands near the target.
  // A tile's target physical edge is `tileTargetPixels` at a nominal reference
  // DPI (TILE_REFERENCE_DPI): the "overview at model DPI" scale of design §5
  // S6. The number of columns tracks the page width, rows the height; a page
  // whose edge is under one tile edge stays at 1 on that axis. The actual
  // render DPI is chosen separately in `tileDpi` so tiles are sharper than the
  // page; this ratio only sizes the grid and is deterministic.
  const tileEdgeIn = tileTargetPixels / TILE_REFERENCE_DPI;
  let cols = Math.max(1, Math.ceil(widthIn / tileEdgeIn));
  let rows = Math.max(1, Math.ceil(heightIn / tileEdgeIn));

  // Budget guard: cap cols × rows ≤ maxTiles, shrinking the larger axis first so
  // the grid stays as square as the page allows.
  ({ cols, rows } = capTileCount(cols, rows, maxTiles));

  if (cols === 1 && rows === 1) {
    return singleTileGrid(size, { maxPixels, minDpi });
  }

  // A single tile covers 1/cols × 1/rows of the page. Choose the DPI so that
  // tile's rendered area stays under the pixel ceiling.
  const tileWidthIn = widthIn / cols;
  const tileHeightIn = heightIn / rows;
  const dpi = tileDpi(tileWidthIn, tileHeightIn, tileTargetPixels, maxPixels, minDpi);

  const tiles = buildTiles(cols, rows, overlapFraction);
  return { cols, rows, dpi, tiles, singleTile: false };
}

/** Cap `cols × rows` at `maxTiles`, shrinking the larger axis first. */
function capTileCount(cols: number, rows: number, maxTiles: number): { cols: number; rows: number } {
  while (cols * rows > maxTiles) {
    if (cols >= rows && cols > 1) cols -= 1;
    else if (rows > 1) rows -= 1;
    else break; // both at 1 (maxTiles < 1 handled by the caller)
  }
  return { cols, rows };
}

/** Choose a tile's render DPI so its area stays under the pixel ceiling. */
function tileDpi(
  tileWidthIn: number,
  tileHeightIn: number,
  tileTargetPixels: number,
  maxPixels: number,
  minDpi: number,
): number {
  const tileLongEdgeIn = Math.max(tileWidthIn, tileHeightIn);
  const tileAreaIn2 = Math.max(tileWidthIn * tileHeightIn, 1e-9);
  // DPI that lands the tile's long edge on the target pixel count.
  const dpiForTarget = tileTargetPixels / Math.max(tileLongEdgeIn, 1e-9);
  // DPI that lands the tile's total pixels on the ceiling (pixels grow with dpi²).
  const dpiForCeiling = Math.sqrt(maxPixels / tileAreaIn2);
  const dpi = Math.min(dpiForTarget, dpiForCeiling);
  return Math.max(minDpi, Math.floor(dpi));
}

/**
 * Build the tile bboxes for a `cols × rows` grid with `overlapFraction` overlap.
 * Each cell spans `1/cols × 1/rows`; the overlap extends a cell outward by
 * `overlapFraction` of a cell's own size on each interior edge, then clamps to
 * `[0,1]`. Tiles are emitted in row-major order (r0c0, r0c1, …).
 */
function buildTiles(cols: number, rows: number, overlapFraction: number): Tile[] {
  const overlap = Math.max(0, Math.min(0.5, overlapFraction));
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const padX = cellW * overlap;
  const padY = cellH * overlap;
  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x1 = clamp01(col * cellW - padX);
      const y1 = clamp01(row * cellH - padY);
      const x2 = clamp01((col + 1) * cellW + padX);
      const y2 = clamp01((row + 1) * cellH + padY);
      tiles.push({
        col,
        row,
        tileId: `r${row}c${col}`,
        bbox: [x1, y1, x2, y2],
      });
    }
  }
  return tiles;
}

/** A one-tile grid covering the whole page — the "not tiled" result. */
function singleTileGrid(
  size: PageSizePt,
  opts: { maxPixels: number; minDpi: number },
): TileGrid {
  const edges = edgesInInches(size);
  // Whole-page DPI under the ceiling; falls back to the floor for a bad size.
  const dpi =
    edges === null
      ? opts.minDpi
      : Math.max(
          opts.minDpi,
          Math.floor(Math.sqrt(opts.maxPixels / Math.max(edges.longIn * edges.shortIn, 1e-9))),
        );
  return {
    cols: 1,
    rows: 1,
    dpi,
    tiles: [{ col: 0, row: 0, tileId: "r0c0", bbox: [0, 0, 1, 1] }],
    singleTile: true,
  };
}

/** Clamp a number into the normalised `[0,1]` range. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Choose the tile a zoom region should be served from (design §5 S6, task 5.1,
 * requirement 14.4: "zoom preferably via tiles"). Given a requested region
 * and a tile grid, returns the SMALLEST tile whose bbox fully contains the
 * region, or `null` when no single tile contains it (the region spans a seam,
 * or the grid is a single full-page tile). Pure.
 *
 * A hit means the render can be served from that one tile's region — a small,
 * already-sharp crop — instead of re-rendering the whole large-format page,
 * which is the entire point of tiling the plan in the first place.
 */
export function tileForRegion(region: BBox, grid: TileGrid): Tile | null {
  if (grid.singleTile) return null;
  let best: Tile | null = null;
  let bestArea = Infinity;
  for (const tile of grid.tiles) {
    if (!contains(tile.bbox, region)) continue;
    const area = bboxArea(tile.bbox);
    if (area < bestArea) {
      best = tile;
      bestArea = area;
    }
  }
  return best;
}

/** True when `outer` fully contains `inner` (both normalised `[x1,y1,x2,y2]`). */
function contains(outer: BBox, inner: BBox): boolean {
  return (
    inner[0] >= outer[0] &&
    inner[1] >= outer[1] &&
    inner[2] <= outer[2] &&
    inner[3] <= outer[3]
  );
}

/** The normalised area of a bbox. */
function bboxArea(bbox: BBox): number {
  return Math.max(0, bbox[2] - bbox[0]) * Math.max(0, bbox[3] - bbox[1]);
}
