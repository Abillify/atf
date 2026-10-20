// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * page-renderer-cache.test.ts
 *
 * Phase 11 (Fix C): the derived-PDF cache (DERIVED_PDF_CACHE).
 *
 *  (a) a PDF source stored UNDER the scratch root is used in place — no
 *      per-run copy — and survives close(); outside the scratch root (or with
 *      the cache off) the historical copy into the job work dir applies;
 *  (b) a LibreOffice conversion is cached under TEMP_DIR/derived-pdf keyed by
 *      the source sha256 + converter identity: a second prepare of the same
 *      source skips the conversion and reuses the same file;
 *  (c) with the cache disabled every prepare re-converts into its own work dir.
 *
 * The conversion itself is mocked (partial vi.mock of the office module — the
 * real one needs a LibreOffice binary); poppler is stubbed through the
 * injectable PdfOps, so the test is hermetic. The SourceStore is the real
 * filesystem one, because the whole point is WHERE the prepared PDF lives.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Counts convertToPdf calls across mocks (hoisted so the factory can see it). */
const convertCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/pipeline/office.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/pipeline/office.js")>();
  // Dynamic imports: the hoisted factory must not touch the test module's own
  // top-level imports (TDZ).
  const { join } = await import("node:path");
  const { mkdir, writeFile } = await import("node:fs/promises");
  return {
    ...actual,
    convertToPdf: async (
      _source: { buffer: Uint8Array; extension: string },
      options: { workDir: string },
    ): Promise<string> => {
      convertCalls.count += 1;
      const outDir = join(options.workDir, "office-out");
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, `converted-${convertCalls.count}.pdf`);
      await writeFile(outPath, Buffer.from("%PDF-1.4\n%stub\n%%EOF\n"));
      return outPath;
    },
  };
});

import {
  createPageRenderer,
  type PageRendererConfig,
  type PdfOps,
} from "../src/jobs/page-renderer.js";
import { createFilesystemSourceStore } from "../src/source-store.js";
import { TINY_PNG, testLogger } from "./helpers.js";

/** The prepared PDF path, or a hard failure — a PDF source always has one. */
function pdfPathOf(prepared: { pdfPath: string | null }): string {
  if (prepared.pdfPath === null)
    throw new Error("expected the prepared source to expose a PDF path");
  return prepared.pdfPath;
}

/** A minimal PDF-magic buffer — resolveFormat sniffs `%PDF` unambiguously. */
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

/** A real (tiny) ZIP with a PPTX part — the extension makes it a PPTX. */
const PPTX_BYTES = Buffer.from(
  zipSync({ "ppt/presentation.xml": strToU8("<x/>") }),
);

/** Poppler stubbed: no binary is ever spawned through PdfOps. */
const stubPdfOps: PdfOps = {
  async readPdfInfo() {
    return {
      pageCount: 2,
      pageSize: { widthPt: 595, heightPt: 842 },
      encrypted: false,
    };
  },
  async readPageSize() {
    return { widthPt: 595, heightPt: 842 };
  },
  async renderPage(pdfPath, page, dpi) {
    void pdfPath;
    return { buffer: Buffer.from(TINY_PNG), page, dpi };
  },
  async extractPageText() {
    return "stub text";
  },
  async extractDocumentText(_pdfPath, lastPage) {
    return Array.from({ length: lastPage }, (_, i) => `page ${i + 1}`);
  },
  async imageSize() {
    return { width: 1, height: 1 };
  },
};

let scratchRoot: string;
let versionStubPath: string;
const cleanups: Array<() => Promise<void>> = [];

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Store bytes in a filesystem store at `dir` and return {sha, path}. */
async function storeBytes(dir: string, bytes: Buffer) {
  const store = createFilesystemSourceStore(dir);
  const { sha256 } = await store.putStream(Readable.from([bytes]));
  const path = await store.locate(sha256);
  if (path === null) throw new Error("stored source not locatable");
  return { sha256, path, store };
}

/**
 * A stand-in `soffice` that answers `--version` (the only call the renderer
 * itself makes; the conversion is mocked). Printing nothing models a binary
 * that is up but not yet ready; a missing binary models a sidecar that is down.
 */
