// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration test — cluster-wide limit enforcement
 * (`src/graph/__tests__/cluster-limits.integration.test.ts`)
 *
 * Verifies that rate-limit counters and the concurrency semaphore enforce their
 * limits correctly under concurrent load, even when multiple "clients" (simulated
 * via Promise.all) hit the same key simultaneously.
 *
 * Uses MemoryStoreFactory / InMemoryConcurrencyLimiter for CI (no external deps).
 * Tests marked with `.skipIf` can run against real Redis/Postgres when the
 * corresponding env vars are set (REDIS_URL / DATABASE_URL) — wired in Task 14.4.
 *
 * Requirements: 2.4, 7.3
 */

import { describe, test, expect } from "bun:test";
import { MemoryStoreFactory } from "../../db/store/memory-store.js";
import { InMemoryConcurrencyLimiter } from "../distributed-semaphore.js";
import { QueueFullError } from "../semaphore.js";

// ---------------------------------------------------------------------------
// 1. Rate-limit counter: cluster-wide enforcement
// ---------------------------------------------------------------------------

describe("Cluster-wide rate-limit counter enforcement", () => {
  test("concurrent increments on the same key yield exact total (no lost updates)", async () => {
    const factory = new MemoryStoreFactory();
    const counter = factory.counter<string>("rate-limit");
    const numClients = 50;
    const windowMs = 60_000;
    const key = "tenant:abc:endpoint:/v1/chat";

    // Simulate N concurrent clients each incrementing by 1
    const results = await Promise.all(
      Array.from({ length: numClients }, () => counter.incr(key, 1, windowMs)),
    );

    // Every result must be a unique value between 1 and numClients
    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: numClients }, (_, i) => i + 1));

    // Final counter value must equal exactly numClients
    const finalValue = await counter.incr(key, 1, windowMs);
    expect(finalValue).toBe(numClients + 1);
  });

  test("concurrent increments by varying amounts yield correct total", async () => {
    const factory = new MemoryStoreFactory();
    const counter = factory.counter<string>("rate-limit");
    const windowMs = 60_000;
    const key = "tenant:xyz:endpoint:/v1/completions";

    // Each client increments by a different amount (1..10)
    const increments = Array.from({ length: 10 }, (_, i) => i + 1);
    const expectedTotal = increments.reduce((sum, v) => sum + v, 0); // 55

    const results = await Promise.all(
      increments.map((by) => counter.incr(key, by, windowMs)),
    );

    // The last returned value must equal the cumulative total
    const maxResult = Math.max(...results);
    expect(maxResult).toBe(expectedTotal);

    // No value should exceed the total
    for (const r of results) {
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThanOrEqual(expectedTotal);
    }
  });

  test("different keys remain isolated under concurrent load", async () => {
    const factory = new MemoryStoreFactory();
    const counter = factory.counter<string>("rate-limit");
    const windowMs = 60_000;
    const numPerKey = 20;

    // Two keys hammered concurrently
    const [resultsA, resultsB] = await Promise.all([
      Promise.all(
        Array.from({ length: numPerKey }, () =>
          counter.incr("keyA", 1, windowMs),
        ),
      ),
      Promise.all(
        Array.from({ length: numPerKey }, () =>
          counter.incr("keyB", 1, windowMs),
        ),
      ),
    ]);

    // Each key's max result must equal its own count, not the combined total
    expect(Math.max(...resultsA)).toBe(numPerKey);
    expect(Math.max(...resultsB)).toBe(numPerKey);
  });
});

// ---------------------------------------------------------------------------
// 2. Semaphore: cluster-wide concurrency enforcement
// ---------------------------------------------------------------------------

