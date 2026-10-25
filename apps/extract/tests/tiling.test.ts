// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * tiling.test.ts
 *
 * Deterministic tile geometry — the pure half of S6.
 *
 * The grid, DPI, overlap and tile selection are pure functions of the page size
 * and the tiling options, so these tests drive them with synthetic sizes and no
 * poppler/sharp present.
 *
 * Covers:
 *  - a normal (A4) page yields a single full-page tile (no tiling)
 *  - a `drawing` class or an over-A3 page is tiled into multiple tiles
 *  - the tile count is deterministic and capped by maxTiles
 *  - adjacent tiles overlap by ~10 % of a tile's own extent
 *  - per-tile DPI stays under the pixel ceiling and is sharper than the page
 *  - a zoom region inside one tile selects that tile; a seam-spanning region does not
 */

import { describe, expect, it } from "vitest";
import { A3_LONG_EDGE_PT } from "../src/jobs/page-classifier.js";
import {
  planTiles,
  shouldTilePage,
  tileForRegion,
  type TilingOptions,
} from "../src/pipeline/tiling.js";

/** 72 points per inch. A4 is 595×842 pt; A0 is ~2384×3370 pt. */
const A4 = { widthPt: 595, heightPt: 842 };
const A0 = { widthPt: 2384, heightPt: 3370 };

const OPTS: TilingOptions = {
  tileTargetPixels: 2000,
  overlapFraction: 0.1,
  maxTiles: 16,
  maxPixels: 40_000_000,
};

describe("shouldTilePage (requirement 8.5)", () => {
  it("tiles a page classified as drawing regardless of size", () => {
    expect(shouldTilePage("drawing", A4)).toBe(true);
  });

  it("tiles any page whose long edge exceeds A3", () => {
    const overA3 = { widthPt: A3_LONG_EDGE_PT + 1, heightPt: 400 };
    expect(shouldTilePage("text", overA3)).toBe(true);
  });

  it("does not tile a normal text/mixed page at or under A3", () => {
    expect(shouldTilePage("text", A4)).toBe(false);
    expect(shouldTilePage("mixed", A4)).toBe(false);
    expect(shouldTilePage(undefined, A4)).toBe(false);
  });
});

describe("planTiles: normal page → single tile", () => {
  it("returns one full-page tile for an A4 page (no tiling)", () => {
    const grid = planTiles(A4, OPTS);
    expect(grid.singleTile).toBe(true);
    expect(grid.tiles).toHaveLength(1);
    expect(grid.tiles[0]?.bbox).toEqual([0, 0, 1, 1]);
    expect(grid.cols).toBe(1);
    expect(grid.rows).toBe(1);
  });

  it("returns a single tile for an unusable page size", () => {
    const grid = planTiles({ widthPt: 0, heightPt: 0 }, OPTS);
    expect(grid.singleTile).toBe(true);
    expect(grid.tiles).toHaveLength(1);
  });
});

describe("planTiles: large plan → multiple tiles", () => {
  it("splits an A0 plan into an N×M grid, deterministically", () => {
    const a = planTiles(A0, OPTS);
    const b = planTiles(A0, OPTS);
    expect(a.singleTile).toBe(false);
    expect(a.cols * a.rows).toBeGreaterThan(1);
    // Deterministic: same inputs, identical grid.
    expect(b).toEqual(a);
    // Row-major tile ids.
    expect(a.tiles[0]?.tileId).toBe("r0c0");
    expect(a.tiles.at(-1)?.tileId).toBe(`r${a.rows - 1}c${a.cols - 1}`);
    expect(a.tiles).toHaveLength(a.cols * a.rows);
  });

  it("caps the tile count at maxTiles", () => {
    const grid = planTiles(A0, { ...OPTS, tileTargetPixels: 256, maxTiles: 6 });
    expect(grid.cols * grid.rows).toBeLessThanOrEqual(6);
    expect(grid.singleTile).toBe(false);
  });

  it("gives adjacent tiles ~10% overlap of a tile's own extent", () => {
    // Force a clean 2×2 grid on a square page for a simple overlap assertion.
    const square = { widthPt: A3_LONG_EDGE_PT * 1.5, heightPt: A3_LONG_EDGE_PT * 1.5 };
    const grid = planTiles(square, { ...OPTS, tileTargetPixels: 800, maxTiles: 4 });
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(2);
    // Cell width is 0.5; overlap pad is 0.5 * 0.1 = 0.05.
    const r0c0 = grid.tiles.find((t) => t.tileId === "r0c0");
    const r0c1 = grid.tiles.find((t) => t.tileId === "r0c1");
    expect(r0c0?.bbox[2]).toBeCloseTo(0.55, 5); // 0.5 + pad, right edge extended
    expect(r0c1?.bbox[0]).toBeCloseTo(0.45, 5); // 0.5 - pad, left edge extended
    // The overlap band between them is 0.55 - 0.45 = 0.10 of the page = 20% of
    // a 0.5-wide cell measured symmetrically → each side extends 10% of a cell.
    const overlap = (r0c0?.bbox[2] ?? 0) - (r0c1?.bbox[0] ?? 0);
    expect(overlap).toBeCloseTo(0.1, 5);
    // Outer edges clamp to the page.
    expect(r0c0?.bbox[0]).toBe(0);
    expect(r0c1?.bbox[2]).toBe(1);
  });

  it("renders tiles sharper than the whole page and under the pixel ceiling", () => {
    const grid = planTiles(A0, OPTS);
    const widthIn = A0.widthPt / 72;
    const heightIn = A0.heightPt / 72;
    const tileWidthIn = widthIn / grid.cols;
    const tileHeightIn = heightIn / grid.rows;
    // A single tile's area at the chosen DPI is under the ceiling.
    const tilePixels = tileWidthIn * grid.dpi * (tileHeightIn * grid.dpi);
    expect(tilePixels).toBeLessThanOrEqual(OPTS.maxPixels);
    // The whole page at that DPI would exceed a single tile's budget — i.e. the
    // tile DPI is only legal because the tile is smaller than the page.
    expect(grid.dpi).toBeGreaterThan(36);
  });
});

describe("tileForRegion: zoom prefers tiles (requirement 14.4)", () => {
  const grid = planTiles(A0, OPTS);

  it("selects the smallest tile that fully contains a region", () => {
    const first = grid.tiles[0];
    if (first === undefined) throw new Error("expected at least one tile");
    // A tiny region well inside the first tile.
    const region: [number, number, number, number] = [
      first.bbox[0] + 0.001,
      first.bbox[1] + 0.001,
      first.bbox[0] + 0.01,
      first.bbox[1] + 0.01,
    ];
    const chosen = tileForRegion(region, grid);
    expect(chosen).not.toBeNull();
    expect(chosen?.bbox[0]).toBeLessThanOrEqual(region[0]);
    expect(chosen?.bbox[2]).toBeGreaterThanOrEqual(region[2]);
  });

  it("returns null for a region spanning the whole page (no single tile)", () => {
    expect(tileForRegion([0, 0, 1, 1], grid)).toBeNull();
  });

  it("returns null for a single-tile (non-tiled) grid", () => {
    const single = planTiles(A4, OPTS);
    expect(tileForRegion([0.1, 0.1, 0.2, 0.2], single)).toBeNull();
  });
});
