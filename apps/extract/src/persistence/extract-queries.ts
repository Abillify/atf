// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * extract-queries.ts
 *
 * Pure SQL builders for the extract persistence layer. Each returns a
 * parameterised `{ text, values }` — never an interpolated literal — so the
 * store stays a thin execution shell and the query construction can be unit
 * tested without a live database, mirroring how search tests its DDL.
 *
 * Only the schema identifier is interpolated, and it is the fixed
 * {@link EXTRACT_SCHEMA} constant, never anything caller-supplied.
 *
 * ## Fencing
 *
 * Every write a worker issues is fenced on its lease (design §9b.2,
 * requirement 4.5). Writes to the `jobs` row itself carry the fence in their
 * `WHERE` clause (`lease_holder = … AND lease_epoch = …`), so the check and the
 * write are one statement. Writes to the child tables (stages, docpass state,
 * outboxes) run inside a transaction that first takes a row lock on the job via
 * {@link fenceCheckQuery}; an operator action or a takeover that bumps the epoch
 * either commits before (the check then fails) or waits for the transaction.
 */

import { EXTRACT_SCHEMA } from "./extract-ddl.js";
import type {
  Fence,
  NewJob,
  OperatorTransition,
  StageUnit,
  StageUpsert,
  OutboxStatus,
} from "./types.js";

/** A parameterised statement ready to hand to `client.query(text, values)`. */
export interface Query {
  text: string;
  values: unknown[];
}

/**
 * The 32-bit signed INTEGER maximum (2^31 − 1), used as the "effectively no
 * cap" default for the large-job lane parameters. These defaults are bound as
 * query parameters and compared against `page_count` / `COUNT(*)::int`, which
 * are Postgres `INTEGER` columns; `Number.MAX_SAFE_INTEGER` overflows that type,
 * so this fits the comparison while still exceeding any realistic page count or
 * concurrent-lease count.
 */
const NO_LANE_CAP = 2_147_483_647;

/** The mutable stage tables, keyed by the unit they checkpoint. */
const STAGE_TABLE: Record<StageUnit, string> = {
  page: "page_stages",
  figure: "figure_stages",
  tile: "tile_stages",
};

/** The natural-key columns of each stage table, in order. */
const STAGE_KEY_COLUMNS: Record<StageUnit, string[]> = {
  page: ["job_id", "page", "stage"],
  figure: ["job_id", "page", "figure_id", "stage"],
  tile: ["job_id", "page", "tile_id", "stage"],
};

/**
 * Append the lease fence to a `jobs` UPDATE's WHERE clause. Pushes the holder
 * and epoch onto `values` and returns the SQL fragment (empty when unfenced,
 * i.e. an operator/API write).
 */
function fenceWhere(values: unknown[], fence: Fence | undefined): string {
  if (fence === undefined) return "";
  values.push(fence.holder, fence.epoch);
  const n = values.length;
  return ` AND lease_holder = $${n - 1} AND lease_epoch = $${n}`;
}

// ─── fencing ─────────────────────────────────────────────────────────────

/**
 * The in-transaction lease check that fences a child-table write. `share` lets
 * the concurrent page stages of one job proceed in parallel while blocking an
 * epoch bump until they commit; `update` is used when the same transaction also
 * updates the job row (token settlement), so two such transactions serialise
 * instead of deadlocking on a share→update upgrade.
 */
export function fenceCheckQuery(fence: Fence, lock: "share" | "update" = "share"): Query {
  return {
    text: `
      SELECT id FROM ${EXTRACT_SCHEMA}.jobs
       WHERE id = $1 AND lease_holder = $2 AND lease_epoch = $3
       ${lock === "update" ? "FOR NO KEY UPDATE" : "FOR SHARE"}`,
    values: [fence.jobId, fence.holder, fence.epoch],
  };
}

// ─── jobs ──────────────────────────────────────────────────────────────────

