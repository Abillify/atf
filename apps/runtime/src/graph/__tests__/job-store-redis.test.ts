// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the cluster-wide Redis-backed job store. Uses an in-memory fake
 * RedisClient (honouring SET EX / SET KEEPTTL / GET) so the lifecycle and
 * cross-replica visibility are verified without a real Redis.
 */

import { describe, expect, it } from "bun:test";
import { RedisJobStore, type JobRedisClient } from "../job-store.js";
import type { ChatCompletionResponse } from "../../types/openai.js";

/**
 * Minimal in-memory Redis fake supporting SET (EX|KEEPTTL), GET, and a sorted
 * set (ZADD/ZRANGEBYSCORE/ZREM) sufficient for the running-jobs lease index.
 */
class FakeRedis implements JobRedisClient {
  readonly store = new Map<string, { value: string; ttl?: number }>();
  /** key -> member -> score, for the sorted-set commands. */
  readonly zsets = new Map<string, Map<string, number>>();

  async send(command: string, args: string[]): Promise<unknown> {
    const cmd = command.toUpperCase();
    if (cmd === "SET") {
      const [key, value, ...rest] = args;
      if (key === undefined || value === undefined) {
        throw new Error("SET requires a key and a value");
      }
      const flag = rest[0]?.toUpperCase();
      if (flag === "EX") {
        this.store.set(key, { value, ttl: Number(rest[1]) });
      } else if (flag === "KEEPTTL") {
        const existing = this.store.get(key);
        this.store.set(key, {
          value,
          ...(existing?.ttl !== undefined ? { ttl: existing.ttl } : {}),
        });
      } else {
        this.store.set(key, { value });
      }
      return "OK";
    }
    if (cmd === "GET") {
      const key = args[0];
      if (key === undefined) throw new Error("GET requires a key");
      return this.store.get(key)?.value ?? null;
    }
    if (cmd === "ZADD") {
      const [key, score, member] = args;
      if (key === undefined || score === undefined || member === undefined) {
        throw new Error("ZADD requires key, score, member");
      }
      const set = this.zsets.get(key) ?? new Map<string, number>();
      set.set(member, Number(score));
      this.zsets.set(key, set);
      return 1;
    }
    if (cmd === "ZRANGEBYSCORE") {
      const [key, min, max] = args;
      if (key === undefined || min === undefined || max === undefined) {
        throw new Error("ZRANGEBYSCORE requires key, min, max");
      }
      const set = this.zsets.get(key) ?? new Map<string, number>();
      const lo = min === "-inf" ? -Infinity : Number(min);
      const hi = max === "+inf" ? Infinity : Number(max);
      return [...set.entries()]
        .filter(([, score]) => score >= lo && score <= hi)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    }
    if (cmd === "ZREM") {
      const [key, member] = args;
      if (key === undefined || member === undefined) {
        throw new Error("ZREM requires key, member");
      }
      const set = this.zsets.get(key);
      return set?.delete(member) === true ? 1 : 0;
    }
    throw new Error(`unsupported: ${command}`);
  }
}

const sampleResult: ChatCompletionResponse = {
  id: "chatcmpl-x",
  object: "chat.completion",
  created: 1,
  model: "f",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi" },
      finish_reason: "stop",
    },
  ],
};

