// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  MemoryApprovalConsumptionStore,
  RedisApprovalConsumptionStore,
} from "../../src/mcp/approval-store.ts";

/**
 * Property 9 (Req 6.1): a redeemed approval JTI can never be redeemed a
 * second time — across K gate replicas sharing Redis, and within the
 * single-process memory fallback (including its exp-based eviction).
 */

/** Minimal in-process Redis stand-in with real `SET ... NX` semantics. */
class FakeRedis {
  private readonly store = new Map<string, { value: string; pxat: number }>();

  async set(
    key: string,
    value: string,
    options: { NX: true; PXAT: number },
  ): Promise<string | null> {
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing !== undefined && existing.pxat > now) return null; // NX: already reserved
    this.store.set(key, { value, pxat: options.PXAT });
    return "OK";
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async quit(): Promise<unknown> {
    return undefined;
  }
}

/** Arbitrary for a batch of redemption attempts: (instance, jti) pairs. */
const arbAttempts = (kInstances: number, jtiCount: number) =>
  fc.array(
    fc.record({
      instance: fc.integer({ min: 0, max: kInstances - 1 }),
      jtiIndex: fc.integer({ min: 0, max: jtiCount - 1 }),
    }),
    { minLength: 1, maxLength: 60 },
  );

describe("approval consumption — Property 9: one-time redemption (Req 6.1)", () => {
  it("across K Redis-backed replicas, each JTI succeeds at most once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 8 }),
        fc.nat({ max: 1_000_000 }),
        async (k, jtiCount, seedOffset) => {
          const redis = new FakeRedis();
          // All replicas share one Redis and one prefix — that is what makes
          // the SET NX reservation visible across the cluster.
          const replicas = Array.from(
            { length: k },
            () => new RedisApprovalConsumptionStore(redis, "atf:approval:"),
          );
          // Distinct expiries far in the future so no reservation lapses mid-run.
          const exps = Array.from(
            { length: jtiCount },
            (_, i) => Date.now() + 60_000 + seedOffset + i,
          );
          const successes = new Map<number, number>();
          const attempts = [
            ...Array.from({ length: jtiCount }, (_, i) => ({ instance: 0, jtiIndex: i })),
            ...Array.from({ length: 20 }, (_, i) => ({
              instance: i % k,
              jtiIndex: (i * 7 + seedOffset) % jtiCount,
            })),
          ];
          for (const { instance, jtiIndex } of attempts) {
            const replica = replicas[instance];
            if (replica === undefined) continue;
            if (await replica.consume(`jti-${jtiIndex}`, exps[jtiIndex] as number))
              successes.set(jtiIndex, (successes.get(jtiIndex) ?? 0) + 1);
          }
          // Every JTI that was attempted has a reservation outcome of exactly
          // one success; all other JTIs have zero.
          for (const [jtiIndex, count] of successes)
            expect(count, `jti-${jtiIndex} redeemed ${count} times`).toBe(1);
          expect(successes.size).toBeGreaterThan(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("memory store: each JTI redeems exactly once while live, repeats are false", async () => {
    await fc.assert(
      fc.asyncProperty(arbAttempts(1, 10), async (attempts) => {
        const store = new MemoryApprovalConsumptionStore(10_000);
        const exp = Date.now() + 3_600_000;
        const successCount = new Map<string, number>();
        for (const { jtiIndex } of attempts) {
          const jti = `jti-${jtiIndex}`;
          if (await store.consume(jti, exp))
            successCount.set(jti, (successCount.get(jti) ?? 0) + 1);
        }
        for (const count of successCount.values()) expect(count).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it("memory eviction drops the soonest-expiring reservation, never a later one", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.shuffledSubarray(
          Array.from({ length: 12 }, (_, i) => i),
          { minLength: 12, maxLength: 12 },
        ),
        async (capacity, shuffledExps) => {
          const store = new MemoryApprovalConsumptionStore(capacity);
          const base = Date.now() + 60_000;
          // Insert exactly `capacity + 1` JTIs with distinct expiries in random
          // order, so precisely one reservation must be evicted.
          const exps = shuffledExps.slice(0, capacity + 1);
          const jtis = exps.map((e) => `jti-${e}`);
          const expOf = new Map<string, number>();
          for (const jti of jtis) expOf.set(jti, base + Number(jti.slice(4)));
          for (const jti of jtis) await store.consume(jti, expOf.get(jti) as number);
          // Exactly one reservation must have been evicted: the smallest exp
          // among the first `capacity` insertions (the last insert triggers the
          // eviction before being stored itself).
          const minExp = Math.min(...exps.slice(0, capacity));
          const evicted = `jti-${minExp}`;
          // Check the live reservations first: a present JTI short-circuits to
          // `false` before the eviction loop, so probing cannot evict anything.
          for (const jti of jtis)
            if (jti !== evicted) expect(await store.consume(jti, expOf.get(jti) as number)).toBe(false);
          // The evicted reservation is the only one that can be redeemed again.
          expect(await store.consume(evicted, expOf.get(evicted) as number)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
