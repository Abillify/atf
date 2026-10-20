// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/render.ts
 *
 * `POST /v2/render` — render a page, or a bbox region of a page, ON DEMAND from
 * the content-addressed source (design §9a.1, requirements 6.8, 14.4).
 *
 * ## Why this route exists
 *
 * Full-resolution page images are NOT pre-stored — at 10 000 pages they are
 * 10–30 GB of derived bytes that reproduce deterministically from the one
 * durable source. So zoom, full-resolution and tile bytes are rendered here on
 * request, from the `SourceStore`, with the SAME poppler/sharp helpers the job
 * pipeline uses (`createPageRenderer`), and Search — which deliberately carries
 * no poppler — calls this endpoint and caches the result as an asset variant.
 *
 * ## The two limits are not optional
 *
 *   - **Pixel ceiling.** `RENDER_MAX_PIXELS` caps the output area. A caller who
 *     asks for a huge `targetPixels`, or crops a poster-sized page, has the
 *     render DPI clamped DOWN so the decode never allocates a gigapixel buffer.
 *     The clamp is silent (the response reports the actual size and dpi) rather
 *     than an error, so a legitimate over-ask still returns a usable image.
 *   - **Rate limit.** Each render spawns a poppler subprocess; a burst is CPU,
 *     not just bytes. The route sits behind its own limiter (`RENDER_RATE_LIMIT`)
 *     in addition to auth, so it cannot be used to exhaust the box.
 *
 * poppler stays an external process with `SUBPROCESS_TIMEOUT_MS` (requirement
 * 1.3), so a page that hangs its render turns into a timeout, not a wedged slot.
 *
 * ## Determinism
 *
 * Rendering the same `(source, page, bbox, targetPixels)` yields byte-stable
 * output: the source is content-addressed, the DPI is a pure function of the
 * page size and the (clamped) target, and poppler + sharp are deterministic at
 * a fixed DPI. That is what lets Search cache the result and treat a second
 * request as a pure read (design §9a.1 "deterministic intermediate states").
 */

