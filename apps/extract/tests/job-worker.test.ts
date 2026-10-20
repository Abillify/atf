// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * job-worker.test.ts
 *
 * The worker loop, lease fencing and expired-lease takeover (task 1.5,
 * requirements 4.4, 4.5, 4.12). Driven against the in-memory fake store with a
 * controllable clock, so leases expire deterministically without sleeping.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFakeJobStore } from "./job-store-fake.js";
import { testLogger } from "./helpers.js";
import { createLeaseGuard, LeaseLostError } from "../src/jobs/lease.js";
import {
  createJobWorker,
  createNoopJobRunner,
  type JobRunner,
} from "../src/jobs/worker.js";
import type { PipelineSnapshot } from "../src/jobs/snapshot.js";

const SNAP: PipelineSnapshot = { pipelineHash: "p1", promptHash: "q1" };

function workerConfig(
  overrides: Partial<Parameters<typeof createJobWorker>[0]["config"]> = {},
): Parameters<typeof createJobWorker>[0]["config"] {
  return {
    leaseSeconds: 60,
    heartbeatIntervalMs: 100_000, // never fires during a synchronous tick
    pollIntervalMs: 5,
    currentSnapshot: SNAP,
    // Effectively no lane cap by default, so the pre-5.2 tests are unaffected;
    // the lane test below overrides these.
    largeJobPageThreshold: Number.MAX_SAFE_INTEGER,
    largeJobMaxConcurrency: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

async function seedJob(store: ReturnType<typeof createFakeJobStore>, overrides = {}) {
  const id = randomUUID();
  return store.createJob({
    id,
    reference: "tests/handbuch.pdf",
    source_sha256: "a".repeat(64),
    pipeline_hash: SNAP.pipelineHash,
    prompt_hash: SNAP.promptHash,
    ...overrides,
  });
}

describe("worker · lease fencing", () => {
  it("rejects a heartbeat with a stale epoch and accepts the current one", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const claimed = await store.claimNextJob("worker-1", 60);
    if (claimed === null) throw new Error("expected a claim");
    const epoch = Number(claimed.lease_epoch);

    const guardStale = createLeaseGuard(
      store,
      { jobId: job.id, holder: "worker-1", epoch: epoch - 1 },
      60,
    );
    await expect(guardStale.ensureHeld()).rejects.toBeInstanceOf(LeaseLostError);

    const guardFresh = createLeaseGuard(
      store,
      { jobId: job.id, holder: "worker-1", epoch },
      60,
    );
    await expect(guardFresh.ensureHeld()).resolves.toBeUndefined();
  });

  it("a zombie worker's guarded write is refused after takeover bumps the epoch", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const first = await store.claimNextJob("worker-A", 60);
    if (first === null) throw new Error("expected a claim");
    const firstEpoch = Number(first.lease_epoch);
    const zombieGuard = createLeaseGuard(
      store,
      { jobId: job.id, holder: "worker-A", epoch: firstEpoch },
      60,
    );

    // Lease expires; a second worker takes over, bumping the epoch.
    store.advance(61_000);
    const second = await store.claimNextJob("worker-B", 60);
    if (second === null) throw new Error("expected a takeover claim");
    expect(Number(second.lease_epoch)).toBe(firstEpoch + 1);

    // The original worker (now a zombie) cannot write.
    let wrote = false;
    await expect(
      zombieGuard.guard(async () => {
        wrote = true;
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(wrote).toBe(false);
  });
});

describe("worker · state machine over the queue", () => {
  it("claims a queued job and drives it to completed via the no-op runner", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const worker = createJobWorker({
      store,
      runner: createNoopJobRunner(),
      config: workerConfig(),
      logger: testLogger,
      workerId: "worker-1",
    });

    const processed = await worker.tick();
    expect(processed).toBe(true);
    expect(store.peek(job.id)?.status).toBe("completed");
  });

  it("returns false when the queue is empty", async () => {
    const store = createFakeJobStore();
    const worker = createJobWorker({
      store,
      runner: createNoopJobRunner(),
      config: workerConfig(),
      logger: testLogger,
    });
    expect(await worker.tick()).toBe(false);
  });

  it("marks a job failed when the runner reports failure", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const failing: JobRunner = {
      async run() {
        return { status: "failed", error: "permanent" };
      },
    };
    const worker = createJobWorker({
      store,
      runner: failing,
      config: workerConfig(),
      logger: testLogger,
    });
    await worker.tick();
    expect(store.peek(job.id)?.status).toBe("failed");
    // The cause is kept on the job, so a status read can show it.
    expect(store.peek(job.id)?.warnings).toContain("Job failed: permanent");
  });

  it("marks a job paused with the runner's reason", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const pausing: JobRunner = {
      async run() {
        return { status: "paused", reason: "budget" };
      },
    };
    const worker = createJobWorker({ store, runner: pausing, config: workerConfig(), logger: testLogger });
    await worker.tick();
    expect(store.peek(job.id)?.status).toBe("paused");
    expect(store.peek(job.id)?.pause_reason).toBe("budget");
  });

  it("throwing in the runner marks the job failed", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const throwing: JobRunner = {
      async run() {
        throw new Error("boom");
      },
    };
    const worker = createJobWorker({ store, runner: throwing, config: workerConfig(), logger: testLogger });
    await worker.tick();
    expect(store.peek(job.id)?.status).toBe("failed");
    expect(store.peek(job.id)?.warnings).toContain("Job failed: boom");
  });
});

