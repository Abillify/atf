// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Robust per-page processing for the PDF path (task 0.6, Requirements 2.7–2.9).
 *
 * The PDF branch of the orchestrator shells out to poppler, which is not present
 * on every machine and cannot be made to fail one specific page on demand with a
 * real binary. So the poppler operations are injected: a stub renders, sizes and
 * reads text without a subprocess, and can make a chosen page throw. This
 * exercises the real orchestrator — the page loop, the adaptive-DPI decision,
 * the per-page error path and document assembly — with only the process boundary
 * replaced.
 */

import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { validateDocument } from "@atf/extract-contract/v1";
import {
  createExtractor,
  type ExtractorConfig,
  type PdfOps,
} from "../src/pipeline/extract.js";
import {
  adaptiveRenderDpi,
  MAX_RENDER_PIXELS,
} from "../src/pipeline/raster.js";
import type { PdfInfo, PdfPageSize, RenderedPage } from "../src/pipeline/pdf.js";
import type { VisionClient } from "../src/vision/client.js";
import { conversionFailed } from "../src/errors.js";
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
  subprocessTimeoutMs: 120_000,
  visionModel: "test-vlm",
};

const noopMetrics = {
  recordPage: vi.fn(),
  recordVision: vi.fn(),
  recordFigures: vi.fn(),
  recordTextFidelity: vi.fn(),
};

/** Minimal bytes that `resolveFormat` classifies as a PDF; content is never read. */
function pdfBytes(): Buffer {
  return Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("stub pdf body")]);
}

/** A vision client returning fixed body Markdown per page. */
function fixedVision(): VisionClient {
  return {
    async analyzePage({ page }) {
      return {
        raw: `<summary>Seite ${page}.</summary><figures></figures><markdown>Inhalt Seite ${page}</markdown>`,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        requests: 1,
        truncated: false,
        maxTokens: 8192,
      };
    },
    async analyzeFigure() {
      return {
        raw: '{"format":"markdown","text":"stub"}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        requests: 1,
        truncated: false,
        maxTokens: 8192,
      };
    },
    async probe() {
      return { available: true };
    },
  };
}

/** A 4×4 white PNG, so `imageSize` and any crop have a real image to work on. */
async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();
}

/** Portrait A0 in PostScript points: 841 mm × 1189 mm at 72 pt/in. */
const A0_SIZE: PdfPageSize = { widthPt: (841 / 25.4) * 72, heightPt: (1189 / 25.4) * 72 };
/** Portrait A4 in PostScript points. */
const A4_SIZE: PdfPageSize = { widthPt: (210 / 25.4) * 72, heightPt: (297 / 25.4) * 72 };

interface StubOptions {
  pageCount: number;
  pageSizes?: Record<number, PdfPageSize>;
  /** Pages whose render (and thus the whole page) must fail. */
  failRenderOn?: Set<number>;
  /** Pages whose text extraction must fail. */
  failTextOn?: Set<number>;
}

interface PdfStub {
  ops: PdfOps;
  renderedDpiByPage: Map<number, number>;
  /** The PNG bytes `renderPage` returns; set before calling `extract`. */
  png: Buffer;
}

/** Build injectable poppler ops plus a spy on the DPI each page is rendered at. */
function stubPdfOps(options: StubOptions): PdfStub {
  const renderedDpiByPage = new Map<number, number>();
  const pageSizes = options.pageSizes ?? {};
  const stub: PdfStub = { ops: {} as PdfOps, renderedDpiByPage, png: Buffer.alloc(0) };

  stub.ops = {
    async readPdfInfo(): Promise<PdfInfo> {
      return { pageCount: options.pageCount, pageSize: pageSizes[1] ?? null, encrypted: false };
    },
    async readPageSize(_pdfPath, page): Promise<PdfPageSize | null> {
      return pageSizes[page] ?? null;
    },
    async renderPage(_pdfPath, page, dpi): Promise<RenderedPage> {
      renderedDpiByPage.set(page, dpi);
      if (options.failRenderOn?.has(page) === true) {
        throw conversionFailed(`pdftoppm produced no image for page ${page}`, { page });
      }
      return { buffer: stub.png, page, dpi };
    },
    async extractPageText(_pdfPath, page): Promise<string> {
      if (options.failTextOn?.has(page) === true) {
        throw conversionFailed(`pdftotext failed for page ${page}`, { page });
      }
      return `Textschicht Seite ${page}`;
    },
    async imageSize(): Promise<{ width: number; height: number }> {
      return { width: 4, height: 4 };
    },
  };

  return stub;
}

function extractor(vision: VisionClient, pdfOps: PdfOps) {
  return createExtractor({
    config: CONFIG,
    logger: testLogger,
    vision,
    metrics: noopMetrics,
    pdfOps,
  });
}