import sharp from "sharp";
import type { Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import type { BoundingBox } from "@atf/extract-contract/v1";
import { renderRequestSchema, type RenderResult } from "@atf/extract-contract";
import { conversionFailed, notFound, validationError } from "../errors.js";
import type { SourceStore } from "../source-store.js";
import type { PageRenderer } from "../jobs/page-renderer.js";
import { adaptiveRenderDpi, MAX_RENDER_PIXELS } from "../pipeline/raster.js";
import { planTiles, tileForRegion } from "../pipeline/tiling.js";
import type { BBox } from "@atf/extract-contract/v2";

/** Config slice the render handler needs. */
export interface RenderHandlerConfig {
  /** Preferred DPI for a whole-page render (mirrors the pipeline `RENDER_DPI`). */
  renderDpi: number;
  /** Preferred DPI for a region/zoom render (mirrors `FIGURE_DPI`). */
  figureDpi: number;
  /**
   * Hard ceiling on the rendered output area in pixels. A `targetPixels` or a
   * tiny crop that would exceed this has its DPI clamped down. Never above the
   * shared render budget so the decode step can never reject the result.
   */
  renderMaxPixels: number;
  /**
   * The long edge, in pixels, a single tile of a large-format page is planned
   * towards (TILE_TARGET_PIXELS; design §5 S6, task 5.1). Used to reconstruct
   * the same tile grid the job pipeline produced so a zoom region within a tile
   * is served from that tile rather than the whole page (requirement 14.4).
   */
  tileTargetPixels: number;
  /** The tile-overlap fraction (TILE_OVERLAP_FRACTION); mirrors the pipeline. */
  tileOverlapFraction: number;
  /** The per-page tile ceiling (TILE_MAX_PER_PAGE); mirrors the pipeline. */
  tileMaxPerPage: number;
}

export interface RenderHandlerDeps {
  sourceStore: SourceStore;
  /** The shared page renderer; `prepare` resolves the source and renders pages. */
  pageRenderer: PageRenderer;
  config: RenderHandlerConfig;
  logger: Logger;
}

/** 72 PostScript points per inch, matching the raster helper. */
const POINTS_PER_INCH = 72;

/** Lowercase hex sha256 — the content address of a stored source. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A file extension usable for format detection: a dot plus 1–10 ASCII alphanumerics. */
const SAFE_EXTENSION = /^\.[a-z0-9]{1,10}$/;

/**
 * Derive the renderer's `filename` from the caller's optional `filename`.
 *
 * The renderer uses the filename ONLY for format detection (the extension, as
 * a hint next to the magic-byte sniff) and for error details; the bytes are
 * always read from the content-addressed source store by sha256. The caller's
 * value is therefore never passed through: we keep only the extension of its
 * basename (both `/` and `\` are treated as separators, so no path component
 * survives), lower-cased and restricted to `[a-z0-9]{1,10}`, and name the file
 * after the source digest. Anything else falls back to `<sha256>.pdf` (the
 * previous default). The result can never contain a path separator, `..`, a
 * control character or an attacker-chosen name.
 */
export function renderFilename(source: string, filename: string | undefined): string {
  const fallback = `${source}.pdf`;
  if (typeof filename !== "string" || filename.length === 0 || filename.length > 1024) {
    return fallback;
  }
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return fallback;
  const ext = base.slice(dot).toLowerCase();
  return SAFE_EXTENSION.test(ext) ? `${source}${ext}` : fallback;
}

/**
 * Choose the render DPI that lands the result's LONG edge near `targetPixels`,
 * clamped so the output area never exceeds `maxPixels`.
 *
 * `pagePixels` is the page's size in pixels at 1 DPI-unit reference (its size in
 * points converted to inches); `regionFraction` is the fraction of that page a
 * bbox crop covers (1 for a whole page). The long edge we aim at is the
 * region's long edge, so a small crop is rendered at a HIGHER DPI to reach the
 * requested pixel count, while a whole poster page is scaled DOWN.
 */
export function chooseRenderDpi(args: {
  widthPt: number;
  heightPt: number;
  bbox: BoundingBox | null;
  preferredDpi: number;
  targetPixels: number | null;
  maxPixels: number;
}): number {
  const { widthPt, heightPt, bbox, preferredDpi, targetPixels, maxPixels } = args;
  const widthIn = widthPt / POINTS_PER_INCH;
  const heightIn = heightPt / POINTS_PER_INCH;
  if (!(widthIn > 0) || !(heightIn > 0)) return preferredDpi;

  // The region's extent in inches: the whole page, or the bbox slice of it.
  const regionWidthIn = bbox === null ? widthIn : widthIn * (bbox[2] - bbox[0]);
  const regionHeightIn = bbox === null ? heightIn : heightIn * (bbox[3] - bbox[1]);
  const regionLongEdgeIn = Math.max(regionWidthIn, regionHeightIn);
  const regionAreaIn2 = Math.max(regionWidthIn * regionHeightIn, 1e-9);

  // A target long edge chooses the DPI up (small crop) or down (whole page);
  // otherwise stay at the preferred DPI.
  let dpi =
    targetPixels !== null && regionLongEdgeIn > 0
      ? targetPixels / regionLongEdgeIn
      : preferredDpi;

  // Clamp DOWN so the region's rendered area never exceeds the pixel ceiling.
  const dpiForPixelCeiling = Math.sqrt(maxPixels / regionAreaIn2);
  dpi = Math.min(dpi, dpiForPixelCeiling);

  // Never render below a legible floor; a genuinely vast crop still yields a
  // usable image rather than a thumbnail.
  return Math.max(36, Math.floor(dpi));
}

/**
 * The long edge, in pixels, the rendered image should be resized to.
 *
 * Returns null when no resize is warranted (no target, and the base image is
 * already within the pixel ceiling). Otherwise it is the requested target long
 * edge, further clamped down so the resulting area — scaled by the base's
 * aspect ratio — never exceeds `maxPixels`. This is the resize twin of the DPI
 * clamp: even if the base render slipped above the ceiling, the final image is
 * brought back under it.
 */
export function resolveLongEdge(args: {
  baseLongEdge: number;
  baseWidth: number;
  baseHeight: number;
  targetPixels: number | null;
  maxPixels: number;
}): number | null {
  const { baseLongEdge, baseWidth, baseHeight, targetPixels, maxPixels } = args;
  const aspect = baseWidth >= baseHeight
    ? baseHeight / Math.max(baseWidth, 1)
    : baseWidth / Math.max(baseHeight, 1);
  // Long edge L gives an area of L * (L * aspect) = L² * aspect.
  const ceilingLongEdge = Math.max(1, Math.floor(Math.sqrt(maxPixels / Math.max(aspect, 1e-9))));

  if (targetPixels === null) {
    return baseLongEdge > ceilingLongEdge ? ceilingLongEdge : null;
  }
  return Math.min(targetPixels, ceilingLongEdge);
}

/**
 * Build the `POST /v2/render` handler. Mounted by `index.ts` behind its own
 * rate limiter plus the shared auth chain; the source must already be in the
 * content-addressed store (a job or an upload put it there), or the render is a
 * clean 404 rather than a render failure.
 */
export function createRenderHandler(deps: RenderHandlerDeps): RequestHandler {
  const { sourceStore, pageRenderer, config, logger } = deps;

  async function render(req: Request, res: Response): Promise<void> {
    const parsed = renderRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw validationError(
        `Invalid render request: ${parsed.error.issues[0]?.message ?? "bad body"}`,
        { issues: parsed.error.issues },
      );
    }
    const body = parsed.data;
    // Defence in depth: the contract schema already requires a lowercase hex
    // sha256, but the digest addresses the source store directly, so re-check
    // here rather than rely on the schema staying strict.
    if (!SHA256_HEX.test(body.source)) {
      throw validationError("Invalid render request: source must be a lowercase 64-character hex sha256", {
        field: "source",
      });
    }
    const bbox: BoundingBox | null =
      body.bbox !== undefined
        ? ([body.bbox[0], body.bbox[1], body.bbox[2], body.bbox[3]] as BoundingBox)
        : null;

    // A missing source is a create-time-style error: the caller must upload it
    // first. 404 keeps a probe cheap (no source read, no render).
    if (!(await sourceStore.has(body.source))) {
      throw notFound(`No stored source for sha256 ${body.source}; upload it first via /v2/uploads`);
    }

    // Cap the caller's target at the pixel ceiling BEFORE any render work, so an
    // absurd ask is bounded rather than clamped only after choosing a DPI.
    const targetPixels =
      body.targetPixels !== undefined
        ? Math.min(body.targetPixels, Math.floor(Math.sqrt(config.renderMaxPixels)))
        : null;
    const clamped = body.targetPixels !== undefined && targetPixels !== body.targetPixels;

    const prepared = await pageRenderer.prepare({
      sourceSha256: body.source,
      // Format hint only — never the caller's raw filename (see renderFilename).
      filename: renderFilename(body.source, body.filename),
      reference: body.source,
    });
    try {
      if (body.page > prepared.pageCount) {
        throw validationError(
          `Page ${body.page} is out of range; the source has ${prepared.pageCount} page(s)`,
          { page: body.page, pageCount: prepared.pageCount },
        );
      }

      // The page's size AS RENDERED, without rasterising it: one pdfinfo call
      // (a single image: its pixels at the nominal DPI). The DPI choice and the
      // tile grid both depend on this, and rendering the page first just to
      // learn it was the first of two renders per request.
      const sizePt = await prepared.pageSizePt(body.page);
      const { widthPt, heightPt } = sizePt;
      // ── Which tile the zoom region lies in (design §5 S6, requirement 14.4) ──
      // Reconstructs the grid the job pipeline planned for this page (a pure
      // function of the true page size) and names the tile that contains the
      // whole region, for `X-Render-Tile`. The region itself is rendered
      // directly at the DPI chosen below; the tile only reports where it lies.
      let servingTileId: string | null = null;
      if (bbox !== null) {
        const grid = planTiles(
          { widthPt, heightPt },
          {
            tileTargetPixels: config.tileTargetPixels,
            overlapFraction: config.tileOverlapFraction,
            maxTiles: config.tileMaxPerPage,
            maxPixels: config.renderMaxPixels,
          },
        );
        const tile = tileForRegion([bbox[0], bbox[1], bbox[2], bbox[3]] as BBox, grid);
        if (tile !== null) servingTileId = tile.tileId;
      }
      // A whole page without a target uses the SAME adaptive DPI as the job
      // pipeline's model page, so its bytes are what a job would have produced;
      // a region starts from FIGURE_DPI. A target (or the pixel ceiling) moves
      // either one.
      const preferredDpi =
        bbox === null ? adaptiveRenderDpi(sizePt, config.renderDpi) : config.figureDpi;
      const requestedDpi = chooseRenderDpi({
        widthPt,
        heightPt,
        bbox,
        preferredDpi,
        targetPixels,
        maxPixels: config.renderMaxPixels,
      });
      // ONE poppler call at the chosen DPI, rasterising only the region: the
      // result has the resolution that was asked for (and reported) instead of
      // a model-resolution page that is then cropped, re-rendered and scaled.
      const rendered = await prepared.renderRegion(body.page, {
        bbox,
        dpi: requestedDpi,
        sizePt,
        maxPixels: config.renderMaxPixels,
      });
      const base = rendered.image;
      // Scale DOWN to the target long edge when one was asked for. sharp is the
      // same encoder the pipeline uses; `fit: inside` preserves the aspect ratio.
      // A render never enlarges: a target above what the source can deliver
      // (a single image, or a rounding step) returns the pixels it has, and the
      // reported size and DPI say so. `targetPixels === null` keeps the base
      // bytes untouched. A pixel-ceiling breach is scaled down, not thrown.
      const longEdge = Math.max(base.width, base.height);
      const desiredLongEdge = resolveLongEdge({
        baseLongEdge: longEdge,
        baseWidth: base.width,
        baseHeight: base.height,
        targetPixels,
        maxPixels: config.renderMaxPixels,
      });

      let pngBytes: Uint8Array;
      let width: number;
      let height: number;
      if (desiredLongEdge !== null && desiredLongEdge < longEdge) {
        const resized = await sharp(base.buffer, { limitInputPixels: MAX_RENDER_PIXELS })
          .resize({
            width: base.width >= base.height ? desiredLongEdge : undefined,
            height: base.height > base.width ? desiredLongEdge : undefined,
            fit: "inside",
            withoutEnlargement: true,
          })
          .png()
          .toBuffer({ resolveWithObject: true });
        pngBytes = resized.data;
        width = resized.info.width;
        height = resized.info.height;
      } else {
        pngBytes = base.buffer;
        width = base.width;
        height = base.height;
      }

      // The resolution the delivered pixels really have: what the renderer
      // produced, scaled by any downsizing above.
      const dpi = Math.max(1, Math.round((rendered.dpi * width) / Math.max(base.width, 1)));
      // Final byte guard behind the DPI/resize clamp: never emit above ceiling.
      if (width * height > config.renderMaxPixels) {
        throw conversionFailed(
          `The rendered image is ${width}×${height}px, above the ${config.renderMaxPixels} pixel limit`,
          { width, height, maxPixels: config.renderMaxPixels },
        );
      }

      const meta: RenderResult = {
        source: body.source,
        page: body.page,
        bbox: bbox === null ? null : [bbox[0], bbox[1], bbox[2], bbox[3]],
        width,
        height,
        dpi,
        mimeType: "image/png",
      };

      logger.debug(
        {
          source: body.source,
          page: body.page,
          hasBbox: bbox !== null,
          width,
          height,
          dpi,
          clamped,
          ...(servingTileId !== null ? { tile: servingTileId } : {}),
        },
        servingTileId !== null
          ? "Rendered zoom region (lies within one tile)"
          : "Rendered page/region on demand",
      );

      // The PNG travels as the body; the metadata rides response headers so a
      // streaming client does not have to buffer JSON. `X-Render-Clamped` tells
      // a caller its target was reduced to the pixel ceiling.
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", String(pngBytes.length));
      res.setHeader("X-Render-Width", String(width));
      res.setHeader("X-Render-Height", String(height));
      res.setHeader("X-Render-Dpi", String(dpi));
      res.setHeader("X-Render-Clamped", clamped ? "1" : "0");
      // `X-Render-Tile` names the large-format tile a zoom region lies in, when
      // the region falls within one (requirement 14.4). Absent for a
      // whole-page render or a region that spans a seam / a non-tiled page.
      if (servingTileId !== null) res.setHeader("X-Render-Tile", servingTileId);
      res.setHeader("X-Render-Meta", JSON.stringify(meta));
      res.setHeader("Cache-Control", "private, no-store");
      res.status(200).send(Buffer.from(pngBytes));
    } finally {
      await prepared.close();
    }
  }

  return (req, res, next) => {
    void render(req, res).catch(next);
  };
}

/** The shared render pixel ceiling default, exported for config parsing/tests. */
export const DEFAULT_RENDER_MAX_PIXELS = MAX_RENDER_PIXELS;