/** Insert a new job row. Caller supplies the UUID so it can echo it back. */
export function insertJobQuery(job: NewJob): Query {
  return {
    text: `
      INSERT INTO ${EXTRACT_SCHEMA}.jobs
        (id, reference, status, config, pipeline_hash, prompt_hash, resume_policy,
         visibility, priority, token_budget, source_sha256, collection, callback_url)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
    values: [
      job.id,
      job.reference,
      job.status ?? "queued",
      JSON.stringify(job.config ?? {}),
      job.pipeline_hash ?? null,
      job.prompt_hash ?? null,
      job.resume_policy ?? "pin",
      job.visibility ?? "progressive",
      job.priority ?? 0,
      job.token_budget ?? null,
      job.source_sha256,
      job.collection ?? null,
      job.callback_url ?? null,
    ],
  };
}

/** Fetch one job by id. */
export function getJobQuery(id: string): Query {
  return {
    text: `SELECT * FROM ${EXTRACT_SCHEMA}.jobs WHERE id = $1`,
    values: [id],
  };
}

/**
 * List jobs for the overview UI (requirement 18.6), newest first, paginated.
 *
 * Deliberately cheap: it reads only the `jobs` table — no join onto the
 * per-page `*_stages` tables — so a list of hundreds of jobs stays a single
 * indexed scan of `created_at DESC`. The detail view (`GET /v2/jobs/{id}`) is
 * the one that pays for the per-stage progress join; the list shows the row's
 * own status/cost/warnings and leaves `progress`/`etaSeconds` unpopulated.
 *
 * `limit` and `offset` are clamped by the caller; the tie-break on `id` keeps
 * the order total (and therefore the pagination stable) when two rows share a
 * `created_at`.
 */
export function listJobsQuery(limit: number, offset: number): Query {
  return {
    text: `
      SELECT * FROM ${EXTRACT_SCHEMA}.jobs
       ORDER BY created_at DESC, id DESC
       LIMIT $1 OFFSET $2`,
    values: [limit, offset],
  };
}

/**
 * Record the page count once the source has been prepared into a
 * page-addressable document (the `preparing` stage). Persisted so a resume
 * knows the range to schedule over without re-probing the source, and so the
 * Job API's progress reads `done/N` rather than `done/0`.
 */
export function setJobPageCountQuery(id: string, pageCount: number, fence?: Fence): Query {
  const values: unknown[] = [id, pageCount];
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET page_count = $2, updated_at = NOW()
       WHERE id = $1${fenceWhere(values, fence)}
      RETURNING *`,
    values,
  };
}

/**
 * Atomically add `tokens` to `tokens_used`, returning the new total and the
 * cap. The increment is done in SQL (`tokens_used + $2`) so concurrent page
 * stages cannot lose each other's spend the way a read-modify-write would; the
 * budget ledger reads `token_budget - tokens_used` from the returned row.
 */
export function consumeJobTokensQuery(id: string, tokens: number, fence?: Fence): Query {
  const values: unknown[] = [id, tokens];
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET tokens_used = tokens_used + $2, updated_at = NOW()
       WHERE id = $1${fenceWhere(values, fence)}
      RETURNING *`,
    values,
  };
}

/**
 * Atomically reserve `tokens` against the job's budget (requirement 4.9). The
 * reservation only succeeds while `token_budget - tokens_used - tokens_reserved
 * >= tokens`; the comparison and the increment are one statement, so two
 * concurrent pages can never both pass a check the budget only covers once. A
 * job without a cap always reserves. Zero rows means "insufficient budget" —
 * the caller runs it inside a fenced transaction, so a lost lease is detected
 * separately.
 */
export function reserveJobTokensQuery(id: string, tokens: number): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET tokens_reserved = tokens_reserved + $2, updated_at = NOW()
       WHERE id = $1
         AND (token_budget IS NULL OR token_budget - tokens_used - tokens_reserved >= $2)
      RETURNING *`,
    values: [id, tokens],
  };
}

/**
 * Settle a reservation: release `reserved` and book the actual `used` spend.
 * Runs in the same transaction as the checkpoint write it pays for.
 */
export function settleJobTokensQuery(id: string, reserved: number, used: number): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET tokens_reserved = GREATEST(0, tokens_reserved - $2),
             tokens_used     = tokens_used + $3,
             updated_at      = NOW()
       WHERE id = $1
      RETURNING *`,
    values: [id, reserved, used],
  };
}

/**
 * Update the status (and optional pause reason) of a job, bumping updated_at.
 * A dedicated builder keeps the common state-machine transition a one-liner for
 * the worker without exposing raw SQL. Any status write clears `auto_resume`;
 * only {@link pauseJobQuery} arms it.
 */
export function updateJobStatusQuery(
  id: string,
  status: string,
  pauseReason: string | null = null,
  fence?: Fence,
): Query {
  const values: unknown[] = [id, status, pauseReason];
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET status = $2, pause_reason = $3, auto_resume = FALSE, updated_at = NOW()
       WHERE id = $1${fenceWhere(values, fence)}
      RETURNING *`,
    values,
  };
}

/**
 * Park a job in `paused(reason)` (requirements 4.8, 4.9). With `autoResumeAt`
 * set (a transient dependency outage) the job is re-claimed automatically once
 * that instant is due; with `null` (budget, manual, pin) it waits for an
 * operator. `configPatch` records bookkeeping such as the dependency attempt
 * counter in the same statement.
 */
export function pauseJobQuery(
  id: string,
  reason: string,
  autoResumeAt: Date | null,
  configPatch: Record<string, unknown>,
  fence?: Fence,
): Query {
  const values: unknown[] = [id, reason, autoResumeAt, JSON.stringify(configPatch)];
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET status          = 'paused',
             pause_reason    = $2,
             auto_resume     = ($3::timestamptz IS NOT NULL),
             next_attempt_at = COALESCE($3::timestamptz, next_attempt_at),
             config          = config || $4::jsonb,
             updated_at      = NOW()
       WHERE id = $1${fenceWhere(values, fence)}
      RETURNING *`,
    values,
  };
}

/**
 * Record the Search revision id a job's emitter opened, so a resume reuses the
 * same revision (its `Idempotency-Key` is derived from the job id and the emit
 * generation, so a re-create is a no-op, but pinning the id avoids the
 * round-trip and keeps the job row authoritative). `null` clears it when a new
 * emit generation starts.
 */
export function setJobRevisionQuery(id: string, revisionId: string | null, fence?: Fence): Query {
  const values: unknown[] = [id, revisionId];
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET revision_id = $2, updated_at = NOW()
       WHERE id = $1${fenceWhere(values, fence)}
      RETURNING *`,
    values,
  };
}

