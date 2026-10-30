// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Local_Source (requirements 6.1, 6.2, 15.5).
 *
 * Recursive listing with `opendir`/`lstat`: symlinks are skipped (6.2), only
 * regular files are yielded. The `quellId` is the relative path with POSIX
 * separators, NFC-normalized, so Windows and macOS derive the same
 * reference. The marker is `${mtimeMs}:${size}`. Every `open` re-checks the
 * path against the real source root (15.5).
 *
 * The quellId is an identity, not a path: names on disk keep the Unicode form
 * they were written in (folders copied from macOS are often NFD), and Linux
 * filesystems compare names byte by byte. `open` therefore maps the quellId
 * back to the on-disk name segment by segment before the guard runs.
 */

import { createReadStream } from "node:fs";
import { lstat, opendir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { isIncluded } from "./filter.js";
import { guardPath } from "./path-guard.js";
import type { SourceAdapter, SourceItem } from "./types.js";

export interface LocalSourceOptions {
  /** Absolute path of the source folder. */
  root: string;
  include?: readonly string[];
  exclude?: readonly string[];
}

/** NFC-normalize and convert to POSIX separators. */
export function toQuellId(relative: string): string {
  return relative.replaceAll(path.sep, "/").normalize("NFC");
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map an NFC quellId to the path of the entry on disk. Each segment is taken
 * as-is when that name exists, otherwise the directory is searched for the
 * one entry whose NFC form equals the segment. Two different entries with the
 * same NFC form are ambiguous and rejected rather than guessed. A segment
 * that matches nothing is kept unchanged, so the path guard reports it as not
 * resolvable. The result is still untrusted: `open` runs it through the guard.
 */
export async function resolveOnDisk(root: string, quellId: string): Promise<string> {
  let current = root;
  for (const segment of quellId.split("/")) {
    const direct = path.join(current, segment);
    if (segment === "" || segment === "." || segment === ".." || (await exists(direct))) {
      current = direct;
      continue;
    }
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      current = direct;
      continue;
    }
    const matches = names.filter((name) => name.normalize("NFC") === segment);
    if (matches.length > 1) {
      throw new Error(`ambiguous Unicode name for ${quellId}`);
    }
    current = matches.length === 1 ? path.join(current, matches[0] as string) : direct;
  }
  return current;
}

async function* walk(
  root: string,
  dir: string,
  signal: AbortSignal,
  include?: readonly string[],
  exclude?: readonly string[],
): AsyncGenerator<SourceItem> {
  if (Boolean(signal.aborted)) throw new Error("listing aborted");
  const handle = await opendir(dir);
  for await (const entry of handle) {
    if (Boolean(signal.aborted)) throw new Error("listing aborted");
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(root, fullPath, signal, include, exclude);
      continue;
    }
    if (entry.isFile()) {
      const stats = await lstat(fullPath);
      // lstat again: the dirent type can be a guess on some filesystems.
      if (!stats.isFile()) continue;
      const relative = path.relative(root, fullPath);
      const quellId = toQuellId(relative);
      if (!isIncluded(quellId, include, exclude)) continue;
      yield {
        quellId,
        name: path.posix.basename(quellId),
        size: stats.size,
        modified: stats.mtime,
        marker: `${stats.mtimeMs}:${stats.size}`,
      };
      continue;
    }
    // Symlinks, sockets, fifos, devices: skipped (6.2).
  }
}

export function createLocalSource(options: LocalSourceOptions): SourceAdapter {
  const root = path.resolve(options.root);
  return {
    async *list(signal: AbortSignal): AsyncIterable<SourceItem> {
      // A missing/unreadable root throws → the listing is incomplete (6.12).
      if (Boolean(signal.aborted)) throw new Error("listing aborted");
      const realRoot = await realpath(root);
      yield* walk(realRoot, realRoot, signal, options.include, options.exclude);
    },
    async open(item: SourceItem, signal: AbortSignal): Promise<Readable> {
      let candidate: string;
      try {
        candidate = await resolveOnDisk(root, item.quellId);
      } catch (error) {
        throw new Error(`path guard rejected ${item.quellId}: ${(error as Error).message}`);
      }
      const guard = await guardPath(root, candidate);
      if (!guard.ok) {
        throw new Error(`path guard rejected ${item.quellId}: ${guard.reason}`);
      }
      if (Boolean(signal.aborted)) throw new Error("open aborted");
      return createReadStream(guard.realPath);
    },
  };
}
