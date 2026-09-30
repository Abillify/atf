// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Plattform-Backends fuer den Datei-Watcher (requirements 1.5, design.md):
 * `fs.watch` mit `recursive: true` auf macOS/Windows, chokidar auf Linux.
 */

import { watch as fsWatch } from "node:fs";
import { watch as chokidarWatch } from "chokidar";
import type { WatchBackendFactory, WatchHandle } from "./watcher.js";

/** macOS/Windows: natives rekursives fs.watch. */
export const fsWatchBackend: WatchBackendFactory = async (dir, onChange) => {
  const watcher = fsWatch(dir, { recursive: true }, () => {
    onChange();
  });
  // Ein EIO/EPERM darf den Prozess nicht beenden — der Intervall-Lauf bleibt
  // die Sicherheitsnetz-Strategie (1.3).
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

/** Auswahl gemaess Plattform (design.md). */
export function defaultBackendForPlatform(platform: NodeJS.Platform): WatchBackendFactory {
  return platform === "linux" ? chokidarBackend : fsWatchBackend;
}

export type { WatchHandle };
