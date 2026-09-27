// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * raster.ts
 *
 * Image handling: normalising an uploaded image into a page, and cutting figure
 * crops out of a rendered page.
 *
 * This is where the geometry bug in the pipeline this replaces lived. The
 * previous cropper computed `crop((left, upper, left + right, upper + lower))`
 * from a box the prompt documented as `[x_min, y_min, x_max, y_max]` — reading
 * the last two numbers as width and height. Every crop was wrong unless the
 * figure happened to start at the page origin, and nothing failed loudly: the
 * output was a plausible-looking image of the wrong region.
 *
 * The fix is not a corrected formula here but a contract that states the
 * semantics once (`boundingBoxToPixels` in `@atf/extract-contract`) and is used
 * by every consumer. This module never does coordinate arithmetic of its own.
 */

import sharp, { type Metadata } from "sharp";
import { decode as decodeBmp } from "bmp-js";
import { boundingBoxToPixels, type BoundingBox, type FigureMimeType } from "@atf/extract-contract/v1";
import { conversionFailed } from "../errors.js";

/**
 * Guard against decompression bombs.
 *
 * A 100 KiB PNG can declare 30 000 × 30 000 pixels and allocate ~3.6 GiB when
 * decoded. `MAX_UPLOAD_BYTES` does not catch that, because the bomb is small on
 * the wire; the limit has to be on decoded pixels.
 */
// ~40 MP. This is a memory ceiling, not a paper-size statement: the earlier
// comment claimed it sat "comfortably above an A0 page at 300 dpi", which is
// simply wrong — A0 (841×1189 mm) at 300 dpi is ~140 MP, more than three times
// this. That is precisely why a large page must have its DPI adapted downward
// (see `adaptiveRenderDpi`) before it is rendered, rather than rendered at a
// fixed DPI and then rejected here for being too many pixels.
const MAX_PIXELS = 40_000_000;
// bmp-js expands to ABGR before we create Sharp's RGB input, so BMP needs a
// stricter budget to keep peak memory bounded under conversion concurrency.
const MAX_BMP_PIXELS = 10_000_000;

/**
 * The pixel ceiling a rendered PDF page must stay under.
 *
 * Shared with the renderer so the DPI chosen for a page and the limit enforced
 * on the resulting image are the same number, and a page can never be rendered
 * at a DPI that the very next decode step will reject as a decompression bomb.
 */
export const MAX_RENDER_PIXELS = MAX_PIXELS;

/**
 * The edge length, in pixels, that adaptive rendering aims a page's longer side
 * at. Chosen so ordinary A4/Letter pages still land near `RENDER_DPI` while a
 * poster-sized page is scaled down instead of dropped: at ~2400 px the long
 * edge of an A4 page (~11.7 in) works out to ~205 dpi, right at the knee where
 * small table text stops improving with resolution.
 */
const TARGET_LONG_EDGE_PX = 2400;

/** One inch is 72 PostScript points; poppler reports page size in points. */
const POINTS_PER_INCH = 72;

/**
 * Choose the DPI to rasterise a page at, given its size in PostScript points.
 *
 * Requirement 2.7: a page larger than A3 must have its DPI lowered so the
 * rendered image stays under the pixel limit, never dropped. The preferred DPI
 * (`RENDER_DPI`) is used as-is for ordinary pages; a large page is scaled down
 * on two independent grounds and the stricter wins:
 *
 *   1. a target for the longer edge, so a poster does not render at a resolution
 *      that produces a needlessly enormous image for the model, and
 *   2. the hard pixel ceiling `MAX_RENDER_PIXELS`, so the decode never trips the
 *      decompression-bomb guard.
 *
 * The result is clamped to `minDpi` so a genuinely vast page still yields a
 * legible-enough image rather than being scaled into a thumbnail.
 */
export function adaptiveRenderDpi(
  pageSize: { widthPt: number; heightPt: number },
  preferredDpi: number,
  options: { minDpi?: number; maxPixels?: number; targetLongEdgePx?: number } = {},
): number {
  const { minDpi = 72, maxPixels = MAX_RENDER_PIXELS, targetLongEdgePx = TARGET_LONG_EDGE_PX } =
    options;

  const widthIn = pageSize.widthPt / POINTS_PER_INCH;
  const heightIn = pageSize.heightPt / POINTS_PER_INCH;
  if (!(widthIn > 0) || !(heightIn > 0)) return preferredDpi;

  const longEdgeIn = Math.max(widthIn, heightIn);
  const areaIn2 = widthIn * heightIn;

  // DPI at which the longer edge hits the target pixel count.
  const dpiForLongEdge = targetLongEdgePx / longEdgeIn;
  // DPI at which the total pixel count hits the ceiling (pixels grow with dpi²).
  const dpiForPixelCeiling = Math.sqrt(maxPixels / areaIn2);

  const dpi = Math.min(preferredDpi, dpiForLongEdge, dpiForPixelCeiling);
  return Math.max(minDpi, Math.floor(dpi));
}

function isBmp(buffer: Uint8Array): boolean {
  return buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d;
}