/**
 * Start a new emit generation: bump `emit_generation` and forget the revision
 * id, so the next emit opens a fresh revision under a new Idempotency-Key.
 * Runs inside a fenced transaction together with the outbox reset.
 */
export function bumpEmitGenerationQuery(id: string): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET emit_generation = emit_generation + 1,
             revision_id     = NULL,
             updated_at      = NOW()
       WHERE id = $1
      RETURNING *`,
    values: [id],
  };
}

/**
 * Merge a JSON patch into a job's `config` and bump `updated_at`. Used by
 * `reparse` to flag the parse-only path and by the budget ledger to record its
 * one-time warning marker, without disturbing the frozen snapshot fields.
 */
export function patchJobConfigQuery(id: string, patch: Record<string, unknown>, fence?: Fence): Query {
  const values: unknown[] = [id, JSON.stringify(patch)];
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET config = config || $2::jsonb, updated_at = NOW()
       WHERE id = $1${fenceWhere(values, fence)}
      RETURNING *`,
    values,
  };
}

/**
 * Append a warning to a job's `warnings` array without disturbing any other
 * field. Used when a unit fails permanently: the unit is marked `failed` and
 * the job records the warning but keeps going (requirement 4.10). The append is
 * done in SQL (`warnings || $2`) so concurrent stage failures do not clobber
 * each other's warnings the way a read-modify-write would.
 */
export function appendJobWarningQuery(id: string, warning: string, fence?: Fence): Query {
  const values: unknown[] = [id, JSON.stringify([warning])];
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET warnings = warnings || $2::jsonb, updated_at = NOW()
       WHERE id = $1${fenceWhere(values, fence)}
      RETURNING *`,
    values,
  };
}

/**
 * Re-queue a job regardless of its current status, resetting the pause reason
 * and making it immediately due. This is an operator action, so instead of
 * passing the fence it REVOKES the lease: the epoch is bumped and the holder
 * cleared in the same statement, so a worker still running the job fails its
 * next fenced write with a lost lease and stops (requirement 4.5).
 */
export function requeueJobQuery(id: string): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET status           = 'queued',
             pause_reason     = NULL,
             auto_resume      = FALSE,
             next_attempt_at  = NOW(),
             lease_epoch      = lease_epoch + 1,
             lease_holder     = NULL,
             lease_expires_at = NULL,
             tokens_reserved  = 0,
             updated_at       = NOW()
       WHERE id = $1
      RETURNING *`,
    values: [id],
  };
}

/**
 * Apply an operator action (pause, resume, cancel, reparse) atomically with a
 * lease revocation. The update only applies while the job is still in the
 * status the handler validated against the state machine (`expectedStatus`),
 * so a concurrent transition turns into a retry/409 instead of a lost update.
 * Bumping the epoch and clearing the holder makes a running worker's next
 * fenced write fail, so it cannot overwrite `cancelled`/`paused`.
 */
