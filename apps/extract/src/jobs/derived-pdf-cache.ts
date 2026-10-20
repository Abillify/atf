// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/derived-pdf-cache.ts
 *
 * Lifecycle of the derived-PDF cache (`TEMP_DIR/derived-pdf`, ADR 0033).
 *
 * The cache holds the full content of converted documents, so it needs the
 * same lifecycle rules as every other store that does:
 *
 *  - **Erasure.** `removeDerivedPdfsFor` deletes every cached conversion of a
 *    source (all converter identities: file names are
 *    `<sha256>-<identity>.pdf`). `DELETE /v2/documents/{reference}` and the
 *    DSAR erasure call it for the source digests of the jobs they remove.
 *  - **Retention.** `evictDerivedPdfs` enforces an age and a size ceiling
 *    (`DERIVED_PDF_CACHE_MAX_AGE_HOURS`, `DERIVED_PDF_CACHE_MAX_MB`). "Age" is
 *    time since last use: a cache hit refreshes the file's mtime
 *    (`touchDerivedPdf`). Files a running job is reading are never evicted
 *    (`pinned`), because poppler re-opens the path for every page.
 *
 * Everything here is best effort and never throws into the caller: a cache
 * that cannot be cleaned must not fail a job or an erasure response (the
 * erasure handler reports the failure separately).
 */

import { readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

/** Directory name of the cache under the scratch root. */
export const DERIVED_PDF_DIR = "derived-pdf";

/** A SHA-256 hex digest — the only shape a cache file name may start with. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** `<sha256>-<16 hex identity>.pdf` */
const CACHE_FILE = /^([0-9a-f]{64})-[0-9a-f]{16}\.pdf$/;

export interface DerivedPdfCacheLimits {
  /** Total size ceiling in bytes; 0 = unlimited. */
  maxBytes: number;
  /** Time-since-last-use ceiling in milliseconds; 0 = unlimited. */
  maxAgeMs: number;
}

export interface EvictionResult {
  removedByAge: number;
  removedBySize: number;
  /** Bytes still cached after the sweep (pinned files included). */
  remainingBytes: number;
}

/** The cache directory under a scratch root. */
export function derivedPdfCacheDir(scratchRoot: string): string {
  return join(scratchRoot, DERIVED_PDF_DIR);
}

/** True for a name this module created (and therefore may delete). */
export function isCacheFileName(name: string): boolean {
  return CACHE_FILE.test(name);
}

/**
 * Delete every cached conversion of the given source digests. Returns the
 * number of files removed. Unknown or malformed digests are ignored; a missing
 * cache directory is not an error.
 */
export async function removeDerivedPdfsFor(
  cacheDir: string,
  digests: Iterable<string>,
): Promise<number> {
  const wanted = new Set<string>();
  for (const digest of digests) {
    if (SHA256_HEX.test(digest)) wanted.add(digest);
  }
  if (wanted.size === 0) return 0;
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = CACHE_FILE.exec(name);
    if (match === null || !wanted.has(match[1] ?? "")) continue;
    try {
      await rm(join(cacheDir, name), { force: true });
      removed += 1;
    } catch {
      // Best effort; the next sweep or erasure retry removes it.
    }
  }
  return removed;
}

/** Refresh the last-use time of a cache file (a hit counts as use). */
export async function touchDerivedPdf(path: string, now = new Date()): Promise<void> {
  await utimes(path, now, now).catch(() => {});
}

/**
 * Enforce the retention limits. Files older than `maxAgeMs` go first; if the
 * remainder still exceeds `maxBytes`, the least recently used files go until it
 * fits. `pinned` paths (in use by a running job) are skipped by both rules.
 */
export async function evictDerivedPdfs(
  cacheDir: string,
  limits: DerivedPdfCacheLimits,
  options: { now?: number; pinned?: ReadonlySet<string> } = {},
): Promise<EvictionResult> {
  const now = options.now ?? Date.now();
  const pinned = options.pinned ?? new Set<string>();
  const result: EvictionResult = {
    removedByAge: 0,
    removedBySize: 0,
    remainingBytes: 0,
  };
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return result;
  }

  const entries: Array<{ path: string; size: number; usedAt: number }> = [];
  for (const name of names) {
    if (!isCacheFileName(name)) continue;
    const path = join(cacheDir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      entries.push({ path, size: info.size, usedAt: info.mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }

  const remove = async (path: string): Promise<boolean> => {
    try {
      await rm(path, { force: true });
      return true;
    } catch {
      return false;
    }
  };

  let kept = entries;
  if (limits.maxAgeMs > 0) {
    const survivors: typeof entries = [];
    for (const entry of kept) {
      const expired = now - entry.usedAt > limits.maxAgeMs;
      if (expired && !pinned.has(entry.path) && (await remove(entry.path))) {
        result.removedByAge += 1;
      } else {
        survivors.push(entry);
      }
    }
    kept = survivors;
  }

  let total = kept.reduce((sum, entry) => sum + entry.size, 0);
  if (limits.maxBytes > 0 && total > limits.maxBytes) {
    const oldestFirst = [...kept].sort((a, b) => a.usedAt - b.usedAt);
    for (const entry of oldestFirst) {
      if (total <= limits.maxBytes) break;
      if (pinned.has(entry.path)) continue;
      if (await remove(entry.path)) {
        total -= entry.size;
        result.removedBySize += 1;
      }
    }
  }
  result.remainingBytes = total;
  return result;
}
