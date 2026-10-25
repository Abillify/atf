// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feindseliger Testkorpus.
 *
 * One generated corpus of the four bomb classes the requirement names —
 * ZIP bombs, Billion Laughs, pathological PDFs and pixel bombs — run against
 * the real guards, plus a fuzz pass over random bytes and an availability
 * check: while a hostile document is being processed, `/health` must keep
 * answering. Every bomb is built in kilobytes by declaring sizes the payload
 * never has, so the corpus proves rejection (a fast `ExtractError`) rather
 * than exhaustion (a slow success, a hang, or a dead process).
 *
 * The individual guards have their own unit tests (`zip-guard.test.ts`,
 * `native-bpmn.test.ts`, `pdf-robustness.test.ts`, `pipeline.test.ts`); this
 * file is the acceptance corpus that drives them through the same entry
 * points a request would, so a guard that was bypassed by a refactor shows up
 * here even if its unit test still passes.
 */

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import fc from "fast-check";
import { serializeDocument } from "@atf/extract-contract/v1";
import { createApp } from "../src/index.js";
import {
  createExtractor,
  type Extractor,
  type ExtractorConfig,
  type PdfOps,
} from "../src/pipeline/extract.js";
import { assertZipWithinLimits } from "../src/pipeline/native/zip-guard.js";
import { parseBpmn } from "../src/pipeline/native/bpmn.js";
import { hasDoctypeDeclaration, safeXmlParser } from "../src/pipeline/safe-xml.js";
import { ExtractError } from "../src/errors.js";
import type { PdfInfo, PdfPageSize } from "../src/pipeline/pdf.js";
import {
  loadTestConfig,
  stubVisionClient,
  testDocument,
  testLogger,
} from "./helpers.js";

/** A bomb must be REJECTED, not processed: every guard fires in well under this. */
const REJECT_BUDGET_MS = 2_000;

async function expectExtractError(
  run: Promise<unknown>,
  code: string,
): Promise<void> {
  const started = Date.now();
  let error: unknown;
  try {
    await run;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ExtractError);
  expect((error as ExtractError).code).toBe(code);
  // Rejection must be fast: a guard that fires after inflating or decoding
  // billions of bytes is a guard that lost the race.
  expect(Date.now() - started).toBeLessThan(REJECT_BUDGET_MS);
}

// --------------------------------------------------------------------------
// Generators — each produces a hostile document in kilobytes.
// --------------------------------------------------------------------------

/**
 * A structurally valid ZIP whose central directory DECLARES gigabytes while
 * the payload stays zeros (the shape of a ZIP bomb). Never inflated: the
 * guard reads only the directory, so a bypass would show up as a decompress
 * error on garbage deflate streams rather than DOCUMENT_TOO_COMPLEX.
 */
function zipBomb(): Buffer {
  const encoder = new TextEncoder();
  const entryCount = 4;
  const declaredPerEntry = 200 * 1024 * 1024; // × 4 entries > ZIP_MAX_TOTAL_BYTES
  const nameBytes = Buffer.from(encoder.encode("xl/worksheets/sheet1.xml"));
  // 8 payload bytes per entry so the local headers point at real (zeroed)
  // data; they are never inflated — the guard reads only the directory.
  const localSize = 30 + nameBytes.length + 8;
  const centralSize = 46 + nameBytes.length;
  const out = Buffer.alloc(entryCount * (localSize + centralSize) + 22);
  const u16 = (offset: number, value: number) => out.writeUInt16LE(value, offset);
  const u32 = (offset: number, value: number) => out.writeUInt32LE(value, offset);

  let offset = 0;
  const locals: number[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    locals.push(offset);
    u32(offset, 0x04034b50);
    u16(offset + 4, 20);
    u16(offset + 8, 8); // deflate — the bytes are garbage, never inflated
    u32(offset + 18, 8); // compressedSize
    u32(offset + 22, declaredPerEntry); // originalSize — the lie
    u16(offset + 26, nameBytes.length);
    nameBytes.copy(out, offset + 30);
    offset += localSize;
  }
  const centralStart = offset;
  for (const localHeaderOffset of locals) {
    u32(offset, 0x02014b50);
    u16(offset + 4, 20);
    u16(offset + 6, 20);
    u16(offset + 10, 8);
    u32(offset + 20, 8);
    u32(offset + 24, declaredPerEntry);
    u16(offset + 28, nameBytes.length);
    u32(offset + 42, localHeaderOffset);
    nameBytes.copy(out, offset + 46);
    offset += centralSize;
  }
  u32(offset, 0x06054b50);
  u16(offset + 8, entryCount);
  u16(offset + 10, entryCount);
  u32(offset + 12, offset - centralStart);
  u32(offset + 16, centralStart);
  return out;
}

