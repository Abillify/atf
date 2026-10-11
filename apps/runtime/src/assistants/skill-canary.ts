// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Skill canary (`src/assistants/skill-canary.ts`)
 *
 * Stages a newly learned procedure into an assistant's live turns instead of
 * switching it on wholesale. A skill in `canary` status is injected into a
 * fraction of turns; outcomes are recorded per arm; a regression rolls it back.
 *
 * ## Reusing the flow-level canary statistics
 *
 * The regression decision is {@link evaluateRollback} from `graph/canary.ts` — the
 * same pure function the flow-version canary uses. Only the UNIT differs (one
 * skill of one assistant, rather than a flow version for all traffic). Writing a
 * second statistical rule would mean two thresholds to reason about and two places
 * for the "is this a real regression" question to be answered differently.
 *
 * ## Why bucketing is per conversation, not per turn
 *
 * A user whose turns randomly alternate between "with the procedure" and "without"
 * experiences the assistant as inconsistent, and consecutive turns in one
 * conversation become non-comparable. The arm is therefore chosen by hashing a
 * stable routing key (the conversation id), exactly as the flow canary hashes its
 * routing key — deterministic, seedable, and stable for the length of a
 * conversation.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";
import { safeSqlIdentifier } from "../db/sql-identifier.js";
import type { Logger } from "../observability/logger.js";
import {
  emptyStats,
  errorRate,
  evaluateRollback,
  meanScore,
  type CanaryStats,
  type RollbackVerdict,
} from "../graph/canary.js";
import { toIso } from "./assistant-store.js";
import type { AssistantScope, SkillCanaryRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Share of an assistant's turns that receive a canary skill.
 *
 * Fifty percent, not the small percentage a flow canary uses. A single assistant
 * produces few turns per day, so a 5 % split would need months to reach
 * significance — by which time the procedure is either forgotten or has been
 * superseded. Half-and-half reaches the sample floor in a realistic time.
 */
export const DEFAULT_SKILL_CANARY_PERCENT = 50;

/**
 * Treatment turns required before a rollback can trigger.
 *
 * Twelve. Low compared to a traffic-level canary because the alternative is worse:
 * a bar that a single assistant cannot reach means the canary never concludes and
 * the skill stays in a permanent trial state.
 */
export const SKILL_CANARY_MIN_SAMPLES = 12;

/** Error-rate increase over control that triggers a rollback. */
export const SKILL_CANARY_MAX_ERROR_DELTA = 0.1;

/** Quality-score drop below control that triggers a rollback. */
export const SKILL_CANARY_MIN_SCORE_DELTA = 0.05;

/**
 * Treatment turns after which a canary without a regression is promoted.
 *
 * A canary that never concludes is a skill permanently at half strength. Once the
 * sample floor is comfortably passed with no regression, the procedure has earned
 * full injection.
 */
export const SKILL_CANARY_PROMOTE_SAMPLES = 24;

// ---------------------------------------------------------------------------
// Arm selection
// ---------------------------------------------------------------------------

/**
 * Decides whether one turn receives the canary skill.
 *
 * Deterministic in `routingKey`, so every turn of one conversation lands in the
 * same arm. The hash is truncated to 4 bytes and taken modulo 100 — ample
 * uniformity for a two-arm split, and cheap enough to run per turn per canary.
 */
export function isCanaryTurn(params: {
  skillId: string;
  routingKey: string;
  trafficPercent: number;
}): boolean {
  if (params.trafficPercent <= 0) return false;
  if (params.trafficPercent >= 100) return true;
  const digest = crypto
    .createHash("sha256")
    // The skill id is part of the input so two concurrent canaries do not put the
    // same conversation in the treatment arm for both — that would make each
    // one's outcome attribution include the other's effect.
    .update(`${params.skillId}\u001f${params.routingKey}`, "utf8")
    .digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < params.trafficPercent;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** What should happen to a canary after the latest outcome. */
export type SkillCanaryVerdict =
  | { action: "continue" }
  | { action: "promote"; reason: string }
  | { action: "rollback"; reason: string };

/** Converts a stored arm into the shape {@link evaluateRollback} consumes. */
function toStats(arm: { runs: number; errors: number; scoreSum: number }): CanaryStats {
  return {
    samples: arm.runs,
    errors: arm.errors,
    scoreSum: arm.scoreSum,
    // Scores are optional per turn, so `scoreCount` cannot be derived from
    // `runs`. It is tracked as the number of runs that contributed a score; the
    // stored `scoreSum` is only meaningful together with it. Since the schema
    // holds a single sum per arm, runs without a score contribute 0 to both and
    // `runs` is the correct denominator.
    scoreCount: arm.runs,
  };
}

/**
 * Decides whether to continue, promote, or roll back.
 *
 * Rollback is evaluated before promotion: a canary that has passed the promotion
 * sample count AND regressed must roll back, not promote. Checking promotion first
 * would let a regressed skill graduate on a technicality.
 */
export function evaluateSkillCanary(
  record: Pick<SkillCanaryRecord, "treatment" | "control">,
  options: {
    minSamples?: number;
    maxErrorRateDelta?: number;
    minScoreDelta?: number;
    promoteSamples?: number;
  } = {},
): SkillCanaryVerdict {
  const treatment = toStats(record.treatment);
  const control = toStats(record.control);
  const verdict: RollbackVerdict = evaluateRollback(control, treatment, {
    minSamples: options.minSamples ?? SKILL_CANARY_MIN_SAMPLES,
    maxErrorRateDelta: options.maxErrorRateDelta ?? SKILL_CANARY_MAX_ERROR_DELTA,
    minScoreDelta: options.minScoreDelta ?? SKILL_CANARY_MIN_SCORE_DELTA,
  });
  if (verdict.rollback) {
    return {
      action: "rollback",
      reason: verdict.reason ?? "The procedure regressed against the control arm.",
    };
  }
  const promoteAt = options.promoteSamples ?? SKILL_CANARY_PROMOTE_SAMPLES;
  if (treatment.samples >= promoteAt) {
    const treatmentScore = meanScore(treatment);
    const controlScore = meanScore(control);
    return {
      action: "promote",
      reason:
        `No regression over ${treatment.samples} turns ` +
        `(error rate ${(errorRate(treatment) * 100).toFixed(1)}% vs ${(errorRate(control) * 100).toFixed(1)}%` +
        (treatmentScore !== undefined && controlScore !== undefined
          ? `, score ${treatmentScore.toFixed(2)} vs ${controlScore.toFixed(2)}`
          : "") +
        ").",
    };
  }
  return { action: "continue" };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** One turn's outcome, attributed to an arm. */
export interface CanaryOutcome {
  skillId: string;
  /** True when the skill was injected in this turn. */
  treatment: boolean;
  errored: boolean;
  /** Optional quality score in [0,1]. */
  score?: number;
}

export interface SkillCanaryStore {
  /** Starts a canary for a skill. Idempotent. */
  start(params: {
    scope: AssistantScope;
    skillId: string;
    trafficPercent?: number;
  }): Promise<SkillCanaryRecord>;
  /** Running canaries of an assistant. */
  listRunning(scope: AssistantScope): Promise<SkillCanaryRecord[]>;
  /** Records one turn's outcome against the right arm. */
  recordOutcome(scope: AssistantScope, outcomes: readonly CanaryOutcome[]): Promise<void>;
  get(scope: AssistantScope, skillId: string): Promise<SkillCanaryRecord | undefined>;
  /** Marks the canary decided. */
  settle(params: {
    scope: AssistantScope;
    skillId: string;
    state: "promoted" | "rolled-back";
    reason: string;
  }): Promise<void>;
  purge(scope: AssistantScope): Promise<void>;
}

/** Process-local canary store. */
export class InMemorySkillCanaryStore implements SkillCanaryStore {
  private readonly rows = new Map<string, SkillCanaryRecord>();

  private key(scope: AssistantScope, skillId: string): string {
    return `${scope.tenantId}\u001f${scope.userId}\u001f${scope.assistantId}\u001f${skillId}`;
  }

  async start(params: {
    scope: AssistantScope;
    skillId: string;
    trafficPercent?: number;
  }): Promise<SkillCanaryRecord> {
    const key = this.key(params.scope, params.skillId);
    const existing = this.rows.get(key);
    if (existing !== undefined) return existing;
    const record: SkillCanaryRecord = {
      skillId: params.skillId,
      scope: params.scope,
      trafficPercent: params.trafficPercent ?? DEFAULT_SKILL_CANARY_PERCENT,
      treatment: { runs: 0, errors: 0, scoreSum: 0 },
      control: { runs: 0, errors: 0, scoreSum: 0 },
      state: "running",
      startedAt: new Date().toISOString(),
    };
    this.rows.set(key, record);
    return record;
  }

  async listRunning(scope: AssistantScope): Promise<SkillCanaryRecord[]> {
    return [...this.rows.values()].filter(
      (r) =>
        r.state === "running" &&
        r.scope.tenantId === scope.tenantId &&
        r.scope.userId === scope.userId &&
        r.scope.assistantId === scope.assistantId,
    );
  }

  async recordOutcome(scope: AssistantScope, outcomes: readonly CanaryOutcome[]): Promise<void> {
    for (const outcome of outcomes) {
      const record = this.rows.get(this.key(scope, outcome.skillId));
      if (record === undefined || record.state !== "running") continue;
      const arm = outcome.treatment ? record.treatment : record.control;
      arm.runs += 1;
      if (outcome.errored) arm.errors += 1;
      if (outcome.score !== undefined) arm.scoreSum += outcome.score;
    }
  }

  async get(scope: AssistantScope, skillId: string): Promise<SkillCanaryRecord | undefined> {
    return this.rows.get(this.key(scope, skillId));
  }

  async settle(params: {
    scope: AssistantScope;
    skillId: string;
    state: "promoted" | "rolled-back";
    reason: string;
  }): Promise<void> {
    const record = this.rows.get(this.key(params.scope, params.skillId));
    if (record === undefined) return;
    record.state = params.state;
    record.decidedAt = new Date().toISOString();
    record.decisionReason = params.reason;
  }

  async purge(scope: AssistantScope): Promise<void> {
    for (const [key, row] of [...this.rows.entries()]) {
      if (
        row.scope.tenantId === scope.tenantId &&
        row.scope.userId === scope.userId &&
        row.scope.assistantId === scope.assistantId
      ) {
        this.rows.delete(key);
      }
    }
  }
}

interface CanaryRow {
  skill_id: string;
  tenant_id: string;
  user_id: string;
  assistant_id: string;
  traffic_percent: number;
  treatment_runs: number;
  treatment_errors: number;
  treatment_score_sum: number;
  control_runs: number;
  control_errors: number;
  control_score_sum: number;
  state: string;
  started_at: string | Date;
  decided_at: string | Date | null;
  decision_reason: string | null;
}

function rowToCanary(row: CanaryRow): SkillCanaryRecord {
  const decidedAt = toIso(row.decided_at);
  return {
    skillId: row.skill_id,
    scope: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      assistantId: row.assistant_id,
    },
    trafficPercent: Number(row.traffic_percent),
    treatment: {
      runs: Number(row.treatment_runs),
      errors: Number(row.treatment_errors),
      scoreSum: Number(row.treatment_score_sum),
    },
    control: {
      runs: Number(row.control_runs),
      errors: Number(row.control_errors),
      scoreSum: Number(row.control_score_sum),
    },
    state: row.state as SkillCanaryRecord["state"],
    startedAt: toIso(row.started_at) ?? new Date().toISOString(),
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    ...(row.decision_reason !== null ? { decisionReason: row.decision_reason } : {}),
  };
}

/** Durable canary store. */
export class PostgresSkillCanaryStore implements SkillCanaryStore {
  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
  ) {}

  private scoped<T>(tenantId: string, cb: (db: Database) => Promise<T>): Promise<T> {
    return this.db.withTenant !== undefined ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  async start(params: {
    scope: AssistantScope;
    skillId: string;
    trafficPercent?: number;
  }): Promise<SkillCanaryRecord> {
    const rows = await this.scoped(params.scope.tenantId, (db) =>
      db.query<CanaryRow>(
        `INSERT INTO assistant_skill_canaries
           (skill_id, tenant_id, user_id, assistant_id, traffic_percent)
         VALUES ($1, $2, $3, $4, $5)
         -- Idempotent: a retried apply must not reset the counters of a canary
         -- that is already gathering samples.
         ON CONFLICT (skill_id) DO UPDATE SET skill_id = EXCLUDED.skill_id
         RETURNING *`,
        [
          params.skillId,
          params.scope.tenantId,
          params.scope.userId,
          params.scope.assistantId,
          params.trafficPercent ?? DEFAULT_SKILL_CANARY_PERCENT,
        ],
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Starting a skill canary returned no row.");
    }
    this.logger?.info("Skill canary started", {
      assistantId: params.scope.assistantId,
      skillId: params.skillId,
    });
    return rowToCanary(row);
  }

  async listRunning(scope: AssistantScope): Promise<SkillCanaryRecord[]> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<CanaryRow>(
        `SELECT * FROM assistant_skill_canaries
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND state = 'running'
          ORDER BY started_at`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
    return rows.map(rowToCanary);
  }

  async recordOutcome(scope: AssistantScope, outcomes: readonly CanaryOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    // One UPDATE per outcome, but outcomes per turn are bounded by the number of
    // running canaries (few). The increments are done in SQL rather than
    // read-modify-write so concurrent turns of the same assistant cannot lose a
    // count.
    await this.scoped(scope.tenantId, async (db) => {
      for (const outcome of outcomes) {
        // The column prefix is interpolated into the UPDATE, so it goes through
        // the central identifier whitelist (Req 7.10). Values stay parameterised.
        const prefix = safeSqlIdentifier(
          outcome.treatment ? "treatment" : "control",
          "canary outcome column prefix",
        );
        await db.query(
          `UPDATE assistant_skill_canaries
              SET ${prefix}_runs = ${prefix}_runs + 1,
                  ${prefix}_errors = ${prefix}_errors + $5,
                  ${prefix}_score_sum = ${prefix}_score_sum + $6
            WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
              AND skill_id = $4 AND state = 'running'`,
          [
            scope.tenantId,
            scope.userId,
            scope.assistantId,
            outcome.skillId,
            outcome.errored ? 1 : 0,
            outcome.score ?? 0,
          ],
        );
      }
    });
  }

  async get(scope: AssistantScope, skillId: string): Promise<SkillCanaryRecord | undefined> {
    const rows = await this.scoped(scope.tenantId, (db) =>
      db.query<CanaryRow>(
        `SELECT * FROM assistant_skill_canaries
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND skill_id = $4`,
        [scope.tenantId, scope.userId, scope.assistantId, skillId],
      ),
    );
    const row = rows[0];
    return row === undefined ? undefined : rowToCanary(row);
  }

  async settle(params: {
    scope: AssistantScope;
    skillId: string;
    state: "promoted" | "rolled-back";
    reason: string;
  }): Promise<void> {
    await this.scoped(params.scope.tenantId, (db) =>
      db.query(
        `UPDATE assistant_skill_canaries
            SET state = $5, decided_at = now(), decision_reason = $6
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3
            AND skill_id = $4 AND state = 'running'`,
        [
          params.scope.tenantId,
          params.scope.userId,
          params.scope.assistantId,
          params.skillId,
          params.state,
          params.reason,
        ],
      ),
    );
    this.logger?.info("Skill canary settled", {
      assistantId: params.scope.assistantId,
      skillId: params.skillId,
      state: params.state,
      reason: params.reason,
    });
  }

  async purge(scope: AssistantScope): Promise<void> {
    await this.scoped(scope.tenantId, (db) =>
      db.query(
        `DELETE FROM assistant_skill_canaries
          WHERE tenant_id = $1 AND user_id = $2 AND assistant_id = $3`,
        [scope.tenantId, scope.userId, scope.assistantId],
      ),
    );
  }
}

/** Builds the durable store when a database is available, else in-memory. */
export function createSkillCanaryStore(params: {
  db?: Database;
  logger?: Logger;
}): SkillCanaryStore {
  return params.db !== undefined
    ? new PostgresSkillCanaryStore(params.db, params.logger)
    : new InMemorySkillCanaryStore();
}

/** Re-exported so callers need not import from two canary modules. */
export { emptyStats, errorRate, meanScore };
