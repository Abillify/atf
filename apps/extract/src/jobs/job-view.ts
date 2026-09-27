// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/job-view.ts
 *
 * The `JobRow` (snake_case DB shape) → `Job` (camelCase wire contract)
 * translation at the API boundary, plus the derived status fields the contract
 * asks for: per-stage progress, cost and an ETA (requirement 4.11).
 *
 * The DB layer is snake_case because it maps 1:1 onto the table; the contract
 * is camelCase because it is the shared wire type. Keeping the translation in
 * one place means the two vocabularies cannot drift and the API never leaks a
 * raw row (with its lease internals) to a client.
 */

import type { Job, StageProgress } from "@atf/extract-contract/v2";
import type { JobRow, PageStageRow, StageStatus } from "../persistence/types.js";

/** The per-page stages, in pipeline order (design §9b.2). */
export const PAGE_STAGES = [
  "analyzed",
  "vision1",
  "refined",
  "vision2",
  "tiled",
  "docpass",
  "emitted",
] as const;

/**
 * The terminal per-page stage — a page is fully processed once it reaches this
 * checkpoint. The ETA measures throughput and remaining work against it, so the
 * estimate is a straight "remaining pages × per-page time" (the same shape the
 * convert handler uses), independent of how many intermediate stages a page
 * happens to run.
 */
const CURSOR_STAGE = "emitted" as const;

/**
 * Fold a set of stage rows into per-stage progress counts. `total` is the job's
 * page count when known (so a stage with no rows yet reads 0/N rather than
 * 0/0), and `done`/`failed` are tallied from the rows.
 */
export function computeProgress(
  stages: readonly PageStageRow[],
  pageCount: number | null,
): StageProgress {
  const progress: StageProgress = {};
  const byStage = new Map<string, { done: number; failed: number; seen: number }>();
  for (const row of stages) {
    const bucket = byStage.get(row.stage) ?? { done: 0, failed: 0, seen: 0 };
    bucket.seen += 1;
    if (row.status === "done") bucket.done += 1;
    else if (row.status === "failed") bucket.failed += 1;
    byStage.set(row.stage, bucket);
  }
  for (const stage of PAGE_STAGES) {
    const bucket = byStage.get(stage);
    if (bucket === undefined && pageCount === null) continue;
    const total = pageCount ?? bucket?.seen ?? 0;
    progress[stage] = {
      done: bucket?.done ?? 0,
      total,
      failed: bucket?.failed ?? 0,
    };
  }
  return progress;
}

/**
 * Estimate the remaining seconds for a job (requirement 4.11, the
 * "Restzeitschätzung"). Returns null when there is not enough signal yet (no
 * measured stage throughput, no progress, or the job is not running).
 *
 * The heuristic mirrors the convert-handler's `remainingPages * pageMs`, but
 * derives `pageMs` from the actual measured throughput of the *completed* stage
 * work rather than a fixed per-page timing: elapsed processing time divided by
 * the units finished so far gives a per-unit cost, multiplied by the units
 * still outstanding. Measuring from when processing began (the earliest stage
 * checkpoint) rather than from `created_at` keeps queue-wait out of the rate,
 * so a job that sat queued for an hour does not report an hour of "remaining"
 * per its first page. It is a display hint, not an SLA.
 *
 * `processingStartMs` is the wall-clock at which the first stage checkpoint was
 * written (the caller derives it from the stage rows); when it is unknown the
 * estimate falls back to `created_at`, which is never later than processing.
 */
export function estimateEtaSeconds(
  row: JobRow,
  progress: StageProgress,
  now: number = Date.now(),
  processingStartMs?: number,
): number | null {
  if (row.status !== "processing" && row.status !== "emitting" && row.status !== "preparing") {
    return null;
  }
  // Measure against the cursor stage: pages that have reached `emitted` are
  // fully processed, so `remaining pages × per-page time` is the estimate — the
  // same shape the convert handler uses (`remainingPages * pageMs`). Falling
  // back to the furthest-along stage keeps an estimate before the cursor stage
  // has any rows (early in a run), so a job reads meaningfully throughout.
  const cursor = progress[CURSOR_STAGE];
  let done = cursor?.done ?? 0;
  let total = cursor?.total ?? 0;
  if (total <= 0 || done <= 0) {
    // No cursor throughput yet: use the furthest-along stage that has finished
    // some work, so the estimate is available during the first pass too.
    for (const stage of PAGE_STAGES) {
      const p = progress[stage];
      if (p !== undefined && p.total > 0 && p.done > done) {
        done = p.done;
        total = p.total;
      }
    }
  }
  if (total <= 0) return null;
  const remaining = total - done;
  if (remaining <= 0) return 0;
  if (done <= 0) return null; // no throughput measured yet

  const startMs = processingStartMs ?? new Date(row.created_at).getTime();
  const elapsedMs = now - startMs;
  if (elapsedMs <= 0) return null;
  const perUnitMs = elapsedMs / done;
  return Math.round((remaining * perUnitMs) / 1000);
}

/**
 * The wall-clock (ms) of the earliest stage checkpoint, an estimate of when
 * processing actually began. Returns null when there are no stage rows. Used to
 * measure throughput without counting the time a job sat queued.
 */
function earliestStageMs(stages: readonly PageStageRow[]): number | null {
  let earliest: number | null = null;
  for (const row of stages) {
    const t = new Date(row.created_at).getTime();
    if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
  }
  return earliest;
}

/**
 * Translate a job row (and optional stage rows) into the wire `Job`. When the
 * stage rows are omitted the progress/eta fields are left off, so a cheap
 * status read that does not join the stage tables is still valid.
 */
export function toJobView(
  row: JobRow,
  stages?: readonly PageStageRow[],
): Job {
  const progress =
    stages !== undefined ? computeProgress(stages, row.page_count) : undefined;
  const job: Job = {
    jobId: row.id,
    reference: row.reference,
    status: row.status,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
  if (row.pause_reason !== null) job.pauseReason = row.pause_reason;
  if (row.page_count !== null) job.pageCount = row.page_count;
  if (progress !== undefined) {
    job.progress = progress;
    // Measure the rate from when the first stage checkpoint appeared, so
    // queue-wait before processing does not inflate the estimate.
    const processingStartMs = earliestStageMs(stages ?? []);
    job.etaSeconds =
      processingStartMs !== null
        ? estimateEtaSeconds(row, progress, Date.now(), processingStartMs)
        : estimateEtaSeconds(row, progress);
  }
  if (row.tokens_used !== undefined) job.tokensUsed = Number(row.tokens_used);
  if (row.token_budget !== null) job.tokenBudget = Number(row.token_budget);
  if (row.cost_usd !== undefined) job.costUsd = Number(row.cost_usd);
  if (row.revision_id !== null) job.revisionId = row.revision_id;
  return job;
}

/** The stage statuses considered "failed" for retry-failed. */
export const FAILED_STATUS: StageStatus = "failed";
