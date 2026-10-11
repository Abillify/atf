// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the distributed concurrency limiter
 * (`src/graph/distributed-semaphore.ts`).
 *
 * A fake in-memory Redis implements the sorted-set commands AND emulates the
 * server-side EVAL of the limiter's two Lua scripts (atomic acquire,
 * heartbeat) so the slot accounting, capacity rejection, heartbeat refresh,
 * release and fail-open behaviour are testable without a real Redis. The EVAL
 * emulation mirrors the Lua bodies exactly (see distributed-semaphore.ts) —
 * it is dispatched by argument shape since the fake never parses Lua.
 */

import { describe, it, expect } from "bun:test";
import {
  RedisConcurrencyLimiter,
  InMemoryConcurrencyLimiter,
  PostgresConcurrencyLimiter,
  createConcurrencyLimiterFromFactory,
  type LimiterRedisClient,
} from "../distributed-semaphore.js";
import { QueueFullError } from "../semaphore.js";
import { createMetrics } from "../../observability/metrics.js";
import type { StoreFactory } from "../../db/store/store.js";
import type { Database } from "../../db/database.js";

class FakeRedis implements LimiterRedisClient {
  private z = new Map<string, number>(); // member -> score
  async send(command: string, args: string[]): Promise<unknown> {
    switch (command) {
      case "ZADD": {
        const [, score, member] = args;
        if (member === undefined) throw new Error("ZADD requires a member");
        this.z.set(member, Number(score));
        return 1;
      }
      case "ZCARD":
        return this.z.size;
      case "ZREM": {
        const member = args[1];
        if (member === undefined) throw new Error("ZREM requires a member");
        this.z.delete(member);
        return 1;
      }
      case "ZREMRANGEBYSCORE": {
        const max = Number(args[2]);
        for (const [m, s] of [...this.z]) if (s <= max) this.z.delete(m);
        return 0;
      }
      case "EVAL": {
        // args = [script, numkeys, key, ...ARGV...]. Dispatch by ARGV shape:
        // acquire = [now, ttlMs, token, maxConcurrent] (4 ARGV), heartbeat =
        // [now, token] (2 ARGV) — mirrors ACQUIRE_LUA / HEARTBEAT_LUA.
        const argv = args.slice(2);
        if (argv.length >= 5) {
          // [key, now, ttlMs, token, maxConcurrent]
          const [, now, ttlMs, token, maxConcurrent] = argv;
          const nowNum = Number(now);
          const staleBefore = nowNum - Number(ttlMs);
          for (const [m, s] of [...this.z])
            if (s <= staleBefore) this.z.delete(m);
          if (token === undefined) throw new Error("acquire requires token");
          this.z.set(token, nowNum);
          if (this.z.size <= Number(maxConcurrent)) return 1;
          this.z.delete(token);
          return 0;
        }
        // heartbeat: [key, now, token]
        const [, now, token] = argv;
        if (token === undefined) throw new Error("heartbeat requires token");
        if (!this.z.has(token)) return 0;
        this.z.set(token, Number(now));
        return 1;
      }
      default:
        return null;
    }
  }
  count(): number {
    return this.z.size;
  }
  score(token: string): number | undefined {
    return this.z.get(token);
  }
}

class BrokenRedis implements LimiterRedisClient {
  async send(): Promise<unknown> {
    throw new Error("redis down");
  }
}

