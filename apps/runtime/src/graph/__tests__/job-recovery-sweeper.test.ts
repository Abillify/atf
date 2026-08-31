// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the Durable Agent Runtime's job recovery sweeper
 * (`src/graph/job-recovery-sweeper.ts`). Uses an in-memory `InMemoryJobStore`
 * with an injected clock, and a spyable retry callback, so the tick logic is
 * exercised without real timers or a real graph engine.
 */

import { describe, test, expect } from "bun:test";
import { InMemoryJobStore } from "../job-store.js";
import { createJobRecoverySweeper } from "../job-recovery-sweeper.js";
import type { JobRecord } from "../job-store.js";

describe("JobRecoverySweeper.tick", () => {
  test("retries an orphaned job with attempts remaining and a resumePayload", async () => {
    let now = 1_000_000;
    const jobStore = new InMemoryJobStore({ clock: () => now });
    jobStore.create({
      id: "j1",
      model: "flow-a",
      maxAttempts: 3,
      resumePayload: { flowId: "flow-a", messages: [] },
    });
    jobStore.markRunning("j1", 1_000);
    now += 5_000; // lease expired

    const retried: JobRecord[] = [];
    const sweeper = createJobRecoverySweeper(
      { intervalMs: 60_000 },
      {
        jobStore,
        retry: async (job) => {
          retried.push(job);
        },
        clock: () => now,
      },
    );

    const result = await sweeper.tick();
    expect(result.retried).toEqual(["j1"]);
    expect(result.failed).toHaveLength(0);
    // The retry callback receives the REQUEUED record (attempt incremented).
    expect(retried).toHaveLength(1);
    expect(retried[0]?.attempt).toBe(2);
    expect(retried[0]?.status).toBe("queued");
  });

  test("fails an orphaned job with no resumePayload (no attempt is possible)", async () => {
    let now = 1_000_000;
    const jobStore = new InMemoryJobStore({ clock: () => now });
    jobStore.create({ id: "j2", model: "flow-b" }); // no maxAttempts/resumePayload
    jobStore.markRunning("j2", 1_000);
    now += 5_000;

    const sweeper = createJobRecoverySweeper(
      { intervalMs: 60_000 },
      { jobStore, retry: async () => {}, clock: () => now },
    );

    const result = await sweeper.tick();
    expect(result.retried).toHaveLength(0);
    expect(result.failed).toEqual(["j2"]);
    const job = jobStore.get("j2");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("cannot be retried");
  });

  test("fails an orphaned job that has exhausted its attempts", async () => {
    let now = 1_000_000;
    const jobStore = new InMemoryJobStore({ clock: () => now });
    jobStore.create({
      id: "j3",
      model: "flow-c",
      maxAttempts: 1,
      resumePayload: { flowId: "flow-c", messages: [] },
    });
    jobStore.markRunning("j3", 1_000);
    now += 5_000;

    const sweeper = createJobRecoverySweeper(
      { intervalMs: 60_000 },
      { jobStore, retry: async () => {}, clock: () => now },
    );

    const result = await sweeper.tick();
    expect(result.failed).toEqual(["j3"]);
    const job = jobStore.get("j3");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("already used its");
  });

  test("does nothing when there are no orphaned jobs", async () => {
    const now = 1_000_000;
    const jobStore = new InMemoryJobStore({ clock: () => now });
    jobStore.create({
      id: "j4",
      model: "flow-d",
      maxAttempts: 3,
      resumePayload: { flowId: "flow-d", messages: [] },
    });
    jobStore.markRunning("j4", 60_000); // healthy lease, not expired
    const sweeper = createJobRecoverySweeper(
      { intervalMs: 60_000 },
      { jobStore, retry: async () => {}, clock: () => now },
    );
    const result = await sweeper.tick();
    expect(result.retried).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test("continues sweeping remaining orphans when the retry callback throws", async () => {
    let now = 1_000_000;
    const jobStore = new InMemoryJobStore({ clock: () => now });
    jobStore.create({
      id: "j5",
      model: "flow-e",
      maxAttempts: 3,
      resumePayload: { flowId: "flow-e", messages: [] },
    });
    jobStore.markRunning("j5", 1_000);
    jobStore.create({
      id: "j6",
      model: "flow-f",
      maxAttempts: 3,
      resumePayload: { flowId: "flow-f", messages: [] },
    });
    jobStore.markRunning("j6", 1_000);
    now += 5_000;

    const retried: string[] = [];
    const sweeper = createJobRecoverySweeper(
      { intervalMs: 60_000 },
      {
        jobStore,
        retry: async (job) => {
          retried.push(job.id);
          if (job.id === "j5") throw new Error("boom");
        },
        clock: () => now,
      },
    );

    const result = await sweeper.tick();
    // Both were requeued+handed to the retry callback (fire-and-forget) —
    // the sweeper's own tick() result does not depend on the retry outcome.
    expect(result.retried.sort()).toEqual(["j5", "j6"]);
    // Give the fire-and-forget rejection a turn to be caught internally.
    await new Promise((r) => setTimeout(r, 0));
    expect(retried.sort()).toEqual(["j5", "j6"]);
  });

  test("does not double-process a job that was already settled between listOrphaned and requeue", async () => {
    let now = 1_000_000;
    const jobStore = new InMemoryJobStore({ clock: () => now });
    jobStore.create({
      id: "j7",
      model: "flow-g",
      maxAttempts: 3,
      resumePayload: { flowId: "flow-g", messages: [] },
    });
    jobStore.markRunning("j7", 1_000);
    now += 5_000;

    // Simulate a race: the job settles (e.g. a very-late completion) right
    // before the sweeper's requeueForRetry call would run, by completing it
    // via a store method that wraps the real requeueForRetry.
    const realRequeue = jobStore.requeueForRetry.bind(jobStore);
    jobStore.requeueForRetry = (id: string) => {
      jobStore.complete(id, {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "flow-g",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      });
      return realRequeue(id); // now returns undefined — job is no longer "running"
    };

    const sweeper = createJobRecoverySweeper(
      { intervalMs: 60_000 },
      { jobStore, retry: async () => {}, clock: () => now },
    );
    const result = await sweeper.tick();
    expect(result.retried).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(jobStore.get("j7")?.status).toBe("completed");
  });

  test("listOrphaned failure is swallowed and produces an empty result", async () => {
    const jobStore = new InMemoryJobStore();
    jobStore.listOrphaned = () => {
      throw new Error("store unavailable");
    };
    const sweeper = createJobRecoverySweeper(
      { intervalMs: 60_000 },
      { jobStore, retry: async () => {} },
    );
    const result = await sweeper.tick();
    expect(result).toEqual({ retried: [], failed: [] });
  });
});

describe("JobRecoverySweeper.start/stop", () => {
  test("active is false when intervalMs is 0", () => {
    const jobStore = new InMemoryJobStore();
    const sweeper = createJobRecoverySweeper(
      { intervalMs: 0 },
      { jobStore, retry: async () => {} },
    );
    expect(sweeper.active).toBe(false);
    expect(sweeper.start()).toBe(false);
  });

  test("start returns true and is idempotent; stop clears the timer", () => {
    const jobStore = new InMemoryJobStore();
    const sweeper = createJobRecoverySweeper(
      { intervalMs: 60_000 },
      { jobStore, retry: async () => {} },
    );
    expect(sweeper.start()).toBe(true);
    expect(sweeper.start()).toBe(true); // idempotent
    sweeper.stop();
    sweeper.stop(); // idempotent
  });
});
