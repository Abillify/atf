// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * SLO reporting route (`src/routes/slo.ts`)
 *
 * GET /monitoring/slo — per-flow cost/quality SLO attainment (see graph/slo.ts).
 * Operator-plane, gated by `monitoring:read`.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { SloRegistry } from "../graph/slo.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface SloRouterDeps {
  registry: SloRegistry;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

export function createSloRouter(deps: SloRouterDeps): Hono {
  const app = new Hono();
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  app.get("/monitoring/slo", async (ctx: Context) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return ctx.json({ error: "forbidden" }, 403);
    return ctx.json({
      enabled: deps.registry.enabled,
      slos: deps.registry.report(),
    });
  });

  return app;
}
