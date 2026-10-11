// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Platform backends for the file watcher (requirements 1.5, design.md):
 * `fs.watch` with `recursive: true` on macOS/Windows, chokidar on Linux.
 */

import { watch as fsWatch } from "node:fs";
import { watch as chokidarWatch } from "chokidar";
import type { WatchBackendFactory, WatchHandle } from "./watcher.js";

/** macOS/Windows: natives rekursives fs.watch. */
export const fsWatchBackend: WatchBackendFactory = async (dir, onChange) => {
  const watcher = fsWatch(dir, { recursive: true }, () => {
    onChange();
  });
  // An EIO/EPERM must not end the process; the interval run stays the
  // safety-net strategy (1.3).
  watcher.on("error", () => {
    /* bewusst ignoriert */
  });
  return {
    async close(): Promise<void> {
      watcher.close();
    },
  };
};

/** Linux: chokidar 4 (inotify, rekursiv). */
export const chokidarBackend: WatchBackendFactory = async (dir, onChange) => {
  const watcher = chokidarWatch(dir, { ignoreInitial: true, persistent: true });
  watcher.on("all", () => {
    onChange();
  });
  return {
    async close(): Promise<void> {
      await watcher.close();
    },
  };
};

/** Selection by platform (design.md). */
export function defaultBackendForPlatform(platform: NodeJS.Platform): WatchBackendFactory {
  return platform === "linux" ? chokidarBackend : fsWatchBackend;
}

export type { WatchHandle };
