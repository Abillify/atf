// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graceful shutdown (requirements 7.10, 10.7).
 *
 * SIGTERM/SIGINT: no new runs, running transfers may finish (grace,
 * default 30 s), then abort, state flush, exit 0. A second signal cuts
 * the grace to zero immediately. The flow is written against injectable
 * signal handlers and an injectable exit so tests can play it through
 * with fake timers.
 */

import type { Scheduler } from "@atf/outpost-core";

export const DEFAULT_GRACE_MS = 30_000;

export type ShutdownSignal = "SIGTERM" | "SIGINT";

export interface ShutdownHandler {
  /** Registers a handler; returns a function to remove it. */
  on(signal: ShutdownSignal, handler: () => void): () => void;
}

/** Handlers on the real `process`. */
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
  /** true after a signal has arrived. */
  requested(): boolean;
  /** Waits for the shutdown flow (for tests and the daemon main loop). */
  done(): Promise<void>;
}

/**
 * Install SIGTERM/SIGINT handling. On a signal:
 * 1. `scheduler.beginShutdown()`: no new runs, intervals off;
 * 2. wait up to `graceMs` for running runs;
 * 3. `scheduler.stopAll("shutdown")`: abort after the grace + flush;
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
    // Second signal: end the grace immediately (10.7, "SIGTERM again → immediately").
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