describe("worker · expired-lease takeover", () => {
  it("takes over a job whose worker crashed mid-run", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);

    // Worker A claims and 'crashes' after moving into preparing, holding the lease.
    const a = await store.claimNextJob("worker-A", 60);
    if (a === null) throw new Error("expected a claim");
    await store.setJobStatus(job.id, "preparing");
    // (worker A never releases; simulate a crash by doing nothing further)

    // Lease expires.
    store.advance(61_000);

    // Worker B's loop takes it over and completes it.
    const workerB = createJobWorker({
      store,
      runner: createNoopJobRunner(),
      config: workerConfig(),
      logger: testLogger,
      workerId: "worker-B",
    });
    const processed = await workerB.tick();
    expect(processed).toBe(true);
    const final = store.peek(job.id);
    expect(final?.status).toBe("completed");
    expect(final?.lease_holder).toBe("worker-B");
    expect(Number(final?.lease_epoch)).toBeGreaterThan(Number(a.lease_epoch));
  });
});

describe("worker · resume_policy", () => {
  it("pauses (dependency) a pin job whose stand changed", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, { resume_policy: "pin" });
    const worker = createJobWorker({
      store,
      runner: createNoopJobRunner(),
      // Current stand differs from the job's frozen snapshot.
      config: workerConfig({ currentSnapshot: { pipelineHash: "p2", promptHash: "q1" } }),
      logger: testLogger,
    });
    await worker.tick();
    const final = store.peek(job.id);
    expect(final?.status).toBe("paused");
    expect(final?.pause_reason).toBe("dependency");
  });

  it("continues a `continue` job whose stand changed", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, { resume_policy: "continue" });
    const worker = createJobWorker({
      store,
      runner: createNoopJobRunner(),
      config: workerConfig({ currentSnapshot: { pipelineHash: "p2", promptHash: "q1" } }),
      logger: testLogger,
    });
    await worker.tick();
    expect(store.peek(job.id)?.status).toBe("completed");
  });
});

