// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graceful Shutdown (requirements 7.10, 10.7).
 *
 * SIGTERM/SIGINT: keine neuen Läufe, laufende Übertragungen dürfen zu Ende
 * laufen (Grace, Default 30 s), danach Abbruch, State-Flush, Exit 0. Ein
 * zweites Signal verkürzt die Grace sofort auf null. Der Ablauf ist gegen
 * injizierbare Signal-Handler und einen injizierbaren Exit geschrieben, damit
 * Tests ihn mit Fake-Timern durchspielen können.
 */

import type { Scheduler } from "@atf/outpost-core";

export const DEFAULT_GRACE_MS = 30_000;

export type ShutdownSignal = "SIGTERM" | "SIGINT";

export interface ShutdownHandler {
  /** Registriert einen Handler; Rückgabe zum Entfernen. */
  on(signal: ShutdownSignal, handler: () => void): () => void;
}

/** Handler auf dem echten `process`. */
export const processSignals: ShutdownHandler = {
  on(signal, handler) {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  },
};

export interface ShutdownOptions {
  graceMs?: number;
  handler?: ShutdownHandler;
  /** Prozess-Exit; Default `process.exit`. */
  exit?: (code: number) => void;
  /** Injizierbare Timer (Fake-Timer in Tests). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  logger?: { info: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void };
}

export interface ShutdownHandle {
  /** Entfernt die Signal-Handler (Test-Cleanup). */
  dispose(): void;
  /** true, nachdem ein Signal eingegangen ist. */
  requested(): boolean;
  /** Wartet den Shutdown-Ablauf (für Tests und den Daemon-Hauptloop). */
  done(): Promise<void>;
}

/**
 * Installiere SIGTERM/SIGINT-Behandlung. Bei Signal:
 * 1. `scheduler.beginShutdown()` — keine neuen Läufe, Intervalle aus;
 * 2. bis `graceMs` auf laufende Läufe warten;
 * 3. `scheduler.stopAll("shutdown")` — nach Grace abbrechen + flushen;
 * 4. Exit 0.
 */
export function installShutdown(
  scheduler: Scheduler,
  options: ShutdownOptions = {},
): ShutdownHandle {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const handler = options.handler ?? processSignals;
  const exit = options.exit ?? ((code: number): never => process.exit(code));
  const setT = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT =
    options.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const logger = options.logger;

  let requested = false;
  let graceElapsed = false;
  let graceTimer: unknown;
  let resolveIdle!: () => void;
  const idleReached = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });

  const done = (async () => {
    await idleReached;
    if (!graceElapsed) clearT(graceTimer);
    await scheduler.stopAll("shutdown");
    logger?.info({ event: "shutdown.complete" }, "geordnet beendet");
    exit(0);
  })();

  const onSignal = (): void => {
    if (!requested) {
      requested = true;
      logger?.info(
        { event: "shutdown.started", graceMs },
        "Shutdown eingeleitet: keine neuen Läufe, laufende erhalten Grace",
      );
      scheduler.beginShutdown();
      graceTimer = setT(() => {
        graceElapsed = true;
        resolveIdle();
      }, graceMs);
      void scheduler.awaitIdle().then(() => {
        if (!graceElapsed) resolveIdle();
      });
      return;
    }
    // Zweites Signal: Grace sofort beenden (10.7 — "SIGTERM erneut → sofort").
    logger?.warn?.({ event: "shutdown.forced" }, "zweites Signal: Grace uebersprungen");
    graceElapsed = true;
    resolveIdle();
  };

  const offs = [handler.on("SIGTERM", onSignal), handler.on("SIGINT", onSignal)];

  return {
    dispose: () => {
      for (const off of offs) off();
      clearT(graceTimer);
    },
    requested: () => requested,
    done: () => done,
  };
}
