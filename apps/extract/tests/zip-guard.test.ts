// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the ZIP pre-flight guard (requirement 5.1) and the embedded-message
 * depth limit (requirement 5.4). The synthetic-ZIP builder writes central
 * directories whose entries DECLARE sizes without any payload ever being
 * inflated — the exact shape of a ZIP bomb — so the tests stay in the
 * kilobyte range while the guard sees gigabytes.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { strToU8, zipSync } from "fflate";
import { ExtractError } from "../src/errors.js";
import {
  assertZipWithinLimits,
  DEFAULT_ZIP_LIMITS,
  type ZipLimits,
} from "../src/pipeline/native/zip-guard.js";
import { readXlsx } from "../src/pipeline/native/xlsx.js";
import { parseDocxHeadings } from "../src/pipeline/native/docx-headings.js";
import { parseVsdx } from "../src/pipeline/native/vsdx.js";
import { extractDocxEmbeddings } from "../src/pipeline/native/docx-embeddings.js";

/** One central-directory entry as the synthetic builder writes it. */
interface SyntheticEntry {
  name: string;
  originalSize: number;
  compressedSize: number;
  /** 0 = stored, 8 = deflate. */
  compression: number;
}

/**
 * Write a structurally valid ZIP whose entries declare arbitrary sizes. The
 * payload bytes are zeros and are never inflated: the guard inspects only the
 * central directory, and a rejection must happen BEFORE any decompression —
 * if the guard ever tried to inflate, the deflate streams would be garbage and
 * the test would see a decompression error instead of DOCUMENT_TOO_COMPLEX.
 */
function buildSyntheticZip(entries: readonly SyntheticEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = entries.map((entry) => ({ entry, name: encoder.encode(entry.name) }));
  let localBytes = 0;
  parts.forEach(({ entry, name }) => {
    localBytes += 30 + name.length + entry.compressedSize;
  });
  let centralBytes = 0;
  parts.forEach(({ name }) => {
    centralBytes += 46 + name.length;
  });
  const out = new Uint8Array(localBytes + centralBytes + 22);
  const view = new DataView(out.buffer);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);

  let offset = 0;
  const locals = parts.map(({ entry, name }) => {
    const localHeaderOffset = offset;
    u32(offset, 0x04034b50); // local file header signature
    u16(offset + 4, 20); // version needed
    u16(offset + 6, 0); // flags
    u16(offset + 8, entry.compression);
    u16(offset + 10, 0); // mod time
    u16(offset + 12, 0); // mod date
    u32(offset + 14, 0); // crc — never verified, the entry is never inflated
    u32(offset + 18, entry.compressedSize);
    u32(offset + 22, entry.originalSize);
    u16(offset + 26, name.length);
    u16(offset + 28, 0); // extra length
    out.set(name, offset + 30);
    offset += 30 + name.length + entry.compressedSize;
    return { entry, name, localHeaderOffset };
  });

  const centralStart = offset;
  locals.forEach(({ entry, name, localHeaderOffset }) => {
    u32(offset, 0x02014b50); // central directory header signature
    u16(offset + 4, 20); // version made by
    u16(offset + 6, 20); // version needed
    u16(offset + 8, 0); // flags
    u16(offset + 10, entry.compression);
    u16(offset + 12, 0); // mod time
    u16(offset + 14, 0); // mod date
    u32(offset + 16, 0); // crc
    u32(offset + 20, entry.compressedSize);
    u32(offset + 24, entry.originalSize);
    u16(offset + 28, name.length);
    u16(offset + 30, 0); // extra length
    u16(offset + 32, 0); // comment length
    u16(offset + 34, 0); // disk start
    u16(offset + 36, 0); // internal attributes
    u32(offset + 38, 0); // external attributes
    u32(offset + 42, localHeaderOffset);
    out.set(name, offset + 46);
    offset += 46 + name.length;
  });

  u32(offset, 0x06054b50); // end of central directory signature
  u16(offset + 4, 0); // this disk
  u16(offset + 6, 0); // central directory disk
  u16(offset + 8, entries.length); // entries on this disk
  u16(offset + 10, entries.length); // total entries
  u32(offset + 12, offset - centralStart); // central directory size
  u32(offset + 16, centralStart); // central directory offset
  u16(offset + 20, 0); // comment length
  return out;
}