export function operatorTransitionQuery(id: string, t: OperatorTransition): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET status           = $3,
             pause_reason     = $4,
             auto_resume      = FALSE,
             config           = config || $5::jsonb,
             resume_policy    = COALESCE($6, resume_policy),
             next_attempt_at  = CASE WHEN $3 = 'queued' THEN NOW() ELSE next_attempt_at END,
             lease_epoch      = lease_epoch + 1,
             lease_holder     = NULL,
             lease_expires_at = NULL,
             tokens_reserved  = 0,
             updated_at       = NOW()
       WHERE id = $1 AND status = $2
      RETURNING *`,
    values: [
      id,
      t.expectedStatus,
      t.status,
      t.pauseReason,
      JSON.stringify(t.configPatch ?? {}),
      t.resumePolicy ?? null,
    ],
  };
}

/**
 * Claim the next runnable job for a worker, with a fresh lease, honouring the
 * large-job lane cap (design §9b/§9a.5, requirements 4.4, 4.5, 4.8, 6.6).
 *
 * `SELECT … FOR UPDATE SKIP LOCKED` lets many workers poll the same queue
 * without blocking each other. A job is runnable when it is `queued` and due
 * (`next_attempt_at <= now`), when it is `paused` with `auto_resume` armed (a
 * dependency outage whose backoff has elapsed — requirement 4.8) and due, or
 * when its lease has expired (crash takeover). An auto-resumed job is moved back
 * to `queued` by the claim itself so the worker walks it through `preparing`.
 * The lease epoch is bumped on claim so a resurrected zombie worker fails the
 * fencing check on its next write, and any token reservations of the previous
 * holder are dropped (the new holder has no calls in flight).
 *
 * ## Lanes and fairness
 *
 * A job is "large" when its `page_count` is known AND strictly greater than
 * `largeJobPageThreshold`. A job whose `page_count` is still NULL (it has not
 * been sized by the `preparing` stage yet) is NOT large — its size is unknown,
 * so it stays in the normal lane and is freely claimable, and only lands in the
 * large lane once a resume re-claims it after prepare recorded the count.
 *
 * The `largeLaneFull` CTE counts the large jobs whose lease is currently live
 * (a working status with a lease that has not expired). When that count is at
 * or above `largeJobMaxConcurrency`, the candidate scan excludes large jobs, so
 * a worker falls through to the next NORMAL job instead — a handful of 10 000-
 * page plans can never occupy every worker and starve the small uploads behind
 * them. The count is evaluated inside the same statement as the `FOR UPDATE SKIP
 * LOCKED` pick, so it is consistent under many concurrent workers: two workers
 * cannot both read "cap not reached" and both claim the last large slot, because
 * each large job they might claim is one of the rows the other would have to
 * skip-lock. The ordering (`priority DESC, next_attempt_at, created_at, id`)
 * stays total and deterministic, so within a lane higher-priority and older jobs
 * always go first and the tie-break on `id` keeps two same-instant jobs ordered.
 */
export function claimNextJobQuery(
  leaseHolder: string,
  leaseSeconds: number,
  largeJobPageThreshold: number = NO_LANE_CAP,
  largeJobMaxConcurrency: number = NO_LANE_CAP,
): Query {
  return {
    text: `
      WITH large_lane AS (
        SELECT COUNT(*)::int AS active_large
          FROM ${EXTRACT_SCHEMA}.jobs
         WHERE status IN ('preparing','processing','emitting','committing')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at > NOW()
           AND page_count IS NOT NULL
           AND page_count > $3
      ),
      next AS (
        SELECT j.id
          FROM ${EXTRACT_SCHEMA}.jobs j
          CROSS JOIN large_lane
         WHERE ((j.status = 'queued' AND j.next_attempt_at <= NOW())
                OR (j.status = 'paused' AND j.auto_resume AND j.next_attempt_at <= NOW())
                OR (j.status IN ('preparing','processing','emitting','committing')
                    AND j.lease_expires_at IS NOT NULL
                    AND j.lease_expires_at <= NOW()))
           AND (
                 -- Normal-lane job (unknown size counts as normal): always eligible.
                 j.page_count IS NULL
                 OR j.page_count <= $3
                 -- Large-lane job: only when the lane has a free slot.
                 OR large_lane.active_large < $4
               )
         ORDER BY j.priority DESC, j.next_attempt_at, j.created_at, j.id
         LIMIT 1
         FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE ${EXTRACT_SCHEMA}.jobs j
         SET lease_holder     = $1,
             lease_epoch      = j.lease_epoch + 1,
             lease_expires_at = NOW() + ($2 || ' seconds')::interval,
             heartbeat_at     = NOW(),
             tokens_reserved  = 0,
             status           = CASE WHEN j.status = 'paused' THEN 'queued' ELSE j.status END,
             pause_reason     = CASE WHEN j.status = 'paused' THEN NULL ELSE j.pause_reason END,
             auto_resume      = FALSE,
             updated_at       = NOW()
        FROM next
       WHERE j.id = next.id
      RETURNING j.*`,
    values: [leaseHolder, String(leaseSeconds), largeJobPageThreshold, largeJobMaxConcurrency],
  };
}

/**
 * Extend a held lease, but only if the caller still owns the current epoch.
 * The fencing guard (`lease_epoch = $3`) means a heartbeat from a worker that
 * has already been superseded is a no-op (0 rows), which the caller reads as
 * "you lost the lease" (requirement 4.5).
 */
export function heartbeatJobQuery(id: string, leaseHolder: string, epoch: number, leaseSeconds: number): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.jobs
         SET lease_expires_at = NOW() + ($4 || ' seconds')::interval,
             heartbeat_at     = NOW(),
             updated_at       = NOW()
       WHERE id = $1 AND lease_holder = $2 AND lease_epoch = $3
      RETURNING *`,
    values: [id, leaseHolder, epoch, String(leaseSeconds)],
  };
}

// ─── *_stages ────────────────────────────────────────────────────────────

/**
 * Look up a stage checkpoint by its natural key. The `input_hash` is compared
 * by the caller so a resume can decide reuse-vs-recompute without a model call
 * (requirement 4.3).
 */
export function getStageQuery(unit: StageUnit, key: StageKey): Query {
  const cols = STAGE_KEY_COLUMNS[unit];
  const where = cols.map((c, i) => `${c} = $${i + 1}`).join(" AND ");
  return {
    text: `SELECT * FROM ${EXTRACT_SCHEMA}.${STAGE_TABLE[unit]} WHERE ${where}`,
    values: keyValues(unit, key),
  };
}

/**
 * Upsert a stage checkpoint. On conflict of the natural key the result is
 * overwritten and `attempts` incremented, so a retry after a transient failure
 * records the new attempt count and outcome in place (requirement 4.2).
 */
