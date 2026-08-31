// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Redis integration tests for the cluster-wide coordination primitives that the
 * unit suite can only cover with fakes: the sliding-window rate limiter, the
 * distributed concurrency limiter, the distributed thread lock, and the
 * Redis-backed response cache. They also verify the startup bootstrap
 * ({@link ensureBunGlobals}) actually exposes Bun's RedisClient so these
 * integrations are not silently disabled in production.
 *
 * Run ONLY when REDIS_URL is set (an ephemeral redis container); otherwise the
 * whole block is skipped. Start one with:
 *   docker compose -f docker-compose.test.yml up -d
 *   REDIS_URL=redis://localhost:56379 bun test src/graph/__tests__/redis-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import crypto from "node:crypto";
import { ensureBunGlobals } from "../../bun-globals.js";
import { createRedisRateLimitStore } from "../../middleware/rate-limit.js";
import { createRedisConcurrencyLimiter } from "../distributed-semaphore.js";
import { QueueFullError } from "../semaphore.js";
import { createRedisThreadLock } from "../thread-lock.js";
import { createRedisCacheStore } from "../response-cache.js";

const REDIS_URL = process.env.REDIS_URL;
const suite = REDIS_URL ? describe : describe.skip;

let hadGlobal = false;
beforeAll(() => {
  hadGlobal =
    (globalThis as { RedisClient?: unknown }).RedisClient !== undefined;
  ensureBunGlobals();
});
afterAll(() => {
  // Leave the global as the bootstrap left it, but don't leak it to other test
  // files that rely on it being absent.
  if (!hadGlobal) delete (globalThis as { RedisClient?: unknown }).RedisClient;
});

const uniq = () => crypto.randomUUID();

/** `REDIS_URL`, asserting it's set (only called within a `suite` gated on it). */
function mustRedisUrl(): string {
  if (REDIS_URL === undefined) throw new Error("expected REDIS_URL to be set");
  return REDIS_URL;
}

/** `createRedisRateLimitStore` for a URL known to produce a store. */
function mustCreateRedisRateLimitStore(url: string) {
  const store = createRedisRateLimitStore(url);
  if (store === undefined) throw new Error("expected a rate-limit store");
  return store;
}

/** `createRedisConcurrencyLimiter` for options known to produce a limiter. */
function mustCreateRedisConcurrencyLimiter(
  url: string,
  opts: Parameters<typeof createRedisConcurrencyLimiter>[1],
) {
  const limiter = createRedisConcurrencyLimiter(url, opts);
  if (limiter === undefined) throw new Error("expected a concurrency limiter");
  return limiter;
}

/** `createRedisThreadLock` for options known to produce a lock. */
function mustCreateRedisThreadLock(
  url: string,
  opts: Parameters<typeof createRedisThreadLock>[2],
) {
  const lock = createRedisThreadLock(url, undefined, opts);
  if (lock === undefined) throw new Error("expected a thread lock");
  return lock;
}

/** `createRedisCacheStore` for a URL known to produce a store. */
function mustCreateRedisCacheStore(url: string) {
  const store = createRedisCacheStore(url);
  if (store === undefined) throw new Error("expected a cache store");
  return store;
}

suite("ensureBunGlobals", () => {
  it("exposes Bun's RedisClient on globalThis", () => {
    expect(typeof (globalThis as { RedisClient?: unknown }).RedisClient).toBe(
      "function",
    );
  });
});

suite("Redis sliding-window rate limiter", () => {
  it("counts hits within a window", async () => {
    const store = mustCreateRedisRateLimitStore(mustRedisUrl());
    expect(store).toBeDefined();
    const key = `it-${uniq()}`;
    const first = await store.hit(key, 60_000);
    const second = await store.hit(key, 60_000);
    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(second.resetAt).toBeGreaterThan(Date.now());
    await store.close?.();
  });
});