describe("RedisConcurrencyLimiter", () => {
  it("admits up to the cap and releases slots", async () => {
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis, { maxConcurrent: 2 });

    const s1 = await limiter.acquire();
    const s2 = await limiter.acquire();
    expect(redis.count()).toBe(2);

    await s1.release();
    expect(redis.count()).toBe(1);
    await s2.release();
    expect(redis.count()).toBe(0);
  });

  it("rejects with QueueFullError when the cluster is saturated", async () => {
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis, {
      maxConcurrent: 1,
      maxWaitMs: 30,
      retryMs: 5,
    });
    const held = await limiter.acquire();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(QueueFullError);
    await held.release();
    // After release a new acquire succeeds.
    const next = await limiter.acquire();
    expect(redis.count()).toBe(1);
    await next.release();
  });

  it("releasing twice is a no-op", async () => {
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis, { maxConcurrent: 1 });
    const s = await limiter.acquire();
    await s.release();
    await s.release();
    expect(redis.count()).toBe(0);
  });

  it("fails open (admits) when Redis errors", async () => {
    const limiter = new RedisConcurrencyLimiter(new BrokenRedis(), {
      maxConcurrent: 1,
    });
    const slot = await limiter.acquire();
    // Should not throw and release is safe.
    await slot.release();
    expect(true).toBe(true);
  });

  it("fail-open on a Redis error counts aiperator_degraded_total (Req 7.8)", async () => {
    const m = createMetrics(true);
    const limiter = new RedisConcurrencyLimiter(
      new BrokenRedis(),
      { maxConcurrent: 1 },
      undefined,
      m,
    );
    const slot = await limiter.acquire();
    await slot.release();
    expect(m.render()).toContain(
      'aiperator_degraded_total{component="semaphore"} 1',
    );
  });

  it("resolves a race for the last slot atomically (no under-admission)", async () => {
    // Two concurrent acquire() calls contending for the single remaining
    // slot must result in exactly one winner and one QueueFullError, never
    // both succeeding and never both failing — the failure mode the old
    // 4-round-trip implementation was prone to.
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis, {
      maxConcurrent: 1,
      maxWaitMs: 30,
      retryMs: 5,
    });
    const results = await Promise.allSettled([
      limiter.acquire(),
      limiter.acquire(),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(redis.count()).toBe(1);
  });

  it("heartbeat re-scores a held token so it survives past ttlMs", async () => {
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis, {
      maxConcurrent: 1,
      ttlMs: 40,
      heartbeatIntervalMs: 10,
    });
    const slot = await limiter.acquire();
    const scoresBefore = redis.count();
    expect(scoresBefore).toBe(1);

    // Wait past the TTL — without a heartbeat the token would be evicted by
    // the next acquire's stale-eviction step. The heartbeat (firing every
    // 10ms) should have kept re-scoring it to "now" the whole time.
    await new Promise((r) => setTimeout(r, 80));

    // A fresh acquire() from a second limiter instance triggers stale
    // eviction (ZREMRANGEBYSCORE) as part of its own attempt; the held
    // token must still be present because the heartbeat kept its score
    // fresh, so this second acquire must be rejected (cap = 1).
    const other = new RedisConcurrencyLimiter(redis, {
      maxConcurrent: 1,
      maxWaitMs: 20,
      retryMs: 5,
    });
    await expect(other.acquire()).rejects.toBeInstanceOf(QueueFullError);

    await slot.release();
  });

  it("stops heartbeating after release", async () => {
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis, {
      maxConcurrent: 1,
      heartbeatIntervalMs: 10,
    });
    const slot = await limiter.acquire();
    await slot.release();
    expect(redis.count()).toBe(0);

    // If the heartbeat interval were still running it would try to
    // re-score a token that no longer exists — HEARTBEAT_LUA guards against
    // resurrecting it (returns 0, no ZADD), so the set must stay empty.
    await new Promise((r) => setTimeout(r, 40));
    expect(redis.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// InMemoryConcurrencyLimiter
// ---------------------------------------------------------------------------

describe("InMemoryConcurrencyLimiter", () => {
  it("admits up to the cap and releases slots", async () => {
    const limiter = new InMemoryConcurrencyLimiter({ maxConcurrent: 2 });
    const s1 = await limiter.acquire();
    const s2 = await limiter.acquire();
    // Both acquired — no error
    await s1.release();
    await s2.release();
  });

  it("rejects with QueueFullError when saturated", async () => {
    const limiter = new InMemoryConcurrencyLimiter({
      maxConcurrent: 1,
      maxWaitMs: 30,
      retryMs: 5,
    });
    const held = await limiter.acquire();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(QueueFullError);
    await held.release();
    // After release, next acquire succeeds
    const next = await limiter.acquire();
    await next.release();
  });

  it("releasing twice is a no-op", async () => {
    const limiter = new InMemoryConcurrencyLimiter({ maxConcurrent: 1 });
    const s = await limiter.acquire();
    await s.release();
    await s.release(); // should not throw or change state
    // After double release, can still acquire one slot
    const next = await limiter.acquire();
    await next.release();
  });
});

// ---------------------------------------------------------------------------
// PostgresConcurrencyLimiter
// ---------------------------------------------------------------------------

describe("PostgresConcurrencyLimiter", () => {
  it("admits up to the cap with a fake Postgres", async () => {
    // Models the reserved-connection transaction path: INSERT adds a pending
    // token, COMMIT persists it, ROLLBACK discards it, COUNT reflects committed
    // + pending, and release() deletes a committed token.
    const committed = new Set<string>();
    const makeConn = (): Database => {
      let pending: string | null = null;
      const conn: Database = {
        async query<T>(
          text: string,
          params?: readonly unknown[],
        ): Promise<T[]> {
          if (text.includes("INSERT INTO")) {
            pending = params?.[0] as string;
            return [] as T[];
          }
          if (text.includes("COUNT(*)")) {
            return [{ count: committed.size + (pending ? 1 : 0) }] as T[];
          }
          if (text.startsWith("COMMIT")) {
            if (pending) committed.add(pending);
            pending = null;
            return [] as T[];
          }
          if (text.startsWith("ROLLBACK")) {
            pending = null;
            return [] as T[];
          }
          if (text.includes("DELETE") && text.includes("WHERE token")) {
            committed.delete(params?.[0] as string);
            return [] as T[];
          }
          // BEGIN, advisory lock, stale-eviction DELETE, CREATE TABLE → no-op
          return [] as T[];
        },
        async close() {},
        async withConnection<T>(cb: (db: Database) => Promise<T>) {
          return cb(conn);
        },
        async withOperator<T>(cb: (db: Database) => Promise<T>) {
          return cb(conn);
        },
      };
      return conn;
    };
    const db: Database = {
      async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
        if (text.includes("DELETE") && text.includes("WHERE token")) {
          committed.delete(params?.[0] as string);
        }
        return [] as T[];
      },
      async close() {},
      async withConnection<T>(cb: (db: Database) => Promise<T>) {
        return cb(makeConn());
      },
      async withOperator<T>(cb: (db: Database) => Promise<T>) {
        return cb(this);
      },
    };
    const tokens = committed;

    const limiter = new PostgresConcurrencyLimiter(db, { maxConcurrent: 2 });
    const s1 = await limiter.acquire();
    const s2 = await limiter.acquire();
    expect(tokens.size).toBe(2);

    await s1.release();
    expect(tokens.size).toBe(1);
    await s2.release();
    expect(tokens.size).toBe(0);
  });

  it("fails open when database errors", async () => {
    const db: Database = {
      async query(): Promise<never[]> {
        throw new Error("connection refused");
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>) {
        return cb(this);
      },
    };

    const limiter = new PostgresConcurrencyLimiter(db, { maxConcurrent: 1 });
    // Should not throw — fails open
    const slot = await limiter.acquire();
    await slot.release();
  });
});

// ---------------------------------------------------------------------------
// createConcurrencyLimiterFromFactory
// ---------------------------------------------------------------------------

describe("createConcurrencyLimiterFromFactory", () => {
  it("returns undefined when maxConcurrent <= 0", () => {
    const factory: StoreFactory = {
      keyValue: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      }),
      counter: () => ({ incr: async () => 0 }),
      backing: () => "memory",
    };
    const result = createConcurrencyLimiterFromFactory(factory, {
      maxConcurrent: 0,
    });
    expect(result).toBeUndefined();
  });

  it("returns InMemoryConcurrencyLimiter for memory backing", () => {
    const factory: StoreFactory = {
      keyValue: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      }),
      counter: () => ({ incr: async () => 0 }),
      backing: () => "memory",
    };
    const result = createConcurrencyLimiterFromFactory(factory, {
      maxConcurrent: 5,
    });
    expect(result).toBeInstanceOf(InMemoryConcurrencyLimiter);
  });

  it("returns PostgresConcurrencyLimiter for postgres backing with database", () => {
    const db: Database = {
      async query() {
        return [];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>) {
        return cb(this);
      },
    };
    const factory: StoreFactory = {
      keyValue: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      }),
      counter: () => ({ incr: async () => 0 }),
      backing: () => "postgres",
    };
    const result = createConcurrencyLimiterFromFactory(factory, {
      maxConcurrent: 5,
      database: db,
    });
    expect(result).toBeInstanceOf(PostgresConcurrencyLimiter);
  });

  it("falls back to InMemoryConcurrencyLimiter for postgres backing without database", () => {
    const factory: StoreFactory = {
      keyValue: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      }),
      counter: () => ({ incr: async () => 0 }),
      backing: () => "postgres",
    };
    const result = createConcurrencyLimiterFromFactory(factory, {
      maxConcurrent: 5,
    });
    expect(result).toBeInstanceOf(InMemoryConcurrencyLimiter);
  });

  it("falls back to InMemoryConcurrencyLimiter for redis backing without redisUrl", () => {
    const factory: StoreFactory = {
      keyValue: () => ({
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      }),
      counter: () => ({ incr: async () => 0 }),
      backing: () => "redis",
    };
    const result = createConcurrencyLimiterFromFactory(factory, {
      maxConcurrent: 5,
    });
    expect(result).toBeInstanceOf(InMemoryConcurrencyLimiter);
  });
});
