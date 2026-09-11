// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * End-to-end pipeline tests that need no external binaries.
 *
 * The image path is used deliberately: PNG goes through sharp rather than
 * LibreOffice and poppler, so this exercises the real orchestrator, the real
 * response parser, real crop geometry and real contract serialisation on any
 * machine — including CI, where `pdftoppm` is not installed. Only the vision call
 * is stubbed, because that is the one step that is genuinely remote.
 *
 * The crop-geometry assertion here is the regression test for the defect this
 * service replaces: the previous cropper read `[x1, y1, x2, y2]` as
 * `[x, y, w, h]`, so every crop of a figure not starting at the page origin was
 * of the wrong region — and looked plausible.
 */

import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { validateDocument } from "@atf/extract-contract";
import { createExtractor, type ExtractorConfig } from "../src/pipeline/extract.js";
import { normalizeImageToPage } from "../src/pipeline/raster.js";
import type { VisionClient } from "../src/vision/client.js";
import { visionUnavailable } from "../src/errors.js";
import { testLogger } from "./helpers.js";

const CONFIG: ExtractorConfig = {
  renderDpi: 200,
  figureDpi: 300,
  maxPages: 0,
  tempDir: "",
  pageLabel: "Seite",
  libreofficeBin: "libreoffice",
  popplerBinDir: null,
  pageConcurrency: 2,
  visionModel: "test-vlm",
};

const noopMetrics = {
  recordPage: vi.fn(),
  recordVision: vi.fn(),
  recordFigures: vi.fn(),
};

/** A 400×300 PNG with a distinguishable region, so a crop can be verified. */
async function testPng(width = 400, height = 300): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
}

