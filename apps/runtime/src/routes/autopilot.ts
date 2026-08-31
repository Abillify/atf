// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Autopilot routes (`src/routes/autopilot.ts`)
 *
 * REST API for the Continuous Safety & Quality Autopilot engine.
 * Mounted at `/autopilot/*`, gated by operator RBAC (requires "operator" or
 * "admin" role, mirrors the red-team and optimizer routes).
 *
 * Endpoints:
 *   GET  /autopilot/runs           — list recent runs (all flows)
 *   GET  /autopilot/runs/:id       — single run detail
 *   GET  /autopilot/runs/flow/:id  — runs for a specific flow
 *   POST /autopilot/trigger        — manually trigger a cycle for a flow
 *   GET  /autopilot/config         — current autopilot configuration
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { AutopilotEngine } from "../autopilot/autopilot-engine.js";
import type { OperatorAuthorizer } from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";

export interface AutopilotRouterDeps {
  autopilot: AutopilotEngine;
  operatorAuth: OperatorAuthorizer;
  auditLog?: AuditLog;
}

export function createAutopilotRouter(deps: AutopilotRouterDeps): Hono {
  const router = new Hono();
  const { autopilot, operatorAuth, auditLog } = deps;

  const guard = async (ctx: {
    req: {
      header: (k: string) => string | undefined;
      query: (k: string) => string | undefined;
    };
  }) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "flows:read",
    );
    return r.ok
      ? (r.actor ?? { name: "operator", role: "admin" as const, via: "open" as const })
      : null;
  };

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      { error: { message: "Unauthorized operator access.", type: "authentication_error" } },
      401,
    );

  // GET /autopilot/runs — list recent runs
  router.get("/runs", async (ctx) => {
    if (!(await guard(ctx))) return unauthorized(ctx);
    const limit = Math.min(
      200,
      Math.max(1, Number(ctx.req.query("limit") ?? "50")),
    );
    return ctx.json({ runs: autopilot.listAllRuns(limit) });
  });

  // GET /autopilot/runs/flow/:flowId — runs for a flow
  router.get("/runs/flow/:flowId", async (ctx) => {
    if (!(await guard(ctx))) return unauthorized(ctx);
    const flowId = ctx.req.param("flowId");
    return ctx.json({ flowId, runs: autopilot.listRuns(flowId) });
  });

  // GET /autopilot/runs/:id — single run
  router.get("/runs/:id", async (ctx) => {
    if (!(await guard(ctx))) return unauthorized(ctx);
    const run = autopilot.getRun(ctx.req.param("id"));
    if (run === undefined) {
      return ctx.json(
        { error: { message: "Autopilot run not found.", type: "not_found_error" } },
        404,
      );
    }
    return ctx.json(run);
  });

  // POST /autopilot/trigger — manual cycle trigger
  router.post("/trigger", async (ctx) => {
    const actor = await guard(ctx);
    if (!actor) return unauthorized(ctx);

    let body: { flowId?: unknown };
    try {
      body = await ctx.req.json<{ flowId?: unknown }>();
    } catch {
      return ctx.json(
        { error: { message: "Request body must be valid JSON.", type: "invalid_request_error" } },
        400,
      );
    }

    if (typeof body.flowId !== "string" || body.flowId.trim().length === 0) {
      return ctx.json(
        { error: { message: "Field 'flowId' (non-empty string) is required.", type: "invalid_request_error" } },
        400,
      );
    }

    auditLog?.record({
      actor: actor.name,
      role: actor.role,
      action: "autopilot.trigger.manual",
      target: body.flowId,
    });

    const run = await autopilot.triggerManual(body.flowId);
    return ctx.json({ run }, 202);
  });

  // GET /autopilot/config — current configuration
  router.get("/config", async (ctx) => {
    if (!(await guard(ctx))) return unauthorized(ctx);
    return ctx.json({ config: autopilot.config });
  });

  return router;
}
