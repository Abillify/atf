// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Idempotency store (`src/graph/idempotency-store.ts`)
 *
 * A network blip or an impatient client can resend the same chat request — and
 * because a flow may execute consequential tool calls (a payment or collections action, a
 * calendar write, a charge), a naive retry would run those side effects twice.
 * An idempotency key makes a retry safe: the first request with a given key
 * runs and its answer is remembered; a later request with the *same* key returns
 * the stored answer instead of re-executing.
 *
 * Semantics follow the widely-used Stripe model:
 *   - first use of a key  → claimed (the caller proceeds and later `complete`s).
 *   - same key, completed → replay the stored response (no re-execution).
 *   - same key, in flight → conflict (the original is still running).
 *   - same key, DIFFERENT request body → mismatch (a key must not be reused for
 *     a different request; the caller rejects with 422).
 *
 * The store is in-memory, bounded (LRU) and TTL'd, with an injected clock for
 * deterministic tests. For a cluster-wide guarantee across replicas, the
 * Redis-backed {@link RedisIdempotencyStore} performs the claim atomically with
 * a Lua script (`SET NX` semantics over a JSON record) so a duplicate retry
 * landing on a *different* replica still replays rather than re-executing.
 *
 * No `any` at module boundaries.
 */

import type { TokenUsage } from "../types/openai.js";
import type { Logger } from "../observability/logger.js";
import {
  createRedisClient,
  type RedisClientLike,
} from "../util/redis-client.js";

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

/** The remembered outcome of a completed request. */
export interface IdempotencyRecord {
  model: string;
  responseText: string;
  usage?: TokenUsage;
  finishReason: "stop" | "error";
  createdAt: string;
}

export type ClaimOutcome =
  | { status: "claimed" }
  | { status: "inflight" }
  | { status: "replay"; record: IdempotencyRecord }
  | { status: "mismatch" };

export interface IdempotencyStore {
  /**
   * Atomically reserves a key for a request fingerprint. See {@link ClaimOutcome}.
   * On "claimed" the caller MUST later call {@link complete} (on success) or
   * {@link release} (on failure) for the same key.
   *
   * Returns synchronously for the in-memory store and a Promise for the
   * Redis-backed (cluster-wide) store — callers `await` the result, which is a
   * no-op for the synchronous case.
   */
  claim(key: string, fingerprint: string): ClaimOutcome | Promise<ClaimOutcome>;
  /** Stores the completed response so future claims of this key replay it. */
  complete(key: string, record: IdempotencyRecord): void | Promise<void>;
  /** Frees an in-flight reservation (e.g. after an execution error) so a retry can proceed. */
  release(key: string): void | Promise<void>;
}

type EntryState = "inflight" | "done";

interface Entry {
  fingerprint: string;
  state: EntryState;
  record?: IdempotencyRecord;
  expiresAt: number;
  touched: number;
}

