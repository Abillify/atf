// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/worker.ts
 *
 * The job worker loop.
 *
 * A worker polls the queue with `claimNextJob`, which does a `FOR UPDATE SKIP
 * LOCKED` claim and bumps the lease epoch — so many workers share one queue
 * without stepping on each other, and a job whose lease has expired (its worker
 * crashed) is taken over by whoever claims it next. The claim also picks up a
 * `paused(dependency)` job once its auto-resume backoff has elapsed
 * budget, manual and pin pauses wait for an operator.
 *
 * The claimed lease is fenced: every persistent write passes the lease token to
 * the store, which refuses it in SQL once the epoch moved on (a takeover, or an
 * operator's pause/cancel/resume, all of which bump the epoch). A heartbeat
 * ticks on an interval to keep the lease alive; when it reports a loss, the
 * worker aborts the run through an AbortSignal, so in-flight model calls are
 * cancelled and no new ones start.
 *
 * The loop drives the state machine — `queued → preparing → processing →
 * emitting → committing → completed` — and delegates the working span to an
 * injected {@link JobRunner}. A default no-op runner keeps the loop testable.
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { JobStatus } from "@atf/extract-contract/v2";
import type { ExtractStore } from "../persistence/index.js";
import type { JobRow } from "../persistence/types.js";
import { createLeaseGuard, LeaseLostError, type LeaseGuard } from "./lease.js";
import { assertTransition, isTerminal } from "./state-machine.js";
import {
  decideResume,
  type PipelineSnapshot,
  type ResumeDecision,
} from "./snapshot.js";
import { DEFAULT_BACKOFF, backoffMs, type BackoffPolicy } from "./stage-runner.js";

/** Tunables for the worker loop. */
export interface WorkerConfig {
  /** How long a claimed lease is valid before it can be taken over (seconds). */
  leaseSeconds: number;
  /** How often to renew the lease while working (ms). */
  heartbeatIntervalMs: number;
  /** How long to wait between empty polls of the queue (ms). */
  pollIntervalMs: number;
  /**
   * How many jobs this process claims and processes in parallel (Phase 11).
   * Default 1 — the historical one-job-per-process loop. Each lane holds its
   * own lease/heartbeat; the large-job lane cap is fleet-wide in the claim
   * query, so parallel lanes cannot over-subscribe it.
   */
  jobConcurrency?: number;
  /** The current pipeline/prompt stand, compared against each job's snapshot. */
  currentSnapshot: PipelineSnapshot;
  /**
   * Pages above which a job runs in the bounded large-job lane. Passed to
   * `claimNextJob` so the claim query lanes the job; a job with an unknown page
   * count is treated as normal until `preparing` sizes it.
   */
  largeJobPageThreshold: number;
  /**
   * The most large-lane jobs leased across the fleet at once. A worker at the
   * cap falls through to the next normal job rather than starving small jobs.
   */
  largeJobMaxConcurrency: number;
  /**
   * The backoff between automatic resumes of a `paused(dependency)` job whose
   * runner reported no retry instant of its own (e.g. Search unreachable).
   */
  dependencyBackoff?: BackoffPolicy;
  /** The wall clock; injectable for tests. */
  now?: () => Date;
}

/**
 * The stage-execution seam. It receives the claimed job and its lease (whose
 * `fence` every persistent write MUST carry), the resume decision so it knows
 * whether to reuse checkpoints, run the rest under a new stand, or recompute
 * from a stage, and an AbortSignal that fires when the lease is lost.
 */
export interface JobRunContext {
  job: JobRow;
  lease: LeaseGuard;
  resume: ResumeDecision;
  logger: Logger;
  /** Aborted when the heartbeat reports a lost lease; stop model calls. */
  signal?: AbortSignal;
  /**
   * The stand this run executes under — the job's own snapshot, or the current
   * deployment's under `continue`/`restart-stage`. Defaults to the job's.
   */
  stand?: PipelineSnapshot;
}

export type JobRunOutcome =
  | { status: "completed" }
  | {
      status: "paused";
      reason: "budget" | "dependency" | "manual";
      /** For a dependency pause: when the blocked unit becomes due again. */
      retryAt?: Date;
    }
  | { status: "failed"; error: string };

export interface JobRunner {
  /**
   * Drive the job's pipeline to a terminal-ish outcome. Implementations advance
   * the working states (`preparing → processing → emitting → committing`)
   * through fenced `store.setJobStatus` calls and return the final outcome.
   */
  run(ctx: JobRunContext): Promise<JobRunOutcome>;
}

/**
 * The default runner: a no-op that immediately reports completion. It exists so
 * the worker loop, lease, resume policy and transitions are all exercisable
 * without the staged pipeline.
 */
export function createNoopJobRunner(): JobRunner {
  return {
    async run(ctx) {
      // Prove the lease is still held; throws LeaseLostError when it is not.
      await ctx.lease.ensureHeld();
      return { status: "completed" };
    },
  };
}

export interface JobWorkerDeps {
  store: ExtractStore;
  runner: JobRunner;
  config: WorkerConfig;
  logger: Logger;
  /** A stable id for this worker instance; defaults to a random uuid. */
  workerId?: string;
}

/** A running worker; `stop()` ends the loop after the current job. */
export interface JobWorker {
  readonly workerId: string;
  start(): void;
  stop(): Promise<void>;
  /**
   * Claim and process at most one job. Returns true when a job was processed,
   * false when the queue was empty. Exposed for tests and for a single-shot
   * drain; the loop calls it repeatedly.
   */
  tick(): Promise<boolean>;
}

/** The config key counting consecutive dependency pauses (for the backoff). */
export const DEPENDENCY_ATTEMPTS_KEY = "dependencyAttempts";

/**
 * Persist a job status transition, validating it against the state machine
 * first so an illegal move (e.g. completing a cancelled job) throws rather than
 * corrupting the row. The write is fenced; a lost lease throws LeaseLostError.
 */
async function transition(
  store: ExtractStore,
  lease: LeaseGuard,
  from: JobStatus,
  to: JobStatus,
  pauseReason: JobRow["pause_reason"] = null,
): Promise<JobRow> {
  assertTransition(from, to);
  const row = await store.setJobStatus(lease.token.jobId, to, pauseReason, lease.fence);
  if (row === null) {
    throw new Error(`transition ${from} → ${to}: job ${lease.token.jobId} vanished`);
  }
  return row;
}

/** Longest failure cause kept as a job warning; the full error stays in the log. */
const FAILURE_WARNING_MAX = 500;

/** The warning a failed job carries, so its status read says why. */
function failureWarning(error: string): string {
  const text = `Job failed: ${error}`;
  return text.length > FAILURE_WARNING_MAX ? `${text.slice(0, FAILURE_WARNING_MAX - 1)}…` : text;
}

export function createJobWorker(deps: JobWorkerDeps): JobWorker {
  const { store, runner, config, logger } = deps;
  const workerId = deps.workerId ?? `extract-worker-${randomUUID()}`;
  const now = config.now ?? (() => new Date());
  const dependencyBackoff = config.dependencyBackoff ?? DEFAULT_BACKOFF;
  let running = false;
  let loopPromise: Promise<void> | null = null;
  let stopResolve: (() => void) | null = null;

  const snapshotOf = (job: JobRow): PipelineSnapshot => ({
    pipelineHash: job.pipeline_hash ?? "",
    promptHash: job.prompt_hash ?? "",
  });

  /** Restart-stage target, encoded on the config snapshot when set. */
  const restartStageOf = (job: JobRow): string | undefined => {
    const raw = (job.config as Record<string, unknown>).restartStage;
    return typeof raw === "string" && raw !== "" ? raw : undefined;
  };

  const dependencyAttemptsOf = (job: JobRow): number => {
    const raw = (job.config as Record<string, unknown>)[
      DEPENDENCY_ATTEMPTS_KEY
    ];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };

  /** Park the job; a dependency pause arms the automatic resume with backoff. */
  async function pause(
    lease: LeaseGuard,
    current: JobRow,
    reason: "budget" | "dependency" | "manual",
    retryAt: Date | undefined,
    autoResume: boolean,
  ): Promise<void> {
    assertTransition(current.status, "paused");
    if (reason === "dependency" && autoResume) {
      const attempts = dependencyAttemptsOf(current) + 1;
      const at =
        retryAt ??
        new Date(now().getTime() + backoffMs(attempts, dependencyBackoff));
      await store.pauseJob(
        current.id,
        "dependency",
        at,
        { [DEPENDENCY_ATTEMPTS_KEY]: attempts },
        lease.fence,
      );
      logger.info(
        { jobId: current.id, attempts, resumeAt: at },
        "Job paused on dependency; auto-resume armed",
      );
      return;
    }
    await store.pauseJob(current.id, reason, null, {}, lease.fence);
    logger.info(
      { jobId: current.id, reason },
      "Job paused; waiting for an operator",
    );
  }

  async function processJob(job: JobRow): Promise<void> {
    const lease = createLeaseGuard(
      store,
      { jobId: job.id, holder: workerId, epoch: Number(job.lease_epoch) },
      config.leaseSeconds,
    );

    // Resume policy: compare the frozen snapshot to the current stand.
    const restartStage = restartStageOf(job);
    const resume = decideResume({
      snapshot: snapshotOf(job),
      current: config.currentSnapshot,
      policy: job.resume_policy,
      ...(restartStage !== undefined ? { restartStage } : {}),
    });

    if (resume.action === "pause") {
      // `pin` policy and the stand changed: hold for an operator decision. No
      // auto-resume — mixing versions needs an explicit continue/restart-stage.
      logger.warn(
        { jobId: job.id, policy: job.resume_policy },
        "Pipeline/prompt stand changed; pausing per resume_policy=pin",
      );
      try {
        await pause(lease, job, resume.reason, undefined, false);
      } catch (err) {
        if (!(err instanceof LeaseLostError)) throw err;
        logger.warn(
          { jobId: job.id },
          "Lease lost before the pin pause could be recorded",
        );
      }
      return;
    }

    // The run is aborted the moment the lease is lost, so model calls stop.
    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      void lease.ensureHeld().catch((err: unknown) => {
        if (err instanceof LeaseLostError) {
          logger.warn(
            { jobId: job.id },
            "Lease lost during heartbeat; aborting the run",
          );
          abort.abort(err);
        } else {
          logger.error({ jobId: job.id, err }, "Heartbeat failed");
        }
      });
    }, config.heartbeatIntervalMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    try {
      // Enter the working span. A freshly claimed `queued` job transitions to
      // `preparing`; a taken-over job is already in a working state (its crashed
      // worker left it there), so we resume from wherever it was.
      const working =
        job.status === "queued"
          ? await transition(store, lease, "queued", "preparing")
          : job;

      const stand = resume.changed ? config.currentSnapshot : snapshotOf(job);
      const outcome = await runner.run({
        job: working,
        lease,
        resume,
        logger,
        signal: abort.signal,
        stand,
      });
      if (abort.signal.aborted) throw new LeaseLostError(lease.token);

      // Re-read the job to learn what state the runner left it in (it advances
      // through processing/emitting/committing itself).
      const current = (await store.getJob(job.id)) ?? working;
      if (isTerminal(current.status)) return; // runner already finalised it

      switch (outcome.status) {
        case "completed": {
          // The runner may have parked the job in any working state; walk it to
          // committing then completed if it is not already there.
          let cursor = current.status;
          if (cursor === "preparing")
            cursor = (await transition(store, lease, cursor, "processing"))
              .status;
          if (cursor === "processing")
            cursor = (await transition(store, lease, cursor, "emitting"))
              .status;
          if (cursor === "emitting")
            cursor = (await transition(store, lease, cursor, "committing"))
              .status;
          if (cursor === "committing")
            await transition(store, lease, cursor, "completed");
          if (dependencyAttemptsOf(current) > 0) {
            await store.patchJobConfig(
              job.id,
              { [DEPENDENCY_ATTEMPTS_KEY]: 0 },
              lease.fence,
            );
          }
          logger.info({ jobId: job.id }, "Job completed");
          break;
        }
        case "paused":
          await pause(lease, current, outcome.reason, outcome.retryAt, true);
          break;
        case "failed":
          // Record the cause on the job: the status read (and the console)
          // otherwise only shows "failed", with the reason in a log line.
          await store.appendJobWarning(
            job.id,
            failureWarning(outcome.error),
            lease.fence,
          );
          await transition(store, lease, current.status, "failed");
          logger.warn({ jobId: job.id, error: outcome.error }, "Job failed");
          break;
      }
    } catch (err) {
      if (err instanceof LeaseLostError || abort.signal.aborted) {
        // A takeover or an operator action happened mid-run. Do not touch the
        // job — the new holder (or the operator's status) owns it now; fencing
        // already refused our writes.
        logger.warn({ jobId: job.id }, "Abandoning job after lease loss");
        return;
      }
      // Any other error is a job-level failure. Try to record it, but a failed
      // fence here just means someone else owns the job.
      logger.error({ jobId: job.id, err }, "Job run threw; marking failed");
      try {
        const latest = (await store.getJob(job.id)) ?? job;
        if (!isTerminal(latest.status)) {
          await store.appendJobWarning(
            job.id,
            failureWarning(err instanceof Error ? err.message : String(err)),
            lease.fence,
          );
          await store.setJobStatus(job.id, "failed", null, lease.fence);
        }
      } catch (markErr) {
        logger.error(
          { jobId: job.id, err: markErr },
          "Could not mark job failed",
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function tick(): Promise<boolean> {
    const job = await store.claimNextJob(
      workerId,
      config.leaseSeconds,
      config.largeJobPageThreshold,
      config.largeJobMaxConcurrency,
    );
    if (job === null) return false;
    logger.debug(
      { jobId: job.id, status: job.status, epoch: job.lease_epoch },
      "Claimed job",
    );
    await processJob(job);
    return true;
  }

  /**
   * Parallel job lanes (Phase 11). With `jobConcurrency` 1 — the default —
   * this behaves exactly like the historical sequential loop: claim, process,
   * repeat. Above 1 the loop claims into every free lane so one long job no
   * longer idles the process; each lane holds its own lease/heartbeat and the
   * large-job lane cap is enforced fleet-wide by the claim query, so parallel
   * lanes cannot over-subscribe it.
   */
  const jobConcurrency = Math.max(1, config.jobConcurrency ?? 1);
  const lanes = new Set<Promise<void>>();

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === "function") timer.unref();
    });

  async function loop(): Promise<void> {
    while (running) {
      let claimed = false;
      if (lanes.size < jobConcurrency) {
        try {
          const job = await store.claimNextJob(
            workerId,
            config.leaseSeconds,
            config.largeJobPageThreshold,
            config.largeJobMaxConcurrency,
          );
          if (job !== null) {
            claimed = true;
            logger.debug(
              { jobId: job.id, status: job.status, epoch: job.lease_epoch },
              "Claimed job",
            );
            const lane: Promise<void> = processJob(job)
              .catch((err: unknown) => {
                logger.error({ jobId: job.id, err }, "Worker tick failed");
              })
              .finally(() => {
                lanes.delete(lane);
              });
            lanes.add(lane);
          }
        } catch (err) {
          logger.error({ err }, "Worker tick failed");
        }
      }
      if (!running) break;
      if (!claimed) {
        if (lanes.size === 0) {
          await sleep(config.pollIntervalMs);
        } else {
          // Lanes are busy: wake on the next lane finishing OR the poll
          // interval, so an empty queue is re-polled while work runs.
          await Promise.race([
            Promise.race([...lanes]),
            sleep(config.pollIntervalMs),
          ]);
        }
      }
    }
    // Drain: a claimed job finishes its lease transitions before the worker
    // reports stopped (the historical stop-after-current-job contract, per lane).
    await Promise.allSettled([...lanes]);
    stopResolve?.();
  }

  return {
    workerId,
    start() {
      if (running) return;
      running = true;
      loopPromise = loop();
    },
    async stop() {
      if (!running) return;
      running = false;
      await new Promise<void>((resolve) => {
        stopResolve = resolve;
      });
      await loopPromise;
      loopPromise = null;
    },
    tick,
  };
}
