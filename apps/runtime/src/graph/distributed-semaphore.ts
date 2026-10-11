// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Distributed concurrency limiter (`src/graph/distributed-semaphore.ts`)
 *
 * The in-process {@link Semaphore} bounds concurrent executions per replica.
 * Behind a load balancer that is not a global guarantee: N replicas allow
 * N × maxConcurrentExecutions in flight. This limiter adds a CLUSTER-WIDE bound
 * enforced in Redis, so the total number of simultaneous executions across all
 * replicas cannot exceed a configured cap.
 *
 * Mechanism — a Redis sorted set of live "slot tokens" scored by acquisition
 * time:
 *   acquire: drop stale tokens (older than ttl), ZADD our token, ZCARD; if the
 *            count is within the cap we hold a slot, otherwise ZREM our token
 *            and retry until the wait budget is exhausted (then reject).
 *   release: ZREM our token.
 *
 * The TTL makes the limiter self-healing: a replica that crashes without
 * releasing its slot has its token expire automatically, so a leaked slot never
 * permanently shrinks global capacity.
 *
 * Fail-open: any Redis error during acquire lets the request proceed (the
 * per-replica semaphore still applies), so a cache outage degrades capacity
 * accuracy rather than blocking all traffic — consistent with the thread-lock
 * and rate-limiter philosophy.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import { QueueFullError } from "./semaphore.js";
import { safeSqlIdentifier } from "../db/sql-identifier.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import {
  createRedisClient,
  type RedisClientLike,
} from "../util/redis-client.js";

export interface GlobalSlot {
  /** Releases the global slot. Safe to call exactly once. */
  release(): Promise<void>;
}

export interface DistributedConcurrencyLimiter {
  /**
   * Acquires one global slot, waiting up to the configured budget. Throws
   * {@link QueueFullError} when the cluster is at capacity and the wait budget
   * is exhausted. Fails open (returns a no-op slot) on Redis errors.
   */
  acquire(): Promise<GlobalSlot>;
}

/** Minimal shape of the Bun-native RedisClient surface we use. */
export type LimiterRedisClient = RedisClientLike;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Jittered poll delay: `random(0.5, 1.5) * retryMs`. Without jitter, every
 * replica polling this limiter on the same fixed interval falls into lockstep
 * — they all re-check at (roughly) the same instant, so a freed slot is raced
 * by every waiter simultaneously instead of being picked up by whichever
 * happens to poll next. Centred on `retryMs` (not full-jitter's `[0, base]`)
 * because this is a POLL interval, not a backoff: collapsing toward 0 would
 * turn "poll every 50ms" into "poll almost continuously".
 */
function jitteredRetryDelay(retryMs: number): number {
  return retryMs * (0.5 + Math.random());
}

const KEY = "aiperator:concurrency:global";
const NOOP_SLOT: GlobalSlot = { release: async (): Promise<void> => {} };

/**
 * Atomic acquire attempt: evict stale tokens, add ours, count, and — if over
 * capacity — remove ours again, all as ONE Redis command.
 *
 * The previous implementation issued this as four separate round-trips
 * (`ZREMRANGEBYSCORE` → `ZADD` → `ZCARD` → conditional `ZREM`). Two replicas
 * racing to acquire the last slot could both add their token, both `ZCARD`
 * and see a count that includes the OTHER's not-yet-removed token, and both
 * decide they are over capacity and back off — an under-admission that also,
 * under load, synchronises every waiter's retry onto the same failed
 * assumption (worsened further by clients arriving in bursts). Evaluated
 * server-side, this whole decision is a single atomic step: no other client's
 * ZADD/ZCARD/ZREM can interleave with it.
 *
 * Returns 1 (acquired) or 0 (over capacity, our token was not added).
 */
const ACQUIRE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local token = ARGV[3]
local maxConcurrent = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '0', tostring(now - ttlMs))
redis.call('ZADD', key, now, token)
local count = redis.call('ZCARD', key)
if count <= maxConcurrent then
  return 1
else
  redis.call('ZREM', key, token)
  return 0
end`;

/**
 * Heartbeat refresh: re-scores our token to `now` ONLY if it is still present
 * (a slot that was already reaped by TTL eviction — e.g. after an unusually
 * long GC pause — must not be silently resurrected by a heartbeat that
 * assumes it still holds the slot).
 */
const HEARTBEAT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local token = ARGV[2]
if redis.call('ZSCORE', key, token) then
  redis.call('ZADD', key, now, token)
  return 1
else
  return 0
end`;

