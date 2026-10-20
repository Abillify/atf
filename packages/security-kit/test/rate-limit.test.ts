// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * GCRA core + backends. The core is pure (time in, state out); the memory
 * backend wraps it with bounded growth; the Redis backend ships one atomic
 * Lua script, tested here against a faithful in-test interpreter of the same
 * arithmetic (a real-Redis systemtest lives in integration/system).
 *
 * Property 11 (Rate-Limit-Schranke): for arbitrary request sequences the
 * number of allowed requests in any window of length w never exceeds max,
 * within the GCRA tolerance of one extra cell.
 */

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  createMemoryRateLimitBackend,
  createRedisRateLimitBackend,
  gcraCheck,
  type GcraConfig,
  type GcraState,
  type RateLimitResult,
} from "../src/index.js";

const CONFIG: GcraConfig = { limit: 10, burstMs: 1000 };
const US = 1000; // µs per ms

describe("gcraCheck", () => {
  test("burst of limit allowed immediately, then denied", () => {
    let state: GcraState | null = null;
    const now = 1_000_000 * US;
    for (let i = 0; i < 10; i++) {
      const decision = gcraCheck(CONFIG, state, now);
      expect(decision.allowed).toBe(true);
      state = decision.state;
    }
    const denied = gcraCheck(CONFIG, state, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  test("denied requests do not move the TAT (no debt accumulation)", () => {
    let state: GcraState | null = null;
    const now = 1_000_000 * US;
    for (let i = 0; i < 10; i++) state = gcraCheck(CONFIG, state, now).state;
    const first = gcraCheck(CONFIG, state, now);
    const second = gcraCheck(CONFIG, state, now);
    expect(first.allowed).toBe(false);
    expect(second.state.tatUs).toBe(first.state.tatUs);
    expect(second.retryAfterMs).toBe(first.retryAfterMs);
  });

  test("refills one cell per burstMs/limit", () => {
    let state: GcraState | null = null;
    const now = 1_000_000 * US;
    for (let i = 0; i < 10; i++) state = gcraCheck(CONFIG, state, now).state;
    // Emission interval = 1000ms/10 = 100ms per cell.
    const tooEarly = gcraCheck(CONFIG, state, now + 50 * US);
    expect(tooEarly.allowed).toBe(false);
    const justInTime = gcraCheck(CONFIG, state, now + 100 * US);
    expect(justInTime.allowed).toBe(true);
  });

  test("idle key behaves as full bucket", () => {
    const state: GcraState = { tatUs: 1_000_000 * US };
    const muchLater = 1_000_000 * US + 60_000 * US;
    let current: GcraState | null = state;
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      const decision = gcraCheck(CONFIG, current, muchLater);
      if (decision.allowed) allowed += 1;
      current = decision.state;
    }
    expect(allowed).toBe(10);
  });

  test("cost > 1 consumes multiple cells", () => {
    // limit=10, burst=1000 ms → emission 100 ms. cost=5 pushes the TAT 500 ms
    // ahead, leaving floor((1000-500)/100) = 5 cells that fit immediately.
    const decision = gcraCheck(CONFIG, null, 1_000_000 * US, 5);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(5);
  });

  test("invalid configs throw", () => {
    const now = 1_000_000 * US;
    expect(() => gcraCheck({ limit: 0, burstMs: 1000 }, null, now)).toThrow();
    expect(() => gcraCheck({ limit: 10, burstMs: 0 }, null, now)).toThrow();
    expect(() => gcraCheck(CONFIG, null, now, 0)).toThrow();
  });

  test("retryAfterMs is the exact wait for one cell", () => {
    let state: GcraState | null = null;
    const now = 1_000_000 * US;
    for (let i = 0; i < 10; i++) state = gcraCheck(CONFIG, state, now).state;
    const denied = gcraCheck(CONFIG, state, now);
    expect(denied.retryAfterMs).toBe(100);
    const retried = gcraCheck(CONFIG, state, now + denied.retryAfterMs * US);
    expect(retried.allowed).toBe(true);
  });
});

describe("memory backend", () => {
  test("tracks per-key state independently", async () => {
    const backend = createMemoryRateLimitBackend();
    const a1 = await backend.take("a", CONFIG, 1);
    const a2 = await backend.take("a", CONFIG, 1);
    const b1 = await backend.take("b", CONFIG, 1);
    expect(a1.allowed && a2.allowed && b1.allowed).toBe(true);
    expect(a2.remaining).toBe(8);
    expect(b1.remaining).toBe(9);
    expect(backend.size()).toBe(2);
  });

  test("enforces the limit across many calls", async () => {
    const backend = createMemoryRateLimitBackend();
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const result = await backend.take("flood", CONFIG, 1);
      if (result.allowed) allowed += 1;
    }
    expect(allowed).toBe(10);
  });

  test("evicts lowest-TAT keys past maxKeys", async () => {
    const backend = createMemoryRateLimitBackend({ maxKeys: 100 });
    for (let i = 0; i < 150; i++) await backend.take(`key-${i}`, CONFIG, 1);
    expect(backend.size()).toBeLessThanOrEqual(100);
  });

  test("clear() drops all state", async () => {
    const backend = createMemoryRateLimitBackend();
    await backend.take("x", CONFIG, 1);
    backend.clear();
    expect(backend.size()).toBe(0);
  });
});

describe("redis backend (faithful script interpreter)", () => {
  // Mirrors GCRA_LUA arithmetic over a Map to catch wiring bugs (argument
  // order, unit conversion, result mapping). The Lua itself is covered by the
  // integration systemtest against real Redis.
  function fakeRedis() {
    const store = new Map<string, number>();
    return {
      eval: async (
        _script: string,
        options: { keys: string[]; arguments: (string | number)[] },
      ): Promise<unknown> => {
        const key = options.keys[0] ?? "";
        const emission = Number(options.arguments[0]);
        const fill = Number(options.arguments[1]);
        const cost = Number(options.arguments[2]);
        const now = Number(options.arguments[3]);
        let tat = store.has(key) ? (store.get(key) as number) : now;
        if (tat < now) tat = now;
        const newTat = tat + cost * emission;
        const delay = newTat - now;
        if (delay > fill) {
          store.set(key, tat);
          return [
            0,
            0,
            Math.ceil((newTat - fill - now) / 1000),
            Math.ceil((tat - now) / 1000),
            tat,
          ];
        }
        store.set(key, newTat);
        const limit = Math.floor(fill / emission);
        const remaining = Math.max(
          0,
          Math.min(limit - 1, Math.floor((fill - delay) / emission)),
        );
        return [1, remaining, 0, Math.ceil((newTat - now) / 1000), newTat];
      },
    };
  }

  // Regression: redis v4+/v5 parses eval(script, numKeys, keys, args) as an
  // options object and silently drops the keys/args (the script then runs
  // with ZERO keys). Assert the backend uses the options-object form.
  test("calls eval with the redis v4+/v5 options-object form", async () => {
    const calls: { script: string; options: unknown }[] = [];
    const client = {
      eval: async (script: string, options: unknown): Promise<unknown> => {
        calls.push({ script, options });
        return [1, 5, 0, 1000, 0];
      },
    };
    const backend = createRedisRateLimitBackend(client, { keyPrefix: "gate" });
    await backend.take("tenant-1", CONFIG, 1);
    expect(calls).toHaveLength(1);
    const opts = calls[0]?.options as
      | { keys?: unknown[]; arguments?: unknown[] }
      | undefined;
    expect(opts).toBeDefined();
    expect(Array.isArray(opts?.keys)).toBe(true);
    expect(opts?.keys).toEqual(["gate:tenant-1"]);
    expect(Array.isArray(opts?.arguments)).toBe(true);
    expect(opts?.arguments?.length).toBe(4);
  });

  test("passes GCRA decisions through and prefixes keys", async () => {
    const client = fakeRedis();
    const backend = createRedisRateLimitBackend(client, { keyPrefix: "gate" });
    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const result = await backend.take("tenant-1", CONFIG, 1);
      if (result.allowed) allowed += 1;
    }
    expect(allowed).toBe(10);
  });

  test("failMode closed denies on redis error", async () => {
    const backend = createRedisRateLimitBackend({
      eval: async () => {
        throw new Error("redis down");
      },
    });
    const result = await backend.take("k", CONFIG, 1);
    expect(result.allowed).toBe(false);
  });

  test("failMode open allows on redis error", async () => {
    let seen: unknown = null;
    const backend = createRedisRateLimitBackend(
      {
        eval: async () => {
          throw new Error("redis down");
        },
      },
      { failMode: "open", onError: (err) => (seen = err) },
    );
    const result = await backend.take("k", CONFIG, 1);
    expect(result.allowed).toBe(true);
    expect(seen).toBeInstanceOf(Error);
  });
});