/** Assert the run throws DOCUMENT_TOO_COMPLEX (422, never retryable). */
function expectTooComplex(run: () => unknown): ExtractError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractError);
    const err = error as ExtractError;
    expect(err.code).toBe("DOCUMENT_TOO_COMPLEX");
    expect(err.status).toBe(422);
    expect(err.retryable).toBe(false);
    return err;
  }
  throw new Error("expected the ZIP guard to reject the package");
}

describe("assertZipWithinLimits", () => {
  it("exposes the design defaults", () => {
    expect(DEFAULT_ZIP_LIMITS).toEqual({
      maxEntries: 10_000,
      maxTotalBytes: 512 * 1024 * 1024,
      maxEntryBytes: 200 * 1024 * 1024,
      maxRatio: 100,
    });
  });

  it("lets an honest package through", () => {
    const zip = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "xl/workbook.xml": strToU8("<workbook><sheets/></workbook>"),
      "xl/worksheets/sheet1.xml": strToU8("<worksheet><row/></worksheet>"),
    });
    expect(() => assertZipWithinLimits(zip)).not.toThrow();
  });

  it("rejects too many entries before inflating anything", () => {
    const zip = buildSyntheticZip(
      Array.from({ length: 5 }, (_, index) => ({
        name: `part-${index}.xml`,
        originalSize: 64,
        compressedSize: 64,
        compression: 0,
      })),
    );
    const err = expectTooComplex(() =>
      assertZipWithinLimits(zip, { ...DEFAULT_ZIP_LIMITS, maxEntries: 4 }),
    );
    expect(err.context.violation).toBe("entries");
    expect(err.context.observed).toBe(5);
  });

  it("rejects a declared total above ZIP_MAX_TOTAL_BYTES", () => {
    const zip = buildSyntheticZip([
      { name: "a.xml", originalSize: 1024, compressedSize: 1024, compression: 0 },
      { name: "b.xml", originalSize: 1024, compressedSize: 1024, compression: 0 },
    ]);
    const err = expectTooComplex(() =>
      assertZipWithinLimits(zip, { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 1500 }),
    );
    expect(err.context.violation).toBe("totalBytes");
    expect(err.context.observedBytes).toBe(2048);
  });

  it("rejects a single entry above ZIP_MAX_ENTRY_BYTES", () => {
    const zip = buildSyntheticZip([
      { name: "xl/worksheets/sheet1.xml", originalSize: 4096, compressedSize: 4096, compression: 0 },
    ]);
    const err = expectTooComplex(() =>
      assertZipWithinLimits(zip, { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 2048 }),
    );
    expect(err.context.violation).toBe("entryBytes");
    expect(err.context.entry).toBe("xl/worksheets/sheet1.xml");
  });

  it("rejects a deflated entry above ZIP_MAX_RATIO", () => {
    // A real deflate stream: 200 KB of one byte compresses to a few hundred
    // bytes, so the honest ratio is in the hundreds — above the default 100.
    const zip = zipSync({ "big.xml": strToU8("a".repeat(200_000)) }, { level: 9 });
    const err = expectTooComplex(() => assertZipWithinLimits(zip));
    expect(err.context.violation).toBe("ratio");
    expect((err.context.observedRatio as number) > 100).toBe(true);
  });

  it("does not apply the ratio to stored entries", () => {
    // Stored entries have ratio 1 by definition; the central directory's
    // declared sizes must not trip the ratio check.
    const zip = buildSyntheticZip([
      { name: "stored.bin", originalSize: 1_000_000, compressedSize: 1, compression: 0 },
    ]);
    expect(() =>
      assertZipWithinLimits(zip, { ...DEFAULT_ZIP_LIMITS, maxRatio: 1 }),
    ).not.toThrow();
  });

  it("rejects a deflated entry that declares content with zero compressed bytes", () => {
    const zip = buildSyntheticZip([
      { name: "broken.xml", originalSize: 10, compressedSize: 0, compression: 8 },
    ]);
    const err = expectTooComplex(() => assertZipWithinLimits(zip));
    expect(err.context.violation).toBe("ratio");
  });

  it("lets a non-ZIP buffer raise fflate's own error, not an ExtractError", () => {
    // The readers' never-throws contract depends on this: "not a package"
    // stays a warning, only limit violations reject.
    let thrown: unknown = null;
    try {
      assertZipWithinLimits(new Uint8Array([1, 2, 3, 4]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown).not.toBeInstanceOf(ExtractError);
  });
});