export interface RedisLimiterOptions {
  /** Maximum simultaneous executions cluster-wide. */
  maxConcurrent: number;
  /**
   * Slot TTL in ms — a crashed holder's slot expires after this if no
   * heartbeat refreshes it. Default = executionTimeout + 30s, here 150000.
   * Must be comfortably larger than `heartbeatIntervalMs` (several multiples)
   * so a single missed heartbeat (a GC pause, a slow event-loop tick) does
   * not cause a live slot to be reaped.
   */
  ttlMs?: number;
  /** Poll interval while waiting for a free slot. Default 50ms. */
  retryMs?: number;
  /** Max time to wait for a slot before rejecting with QueueFullError. Default 10000. */
  maxWaitMs?: number;
  /**
   * Interval (ms) at which a HELD slot re-scores its token so a legitimately
   * long-running execution is not evicted by `ttlMs` mid-flight. Without this,
   * `ttlMs` had to be sized for the SLOWEST possible execution (agent-harness
   * flows can run for many minutes), which meant a genuinely crashed replica's
   * slot leaked for that entire window instead of being reclaimed promptly.
   * Default 30000 (30s) — comfortably below the default 150s TTL.
   */
  heartbeatIntervalMs?: number;
}

export class RedisConcurrencyLimiter implements DistributedConcurrencyLimiter {
  private readonly maxConcurrent: number;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly maxWaitMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly client: LimiterRedisClient,
    opts: RedisLimiterOptions,
    private readonly logger?: Logger,
    private readonly metrics?: Metrics,
  ) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent);
    this.ttlMs = opts.ttlMs ?? 150_000;
    this.retryMs = opts.retryMs ?? 50;
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30_000;
  }

  async acquire(): Promise<GlobalSlot> {
    const token = crypto.randomUUID();
    const deadline = Date.now() + this.maxWaitMs;

    for (;;) {
      const now = Date.now();
      try {
        const result = await this.client.send("EVAL", [
          ACQUIRE_LUA,
          "1",
          KEY,
          String(now),
          String(this.ttlMs),
          token,
          String(this.maxConcurrent),
        ]);
        const acquired = Number(result) === 1;
        if (acquired) return this.makeSlot(token);
        // Over capacity — the Lua script already removed our token.
      } catch (err) {
        // Redis unavailable — fail open (per-replica semaphore still bounds us).
        this.metrics?.recordCounter("aiperator_degraded_total", {
          component: "semaphore",
        });
        this.logger?.warn(
          "Global concurrency limiter Redis error — proceeding without global bound",
          { error: err instanceof Error ? err.message : String(err) },
        );
        return NOOP_SLOT;
      }

      if (Date.now() >= deadline) {
        throw new QueueFullError(this.maxConcurrent);
      }
      await sleep(jitteredRetryDelay(this.retryMs));
    }
  }

  private makeSlot(token: string): GlobalSlot {
    let released = false;
    // Periodically re-score the token so `ttlMs` bounds only a CRASHED
    // holder, not a legitimately long-running one. `unref()` so the timer
    // never keeps the process alive on its own.
    const heartbeat = setInterval(() => {
      void this.client
        .send("EVAL", [HEARTBEAT_LUA, "1", KEY, String(Date.now()), token])
        .catch((err) => {
          this.logger?.warn("Global concurrency slot heartbeat failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, this.heartbeatIntervalMs);
    heartbeat.unref?.();

    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          await this.client.send("ZREM", [KEY, token]);
        } catch (err) {
          // Slot will expire via TTL — non-fatal.
          this.logger?.warn(
            "Global concurrency slot release failed (will expire via TTL)",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      },
    };
  }
}

/**
 * Builds a Redis-backed distributed concurrency limiter using Bun's native
 * RedisClient, or undefined when Redis is unavailable so the caller relies on
 * the per-replica semaphore alone.
 */
export function createRedisConcurrencyLimiter(
  redisUrl: string,
  opts: RedisLimiterOptions,
  logger?: Logger,
  metrics?: Metrics,
): DistributedConcurrencyLimiter | undefined {
  const client = createRedisClient<LimiterRedisClient>(
    redisUrl,
    "Global concurrency limit",
    logger,
  );
  return client
    ? new RedisConcurrencyLimiter(client, opts, logger, metrics)
    : undefined;
}

// ---------------------------------------------------------------------------
// In-memory concurrency limiter (single replica — non-production)
// ---------------------------------------------------------------------------

/**
 * In-memory concurrency limiter for non-production environments. Limits are
 * per-replica only (not cluster-wide). Useful as a fallback when no external
 * store is available.
 */
export class InMemoryConcurrencyLimiter
  implements DistributedConcurrencyLimiter
{
  private active = 0;
  private readonly maxConcurrent: number;
  private readonly maxWaitMs: number;
  private readonly retryMs: number;

  constructor(opts: RedisLimiterOptions) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent);
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
    this.retryMs = opts.retryMs ?? 50;
  }

  async acquire(): Promise<GlobalSlot> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      if (this.active < this.maxConcurrent) {
        this.active++;
        return this.makeSlot();
      }
      if (Date.now() >= deadline) {
        throw new QueueFullError(this.maxConcurrent);
      }
      await sleep(jitteredRetryDelay(this.retryMs));
    }
  }

  private makeSlot(): GlobalSlot {
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }
}

