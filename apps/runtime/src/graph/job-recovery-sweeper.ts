// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Job recovery sweeper (`src/graph/job-recovery-sweeper.ts`)
 *
 * The half of the Durable Agent Runtime that turns an orphaned lease
 * (`JobStore.listOrphaned`, see `job-store.ts`'s module doc comment) into an
 * actual outcome: a bounded retry, or a clean, explicit failure. Without this,
 * a crashed async job's lease would simply expire and nothing would ever look
 * at it again — orphan detection alone is a diagnostic, not a recovery.
 *
 * On a fixed interval, {@link JobRecoverySweeper.tick} asks the job store for
 * every `running` job whose lease has passed, then for each one:
 *   - if it has attempts remaining (`attempt < maxAttempts`) AND a
 *     `resumePayload`, requeues it (`JobStore.requeueForRetry`) and hands it to
 *     the injected `retry` callback, which re-runs the flow from scratch and
 *     is responsible for calling `complete`/`fail` on the outcome — same
 *     division of responsibility `dispatchAsyncJob`'s own detached execution
 *     already has;
 *   - otherwise calls `JobStore.fail` directly with a stated reason, so the
 *     client's next poll sees a clean terminal state instead of a job that
 *     silently vanished from consideration.
 *
 * Mirrors `optimizer-scheduler.ts`'s shape deliberately (a `tick()` exposed
 * for tests/manual runs, `start()`/`stop()` wrapping a `setInterval`, an
 * overlap guard) — this codebase's established pattern for "a periodic
 * background pass over a store", not a new one invented for this feature.
 *
 * All dependencies are injected (job store, retry callback, clock), so the
 * tick logic is fully unit-testable without real timers or a real graph
 * engine.
 *
 * No `any` at module boundaries.
 */

import type { JobRecord, JobStore } from "./job-store.js";
import type { Logger } from "../observability/logger.js";

/** Monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

/**
 * Re-runs a job's flow from its `resumePayload` and settles the outcome
 * (`complete`/`fail` on the job store) — mirrors what `dispatchAsyncJob`'s own
 * detached execution does for a first attempt, but scoped to exactly what a
 * retry needs (no billing/canary/shadow-mode side effects; see the ADR for why
 * that is a deliberate, stated scope boundary). Never throws into the
 * sweeper — a retry failure is the callback's own job to record via
 * `jobStore.fail`.
 */
export type JobRetryRunner = (job: JobRecord) => Promise<void>;

export interface JobRecoverySweeperConfig {
  /** Tick interval in ms (how often orphans are swept). */
  intervalMs: number;
}

export interface JobRecoverySweeperDeps {
  jobStore: JobStore;
  retry: JobRetryRunner;
  logger?: Logger;
  clock?: Clock;
}

export interface SweepResult {
  retried: string[];
  failed: string[];
}

/**
 * Periodic sweep over a {@link JobStore} for orphaned (lease-expired,
 * `running`) jobs. Construct with a config + deps, then {@link start} on a
 * timer; {@link tick} runs one sweep pass (exposed for tests + a manual
 * "sweep now").
 */
export class JobRecoverySweeper {
  private readonly cfg: JobRecoverySweeperConfig;
  private readonly jobStore: JobStore;
  private readonly retry: JobRetryRunner;
  private readonly logger: Logger | undefined;
  private readonly clock: Clock;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping sweeps when one outlasts the interval. */
  private sweeping = false;

  constructor(cfg: JobRecoverySweeperConfig, deps: JobRecoverySweeperDeps) {
    this.cfg = cfg;
    this.jobStore = deps.jobStore;
    this.retry = deps.retry;
    this.logger = deps.logger;
    this.clock = deps.clock ?? Date.now;
  }

  /** True when the interval is positive. */
  get active(): boolean {
    return this.cfg.intervalMs > 0;
  }

  /**
   * Sweeps once: lists orphaned jobs and either requeues+retries or fails
   * each one. Returns what happened. Never throws — a per-job failure is
   * logged and does not abort the sweep of the remaining orphans.
   */
  async tick(): Promise<SweepResult> {
    const result: SweepResult = { retried: [], failed: [] };
    const now = this.clock();

    let orphans: JobRecord[];
    try {
      orphans = await this.jobStore.listOrphaned(now);
    } catch (err) {
      this.logger?.warn("Job recovery sweep: listOrphaned failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return result;
    }

    for (const job of orphans) {
      try {
        const canRetry =
          job.resumePayload !== undefined && job.attempt < job.maxAttempts;
        if (!canRetry) {
          await this.jobStore.fail(
            job.id,
            job.resumePayload === undefined
              ? "The executing replica stopped responding and this job cannot be retried " +
                  "(no resumable snapshot was recorded at submission)."
              : `The executing replica stopped responding, and the job had already used its ` +
                  `${job.attempt} of ${job.maxAttempts} allowed attempt(s).`,
          );
          result.failed.push(job.id);
          this.logger?.warn("Job recovery sweep: orphaned job failed (no attempts left)", {
            jobId: job.id,
            attempt: job.attempt,
            maxAttempts: job.maxAttempts,
          });
          continue;
        }
        const requeued = await this.jobStore.requeueForRetry(job.id);
        if (requeued === undefined) {
          // Raced with something else settling the job between listOrphaned
          // and here (e.g. a very-late heartbeat from the original executor,
          // or a concurrent sweeper tick on another replica) — not an error.
          continue;
        }
        this.logger?.info("Job recovery sweep: retrying orphaned job", {
          jobId: job.id,
          attempt: requeued.attempt,
          maxAttempts: requeued.maxAttempts,
        });
        result.retried.push(job.id);
        // Fire-and-forget: the retry runner owns settling the job (complete/
        // fail) and is responsible for its own error handling, exactly like
        // dispatchAsyncJob's own detached execution for a first attempt.
        void this.retry(requeued).catch((err) => {
          this.logger?.warn("Job recovery sweep: retry runner threw", {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (err) {
        this.logger?.warn("Job recovery sweep: failed to process an orphaned job", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Starts the periodic sweep. No-op when inactive. Returns true when a
   * timer was started.
   */
  start(): boolean {
    if (this.timer !== undefined) return true;
    if (!this.active) return false;
    this.timer = setInterval(() => {
      if (this.sweeping) return; // don't overlap a slow sweep
      this.sweeping = true;
      void this.tick()
        .catch((err) => {
          this.logger?.warn("Job recovery sweep tick failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.sweeping = false;
        });
    }, this.cfg.intervalMs);
    // Don't keep the event loop alive solely for the sweeper.
    (this.timer as unknown as { unref?: () => void }).unref?.();
    this.logger?.info("Job recovery sweeper started", {
      intervalMs: this.cfg.intervalMs,
    });
    return true;
  }

  /** Stops the periodic sweep, if running. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/** Builds a {@link JobRecoverySweeper}. */
export function createJobRecoverySweeper(
  cfg: JobRecoverySweeperConfig,
  deps: JobRecoverySweeperDeps,
): JobRecoverySweeper {
  return new JobRecoverySweeper(cfg, deps);
}