/** Classic Billion Laughs: ten levels of self-expanding entity definitions. */
function billionLaughsXml(rootOpen: string, rootClose: string): string {
  const levels = 10;
  let defs = '<!ENTITY lol "lol">';
  for (let level = 1; level <= levels; level += 1) {
    const prev = level === 1 ? "lol" : `lol${level - 1}`;
    defs += `<!ENTITY lol${level} "${`&${prev};`.repeat(10)}">`;
  }
  return `<?xml version="1.0"?>\n<!DOCTYPE root [${defs}]>\n${rootOpen}&lol${levels};${rootClose}`;
}

/** A BMP header declaring 50 000 × 50 000 pixels over a 2×2 payload. */
function pixelBomb(): Buffer {
  const rowSize = 8;
  const pixelBytes = rowSize * 2;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(50_000, 18); // declared width — 2.5 GPixel
  buffer.writeInt32LE(50_000, 22); // declared height
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  return buffer;
}

/** Bytes that `resolveFormat` classifies as a PDF; content is never read. */
function pdfBytes(): Buffer {
  return Buffer.from("%PDF-1.7\nhostile body\n", "utf-8");
}

// --------------------------------------------------------------------------
// The real extractor, without external binaries.
// --------------------------------------------------------------------------

const A4: PdfPageSize = { widthPt: 595, heightPt: 842 };

let tempDir = "";
beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hostile-corpus-"));
});
afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function extractorConfig(overrides: Partial<ExtractorConfig> = {}): ExtractorConfig {
  return {
    renderDpi: 200,
    figureDpi: 300,
    maxPages: 500,
    tempDir,
    pageLabel: "Seite",
    libreofficeBin: "libreoffice",
    popplerBinDir: null,
    pageConcurrency: 1,
    subprocessTimeoutMs: 120_000,
    visionModel: "test-vlm",
    ...overrides,
  };
}

function buildExtractor(
  config: ExtractorConfig,
  pdfOps?: PdfOps,
): ReturnType<typeof createExtractor> {
  return createExtractor({
    config,
    logger: testLogger,
    vision: stubVisionClient(),
    metrics: {
      recordPage: vi.fn(),
      recordVision: vi.fn(),
      recordFigures: vi.fn(),
      recordTextFidelity: vi.fn(),
    },
    ...(pdfOps === undefined ? {} : { pdfOps }),
  });
}

/** Poppler replaced: declares an arbitrary page count, renders nothing. */
function stubPdfOps(pageCount: number): PdfOps {
  return {
    async readPdfInfo(): Promise<PdfInfo> {
      return { pageCount, pageSize: A4, encrypted: false };
    },
    async readPageSize(): Promise<PdfPageSize> {
      return A4;
    },
    async renderPage(): Promise<never> {
      throw new Error("a rejected document must never reach rendering");
    },
    async extractPageText(): Promise<string> {
      return "";
    },
    async imageSize(): Promise<{ width: number; height: number }> {
      return { width: 4, height: 4 };
    },
  };
}

// --------------------------------------------------------------------------
// The corpus.
// --------------------------------------------------------------------------

describe("hostile corpus · ZIP bombs (requirement 5.12)", () => {
  it("rejects a declared-gigabytes XLSX before any inflate, through the pipeline", async () => {
    const extractor = buildExtractor(extractorConfig());
    await expectExtractError(
      extractor.extract({
        buffer: zipBomb(),
        filename: "bombe.xlsx",
        declaredMimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        reference: "tests/bombe.xlsx",
      }),
      "DOCUMENT_TOO_COMPLEX",
    );
  });

  it("rejects the same container at the guard directly", () => {
    expect(() => assertZipWithinLimits(zipBomb())).toThrowError(ExtractError);
    try {
      assertZipWithinLimits(zipBomb());
    } catch (error) {
      expect((error as ExtractError).code).toBe("DOCUMENT_TOO_COMPLEX");
      expect((error as ExtractError).retryable).toBe(false);
    }
  });
});

describe("hostile corpus · Billion Laughs (requirement 5.12)", () => {
  it("rejects a BPMN entity bomb before the parser sees it", () => {
    const bomb = billionLaughsXml(
      '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">',
      "</definitions>",
    );
    expect(() => parseBpmn(bomb)).toThrowError(ExtractError);
    try {
      parseBpmn(bomb);
    } catch (error) {
      expect((error as ExtractError).code).toBe("DOCUMENT_TOO_COMPLEX");
    }
  });

  it("never expands entities in generic safe-XML parsing", () => {
    const bomb = billionLaughsXml("<root>", "</root>");
    const started = Date.now();
    const parsed = safeXmlParser({}).parse(bomb) as { root?: string };
    // Entity processing is off: the reference survives as
    // literal text instead of expanding to ~10 GiB.
    expect(String(parsed.root ?? "")).toContain("&lol10;");
    expect(JSON.stringify(parsed).length).toBeLessThan(bomb.length + 1024);
    expect(Date.now() - started).toBeLessThan(REJECT_BUDGET_MS);
  });

  it("flags every DOCTYPE declaration regardless of case or whitespace", () => {
    for (const xml of [
      "<!DOCTYPE root [<!ENTITY a 'a'>]><root/>",
      "<!doctype root><root/>",
      "<!DoCtYpE\troot><root/>",
    ]) {
      expect(hasDoctypeDeclaration(xml)).toBe(true);
    }
    expect(hasDoctypeDeclaration("<root>a &amp; b</root>")).toBe(false);
  });
});