describe("RedisJobStore", () => {
  it("creates, runs and completes a job, preserving the original TTL", async () => {
    const redis = new FakeRedis();
    const store = new RedisJobStore(redis, undefined, { ttlSeconds: 100 });

    await store.create({ id: "job-1", model: "flow-a", owner: "tenant-x" });
    const created = await store.get("job-1");
    expect(created?.status).toBe("queued");
    expect(created?.owner).toBe("tenant-x");
    expect(redis.store.get("aiperator:job:job-1")?.ttl).toBe(100);

    await store.markRunning("job-1");
    expect((await store.get("job-1"))?.status).toBe("running");

    await store.complete("job-1", sampleResult);
    const done = await store.get("job-1");
    expect(done?.status).toBe("completed");
    expect(done?.result?.id).toBe("chatcmpl-x");
    // TTL preserved across the read-modify-write updates.
    expect(redis.store.get("aiperator:job:job-1")?.ttl).toBe(100);
  });

  it("records a failure", async () => {
    const redis = new FakeRedis();
    const store = new RedisJobStore(redis);
    await store.create({ id: "job-2", model: "flow-b" });
    await store.fail("job-2", "boom");
    const rec = await store.get("job-2");
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toBe("boom");
  });

  it("is no-op on lifecycle updates to an unknown job", async () => {
    const redis = new FakeRedis();
    const store = new RedisJobStore(redis);
    await store.markRunning("nope");
    await store.complete("nope", sampleResult);
    await store.fail("nope", "x");
    expect(await store.get("nope")).toBeUndefined();
  });

  it("is visible across replicas sharing the same store", async () => {
    const redis = new FakeRedis(); // shared backing store
    const replicaA = new RedisJobStore(redis);
    const replicaB = new RedisJobStore(redis);

    await replicaA.create({ id: "job-3", model: "flow-c" });
    await replicaA.complete("job-3", sampleResult);

    // A different replica can read the result — no sticky session needed.
    const fromB = await replicaB.get("job-3");
    expect(fromB?.status).toBe("completed");
  });

  it("fails soft (returns undefined) when GET errors", async () => {
    const broken: JobRedisClient = {
      async send(cmd: string): Promise<unknown> {
        if (cmd.toUpperCase() === "GET") throw new Error("down");
        return "OK";
      },
    };
    const store = new RedisJobStore(broken);
    expect(await store.get("whatever")).toBeUndefined();
  });

  describe("lease / heartbeat / orphan detection (running-jobs index)", () => {
    it("markRunning with a leaseMs registers the job in the running index", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-4", model: "flow-d" });
      await store.markRunning("job-4", 5_000);
      const rec = await store.get("job-4");
      expect(rec?.status).toBe("running");
      expect(rec?.leaseExpiresAt).toBeDefined();
      expect(redis.zsets.get("aiperator:jobs:running")?.has("job-4")).toBe(true);
    });

    it("markRunning WITHOUT a leaseMs does not register the job (opts out)", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-5", model: "flow-e" });
      await store.markRunning("job-5");
      expect(redis.zsets.get("aiperator:jobs:running")?.has("job-5")).toBeFalsy();
    });

    it("heartbeat renews the lease and returns true for a running job", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-6", model: "flow-f" });
      await store.markRunning("job-6", 1_000);
      const before = redis.zsets.get("aiperator:jobs:running")?.get("job-6");
      const renewed = await store.heartbeat("job-6", 60_000);
      expect(renewed).toBe(true);
      const after = redis.zsets.get("aiperator:jobs:running")?.get("job-6");
      expect(after).toBeGreaterThan(before ?? 0);
    });

    it("heartbeat returns false for an unknown job", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      expect(await store.heartbeat("nope", 5_000)).toBe(false);
    });

    it("heartbeat returns false for a job that is not running", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-7", model: "flow-g" });
      expect(await store.heartbeat("job-7", 5_000)).toBe(false); // still "queued"
    });

    it("listOrphaned finds a running job whose lease has passed", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-8", model: "flow-h" });
      await store.markRunning("job-8", 1); // expires almost immediately
      await new Promise((r) => setTimeout(r, 5));
      const orphans = await store.listOrphaned(Date.now());
      expect(orphans.map((o) => o.id)).toContain("job-8");
    });

    it("listOrphaned excludes a running job whose lease has not passed", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-9", model: "flow-i" });
      await store.markRunning("job-9", 60_000);
      expect(await store.listOrphaned(Date.now())).toHaveLength(0);
    });

    it("complete removes the job from the running index", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-10", model: "flow-j" });
      await store.markRunning("job-10", 60_000);
      await store.complete("job-10", sampleResult);
      expect(redis.zsets.get("aiperator:jobs:running")?.has("job-10")).toBeFalsy();
    });

    it("fail removes the job from the running index", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-11", model: "flow-k" });
      await store.markRunning("job-11", 60_000);
      await store.fail("job-11", "boom");
      expect(redis.zsets.get("aiperator:jobs:running")?.has("job-11")).toBeFalsy();
    });
  });

  describe("requeueForRetry", () => {
    it("requeues a job with a resumePayload and attempts remaining, removing it from the running index", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({
        id: "job-12",
        model: "flow-l",
        maxAttempts: 3,
        resumePayload: { flowId: "flow-l", messages: [] },
      });
      await store.markRunning("job-12", 1_000);
      const requeued = await store.requeueForRetry("job-12");
      expect(requeued?.attempt).toBe(2);
      expect(requeued?.status).toBe("queued");
      expect(redis.zsets.get("aiperator:jobs:running")?.has("job-12")).toBeFalsy();
    });

    it("returns undefined when the job has no resumePayload", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({ id: "job-13", model: "flow-m", maxAttempts: 3 });
      await store.markRunning("job-13", 1_000);
      expect(await store.requeueForRetry("job-13")).toBeUndefined();
    });

    it("returns undefined when attempts are already exhausted", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      await store.create({
        id: "job-14",
        model: "flow-n",
        maxAttempts: 1,
        resumePayload: { flowId: "flow-n", messages: [] },
      });
      await store.markRunning("job-14", 1_000);
      expect(await store.requeueForRetry("job-14")).toBeUndefined();
    });

    it("returns undefined for an unknown job", async () => {
      const redis = new FakeRedis();
      const store = new RedisJobStore(redis);
      expect(await store.requeueForRetry("nope")).toBeUndefined();
    });
  });
});