export interface InMemoryIdempotencyStoreOptions {
  /** Entry TTL in seconds. Default 86400 (24h). */
  ttlSeconds?: number;
  /** Max entries before LRU eviction. Default 10000. */
  maxEntries?: number;
  clock?: Clock;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;
  private seq = 0;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = Math.max(1, options.ttlSeconds ?? 86_400) * 1000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.clock = options.clock ?? Date.now;
  }

  claim(key: string, fingerprint: string): ClaimOutcome {
    const now = this.clock();
    const existing = this.entries.get(key);
    if (existing !== undefined && now <= existing.expiresAt) {
      if (existing.fingerprint !== fingerprint) return { status: "mismatch" };
      existing.touched = ++this.seq;
      if (existing.state === "done" && existing.record !== undefined) {
        return { status: "replay", record: existing.record };
      }
      return { status: "inflight" };
    }
    // New or expired → reserve.
    this.entries.set(key, {
      fingerprint,
      state: "inflight",
      expiresAt: now + this.ttlMs,
      touched: ++this.seq,
    });
    this.evictIfNeeded();
    return { status: "claimed" };
  }

  complete(key: string, record: IdempotencyRecord): void {
    const existing = this.entries.get(key);
    // Only transition our own reservation; ignore unknown/expired keys.
    if (existing === undefined) return;
    existing.state = "done";
    existing.record = record;
    existing.expiresAt = this.clock() + this.ttlMs;
    existing.touched = ++this.seq;
  }

  release(key: string): void {
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.state === "inflight") {
      this.entries.delete(key);
    }
  }

  /** Current entry count (diagnostics/tests). */
  size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let lruKey: string | undefined;
      let lruTouched = Infinity;
      for (const [k, e] of this.entries) {
        if (e.touched < lruTouched) {
          lruTouched = e.touched;
          lruKey = k;
        }
      }
      if (lruKey === undefined) break;
      this.entries.delete(lruKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis-backed store (cluster-wide)
// ---------------------------------------------------------------------------

/** Minimal shape of the Bun-native RedisClient surface we use. */
export type IdempotencyRedisClient = RedisClientLike;

const KEY_PREFIX = "aiperator:idem";

// Atomic claim: inspect the stored JSON record and decide the outcome in one
// round-trip. Returns one of the literals "claimed"/"inflight"/"mismatch", or
// the stored JSON string when a completed record exists (caller decodes it).
const CLAIM_LUA = `
local v = redis.call('GET', KEYS[1])
if v then
  local ok, e = pcall(cjson.decode, v)
  if not ok then redis.call('DEL', KEYS[1]) else
    if e.fp ~= ARGV[1] then return 'mismatch' end
    if e.state == 'done' then return v end
    return 'inflight'
  end
end
redis.call('SET', KEYS[1], cjson.encode({fp = ARGV[1], state = 'inflight'}), 'EX', ARGV[2])
return 'claimed'`;

// Complete: store the done record (preserving the fingerprint), resetting TTL.
const COMPLETE_LUA = `
local v = redis.call('GET', KEYS[1])
local fp = ''
if v then local ok, e = pcall(cjson.decode, v); if ok then fp = e.fp end end
redis.call('SET', KEYS[1], cjson.encode({fp = fp, state = 'done', record = ARGV[1]}), 'EX', ARGV[2])
return 1`;

// Release: delete only an in-flight reservation (a completed record is kept).
const RELEASE_LUA = `
local v = redis.call('GET', KEYS[1])
if v then
  local ok, e = pcall(cjson.decode, v)
  if ok and e.state == 'inflight' then return redis.call('DEL', KEYS[1]) end
end
return 0`;

export interface RedisIdempotencyStoreOptions {
  /** Entry TTL in seconds. Default 86400 (24h). */
  ttlSeconds?: number;
}

/**
 * Cluster-wide idempotency via Bun's native RedisClient. The claim is a single
 * atomic Lua script so two concurrent retries (even on different replicas) can
 * never both be "claimed". On any Redis error the store fails OPEN (returns
 * "claimed"), preserving availability — a cache outage degrades the guarantee
 * to "may re-execute" rather than blocking the request.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly ttlSeconds: number;

  constructor(
    private readonly client: IdempotencyRedisClient,
    private readonly logger?: Logger,
    opts: RedisIdempotencyStoreOptions = {},
  ) {
    this.ttlSeconds = Math.max(1, opts.ttlSeconds ?? 86_400);
  }

  private key(key: string): string {
    return `${KEY_PREFIX}:${key}`;
  }

  async claim(key: string, fingerprint: string): Promise<ClaimOutcome> {
    try {
      const res = await this.client.send("EVAL", [
        CLAIM_LUA,
        "1",
        this.key(key),
        fingerprint,
        String(this.ttlSeconds),
      ]);
      const str = typeof res === "string" ? res : String(res);
      if (str === "claimed") return { status: "claimed" };
      if (str === "inflight") return { status: "inflight" };
      if (str === "mismatch") return { status: "mismatch" };
      // Otherwise it is the stored JSON record for a completed key.
      const parsed = JSON.parse(str) as {
        record?: string;
      };
      if (parsed.record !== undefined) {
        const record = JSON.parse(parsed.record) as IdempotencyRecord;
        return { status: "replay", record };
      }
      return { status: "inflight" };
    } catch (err) {
      this.logger?.warn(
        "Idempotency claim Redis error — failing open (claimed)",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return { status: "claimed" };
    }
  }

  async complete(key: string, record: IdempotencyRecord): Promise<void> {
    try {
      await this.client.send("EVAL", [
        COMPLETE_LUA,
        "1",
        this.key(key),
        JSON.stringify(record),
        String(this.ttlSeconds),
      ]);
    } catch (err) {
      this.logger?.warn(
        "Idempotency complete Redis error (key will expire via TTL)",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  async release(key: string): Promise<void> {
    try {
      await this.client.send("EVAL", [RELEASE_LUA, "1", this.key(key)]);
    } catch (err) {
      this.logger?.warn(
        "Idempotency release Redis error (key will expire via TTL)",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}

/**
 * Creates a cluster-wide Redis idempotency store using Bun's native
 * RedisClient, or returns undefined when Redis is unavailable so the caller
 * falls back to the per-replica in-memory store.
 */
export function createRedisIdempotencyStore(
  redisUrl: string,
  logger?: Logger,
  opts?: RedisIdempotencyStoreOptions,
): IdempotencyStore | undefined {
  const client = createRedisClient<IdempotencyRedisClient>(
    redisUrl,
    "Distributed idempotency",
    logger,
  );
  return client ? new RedisIdempotencyStore(client, logger, opts) : undefined;
}