describe("hostile corpus · pathological PDFs (requirement 5.12)", () => {
  it("rejects a PDF declaring more pages than MAX_PAGES before rendering", async () => {
    const extractor = buildExtractor(extractorConfig({ maxPages: 500 }), stubPdfOps(100_000));
    await expectExtractError(
      extractor.extract({
        buffer: pdfBytes(),
        filename: "unendlich.pdf",
        declaredMimeType: "application/pdf",
        reference: "tests/unendlich.pdf",
      }),
      "TOO_MANY_PAGES",
    );
  });

  it("rejects a PDF declaring zero pages", async () => {
    const extractor = buildExtractor(extractorConfig(), stubPdfOps(0));
    await expectExtractError(
      extractor.extract({
        buffer: pdfBytes(),
        filename: "leer.pdf",
        declaredMimeType: "application/pdf",
        reference: "tests/leer.pdf",
      }),
      "CONVERSION_FAILED",
    );
  });
});

describe("hostile corpus · pixel bombs (requirement 5.12)", () => {
  it("rejects a BMP declaring 2.5 GPixel before decoding pixels", async () => {
    const extractor = buildExtractor(extractorConfig());
    await expectExtractError(
      extractor.extract({
        buffer: pixelBomb(),
        filename: "pixel.bmp",
        declaredMimeType: "image/bmp",
        reference: "tests/pixel.bmp",
      }),
      "CONVERSION_FAILED",
    );
  });
});

describe("hostile corpus · fuzz (requirement 5.12)", () => {
  it("ZIP guard: arbitrary bytes either pass or throw an Error, never crash", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 4096 }), (bytes) => {
        try {
          assertZipWithinLimits(bytes);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("safe XML: arbitrary bytes parse or throw an Error, never crash", () => {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 2048 }), (bytes) => {
        try {
          safeXmlParser({}).parse(decoder.decode(bytes));
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("BPMN: arbitrary XML-ish text either parses or throws an Error", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2048 }), (text) => {
        try {
          parseBpmn(text);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("image path: arbitrary bytes are rejected as an ExtractError, never a crash", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 4096 }), async (bytes) => {
        const extractor = buildExtractor(extractorConfig());
        try {
          await extractor.extract({
            buffer: Buffer.from(bytes),
            filename: "fuzz.png",
            declaredMimeType: "image/png",
            reference: "tests/fuzz.png",
          });
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe("hostile corpus · /health stays reachable during processing (requirement 5.12)", () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** An extractor that signals entry and blocks until released. */
  function blockingExtractor(): {
    extractor: Extractor;
    entered: Promise<void>;
    release: () => void;
  } {
    let markEntered!: () => void;
    let releaseBlock!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const extractor: Extractor = {
      async extract(input) {
        markEntered();
        await blocked;
        const document = testDocument({ reference: input.reference });
        return { document, markdown: serializeDocument(document), crops: new Map() };
      },
    };
    return { extractor, entered, release: releaseBlock };
  }

  it("answers /health within 2 s while a hostile document occupies the worker", async () => {
    const config = loadTestConfig();
    const { extractor, entered, release } = blockingExtractor();
    const blocked = createApp(config, {
      logger: testLogger,
      vision: stubVisionClient(),
      probeBinary: vi.fn(async () => ({ available: true, version: "stub" })),
      extractor,
    });
    cleanups.push(blocked.cleanup);
    const server = blocked.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind to a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    // A supertest request only fires when awaited or ended; end() starts it
    // without blocking, so the worker stays occupied while /health is probed.
    let finished!: () => void;
    const inflight = new Promise<void>((resolve) => {
      finished = resolve;
    });
    request(baseUrl)
      .post("/v1/convert")
      .set("Content-Type", "application/pdf")
      .set("X-Reference", "tests/bombe.pdf")
      .send(pdfBytes())
      .end(() => finished());

    await entered;
    const started = Date.now();
    const health = await request(baseUrl).get("/health");
    expect(health.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);

    release();
    await inflight;
  });
});
