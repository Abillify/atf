// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Datei-Watcher fuer lokale Quellen mit `watch: true` (requirements 1.5,
 * 1.6, design.md): Aenderungen fuehren zu einem vollen Sync-Lauf der Quelle.
 *
 * Plattform-Backends: `fs.watch` mit `recursive: true` auf macOS/Windows,
 * chokidar auf Linux (4.x). Debounce 5 s, maximale Wartezeit 30 s — eine
 * anhaltende Aenderungssequenz startet spaetestens nach 30 s einen Lauf
 * (Anforderung 1.6).
 *
 * Das Backend ist injizierbar ({@link WatchBackendFactory}), damit Tests ohne
 * echte Dateisystem-Events auskommen (Task 18.7).
 */

import { fsWatchBackend } from "./watch-backends.js";

/** Rueckgabe eines aktiven Watchers. */
export interface WatchHandle {
  /** Beobachtung beenden; idempotent. */
  close(): Promise<void>;
}

/**
 * Backend-Vertrag: ruft `onChange()` bei jeder Aenderung unter `dir` auf.
 * Implementierungen duerfen Events buendeln — die Debounce-Logik liegt im
 * Watcher selbst.
 */
export type WatchBackendFactory = (
  dir: string,
  onChange: () => void,
) => Promise<WatchHandle>;

export interface WatcherOptions {
  /** Zu beobachtendes Verzeichnis. */
  dir: string;
  /** Startet einen vollen Sync-Lauf der Quelle. */
  trigger: () => void;
  /** Debounce-Fenster in ms (Default 5000, Anforderung 1.6). */
  debounceMs?: number;
  /** Maximale Aufschubzeit in ms (Default 30000, Anforderung 1.6). */
  maxDelayMs?: number;
  /** Backend-Auswahl; Default: plattformabhaengig (1.5). */
  backend?: WatchBackendFactory;
  /** Timer-Injektion fuer Tests (fake timers patchen i. d. R. die Globals). */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Startet einen Debounce-Watcher auf `dir`. Jeder Event innerhalb des
 * Debounce-Fensters verschiebt den Start; nach spaetestens `maxDelayMs`
 * wird ausgeloesst, auch bei anhaltenden Events.
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
      // Spaetestens nach maxDelayMs, auch wenn Events nicht abreissen.
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
