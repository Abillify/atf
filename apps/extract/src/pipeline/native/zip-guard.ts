// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/zip-guard.ts
 *
 * The pre-flight check every ZIP-based container (XLSX, VSDX, DOCX, PPTX and
 * the OOXML packages embedded in a DOCX) must pass before it is unpacked
 *
 * ## Why a guard and not just a decompression cap
 *
 * Every OOXML reader in this directory calls `unzipSync`, which materialises
 * the filtered entries in memory. A "ZIP bomb" — a few kilobytes whose central
 * directory declares gigabytes of decompressed XML, or ten thousand entries
 * each modest but together enormous — therefore expands the process before any
 * reader sees a byte of content, and the first symptom is an OOM kill that
 * takes the worker (and its lease heartbeats) down with it. The guard reads
 * only the central directory, which is O(entries) in the file size and never
 * inflates a single byte, and rejects the package up front with
 * `DOCUMENT_TOO_COMPLEX` (422) — the caller's fault, not ours, and never
 * retryable because the bytes do not change.
 *
 * ## What is checked
 *
 *  - entry count            ≤ `ZIP_MAX_ENTRIES`
 *  - sum of originalSize    ≤ `ZIP_MAX_TOTAL_BYTES`
 *  - largest originalSize   ≤ `ZIP_MAX_ENTRY_BYTES`
 *  - per-entry ratio        originalSize / compressed size ≤ `ZIP_MAX_RATIO`
 *    (only for deflated entries; a stored entry has ratio 1 by definition, and
 *    a deflated entry claiming data with a compressed size of 0 is malformed
 *    and rejected on the same grounds)
 *
 * The declared `originalSize` is trusted here — that is the point: the check
 * happens before inflation, so it can only read what the central directory
 * claims. A package that lies about its sizes still cannot blow memory,
 * because fflate's own inflate aborts on a size mismatch; the guard catches
 * the honest bombs, which are the ones that kill the process today.
 *
 * ## Error contract
 *
 * `assertZipWithinLimits` throws `ExtractError("DOCUMENT_TOO_COMPLEX")` for a
 * limit violation and lets fflate's own parse errors propagate unchanged: a
 * buffer that is not a ZIP at all stays the reader's business (its
 * never-throws contract turns that into a warning), while a limit violation is
 * a rejection the reader must NOT swallow. Readers therefore re-throw
 * `ExtractError` from their catch blocks.
 */

import { unzipSync } from "fflate";
import { documentTooComplex } from "../../errors.js";

/** The four ceilings {@link assertZipWithinLimits} enforces. */
export interface ZipLimits {
  /** ZIP_MAX_ENTRIES — largest accepted entry count. */
  maxEntries: number;
  /** ZIP_MAX_TOTAL_BYTES — largest accepted sum of uncompressed sizes. */
  maxTotalBytes: number;
  /** ZIP_MAX_ENTRY_BYTES — largest accepted single uncompressed size. */
  maxEntryBytes: number;
  /** ZIP_MAX_RATIO — largest accepted originalSize / compressed-size ratio. */
  maxRatio: number;
}

/**
 * Defaults from design §"ZIP-Guard": generous for honest documents (a 500-page
 * XLSX with images stays far below them) and tight enough that no package
 * passing the guard can exhaust a worker's heap when inflated.
 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 10_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 200 * 1024 * 1024,
  maxRatio: 100,
};

/** One central-directory entry as fflate reports it, for the violation report. */
interface ZipEntryMeta {
  name: string;
  /** Compressed size on disk, from the central directory. */
  size: number;
  /** Declared uncompressed size. */
  originalSize: number;
  /** 0 = stored, 8 = deflate. */
  compression: number;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/**
 * Read the central directory of `buffer` without inflating anything and throw
 * `DOCUMENT_TOO_COMPLEX` when any of the four limits is exceeded.
 *
 * The metadata pass uses fflate's `filter` hook, which is invoked per entry
 * BEFORE decompression; returning `false` for every entry means the inflate
 * path never runs and the call costs one scan of the central directory.
 *
 * A buffer that is not a readable ZIP throws fflate's own error (not an
 * `ExtractError`) so the caller's existing "not a package" handling stays in
 * charge; only limit violations produce `DOCUMENT_TOO_COMPLEX`.
 */
export function assertZipWithinLimits(
  buffer: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): void {
  const entries: ZipEntryMeta[] = [];
  // fflate's `filter` hook runs per entry BEFORE decompression; returning
  // false everywhere means no inflate happens and this costs one central-
  // directory scan. A buffer that is not a readable ZIP throws fflate's own
  // error here, which the caller's "not a package" handling deals with.
  unzipSync(buffer, {
    filter: (file) => {
      entries.push({
        name: file.name,
        size: file.size,
        originalSize: file.originalSize,
        compression: file.compression,
      });
      return false;
    },
  });

  if (entries.length > limits.maxEntries) {
    throw documentTooComplex(
      `The ZIP package declares ${entries.length} entries; the limit is ${limits.maxEntries}`,
      { violation: "entries", observed: entries.length, limit: limits.maxEntries },
    );
  }

  let totalOriginalSize = 0;
  for (const entry of entries) {
    totalOriginalSize += entry.originalSize;
  }
  if (totalOriginalSize > limits.maxTotalBytes) {
    throw documentTooComplex(
      `The ZIP package declares ${formatBytes(totalOriginalSize)} uncompressed across ` +
        `${entries.length} entries; the limit is ${formatBytes(limits.maxTotalBytes)}`,
      {
        violation: "totalBytes",
        observedBytes: totalOriginalSize,
        limitBytes: limits.maxTotalBytes,
        entryCount: entries.length,
      },
    );
  }

  for (const entry of entries) {
    if (entry.originalSize > limits.maxEntryBytes) {
      throw documentTooComplex(
        `The ZIP entry "${entry.name}" declares ${formatBytes(entry.originalSize)} ` +
          `uncompressed; the limit is ${formatBytes(limits.maxEntryBytes)}`,
        {
          violation: "entryBytes",
          entry: entry.name,
          observedBytes: entry.originalSize,
          limitBytes: limits.maxEntryBytes,
        },
      );
    }
    if (entry.compression === 0) continue; // stored: ratio is 1 by definition
    if (entry.size === 0) {
      // A deflated entry declaring content with no compressed bytes cannot
      // exist; treat it as malformed rather than dividing by zero.
      throw documentTooComplex(
        `The ZIP entry "${entry.name}" declares ${entry.originalSize} bytes with a ` +
          `compressed size of 0`,
        { violation: "ratio", entry: entry.name, observed: "compressed size 0" },
      );
    }
    const ratio = entry.originalSize / entry.size;
    if (ratio > limits.maxRatio) {
      throw documentTooComplex(
        `The ZIP entry "${entry.name}" has a compression ratio of ${Math.round(ratio)}:1 ` +
          `(${formatBytes(entry.size)} compressed, ${formatBytes(entry.originalSize)} ` +
          `uncompressed); the limit is ${limits.maxRatio}:1`,
        {
          violation: "ratio",
          entry: entry.name,
          observedRatio: Math.round(ratio),
          limitRatio: limits.maxRatio,
          compressedBytes: entry.size,
          originalBytes: entry.originalSize,
        },
      );
    }
  }
}
