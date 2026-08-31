// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Eval run history routes (`src/routes/eval-runs.ts`)
 *
 * Lets CI (a scheduled evaluation job driving the CLI in `src/eval/run.ts`) or
 * an operator record a completed {@link EvalReport}
 * against the running server, so `GET /admin/compliance/dossier` can cite
 * "this flow/dataset was last evaluated on <date> with pass rate <x>%" as
 * quality-assurance evidence. Without this endpoint, eval results only ever
 * exist as CI job output — invisible to the running deployment.
 *
 *   POST /admin/eval/runs         — record a completed eval report [operator]
 *   GET  /admin/eval/runs         — list recent recorded runs        [viewer]
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { EvalRunHistory } from "../eval/eval-run-history.js";
import type { EvalReport } from "../eval/eval-runner.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { Logger } from "../observability/logger.js";
import type { EvalMatrixService, EvalMatrixTask } from "../eval/eval-matrix.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface EvalRunsRouterDeps {
  history: EvalRunHistory;
  matrix?: EvalMatrixService;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
  auditLog?: AuditLog;
  logger?: Logger;
}

function isEvalReport(v: unknown): v is EvalReport {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    typeof r.total === "number" &&
    typeof r.passed === "number" &&
    typeof r.failed === "number" &&
    typeof r.passRate === "number" &&
    Array.isArray(r.cases)
  );
}