describe("queue lanes and fairness (requirement 6.6)", () => {
  it("caps the large-job lane and lets a normal job through past the cap", async () => {
    const store = createFakeJobStore();
    // Two large jobs (>1000 pages) with higher priority, one small job.
    const big1 = await seedJob(store, { priority: 10 });
    const big2 = await seedJob(store, { priority: 10 });
    const small = await seedJob(store, { priority: 1 });
    await store.setJobPageCount(big1.id, 5000);
    await store.setJobPageCount(big2.id, 5000);
    await store.setJobPageCount(small.id, 10);
    // setJobPageCount leaves status queued; all three are due.

    // Cap the large lane at 1.
    const first = await store.claimNextJob("w1", 60, 1000, 1);
    // Highest-priority runnable job is a large one; it takes the single slot.
    expect(first?.id === big1.id || first?.id === big2.id).toBe(true);
    // Mirror the worker: a claimed job moves into a working state, so it now
    // counts against the large-lane cap (and stops being a queued candidate).
    if (first) await store.setJobStatus(first.id, "preparing");

    // The lane is now full, so the next claim must skip the remaining large job
    // and hand out the small one — even though the large job is higher priority.
    const second = await store.claimNextJob("w2", 60, 1000, 1);
    expect(second?.id).toBe(small.id);
    if (second) await store.setJobStatus(second.id, "preparing");

    // Nothing normal left and the lane is full: no job is handed out rather than
    // exceeding the cap.
    const third = await store.claimNextJob("w3", 60, 1000, 1);
    expect(third).toBeNull();
  });

  it("treats an unsized (null page_count) job as normal-lane and claims it freely", async () => {
    const store = createFakeJobStore();
    // One large job holds the only large slot; a fresh unsized job must still be
    // claimable because its size is unknown (normal lane until prepare sizes it).
    const big = await seedJob(store, { priority: 10 });
    await store.setJobPageCount(big.id, 5000);
    const unsized = await seedJob(store, { priority: 1 }); // page_count stays null

    const first = await store.claimNextJob("w1", 60, 1000, 1);
    expect(first?.id).toBe(big.id);
    if (first) await store.setJobStatus(first.id, "preparing");

    const second = await store.claimNextJob("w2", 60, 1000, 1);
    expect(second?.id).toBe(unsized.id);
    expect(second?.page_count).toBeNull();
  });

  it("orders within a lane by priority then age (deterministic fairness)", async () => {
    const store = createFakeJobStore();
    // No lane cap in play (all small): higher priority wins; equal priority goes
    // to the older job.
    const low = await seedJob(store, { priority: 1 });
    store.advance(10);
    const highOld = await seedJob(store, { priority: 5 });
    store.advance(10);
    const highNew = await seedJob(store, { priority: 5 });

    const first = await store.claimNextJob("w1", 60, 1000, 5);
    expect(first?.id).toBe(highOld.id); // priority 5, oldest of the two
    if (first) await store.setJobStatus(first.id, "preparing");
    const second = await store.claimNextJob("w2", 60, 1000, 5);
    expect(second?.id).toBe(highNew.id); // priority 5, newer
    if (second) await store.setJobStatus(second.id, "preparing");
    const third = await store.claimNextJob("w3", 60, 1000, 5);
    expect(third?.id).toBe(low.id); // priority 1, last
  });

  it("a 1000-page job is normal-lane; 1001 pages is large (strict threshold)", async () => {
    const store = createFakeJobStore();
    const exactly1000 = await seedJob(store, { priority: 1 });
    const over1000 = await seedJob(store, { priority: 10 });
    await store.setJobPageCount(exactly1000.id, 1000);
    await store.setJobPageCount(over1000.id, 1001);

    // Lane cap 0-effect: set max concurrency to something, then occupy it with
    // the large job and confirm the 1000-page job is NOT laned (claimable).
    const first = await store.claimNextJob("w1", 60, 1000, 1);
    expect(first?.id).toBe(over1000.id); // large, higher priority, takes the slot
    if (first) await store.setJobStatus(first.id, "preparing");
    const second = await store.claimNextJob("w2", 60, 1000, 1);
    // The 1000-page job is normal (not > 1000), so it is claimable past the cap.
    expect(second?.id).toBe(exactly1000.id);
  });
});

