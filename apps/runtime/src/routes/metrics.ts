// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Metrics routes (`src/routes/metrics.ts`)
 *
 *  GET /metrics            — Prometheus text exposition (optional auth).
 *  GET /monitoring/metrics — Compact JSON summary for the dashboard (combines
 *                            runtime metrics with per-tenant cost snapshot).
 *
 * Both endpoints go through the SAME {@link OperatorAuthorizer} as the rest of
 * the operator plane (`monitoring:read` permission) rather than a bespoke
 * "well-formed 3-segment token" format check. The format-only check was a real
 * gap: `?token=aaa.bbb.ccc` — a value with no signature and no verification —
 * satisfied it, so anyone could read Prometheus metrics and, worse, the
 * per-tenant/per-user cost and token-usage breakdown even with
 * `METRICS_AUTH=true` configured. Routing through {@link OperatorAuthorizer}
 * means these endpoints inherit the platform's actual identity checks (static
 * token map, or a JWT verified via JWKS/HS256 before its role claim is
 * trusted) and RBAC (`monitoring:read` — granted to every role, so this is not
 * a behavioural narrowing for legitimate operators, only a closing of the
 * anonymous bypass).
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Metrics } from "../observability/metrics.js";
import type {
  TenantSpendSummary,
  UserSpendSummary,
  FlowSpendSummary,
} from "../observability/cost.js";
import type { UsageAnalytics } from "../observability/token-limits.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

/** Minimal async-friendly view of the budget tracker for the dashboard. */
export interface TenantSpendProvider {
  snapshot(): Promise<TenantSpendSummary[]> | TenantSpendSummary[];
  /** Per-authenticated-user spend in the rolling window. Optional for older providers. */
  snapshotByUser?(): Promise<UserSpendSummary[]> | UserSpendSummary[];
  /** Per-flow spend in the rolling window. Optional for older providers. */
  snapshotByFlow?(): Promise<FlowSpendSummary[]> | FlowSpendSummary[];
}

function unauthorized(ctx: import("hono").Context): Response {
  return ctx.json(
    {
      error: {
        message: "Unauthorized metrics access.",
        type: "authentication_error",
      },
    },
    401,
  );
}

export function createMetricsRouter(
  metrics: Metrics,
  options?: {
    /** Require operator identity (RBAC token/JWT) for GET /metrics. */
    metricsAuthRequired?: boolean;
    /** Require operator identity (RBAC token/JWT) for GET /monitoring/metrics. */
    monitoringAuthRequired?: boolean;
    costTracker?: TenantSpendProvider;
    /**
     * Durable per-model cost/token analytics (Postgres-backed `cost_ledger`).
     * When present, its 24h `byModel` breakdown REPLACES the in-memory
     * `Metrics.summary()` breakdown in the dashboard response — the in-memory
     * one is per-replica and resets on every restart, which made "estimated
     * cost" appear to vanish or stay stuck after a redeploy/replica failover.
     */
    usageAnalytics?: UsageAnalytics;
    /**
     * Shared operator authorizer for GET /monitoring/metrics. Defaults to a
     * back-compat authorizer built from `monitoringAuthRequired` when not
     * provided — callers that already build one for the rest of the operator
     * plane (`src/index.ts`) should pass it here so identity/RBAC config is
     * not duplicated.
     */
    operatorAuth?: OperatorAuthorizer;
    /**
     * Operator authorizer for GET /metrics specifically. `METRICS_AUTH` has
     * historically been an independently configurable flag from
     * `MONITORING_AUTH`, so this defaults to a SEPARATE back-compat authorizer
     * built from `metricsAuthRequired` rather than reusing `operatorAuth` — a
     * caller wanting the two endpoints to share one authorizer instance (and
     * thus one requiredness) should pass the SAME value for both.
     */
    metricsOperatorAuth?: OperatorAuthorizer;
  },
): Hono {
  const router = new Hono();
  const metricsAuth = options?.metricsAuthRequired ?? false;
  const monitoringAuth = options?.monitoringAuthRequired ?? false;
  const costTracker = options?.costTracker;
  const usageAnalytics = options?.usageAnalytics;
  const metricsOperatorAuth =
    options?.metricsOperatorAuth ??
    createOperatorAuthorizer({ authRequired: metricsAuth });
  const monitoringOperatorAuth =
    options?.operatorAuth ??
    createOperatorAuthorizer({ authRequired: monitoringAuth });

  // Prometheus scrape endpoint
  router.get("/metrics", async (ctx) => {
    const r = await metricsOperatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);
    return ctx.text(metrics.render(), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  // JSON summary for the dashboard
  router.get("/monitoring/metrics", async (ctx) => {
    const r = await monitoringOperatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);
    const summary = metrics.summary();
    const tenants =
      costTracker !== undefined ? await costTracker.snapshot() : [];
    const spendByUser =
      costTracker?.snapshotByUser !== undefined
        ? await costTracker.snapshotByUser()
        : [];
    const spendByFlow =
      costTracker?.snapshotByFlow !== undefined
        ? await costTracker.snapshotByFlow()
        : [];

    // Prefer the durable per-model breakdown (Postgres `cost_ledger`, 24h
    // window) over the in-memory-only one from `metrics.summary()` when a
    // database is configured — it survives restarts and aggregates across
    // all replicas, so "estimated cost" no longer appears to reset/vanish.
    let costByModel = summary.costByModel;
    let tokensByModel = summary.tokensByModel;
    let costTotal = summary.costTotal;
    let tokensPrompt = summary.tokensPrompt;
    let tokensCompletion = summary.tokensCompletion;
    if (usageAnalytics !== undefined) {
      const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const durable = await usageAnalytics.byModel(sinceIso);
      if (Object.keys(durable).length > 0) {
        costByModel = {};
        tokensByModel = {};
        costTotal = 0;
        tokensPrompt = 0;
        tokensCompletion = 0;
        for (const [model, breakdown] of Object.entries(durable)) {
          costByModel[model] = breakdown.cost;
          tokensByModel[model] = {
            prompt: breakdown.promptTokens,
            completion: breakdown.completionTokens,
          };
          costTotal += breakdown.cost;
          tokensPrompt += breakdown.promptTokens;
          tokensCompletion += breakdown.completionTokens;
        }
        costTotal = Math.round(costTotal * 1_000_000) / 1_000_000;
      }
    }

    return ctx.json({
      ...summary,
      costByModel,
      tokensByModel,
      costTotal,
      tokensPrompt,
      tokensCompletion,
      tenants,
      spendByUser,
      spendByFlow,
    });
  });

  return router;
}
