// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for server-side asset variant generation (task 1.11, Req 14.1).
 * These exercise the real sharp/libvips pipeline on synthetic PNGs — no DB.
 */

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  generateDerivedVariants,
  isAssetVariant,
  probeImageSize,
  resizeToEdge,
  VARIANT_MAX_EDGE,
} from "../src/asset-variants.js";

/** A solid-colour PNG of the requested pixel size. */
async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .jpeg()
    .toBuffer();
}

describe("asset-variants", () => {
  it("recognises the three variant names", () => {
    expect(isAssetVariant("thumb")).toBe(true);
    expect(isAssetVariant("preview")).toBe(true);
    expect(isAssetVariant("full")).toBe(true);
    expect(isAssetVariant("original")).toBe(false);
    expect(isAssetVariant(42)).toBe(false);
  });

  it("probes image dimensions", async () => {
    const png = await makePng(640, 480);
    expect(await probeImageSize(png)).toEqual({ width: 640, height: 480 });
  });

  it("returns null probing non-image bytes", async () => {
    expect(await probeImageSize(Buffer.from("not an image"))).toBeNull();
  });

  it("downscales the longest edge within the budget and never enlarges", async () => {
    const png = await makePng(4000, 2000);
    const thumb = await resizeToEdge(png, VARIANT_MAX_EDGE.thumb, "image/png");
    expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(VARIANT_MAX_EDGE.thumb);
    // 2:1 aspect ratio preserved → 512 x 256.
    expect(thumb.width).toBe(512);
    expect(thumb.height).toBe(256);

    // A small source is not enlarged.
    const small = await makePng(100, 80);
    const notEnlarged = await resizeToEdge(small, VARIANT_MAX_EDGE.preview, "image/png");
    expect(notEnlarged.width).toBe(100);
    expect(notEnlarged.height).toBe(80);
  });

  it("keeps PNG source as PNG and emits WebP for JPEG", async () => {
    const png = await resizeToEdge(await makePng(1000, 1000), 512, "image/png");
    expect(png.mimeType).toBe("image/png");
    const jpeg = await resizeToEdge(await makeJpeg(1000, 1000), 512, "image/jpeg");
    expect(jpeg.mimeType).toBe("image/webp");
  });

  it("generates thumb (512) and preview (1568) derived variants", async () => {
    const original = await makePng(3136, 1568); // 2:1, larger than preview edge
    const variants = await generateDerivedVariants(original, "image/png");
    const thumb = variants.find((v) => v.variant === "thumb");
    const preview = variants.find((v) => v.variant === "preview");

    expect(variants.map((v) => v.variant).sort()).toEqual(["preview", "thumb"]);
    expect(thumb && Math.max(thumb.width, thumb.height)).toBe(512);
    expect(preview && Math.max(preview.width, preview.height)).toBe(1568);
    for (const v of variants) {
      expect(v.data.length).toBeGreaterThan(0);
    }
  });

  it("throws on an undecodable image so a bad upload fails closed", async () => {
    await expect(generateDerivedVariants(Buffer.from("garbage"), "image/png")).rejects.toThrow();
  });
});