export function upsertStageQuery(unit: StageUnit, row: StageUpsert): Query {
  const keyCols = STAGE_KEY_COLUMNS[unit];
  const cols = [
    ...keyCols,
    "input_hash",
    "status",
    "output",
    "attempts",
    "next_attempt_at",
    "error",
  ];
  const values = [
    ...keyValues(unit, row),
    row.input_hash,
    row.status ?? "pending",
    row.output === undefined ? null : JSON.stringify(row.output),
    row.attempts ?? 0,
    row.next_attempt_at ?? null,
    row.error ?? null,
  ];
  const placeholders = cols.map((c, i) => {
    const p = `$${i + 1}`;
    return c === "output" ? `${p}::jsonb` : p;
  });
  const conflict = keyCols.join(", ");
  return {
    text: `
      INSERT INTO ${EXTRACT_SCHEMA}.${STAGE_TABLE[unit]}
        (${cols.join(", ")})
      VALUES (${placeholders.join(", ")})
      ON CONFLICT (${conflict}) DO UPDATE SET
        input_hash      = EXCLUDED.input_hash,
        status          = EXCLUDED.status,
        output          = EXCLUDED.output,
        attempts        = ${STAGE_TABLE[unit]}.attempts + 1,
        next_attempt_at = EXCLUDED.next_attempt_at,
        error           = EXCLUDED.error,
        updated_at      = NOW()
      RETURNING *`,
    values,
  };
}

/** All stage rows for a job in a given status (worker backlog scan). */
export function listStagesByStatusQuery(unit: StageUnit, jobId: string, status: string): Query {
  return {
    text: `
      SELECT * FROM ${EXTRACT_SCHEMA}.${STAGE_TABLE[unit]}
       WHERE job_id = $1 AND status = $2
       ORDER BY page`,
    values: [jobId, status],
  };
}

/**
 * The checkpoints of one stage over a bounded page window `[fromPage, toPage]`
 * (e.g. every `vision1` row of pages 1–200). The reparse pass walks the
 * document in such windows so it never loads a 10 000-page result set.
 */
export function listStagesWindowQuery(
  unit: StageUnit,
  jobId: string,
  stage: string,
  fromPage: number,
  toPage: number,
): Query {
  return {
    text: `
      SELECT * FROM ${EXTRACT_SCHEMA}.${STAGE_TABLE[unit]}
       WHERE job_id = $1 AND stage = $2 AND page >= $3 AND page <= $4
       ORDER BY page`,
    values: [jobId, stage, fromPage, toPage],
  };
}

/**
 * Reset the listed page stages of every page `>= fromPage` to `pending`, so the
 * scheduler re-drives them (downstream invalidation after reparse or
 * restart-stage). The output is dropped: these stages are deterministic and
 * rebuilt from the upstream checkpoints.
 */
export function resetPageStagesFromQuery(jobId: string, stages: string[], fromPage: number): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.page_stages
         SET status = 'pending', output = NULL, next_attempt_at = NULL, error = NULL,
             updated_at = NOW()
       WHERE job_id = $1 AND stage = ANY($2::text[]) AND page >= $3`,
    values: [jobId, stages, fromPage],
  };
}

/** Reset the listed page stages of exactly the given pages to `pending`. */
export function resetPageStagesForPagesQuery(jobId: string, stages: string[], pages: number[]): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.page_stages
         SET status = 'pending', output = NULL, next_attempt_at = NULL, error = NULL,
             updated_at = NOW()
       WHERE job_id = $1 AND stage = ANY($2::text[]) AND page = ANY($3::int[])`,
    values: [jobId, stages, pages],
  };
}

/**
 * Move every `failed` unit of one stage table back to `pending` and return the
 * pages they belong to (retry-failed, requirement 4.10). The output — including
 * a persisted raw model response — is kept, so a unit whose raw response
 * survived can still be re-parsed.
 */