async function writeVersionStub(
  name: string,
  version: string | null,
): Promise<string> {
  const path = join(scratchRoot, name);
  await writeFile(
    path,
    version === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\necho "${version}"\n`,
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

function rendererFor(
  store: ReturnType<typeof createFilesystemSourceStore>,
  derivedPdfCache: boolean,
  libreofficeBin: string = versionStubPath,
  limits: { maxBytes?: number; maxAgeMs?: number } = {},
) {
  const config: PageRendererConfig = {
    renderDpi: 200,
    figureDpi: 300,
    tempDir: scratchRoot,
    // The conversion is mocked; only `--version` is really spawned.
    libreofficeBin,
    popplerBinDir: null,
    subprocessTimeoutMs: 30_000,
    derivedPdfCache,
    ...(limits.maxBytes !== undefined ? { derivedPdfCacheMaxBytes: limits.maxBytes } : {}),
    ...(limits.maxAgeMs !== undefined ? { derivedPdfCacheMaxAgeMs: limits.maxAgeMs } : {}),
  };
  return createPageRenderer({
    config,
    sourceStore: store,
    logger: testLogger,
    pdfOps: stubPdfOps,
  });
}

beforeEach(async () => {
  convertCalls.count = 0;
  scratchRoot = await mkdtemp(join(tmpdir(), "atf-pdf-cache-scratch-"));
  versionStubPath = await writeVersionStub("soffice-stub", "LibreOffice 24.8.1.2");
  cleanups.push(() => rm(scratchRoot, { recursive: true, force: true }));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("page-renderer · PDF sources are used in place (Phase 11)", () => {
  it("uses the stored PDF directly when it lives under the scratch root", async () => {
    const storeDir = join(scratchRoot, "sources");
    const { sha256, path, store } = await storeBytes(storeDir, PDF_BYTES);

    const renderer = rendererFor(store, true);
    const prepared = await renderer.prepare({
      sourceSha256: sha256,
      filename: "handbuch.pdf",
    });
    try {
      expect(prepared.pdfPath).toBe(path);
    } finally {
      await prepared.close();
    }
    // close() removes only the job work dir — the immutable store file stays.
    expect(await exists(path)).toBe(true);
  });

  it("copies into the work dir when the store sits outside the scratch root", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "atf-pdf-cache-store-"));
    cleanups.push(() => rm(storeDir, { recursive: true, force: true }));
    const { sha256, path, store } = await storeBytes(storeDir, PDF_BYTES);

    const renderer = rendererFor(store, true);
    const prepared = await renderer.prepare({
      sourceSha256: sha256,
      filename: "handbuch.pdf",
    });
    try {
      const rendered = pdfPathOf(prepared);
      expect(rendered).not.toBe(path);
      expect(rendered.startsWith(join(scratchRoot, "job-"))).toBe(true);
      // The copy is byte-identical to the stored source.
      expect(await readFile(rendered)).toEqual(PDF_BYTES);
    } finally {
      await prepared.close();
    }
  });

  it("copies even under the scratch root when DERIVED_PDF_CACHE is off", async () => {
    const storeDir = join(scratchRoot, "sources");
    const { sha256, path, store } = await storeBytes(storeDir, PDF_BYTES);

    const renderer = rendererFor(store, false);
    const prepared = await renderer.prepare({
      sourceSha256: sha256,
      filename: "handbuch.pdf",
    });
    try {
      const rendered = pdfPathOf(prepared);
      expect(rendered).not.toBe(path);
      expect(rendered.startsWith(join(scratchRoot, "job-"))).toBe(true);
    } finally {
      await prepared.close();
    }
  });
});

describe("page-renderer · LibreOffice conversions are cached (Phase 11)", () => {
  it("converts once and reuses the cached PDF for the same source", async () => {
    const storeDir = join(scratchRoot, "sources");
    const { sha256, store } = await storeBytes(storeDir, PPTX_BYTES);

    const first = await rendererFor(store, true).prepare({
      sourceSha256: sha256,
      filename: "deck.pptx",
    });
    expect(convertCalls.count).toBe(1);
    const cachePath = pdfPathOf(first);
    expect(cachePath.startsWith(join(scratchRoot, "derived-pdf"))).toBe(true);
    expect(basename(cachePath)).toContain(sha256);
    await first.close();
    // The cache file is a hard link, so removing the work dir keeps it alive.
    expect(await exists(cachePath)).toBe(true);

    // A fresh renderer (a resume, a restart) hits the on-disk cache: no second
    // conversion, same file.
    const second = await rendererFor(store, true).prepare({
      sourceSha256: sha256,
      filename: "deck.pptx",
    });
    try {
      expect(convertCalls.count).toBe(1);
      expect(second.pdfPath).toBe(cachePath);
    } finally {
      await second.close();
    }
  });

  it("re-converts into the work dir on every prepare when the cache is off", async () => {
    const storeDir = join(scratchRoot, "sources");
    const { sha256, store } = await storeBytes(storeDir, PPTX_BYTES);

    const renderer = rendererFor(store, false);
    const first = await renderer.prepare({
      sourceSha256: sha256,
      filename: "deck.pptx",
    });
    expect(convertCalls.count).toBe(1);
    expect(pdfPathOf(first).startsWith(join(scratchRoot, "job-"))).toBe(true);
    await first.close();

    const second = await renderer.prepare({
      sourceSha256: sha256,
      filename: "deck.pptx",
    });
    try {
      expect(convertCalls.count).toBe(2);
      expect(pdfPathOf(second).startsWith(join(scratchRoot, "job-"))).toBe(true);
    } finally {
      await second.close();
    }
  });
});

describe("page-renderer · converter identity is part of the cache key", () => {
  const prepareDeck = async (
    store: ReturnType<typeof createFilesystemSourceStore>,
    sha256: string,
    bin: string,
  ) => rendererFor(store, true, bin).prepare({ sourceSha256: sha256, filename: "deck.pptx" });

  it("a different LibreOffice build never reuses the cached conversion", async () => {
    const { sha256, store } = await storeBytes(join(scratchRoot, "sources"), PPTX_BYTES);
    const v1 = await writeVersionStub("soffice-v1", "LibreOffice 24.8.1.2");
    const v2 = await writeVersionStub("soffice-v2", "LibreOffice 25.2.0.3");

    const first = await prepareDeck(store, sha256, v1);
    expect(convertCalls.count).toBe(1);
    await first.close();

    const sameBuild = await prepareDeck(store, sha256, v1);
    expect(convertCalls.count).toBe(1);
    await sameBuild.close();

    const upgraded = await prepareDeck(store, sha256, v2);
    try {
      expect(convertCalls.count).toBe(2);
      expect(pdfPathOf(upgraded)).not.toBe(pdfPathOf(first));
    } finally {
      await upgraded.close();
    }
  });

  it("bypasses the cache while the version probe fails, instead of keying on 'unknown'", async () => {
    const { sha256, store } = await storeBytes(join(scratchRoot, "sources"), PPTX_BYTES);
    const down = join(scratchRoot, "soffice-does-not-exist");

    const first = await prepareDeck(store, sha256, down);
    const second = await prepareDeck(store, sha256, down);
    try {
      // Every prepare converts into its own work dir; nothing lands in the cache.
      expect(convertCalls.count).toBe(2);
      expect(pdfPathOf(first).startsWith(join(scratchRoot, "derived-pdf"))).toBe(false);
      expect(pdfPathOf(second).startsWith(join(scratchRoot, "derived-pdf"))).toBe(false);
      expect(await exists(join(scratchRoot, "derived-pdf"))).toBe(false);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("an empty version answer is treated as a failed probe", async () => {
    const { sha256, store } = await storeBytes(join(scratchRoot, "sources"), PPTX_BYTES);
    const silent = await writeVersionStub("soffice-silent", "");
    const prepared = await prepareDeck(store, sha256, silent);
    try {
      expect(pdfPathOf(prepared).startsWith(join(scratchRoot, "derived-pdf"))).toBe(false);
    } finally {
      await prepared.close();
    }
  });

  it("a failed probe is not remembered: the next prepare caches once the binary answers", async () => {
    const { sha256, store } = await storeBytes(join(scratchRoot, "sources"), PPTX_BYTES);
    const flaky = join(scratchRoot, "soffice-flaky");
    // One renderer instance throughout, so the memoization is what is tested.
    await writeFile(flaky, "#!/bin/sh\nexit 1\n", "utf8");
    await chmod(flaky, 0o755);
    const renderer = rendererFor(store, true, flaky);

    const down = await renderer.prepare({ sourceSha256: sha256, filename: "deck.pptx" });
    expect(pdfPathOf(down).startsWith(join(scratchRoot, "derived-pdf"))).toBe(false);
    await down.close();

    // The binary comes up (same path, now answering).
    await writeFile(flaky, '#!/bin/sh\necho "LibreOffice 24.8.1.2"\n', "utf8");
    const up = await renderer.prepare({ sourceSha256: sha256, filename: "deck.pptx" });
    try {
      expect(pdfPathOf(up).startsWith(join(scratchRoot, "derived-pdf"))).toBe(true);
    } finally {
      await up.close();
    }
  });
});

describe("page-renderer · retention sweep of the derived-PDF cache", () => {
  const wait = async (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("evicts an unused old conversion but never the file a prepared source is reading", async () => {
    const cacheDir = join(scratchRoot, "derived-pdf");
    await mkdir(cacheDir, { recursive: true });
    // A stale conversion nobody holds: 40 hours old, far over a 24 h limit.
    const stale = join(cacheDir, `${"d".repeat(64)}-0123456789abcdef.pdf`);
    await writeFile(stale, "%PDF-1.4 stale");
    const longAgo = new Date(Date.now() - 40 * 3_600_000);
    await utimes(stale, longAgo, longAgo);

    const { sha256, store } = await storeBytes(join(scratchRoot, "sources"), PPTX_BYTES);
    // maxBytes of 1 would evict the new file too if it were not pinned.
    const prepared = await rendererFor(store, true, versionStubPath, {
      maxBytes: 1,
      maxAgeMs: 24 * 3_600_000,
    }).prepare({ sourceSha256: sha256, filename: "deck.pptx" });
    try {
      await wait(100); // the sweep is fire-and-forget after prepare
      expect(await exists(stale)).toBe(false);
      expect(await exists(pdfPathOf(prepared))).toBe(true);
    } finally {
      await prepared.close();
    }
  });

  it("with both limits at 0 nothing is ever evicted", async () => {
    const cacheDir = join(scratchRoot, "derived-pdf");
    await mkdir(cacheDir, { recursive: true });
    const stale = join(cacheDir, `${"d".repeat(64)}-0123456789abcdef.pdf`);
    await writeFile(stale, "%PDF-1.4 stale");
    const longAgo = new Date(Date.now() - 999 * 3_600_000);
    await utimes(stale, longAgo, longAgo);
    const { sha256, store } = await storeBytes(join(scratchRoot, "sources"), PPTX_BYTES);
    const prepared = await rendererFor(store, true).prepare({
      sourceSha256: sha256,
      filename: "deck.pptx",
    });
    try {
      await wait(100);
      expect(await exists(stale)).toBe(true);
    } finally {
      await prepared.close();
    }
  });

  it("a cache hit refreshes the file so a later age sweep keeps it", async () => {
    const { sha256, store } = await storeBytes(join(scratchRoot, "sources"), PPTX_BYTES);
    const first = await rendererFor(store, true).prepare({
      sourceSha256: sha256,
      filename: "deck.pptx",
    });
    const cachePath = pdfPathOf(first);
    await first.close();
    const longAgo = new Date(Date.now() - 40 * 3_600_000);
    await utimes(cachePath, longAgo, longAgo);

    // A hit (fresh renderer) touches the file; its first-use sweep then keeps it.
    const second = await rendererFor(store, true, versionStubPath, {
      maxAgeMs: 24 * 3_600_000,
    }).prepare({ sourceSha256: sha256, filename: "deck.pptx" });
    try {
      expect(second.pdfPath).toBe(cachePath);
      expect((await stat(cachePath)).mtimeMs).toBeGreaterThan(longAgo.getTime() + 1000);
      expect(await exists(cachePath)).toBe(true);
    } finally {
      await second.close();
    }
  });
});
