// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * asset-variants.ts
 *
 * Server-side derived-variant generation for the v2 AssetStore. The `full`
 * variant is the original bytes as uploaded; two smaller variants are
 * derived with sharp/libvips:
 *
 *   - `thumb`   — the longest edge fits within 512 px
 *   - `preview` — the longest edge fits within 1568 px
 *
 * Both derived variants are produced eagerly on PUT (task 1.11 note) and stored
 * as their own vs_assets rows, so a GET for any variant is a pure read with no
 * image processing on the hot path.
 *
 * `sharp` is only imported here so the rest of the asset code (store, handlers)
 * stays dependency-light and unit-testable without libvips.
 */

import sharp from "sharp";

/** The three asset variants (Requirement 14.1). */
export type AssetVariant = "thumb" | "preview" | "full";

export const ASSET_VARIANTS: readonly AssetVariant[] = ["thumb", "preview", "full"];

/** The two derived variants and their longest-edge budget in pixels. */
export const VARIANT_MAX_EDGE: Readonly<Record<"thumb" | "preview", number>> = {
  thumb: 512,
  preview: 1568,
};

/** Guard against pathological inputs (mirrors the raster pipeline budget). */
const MAX_INPUT_PIXELS = 40_000_000;

export function isAssetVariant(value: unknown): value is AssetVariant {
  return value === "thumb" || value === "preview" || value === "full";
}

/** A generated variant: its bytes, mime type and pixel dimensions. */
export interface GeneratedVariant {
  variant: "thumb" | "preview";
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/** Probe an image's pixel dimensions without decoding it fully. */
export async function probeImageSize(
  data: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (typeof meta.width === "number" && typeof meta.height === "number") {
      return { width: meta.width, height: meta.height };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Downscale `data` so its longest edge fits within `maxEdge`, never enlarging a
 * smaller image (`withoutEnlargement`). The output keeps the source encoding
 * where sensible: PNG/GIF stay PNG (lossless UI masks, diagrams), everything
 * else is emitted as WebP to keep the derived variants small.
 */
export async function resizeToEdge(
  data: Buffer,
  maxEdge: number,
  sourceMime: string,
): Promise<{ data: Buffer; mimeType: string; width: number; height: number }> {
  const keepPng = sourceMime === "image/png" || sourceMime === "image/gif";
  const pipeline = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).resize({
    width: maxEdge,
    height: maxEdge,
    fit: "inside",
    withoutEnlargement: true,
  });
  const out = keepPng ? pipeline.png() : pipeline.webp({ quality: 82 });
  const { data: buffer, info } = await out.toBuffer({ resolveWithObject: true });
  return {
    data: buffer,
    mimeType: keepPng ? "image/png" : "image/webp",
    width: info.width,
    height: info.height,
  };
}

/**
 * Generate the `thumb` and `preview` variants from the original bytes. Returns
 * the two derived variants; the caller stores each as its own vs_assets row
 * alongside the `full` original. Throws if the input is not a decodable image.
 */
export async function generateDerivedVariants(
  original: Buffer,
  sourceMime: string,
): Promise<GeneratedVariant[]> {
  const results: GeneratedVariant[] = [];
  for (const variant of ["thumb", "preview"] as const) {
    const resized = await resizeToEdge(original, VARIANT_MAX_EDGE[variant], sourceMime);
    results.push({
      variant,
      data: resized.data,
      mimeType: resized.mimeType,
      width: resized.width,
      height: resized.height,
    });
  }
  return results;
}
