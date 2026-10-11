// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * File watcher for local sources with `watch: true` (requirements 1.5,
 * 1.6, design.md): changes lead to a full sync run of the source.
 *
 * Platform backends: `fs.watch` with `recursive: true` on macOS/Windows,
 * chokidar on Linux (4.x). Debounce 5 s, maximum wait 30 s: an ongoing
 * change sequence starts a run after 30 s at the latest
 * (Requirement 1.6).
 *
 * The backend is injectable ({@link WatchBackendFactory}) so tests work
 * without real file-system events (Task 18.7).
 */

import { fsWatchBackend } from "./watch-backends.js";

/** Return value of an active watcher. */
export interface WatchHandle {
  /** Beobachtung beenden; idempotent. */
  close(): Promise<void>;
}

/**
 * Backend contract: calls `onChange()` on every change under `dir`.
 * Implementations may batch events; the debounce logic lives in the
 * watcher itself.
 */
export type WatchBackendFactory = (
  dir: string,
  onChange: () => void,
) => Promise<WatchHandle>;

export interface WatcherOptions {
  /** Zu beobachtendes Verzeichnis. */
  dir: string;
  /** Starts a full sync run of the source. */
  trigger: () => void;
  /** Debounce window in ms (default 5000, Requirement 1.6). */
  debounceMs?: number;
  /** Maximum postponement in ms (default 30000, Requirement 1.6). */
  maxDelayMs?: number;
  /** Backend-Auswahl; Default: plattformabhaengig (1.5). */
  backend?: WatchBackendFactory;
  /** Timer injection for tests (fake timers usually patch the globals). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Starts a debounce watcher on `dir`. Every event within the debounce
 * window postpones the start; after `maxDelayMs` at the latest it fires,
 * even with ongoing events.
 */
export async function startWatcher(options: WatcherOptions): Promise<WatchHandle> {
  const debounceMs = options.debounceMs ?? 5_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  const backend = options.backend ?? fsWatchBackend;

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const fire = (): void => {
    if (closed) return;
    if (debounce !== undefined) {
      clearTimer(debounce);
      debounce = undefined;
    }
    if (deadline !== undefined) {
      clearTimer(deadline);
      deadline = undefined;
    }
    options.trigger();
  };

  const onChange = (): void => {
    if (closed) return;
    if (debounce !== undefined) clearTimer(debounce);
    debounce = setTimer(fire, debounceMs);
    if (deadline === undefined) {
      // After maxDelayMs at the latest, even if events keep coming.
      deadline = setTimer(fire, maxDelayMs);
    }
  };

  const inner = await backend(options.dir, onChange);

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (debounce !== undefined) clearTimer(debounce);
      if (deadline !== undefined) clearTimer(deadline);
      await inner.close();
    },
  };
}
