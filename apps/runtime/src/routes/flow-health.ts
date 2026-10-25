// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow health route (`src/routes/flow-health.ts`)
 *
 * The authenticated detail view behind the public readiness probe's
 * `flow_load: degraded` marker: which flows are loaded, where each
 * one comes from (file vs. DB, including DB flows that shadow a same-id file
 * flow — ADR 0034), its declared version and definition digest, the last
 * recorded eval run when the eval-run history knows the name, and every flow
 * file that failed to load with its reason.
 *
 *   GET /monitoring/flow-health — per-flow health + load failures [monitoring:read]
 *
 * Auth mirrors `/monitoring/flow-stats` (the monitoring router): a valid
 * short-lived stream ticket in `?token=` when ticketing is enabled, otherwise
 * the standard operator token/JWT.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { computeFlowDigest } from "../graph/flow-revision.js";
import {
  findShadowedFlowIds,
  type DbFlowSource,
} from "../graph/flow-registry-composite.js";
import { getFlowLoadFailures } from "../graph/flow-parser/validate.js";
import type { FlowRegistry } from "../graph/flow-parser/loader.js";
import type { EvalRunHistory } from "../eval/eval-run-history.js";
import { verifyMonitoringTicket } from "../monitoring/monitoring-ticket.js";
import {
  createOperatorAuthorizer,
  roleHasPermission,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";
import {
  SLO_DEFAULT_WINDOW,
  SLO_MIN_SAMPLES,
  type FlowSloEvaluator,
  type SloObjective,
} from "../observability/flow-slo.js";

export interface FlowHealthRouterDeps {
  /** Merged registry the engine serves from (composite when DB flows exist). */
  flowRegistry: Pick<FlowRegistry, "list">;
  /** File-only registry — used for the `file` name of file-sourced flows. */
  fileRegistry?: Pick<FlowRegistry, "list" | "getSource">;
  /** DB snapshot — used to classify `source: "db"` and compute shadowing. */
  dbSource?: Pick<DbFlowSource, "get" | "list">;
  /** Eval-run history behind `/admin/eval/runs`; omit `lastEval` when absent. */
  evalHistory?: EvalRunHistory;
  /**
   * Process-local SLO evaluator — supplies the live evaluation state
   * (samples in window, breached objectives) for each flow's `slo` field.
   * Without it the declared objectives are still reported, with an empty
   * state. Per replica: each runtime instance reports its own window.
   */
  flowSlo?: FlowSloEvaluator;
  /** Mirrors MONITORING_AUTH for the monitoring plane. */
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
  /** HMAC secret for short-lived monitoring tickets (same as monitoring router). */
  ticketSecret?: string;
  ticketTtlSeconds?: number;
}

interface FlowHealthEntry {
  id: string;
  source: "file" | "db";
  file?: string;
  version?: string;
  digest?: string;
  shadowsFile: boolean;
  lastEval?: { runId: string; at: string; passed: number; failed: number };
  /**
   * Declared service objectives plus this replica's live evaluation state.
   * Present only when the flow declares `slo`.
   */
  slo?: {
    window: number;
    objectives: Partial<Record<SloObjective, number>>;
    samples: number;
    /** Executions needed before objectives are evaluated (fixed, 10). */
    minSamples: number;
    breached: SloObjective[];
  };
}

function unauthorized(c: Context) {
  return c.json(
    {
      error: {
        message: "Unauthorized monitoring access.",
        type: "authentication_error",
      },
    },
    401,
  );
}

export function createFlowHealthRouter(deps: FlowHealthRouterDeps): Hono {
  const router = new Hono();
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });
  const ticketSecret = deps.ticketSecret;
  void deps.ticketTtlSeconds; // tickets are minted by the monitoring router

  /** Same ticket-or-operator authorization as `/monitoring/flow-stats`. */
  const authorize = async (c: {
    req: {
      header: (k: string) => string | undefined;
      query: (k: string) => string | undefined;
    };
  }): Promise<boolean> => {
    const authHeader = c.req.header("Authorization");
    const queryToken = c.req.query("token");
    if (ticketSecret !== undefined && queryToken !== undefined) {
      const ticket = verifyMonitoringTicket(ticketSecret, queryToken);
      if (ticket !== undefined) {
        return roleHasPermission(ticket.role, "monitoring:read");
      }
    }
    const result = await operatorAuth.authorize(
      authHeader,
      queryToken,
      "monitoring:read",
    );
    return result.ok;
  };

  router.get("/monitoring/flow-health", async (c) => {
    if (authRequired && !(await authorize(c))) {
      return unauthorized(c);
    }

    const shadowed =
      deps.fileRegistry !== undefined && deps.dbSource !== undefined
        ? new Set(findShadowedFlowIds(deps.fileRegistry, deps.dbSource))
        : new Set<string>();

    const flows = [...deps.flowRegistry.list()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((flow): FlowHealthEntry => {
        const fromDb = deps.dbSource?.get(flow.id) !== undefined;
        const entry: FlowHealthEntry = {
          id: flow.id,
          source: fromDb ? "db" : "file",
          shadowsFile: shadowed.has(flow.id),
        };
        if (!fromDb) {
          const fileName = deps.fileRegistry?.getSource?.(flow.id)?.fileName;
          if (fileName !== undefined) entry.file = fileName;
        }
        const version = flow.metadata?.["version"];
        if (typeof version === "string") entry.version = version;
        entry.digest = computeFlowDigest(flow);
        if (flow.slo !== undefined) {
          const objectives: Partial<Record<SloObjective, number>> = {};
          for (const key of [
            "p50LatencyMs",
            "p95LatencyMs",
            "maxTokensP50",
            "maxErrorRate",
          ] as const) {
            const value = flow.slo[key];
            if (typeof value === "number") objectives[key] = value;
          }
          const status = deps.flowSlo?.status(flow.id);
          entry.slo = {
            window: flow.slo.window ?? SLO_DEFAULT_WINDOW,
            objectives,
            samples: status?.samples ?? 0,
            minSamples: SLO_MIN_SAMPLES,
            breached: status?.breached ?? [],
          };
        }
        return entry;
      });

    if (deps.evalHistory !== undefined) {
      await Promise.all(
        flows.map(async (entry) => {
          const record = await deps.evalHistory?.latestFor(entry.id);
          if (record !== undefined) {
            entry.lastEval = {
              runId: record.id,
              at: record.recordedAt,
              passed: record.report.passed,
              failed: record.report.failed,
            };
          }
        }),
      );
    }

    return c.json({
      generatedAt: new Date().toISOString(),
      flows,
      loadFailures: getFlowLoadFailures(),
    });
  });

  return router;
}
