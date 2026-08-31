// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Thread Lock (`src/graph/thread-lock.ts`)
 *
 * Serialises concurrent executions that target the SAME conversation thread
 * (`conversation_id`). Without this, two requests for one conversation can run
 * against the same LangGraph checkpoint concurrently and interleave their
 * state writes, corrupting the thread's history or losing turns.
 *
 * Two implementations:
 *   - {@link InProcessThreadLock} — a per-key async mutex. Correct for a single
 *     replica (the common case) and always used as the in-process guard.
 *   - {@link RedisThreadLock} — a distributed lock (Bun-native RedisClient,
 *     `SET key token NX PX` + token-checked release via Lua) so serialisation
 *     also holds across replicas when REDIS_URL is configured.
 *
 * Both fail SAFE for liveness: acquisition has a bounded wait, and on any lock
 * backend error the request is allowed to proceed (a missed lock degrades to
 * the prior behaviour rather than deadlocking traffic).
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Logger } from "../observability/logger.js";
import {
  createRedisClient,
  type RedisClientLike,
} from "../util/redis-client.js";

export interface ThreadLockHandle {
  /** Releases the lock. Safe to call exactly once. */
  release(): Promise<void>;
}

export interface ThreadLockAcquireOptions {
  /**
   * Max time to wait for the lock. On expiry the lock is NOT taken and the
   * caller proceeds anyway (fail-open for liveness — see the module note).
   * Omitted/0 = wait indefinitely.
   */
  maxWaitMs?: number;
  /** Give up waiting when this fires (e.g. the flow's execution-timeout signal). */
  signal?: AbortSignal;
}

export interface ThreadLock {
  /** Acquires the lock for `key`, returning a handle whose `release()` frees it. */
  acquire(
    key: string,
    opts?: ThreadLockAcquireOptions,
  ): Promise<ThreadLockHandle>;
}

