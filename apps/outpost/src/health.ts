// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Health-Endpunkt (requirements 6.18, 11.3, 11.4).
 *
 * `GET /healthz` auf `OUTPOST_HEALTH_BIND` (Default `127.0.0.1:8787`).
 * Antwortform gemäß Design:
 *
 * ```json
 * {"auth":"ok"|"reauth_required",
 *  "extract":{"reachable":true,"status":200,"checkedAt":"…"},
 *  "sources":[{"id":"…","status":"idle","lastRun":{…}}]}
 * ```
 *
 * HTTP `503` gibt es NUR bei `reauth_required` oder nicht erreichbarem
 * Extract — `needs-authorization` einer Quelle bleibt `200`, weil ein
 * Container-Neustart dadurch nichts gewonnen wäre und die übrigen Quellen
 * unterbrechen würde (11.4). Der Endpunkt ist unauthentifiziert und enthaelt
 * weder Secrets noch Dateinamen; eine Bindung ausserhalb des Loopback wird
 * beim Start als Warnung geloggt (11.3).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SourceStatusView } from "@atf/outpost-core";

export const DEFAULT_HEALTH_BIND = "127.0.0.1";
export const DEFAULT_HEALTH_PORT = 8787;

/** Ergebnis des letzten Extract-Probes (whoami). */
export interface ExtractProbeResult {
  reachable: boolean;
  /** HTTP-Status, wenn eine Antwort einging. */
  status?: number;
  checkedAt: string;
}

export interface HealthState {
  /** Extract-Auth-Status des AuthManagers (4.4). */
  auth: "ok" | "reauth_required";
  sources: SourceStatusView[];
  extract: ExtractProbeResult;
}

export interface HealthServerOptions {
  getState: () => HealthState;
  bind?: string;
  port?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

export interface HealthServer {
  /** Startet der Server; liefert die gebundene Adresse. */
  listen(): Promise<{ address: string; port: number }>;
  close(): Promise<void>;
  /** Gebundener Port nach listen() (0 → zugewiesener Port). */
  port(): number;
}

/** true für Loopback-Adressen (Warnung sonst, 11.3). */
export function isLoopbackBind(bind: string): boolean {
  const host = bind.includes("%") ? bind.slice(0, bind.indexOf("%")) : bind;
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.")
  );
}

/** HTTP-Status für die Health-Antwort (11.4). */
export function healthStatusCode(state: HealthState): number {
  return state.auth === "reauth_required" || !state.extract.reachable ? 503 : 200;
}

/** JSON-Body für /healthz — keine Secrets, keine Dateinamen (11.3). */
export function healthBody(state: HealthState): unknown {
  return {
    auth: state.auth,
    extract: {
      reachable: state.extract.reachable,
      ...(state.extract.status !== undefined ? { status: state.extract.status } : {}),
      checkedAt: state.extract.checkedAt,
    },
    sources: state.sources.map((s) => ({
      id: s.sourceId,
      status: s.status,
      pending: s.pending,
      ...(s.lastRun !== undefined
        ? {
            lastRun: {
              finishedAt: s.lastRun.finishedAt,
              result: s.lastRun.result,
              counters: s.lastRun.counters,
            },
          }
        : {}),
    })),
  };
}

/**
 * Health-Server. Der Server antwortet ausschließlich mit dem Zustand, den
 * `getState` liefert — die Probe-Logik (wer/wann) liegt beim Aufrufer, damit
 * der Endpunkt selbst rein testbar ist.
 */
export function createHealthServer(options: HealthServerOptions): HealthServer {
  const bind = options.bind ?? DEFAULT_HEALTH_BIND;
  const port = options.port ?? DEFAULT_HEALTH_PORT;
  const logger = options.logger;
  let server: Server | undefined;

  const handler = (
    req: { method?: string; url?: string },
    res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body?: string) => void },
  ): void => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/healthz") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const state = options.getState();
    const code = healthStatusCode(state);
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(healthBody(state)));
  };

  return {
    async listen() {
      if (!isLoopbackBind(bind)) {
        logger?.warn(
          { event: "health.bind_public", bind },
          "Health-Endpunkt ohne Authentifizierung ausserhalb des Loopback gebunden",
        );
      }
      const s = createServer((req, res) => handler(req, res));
      server = s;
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(port, bind, () => resolve());
      });
      const info = s.address() as AddressInfo;
      logger?.info({ event: "health.listening", bind, port: info.port });
      return { address: info.address, port: info.port };
    },
    async close() {
      if (server === undefined) return;
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err !== undefined && err !== null ? reject(err) : resolve()));
      });
      server = undefined;
    },
    port() {
      const info = server?.address() as AddressInfo | undefined;
      return info?.port ?? port;
    },
  };
}

/**
 * Einmaliger Extract-Probe über `GET /v1/whoami` (5.1). Fehler werden zu
 * `reachable:false` — der Health-Endpunkt darf nie selbst scheitern, weil ein
 * Probe wirft (11.3).
 */
export async function probeExtract(
  client: { request: (r: { url: string; signal?: AbortSignal }) => Promise<{ status: number }> },
  signal?: AbortSignal,
): Promise<ExtractProbeResult> {
  const checkedAt = new Date().toISOString();
  try {
    const response = await client.request({ url: "/v1/whoami", ...(signal !== undefined ? { signal } : {}) });
    return { reachable: response.status === 200, status: response.status, checkedAt };
  } catch {
    return { reachable: false, checkedAt };
  }
}

/**
 * Subcommand `healthcheck`: ruft den lokalen Health-Endpunkt auf und liefert
 * den Exit-Code (0 bei 200, sonst 1). Verwendet 127.0.0.1 unabhaengig von der
 * Bind-Adresse, damit der Docker-HEALTHCHECK auch bei anderer Bind funktioniert.
 */
export async function runHealthcheck(
  port: number,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
      signal: controller.signal,
    });
    return response.status === 200 ? 0 : 1;
  } catch {
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
