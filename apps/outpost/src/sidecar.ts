// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sidecar mode of the Outpost (design.md, Desktop_App; requirements 13.2,
 * 13.5, 15.3, 15.4).
 *
 * The Rust host starts `atf-outpost sidecar` and passes the
 * IPC token in the FIRST stdin line (not argv/env, where it would be
 * visible to other processes). Every further stdin line is a
 * bridge request (line-based JSON, see keychain-bridge.ts);
 * responses and the `ready` line go to stdout. The logger writes to
 * stderr; stdout carries protocol only.
 *
 * Flow: read the token → build the bridge → runtime (credential store =
 * bridge, User-Agent `desktop`) → Control API on `127.0.0.1:0` →
 * first stdout line `{"event":"ready","port":N}` → start the scheduler.
 * Shutdown: `POST /shutdown` (grace 30 s) or SIGTERM/SIGINT; if the host
 * closes stdin (unexpectedly), the sidecar shuts down in order so no
 * orphaned process remains.
 */

import { createInterface } from "node:readline";
import { createStdioBridge, KeychainBridgeStore } from "./keychain-bridge.js";
import { createControlApi } from "./control-api.js";
import { createRuntime, type RuntimeOptions } from "./runtime.js";
import { installShutdown } from "./signals.js";
import { Scheduler, type SchedulerOptions } from "@atf/outpost-core";

/** Line source stdin, injectable for tests. */
export interface SidecarInput {
  /** One protocol line (without newline); returns an unsubscribe function. */
  onLine(handler: (line: string) => void): () => void;
  /** stdin was closed (host gone); returns an unsubscribe function. */
  onClose(handler: () => void): () => void;
}

export interface StartSidecarOptions {
  /** Writes a line to stdout (ready line); the newline is appended. */
  out: (line: string) => void;
  /** Raw stdout output for bridge lines (newline already included). */
  write?: (chunk: string) => void;
  /** stdin source; default `process.stdin` via readline. */
  input?: SidecarInput;
  /** Runtime options; `credentialStore`, `logDestination` and
   *  `onReauthRequired` are set by the sidecar. */
  runtimeOptions?: RuntimeOptions;
  /** Beenden; Default `process.exit`. */
  exit?: (code: number) => void;
}

/** Default input: readline on `process.stdin`. */
export function processSidecarInput(): SidecarInput {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return {
    onLine(handler) {
      rl.on("line", handler);
      return () => rl.off("line", handler);
    },
    onClose(handler) {
      rl.on("close", handler);
      return () => rl.off("close", handler);
    },
  };
}

/** Waits for the first input line (the IPC token). */
function readFirstLine(input: SidecarInput): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const offLine = input.onLine((line) => {
      offClose();
      resolve(line.trim());
    });
    const offClose = input.onClose(() => {
      offLine();
      reject(new Error("stdin geschlossen, bevor das IPC-Token gelesen wurde"));
    });
  });
}

/**
 * Starts the sidecar. Returns the exit code after `POST /shutdown`,
 * a signal or closing stdin has led to an orderly shutdown.
 */
export async function startSidecar(options: StartSidecarOptions): Promise<number> {
  const input = options.input ?? processSidecarInput();
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const realExit = options.exit ?? ((code: number) => process.exit(code));

  // 1. IPC token: first stdin line from the host (15.3).
  const ipcToken = await readFirstLine(input);
  if (ipcToken === "") {
    throw new Error("IPC-Token auf stdin ist leer");
  }

  // 2. Keychain-Bridge: Anfragen → stdout, Antworten ← stdin (13.5).
  const bridge = new KeychainBridgeStore(createStdioBridge(write, input.onLine));

  // 3. Runtime: secrets live in the host keychain, logger on stderr,
  // stdout stays reserved for the ready line and the bridge (15.4).
  let notifyReauth = (): void => undefined;
  const rt = await createRuntime({
    runtime: "desktop",
    ...options.runtimeOptions,
    credentialStore: bridge,
    logDestination: process.stderr,
    onReauthRequired: () => notifyReauth(),
  });

  const schedulerOptions: SchedulerOptions = {
    cfg: rt.cfg,
    logger: rt.logger,
    runSource: rt.runSource,
    flushSource: rt.flushSource,
  };
  const scheduler = new Scheduler(schedulerOptions);
  notifyReauth = () => scheduler.onReauthRequired();

  // 4. Control API on 127.0.0.1:0; the port goes into the ready line (13.2).
  let resolveFinished!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    resolveFinished = resolve;
  });
  const finish = (code: number): void => resolveFinished(code);

  const api = createControlApi({
    rt,
    scheduler,
    bridge,
    ipcToken,
    logger: rt.logger,
    // PUT /config persists into the host's settings file (13.9).
    ...(rt.configFile !== undefined ? { configPath: rt.configFile } : {}),
    exit: finish,
  });

  const port = await api.listen();
  options.out(JSON.stringify({ event: "ready", port }));

  // Signale (host-seitiges SIGTERM) beenden ebenfalls geordnet.
  const shutdown = installShutdown(scheduler, { logger: rt.logger, exit: finish });

  // If the host closes stdin, it is gone: abort runs, exit 0.
  input.onClose(() => {
    void scheduler.stopAll("host-gone").then(() => finish(0), () => finish(0));
  });

  scheduler.start();
  rt.logger.info({ event: "sidecar.started", port, sources: rt.cfg.sources.length });

  const code = await finished;
  shutdown.dispose();
  await api.close();
  await rt.close();
  realExit(code);
  return code;
}
