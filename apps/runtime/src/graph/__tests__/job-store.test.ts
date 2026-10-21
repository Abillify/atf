// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the in-memory async job store: lifecycle transitions, TTL expiry
 * and LRU bounding, with an injected clock.
 */

import { describe, test, expect } from "bun:test";
import {
  createProgressWriteThrottle,
  InMemoryJobStore,
  type JobProgress,
} from "../job-store.js";
import type { ChatCompletionResponse } from "../../types/openai.js";

const resp = (text: string): ChatCompletionResponse => ({
  id: "chatcmpl-x",
  object: "chat.completion",
  created: 0,
  model: "flow-x",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    },
  ],
});

describe("InMemoryJobStore", () => {
  test("create → running → complete lifecycle", () => {
    const s = new InMemoryJobStore();
    const j = s.create({ id: "j1", model: "flow-x", owner: "tenant-a" });
    expect(j.status).toBe("queued");
    s.markRunning("j1");
    const running = s.get("j1");
    if (running === undefined) throw new Error("expected job j1");
    expect(running.status).toBe("running");
    s.complete("j1", resp("hello"));
    const done = s.get("j1");
    if (done === undefined) throw new Error("expected job j1");
    expect(done.status).toBe("completed");
    if (done.result === undefined) throw new Error("expected a result");
    const choice = done.result.choices[0];
    if (choice === undefined) throw new Error("expected a choice");
    expect(choice.message.content).toBe("hello");
  });

  test("fail records the error", () => {
    const s = new InMemoryJobStore();
    s.create({ id: "j2", model: "flow-x" });
    s.fail("j2", "boom");
    const j = s.get("j2");
    if (j === undefined) throw new Error("expected job j2");
    expect(j.status).toBe("failed");
    expect(j.error).toBe("boom");
  });

  test("expires entries past the TTL", () => {
    let now = 1_000_000;
    const s = new InMemoryJobStore({ ttlSeconds: 10, clock: () => now });
    s.create({ id: "j3", model: "flow-x" });
    expect(s.get("j3")).toBeDefined();
    now += 11_000;
    expect(s.get("j3")).toBeUndefined();
  });

  test("evicts oldest beyond maxEntries", () => {
    const s = new InMemoryJobStore({ maxEntries: 2 });
    s.create({ id: "a", model: "f" });
    s.create({ id: "b", model: "f" });
    s.create({ id: "c", model: "f" }); // triggers prune → "a" evicted
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeDefined();
    expect(s.get("c")).toBeDefined();
  });

  test("get of an unknown id returns undefined", () => {
    expect(new InMemoryJobStore().get("nope")).toBeUndefined();
  });

  test("create defaults attempt=1 and maxAttempts=1 when omitted", () => {
    const s = new InMemoryJobStore();
    const j = s.create({ id: "j4", model: "flow-x" });
    expect(j.attempt).toBe(1);
    expect(j.maxAttempts).toBe(1);
    expect(j.resumePayload).toBeUndefined();
  });

  test("create records a resumePayload and maxAttempts when given", () => {
    const s = new InMemoryJobStore();
    const j = s.create({
      id: "j5",
      model: "flow-x",
      maxAttempts: 3,
      resumePayload: { flowId: "flow-x", messages: [] },
    });
    expect(j.maxAttempts).toBe(3);
    expect(j.resumePayload).toEqual({ flowId: "flow-x", messages: [] });
  });

  describe("lease / heartbeat / orphan detection", () => {
    test("markRunning with leaseMs sets leaseExpiresAt in the future", () => {
      const now = 1_000_000;
      const s = new InMemoryJobStore({ clock: () => now });
      s.create({ id: "j6", model: "flow-x" });
      s.markRunning("j6", 5_000);
      const j = s.get("j6");
      if (j === undefined) throw new Error("expected job j6");
      expect(j.status).toBe("running");
      expect(new Date(j.leaseExpiresAt ?? "").getTime()).toBe(now + 5_000);
    });

    test("markRunning without leaseMs leaves the job leaseless (opts out of orphan detection)", () => {
      const s = new InMemoryJobStore();
      s.create({ id: "j7", model: "flow-x" });
      s.markRunning("j7");
      const j = s.get("j7");
      if (j === undefined) throw new Error("expected job j7");
      expect(j.leaseExpiresAt).toBeUndefined();
      expect(s.listOrphaned(Date.now() + 10_000_000)).toHaveLength(0);
    });

    test("heartbeat renews the lease and returns true for a running job", () => {
      let now = 1_000_000;
      const s = new InMemoryJobStore({ clock: () => now });
      s.create({ id: "j8", model: "flow-x" });
      s.markRunning("j8", 5_000);
      now += 2_000;
      expect(s.heartbeat("j8", 5_000)).toBe(true);
      const j = s.get("j8");
      if (j === undefined) throw new Error("expected job j8");
      expect(new Date(j.leaseExpiresAt ?? "").getTime()).toBe(now + 5_000);
    });

    test("heartbeat returns false for an unknown job", () => {
      const s = new InMemoryJobStore();
      expect(s.heartbeat("nope", 5_000)).toBe(false);
    });

    test("heartbeat returns false for a job that is not running (does not resurrect a settled job)", () => {
      const s = new InMemoryJobStore();
      s.create({ id: "j9", model: "flow-x" });
      expect(s.heartbeat("j9", 5_000)).toBe(false); // still "queued"
    });

    test("listOrphaned finds a running job whose lease has passed", () => {
      let now = 1_000_000;
      const s = new InMemoryJobStore({ clock: () => now });
      s.create({ id: "j10", model: "flow-x" });
      s.markRunning("j10", 1_000);
      now += 5_000; // lease expired 4s ago
      const orphans = s.listOrphaned(now);
      expect(orphans.map((o) => o.id)).toEqual(["j10"]);
    });

    test("listOrphaned excludes a running job whose lease has NOT passed", () => {
      const now = 1_000_000;
      const s = new InMemoryJobStore({ clock: () => now });
      s.create({ id: "j11", model: "flow-x" });
      s.markRunning("j11", 60_000);
      expect(s.listOrphaned(now)).toHaveLength(0);
    });

    test("listOrphaned excludes a terminal job even past its old lease time", () => {
      let now = 1_000_000;
      const s = new InMemoryJobStore({ clock: () => now });
      s.create({ id: "j12", model: "flow-x" });
      s.markRunning("j12", 1_000);
      s.complete("j12", resp("done"));
      now += 5_000;
      expect(s.listOrphaned(now)).toHaveLength(0);
    });
  });

  describe("requeueForRetry", () => {
    test("requeues a job with a resumePayload and attempts remaining", () => {
      const s = new InMemoryJobStore();
      s.create({
        id: "j13",
        model: "flow-x",
        maxAttempts: 3,
        resumePayload: { flowId: "flow-x", messages: [] },
      });
      s.markRunning("j13", 1_000);
      const requeued = s.requeueForRetry("j13");
      expect(requeued?.attempt).toBe(2);
      expect(requeued?.status).toBe("queued");
      expect(requeued?.leaseExpiresAt).toBeUndefined();
    });

    test("returns undefined when the job has no resumePayload", () => {
      const s = new InMemoryJobStore();
      s.create({ id: "j14", model: "flow-x", maxAttempts: 3 });
      s.markRunning("j14", 1_000);
      expect(s.requeueForRetry("j14")).toBeUndefined();
    });

    test("returns undefined when attempts are already exhausted", () => {
      const s = new InMemoryJobStore();
      s.create({
        id: "j15",
        model: "flow-x",
        maxAttempts: 1,
        resumePayload: { flowId: "flow-x", messages: [] },
      });
      s.markRunning("j15", 1_000);
      expect(s.requeueForRetry("j15")).toBeUndefined();
    });

    test("returns undefined for an unknown job", () => {
      const s = new InMemoryJobStore();
      expect(s.requeueForRetry("nope")).toBeUndefined();
    });
  });
});