export function retryFailedStagesQuery(unit: StageUnit, jobId: string): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.${STAGE_TABLE[unit]}
         SET status = 'pending', next_attempt_at = NOW(), error = NULL, updated_at = NOW()
       WHERE job_id = $1 AND status = 'failed'
      RETURNING page`,
    values: [jobId],
  };
}

/**
 * The DB-backed ordered page scheduler (design §9b, requirement 6.1).
 *
 * Returns the next `limit` page numbers of `[1..pageCount]` that are NOT yet
 * finished and are DUE, in strict ascending order. A page is "finished" when its
 * cursor stage (`cursorStage`, the terminal per-page stage the runner marks
 * `done` last) has a `done` checkpoint, or a `failed` one with no retry
 * scheduled — a permanently-failed page never blocks the ones behind it.
 *
 * A page is not due while ANY of its stages — page, figure or tile — is in a
 * transient-failure backoff (`failed` with `next_attempt_at` in the future). The
 * old cursor-only filter let a page whose `vision1` stage had just failed
 * transiently be re-run immediately, bypassing the backoff; the `NOT EXISTS`
 * probes (served by the partial `*_retry_due_idx` indices) close that gap.
 *
 * The point is the `LIMIT`: the query returns only the small window the worker
 * is about to run, never a 10 000-row array, so the scheduler's memory does not
 * grow with the page count. `generate_series` is evaluated inside Postgres and
 * the `LIMIT` stops it early, so no full-document set is materialised on either
 * side of the wire.
 */
export function nextRunnablePagesQuery(
  jobId: string,
  pageCount: number,
  cursorStage: string,
  limit: number,
  now: Date,
): Query {
  const backingOff = (table: string) => `
         AND NOT EXISTS (
               SELECT 1 FROM ${EXTRACT_SCHEMA}.${table} b
                WHERE b.job_id = $1 AND b.page = gs.page
                  AND b.status = 'failed'
                  AND b.next_attempt_at IS NOT NULL
                  AND b.next_attempt_at > $5)`;
  return {
    text: `
      SELECT gs.page AS page
        FROM generate_series(1, $2) AS gs(page)
        LEFT JOIN ${EXTRACT_SCHEMA}.page_stages ps
          ON ps.job_id = $1 AND ps.page = gs.page AND ps.stage = $3
       WHERE (ps.status IS NULL
              OR (ps.status <> 'done'
                  AND ps.status <> 'failed'
                  AND (ps.next_attempt_at IS NULL OR ps.next_attempt_at <= $5))
              OR (ps.status = 'failed' AND ps.next_attempt_at IS NOT NULL))${backingOff("page_stages")}${backingOff("figure_stages")}${backingOff("tile_stages")}
       ORDER BY gs.page
       LIMIT $4`,
    values: [jobId, pageCount, cursorStage, limit, now],
  };
}

/**
 * The earliest future `next_attempt_at` of any transiently-failed unit of a job
 * (page, figure or tile), or NULL. The scheduler waits until then instead of
 * spinning, and a dependency pause uses it as the auto-resume instant.
 */
export function earliestRetryAtQuery(jobId: string, now: Date): Query {
  const part = (table: string) => `
        SELECT MIN(next_attempt_at) AS at FROM ${EXTRACT_SCHEMA}.${table}
         WHERE job_id = $1 AND status = 'failed'
           AND next_attempt_at IS NOT NULL AND next_attempt_at > $2`;
  return {
    text: `
      SELECT MIN(at) AS at FROM (${part("page_stages")}
        UNION ALL${part("figure_stages")}
        UNION ALL${part("tile_stages")}
      ) retries`,
    values: [jobId, now],
  };
}

/** Count pages whose cursor stage is finished (`done` or permanently `failed`). */
export function finishedPageCountQuery(jobId: string, cursorStage: string): Query {
  return {
    text: `
      SELECT COUNT(*)::int AS count
        FROM ${EXTRACT_SCHEMA}.page_stages
       WHERE job_id = $1
         AND stage = $2
         AND (status = 'done'
              OR (status = 'failed' AND next_attempt_at IS NULL))`,
    values: [jobId, cursorStage],
  };
}

// ─── docpass_state ─────────────────────────────────────────────────────────

/** Persist the streaming document-pass state after page N (requirement 4.7). */
export function upsertDocpassStateQuery(jobId: string, page: number, state: unknown): Query {
  return {
    text: `
      INSERT INTO ${EXTRACT_SCHEMA}.docpass_state (job_id, page, state)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (job_id, page) DO UPDATE SET
        state = EXCLUDED.state, updated_at = NOW()`,
    values: [jobId, page, JSON.stringify(state ?? null)],
  };
}

/** The document-pass state of the last finished page, for resume. */
export function latestDocpassStateQuery(jobId: string): Query {
  return {
    text: `
      SELECT * FROM ${EXTRACT_SCHEMA}.docpass_state
       WHERE job_id = $1
       ORDER BY page DESC
       LIMIT 1`,
    values: [jobId],
  };
}

/** Drop the document-pass states of pages `>= fromPage` (downstream invalidation). */
export function deleteDocpassStateFromQuery(jobId: string, fromPage: number): Query {
  return {
    text: `DELETE FROM ${EXTRACT_SCHEMA}.docpass_state WHERE job_id = $1 AND page >= $2`,
    values: [jobId, fromPage],
  };
}

// ─── outboxes ────────────────────────────────────────────────────────────

/**
 * Stage an emit batch as `pending` before it is sent (design §9b.3).
 *
 * Re-staging the same seq is idempotent: an identical digest is a no-op, and a
 * row that Search has already acknowledged is never touched. A row that is
 * not yet acked but carries a different digest (the page was rebuilt after a
 * reparse/restart/retry) takes the new payload and goes back to `pending`, so
 * the emitter sends the current content — never a stale one.
 */
export function insertEmitOutboxQuery(row: {
  job_id: string;
  seq: number;
  digest: string;
  page_from: number;
  page_to: number;
  payload?: unknown;
  payload_ref?: string | null;
}): Query {
  return {
    text: `
      INSERT INTO ${EXTRACT_SCHEMA}.emit_outbox
        (job_id, seq, digest, page_from, page_to, payload, payload_ref)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (job_id, seq) DO UPDATE SET
        digest      = EXCLUDED.digest,
        page_from   = EXCLUDED.page_from,
        page_to     = EXCLUDED.page_to,
        payload     = EXCLUDED.payload,
        payload_ref = EXCLUDED.payload_ref,
        status      = 'pending',
        updated_at  = NOW()
       WHERE emit_outbox.status <> 'acked'
         AND emit_outbox.digest IS DISTINCT FROM EXCLUDED.digest
      RETURNING *`,
    values: [
      row.job_id,
      row.seq,
      row.digest,
      row.page_from,
      row.page_to,
      row.payload === undefined ? null : JSON.stringify(row.payload),
      row.payload_ref ?? null,
    ],
  };
}

/**
 * Replace an emit-outbox row's payload and digest in place (design §5 S7).
 *
 * The document pass enriches a page's staged record — sectionPath, refs,
 * merged tableId, furniture — after the concurrent per-page stages staged the
 * base record. This updates the existing row's `payload` and its `digest`.
 * Status is left untouched: the row is still `pending` at document-pass time
 * (the emitter has not sent it), so the enriched payload is what the emitter
 * picks up. A row that does not exist (a skipped failed page) matches nothing.
 */
export function updateEmitOutboxPayloadQuery(
  jobId: string,
  seq: number,
  payload: unknown,
  digest: string,
): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.emit_outbox
         SET payload = $3::jsonb, digest = $4, updated_at = NOW()
       WHERE job_id = $1 AND seq = $2
      RETURNING *`,
    values: [jobId, seq, JSON.stringify(payload ?? null), digest],
  };
}