/** A valid 2×2 24-bit BMP used to exercise magic-byte admission and Sharp decoding. */
function tinyBmp(): Buffer {
  const rowSize = 8; // two BGR pixels plus two bytes padding
  const pixelBytes = rowSize * 2;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(2, 18);
  buffer.writeInt32LE(2, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  // Bottom row red/green, top row blue/white (BGR byte order).
  Buffer.from([0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0]).copy(
    buffer,
    54,
  );
  return buffer;
}

/** A vision client returning a fixed page response. */
function fixedVision(raw: string, truncated = false): VisionClient {
  return {
    async analyzePage() {
      return {
        raw,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        requests: 1,
        truncated,
        maxTokens: 8192,
      };
    },
    async probe() {
      return { available: true };
    },
  };
}

const WITH_FIGURE = `<summary>Eine Seite mit einer Abbildung.</summary>
<figures>
<figure id="1" bbox="[0.5000, 0.2500, 1.0000, 0.7500]">Diagramm in der rechten Seitenhälfte.</figure>
</figures>
<markdown>
# Titel

Text vor der Abbildung.

![figure_1]
</markdown>`;

function extractor(vision: VisionClient, config: Partial<ExtractorConfig> = {}) {
  return createExtractor({
    config: { ...CONFIG, ...config },
    logger: testLogger,
    vision,
    metrics: noopMetrics,
  });
}

describe("image extraction", () => {
  it("produces a contract-valid single-page document", async () => {
    const result = await extractor(fixedVision(WITH_FIGURE)).extract({
      buffer: await testPng(),
      filename: "screenshot.png",
      declaredMimeType: "image/png",
      reference: "tests/screenshot.png",
    });

    expect(validateDocument(result.document).filter((i) => i.severity === "error")).toEqual([]);
    expect(result.document.pageCount).toBe(1);
    expect(result.document.source.mimeType).toBe("image/png");
    expect(result.document.pipeline.extractor).toBe("sharp");
    expect(result.document.pipeline.visionModel).toBe("test-vlm");
  });

  it("serializes to the canonical form", async () => {
    const result = await extractor(fixedVision(WITH_FIGURE)).extract({
      buffer: await testPng(),
      filename: "screenshot.png",
      declaredMimeType: "image/png",
      reference: "tests/screenshot.png",
    });

    expect(result.markdown).toContain("## Seite 1");
    expect(result.markdown).toContain("<summary>Eine Seite mit einer Abbildung.</summary>");
    expect(result.markdown).toContain('<figure id="p1-f1" bbox="[0.5000, 0.2500, 1.0000, 0.7500]" page="1">');
    expect(result.markdown).toContain("![figure_p1-f1]");
    // The marker order that keeps Search attributing the figure to this page.
    expect(result.markdown.indexOf("<figures>")).toBeLessThan(result.markdown.indexOf("# Titel"));
  });

  it("reports the image path as OCR, because there was no text layer", async () => {
    // An uploaded image has no text layer by definition, so its text came out of
    // the pixels — and an operator comparing two ingests needs to see that.
    const result = await extractor(fixedVision(WITH_FIGURE)).extract({
      buffer: await testPng(),
      filename: "screenshot.png",
      declaredMimeType: "image/png",
      reference: "r",
    });
    expect(result.document.pipeline.ocr).toBe(true);
  });

  it("crops the region the bbox names, as x1/y1/x2/y2", async () => {
    // bbox [0.5, 0.25, 1.0, 0.75] of a 400×300 page is 200×150 at (200, 75).
    // Read as [x, y, w, h] it would have been 400×225 at (200, 75) — clipped, and
    // of the wrong region. That was the previous behaviour.
    const result = await extractor(fixedVision(WITH_FIGURE)).extract({
      buffer: await testPng(400, 300),
      filename: "screenshot.png",
      declaredMimeType: "image/png",
      reference: "r",
    });

    const crop = result.crops.get("p1-f1");
    expect(crop).toBeDefined();
    expect(crop?.width).toBe(200);
    expect(crop?.height).toBe(150);
    const metadata = await sharp(crop?.buffer as Buffer).metadata();
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(150);
  });

  it("records the crop's checksum and size on the figure", async () => {
    const result = await extractor(fixedVision(WITH_FIGURE)).extract({
      buffer: await testPng(),
      filename: "s.png",
      declaredMimeType: "image/png",
      reference: "r",
    });
    const figure = result.document.pages[0]?.figures[0];
    expect(figure?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(figure?.bytes).toBeGreaterThan(0);
  });

  it("keeps a figure with no geometry and falls back to the whole page", async () => {
    // The description is still the only retrievable text for the figure, so
    // dropping it for a geometry problem would lose real information.
    const raw = '<figures><figure id="1">Ohne Geometrie</figure></figures><markdown>Text</markdown>';
    const result = await extractor(fixedVision(raw)).extract({
      buffer: await testPng(),
      filename: "s.png",
      declaredMimeType: "image/png",
      reference: "r",
    });

    const figure = result.document.pages[0]?.figures[0];
    expect(figure?.description).toBe("Ohne Geometrie");
    expect(figure?.bbox).toEqual([0, 0, 1, 1]);
    expect(result.crops.has("p1-f1")).toBe(true);
    expect(result.document.warnings.join(" ")).toMatch(/keine verwertbare Bounding-Box/);
    expect(validateDocument(result.document).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("surfaces a truncated model response as a document warning", async () => {
    const result = await extractor(fixedVision("<markdown>abgeschnitten", true)).extract({
      buffer: await testPng(),
      filename: "s.png",
      declaredMimeType: "image/png",
      reference: "r",
    });
    expect(result.document.warnings.join(" ")).toMatch(/abgeschnitten/);
    // Partial content is still indexed.
    expect(result.document.pages[0]?.markdown).toContain("abgeschnitten");
  });

  it("keeps the document when a page fails outright", async () => {
    // Failing the document would throw away pages already paid for.
    const failing: VisionClient = {
      analyzePage: async () => {
        throw visionUnavailable("model down");
      },
      probe: async () => ({ available: true }),
    };
    const result = await extractor(failing).extract({
      buffer: await testPng(),
      filename: "s.png",
      declaredMimeType: "image/png",
      reference: "r",
    });

    expect(result.document.pageCount).toBe(1);
    expect(result.document.pages[0]?.markdown).toBe("");
    expect(result.document.warnings.join(" ")).toMatch(/konnte nicht konvertiert werden/);
  });

  it("refuses an unsupported type before spawning anything", async () => {
    await expect(
      extractor(fixedVision(WITH_FIGURE)).extract({
        buffer: Buffer.from("plain text"),
        filename: "notes.txt",
        declaredMimeType: "text/plain",
        reference: "r",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("does not re-render an image page for crops", async () => {
    // There is no higher-resolution source for an uploaded image, so FIGURE_DPI
    // cannot improve on it and re-rendering would be waste.
    const result = await extractor(fixedVision(WITH_FIGURE), { figureDpi: 600 }).extract({
      buffer: await testPng(400, 300),
      filename: "s.png",
      declaredMimeType: "image/png",
      reference: "r",
    });
    expect(result.crops.get("p1-f1")?.width).toBe(200);
  });
});

describe("normalizeImageToPage", () => {
  it("flattens transparency onto white", async () => {
    // A transparent screenshot otherwise renders black-on-black once a model's
    // preprocessing drops the alpha channel, which reads as a blank page.
    const transparent = await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const page = await normalizeImageToPage(transparent);
    const { channels } = await sharp(page.buffer).metadata();
    expect(channels).toBe(3);
    expect(page.width).toBe(10);
    expect(page.height).toBe(10);
  });

  it("normalises GIF to PNG, since not every endpoint accepts GIF", async () => {
    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#123456" },
    })
      .gif()
      .toBuffer();
    const page = await normalizeImageToPage(gif);
    expect(page.mimeType).toBe("image/png");
  });

  it("normalises TIFF, BMP and WebP through the same single-page path", async () => {
    const png = await testPng(8, 8);
    const variants = [
      { buffer: await sharp(png).tiff().toBuffer(), filename: "scan.tiff", mimeType: "image/tiff" },
      { buffer: tinyBmp(), filename: "scan.bmp", mimeType: "image/bmp" },
      { buffer: await sharp(png).webp().toBuffer(), filename: "scan.webp", mimeType: "image/webp" },
    ];

    for (const variant of variants) {
      const result = await extractor(fixedVision(WITH_FIGURE)).extract({
        buffer: variant.buffer,
        filename: variant.filename,
        declaredMimeType: variant.mimeType,
        reference: variant.filename,
      });
      expect(result.document.source.mimeType).toBe(variant.mimeType);
      expect(result.document.pipeline.extractor).toBe("sharp");
      expect(result.document.pageCount).toBe(1);
      expect(result.document.pipeline.ocr).toBe(true);
    }
  });

  it("rejects a BMP above its decoded-memory budget before decoding pixels", async () => {
    const bomb = tinyBmp();
    bomb.writeInt32LE(5000, 18);
    bomb.writeInt32LE(5000, 22);
    await expect(normalizeImageToPage(bomb)).rejects.toMatchObject({
      code: "CONVERSION_FAILED",
      message: expect.stringMatching(/10000000 pixel limit/),
    });
  });

  it("reports aggregate model usage and timing", async () => {
    const result = await extractor(fixedVision(WITH_FIGURE)).extract({
      buffer: await testPng(),
      filename: "usage.png",
      declaredMimeType: "image/png",
      reference: "usage",
    });

    expect(result.document.usage).toEqual({
      requests: 1,
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
    });
    expect(result.document.timings?.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.document.timings?.perPageVisionMs).toHaveLength(1);
  });

  it("rejects an undecodable image with a client error", async () => {
    await expect(normalizeImageToPage(Buffer.from("not an image"))).rejects.toMatchObject({
      code: "CONVERSION_FAILED",
    });
  });
});
