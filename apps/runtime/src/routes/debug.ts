// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Debug Trace Route (`src/routes/debug.ts`)
 *
 * Operator endpoints for exporting execution traces as JSON. Protected by the
 * same token gate as the rest of the monitoring plane (`monitoring:read`
 * permission).
 *
 * Size contract: metadata is complete, free text is byte-bounded on ingest (see
 * `monitoring/debug-trace-limits.ts`); the applied budgets are reported on the
 * trace as `limits`.
 *
 *   GET /monitoring/debug
 *       List the most recent debug traces (lightweight summary — no prompt text).
 *       Query params:
 *         limit  — max entries to return (1–200, default 50)
 *
 *   GET /monitoring/debug/:executionId
 *       Export the complete debug trace for one execution as JSON. Contains:
 *         - context          — session identity (chatId, sessionId, userId, …)
 *         - input_messages   — conversation as received (all roles), text bounded
 *         - limits           — the text budgets applied to this trace
 *         - nodes[]          — per-node detail:
 *             - full_prompt  — system + conversation sent to LLM (bounded)
 *             - full_response — LLM output (bounded to 512 bytes by default)
 *             - full_reasoning — chain-of-thought / thinking content (bounded)
 *             - tool_calls[] — every MCP/RAG call; structure and metadata
 *                               complete, payload strings bounded
 *             - tool_selection — semantic tool selection decision (if used)
 *             - diagnostics[] — in-node event timeline (retries, fallbacks,
 *                               repetition aborts, reasoning-only salvages,
 *                               empty responses) for post-mortem failure tracing
 *             - error_message / error_type / error_details — the failing error,
 *                               structured (only when the node errored)
 *         - usage            — accumulated token counts
 *         - errors           — stream errors
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { DebugTraceStore } from "../monitoring/debug-trace-store.js";
import { buildRunSample, traceBelongsToFlow } from "../monitoring/run-sample.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface DebugRouterDeps {
  debugStore: DebugTraceStore;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

export function createDebugRouter(deps: DebugRouterDeps): Hono {
  const router = new Hono();
  const { debugStore } = deps;
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  /** Returns true when the caller has monitoring:read access. */
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
        error: {
          message: "Unauthorized monitoring access.",
          type: "authentication_error",
        },
      },
      401,
    );

  // -------------------------------------------------------------------------
  // GET /monitoring/debug — list recent debug traces
  // -------------------------------------------------------------------------
  router.get("/monitoring/debug", async (ctx) => {
    if (!(await authed(ctx))) return unauthorized(ctx);

    const rawLimit = Number.parseInt(ctx.req.query("limit") ?? "50", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 200)
      : 50;

    // Optional: only runs of one flow (including its Studio test runs), each
    // with the triggering message, for the Studio's "pin run data" picker.
    const flowId = ctx.req.query("flowId");
    if (flowId !== undefined && flowId !== "") {
      const traces = debugStore
        .listRecent(200)
        .filter((t) => traceBelongsToFlow(t.flow_id, flowId))
        .slice(0, limit)
        .map((t) => {
          const full = debugStore.getTrace(t.execution_id);
          return { ...t, preview: full !== undefined ? buildRunSample(full).preview : "" };
        });
      return ctx.json({ traces });
    }
    const traces = debugStore.listRecent(limit);
    return ctx.json({ traces });
  });

  // -------------------------------------------------------------------------
  // GET /monitoring/debug/:executionId/sample — the run as sample values for
  // the Studio's expression builder (see monitoring/run-sample.ts)
  // -------------------------------------------------------------------------
  router.get("/monitoring/debug/:executionId/sample", async (ctx) => {
    if (!(await authed(ctx))) return unauthorized(ctx);
    const trace = debugStore.getTrace(ctx.req.param("executionId"));
    if (trace === undefined) {
      return ctx.json(
        {
          error: {
            message: "Run not found — debug traces are kept for the last 200 executions only.",
            type: "not_found_error",
          },
        },
        404,
      );
    }
    return ctx.json(buildRunSample(trace));
  });

  // -------------------------------------------------------------------------
  // GET /monitoring/debug/:executionId — full trace export
  // -------------------------------------------------------------------------
  router.get("/monitoring/debug/:executionId", async (ctx) => {
    if (!(await authed(ctx))) return unauthorized(ctx);

    const executionId = ctx.req.param("executionId");
    const trace = debugStore.getTrace(executionId);

    if (trace === undefined) {
      return ctx.json(
        {
          error: {
            message: `Debug trace "${executionId}" not found. Traces are kept in a bounded in-memory buffer (last 200 executions). The trace may have been evicted or the server may have restarted.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }

    return ctx.json(trace);
  });

  return router;
}