/** A handle that owns nothing — returned when acquisition failed open. */
const NOOP_HANDLE: ThreadLockHandle = {
  release: async (): Promise<void> => {},
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Jittered poll delay: `random(0.5, 1.5) * retryMs`. Without jitter, every
 * waiter for the same conversation lock polls on the same fixed interval and
 * falls into lockstep, so a freed lock is raced by every waiter at once rather
 * than picked up by whichever happens to poll next.
 */
function jitteredRetryDelay(retryMs: number): number {
  return retryMs * (0.5 + Math.random());
}

/**
 * Awaits `promise` under a wait budget and an optional abort signal.
 *
 * Reports the outcome instead of throwing, because both callers fail OPEN on
 * expiry: the distinction they need is "did we actually get our turn", not "was
 * it a timer or a signal". Never leaves a dangling timer or listener, and never
 * rejects — a rejection from `promise` itself counts as "our turn arrived",
 * since the previous holder finishing (however it finished) is what we waited
 * for.
 */
async function waitWithBudget(
  promise: Promise<unknown>,
  opts: ThreadLockAcquireOptions,
): Promise<{ acquired: boolean; aborted: boolean; waitedMs: number }> {
  const maxWaitMs = opts.maxWaitMs ?? 0;
  const startedAt = Date.now();

  if (maxWaitMs <= 0 && opts.signal === undefined) {
    await promise.catch(() => undefined);
    return { acquired: true, aborted: false, waitedMs: Date.now() - startedAt };
  }
  if (opts.signal?.aborted === true) {
    return { acquired: false, aborted: true, waitedMs: 0 };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  // Recorded by the listener rather than re-read from `signal.aborted` after the
  // race: the early return above narrows that property to `false | undefined`
  // for the rest of the function, so a later read cannot express "it fired
  // while we waited".
  let firedByAbort = false;
  const GAVE_UP = Symbol("gave-up");

  try {
    const budget = new Promise<typeof GAVE_UP>((resolve) => {
      if (maxWaitMs > 0) timer = setTimeout(() => resolve(GAVE_UP), maxWaitMs);
      if (opts.signal !== undefined) {
        onAbort = (): void => {
          firedByAbort = true;
          resolve(GAVE_UP);
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    const outcome = await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      budget,
    ]);
    return {
      acquired: outcome !== GAVE_UP,
      aborted: outcome === GAVE_UP && firedByAbort,
      waitedMs: Date.now() - startedAt,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined && opts.signal !== undefined) {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// In-process keyed mutex
// ---------------------------------------------------------------------------

/**
 * A per-key FIFO async mutex. Each key serialises its waiters by chaining
 * promises; map entries are removed once the chain for a key drains, so memory
 * stays bounded by the number of *currently contended* keys.
 */
export class InProcessThreadLock implements ThreadLock {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly logger?: Logger) {}

  async acquire(
    key: string,
    opts: ThreadLockAcquireOptions = {},
  ): Promise<ThreadLockHandle> {
    const prev = this.tails.get(key) ?? Promise.resolve();

    let releaseInner!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseInner = resolve;
    });

    // The new tail completes only after the previous holder AND this holder.
    const newTail = prev.then(() => current);
    this.tails.set(key, newTail);

    // Wait for our turn — but not forever.
    //
    // An unbounded wait here was the second half of the head-of-line cascade:
    // one stalled run on a conversation blocked every later turn of that thread
    // indefinitely, each blocked turn holding a concurrency slot while waiting.
    // On expiry we fail OPEN (proceed without the lock) rather than rejecting,
    // matching RedisThreadLock's documented behaviour and the module contract:
    // a missed lock risks interleaved checkpoint writes, whereas a blocked
    // request is a guaranteed outage.
    const waited = await waitWithBudget(prev, opts);
    if (!waited.acquired) {
      this.logger?.warn(
        waited.aborted
          ? "Thread lock wait aborted (execution timeout) — proceeding without the lock; " +
              "concurrent checkpoint writes for this conversation are possible"
          : "Thread lock wait budget exhausted — proceeding without the lock; " +
              "concurrent checkpoint writes for this conversation are possible",
        { key, waitedMs: waited.waitedMs },
      );
      // Give up our place in the chain immediately, otherwise every waiter
      // behind us would stay blocked on a holder that never runs.
      releaseInner();
      if (this.tails.get(key) === newTail) this.tails.delete(key);
      return NOOP_HANDLE;
    }

    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        releaseInner();
        // Cleanup: if no one queued behind us, drop the key.
        if (this.tails.get(key) === newTail) {
          this.tails.delete(key);
        }
      },
    };
  }

  /** Number of keys with an active or queued holder (diagnostics/tests). */
  get size(): number {
    return this.tails.size;
  }
}

// ---------------------------------------------------------------------------
// Redis distributed lock (cluster-wide)
// ---------------------------------------------------------------------------

/** Minimal shape of the Bun-native RedisClient surface we use. */
export type LockRedisClient = RedisClientLike;

const LOCK_PREFIX = "aiperator:threadlock";
// Release script: delete the key only if we still own it (token match).
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface RedisThreadLockOptions {
  /** Lock TTL in ms — an upper bound on how long one execution may hold it. Default 120000. */
  ttlMs?: number;
  /** Poll interval while waiting for a contended lock. Default 50ms. */
  retryMs?: number;
  /** Max time to wait for the lock before proceeding anyway (fail-open). Default 30000. */
  maxWaitMs?: number;
}

export class RedisThreadLock implements ThreadLock {
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly maxWaitMs: number;
  /** In-process guard layered under Redis so same-replica waiters don't busy-poll Redis. */
  private readonly local = new InProcessThreadLock();

  constructor(
    private readonly client: LockRedisClient,
    private readonly logger?: Logger,
    opts: RedisThreadLockOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.retryMs = opts.retryMs ?? 50;
    this.maxWaitMs = opts.maxWaitMs ?? 30_000;
  }

  async acquire(
    key: string,
    opts: ThreadLockAcquireOptions = {},
  ): Promise<ThreadLockHandle> {
    // Honour the caller's budget when it is tighter than the configured one.
    // Compute the deadline before the local guard: local + Redis contention
    // must share one bounded wait instead of each receiving a fresh budget.
    const effectiveWaitMs =
      opts.maxWaitMs !== undefined && opts.maxWaitMs > 0
        ? Math.min(opts.maxWaitMs, this.maxWaitMs)
        : this.maxWaitMs;
    const deadline = Date.now() + effectiveWaitMs;

    // First serialise within this replica cheaply. Applying the effective cap
    // here is essential: passing the raw execution timeout (one hour in
    // production) allowed a same-replica holder to block before the Redis
    // deadline below was ever reached.
    const localHandle = await this.local.acquire(key, {
      ...opts,
      maxWaitMs: effectiveWaitMs,
    });

    const rkey = `${LOCK_PREFIX}:${key}`;
    const token = crypto.randomUUID();

    try {
      // Spin on SET NX PX until acquired or the wait budget is exhausted.
      for (;;) {
        let ok = false;
        try {
          const res = await this.client.send("SET", [
            rkey,
            token,
            "NX",
            "PX",
            String(this.ttlMs),
          ]);
          ok = res === "OK" || res === true;
        } catch (err) {
          // Redis unavailable — fail open: rely on the in-process lock only.
          this.logger?.warn(
            "Thread lock Redis error — proceeding with local lock only",
            {
              key,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          return localHandle;
        }
        if (ok) break;
        if (opts.signal?.aborted === true) {
          this.logger?.warn(
            "Thread lock wait aborted (execution timeout) — proceeding anyway",
            { key },
          );
          break;
        }
        if (Date.now() >= deadline) {
          this.logger?.warn(
            "Thread lock wait budget exhausted — proceeding anyway",
            { key },
          );
          break;
        }
        await sleep(jitteredRetryDelay(this.retryMs));
      }
    } catch {
      return localHandle;
    }

    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await this.client.send("EVAL", [RELEASE_LUA, "1", rkey, token]);
        } catch (err) {
          this.logger?.warn("Thread lock release error (will expire via TTL)", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await localHandle.release();
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a distributed Redis thread lock using Bun's native RedisClient, or
 * returns undefined when Redis is unavailable so the caller falls back to the
 * in-process lock.
 */
export function createRedisThreadLock(
  redisUrl: string,
  logger?: Logger,
  opts?: RedisThreadLockOptions,
): ThreadLock | undefined {
  const client = createRedisClient<LockRedisClient>(
    redisUrl,
    "Distributed thread lock",
    logger,
  );
  return client ? new RedisThreadLock(client, logger, opts) : undefined;
}
