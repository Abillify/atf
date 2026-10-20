// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * render-region.test.ts
 *
 * `POST /v2/render` renders a page or a region ONCE, at the DPI it chose and
 * reports (P1-E5). Before, it rendered the whole page at model resolution just
 * to learn the page size, re-rendered it for a crop, computed a DPI it never
 * used, planned the tile grid from the downscaled pixels and enlarged the
 * result to the requested size.
 *
 *  - `readPageSize` reports the page AS RENDERED (a `/Rotate 90` page is portrait);
 *  - `renderRegion` rasterises only the region (`pdftoppm -x -y -W -H`), at the
 *    requested DPI, and falls back to a whole-page render when poppler clips;
 *  - the handler uses the true page size, calls neither `render` nor
 *    `renderFigureCrop`, and never enlarges.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderHandler, type RenderHandlerConfig } from "../src/handlers/render.js";
import { createPageRenderer, type PdfOps, type PreparedSource } from "../src/jobs/page-renderer.js";
import { readPageSize, type RenderRegion } from "../src/pipeline/pdf.js";
import { createFilesystemSourceStore } from "../src/source-store.js";
import { TINY_PNG, testLogger } from "./helpers.js";

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atf-render-region-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("readPageSize reports the page as rendered", () => {
  async function fakePdfinfo(output: string): Promise<{ binDir: string; home: string }> {
    const path = join(scratch, "pdfinfo");
    await writeFile(path, `#!/bin/sh\ncat <<'EOF'\n${output}\nEOF\n`, "utf8");
    await chmod(path, 0o755);
    return { binDir: scratch, home: scratch };
  }

  it("swaps width and height for a page rotated by 90 or 270 degrees", async () => {
    const tools = await fakePdfinfo("Pages:           1\nPage    1 size:  200 x 100 pts\nPage    1 rot:   90");
    expect(await readPageSize("x.pdf", 1, tools)).toEqual({ widthPt: 100, heightPt: 200 });
    const tools270 = await fakePdfinfo("Page    1 size:  200 x 100 pts\nPage    1 rot:   270");
    expect(await readPageSize("x.pdf", 1, tools270)).toEqual({ widthPt: 100, heightPt: 200 });
  });

  it("keeps the size for rotation 0 and 180, and for a document-level size line", async () => {
    const tools = await fakePdfinfo("Page    1 size:  200 x 100 pts\nPage    1 rot:   180");
    expect(await readPageSize("x.pdf", 1, tools)).toEqual({ widthPt: 200, heightPt: 100 });
    const plain = await fakePdfinfo("Page size:       595.276 x 841.89 pts (A4)\nPage rot:        0");
    expect(await readPageSize("x.pdf", 1, plain)).toEqual({ widthPt: 595.276, heightPt: 841.89 });
    const doc = await fakePdfinfo("Page size:       200 x 100 pts\nPage rot:        90");
    expect(await readPageSize("x.pdf", 1, doc)).toEqual({ widthPt: 100, heightPt: 200 });
  });
});

