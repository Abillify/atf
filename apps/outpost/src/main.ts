// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * CLI entry point of the Outpost (design.md, Docker_Runtime).
 *
 * Subcommands: `daemon` (Default), `once`, `login`, `source-login <id>`,
 * `confirm-deletes <id>`, `healthcheck`, `sidecar`. Exit codes: 0 success,
 * 1 item/source error or needs-authorization, 2 Extract auth/connection,
 * 64 usage error, 78 configuration.
 */

import { writeFile } from "node:fs/promises";
import { platform } from "node:os";
import {
  aggregateExitCode,
  credentialFileHash,
  defaultBackendForPlatform,
  EXIT_CONFIG,
  EXIT_EXTRACT_AUTH_OR_CONNECTION,
  EXIT_OK,
  EXIT_USAGE,
  EXTRACT_REFRESH_TOKEN_KEY,
  performLogout,
  runDeviceCodeFlow,
  runOnce,
  Scheduler,
  sourceOauthRefreshKey,
  startWatcher,
  verifyConnection,
  type RunReport,
  type SchedulerOptions,
  type SourceConfig,
  type WatchHandle,
} from "@atf/outpost-core";
import {
  createRuntime,
  ConfigLoadError,
  type Runtime,
  type RuntimeOptions,
} from "./runtime.js";
import { confirmFilePath } from "./confirm.js";
import { installShutdown } from "./signals.js";
import {
  createHealthServer,
  probeExtract,
  runHealthcheck,
  type ExtractProbeResult,
  type HealthState,
} from "./health.js";
import { processIo, runSourceLogin } from "./source-login.js";

const USAGE = `atf-outpost — ATF Extract Outpost

Verwendung: atf-outpost <befehl> [argumente]

Befehle:
  daemon                     Intervall-Sync + Watcher (Default)
  once                       ein Durchlauf ueber alle Quellen
  login                      Extract-Anmeldung (Device-Code-Flow)
  source-login <sourceId>   Cloud-Quelle autorisieren
  confirm-deletes <sourceId>  ausgesetzte Loeschung bestaetigen
  healthcheck               Health-Endpunkt prufen (Docker HEALTHCHECK)
  sidecar                   Desktop-Modus mit Control-API`;