describe("setProgress", () => {
  const snapshot = (done: number): JobProgress => ({
    phase: "research",
    tasksDone: done,
    tasksTotal: 4,
    elapsedMs: done * 100,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  test("stores the progress snapshot and it is readable via get", () => {
    const s = new InMemoryJobStore();
    s.create({ id: "jp1", model: "flow-x" });
    s.setProgress("jp1", snapshot(1));
    expect(s.get("jp1")?.progress?.tasksDone).toBe(1);
  });

  test("last write wins", () => {
    const s = new InMemoryJobStore();
    s.create({ id: "jp2", model: "flow-x" });
    s.setProgress("jp2", snapshot(1));
    s.setProgress("jp2", snapshot(3));
    expect(s.get("jp2")?.progress?.tasksDone).toBe(3);
  });

  test("progress is absent until the first write", () => {
    const s = new InMemoryJobStore();
    s.create({ id: "jp3", model: "flow-x" });
    expect(s.get("jp3")?.progress).toBeUndefined();
  });

  test("is a no-op for an unknown job", () => {
    const s = new InMemoryJobStore();
    s.setProgress("nope", snapshot(1));
    expect(s.get("nope")).toBeUndefined();
  });
});

describe("createProgressWriteThrottle", () => {
  test("two submits within the interval produce a single write", async () => {
    let now = 1_000;
    const writes: number[] = [];
    const t = createProgressWriteThrottle({
      intervalMs: 2_000,
      now: () => now,
      write: () => {
        writes.push(now);
      },
    });
    t.submit({ phase: "research", tasksDone: 1, tasksTotal: 4, elapsedMs: 10 });
    now += 500;
    t.submit({ phase: "research", tasksDone: 2, tasksTotal: 4, elapsedMs: 510 });
    // Let the scheduled write run; the second submit must still be suppressed.
    await Promise.resolve();
    expect(writes).toEqual([1_000]);
    await t.flush();
    expect(writes).toEqual([1_000, 1_500]);
  });

  test("a submit after the interval writes again", async () => {
    let now = 0;
    const writes: number[] = [];
    const t = createProgressWriteThrottle({
      intervalMs: 2_000,
      now: () => now,
      write: () => {
        writes.push(now);
      },
    });
    t.submit({ phase: "research", tasksDone: 1, tasksTotal: 4, elapsedMs: 0 });
    now = 2_000;
    t.submit({ phase: "research", tasksDone: 2, tasksTotal: 4, elapsedMs: 2_000 });
    await t.flush();
    expect(writes).toEqual([0, 2_000]);
  });

  test("flush persists the pending value exactly once (last value wins)", async () => {
    let now = 0;
    const done: number[] = [];
    const t = createProgressWriteThrottle({
      intervalMs: 2_000,
      now: () => now,
      write: (p) => {
        done.push(p.tasksDone);
      },
    });
    t.submit({ phase: "research", tasksDone: 1, tasksTotal: 4, elapsedMs: 0 });
    now = 500;
    t.submit({ phase: "research", tasksDone: 2, tasksTotal: 4, elapsedMs: 500 });
    now = 900;
    t.submit({ phase: "research", tasksDone: 3, tasksTotal: 4, elapsedMs: 900 });
    await t.flush();
    expect(done).toEqual([1, 3]);
    await t.flush();
    expect(done).toEqual([1, 3]);
  });

  test("a failing write is swallowed and later writes still happen", async () => {
    let now = 0;
    let calls = 0;
    const t = createProgressWriteThrottle({
      intervalMs: 1_000,
      now: () => now,
      write: () => {
        calls += 1;
        if (calls === 1) throw new Error("store down");
      },
    });
    t.submit({ phase: "research", tasksDone: 1, tasksTotal: 2, elapsedMs: 0 });
    now = 1_000;
    t.submit({ phase: "research", tasksDone: 2, tasksTotal: 2, elapsedMs: 1_000 });
    await t.flush();
    expect(calls).toBe(2);
  });
});
