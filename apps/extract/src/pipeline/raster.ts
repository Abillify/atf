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
import { boundingBoxToPixels, type BoundingBox, type FigureMimeType } from "@atf/extract-contract";
import { conversionFailed } from "../errors.js";

/**
 * Guard against decompression bombs.
 *
 * A 100 KiB PNG can declare 30 000 × 30 000 pixels and allocate ~3.6 GiB when
 * decoded. `MAX_UPLOAD_BYTES` does not catch that, because the bomb is small on
 * the wire; the limit has to be on decoded pixels.
 */
const MAX_PIXELS = 40_000_000; // ~40 MP, comfortably above an A0 page at 300 dpi

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
  const image = sharp(buffer, { failOn: "error", limitInputPixels: MAX_PIXELS });
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
