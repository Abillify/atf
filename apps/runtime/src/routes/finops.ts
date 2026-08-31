// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FinOps forecasting + CO2/ESG accounting route (`src/routes/finops.ts`)
 *
 * Two read-only operator-plane reports built on `src/observability/finops.ts`:
 *
 *   GET /admin/finops/forecast/:tenantId — per-tenant budget burn-rate
 *     forecast (days until the daily cap is projected to be exhausted at the
 *     current spend trend). Requires a durable (Postgres) cost store for the
 *     day-bucketed history; returns `insufficient_data`/`unbounded` gracefully
 *     otherwise.
 *
 *   GET /admin/finops/co2 — aggregate CO2e estimate across all models seen in
 *     the current in-memory metrics summary's token breakdown, so it needs no
 *     new persistence and reuses the same 24h-ish window the Cost & Tokens
 *     dashboard already shows.
 *
 * Gated by `monitoring:read` (Operator RBAC) — same plane as `/monitoring/*`.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { BudgetService } from "../observability/cost.js";
import type { Metrics } from "../observability/metrics.js";
import { forecastTenantBudget, co2Report } from "../observability/finops.js";
import type { EnergyFactor } from "../observability/finops.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface FinopsRouterDeps {
  budgetService?: BudgetService;
  metrics?: Metrics;
  co2GridCarbonIntensity?: number;
  co2EnergyFactors?: EnergyFactor[];
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

function unauthorized(ctx: Context) {
  return ctx.json(
    {
      error: {
        message: "Unauthorized operator access.",
        type: "authentication_error",
      },
    },
    401,
  );
}

export function createFinopsRouter(deps: FinopsRouterDeps): Hono {
  const router = new Hono();
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  const authed = (ctx: Context) =>
    operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );

  // --- Budget burn-rate forecast --------------------------------------------
  router.get("/admin/finops/forecast/:tenantId", async (ctx) => {
    const r = await authed(ctx);
    if (!r.ok) return unauthorized(ctx);

    const { budgetService } = deps;
    if (budgetService === undefined) {
      return ctx.json(
        {
          error: {
            message: "Budget tracking is not configured for this deployment.",
            type: "not_available",
          },
        },
        503,
      );
    }

    const tenantId = ctx.req.param("tenantId");
    const rawDays = Number.parseInt(ctx.req.query("days") ?? "14", 10);
    const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 3), 90) : 14;

    const forecast = await forecastTenantBudget(budgetService, tenantId, days);
    return ctx.json({ forecast });
  });

  // --- CO2 / ESG report ------------------------------------------------------
  router.get("/admin/finops/co2", async (ctx) => {
    const r = await authed(ctx);
    if (!r.ok) return unauthorized(ctx);

    const { metrics } = deps;
    const summary = metrics?.summary();
    const usageByModel: Record<
      string,
      { promptTokens: number; completionTokens: number }
    > = {};
    for (const [key, t] of Object.entries(summary?.tokensByModel ?? {})) {
      usageByModel[key] = {
        promptTokens: t.prompt,
        completionTokens: t.completion,
      };
    }

    const report = co2Report(usageByModel, {
      ...(deps.co2GridCarbonIntensity !== undefined
        ? { gridCarbonIntensity: deps.co2GridCarbonIntensity }
        : {}),
      ...(deps.co2EnergyFactors !== undefined
        ? { energyFactors: deps.co2EnergyFactors }
        : {}),
    });
    return ctx.json({ report });
  });

  return router;
}
