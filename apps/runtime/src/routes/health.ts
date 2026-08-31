// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Health Routes (`src/routes/health.ts`)
 *
 * Three endpoints with distinct semantics for K8s probes and load-balancers:
 *
 *   GET /health        — legacy all-in-one (rückwärtskompatibel, always 200)
 *   GET /health/live   — liveness probe: is the process alive and able to serve?
 *                        Never checks external dependencies — a transient DB
 *                        hiccup must NOT kill the pod (K8s would restart it,
 *                        removing it from the load-balancer unnecessarily).
 *   GET /health/ready  — readiness probe: are all required dependencies up?
 *                        Returns 503 when DB/Redis are configured but unreachable
 *                        or when no flows are loaded. K8s stops sending traffic
 *                        to the pod but does NOT restart it.
 *
 * Design goals:
 *   - Readiness probe has a configurable timeout so it never blocks a probe
 *     cycle. Default: 2 000 ms (well under K8s default timeoutSeconds: 3).
 *   - Each dependency check is isolated: one failure does not prevent others
 *     from running (full picture is always returned).
 *   - All probes are unauthenticated (load-balancers cannot set headers).
 *   - The legacy /health endpoint always returns 200 so existing integrations
 *     are not broken.
 *
 * Requirements: 10.6
 */

import { Hono } from "hono";
import type { FlowRegistry } from "../graph/flow-parser.js";
import type { Database } from "../db/database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DependencyStatus =
  | "ok"
  | "degraded"
  | "unavailable"
  | "unconfigured";

export interface DependencyCheck {
  status: DependencyStatus;
  /** Human-readable reason — only present when status ≠ "ok". */
  reason?: string;
  /** Round-trip latency in milliseconds (present when a probe was executed). */
  latencyMs?: number;
}

export interface HealthDetail {
  database: DependencyCheck;
  redis: DependencyCheck;
  flows: DependencyCheck;
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  checks: HealthDetail;
}

export interface LivenessResponse {
  status: "ok";
  uptime_seconds: number;
}

// ---------------------------------------------------------------------------
// Dependency probe helpers
// ---------------------------------------------------------------------------

/** Resolves before `ms` milliseconds; the caller races it against the real work. */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms),
  );
}

/**
 * Probes the database with a lightweight `SELECT 1`. Never throws — returns a
 * DependencyCheck regardless of outcome.
 */
async function probeDatabase(
  database: Database | undefined,
  timeoutMs: number,
): Promise<DependencyCheck> {
  if (database === undefined) {
    return { status: "unconfigured" };
  }
  const t0 = Date.now();
  try {
    await Promise.race([database.query("SELECT 1"), timeout(timeoutMs)]);
    return { status: "ok", latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * Probes Redis via a lightweight PING. The `ping` method is a Bun-native
 * RedisClient convenience — we call it via dynamic duck-typing so the health
 * module has no hard dependency on any Redis client package.
 */
async function probeRedis(
  redisClient: RedisProbeClient | undefined,
  timeoutMs: number,
): Promise<DependencyCheck> {
  if (redisClient === undefined) {
    return { status: "unconfigured" };
  }
  const t0 = Date.now();
  try {
    await Promise.race([redisClient.ping(), timeout(timeoutMs)]);
    return { status: "ok", latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * Checks whether at least one flow is loaded in the registry.
 * This is synchronous — no I/O involved.
 */
function checkFlows(flowRegistry: FlowRegistry | undefined): DependencyCheck {
  if (flowRegistry === undefined) {
    return { status: "unconfigured" };
  }
  const count = flowRegistry.list().length;
  if (count === 0) {
    return {
      status: "degraded",
      reason: "No flows loaded. Drop a .json flow file into the FLOWS_DIR.",
    };
  }
  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// Minimal Redis probe interface (duck-typed — no client package dependency)
// ---------------------------------------------------------------------------

export interface RedisProbeClient {
  /** Issues a PING to the server. Resolves when pong is received. */
  ping(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface HealthRouterOptions {
  /** Postgres connection (optional — omit when persistence is disabled). */
  database?: Database;
  /**
   * Redis client for PING-based health checks (optional). Should be a
   * dedicated, low-priority connection — not the same as the pub/sub or
   * rate-limit clients.
   */
  redisClient?: RedisProbeClient;
  /**
   * Per-dependency probe timeout in milliseconds. Defaults to 2 000 ms.
   * Must be lower than the K8s `timeoutSeconds` probe setting (default 3 s).
   */
  probeTimeoutMs?: number;
  /** Redis is configured and therefore required even if probe construction failed. */
  redisRequired?: boolean;
  /** Process start time used to compute uptime. Defaults to process.uptime(). */
  startTime?: number;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

const SERVER_START = Date.now();

export function createHealthRouter(
  flowRegistry?: FlowRegistry,
  options?: HealthRouterOptions,
): Hono {
  const router = new Hono();
  const probeTimeoutMs = options?.probeTimeoutMs ?? 2_000;

  // -------------------------------------------------------------------------
  // GET /health — legacy endpoint, always 200 (rückwärtskompatibel)
  // -------------------------------------------------------------------------
  router.get("/health", (ctx) => {
    const body: Record<string, unknown> = { status: "ok" };
    if (flowRegistry !== undefined) {
      const flows = flowRegistry.list();
      body.flows_loaded = flows.length;
    }
    return ctx.json(body);
  });

  // -------------------------------------------------------------------------
  // GET /health/live — liveness probe
  //
  // Answers: "Is the process running and able to handle connections?"
  // Does NOT check external dependencies — we don't want K8s restarting the
  // pod because Postgres is slow. Just confirm the event loop is alive.
  // -------------------------------------------------------------------------
  router.get("/health/live", (ctx) => {
    const startMs = options?.startTime ?? SERVER_START;
    const uptimeSeconds = Math.floor((Date.now() - startMs) / 1000);
    const body: LivenessResponse = {
      status: "ok",
      uptime_seconds: uptimeSeconds,
    };
    return ctx.json(body, 200);
  });

  // -------------------------------------------------------------------------
  // GET /health/ready — readiness probe
  //
  // Answers: "Is this replica ready to serve production traffic?"
  // Returns 503 when any *configured* dependency is unavailable, so K8s
  // removes the pod from the load-balancer without restarting it.
  //
  // "unconfigured" dependencies (no DATABASE_URL etc.) are not failures —
  // the platform intentionally degrades gracefully.
  // -------------------------------------------------------------------------
  router.get("/health/ready", async (ctx) => {
    const [dbCheck, redisCheck] = await Promise.all([
      probeDatabase(options?.database, probeTimeoutMs),
      probeRedis(options?.redisClient, probeTimeoutMs).then((result) =>
        options?.redisRequired === true && result.status === "unconfigured"
          ? { status: "unavailable" as const, reason: "Redis is configured but no probe client is available." }
          : result,
      ),
    ]);
    const flowsCheck = checkFlows(flowRegistry);

    const checks: HealthDetail = {
      database: dbCheck,
      redis: redisCheck,
      flows: flowsCheck,
    };

    // A replica with no loaded flows cannot serve meaningful execution traffic.
    // Keep /health backward compatible, but remove it from readiness routing.
    const notReady =
      dbCheck.status === "unavailable" ||
      redisCheck.status === "unavailable" ||
      flowsCheck.status === "unavailable" ||
      flowsCheck.status === "degraded";

    const status = notReady ? 503 : 200;
    const body: ReadinessResponse = {
      status: notReady ? "not_ready" : "ready",
      checks,
    };

    return ctx.json(body, status);
  });

  return router;
}