suite("Redis distributed concurrency limiter", () => {
  it("enforces the cluster-wide cap and frees a slot on release", async () => {
    // Isolate from any leftover tokens of a previous interrupted run.
    const RC = (
      globalThis as {
        RedisClient?: new (u: string) => {
          send(c: string, a: string[]): Promise<unknown>;
          close?(): void;
        };
      }
    ).RedisClient;
    if (RC === undefined) throw new Error("expected Bun's RedisClient global");
    const raw = new RC(mustRedisUrl());
    await raw.send("DEL", ["aiperator:concurrency:global"]);
    raw.close?.();

    const limiter = mustCreateRedisConcurrencyLimiter(mustRedisUrl(), {
      maxConcurrent: 2,
      maxWaitMs: 150,
      retryMs: 10,
    });
    expect(limiter).toBeDefined();

    const s1 = await limiter.acquire();
    const s2 = await limiter.acquire();
    // Third acquire exceeds the cap and should reject within the wait budget.
    await expect(limiter.acquire()).rejects.toBeInstanceOf(QueueFullError);

    await s1.release();
    // After releasing one, a new acquire succeeds.
    const s3 = await limiter.acquire();
    await s2.release();
    await s3.release();
  });

  it("heartbeat keeps a held slot alive past ttlMs against real Redis", async () => {
    const RC = (
      globalThis as {
        RedisClient?: new (u: string) => {
          send(c: string, a: string[]): Promise<unknown>;
          close?(): void;
        };
      }
    ).RedisClient;
    if (RC === undefined) throw new Error("expected Bun's RedisClient global");
    const raw = new RC(mustRedisUrl());
    await raw.send("DEL", ["aiperator:concurrency:global"]);
    raw.close?.();

    const limiter = mustCreateRedisConcurrencyLimiter(mustRedisUrl(), {
      maxConcurrent: 1,
      ttlMs: 60,
      heartbeatIntervalMs: 15,
      maxWaitMs: 100,
      retryMs: 10,
    });
    const held = await limiter.acquire();

    // Outlive ttlMs several times over — only the heartbeat re-scoring the
    // token every 15ms should keep it from being evicted as stale.
    await new Promise((r) => setTimeout(r, 150));

    // A second limiter competing for the single slot must still be rejected,
    // proving the first slot's token was never evicted by ttlMs.
    const other = mustCreateRedisConcurrencyLimiter(mustRedisUrl(), {
      maxConcurrent: 1,
      maxWaitMs: 60,
      retryMs: 10,
    });
    await expect(other.acquire()).rejects.toBeInstanceOf(QueueFullError);

    await held.release();
    // Slot now free.
    const after = await limiter.acquire();
    await after.release();
  });
});

suite("Redis distributed thread lock", () => {
  it("serialises acquire/release for the same key", async () => {
    const lock = mustCreateRedisThreadLock(mustRedisUrl(), {
      ttlMs: 5000,
      retryMs: 10,
      maxWaitMs: 2000,
    });
    expect(lock).toBeDefined();
    const key = `conv-${uniq()}`;

    const h1 = await lock.acquire(key);
    let h2Acquired = false;
    const p2 = lock.acquire(key).then((h) => {
      h2Acquired = true;
      return h;
    });
    // While h1 is held, h2 must not have acquired yet.
    await new Promise((r) => setTimeout(r, 60));
    expect(h2Acquired).toBe(false);

    await h1.release();
    const h2 = await p2;
    expect(h2Acquired).toBe(true);
    await h2.release();
  });
});

suite("Redis response cache", () => {
  it("stores and retrieves a cached response across the shared store", async () => {
    const store = mustCreateRedisCacheStore(mustRedisUrl());
    expect(store).toBeDefined();
    const key = `resp-${uniq()}`;
    const value = {
      text: "Paris",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    };
    await store.set(key, value, 60);
    const got = await store.get(key);
    expect(got).toEqual(value);
    expect(await store.get(`missing-${uniq()}`)).toBeUndefined();
  });
});
