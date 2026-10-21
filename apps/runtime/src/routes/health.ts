// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Health Routes (`src/routes/health.ts`)
 *
 * Three endpoints with distinct semantics for K8s probes and load-balancers:
 *
 *   GET /health        — legacy all-in-one (backward compatible, always 200)
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
  /**
   * Audit-trail write health (Req 1.9, platform-hardening): `degraded` when
   * durable audit writes have failed since process start. Informational only —
   * it never flips readiness to 503, since the audit backend being briefly
   * unhealthy is surfaced per-request (503 AUDIT_UNAVAILABLE on Regulierte
   * Aktionen) and via `aiperator_audit_write_failures_total`, not by pulling
   * the whole replica out of rotation. Present only when an audit log is wired.
   */
  audit?: DependencyCheck;
  /**
   * Flow files that fail to load: `degraded` while any does.
   * Informational only (never 503). Present only when a ledger is wired.
   */
  flow_load?: DependencyCheck;
  /**
   * Tool-Authorization-Policy health (Req 7.7, platform-hardening):
   * `degraded` (`policy_stale: true`) when the last `tool-authz.json` reload
   * failed — the engine in effect is the last-known-good (or deny-all) policy,
   * not the file on disk. Informational only — like `audit` it never flips
   * readiness to 503, since a stale policy still enforces a known-good rule
   * set and pulling the replica out of rotation would not fix the file.
   * Present only when a tool-authz loader is wired.
   */
  policy_stale?: DependencyCheck & { policy_stale?: boolean };
  /**
   * `COMPLIANCE_POLICY_REQUIRED` is set: `degraded` with
   * `compliance_policy: "missing"` while no valid `compliance-policy.yaml` is
   * loaded (also after a failed hot-reload), `ok` / `"loaded"` otherwise.
   * Informational only (never 503): the data-class rules are not enforced
   * while it is missing, and that must not be invisible. Present only when
   * the policy is required.
   */
  compliance_policy?: DependencyCheck & { compliance_policy?: "missing" | "loaded" };
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  checks: HealthDetail;
  /** Present (as `"disabled"`) only while `AUTHN_MODE=disabled` is in effect. */
  auth?: "disabled";
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
  /**
   * Audit log write-health source (Req 1.9). When provided, `/health/ready`
   * reports an `audit` check: `degraded` with the failure count once durable
   * audit writes have failed, `ok` otherwise. Duck-typed on purpose — the
   * health module must not depend on the audit backend.
   */
  audit?: { writeFailures?(): number };
  /**
   * Tool-authorization policy loader (Req 7.7). When provided, `/health/ready`
   * reports a `policy_stale` check: `degraded` while the last
   * `tool-authz.json` reload failed, `ok` after the next successful one.
   * Duck-typed on purpose — the health module must not depend on the loader.
   */
  toolAuthz?: { readonly policyStale?: boolean };
  /**
   * Flow files that currently fail to load. When provided,
   * `/health/ready` reports a `flow_load` check: `degraded` with the file
   * names while any flow file fails to load, `ok` otherwise. Informational
   * (never 503): one broken file must not pull every replica out of rotation,
   * but it must no longer be invisible. Duck-typed, like the others.
   */
  flowLoad?: () => ReadonlyArray<{ file: string; reason: string; since: string }>;
  /**
   * `COMPLIANCE_POLICY_REQUIRED` state. When `required`, `/health/ready`
   * reports a `compliance_policy` check that is `degraded` while `loaded()`
   * is false (evaluated per request, so a failed hot-reload shows up).
   */
  compliancePolicy?: { required: boolean; loaded: () => boolean };
  /**
   * `AUTHN_MODE=disabled` is in effect: every endpoint answers without a
   * credential. `/health` and `/health/ready` then carry `auth: "disabled"` so
   * a probe, a dashboard or a person looking at the response cannot mistake an
   * open instance for a protected one. Absent (the normal case) adds nothing.
   */
  authDisabled?: boolean;
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
  // GET /health — legacy endpoint, always 200 (backward compatible)
  // -------------------------------------------------------------------------
  router.get("/health", (ctx) => {
    const body: Record<string, unknown> = { status: "ok" };
    if (options?.authDisabled === true) body.auth = "disabled";
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
          ? {
              status: "unavailable" as const,
              reason: "Redis is configured but no probe client is available.",
            }
          : result,
      ),
    ]);
    const flowsCheck = checkFlows(flowRegistry);

    // Req 1.9: audit write health as an informational (never 503) hint.
    const auditFailures = options?.audit?.writeFailures?.() ?? 0;
    const auditCheck: DependencyCheck | undefined =
      options?.audit === undefined
        ? undefined
        : auditFailures > 0
          ? {
              status: "degraded",
              reason: `${auditFailures} durable audit write(s) failed since process start (see aiperator_audit_write_failures_total).`,
            }
          : { status: "ok" };

    // Req 7.7: stale tool-authz policy as an informational (never 503) flag.
    const policyStaleCheck:
      | (DependencyCheck & { policy_stale?: boolean })
      | undefined =
      options?.toolAuthz === undefined
        ? undefined
        : options.toolAuthz.policyStale === true
          ? {
              status: "degraded",
              reason:
                "The last tool-authz.json reload failed — the last-known-good policy is still enforced (see aiperator_policy_stale_total).",
              policy_stale: true,
            }
          : { status: "ok", policy_stale: false };

    const flowLoadFailures = options?.flowLoad?.() ?? [];
    const flowLoadCheck: DependencyCheck | undefined =
      options?.flowLoad === undefined
        ? undefined
        : flowLoadFailures.length > 0
          ? {
              status: "degraded",
              reason: `${flowLoadFailures.length} flow file(s) fail to load: ${flowLoadFailures
                .slice(0, 10)
                .map((f) => f.file)
                .join(", ")}${flowLoadFailures.length > 10 ? ", …" : ""} (see aiperator_flow_load_failures).`,
            }
          : { status: "ok" };
    const complianceCheck: HealthDetail["compliance_policy"] | undefined =
      options?.compliancePolicy?.required !== true
        ? undefined
        : options.compliancePolicy.loaded()
          ? { status: "ok", compliance_policy: "loaded" }
          : {
              status: "degraded",
              reason:
                "COMPLIANCE_POLICY_REQUIRED is set but no valid compliance-policy.yaml is loaded — data-class residency and provider rules are not enforced.",
              compliance_policy: "missing",
            };
    const checks: HealthDetail = {
      database: dbCheck,
      redis: redisCheck,
      flows: flowsCheck,
      ...(flowLoadCheck !== undefined ? { flow_load: flowLoadCheck } : {}),
      ...(auditCheck !== undefined ? { audit: auditCheck } : {}),
      ...(policyStaleCheck !== undefined
        ? { policy_stale: policyStaleCheck }
        : {}),
      ...(complianceCheck !== undefined ? { compliance_policy: complianceCheck } : {}),
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
      ...(options?.authDisabled === true ? { auth: "disabled" as const } : {}),
    };

    return ctx.json(body, status);
  });

  return router;
}