// Phase 11 (Fix B): JOB_CONCURRENCY > 1 lets one process work several jobs at
// once — a single long job no longer idles the worker. Each lane holds its own
// claim; stop() drains every lane before reporting stopped.
describe("worker · parallel job lanes (Phase 11)", () => {
  it("runs two jobs concurrently when jobConcurrency is 2", async () => {
    const store = createFakeJobStore();
    const jobA = await seedJob(store);
    const jobB = await seedJob(store);

    // A runner that blocks until the test releases it, so both lanes are
    // observably in flight at the same time.
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking: JobRunner = {
      async run() {
        started += 1;
        await gate;
        return { status: "completed" };
      },
    };
    const worker = createJobWorker({
      store,
      runner: blocking,
      config: workerConfig({ jobConcurrency: 2 }),
      logger: testLogger,
      workerId: "worker-1",
    });

    worker.start();
    await vi.waitFor(() => {
      expect(started).toBe(2);
    });
    // Both jobs are claimed and in a working state simultaneously — with the
    // historical sequential loop, job B would still be queued here.
    expect(store.peek(jobA.id)?.status).toBe("preparing");
    expect(store.peek(jobB.id)?.status).toBe("preparing");

    release();
    await worker.stop();
    expect(store.peek(jobA.id)?.status).toBe("completed");
    expect(store.peek(jobB.id)?.status).toBe("completed");
  });

  it("keeps one job in flight and claims the next while it runs", async () => {
    const store = createFakeJobStore();
    await seedJob(store);
    await seedJob(store);

    const releases: Array<() => void> = [];
    const startedIds: string[] = [];
    const blocking: JobRunner = {
      async run(ctx) {
        startedIds.push(ctx.job.id);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return { status: "completed" };
      },
    };
    const worker = createJobWorker({
      store,
      runner: blocking,
      config: workerConfig({ jobConcurrency: 2 }),
      logger: testLogger,
      workerId: "worker-1",
    });

    worker.start();
    await vi.waitFor(() => {
      expect(startedIds.length).toBe(2);
    });
    // Release only the first-started job: the worker must finish it and keep
    // the second lane running (stop() drains it). Which of the two jobs the
    // loop claims first is not deterministic, so read it from the runner.
    const firstStarted = startedIds[0];
    const stillRunning = startedIds.find((id) => id !== firstStarted);
    if (firstStarted === undefined || stillRunning === undefined)
      throw new Error("expected both jobs to have started");
    releases[0]?.();
    await vi.waitFor(() => {
      expect(store.peek(firstStarted)?.status).toBe("completed");
    });
    expect(store.peek(stillRunning)?.status).toBe("preparing");
    releases[1]?.();
    await worker.stop();
    expect(store.peek(stillRunning)?.status).toBe("completed");
  });

  it("jobConcurrency 1 (default) stays strictly sequential", async () => {
    const store = createFakeJobStore();
    const jobA = await seedJob(store);
    const jobB = await seedJob(store);

    let inFlight = 0;
    let peak = 0;
    const blocking: JobRunner = {
      async run() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { status: "completed" };
      },
    };
    const worker = createJobWorker({
      store,
      runner: blocking,
      config: workerConfig(), // no jobConcurrency → 1
      logger: testLogger,
      workerId: "worker-1",
    });

    worker.start();
    await vi.waitFor(() => {
      expect(store.peek(jobA.id)?.status).toBe("completed");
      expect(store.peek(jobB.id)?.status).toBe("completed");
    });
    await worker.stop();
    expect(peak).toBe(1);
  });
});

describe("worker · operator actions and lease loss (req 4.5)", () => {
  it("a cancel during the run is never overwritten by the worker's completion", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const cancelling: JobRunner = {
      async run(ctx) {
        // The operator cancels while the runner works (epoch bump + holder cleared).
        await store.operatorTransition(ctx.job.id, {
          expectedStatus: ctx.job.status,
          status: "cancelled",
          pauseReason: null,
        });
        return { status: "completed" };
      },
    };
    const worker = createJobWorker({ store, runner: cancelling, config: workerConfig(), logger: testLogger });
    await worker.tick();
    expect(store.peek(job.id)?.status).toBe("cancelled");
    expect(store.peek(job.id)?.lease_holder).toBeNull();
  });

  it("a lost heartbeat aborts the run through its AbortSignal", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    let aborted = false;
    const waiting: JobRunner = {
      async run(ctx) {
        // An operator re-queues the job; the heartbeat notices and aborts.
        await store.requeueJob(ctx.job.id);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("never aborted")), 2_000);
          ctx.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted = true;
            resolve();
          });
        });
        return { status: "completed" };
      },
    };
    const worker = createJobWorker({
      store,
      runner: waiting,
      config: workerConfig({ heartbeatIntervalMs: 5 }),
      logger: testLogger,
    });
    await worker.tick();
    expect(aborted).toBe(true);
    // The worker abandoned the run; the operator's re-queue stands.
    expect(store.peek(job.id)?.status).toBe("queued");
  });

  it("hands the runner the current stand under continue", async () => {
    const store = createFakeJobStore();
    await seedJob(store, { resume_policy: "continue" });
    let seen: PipelineSnapshot | undefined;
    const runner: JobRunner = {
      async run(ctx) {
        seen = ctx.stand;
        return { status: "completed" };
      },
    };
    const current = { pipelineHash: "p2", promptHash: "q1" };
    const worker = createJobWorker({
      store,
      runner,
      config: workerConfig({ currentSnapshot: current }),
      logger: testLogger,
    });
    await worker.tick();
    expect(seen).toEqual(current);
  });
});