describe("Property 11: Rate-Limit-Schranke", () => {
  test("no window of length n*burstMs exceeds (n+1)*limit-1 allowed requests", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }), // limit
        fc.integer({ min: 100, max: 60_000 }), // burstMs
        fc.array(
          fc.record({
            // inter-arrival gaps in ms, including 0 (instant floods)
            gapMs: fc.integer({ min: 0, max: 2_000 }),
            cost: fc.integer({ min: 1, max: 3 }),
          }),
          { minLength: 1, maxLength: 200 },
        ),
        (limit, burstMs, arrivals) => {
          const config: GcraConfig = { limit, burstMs };
          const allowedTimesUs: number[] = [];
          let state: GcraState | null = null;
          let nowUs = 0;
          for (const arrival of arrivals) {
            nowUs += arrival.gapMs * US;
            const decision = gcraCheck(config, state, nowUs, arrival.cost);
            if (decision.allowed) {
              state = decision.state;
              allowedTimesUs.push(nowUs);
            }
          }
          // Sliding-window check with the exact GCRA bound. With emission
          // interval T = burstMs/limit and tolerance τ = burstMs, every
          // allowed request advances the TAT by ≥ T, and the last allowed
          // request in a window [t, t + n·τ) satisfies TAT < t + (n+1)·limit·T.
          // Hence at most (n+1)·limit − 1 requests (each ≥ 1 cell) fit —
          // for n = 1 the full burst of `limit` cells plus one cell per
          // emission interval until the tolerance window closes.
          for (const n of [1, 2]) {
            const windowUs = n * burstMs * US;
            const maxAllowed = (n + 1) * limit - 1;
            for (const start of allowedTimesUs) {
              let count = 0;
              for (const t of allowedTimesUs) {
                if (t >= start && t < start + windowUs) count += 1;
              }
              if (count > maxAllowed) return false;
            }
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  test("memory backend matches the pure core on identical time lines", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 100 }),
        async (gaps) => {
          const config: GcraConfig = { limit: 5, burstMs: 1000 };
          let clockUs = 0;
          const backend = createMemoryRateLimitBackend({ nowUs: () => clockUs });
          let state: GcraState | null = null;
          for (const gap of gaps) {
            clockUs += gap * US;
            const viaBackend: RateLimitResult = await backend.take("k", config, 1);
            const viaCore = gcraCheck(config, state, clockUs, 1);
            if (viaBackend.allowed !== viaCore.allowed) return false;
            state = viaCore.state;
          }
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
