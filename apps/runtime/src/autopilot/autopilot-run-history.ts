// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Durable autopilot run history (`src/autopilot/autopilot-run-history.ts`)
 *
 * A {@link AutopilotRunHistory} backed by Postgres, mirroring the
 * `InMemoryAutopilotRunHistory` fallback in `autopilot-engine.ts`. Persists
 * every autopilot cycle (trigger, outcome, promoted version, canary status) so
 * the drift-guard's "promotions per flow within the window" count survives a
 * process restart — an in-memory-only counter would silently reset on every
 * redeploy and defeat the guard exactly when it matters most (right after a
 * bad rollout that prompts an operator to restart the service).
 *
 * Mirrors writes to an in-memory ring so reads stay available during a brief
 * database outage — same pattern as {@link PostgresAuditLog}.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import {
  InMemoryAutopilotRunHistory,
  type AutopilotRun,
  type AutopilotRunHistory,
} from "./autopilot-engine.js";

interface AutopilotRunRow {
  id: string;
  flow_id: string;
  trigger: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  status: string;
  bypass_rate: number | string | null;
  optimizer_run_id: string | null;
  canary_registered: boolean | null;
  promoted_version: number | string | null;
  optimization_goal: string | null;
  trigger_signal: string | null;
  measured_error_rate: number | string | null;
  measured_p95_ms: number | string | null;
  measured_quality_score: number | string | null;
  error: string | null;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

function rowToRun(r: AutopilotRunRow): AutopilotRun {
  const run: AutopilotRun = {
    id: r.id,
    flowId: r.flow_id,
    trigger: r.trigger as AutopilotRun["trigger"],
    startedAt: toIso(r.started_at),
    status: r.status as AutopilotRun["status"],
  };
  if (r.finished_at !== null) run.finishedAt = toIso(r.finished_at);
  if (r.bypass_rate !== null) run.bypassRate = Number(r.bypass_rate);
  if (r.optimizer_run_id !== null) run.optimizerRunId = r.optimizer_run_id;
  if (r.canary_registered !== null) run.canaryRegistered = r.canary_registered;
  if (r.promoted_version !== null)
    run.promotedVersion = Number(r.promoted_version);
  if (r.optimization_goal !== null) run.optimizationGoal = r.optimization_goal;
  if (r.trigger_signal !== null)
    run.triggerSignal = r.trigger_signal as AutopilotRun["triggerSignal"];
  if (r.measured_error_rate !== null)
    run.measuredErrorRate = Number(r.measured_error_rate);
  if (r.measured_p95_ms !== null)
    run.measuredP95Ms = Number(r.measured_p95_ms);
  if (r.measured_quality_score !== null)
    run.measuredQualityScore = Number(r.measured_quality_score);
  if (r.error !== null) run.error = r.error;
  return run;
}

export class PostgresAutopilotRunHistory implements AutopilotRunHistory {
  private readonly mirror = new InMemoryAutopilotRunHistory(1000);

  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  async record(run: AutopilotRun): Promise<void> {
    await this.mirror.record(run);
    try {
      await this.db.query(
        `INSERT INTO autopilot_runs
           (id, flow_id, trigger, started_at, finished_at, status, bypass_rate,
            optimizer_run_id, canary_registered, promoted_version,
            optimization_goal, trigger_signal, measured_error_rate,
            measured_p95_ms, measured_quality_score, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           finished_at = EXCLUDED.finished_at,
           status = EXCLUDED.status,
           optimizer_run_id = EXCLUDED.optimizer_run_id,
           canary_registered = EXCLUDED.canary_registered,
           promoted_version = EXCLUDED.promoted_version,
           trigger_signal = EXCLUDED.trigger_signal,
           measured_error_rate = EXCLUDED.measured_error_rate,
           measured_p95_ms = EXCLUDED.measured_p95_ms,
           measured_quality_score = EXCLUDED.measured_quality_score,
           error = EXCLUDED.error`,
        [
          run.id,
          run.flowId,
          run.trigger,
          run.startedAt,
          run.finishedAt ?? null,
          run.status,
          run.bypassRate ?? null,
          run.optimizerRunId ?? null,
          run.canaryRegistered ?? null,
          run.promotedVersion ?? null,
          run.optimizationGoal ?? null,
          run.triggerSignal ?? null,
          run.measuredErrorRate ?? null,
          run.measuredP95Ms ?? null,
          run.measuredQualityScore ?? null,
          run.error ?? null,
        ],
      );
    } catch (err) {
      this.logger?.warn("Failed to persist autopilot run (non-fatal)", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async listByFlow(flowId: string, limit = 500): Promise<AutopilotRun[]> {
    try {
      const rows = await this.db.query<AutopilotRunRow>(
        `SELECT id, flow_id, trigger, started_at, finished_at, status, bypass_rate,
                optimizer_run_id, canary_registered, promoted_version,
                optimization_goal, trigger_signal, measured_error_rate,
                measured_p95_ms, measured_quality_score, error
           FROM autopilot_runs
          WHERE flow_id = $1
          ORDER BY started_at DESC
          LIMIT $2`,
        [flowId, limit],
      );
      return rows.map(rowToRun);
    } catch (err) {
      this.logger?.warn(
        "Autopilot run history query failed; serving in-memory mirror",
        { error: err instanceof Error ? err.message : String(err) },
      );
      return this.mirror.listByFlow(flowId, limit);
    }
  }
}

/** Builds the durable history when a database is present, else in-memory. */
export function createAutopilotRunHistory(
  db?: Database,
  logger?: Logger,
): AutopilotRunHistory {
  return db !== undefined
    ? new PostgresAutopilotRunHistory(db, logger)
    : new InMemoryAutopilotRunHistory();
}