/** Decode BMP explicitly because some Sharp/libvips builds omit the BMP loader. */
function bmpAsSharpInput(buffer: Uint8Array): {
  data: Buffer;
  raw: { width: number; height: number; channels: 3 };
} {
  if (buffer.byteLength < 26) throw conversionFailed("The BMP header is truncated");
  const source = Buffer.from(buffer);
  const headerSize = source.readUInt32LE(14);
  if (headerSize < 40 || source.byteLength < 54) {
    throw conversionFailed("The BMP uses an unsupported legacy header");
  }
  const width = source.readInt32LE(18);
  const signedHeight = source.readInt32LE(22);
  const height = Math.abs(signedHeight);
  if (width < 1 || height < 1 || width * height > MAX_BMP_PIXELS) {
    throw conversionFailed(
      `The BMP declares ${width}×${height} pixels, outside the ${MAX_BMP_PIXELS} pixel limit`,
    );
  }

  try {
    const decoded = decodeBmp(source);
    if (decoded.width !== width || decoded.height !== height) {
      throw new Error("decoded dimensions differ from the BMP header");
    }
    if (decoded.data.length !== width * height * 4) {
      throw new Error("decoded pixel data has an unexpected length");
    }
    const rgb = Buffer.alloc(width * height * 3);
    // bmp-js returns ABGR; Sharp raw input expects RGB.
    for (let sourceOffset = 0, targetOffset = 0; sourceOffset < decoded.data.length; sourceOffset += 4) {
      rgb[targetOffset++] = decoded.data[sourceOffset + 3] ?? 0;
      rgb[targetOffset++] = decoded.data[sourceOffset + 2] ?? 0;
      rgb[targetOffset++] = decoded.data[sourceOffset + 1] ?? 0;
    }
    return { data: rgb, raw: { width, height, channels: 3 } };
  } catch (error) {
    throw conversionFailed(
      `The BMP could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface RasterPage {
  /** Normalised image bytes. */
  buffer: Buffer;
  mimeType: FigureMimeType;
  width: number;
  height: number;
}

/**
 * Turn an uploaded image into a single page image for the model.
 *
 * Everything is converted to PNG rather than passed through. Two reasons: GIF is
 * not accepted by every vision endpoint and may be animated, in which case only
 * the first frame is meaningful; and a single output format means the rest of the
 * pipeline has one code path instead of a per-format branch.
 *
 * The alpha channel is flattened onto white. A screenshot with transparency
 * otherwise renders as black-on-black once the model's preprocessing drops the
 * channel, which reads as a blank page.
 */
export async function normalizeImageToPage(buffer: Uint8Array): Promise<RasterPage> {
  const decodedBmp = isBmp(buffer) ? bmpAsSharpInput(buffer) : null;
  const image =
    decodedBmp === null
      ? sharp(buffer, { failOn: "error", limitInputPixels: MAX_PIXELS })
      : sharp(decodedBmp.data, {
          raw: decodedBmp.raw,
          failOn: "error",
          limitInputPixels: MAX_PIXELS,
        });
  let metadata: Metadata;
  try {
    metadata = await image.metadata();
  } catch (error) {
    throw conversionFailed(
      `The image could not be decoded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1) {
    throw conversionFailed("The image reports no usable dimensions");
  }
  if (width * height > MAX_PIXELS) {
    throw conversionFailed(
      `The image declares ${width}×${height} pixels, above the ${MAX_PIXELS} pixel limit`,
    );
  }

  const normalized = await image.flatten({ background: "#ffffff" }).png().toBuffer();
  const info = await sharp(normalized).metadata();
  return {
    buffer: normalized,
    mimeType: "image/png",
    width: info.width ?? width,
    height: info.height ?? height,
  };
}

/** Dimensions of an already-rendered page, needed to resolve a normalised bbox. */
export async function imageSize(buffer: Uint8Array): Promise<{ width: number; height: number }> {
  const metadata = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 1 || height < 1) {
    throw conversionFailed("The rendered page reports no usable dimensions");
  }
  return { width, height };
}

export interface FigureCrop {
  buffer: Buffer;
  mimeType: FigureMimeType;
  width: number;
  height: number;
}

/**
 * Cut a figure out of a rendered page.
 *
 * Coordinates come from `boundingBoxToPixels`, which clamps to the page and
 * guarantees at least one pixel in each dimension — so a box the model reported
 * slightly outside the page produces a clipped crop rather than a sharp error.
 * The clamping happens in the contract, deliberately, so the producer and any
 * future consumer resolve the same box to the same pixels.
 */
export async function cropFigure(
  pageBuffer: Uint8Array,
  bbox: BoundingBox,
  pageSize: { width: number; height: number },
): Promise<FigureCrop> {
  const region = boundingBoxToPixels(bbox, pageSize.width, pageSize.height);
  try {
    const buffer = await sharp(pageBuffer, { limitInputPixels: MAX_PIXELS })
      .extract(region)
      .png()
      .toBuffer();
    return { buffer, mimeType: "image/png", width: region.width, height: region.height };
  } catch (error) {
    throw conversionFailed(
      `Cropping a figure failed: ${error instanceof Error ? error.message : String(error)}`,
      { region, pageSize },
    );
  }
}

/** Base64 data URL, the form an OpenAI-compatible vision endpoint expects. */
export function toDataUrl(buffer: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(buffer).toString("base64")}`;
}
