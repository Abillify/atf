// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * page-renderer-window.test.ts
 *
 * The render window (P1-7 / E7): `PreparedSource.prefetch` renders a run of
 * pages with ONE `pdfinfo` and ONE `pdftoppm` call instead of two subprocesses
 * per page, and the figure-resolution render of a page is shared by all of its
 * crops.
 *
 * Part 1 drives the renderer with stubbed poppler ops and counts calls: the
 * saving, the fallbacks (a page that is not warmed, an oversized sheet with its
 * own DPI, a failed window) and the waiting of `render` for a window in flight.
 * Part 2 runs the new `pdfinfo`/`pdftoppm` wrappers against a real poppler when
 * one is installed, on a generated PDF with mixed sizes and rotation.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSyntheticPdf } from "../scripts/lib/synthetic-pdf.js";
import { createPageRenderer, type PageRendererConfig, type PdfOps } from "../src/jobs/page-renderer.js";
import { readPageSize, readPageSizes, renderPage, renderPages } from "../src/pipeline/pdf.js";
import { createFilesystemSourceStore } from "../src/source-store.js";
import { TINY_PNG, testLogger } from "./helpers.js";

interface Calls {
  readPageSizes: Array<[number, number]>;
  renderPages: Array<[number, number, number]>;
  renderPage: Array<[number, number]>;
}

function stubOps(
  calls: Calls,
  options: {
    pageCount?: number;
    sizeOf?: (page: number) => { widthPt: number; heightPt: number };
    failWindow?: boolean;
    windowDelayMs?: number;
  } = {},
): PdfOps {
  const sizeOf = options.sizeOf ?? (() => ({ widthPt: 595, heightPt: 842 }));
  return {
    async readPdfInfo() {
      return { pageCount: options.pageCount ?? 40, pageSize: sizeOf(1), encrypted: false };
    },
    async readPageSize(_pdf, page) {
      return sizeOf(page);
    },
    async readPageSizes(_pdf, first, last) {
      calls.readPageSizes.push([first, last]);
      const sizes = new Map<number, { widthPt: number; heightPt: number }>();
      for (let page = first; page <= last; page++) sizes.set(page, sizeOf(page));
      return sizes;
    },
    async renderPage(_pdf, page, dpi) {
      calls.renderPage.push([page, dpi]);
      return { buffer: Buffer.from(TINY_PNG), page, dpi };
    },
    async renderPages(_pdf, first, last, dpi) {
      calls.renderPages.push([first, last, dpi]);
      if (options.windowDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.windowDelayMs));
      }
      if (options.failWindow === true) throw new Error("pdftoppm window failed");
      return Array.from({ length: last - first + 1 }, (_, i) => ({
        buffer: Buffer.from(TINY_PNG),
        page: first + i,
        dpi,
      }));
    },
    async extractPageText() {
      return "text";
    },
    async extractDocumentText(_pdf, lastPage) {
      return Array.from({ length: lastPage }, () => "text");
    },
    async imageSize() {
      return { width: 1, height: 1 };
    },
  };
}

let scratch: string;
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atf-render-window-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function prepare(ops: PdfOps) {
  const store = createFilesystemSourceStore(join(scratch, "sources"));
  const { sha256 } = await store.putStream(Readable.from([PDF_BYTES]));
  const config: PageRendererConfig = {
    renderDpi: 200,
    figureDpi: 300,
    tempDir: scratch,
    libreofficeBin: "soffice",
    popplerBinDir: null,
    subprocessTimeoutMs: 30_000,
  };
  const renderer = createPageRenderer({ config, sourceStore: store, logger: testLogger, pdfOps: ops });
  return renderer.prepare({ sourceSha256: sha256, filename: "doc.pdf" });
}

function freshCalls(): Calls {
  return { readPageSizes: [], renderPages: [], renderPage: [] };
}

