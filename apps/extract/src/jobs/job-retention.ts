// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * jobs/job-retention.ts
 *
 * What Extract keeps about a document besides the source bytes, and for how
 * long. A finished job still holds the persisted model response of every
 * page (`page_stages.output`), the emit/asset outboxes and, for an abandoned
 * resumable upload, a session row. None of that is needed once the job is done,
 * and all of it can contain the document's content, so it must not live
 * forever (GDPR Art. 5(1)(e)).
 *
 *  - {@link sweepRetention} deletes TERMINAL jobs idle for `JOB_RETENTION_DAYS`
 *    (checkpoints and outboxes cascade) and unfinished upload sessions idle for
 *    `UPLOAD_SESSION_MAX_AGE_HOURS`, together with their `<id>.part` files.
 *    A running or paused job is never swept.
 *  - The SOURCE bytes and the derived-PDF cache are deliberately not part of
 *    this sweep: `/v2/render` renders zoom and tile images from the stored
 *    source on demand for as long as Search still serves the document, so a
 *    time rule would break those images. Sources leave with
 *    `DELETE /v2/documents/{reference}` or an erasure request (which use
 *    {@link orphanedSourceDigests}); the derived PDFs have their own limits.
 *  - {@link startRetentionSweeper} runs the sweep once at start and then on an
 *    interval, never overlapping itself and never throwing.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ExtractStore } from "../persistence/extract-store.js";
import type { ErasureJobTargetRow } from "../persistence/types.js";

/** Rows deleted per statement; a sweep keeps going while a statement comes back full. */
const BATCH = 500;
/** Statements per sweep, so one sweep cannot monopolise the database. */
const MAX_BATCHES = 20;

/** Remove the `<uploadId>.part` scratch files of upload sessions that no longer exist. */
export async function removeSessionFiles(
  tmpDir: string | undefined,
  uploadIds: string[],
  logger: Logger,
): Promise<void> {
  if (tmpDir === undefined || uploadIds.length === 0) return;
  for (const uploadId of uploadIds) {
    // Upload ids are server-generated UUIDs; still refuse path separators.
    if (!/^[0-9a-fA-F-]+$/.test(uploadId)) continue;
    await rm(join(tmpDir, `${uploadId}.part`), { force: true }).catch((err: unknown) => {
      logger.warn({ err, uploadId }, "could not remove an upload session file");
    });
  }
}

/**
 * The source digests of the removed jobs that NO remaining job row references
 * any more — the blobs that became orphans. A digest another job (another
 * reference or collection on the same bytes) still uses stays.
 */
export async function orphanedSourceDigests(
  store: Pick<ExtractStore, "remainingSourceRefs">,
  removed: readonly ErasureJobTargetRow[],
): Promise<string[]> {
  const digests = [...new Set(removed.map((job) => job.source_sha256).filter((d) => d !== ""))];
  if (digests.length === 0) return [];
  const remaining = await store.remainingSourceRefs(digests);
  const stillReferenced = new Set(remaining.filter((r) => r.n > 0).map((r) => r.source_sha256));
  return digests.filter((digest) => !stillReferenced.has(digest));
}

export interface RetentionConfig {
  /** Days a terminal job is kept after its last change. 0 = keep forever. */
  jobRetentionDays: number;
  /** Hours an unfinished upload session is kept after its last change. 0 = keep forever. */
  uploadMaxAgeHours: number;
}

export interface RetentionDeps extends RetentionConfig {
  store: Pick<ExtractStore, "deleteExpiredJobs" | "deleteExpiredUploads">;
  logger: Logger;
  /** Directory of resumable-upload session files (`<uploadId>.part`). */
  tmpDir?: string;
}

export interface RetentionSweepResult {
  jobs: number;
  uploads: number;
}

/** One retention pass. Throws only what the store throws; callers decide how to react. */
export async function sweepRetention(deps: RetentionDeps): Promise<RetentionSweepResult> {
  const { store, logger } = deps;
  let jobs = 0;
  let uploads = 0;
  if (deps.jobRetentionDays > 0) {
    for (let i = 0; i < MAX_BATCHES; i += 1) {
      const removed = await store.deleteExpiredJobs(deps.jobRetentionDays, BATCH);
      jobs += removed.length;
      if (removed.length < BATCH) break;
    }
  }
  if (deps.uploadMaxAgeHours > 0) {
    for (let i = 0; i < MAX_BATCHES; i += 1) {
      const removed = await store.deleteExpiredUploads(deps.uploadMaxAgeHours, BATCH);
      uploads += removed.length;
      await removeSessionFiles(deps.tmpDir, removed, logger);
      if (removed.length < BATCH) break;
    }
  }
  if (jobs > 0 || uploads > 0) {
    logger.info(
      { jobs, uploads, jobRetentionDays: deps.jobRetentionDays, uploadMaxAgeHours: deps.uploadMaxAgeHours },
      "Retention sweep removed expired job data",
    );
  }
  return { jobs, uploads };
}

export interface RetentionSweeper {
  /** Run one pass now (no-op while another is running). */
  sweepNow(): Promise<RetentionSweepResult | null>;
  stop(): void;
}

/**
 * Sweep at start and every `intervalMs`. Does nothing (and starts no timer)
 * when both rules are off. A failed pass is logged and retried at the next tick.
 */
export function startRetentionSweeper(
  deps: RetentionDeps & { intervalMs: number },
): RetentionSweeper {
  let running = false;
  const sweepNow = async (): Promise<RetentionSweepResult | null> => {
    if (running) return null;
    running = true;
    try {
      return await sweepRetention(deps);
    } catch (err) {
      deps.logger.warn({ err }, "Retention sweep failed; it is retried at the next interval");
      return null;
    } finally {
      running = false;
    }
  };
  if (deps.jobRetentionDays <= 0 && deps.uploadMaxAgeHours <= 0) {
    return { sweepNow, stop() {} };
  }
  void sweepNow();
  const timer = setInterval(() => void sweepNow(), Math.max(60_000, deps.intervalMs));
  timer.unref();
  return {
    sweepNow,
    stop() {
      clearInterval(timer);
    },
  };
}
