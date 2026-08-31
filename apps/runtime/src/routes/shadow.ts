// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shadow Mode routes (`src/routes/shadow.ts`)
 *
 * Operator-plane endpoints for the Shadow Mode continuous quality monitoring
 * feature. All endpoints are gated behind `monitoring:read` permission.
 *
 *   GET /monitoring/shadow              — aggregate stats for all flow pairs
 *   GET /monitoring/shadow/:flowId      — stats for one production flow
 *   GET /monitoring/shadow/comparisons  — recent individual comparisons
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { ShadowModeService } from "../graph/shadow-mode.js";
import type { OperatorAuthorizer } from "../middleware/operator-rbac.js";
import { createOperatorAuthorizer } from "../middleware/operator-rbac.js";

export interface ShadowRouterOptions {
  shadowService: ShadowModeService;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

export function createShadowRouter(opts: ShadowRouterOptions): Hono {
  const router = new Hono();
  const { shadowService } = opts;
  const authRequired = opts.authRequired ?? false;
  const operatorAuth =
    opts.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  const authed = async (ctx: {
    req: {
      header: (k: string) => string | undefined;
      query: (k: string) => string | undefined;
    };
  }): Promise<boolean> =>
    (
      await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "monitoring:read",
      )
    ).ok;

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: { message: "Unauthorized monitoring access.", type: "authentication_error" },
      },
      401,
    );

  // GET /monitoring/shadow — all flow pair stats + active config
  router.get("/monitoring/shadow", async (ctx) => {
    if (!(await authed(ctx))) return unauthorized(ctx);
    const stats = shadowService.allStats();
    const configs = shadowService.configs();
    return ctx.json({
      enabled: shadowService.runner !== undefined,
      configured: configs.length,
      stats,
      configs: configs.map((c) => ({
        productionFlow: c.productionFlow,
        shadowFlow: c.shadowFlow,
        samplingRate: c.samplingRate ?? 1.0,
        regressionDelta: c.regressionDelta ?? 0.1,
        maxConcurrent: c.maxConcurrent ?? 2,
        disabled: c.disabled ?? false,
      })),
    });
  });

  // GET /monitoring/shadow/comparisons — recent cross-flow comparison records
  router.get("/monitoring/shadow/comparisons", async (ctx) => {
    if (!(await authed(ctx))) return unauthorized(ctx);
    const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "50", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 50;
    const comparisons = shadowService.recentComparisons(limit);
    return ctx.json({ comparisons, total: comparisons.length });
  });

  // GET /monitoring/shadow/:flowId — stats for one production flow
  router.get("/monitoring/shadow/:flowId", async (ctx) => {
    if (!(await authed(ctx))) return unauthorized(ctx);
    const flowId = ctx.req.param("flowId");
    const stats = shadowService.statsFor(flowId);
    if (stats === undefined) {
      return ctx.json(
        { error: { message: `No shadow data for flow '${flowId}'.`, type: "not_found_error" } },
        404,
      );
    }
    return ctx.json(stats);
  });

  return router;
}