describe("PreparedSource.renderRegion (PDF)", () => {
  type RenderCall = { dpi: number; region: RenderRegion | undefined };

  /** `size` decides how big the image poppler "produced" for a call is. */
  async function prepare(opts: { size: (call: RenderCall) => { width: number; height: number } }) {
    const calls: RenderCall[] = [];
    const pdfOps: PdfOps = {
      async readPdfInfo() {
        return { pageCount: 1, pageSize: { widthPt: 200, heightPt: 100 }, encrypted: false };
      },
      async readPageSize() {
        return { widthPt: 200, heightPt: 100 };
      },
      async renderPage(_pdf, page, dpi, _dir, _tools, _options, region) {
        const call = { dpi, region };
        calls.push(call);
        const { width, height } = opts.size(call);
        const buffer = await sharp({
          create: { width, height, channels: 3, background: { r: 9, g: 9, b: 9 } },
        })
          .png()
          .toBuffer();
        return { buffer, page, dpi };
      },
      async extractPageText() {
        return "";
      },
      async extractDocumentText() {
        return [""];
      },
      async imageSize(buffer) {
        const meta = await sharp(buffer).metadata();
        return { width: meta.width ?? 0, height: meta.height ?? 0 };
      },
    };
    const store = createFilesystemSourceStore(join(scratch, "sources"));
    const { sha256 } = await store.putStream(Readable.from([PDF_BYTES]));
    const renderer = createPageRenderer({
      config: {
        renderDpi: 200,
        figureDpi: 300,
        tempDir: scratch,
        libreofficeBin: "soffice",
        popplerBinDir: null,
        subprocessTimeoutMs: 30_000,
        derivedPdfCache: false,
      },
      sourceStore: store,
      logger: testLogger,
      pdfOps,
    });
    const prepared = await renderer.prepare({ sourceSha256: sha256, filename: `${sha256}.pdf` });
    return { prepared, calls };
  }

  const sizePt = { widthPt: 200, heightPt: 100 };

  it("renders a whole page in one call at the requested DPI", async () => {
    const { prepared, calls } = await prepare({ size: () => ({ width: 400, height: 200 }) });
    try {
      const out = await prepared.renderRegion(1, { bbox: null, dpi: 144, sizePt, maxPixels: 40_000_000 });
      expect(calls).toEqual([{ dpi: 144, region: undefined }]);
      expect(out.dpi).toBe(144);
      expect(out.image).toMatchObject({ width: 400, height: 200 });
    } finally {
      await prepared.close();
    }
  });

  it("rasterises only the region, addressed on the page's pixel grid for that DPI", async () => {
    // 200x100 pt at 144 dpi = 400x200 px; bbox [.25,.25,.75,.5] = x 100..300, y 50..100.
    const { prepared, calls } = await prepare({ size: () => ({ width: 200, height: 50 }) });
    try {
      const out = await prepared.renderRegion(1, {
        bbox: [0.25, 0.25, 0.75, 0.5],
        dpi: 144,
        sizePt,
        maxPixels: 40_000_000,
      });
      expect(calls).toEqual([{ dpi: 144, region: { left: 100, top: 50, width: 200, height: 50 } }]);
      expect(out.dpi).toBe(144);
      expect(out.image).toMatchObject({ width: 200, height: 50 });
    } finally {
      await prepared.close();
    }
  });

  it("falls back to the whole page (capped by the pixel ceiling) when poppler clipped the region", async () => {
    const { prepared, calls } = await prepare({
      // The region call comes back at the wrong size; the whole-page call is 600x300.
      size: (call) => (call.region !== undefined ? { width: 17, height: 9 } : { width: 600, height: 300 }),
    });
    try {
      const out = await prepared.renderRegion(1, {
        bbox: [0, 0, 0.5, 0.5],
        dpi: 600,
        sizePt,
        // 200x100 pt = 2.78 x 1.39 in; 600 dpi would be 2 Mpx, a 1 Mpx ceiling allows ~423 dpi.
        maxPixels: 1_000_000,
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.region).toBeDefined();
      expect(calls[1]?.region).toBeUndefined();
      expect(calls[1]?.dpi).toBeLessThan(600);
      expect(calls[1]?.dpi).toBeGreaterThanOrEqual(400);
      expect(out.dpi).toBe(calls[1]?.dpi);
      // The crop is the top-left quarter of the 600x300 page.
      expect(out.image).toMatchObject({ width: 300, height: 150 });
    } finally {
      await prepared.close();
    }
  });

  it("pageSizePt reads the size without rendering", async () => {
    const { prepared, calls } = await prepare({ size: () => ({ width: 1, height: 1 }) });
    try {
      expect(await prepared.pageSizePt(1)).toEqual({ widthPt: 200, heightPt: 100 });
      expect(calls).toHaveLength(0);
    } finally {
      await prepared.close();
    }
  });
});

describe("POST /v2/render renders once, at the reported DPI, and never enlarges", () => {
  const config: RenderHandlerConfig = {
    renderDpi: 200,
    figureDpi: 300,
    renderMaxPixels: 40_000_000,
    tileTargetPixels: 2000,
    tileOverlapFraction: 0.1,
    tileMaxPerPage: 16,
  };
  const SOURCE = "a".repeat(64);

  async function png(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
  }

  function app(prepared: Partial<PreparedSource>) {
    const calls = { render: vi.fn(), renderFigureCrop: vi.fn() };
    const full: PreparedSource = {
      pageCount: 1,
      format: { mimeType: "application/pdf", extensions: [".pdf"], kind: "pdf", family: "pdf", label: "PDF" },
      native: null,
      docxHeadingHints: null,
      vsdxStructure: null,
      pdfPath: null,
      home: "",
      render: calls.render,
      renderFigureCrop: calls.renderFigureCrop,
      async pageSizePt() {
        return { widthPt: 595, heightPt: 842 };
      },
      async renderRegion() {
        return { image: { buffer: TINY_PNG, mimeType: "image/png", width: 1, height: 1 }, dpi: 72 };
      },
      async close() {},
      ...prepared,
    };
    const server = express();
    server.use(express.json());
    server.post(
      "/v2/render",
      createRenderHandler({
        sourceStore: { has: async () => true } as never,
        pageRenderer: { prepare: async () => full },
        config,
        logger: testLogger as never,
      }),
    );
    return { server, calls };
  }

  it("uses the true page size and one renderRegion call, not render()/renderFigureCrop()", async () => {
    const renderRegion = vi.fn(async (_page: number, region: { dpi: number }) => ({
      image: { buffer: await png(400, 566), mimeType: "image/png", width: 400, height: 566 },
      dpi: region.dpi,
    }));
    const { server, calls } = app({ renderRegion: renderRegion as never });
    const res = await request(server).post("/v2/render").send({ source: SOURCE, page: 1, targetPixels: 566 });
    expect(res.status).toBe(200);
    expect(renderRegion).toHaveBeenCalledTimes(1);
    expect(calls.render).not.toHaveBeenCalled();
    expect(calls.renderFigureCrop).not.toHaveBeenCalled();
    // 566 px on the 842 pt (11.69 in) long edge = ~48 dpi: that is what was rendered and what is reported.
    const asked = renderRegion.mock.calls[0]?.[1];
    expect(asked?.dpi).toBe(48);
    expect(asked).toMatchObject({ bbox: null, sizePt: { widthPt: 595, heightPt: 842 } });
    expect(Number(res.headers["x-render-dpi"])).toBe(48);
  });

  it("a whole page without a target uses the same adaptive DPI the job pipeline's model page does", async () => {
    const renderRegion = vi.fn(async (_page: number, region: { dpi: number }) => ({
      image: { buffer: await png(100, 100), mimeType: "image/png", width: 100, height: 100 },
      dpi: region.dpi,
    }));
    const { server } = app({ renderRegion: renderRegion as never });
    await request(server).post("/v2/render").send({ source: SOURCE, page: 1 }).expect(200);
    // A4 at the configured 200 dpi stays at 200 (adaptiveRenderDpi only lowers large formats).
    expect(renderRegion.mock.calls[0]?.[1].dpi).toBe(200);
  });

  it("a bbox region starts from FIGURE_DPI and is rendered as a region", async () => {
    const renderRegion = vi.fn(async (_page: number, region: { dpi: number }) => ({
      image: { buffer: await png(300, 200), mimeType: "image/png", width: 300, height: 200 },
      dpi: region.dpi,
    }));
    const { server } = app({ renderRegion: renderRegion as never });
    const res = await request(server)
      .post("/v2/render")
      .send({ source: SOURCE, page: 1, bbox: [0.1, 0.1, 0.4, 0.3] })
      .expect(200);
    const asked = renderRegion.mock.calls[0]?.[1] as { dpi: number; bbox: number[] };
    expect(asked.dpi).toBe(300);
    expect(asked.bbox).toEqual([0.1, 0.1, 0.4, 0.3]);
    expect(Number(res.headers["x-render-dpi"])).toBe(300);
  });

  it("never enlarges: a target above what the renderer delivered returns the delivered pixels", async () => {
    const renderRegion = vi.fn(async () => ({
      image: { buffer: await png(100, 60), mimeType: "image/png", width: 100, height: 60 },
      dpi: 72,
    }));
    const { server } = app({ renderRegion: renderRegion as never });
    const res = await request(server).post("/v2/render").send({ source: SOURCE, page: 1, targetPixels: 1000 });
    expect(res.status).toBe(200);
    expect(Number(res.headers["x-render-width"])).toBe(100);
    expect(Number(res.headers["x-render-height"])).toBe(60);
    expect(Number(res.headers["x-render-dpi"])).toBe(72);
  });

  it("reports the DPI of the delivered pixels after a downscale", async () => {
    const renderRegion = vi.fn(async () => ({
      image: { buffer: await png(800, 400), mimeType: "image/png", width: 800, height: 400 },
      dpi: 200,
    }));
    const { server } = app({ renderRegion: renderRegion as never });
    const res = await request(server).post("/v2/render").send({ source: SOURCE, page: 1, targetPixels: 400 });
    expect(Number(res.headers["x-render-width"])).toBe(400);
    expect(Number(res.headers["x-render-dpi"])).toBe(100);
  });

  it("names the tile from the TRUE page size, not from downscaled pixels", async () => {
    // A0 (2384 x 3370 pt): the grid is planned from the real size. The model page of
    // such a format is rendered at a much lower DPI, which used to shrink the page here.
    const renderRegion = vi.fn(async (_page: number, region: { dpi: number }) => ({
      image: { buffer: await png(50, 50), mimeType: "image/png", width: 50, height: 50 },
      dpi: region.dpi,
    }));
    const { server } = app({
      renderRegion: renderRegion as never,
      pageSizePt: async () => ({ widthPt: 2384, heightPt: 3370 }),
    });
    const res = await request(server)
      .post("/v2/render")
      .send({ source: SOURCE, page: 1, bbox: [0.02, 0.02, 0.1, 0.08] })
      .expect(200);
    expect(res.headers["x-render-tile"]).toBeDefined();
    expect(renderRegion.mock.calls[0]?.[1]).toMatchObject({ sizePt: { widthPt: 2384, heightPt: 3370 } });
  });
});