export interface MainOptions {
  argv?: string[];
  runtime?: RuntimeOptions;
  exit?: (code: number) => void;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export async function main(options: MainOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const out = options.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = options.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const command = argv[0] ?? "daemon";

  try {
    switch (command) {
      case "daemon":
        return await cmdDaemon(options, out, err);
      case "once":
        return await cmdOnce(options, out, err);
      case "login":
        return await cmdLogin(options, out, err);
      case "source-login":
        return await cmdSourceLogin(argv[1], options, out, err);
      case "confirm-deletes":
        return await cmdConfirmDeletes(argv[1], options, out, err);
      case "healthcheck":
        return await cmdHealthcheck(options, err);
      case "sidecar":
        return await cmdSidecar(options, out, err);
      case "--help":
      case "-h":
      case "help":
        out(USAGE);
        return EXIT_OK;
      default:
        err(`Unbekannter Befehl "${command}".\n\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof ConfigLoadError) {
      err(error.message);
      return EXIT_CONFIG;
    }
    err(`Fehler: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function buildRuntime(options: MainOptions): Promise<Runtime> {
  return createRuntime(options.runtime ?? {});
}

// ── daemon ──────────────────────────────────────────────────────────────────

async function cmdDaemon(
  options: MainOptions,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  void out;
  // The scheduler only exists after the runtime; the callback is bound below.
  let notifyReauth = (): void => undefined;
  const runtimeOptions = options.runtime ?? {};
  const rt = await createRuntime({
    ...runtimeOptions,
    onReauthRequired: () => {
      runtimeOptions.onReauthRequired?.();
      notifyReauth();
    },
  });
  const { logger } = rt;

  let reauthRequired = false;
  const schedulerOptions: SchedulerOptions = {
    cfg: rt.cfg,
    logger,
    runSource: rt.runSource,
    flushSource: rt.flushSource,
  };
  const scheduler = new Scheduler(schedulerOptions);

  // 4.4: repeated 401s pause all sources until the next login.
  notifyReauth = (): void => {
    reauthRequired = true;
    scheduler.onReauthRequired();
  };

  // Install the shutdown handler BEFORE the connection check: as PID 1 (Docker)
  // the process otherwise ignores SIGTERM without a handler completely, and a
  // daemon without a reachable Extract could no longer be stopped cleanly (12.2).
  const shutdown = installShutdown(scheduler, { logger });

  // 5.1/5.2: connection check before the first run; errors → retry with
  // backoff (the daemon does not exit, it waits for a working
  // configuration).
  const abort = new AbortController();
  let backoffMs = 5_000;
  for (;;) {
    const result = await verifyConnection(rt.client, { mirrorDelete: rt.cfg.mirrorDelete }, abort.signal);
    if (result.ok) break;
    for (const f of result.findings) {
      logger[f.severity === "error" ? "error" : "warn"]({ event: "connection.finding", code: f.code, message: f.message });
    }
    if (abort.signal.aborted) break;
    logger.warn({ event: "connection.retry", backoffMs }, "Verbindungspruefung fehlgeschlagen, erneuter Versuch");
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }

  // Health state: who/when last checked Extract (11.3).
  let probe: ExtractProbeResult = { reachable: true, status: 200, checkedAt: new Date().toISOString() };
  const health = createHealthServer({
    bind: rt.cfg.health.bind,
    port: rt.cfg.health.port,
    logger,
    getState: (): HealthState => ({
      auth: reauthRequired ? "reauth_required" : "ok",
      sources: scheduler.status(),
      extract: probe,
    }),
  });
  await health.listen();

  const probeTimer = setInterval(() => {
    void probeExtract(rt.client).then((p) => {
      probe = p;
    });
  }, 30_000);
  probeTimer.unref?.();

  // Watchers for local sources with watch: true (10.2).
  const watchers: WatchHandle[] = [];
  for (const src of rt.cfg.sources) {
    if (src.type === "local" && src.watch === true) {
      watchers.push(
        await startWatcher({
          dir: src.path,
          trigger: () => scheduler.trigger(src.id),
          backend: defaultBackendForPlatform(platform()),
        }),
      );
    }
  }

  // 6.17: credential changes (token file) start the source immediately;
  // a new Extract refresh token lifts the reauth pause.
  const keyToSource = new Map<string, string>();
  for (const src of rt.cfg.sources) {
    keyToSource.set(credentialFileHash(sourceOauthRefreshKey(src.id)), src.id);
  }
  const refreshHash = credentialFileHash(EXTRACT_REFRESH_TOKEN_KEY);
  const unwatch = watchCredentials(rt, (keyHash) => {
    if (keyHash === refreshHash) {
      reauthRequired = false;
      scheduler.resume();
      return;
    }
    const sourceId = keyToSource.get(keyHash);
    if (sourceId !== undefined) scheduler.credentialChanged(sourceId);
  });

  scheduler.start();
  logger.info({ event: "daemon.started", sources: rt.cfg.sources.length }, "Outpost-Daemon gestartet");

  await shutdown.done();
  clearInterval(probeTimer);
  for (const w of watchers) w.close();
  unwatch();
  await health.close();
  await rt.close();
  void err;
  return EXIT_OK;
}

// ── once ────────────────────────────────────────────────────────────────────

async function cmdOnce(
  options: MainOptions,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const rt = await buildRuntime(options);
  try {
    const connection = await verifyConnection(rt.client, { mirrorDelete: rt.cfg.mirrorDelete });
    if (!connection.ok) {
      for (const f of connection.findings) {
        err(`${f.severity === "error" ? "FEHLER" : "WARNUNG"} [${f.code}]: ${f.message}`);
      }
      return EXIT_EXTRACT_AUTH_OR_CONNECTION;
    }
    const reports: RunReport[] = [];
    const results = await runOnce(rt.cfg.sources, async (src, signal) => {
      const report = await rt.runSource(src, signal);
      reports.push(report);
      return report;
    });
    for (const [index, report] of reports.entries()) {
      const src = rt.cfg.sources[index] as SourceConfig;
      out(
        `${src.id}: ${report.outcome} (new=${report.counters.new} updated=${report.counters.updated} ` +
          `skipped=${report.counters.skipped} deleted=${report.counters.deleted} failed=${report.counters.failed})`,
      );
      if (report.awaitingConfirmation !== undefined) {
        out(
          `  ${report.awaitingConfirmation.count}/${report.awaitingConfirmation.total} Loeschungen warten auf ` +
            `Bestaetigung: atf-outpost confirm-deletes ${src.id}`,
        );
      }
    }
    return aggregateExitCode(results);
  } finally {
    await rt.close();
  }
}

// ── login ───────────────────────────────────────────────────────────────────

async function cmdLogin(
  options: MainOptions,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const rt = await buildRuntime(options);
  try {
    const oidc = rt.cfg.oidc;
    if (oidc === undefined) {
      err("oidc.issuer/oidc.clientId sind nicht konfiguriert — login ist nicht moeglich.");
      return EXIT_CONFIG;
    }
    const result = await runDeviceCodeFlow(
      oidc.issuer,
      oidc.clientId,
      oidc.scopes,
      oidc.audience,
      {
        fetchImpl: globalThis.fetch as unknown as Parameters<typeof runDeviceCodeFlow>[4]["fetchImpl"],
        store: rt.credentialStore,
        logger: rt.logger,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
      },
    );
    out(`Angemeldet (Token gueltig ${result.expiresInSec}s). Der Refresh-Token ist gespeichert.`);
    return EXIT_OK;
  } catch (error) {
    err(`Anmeldung fehlgeschlagen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`);
    return 1;
  } finally {
    await rt.close();
  }
}

// ── source-login ────────────────────────────────────────────────────────────

async function cmdSourceLogin(
  sourceId: string | undefined,
  options: MainOptions,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const rt = await buildRuntime(options);
  try {
    return await runSourceLogin(sourceId, {
      io: { ...processIo(), out, err },
      store: rt.credentialStore,
      cfg: rt.cfg,
      env: rt.env,
      fetchImpl: globalThis.fetch as unknown as Parameters<typeof runSourceLogin>[1]["fetchImpl"],
      redactor: rt.redactor,
    });
  } finally {
    await rt.close();
  }
}

// ── confirm-deletes ─────────────────────────────────────────────────────────

async function cmdConfirmDeletes(
  sourceId: string | undefined,
  options: MainOptions,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  if (sourceId === undefined || sourceId === "") {
    err("Verwendung: atf-outpost confirm-deletes <sourceId>");
    return EXIT_USAGE;
  }
  const rt = await buildRuntime(options);
  try {
    const src = rt.cfg.sources.find((s) => s.id === sourceId);
    if (src === undefined) {
      err(`Unbekannte Source "${sourceId}".`);
      return EXIT_USAGE;
    }
    const store = await rt.storeFor(src);
    const hash = store.state.candidateSetHash;
    if (hash === undefined) {
      err(`Source "${sourceId}" hat keine ausstehende Loeschung.`);
      return 1;
    }
    await writeFile(confirmFilePath(rt.stateDir, sourceId), `${hash}\n`, { mode: 0o600 });
    out(`Loeschung bestaetigt (${hash}). Der naechste Lauf fuehrt sie aus.`);
    return EXIT_OK;
  } finally {
    await rt.close();
  }
}

// ── healthcheck ─────────────────────────────────────────────────────────────

async function cmdHealthcheck(options: MainOptions, err: (l: string) => void): Promise<number> {
  // Determine the port without the full runtime: OUTPOST_HEALTH_PORT, otherwise
  // the config, otherwise the default. A configuration error means "not healthy" here.
  const envPort = process.env.OUTPOST_HEALTH_PORT;
  if (envPort !== undefined && /^\d+$/.test(envPort)) {
    return runHealthcheck(Number.parseInt(envPort, 10));
  }
  try {
    const rt = await buildRuntime(options);
    try {
      return await runHealthcheck(rt.cfg.health.port);
    } finally {
      await rt.close();
    }
  } catch (error) {
    err(`healthcheck: Konfiguration nicht lesbar (${error instanceof Error ? error.message : "?"})`);
    return 1;
  }
}

// ── sidecar ─────────────────────────────────────────────────────────────────

async function cmdSidecar(
  options: MainOptions,
  out: (l: string) => void,
  err: (l: string) => void,
): Promise<number> {
  const { startSidecar } = await import("./sidecar.js");
  void err;
  return startSidecar({ out, runtimeOptions: options.runtime });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FileCredentialStore.watchChanges, encapsulated (Docker runtime only). */
function watchCredentials(
  rt: Runtime,
  onChange: (keyHash: string) => void,
): () => void {
  const store = rt.credentialStore as Partial<{
    watchChanges: (cb: (keyHash: string) => void) => void;
    unwatchChanges: () => void;
  }>;
  if (typeof store.watchChanges !== "function") return () => undefined;
  store.watchChanges(onChange);
  return () => store.unwatchChanges?.();
}

/** Logout sequence for Control API/CLI (3.5): stopAll → flush → token gone. */
export async function logout(rt: Runtime, scheduler: Scheduler): Promise<void> {
  await performLogout(scheduler, rt.authManager);
}

// CLI bootstrap: when run directly (bun/node main.ts, dist-node in the
// Docker image, SEA binary) main() starts; tests import the function and
// call it with injected arguments.
if (import.meta.main) {
  process.exitCode = await main();
}
