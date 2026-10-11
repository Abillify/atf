// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Health endpoint (requirements 6.18, 11.3, 11.4).
 *
 * `GET /healthz` on `OUTPOST_HEALTH_BIND` (default `127.0.0.1:8787`).
 * Response shape per the design:
 *
 * ```json
 * {"auth":"ok"|"reauth_required",
 *  "extract":{"reachable":true,"status":200,"checkedAt":"…"},
 *  "sources":[{"id":"…","status":"idle","lastRun":{…}}]}
 * ```
 *
 * HTTP `503` happens ONLY for `reauth_required` or an unreachable
 * Extract; `needs-authorization` of a source stays `200`, because a
 * container restart would gain nothing and would interrupt the other
 * sources (11.4). The endpoint is unauthenticated and contains neither
 * secrets nor file names; a bind outside the loopback is logged as a
 * warning at startup (11.3).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SourceStatusView } from "@atf/outpost-core";

export const DEFAULT_HEALTH_BIND = "127.0.0.1";
export const DEFAULT_HEALTH_PORT = 8787;

/** Result of the last Extract probe (whoami). */
export interface ExtractProbeResult {
  reachable: boolean;
  /** HTTP status when a response arrived. */
  status?: number;
  checkedAt: string;
}

export interface HealthState {
  /** Extract auth status of the AuthManager (4.4). */
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
  /** Starts the server; returns the bound address. */
  listen(): Promise<{ address: string; port: number }>;
  close(): Promise<void>;
  /** Bound port after listen() (0 → assigned port). */
  port(): number;
}

/** true for loopback addresses (warning otherwise, 11.3). */
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

/** HTTP status for the health response (11.4). */
export function healthStatusCode(state: HealthState): number {
  return state.auth === "reauth_required" || !state.extract.reachable ? 503 : 200;
}

/** JSON body for /healthz: no secrets, no file names (11.3). */
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
 * Health server. The server answers only with the state `getState`
 * returns; the probe logic (who/when) lives with the caller so the
 * endpoint itself is purely testable.
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
 * One-off Extract probe via `GET /v1/whoami` (5.1). Errors become
 * `reachable:false`; the health endpoint must never fail itself because a
 * probe throws (11.3).
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
 * Subcommand `healthcheck`: calls the local health endpoint and returns the
 * exit code (0 for 200, otherwise 1). Uses 127.0.0.1 regardless of the bind
 * address so the Docker HEALTHCHECK also works with a different bind.
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