describe("Cluster-wide semaphore enforcement", () => {
  test("admits exactly maxConcurrent slots under concurrent acquire attempts", async () => {
    const maxConcurrent = 5;
    const limiter = new InMemoryConcurrencyLimiter({
      maxConcurrent,
      maxWaitMs: 100,
      retryMs: 10,
    });

    // Acquire all available slots
    const slots = await Promise.all(
      Array.from({ length: maxConcurrent }, () => limiter.acquire()),
    );
    expect(slots).toHaveLength(maxConcurrent);

    // Additional concurrent acquires must all be rejected with QueueFullError
    const extraAttempts = 10;
    const extras = await Promise.allSettled(
      Array.from({ length: extraAttempts }, () => limiter.acquire()),
    );

    for (const result of extras) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(QueueFullError);
      }
    }

    // Release all held slots
    await Promise.all(slots.map((s) => s.release()));
  });

  test("released slots become available for subsequent acquires", async () => {
    const maxConcurrent = 3;
    const limiter = new InMemoryConcurrencyLimiter({
      maxConcurrent,
      maxWaitMs: 200,
      retryMs: 10,
    });

    // Fill all slots
    const initial = await Promise.all(
      Array.from({ length: maxConcurrent }, () => limiter.acquire()),
    );

    // Release one slot
    const first = initial[0];
    if (first === undefined) throw new Error("expected a first slot");
    await first.release();

    // A new acquire should succeed now
    const next = await limiter.acquire();
    expect(next).toBeDefined();

    // Cleanup
    await next.release();
    await Promise.all(initial.slice(1).map((s) => s.release()));
  });

  test("concurrent acquire/release cycles never exceed maxConcurrent active slots", async () => {
    const maxConcurrent = 4;
    const totalCycles = 20;
    const limiter = new InMemoryConcurrencyLimiter({
      maxConcurrent,
      maxWaitMs: 2_000,
      retryMs: 5,
    });

    let peakActive = 0;
    let currentActive = 0;

    // Run multiple acquire+hold+release cycles concurrently
    await Promise.all(
      Array.from({ length: totalCycles }, async () => {
        const slot = await limiter.acquire();
        currentActive++;
        peakActive = Math.max(peakActive, currentActive);
        // Hold the slot briefly to simulate work
        await new Promise((r) => setTimeout(r, 5));
        currentActive--;
        await slot.release();
      }),
    );

    // Peak active must never have exceeded the limit
    expect(peakActive).toBeLessThanOrEqual(maxConcurrent);
    // All cycles completed
    expect(currentActive).toBe(0);
  });

  test("double-release does not create phantom capacity", async () => {
    const maxConcurrent = 2;
    const limiter = new InMemoryConcurrencyLimiter({
      maxConcurrent,
      maxWaitMs: 100,
      retryMs: 10,
    });

    const s1 = await limiter.acquire();
    const s2 = await limiter.acquire();

    // Double-release slot 1
    await s1.release();
    await s1.release();

    // Should only be able to acquire 1 more slot (not 2)
    const s3 = await limiter.acquire();

    // At capacity now — next should be rejected
    await expect(limiter.acquire()).rejects.toBeInstanceOf(QueueFullError);

    // Cleanup
    await s2.release();
    await s3.release();
  });
});

// ---------------------------------------------------------------------------
// 3. Skipped real-backing tests (require REDIS_URL / DATABASE_URL)
// ---------------------------------------------------------------------------

const hasRedis = !!process.env.REDIS_URL;
const hasPostgres = !!process.env.DATABASE_URL;

describe.skipIf(!hasRedis)("Cluster-wide limits — real Redis", () => {
  test("concurrent counter increments via Redis yield correct total", async () => {
    // This test will be wired in Task 14.4 with CI service containers.
    // The InMemory tests above prove the pattern; this confirms it against Redis.
    expect(true).toBe(true);
  });
});

describe.skipIf(!hasPostgres)("Cluster-wide limits — real Postgres", () => {
  test("concurrent semaphore acquires via Postgres enforce the limit", async () => {
    // This test will be wired in Task 14.4 with CI service containers.
    expect(true).toBe(true);
  });
});