/** Move an emit-outbox row to a new status (pending → sent → acked). */
export function setEmitOutboxStatusQuery(jobId: string, seq: number, status: OutboxStatus): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.emit_outbox
         SET status = $3, updated_at = NOW()
       WHERE job_id = $1 AND seq = $2
      RETURNING *`,
    values: [jobId, seq, status],
  };
}

/** One emit-outbox row (with its payload) by seq — the document pass's lookup. */
export function getEmitOutboxQuery(jobId: string, seq: number): Query {
  return {
    text: `SELECT * FROM ${EXTRACT_SCHEMA}.emit_outbox WHERE job_id = $1 AND seq = $2`,
    values: [jobId, seq],
  };
}

/**
 * Every emit-outbox row of a job WITHOUT its payload (the payload column is
 * returned as NULL). The emitter plans batches and reconciles from this small
 * metadata and loads payloads one batch at a time, so a 10 000-page job never
 * holds every page record in memory.
 */
export function emitOutboxMetaQuery(jobId: string): Query {
  return {
    text: `
      SELECT job_id, seq, digest, page_from, page_to, status,
             NULL::jsonb AS payload, payload_ref, attempts, next_attempt_at, error,
             created_at, updated_at
        FROM ${EXTRACT_SCHEMA}.emit_outbox
       WHERE job_id = $1
       ORDER BY seq`,
    values: [jobId],
  };
}

/** The emit-outbox rows (with payloads) of a seq window, for one batch. */
export function emitOutboxRangeQuery(jobId: string, fromSeq: number, toSeq: number): Query {
  return {
    text: `
      SELECT * FROM ${EXTRACT_SCHEMA}.emit_outbox
       WHERE job_id = $1 AND seq >= $2 AND seq <= $3
       ORDER BY seq`,
    values: [jobId, fromSeq, toSeq],
  };
}

/** Move every emit-outbox row of a job back to `pending` (new emit generation). */
export function resetEmitOutboxQuery(jobId: string): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.emit_outbox
         SET status = 'pending', updated_at = NOW()
       WHERE job_id = $1`,
    values: [jobId],
  };
}

/** Drop the emit-outbox rows of pages `>= fromSeq`; they are re-staged. */
export function deleteEmitOutboxFromQuery(jobId: string, fromSeq: number): Query {
  return {
    text: `DELETE FROM ${EXTRACT_SCHEMA}.emit_outbox WHERE job_id = $1 AND seq >= $2`,
    values: [jobId, fromSeq],
  };
}

/**
 * Stage an asset upload as `pending`. Idempotent on `(job_id, asset_id)`; a
 * legacy row without a page learns it on the next stage.
 */
export function insertAssetOutboxQuery(row: {
  job_id: string;
  asset_id: string;
  page?: number | null;
  checksum?: string | null;
  variant?: string | null;
  mime_type?: string | null;
}): Query {
  return {
    text: `
      INSERT INTO ${EXTRACT_SCHEMA}.asset_outbox
        (job_id, asset_id, checksum, variant, mime_type, page)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (job_id, asset_id) DO UPDATE SET
        page = EXCLUDED.page, updated_at = NOW()
       WHERE asset_outbox.page IS NULL AND EXCLUDED.page IS NOT NULL
      RETURNING *`,
    values: [
      row.job_id,
      row.asset_id,
      row.checksum ?? null,
      row.variant ?? null,
      row.mime_type ?? null,
      row.page ?? null,
    ],
  };
}