describe("adaptiveRenderDpi", () => {
  it("leaves an ordinary A4 page at the preferred DPI", () => {
    // An A4 page at 200 dpi is ~1653×2339 ≈ 3.9 MP — far under any ceiling and
    // under the long-edge target, so nothing is adapted.
    expect(adaptiveRenderDpi(A4_SIZE, 200)).toBe(200);
  });

  it("lowers the DPI of an A0 page so it stays under the pixel limit", () => {
    // A0 at the preferred 200 dpi would be ~6614×9354 ≈ 61.9 MP, above the 40 MP
    // ceiling. The adapted DPI must render it under the limit, not drop it.
    const dpi = adaptiveRenderDpi(A0_SIZE, 200);
    expect(dpi).toBeLessThan(200);
    expect(dpi).toBeGreaterThan(0);

    const widthPx = (A0_SIZE.widthPt / 72) * dpi;
    const heightPx = (A0_SIZE.heightPt / 72) * dpi;
    expect(widthPx * heightPx).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
  });

  it("never returns a DPI below the floor, even for an enormous page", () => {
    const huge: PdfPageSize = { widthPt: 100_000, heightPt: 100_000 };
    expect(adaptiveRenderDpi(huge, 200, { minDpi: 72 })).toBe(72);
  });
});

describe("PDF page rendering (Requirement 2.7)", () => {
  it("renders an A0 page at an adapted DPI instead of dropping it", async () => {
    const stub = stubPdfOps({ pageCount: 1, pageSizes: { 1: A0_SIZE } });
    stub.png = await tinyPng();

    const result = await extractor(fixedVision(), stub.ops).extract({
      buffer: pdfBytes(),
      filename: "plan.pdf",
      declaredMimeType: "application/pdf",
      reference: "tests/plan.pdf",
    });

    // The page survives with content, and it was rendered below the preferred
    // DPI so its pixel count stayed under the limit.
    expect(result.document.pageCount).toBe(1);
    expect(result.document.pages[0]?.markdown).toContain("Inhalt Seite 1");
    const dpi = stub.renderedDpiByPage.get(1);
    expect(dpi).toBeDefined();
    expect(dpi as number).toBeLessThan(CONFIG.renderDpi);
    const widthPx = (A0_SIZE.widthPt / 72) * (dpi as number);
    const heightPx = (A0_SIZE.heightPt / 72) * (dpi as number);
    expect(widthPx * heightPx).toBeLessThanOrEqual(MAX_RENDER_PIXELS);
    expect(validateDocument(result.document).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("renders an A4 page at the preferred DPI", async () => {
    const stub = stubPdfOps({ pageCount: 1, pageSizes: { 1: A4_SIZE } });
    stub.png = await tinyPng();
    await extractor(fixedVision(), stub.ops).extract({
      buffer: pdfBytes(),
      filename: "report.pdf",
      declaredMimeType: "application/pdf",
      reference: "r",
    });
    expect(stub.renderedDpiByPage.get(1)).toBe(CONFIG.renderDpi);
  });
});

describe("per-page failure (Requirement 2.8)", () => {
  it("warns only the corrupt page in the middle and processes the rest", async () => {
    const stub = stubPdfOps({
      pageCount: 5,
      failRenderOn: new Set([3]),
    });
    stub.png = await tinyPng();

    const result = await extractor(fixedVision(), stub.ops).extract({
      buffer: pdfBytes(),
      filename: "handbuch.pdf",
      declaredMimeType: "application/pdf",
      reference: "tests/handbuch.pdf",
    });

    // The whole document survives.
    expect(result.document.pageCount).toBe(5);

    // Every page except the third has content.
    for (const page of result.document.pages) {
      if (page.page === 3) {
        expect(page.markdown).toBe("");
        expect(page.warnings.join(" ")).toMatch(/gerendert oder ihr Text nicht extrahiert/);
      } else {
        expect(page.markdown).toContain(`Inhalt Seite ${page.page}`);
        expect(page.warnings).toEqual([]);
      }
    }

    // Exactly one page-level warning, attributed to page 3, at the document level.
    const pageWarnings = result.document.warnings.filter((w) => /gerendert oder ihr Text/.test(w));
    expect(pageWarnings).toHaveLength(1);
    expect(pageWarnings[0]).toMatch(/Seite 3/);
    expect(validateDocument(result.document).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("warns the page whose text extraction fails, keeping the others", async () => {
    const stub = stubPdfOps({ pageCount: 3, failTextOn: new Set([2]) });
    stub.png = await tinyPng();

    const result = await extractor(fixedVision(), stub.ops).extract({
      buffer: pdfBytes(),
      filename: "handbuch.pdf",
      declaredMimeType: "application/pdf",
      reference: "r",
    });

    expect(result.document.pageCount).toBe(3);
    expect(result.document.pages[1]?.page).toBe(2);
    expect(result.document.pages[1]?.markdown).toBe("");
    expect(result.document.pages[0]?.markdown).toContain("Inhalt Seite 1");
    expect(result.document.pages[2]?.markdown).toContain("Inhalt Seite 3");
  });
});