describe("worker · dependency pauses resume automatically (req 4.8)", () => {
  it("arms the auto-resume with a growing backoff and re-claims once due", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    let runs = 0;
    const flaky: JobRunner = {
      async run() {
        runs += 1;
        return runs <= 2 ? { status: "paused", reason: "dependency" } : { status: "completed" };
      },
    };
    const worker = createJobWorker({
      store,
      runner: flaky,
      config: workerConfig({ now: () => store.clock() }),
      logger: testLogger,
    });

    await worker.tick();
    const first = store.peek(job.id);
    expect(first?.status).toBe("paused");
    expect(first?.auto_resume).toBe(true);
    expect(first?.next_attempt_at.getTime()).toBe(store.clock().getTime() + 1_000);

    expect(await worker.tick()).toBe(false); // not yet due
    store.advance(1_000);
    expect(await worker.tick()).toBe(true);
    // Second consecutive dependency pause: the backoff doubled.
    expect(store.peek(job.id)?.next_attempt_at.getTime()).toBe(store.clock().getTime() + 2_000);

    store.advance(2_000);
    expect(await worker.tick()).toBe(true);
    expect(store.peek(job.id)?.status).toBe("completed");
    expect((store.peek(job.id)?.config as Record<string, unknown> | undefined)?.dependencyAttempts).toBe(0);
  });

  it("uses the runner's retry instant when it reports one", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const retryAt = new Date(store.clock().getTime() + 42_000);
    const runner: JobRunner = {
      async run() {
        return { status: "paused", reason: "dependency", retryAt };
      },
    };
    const worker = createJobWorker({ store, runner, config: workerConfig(), logger: testLogger });
    await worker.tick();
    expect(store.peek(job.id)?.next_attempt_at.getTime()).toBe(retryAt.getTime());
  });

  it("a pin pause and a budget pause wait for an operator", async () => {
    const store = createFakeJobStore();
    const pinned = await seedJob(store, { resume_policy: "pin" });
    const worker = createJobWorker({
      store,
      runner: createNoopJobRunner(),
      config: workerConfig({ currentSnapshot: { pipelineHash: "p2", promptHash: "q1" } }),
      logger: testLogger,
    });
    await worker.tick();
    expect(store.peek(pinned.id)?.status).toBe("paused");
    expect(store.peek(pinned.id)?.auto_resume).toBe(false);
    store.advance(3_600_000);
    expect(await worker.tick()).toBe(false);
  });
});

describe("store fencing · every worker write carries the epoch (req 4.5)", () => {
  it("rejects stage, outbox, docpass and job-row writes with a stale fence", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store);
    const first = await store.claimNextJob("worker-A", 60);
    if (first === null) throw new Error("expected a claim");
    const stale = { jobId: job.id, holder: "worker-A", epoch: Number(first.lease_epoch) };
    store.advance(61_000);
    await store.claimNextJob("worker-B", 60);

    const writes: Array<() => Promise<unknown>> = [
      () => store.setJobStatus(job.id, "failed", null, stale),
      () => store.patchJobConfig(job.id, { x: 1 }, stale),
      () => store.setJobRevision(job.id, "rev", stale),
      () => store.reserveJobTokens(job.id, 1, stale),
      () => store.upsertStage("page", { job_id: job.id, page: 1, stage: "vision1", input_hash: "h" }, stale),
      () => store.stageEmitBatch({ job_id: job.id, seq: 1, digest: "d", page_from: 1, page_to: 1 }, stale),
      () => store.setEmitStatus(job.id, 1, "acked", stale),
      () => store.stageAsset({ job_id: job.id, asset_id: "a" }, stale),
      () => store.saveDocpassState(job.id, 1, {}, stale),
      () => store.resetEmitGeneration(job.id, stale),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(LeaseLostError);
    }
    expect(store.peek(job.id)?.status).toBe("queued");
    expect(store.peekEmitBatches(job.id)).toEqual([]);
  });
});