/** Move an asset-outbox row to a new status. */
export function setAssetOutboxStatusQuery(jobId: string, assetId: string, status: OutboxStatus): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.asset_outbox
         SET status = $3, updated_at = NOW()
       WHERE job_id = $1 AND asset_id = $2
      RETURNING *`,
    values: [jobId, assetId, status],
  };
}

/** Move every asset-outbox row of a job back to `pending` (new emit generation). */
export function resetAssetOutboxQuery(jobId: string): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.asset_outbox
         SET status = 'pending', updated_at = NOW()
       WHERE job_id = $1`,
    values: [jobId],
  };
}

/** Drop every asset-outbox row of a job; the re-driven stages re-stage them. */
export function deleteAssetOutboxQuery(jobId: string): Query {
  return {
    text: `DELETE FROM ${EXTRACT_SCHEMA}.asset_outbox WHERE job_id = $1`,
    values: [jobId],
  };
}

/** Outbox rows still awaiting acknowledgement, for the resume reconciliation. */
export function pendingEmitOutboxQuery(jobId: string): Query {
  return {
    text: `
      SELECT * FROM ${EXTRACT_SCHEMA}.emit_outbox
       WHERE job_id = $1 AND status <> 'acked'
       ORDER BY seq`,
    values: [jobId],
  };
}

/**
 * Every emit-outbox row for a job in seq order, whatever its status, WITH
 * payloads. Prefer {@link emitOutboxMetaQuery} + {@link emitOutboxRangeQuery}
 * on hot paths; this full read remains for small documents and diagnostics.
 */
export function allEmitOutboxQuery(jobId: string): Query {
  return {
    text: `
      SELECT * FROM ${EXTRACT_SCHEMA}.emit_outbox
       WHERE job_id = $1
       ORDER BY seq`,
    values: [jobId],
  };
}

/** Every asset-outbox row for a job, in a stable order (asset_id). */
export function allAssetOutboxQuery(jobId: string): Query {
  return {
    text: `
      SELECT * FROM ${EXTRACT_SCHEMA}.asset_outbox
       WHERE job_id = $1
       ORDER BY asset_id`,
    values: [jobId],
  };
}

// ─── uploads ─────────────────────────────────────────────────────────────

/** Open a resumable upload session. */
export function insertUploadQuery(row: {
  upload_id: string;
  reference: string;
  expected_sha256?: string | null;
  size?: number | null;
}): Query {
  return {
    text: `
      INSERT INTO ${EXTRACT_SCHEMA}.uploads (upload_id, reference, expected_sha256, size)
      VALUES ($1, $2, $3, $4)
      RETURNING *`,
    values: [row.upload_id, row.reference, row.expected_sha256 ?? null, row.size ?? null],
  };
}

/** Fetch an upload session (HEAD returns its confirmed offset). */
export function getUploadQuery(uploadId: string): Query {
  return {
    text: `SELECT * FROM ${EXTRACT_SCHEMA}.uploads WHERE upload_id = $1`,
    values: [uploadId],
  };
}

/** Advance the confirmed offset after a chunk is durably written. */
export function updateUploadOffsetQuery(uploadId: string, receivedOffset: number, status?: string): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.uploads
         SET received_offset = $2,
             status = COALESCE($3, status),
             updated_at = NOW()
       WHERE upload_id = $1
      RETURNING *`,
    values: [uploadId, receivedOffset, status ?? null],
  };
}

/**
 * Lock an upload session row for a chunk append (`SELECT … FOR UPDATE`).
 * Must run inside a transaction; concurrent appends on other replicas block
 * on the row until this one commits or rolls back.
 */
export function lockUploadForAppendQuery(uploadId: string): Query {
  return {
    text: `SELECT * FROM ${EXTRACT_SCHEMA}.uploads WHERE upload_id = $1 FOR UPDATE`,
    values: [uploadId],
  };
}

/**
 * Advance the confirmed offset only when it still equals `expectedOffset` and
 * the session is open (optimistic guard, used under the row lock).
 */
export function advanceUploadOffsetQuery(
  uploadId: string,
  expectedOffset: number,
  newOffset: number,
): Query {
  return {
    text: `
      UPDATE ${EXTRACT_SCHEMA}.uploads
         SET received_offset = $3,
             updated_at = NOW()
       WHERE upload_id = $1
         AND received_offset = $2
         AND status = 'open'
      RETURNING *`,
    values: [uploadId, expectedOffset, newOffset],
  };
}

// ─── key helpers ─────────────────────────────────────────────────────────

/** The natural-key shape of a stage row, discriminated by unit. */
export interface StageKey {
  job_id: string;
  page: number;
  stage: string;
  figure_id?: string;
  tile_id?: string;
}

function keyValues(unit: StageUnit, key: StageKey): unknown[] {
  switch (unit) {
    case "page":
      return [key.job_id, key.page, key.stage];
    case "figure":
      return [key.job_id, key.page, key.figure_id, key.stage];
    case "tile":
      return [key.job_id, key.page, key.tile_id, key.stage];
  }
}