export function createEvalRunsRouter(deps: EvalRunsRouterDeps): Hono {
  const router = new Hono();
  const { history, auditLog, matrix, logger } = deps;
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  const unauthorized = (ctx: Context) =>
    ctx.json(
      {
        error: {
          message: "Unauthorized operator access.",
          type: "authentication_error",
        },
      },
      401,
    );

  if (matrix !== undefined) {
    router.post("/admin/eval/matrix-runs", async (ctx) => {
      const auth = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "monitoring:write",
      );
      if (!auth.ok) return unauthorized(ctx);

      let body: {
        name?: unknown;
        tasks?: unknown;
        flows?: unknown;
        concurrency?: unknown;
      };
      try {
        body = await ctx.req.json();
      } catch {
        return ctx.json(
          { error: { message: "Invalid JSON body.", type: "invalid_request_error" } },
          400,
        );
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const flows = Array.isArray(body.flows)
        ? [...new Set(body.flows.flatMap((flow) =>
            typeof flow === "string" && flow.trim() !== "" ? [flow.trim()] : []))]
        : [];
      const rawTasks = Array.isArray(body.tasks) ? body.tasks : [];
      const tasks: EvalMatrixTask[] = rawTasks.flatMap((value, index) => {
        if (typeof value !== "object" || value === null) return [];
        const task = value as Record<string, unknown>;
        const prompt = typeof task.prompt === "string" ? task.prompt.trim() : "";
        const expected = typeof task.expected === "string" ? task.expected.trim() : "";
        const id = typeof task.id === "string" && task.id.trim() !== ""
          ? task.id.trim()
          : `task-${index + 1}`;
        return prompt === "" || expected === "" ? [] : [{ id, prompt, expected }];
      });
      if (name === "" || flows.length === 0 || tasks.length !== rawTasks.length || tasks.length === 0) {
        return ctx.json(
          {
            error: {
              message: "name, at least one flow, and tasks with non-empty prompt/expected are required.",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      if (
        name.length > 200 ||
        tasks.length > 100 ||
        flows.length > 20 ||
        tasks.length * flows.length > 500 ||
        tasks.some((task) => task.id.length > 200 || task.prompt.length > 20_000 || task.expected.length > 20_000)
      ) {
        return ctx.json(
          {
            error: {
              message: "Matrix exceeds limits (name/id 200 chars, prompt/expected 20,000 chars, 100 tasks, 20 flows, 500 cells).",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
      if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
        return ctx.json(
          { error: { message: "Task ids must be unique.", type: "invalid_request_error" } },
          400,
        );
      }
      const requestedConcurrency = typeof body.concurrency === "number"
        ? body.concurrency
        : undefined;
      try {
        const run = await matrix.start({
          name,
          tasks,
          flows,
          ...(requestedConcurrency === undefined ? {} : { concurrency: requestedConcurrency }),
          createdBy: auth.actor?.name ?? "operator",
        });
        auditLog?.record({
          actor: auth.actor?.name ?? "operator",
          ...(auth.actor?.role !== undefined ? { role: auth.actor.role } : {}),
          action: "eval.matrix.start",
          target: run.id,
          outcome: "success",
          details: { name, tasks: tasks.length, flows: flows.length, total: run.total },
        });
        return ctx.json({ run }, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("Unknown flows:")) {
          return ctx.json(
            { error: { message, type: "invalid_request_error" } },
            400,
          );
        }
        logger?.error("Failed to persist or start eval matrix", {
          error: message,
          ...(typeof error === "object" && error !== null && "code" in error
            ? { code: String((error as { code: unknown }).code) }
            : {}),
          actor: auth.actor?.name ?? "operator",
          name,
          tasks: tasks.length,
          flows: flows.length,
        });
        return ctx.json(
          {
            error: {
              message: "Eval matrix could not be persisted or started.",
              type: "service_unavailable_error",
            },
          },
          503,
        );
      }
    });

    router.get("/admin/eval/matrix-runs", async (ctx) => {
      const auth = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "monitoring:read",
      );
      if (!auth.ok) return unauthorized(ctx);
      const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "20", 10);
      try {
        const runs = await matrix.list(Number.isFinite(rawLimit) ? rawLimit : undefined);
        return ctx.json({ runs });
      } catch {
        return ctx.json(
          { error: { message: "Eval matrix store is unavailable.", type: "service_unavailable_error" } },
          503,
        );
      }
    });

    router.get("/admin/eval/matrix-runs/:id", async (ctx) => {
      const auth = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "monitoring:read",
      );
      if (!auth.ok) return unauthorized(ctx);
      try {
        const run = await matrix.get(ctx.req.param("id"));
        if (run === undefined) {
          return ctx.json(
            { error: { message: "Eval matrix run not found.", type: "not_found_error" } },
            404,
          );
        }
        return ctx.json({ run });
      } catch {
        return ctx.json(
          { error: { message: "Eval matrix store is unavailable.", type: "service_unavailable_error" } },
          503,
        );
      }
    });

    router.get("/admin/eval/matrix-runs/:runId/cells/:cellId/trace", async (ctx) => {
      const auth = await operatorAuth.authorize(
        ctx.req.header("Authorization"),
        ctx.req.query("token"),
        "audit:read",
      );
      if (!auth.ok) return unauthorized(ctx);
      try {
        const trace = await matrix.getTrace(
          ctx.req.param("runId"),
          ctx.req.param("cellId"),
        );
        if (trace === undefined) {
          return ctx.json(
            { error: { message: "Archived trace not found.", type: "not_found_error" } },
            404,
          );
        }
        return ctx.json({ trace });
      } catch {
        return ctx.json(
          { error: { message: "Eval matrix store is unavailable.", type: "service_unavailable_error" } },
          503,
        );
      }
    });
  }

  router.post("/admin/eval/runs", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:write",
    );
    if (!r.ok) return unauthorized(ctx);

    let body: {
      report?: unknown;
      source?: unknown;
      kind?: unknown;
      dataset_id?: unknown;
      dataset_version?: unknown;
      collection?: unknown;
      parameters?: unknown;
      retrieval_report?: unknown;
    };
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        { error: { message: "Invalid JSON body.", type: "invalid_request_error" } },
        400,
      );
    }
    if (!isEvalReport(body.report)) {
      return ctx.json(
        {
          error: {
            message:
              "Field 'report' must be an EvalReport object (as produced by " +
              "`bun run src/eval/run.ts --json`).",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const source = body.source === "ci" ? "ci" : "manual";
    const optionalString = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim() !== "" ? value : undefined;
    const optionalObject = (value: unknown): Record<string, unknown> | undefined =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    if (
      (body.parameters !== undefined && optionalObject(body.parameters) === undefined) ||
      (body.retrieval_report !== undefined && optionalObject(body.retrieval_report) === undefined)
    ) {
      return ctx.json(
        { error: { message: "parameters and retrieval_report must be JSON objects.", type: "invalid_request_error" } },
        400,
      );
    }
    const record = await history.record({
      name: body.report.name,
      source,
      ...(optionalString(body.kind) !== undefined ? { kind: optionalString(body.kind) } : {}),
      ...(optionalString(body.dataset_id) !== undefined ? { datasetId: optionalString(body.dataset_id) } : {}),
      ...(optionalString(body.dataset_version) !== undefined ? { datasetVersion: optionalString(body.dataset_version) } : {}),
      ...(optionalString(body.collection) !== undefined ? { collection: optionalString(body.collection) } : {}),
      ...(optionalObject(body.parameters) !== undefined ? { parameters: optionalObject(body.parameters) } : {}),
      ...(optionalObject(body.retrieval_report) !== undefined ? { retrievalReport: optionalObject(body.retrieval_report) } : {}),
      report: body.report,
    });

    auditLog?.record({
      actor: r.actor?.name ?? "operator",
      ...(r.actor?.role !== undefined ? { role: r.actor.role } : {}),
      action: "eval.run.record",
      target: record.name,
      outcome: "success",
      details: { source, passRate: body.report.passRate, total: body.report.total },
    });

    return ctx.json({ record });
  });

  router.get("/admin/eval/runs", async (ctx) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) return unauthorized(ctx);

    const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "50", 10);
    const runs = await history.listRecent(Number.isFinite(rawLimit) ? rawLimit : undefined);
    return ctx.json({ runs });
  });

  return router;
}
