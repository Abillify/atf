// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Eval case routes (`src/routes/eval.ts`)
 *
 * CRUD over the Studio "Save as Eval Case" dataset (Req. 16), backed by
 * {@link EvalCaseStore}. Creation validates via
 * {@link validateStudioEvalCase} (Req. 16.3) — a case missing required fields
 * (expected output, etc.) is rejected with the list of missing fields.
 *
 *   GET    /eval/cases      — list cases (newest first)
 *   POST   /eval/cases      — add a case (validated)
 *   DELETE /eval/cases/:id  — remove a case
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { EvalCaseStore } from "../eval/eval-case-store.js";
import {
  buildStudioEvalCase,
  validateStudioEvalCase,
  type StudioEvalCase,
} from "../eval/studio-eval-case.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface EvalRouterDeps {
  store: EvalCaseStore;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

export function createEvalRouter(deps: EvalRouterDeps): Hono {
  const { store } = deps;
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  const router = new Hono();

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message: "Unauthorized operator access.",
          type: "authentication_error",
        },
      },
      401,
    );

  router.get("/eval/cases", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);
    const cases = await store.list();
    return ctx.json({ cases });
  });

  router.post("/eval/cases", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:write",
    );
    if (!r.ok) return unauthorized(ctx);

    let body: Partial<StudioEvalCase>;
    try {
      body = await ctx.req.json<Partial<StudioEvalCase>>();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const createdBy = r.actor?.name ?? "operator";
    const candidate: Partial<StudioEvalCase> = {
      ...body,
      createdBy: body.createdBy ?? createdBy,
    };
    const validation = validateStudioEvalCase(candidate);
    if (!validation.valid) {
      return ctx.json(
        {
          error: {
            message: `Missing required fields: ${validation.missingFields.join(", ")}`,
            type: "invalid_request_error",
          },
          missingFields: validation.missingFields,
        },
        400,
      );
    }

    if (
      candidate.flowId === undefined ||
      candidate.prompt === undefined ||
      candidate.createdBy === undefined ||
      candidate.tenantId === undefined
    ) {
      // Unreachable: validateStudioEvalCase above already confirmed these
      // required fields are present.
      return ctx.json(
        {
          error: {
            message: "Missing required fields.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const evalCase = buildStudioEvalCase({
      flowId: candidate.flowId,
      prompt: candidate.prompt,
      expected: candidate.expected,
      actual: candidate.actual,
      createdBy: candidate.createdBy,
      tenantId: candidate.tenantId,
    });
    await store.add(evalCase);
    return ctx.json({ case: evalCase }, 201);
  });

  router.delete("/eval/cases/:id", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:write",
    );
    if (!r.ok) return unauthorized(ctx);
    const removed = await store.remove(ctx.req.param("id"));
    if (!removed) {
      return ctx.json(
        {
          error: {
            message: `Eval case '${ctx.req.param("id")}' not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }
    return ctx.json({ id: ctx.req.param("id"), removed: true });
  });

  return router;
}