// ---------------------------------------------------------------------------
// StoreFactory-aware concurrency limiter factory (Requirement 2.4)
// ---------------------------------------------------------------------------

import type { StoreFactory } from "../db/store/store.js";
import type { Database } from "../db/database.js";

export interface ConcurrencyLimiterFactoryOptions extends RedisLimiterOptions {
  /** Redis URL — used when the StoreFactory backing is Redis. */
  redisUrl?: string;
  /** Database instance — used when the StoreFactory backing is Postgres. */
  database?: Database;
  /**
   * Metrics sink — fail-open degradations count as
   * `aiperator_degraded_total{component="semaphore"}` (Req 7.8).
   */
  metrics?: Metrics;
}

/**
 * Creates a {@link DistributedConcurrencyLimiter} whose backing is determined
 * by the {@link StoreFactory}. This centralises the backing selection so the
 * semaphore is guaranteed to use the SAME cluster-wide store as all other
 * subsystems (rate-limit, approval-log, etc.), enforcing the limit as a total
 * across all replicas (Requirement 2.4).
 *
 * - `redis` backing → sorted-set-based limiter (self-healing TTL)
 * - `postgres` backing → advisory-lock-based limiter
 * - `memory` backing → in-memory per-replica limiter (non-production)
 *
 * Returns `undefined` only when `maxConcurrent` ≤ 0 (feature disabled).
 */
export function createConcurrencyLimiterFromFactory(
  storeFactory: StoreFactory,
  opts: ConcurrencyLimiterFactoryOptions,
  logger?: Logger,
): DistributedConcurrencyLimiter | undefined {
  if (opts.maxConcurrent <= 0) return undefined;

  const backing = storeFactory.backing();

  switch (backing) {
    case "redis": {
      if (opts.redisUrl === undefined) {
        logger?.warn(
          "Concurrency limiter: StoreFactory is Redis-backed but no Redis URL provided — falling back to in-memory limiter",
        );
        return new InMemoryConcurrencyLimiter(opts);
      }
      const limiter = createRedisConcurrencyLimiter(
        opts.redisUrl,
        opts,
        logger,
        opts.metrics,
      );
      if (limiter !== undefined) return limiter;
      // Redis client creation failed — fall back to in-memory
      logger?.warn(
        "Concurrency limiter: Redis client unavailable — falling back to in-memory limiter",
      );
      return new InMemoryConcurrencyLimiter(opts);
    }
    case "postgres": {
      if (opts.database === undefined) {
        logger?.warn(
          "Concurrency limiter: StoreFactory is Postgres-backed but no database provided — falling back to in-memory limiter",
        );
        return new InMemoryConcurrencyLimiter(opts);
      }
      return new PostgresConcurrencyLimiter(
        opts.database,
        opts,
        logger,
        opts.metrics,
      );
    }
    case "memory":
      return new InMemoryConcurrencyLimiter(opts);
    default:
      return new InMemoryConcurrencyLimiter(opts);
  }
}

// ---------------------------------------------------------------------------
// Postgres-backed concurrency limiter (advisory locks)
// ---------------------------------------------------------------------------

// Validated through the central identifier whitelist (Req 7.10) — the name is
// an internal constant, but it is interpolated into DDL/DML, so it must match
// the safe-identifier shape. Fails fast at module load if it ever does not.
const PG_SEMAPHORE_TABLE = safeSqlIdentifier(
  "distributed_semaphore",
  "semaphore table name",
);
const PG_LOCK_KEY = 778_201_200; // Arbitrary advisory lock key for the semaphore

/**
 * Postgres-backed concurrency limiter using advisory locks and a tracking
 * table. Active slots are stored as rows with an expiry timestamp; stale rows
 * (crashed holders) are evicted before counting.
 *
 * Cluster-wide consistency is guaranteed by `pg_advisory_xact_lock` serialising
 * concurrent acquire/release operations.
 */
