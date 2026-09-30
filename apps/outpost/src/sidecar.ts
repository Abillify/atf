// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sidecar-Modus des Outpost (design.md, Desktop_App; requirements 13.2,
 * 13.5, 15.3, 15.4).
 *
 * Der Rust-Host startet `atf-outpost sidecar` und uebergibt das
 * IPC-Token in der ERSTEN stdin-Zeile (nicht argv/Env — dort waere es
 * fuer andere Prozesse sichtbar). Jede weitere stdin-Zeile ist eine
 * Bridge-Anfrage (zeilenbasiertes JSON, siehe keychain-bridge.ts);
 * Antworten und die `ready`-Zeile gehen auf stdout. Der Logger schreibt
 * auf stderr — stdout fuehrt ausschliesslich Protokoll.
 *
 * Ablauf: Token lesen → Bridge bauen → Runtime (Credential-Store =
 * Bridge, User-Agent `desktop`) → Control-API auf `127.0.0.1:0` →
 * erste stdout-Zeile `{"event":"ready","port":N}` → Scheduler starten.
 * Beenden: `POST /shutdown` (Grace 30 s) oder SIGTERM/SIGINT; schliesst
 * der Host die stdin (unerwartet), faehrt der Sidecar geordnet herunter,
 * damit kein verwaister Prozess bleibt.
 */

import { createInterface } from "node:readline";
import { createStdioBridge, KeychainBridgeStore } from "./keychain-bridge.js";
import { createControlApi } from "./control-api.js";
import { createRuntime, type RuntimeOptions } from "./runtime.js";
import { installShutdown } from "./signals.js";
import { Scheduler, type SchedulerOptions } from "@atf/outpost-core";

/** Zeilenquelle stdin, injizierbar fuer Tests. */
export interface SidecarInput {
  /** Eine Protokollzeile (ohne newline); Rueckgabe = Abbestellen. */
  onLine(handler: (line: string) => void): () => void;
  /** stdin wurde geschlossen (Host weg); Rueckgabe = Abbestellen. */
  onClose(handler: () => void): () => void;
}

export interface StartSidecarOptions {
  /** Schreibt eine Zeile auf stdout (ready-Zeile); Newline wird ergaenzt. */
  out: (line: string) => void;
  /** Rohe stdout-Ausgabe fuer Bridge-Zeilen (Newline bereits enthalten). */
  write?: (chunk: string) => void;
  /** stdin-Quelle; Default `process.stdin` via readline. */
  input?: SidecarInput;
  /** Optionen der Runtime; `credentialStore`, `logDestination` und
   *  `onReauthRequired` werden vom Sidecar gesetzt. */
  runtimeOptions?: RuntimeOptions;
  /** Beenden; Default `process.exit`. */
  exit?: (code: number) => void;
}

/** Default-Eingabe: readline auf `process.stdin`. */
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

/** Wartet auf die erste Zeile der Eingabe (das IPC-Token). */
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
 * Startet den Sidecar. Liefert den Exit-Code, nachdem `POST /shutdown`,
 * ein Signal oder das Schliessen der stdin zum geordneten Beenden
 * gefuehrt haben.
 */
export async function startSidecar(options: StartSidecarOptions): Promise<number> {
  const input = options.input ?? processSidecarInput();
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  const realExit = options.exit ?? ((code: number) => process.exit(code));

  // 1. IPC-Token: erste stdin-Zeile vom Host (15.3).
  const ipcToken = await readFirstLine(input);
  if (ipcToken === "") {
    throw new Error("IPC-Token auf stdin ist leer");
  }

  // 2. Keychain-Bridge: Anfragen → stdout, Antworten ← stdin (13.5).
  const bridge = new KeychainBridgeStore(createStdioBridge(write, input.onLine));

  // 3. Runtime: Secrets leben im Host-Keychain, Logger auf stderr,
  // stdout bleibt fuer ready-Zeile und Bridge reserviert (15.4).
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

  // 4. Control-API auf 127.0.0.1:0; der Port geht in der ready-Zeile (13.2).
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
    // PUT /config persistiert in die Einstellungsdatei des Hosts (13.9).
    ...(rt.configFile !== undefined ? { configPath: rt.configFile } : {}),
    exit: finish,
  });

  const port = await api.listen();
  options.out(JSON.stringify({ event: "ready", port }));

  // Signale (host-seitiges SIGTERM) beenden ebenfalls geordnet.
  const shutdown = installShutdown(scheduler, { logger: rt.logger, exit: finish });

  // Schliesst der Host die stdin, ist er weg: Runs abbrechen, Exit 0.
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
