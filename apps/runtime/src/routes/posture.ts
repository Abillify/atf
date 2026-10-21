// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Governance posture route (`src/routes/posture.ts`)
 *
 * GET /monitoring/posture — which governance controls are ACTIVE right now
 * (see compliance/posture.ts). Operator-plane, gated by `monitoring:read`,
 * same monitoring authentication as the other `/monitoring/*` routes.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppConfig } from "../config/schema.js";
import {
  buildPostureReport,
  formatPostureReportAsTable,
} from "../compliance/posture.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface PostureRouterDeps {
  config: AppConfig;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
  /** Whether a valid compliance-policy.yaml is loaded (runtime fact). */
  policyLoaded?: () => boolean;
  /** Number of flow files that failed to load at startup (runtime fact). */
  flowLoadFailures?: () => number;
}

export function createPostureRouter(deps: PostureRouterDeps): Hono {
  const app = new Hono();
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  app.get("/monitoring/posture", async (ctx: Context) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) {
      return ctx.json({ error: { message: "Unauthorized posture access." } }, 401);
    }
    const report = buildPostureReport(deps.config, {
      compliancePolicyLoaded: deps.policyLoaded?.() ?? false,
      flowLoadFailures: deps.flowLoadFailures?.() ?? 0,
    });
    if (ctx.req.query("format") === "table") {
      return ctx.text(formatPostureReportAsTable(report));
    }
    return ctx.json(report);
  });

  return app;
}