export class PostgresConcurrencyLimiter implements DistributedConcurrencyLimiter {
  private readonly maxConcurrent: number;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly maxWaitMs: number;
  private initPromise: Promise<void> | undefined;

  constructor(
    private readonly db: Database,
    opts: RedisLimiterOptions,
    private readonly logger?: Logger,
    private readonly metrics?: Metrics,
  ) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent);
    this.ttlMs = opts.ttlMs ?? 150_000;
    this.retryMs = opts.retryMs ?? 50;
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
  }

  private async ensureTable(): Promise<void> {
    if (this.initPromise === undefined) {
      this.initPromise = this.db
        .query(
          `
        CREATE TABLE IF NOT EXISTS ${PG_SEMAPHORE_TABLE} (
          token TEXT PRIMARY KEY,
          acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `,
        )
        .then(() => {})
        .catch((err) => {
          this.logger?.warn(
            "PostgresConcurrencyLimiter: failed to create table",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
          this.initPromise = undefined;
          throw err;
        });
    }
    return this.initPromise;
  }

  async acquire(): Promise<GlobalSlot> {
    const token = crypto.randomUUID();
    const deadline = Date.now() + this.maxWaitMs;

    try {
      await this.ensureTable();
    } catch (err) {
      // Fail open — per-replica semaphore still applies
      this.metrics?.recordCounter("aiperator_degraded_total", {
        component: "semaphore",
      });
      this.logger?.warn(
        "PostgresConcurrencyLimiter: table init failed — proceeding without global bound",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return NOOP_SLOT;
    }

    for (;;) {
      try {
        const acquired = await this.tryAcquireOnce(token);
        if (acquired) return this.makeSlot(token);
      } catch (err) {
        // Fail open
        this.metrics?.recordCounter("aiperator_degraded_total", {
          component: "semaphore",
        });
        this.logger?.warn(
          "PostgresConcurrencyLimiter: database error — proceeding without global bound",
          { error: err instanceof Error ? err.message : String(err) },
        );
        return NOOP_SLOT;
      }

      if (Date.now() >= deadline) {
        throw new QueueFullError(this.maxConcurrent);
      }
      await sleep(jitteredRetryDelay(this.retryMs));
    }
  }

  /**
   * One acquire attempt, executed as an EXPLICIT transaction on a single pinned
   * connection: take the session's transaction-scoped advisory lock, evict
   * stale rows, insert our token, count. If we're within the cap we COMMIT and
   * keep the token; otherwise we ROLLBACK (which undoes our insert) and return
   * false so the caller retries.
   *
   * Each statement is issued SEPARATELY (never a multi-command string with bind
   * parameters — Postgres' extended/prepared protocol forbids that), and all run
   * on the same reserved connection so `pg_advisory_xact_lock` is actually held
   * for the duration of the transaction rather than acquired-and-released on a
   * connection the later statements might not run on.
   */
  private async tryAcquireOnce(token: string): Promise<boolean> {
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const exec = async (c: Database): Promise<boolean> => {
      await c.query("BEGIN");
      try {
        await c.query(`SELECT pg_advisory_xact_lock(${PG_LOCK_KEY})`);
        await c.query(
          `DELETE FROM ${PG_SEMAPHORE_TABLE} WHERE expires_at < NOW()`,
        );
        await c.query(
          `INSERT INTO ${PG_SEMAPHORE_TABLE} (token, expires_at) VALUES ($1, $2::timestamptz)`,
          [token, expiresAt],
        );
        const rows = await c.query<{ count: string | number }>(
          `SELECT COUNT(*)::int AS count FROM ${PG_SEMAPHORE_TABLE}`,
        );
        const countRow = rows[0];
        const count =
          countRow !== undefined
            ? typeof countRow.count === "number"
              ? countRow.count
              : Number(countRow.count)
            : 0;
        if (Number.isFinite(count) && count <= this.maxConcurrent) {
          await c.query("COMMIT");
          return true;
        }
        await c.query("ROLLBACK");
        return false;
      } catch (err) {
        try {
          await c.query("ROLLBACK");
        } catch {
          /* rollback failure must not mask the original error */
        }
        throw err;
      }
    };
    return this.db.withConnection !== undefined
      ? this.db.withConnection(exec)
      : exec(this.db);
  }

  private makeSlot(token: string): GlobalSlot {
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await this.db.query(
            `DELETE FROM ${PG_SEMAPHORE_TABLE} WHERE token = $1`,
            [token],
          );
        } catch (err) {
          // Slot will expire via TTL — non-fatal
          this.logger?.warn(
            "PostgresConcurrencyLimiter: release failed (will expire via TTL)",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      },
    };
  }
}
