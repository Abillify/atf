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
 */

import { createReadStream } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
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
      const candidate = path.join(root, ...item.quellId.split("/"));
      const guard = await guardPath(root, candidate);
      if (!guard.ok) {
        throw new Error(`path guard rejected ${item.quellId}: ${guard.reason}`);
      }
      if (Boolean(signal.aborted)) throw new Error("open aborted");
      return createReadStream(guard.realPath);
    },
  };
}