describe("native readers reject ZIP bombs instead of warning", () => {
  // 300 MiB declared in one deflated entry: above the 200 MiB single-entry
  // default, so every reader must reject with DOCUMENT_TOO_COMPLEX.
  const bomb = buildSyntheticZip([
    {
      name: "xl/worksheets/sheet1.xml",
      originalSize: 300 * 1024 * 1024,
      compressedSize: 1024,
      compression: 8,
    },
  ]);

  it("readXlsx rejects the bomb", async () => {
    const settled = await readXlsx(bomb).then(
      () => null,
      (error: unknown) => error,
    );
    expect(settled).toBeInstanceOf(ExtractError);
    expect((settled as ExtractError).code).toBe("DOCUMENT_TOO_COMPLEX");
    expect((settled as ExtractError).status).toBe(422);
  });

  it("parseDocxHeadings rejects the bomb", () => {
    expectTooComplex(() => parseDocxHeadings(bomb));
  });

  it("parseVsdx rejects the bomb", () => {
    expectTooComplex(() => parseVsdx(bomb));
  });

  it("extractDocxEmbeddings rejects the bomb", () => {
    expectTooComplex(() => extractDocxEmbeddings(bomb));
  });

  it("still degrades to a warning for bytes that are not a package", () => {
    // The guard must not change the existing contract for non-ZIP input.
    expect(extractDocxEmbeddings(new Uint8Array([1, 2, 3])).sources).toEqual([]);
    expect(parseDocxHeadings(new Uint8Array([1, 2, 3])).warnings.length).toBeGreaterThan(0);
  });
});

describe("ZIP guard (Property 8, requirement 5.1)", () => {
  /**
   * Independent oracle: recomputes the four limits from the entry metadata
   * with multiplication instead of the guard's division, so the check is not
   * the same expression.
   */
  function violatesLimits(entries: readonly SyntheticEntry[], limits: ZipLimits): boolean {
    if (entries.length > limits.maxEntries) return true;
    const total = entries.reduce((sum, entry) => sum + entry.originalSize, 0);
    if (total > limits.maxTotalBytes) return true;
    for (const entry of entries) {
      if (entry.originalSize > limits.maxEntryBytes) return true;
      if (entry.compression === 0) continue; // stored: ratio 1 by definition
      if (entry.compressedSize === 0) return true; // malformed
      if (entry.originalSize > limits.maxRatio * entry.compressedSize) return true;
    }
    return false;
  }

  const entryArb = fc.record({
    name: fc.stringMatching(/^[a-z0-9._-]{1,12}$/),
    originalSize: fc.integer({ min: 0, max: 16 * 1024 * 1024 }),
    compressedSize: fc.integer({ min: 0, max: 512 }),
    compression: fc.constantFrom(0, 8),
  });

  const limitsArb = fc.record({
    maxEntries: fc.integer({ min: 1, max: 25 }),
    maxTotalBytes: fc.integer({ min: 0, max: 32 * 1024 * 1024 }),
    maxEntryBytes: fc.integer({ min: 0, max: 16 * 1024 * 1024 }),
    maxRatio: fc.integer({ min: 1, max: 200 }),
  });

  it("rejects exactly when a limit is exceeded, and never inflates", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { minLength: 0, maxLength: 20 }), limitsArb, (entries, limits) => {
        const zip = buildSyntheticZip(entries);
        const expected = violatesLimits(entries, limits);
        let thrown: unknown = null;
        try {
          assertZipWithinLimits(zip, limits);
        } catch (error) {
          thrown = error;
        }
        if (expected) {
          // The deflate payloads are garbage on purpose: a DOCUMENT_TOO_COMPLEX
          // proves the rejection came from the central directory, before any
          // inflate — a decompression attempt would raise a different error.
          expect(thrown).toBeInstanceOf(ExtractError);
          expect((thrown as ExtractError).code).toBe("DOCUMENT_TOO_COMPLEX");
        } else {
          expect(thrown).toBeNull();
          // All four invariants hold for an accepted package.
          expect(entries.length).toBeLessThanOrEqual(limits.maxEntries);
          const total = entries.reduce((sum, entry) => sum + entry.originalSize, 0);
          expect(total).toBeLessThanOrEqual(limits.maxTotalBytes);
          for (const entry of entries) {
            expect(entry.originalSize).toBeLessThanOrEqual(limits.maxEntryBytes);
            if (entry.compression !== 0) {
              expect(entry.compressedSize).toBeGreaterThan(0);
              expect(entry.originalSize).toBeLessThanOrEqual(
                limits.maxRatio * entry.compressedSize,
              );
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