describe("PreparedSource.prefetch — one pdfinfo and one pdftoppm per window", () => {
  it("renders a window of 8 pages with 2 subprocess calls, not 16", async () => {
    const calls = freshCalls();
    const prepared = await prepare(stubOps(calls));
    try {
      await prepared.prefetch?.([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(calls.readPageSizes).toEqual([[1, 8]]);
      expect(calls.renderPages).toEqual([[1, 8, 200]]);
      for (let page = 1; page <= 8; page++) {
        const rendered = await prepared.render(page);
        expect(rendered.dpi).toBe(200);
        expect(rendered.sizePt).toEqual({ widthPt: 595, heightPt: 842 });
        expect(rendered.rawText).toBe("text");
      }
      // Every page came from the window: no per-page render.
      expect(calls.renderPage).toEqual([]);
    } finally {
      await prepared.close();
    }
  });

  it("hands a warmed page out once; a second render of it renders again", async () => {
    const calls = freshCalls();
    const prepared = await prepare(stubOps(calls));
    try {
      await prepared.prefetch?.([1, 2, 3, 4]);
      await prepared.render(2);
      await prepared.render(2);
      expect(calls.renderPage).toEqual([[2, 200]]);
    } finally {
      await prepared.close();
    }
  });

  it("does not warm a short run, nor a page it already holds", async () => {
    const calls = freshCalls();
    const prepared = await prepare(stubOps(calls));
    try {
      await prepared.prefetch?.([1, 2, 3]);
      expect(calls.renderPages).toEqual([]);
      await prepared.prefetch?.([1, 2, 3, 4]);
      await prepared.prefetch?.([1, 2, 3, 4]);
      expect(calls.renderPages).toEqual([[1, 4, 200]]);
      // Pages 5-8 are cold, 1-4 warm: only the cold run is rendered.
      await prepared.prefetch?.([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(calls.renderPages).toEqual([[1, 4, 200], [5, 8, 200]]);
    } finally {
      await prepared.close();
    }
  });

  it("splits the window at a sheet that gets an adaptive DPI and renders that one on its own", async () => {
    const calls = freshCalls();
    // Page 5 is an A0 plan: the adaptive render DPI lowers it, so it cannot share the window's -r.
    const sizeOf = (page: number) =>
      page === 5 ? { widthPt: 2384, heightPt: 3370 } : { widthPt: 595, heightPt: 842 };
    const prepared = await prepare(stubOps(calls, { sizeOf }));
    try {
      await prepared.prefetch?.([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(calls.readPageSizes).toEqual([[1, 10]]);
      expect(calls.renderPages.map(([from, to]) => [from, to])).toEqual([[1, 4], [6, 10]]);
      const plan = await prepared.render(5);
      expect(calls.renderPage).toHaveLength(1);
      expect(calls.renderPage[0]?.[0]).toBe(5);
      expect(plan.dpi).toBeLessThan(200);
    } finally {
      await prepared.close();
    }
  });

  it("falls back to rendering page by page when the window call fails", async () => {
    const calls = freshCalls();
    const prepared = await prepare(stubOps(calls, { failWindow: true }));
    try {
      await expect(prepared.prefetch?.([1, 2, 3, 4])).resolves.toBeUndefined();
      const rendered = await prepared.render(3);
      expect(rendered.image.width).toBe(1);
      expect(calls.renderPage).toEqual([[3, 200]]);
    } finally {
      await prepared.close();
    }
  });

  it("a render that starts while its window is in flight waits for it instead of rendering twice", async () => {
    const calls = freshCalls();
    const prepared = await prepare(stubOps(calls, { windowDelayMs: 30 }));
    try {
      const warming = prepared.prefetch?.([1, 2, 3, 4]);
      // The window is registered synchronously: this render must not start its own.
      const early = prepared.render(2);
      await Promise.all([warming, early]);
      expect(calls.renderPage).toEqual([]);
      expect(calls.renderPages).toHaveLength(1);
    } finally {
      await prepared.close();
    }
  });

  it("ignores pages outside the document", async () => {
    const calls = freshCalls();
    const prepared = await prepare(stubOps(calls, { pageCount: 6 }));
    try {
      await prepared.prefetch?.([0, 1, 2, 3, 4, 99]);
      expect(calls.renderPages).toEqual([[1, 4, 200]]);
    } finally {
      await prepared.close();
    }
  });
});

describe("renderFigureCrop — the figure-resolution page is rendered once per page", () => {
  const bbox: [number, number, number, number] = [0, 0, 1, 1];
  let png: Buffer;
  let pageImage: { buffer: Buffer; mimeType: string; width: number; height: number };
  beforeEach(async () => {
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } }).png().toBuffer();
    pageImage = { buffer: png, mimeType: "image/png", width: 8, height: 8 };
  });
  const figureOps = (calls: Calls): PdfOps => {
    const ops = stubOps(calls);
    ops.renderPage = async (_pdf, page, dpi) => {
      calls.renderPage.push([page, dpi]);
      return { buffer: png, page, dpi };
    };
    ops.imageSize = async () => ({ width: 8, height: 8 });
    return ops;
  };
  it("shares one figureDpi render between the crops of a page, and renders another page separately", async () => {
    const calls = freshCalls();
    const prepared = await prepare(figureOps(calls));
    try {
      await Promise.all([
        prepared.renderFigureCrop(3, bbox, pageImage),
        prepared.renderFigureCrop(3, bbox, pageImage),
        prepared.renderFigureCrop(3, bbox, pageImage),
      ]);
      await prepared.renderFigureCrop(3, bbox, pageImage);
      expect(calls.renderPage).toEqual([[3, 300]]);
      await prepared.renderFigureCrop(4, bbox, pageImage);
      expect(calls.renderPage).toEqual([[3, 300], [4, 300]]);
    } finally {
      await prepared.close();
    }
  });

  it("does not keep a failed render: the next crop tries again", async () => {
    const calls = freshCalls();
    const ops = figureOps(calls);
    let failures = 1;
    const render = ops.renderPage;
    ops.renderPage = async (...args) => {
      if (failures-- > 0) {
        calls.renderPage.push([args[1], args[2]]);
        throw new Error("render failed");
      }
      return render(...args);
    };
    const prepared = await prepare(ops);
    try {
      await prepared.renderFigureCrop(2, bbox, pageImage);
      await prepared.renderFigureCrop(2, bbox, pageImage);
      // The first attempt failed (and fell back to the model-resolution page);
      // the failure was not cached, so the second crop rendered again.
      expect(calls.renderPage).toEqual([[2, 300], [2, 300]]);
    } finally {
      await prepared.close();
    }
  });
});

// ── Part 2: the wrappers against a real poppler ────────────────────────────

function popplerAvailable(): boolean {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    execFileSync("pdfinfo", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const describeReal = popplerAvailable() ? describe : describe.skip;

describeReal("readPageSizes / renderPages with real poppler", () => {
  const tools = { binDir: null, home: tmpdir() };

  async function pdfOf(
    pages: number,
    page?: Parameters<typeof buildSyntheticPdf>[0]["page"],
  ): Promise<{ path: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "atf-window-pdf-"));
    const path = join(dir, "doc.pdf");
    await writeFile(path, buildSyntheticPdf({ pages, ...(page !== undefined ? { page } : {}), lines: 6 }));
    return { path, dir };
  }

  it("reads the same sizes in one call as page by page, rotation included", async () => {
    const { path, dir } = await pdfOf(6, (n) =>
      n === 2 ? { widthPt: 842, heightPt: 595 } : n === 4 ? { widthPt: 595, heightPt: 842, rotate: 90 } : undefined,
    );
    try {
      const window = await readPageSizes(path, 1, 6, tools);
      expect([...window.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
      for (let page = 1; page <= 6; page++) {
        expect(window.get(page)).toEqual(await readPageSize(path, page, tools));
      }
      // The rotated page is reported as rendered: landscape.
      expect(window.get(4)).toEqual({ widthPt: 842, heightPt: 595 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a single page and an out-of-range request without throwing", async () => {
    const { path, dir } = await pdfOf(3);
    try {
      expect((await readPageSizes(path, 2, 2, tools)).get(2)).toEqual({ widthPt: 595, heightPt: 842 });
      expect((await readPageSizes(path, 40, 50, tools)).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("renders a window in one call with the same pixels as page-by-page, and leaves no files behind", async () => {
    const { path, dir } = await pdfOf(5);
    const work = join(dir, "work");
    try {
      const window = await renderPages(path, 2, 4, 72, work, tools);
      expect(window.map((p) => p.page)).toEqual([2, 3, 4]);
      for (const item of window) {
        expect(item.dpi).toBe(72);
        expect(item.buffer.subarray(1, 4).toString("latin1")).toBe("PNG");
        const single = await renderPage(path, item.page, 72, join(dir, "single"), tools);
        expect(item.buffer.equals(single.buffer)).toBe(true);
      }
      expect(await readdir(work)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps files to pages when poppler zero-pads the number (a document of 100+ pages)", async () => {
    const { path, dir } = await pdfOf(120);
    try {
      const window = await renderPages(path, 98, 102, 36, join(dir, "work"), tools);
      expect(window.map((p) => p.page)).toEqual([98, 99, 100, 101, 102]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
