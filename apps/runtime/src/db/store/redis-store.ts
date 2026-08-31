// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Redis-backed Store implementation (`src/db/store/redis-store.ts`)
 *
 * Uses Bun's native RedisClient via the shared `createRedisClient` utility.
 * Key-value operations use GET/SET with PX (millisecond TTL). Counter uses an
 * atomic Lua script that performs INCRBY + conditional PEXPIRE within a single
 * round-trip to guarantee cluster-wide consistency (Requirement 2.4).
 *
 * No `any` at module boundaries.
 */

import type { Store, CounterStore, StoreFactory } from "./store.js";
import {
  createRedisClient,
  type RedisClientLike,
} from "../../util/redis-client.js";
import type { Logger } from "../../observability/logger.js";

// ---------------------------------------------------------------------------
// Key serialisation helper
// ---------------------------------------------------------------------------

function serializeKey(key: unknown): string {
  if (typeof key === "string") return key;
  return JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// Lua: atomic INCRBY with window-based expiry
// ---------------------------------------------------------------------------

/**
 * Atomically increments a counter by ARGV[1] and sets PEXPIRE to ARGV[2] ms
 * only if the key has no TTL yet (i.e. first increment in a new window).
 * Returns the new counter value after the increment.
 */
const INCR_WINDOW_LUA = `
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return v`;

// ---------------------------------------------------------------------------
// RedisStore (key-value)
// ---------------------------------------------------------------------------

class RedisStore<K, V> implements Store<K, V> {
  constructor(
    private readonly client: RedisClientLike,
    private readonly namespace: string,
  ) {}

  private key(k: K): string {
    return `${this.namespace}:${serializeKey(k)}`;
  }

  async get(key: K): Promise<V | undefined> {
    const raw = await this.client.send("GET", [this.key(key)]);
    if (raw === null || raw === undefined) return undefined;
    const str = typeof raw === "string" ? raw : String(raw);
    try {
      return JSON.parse(str) as V;
    } catch {
      return undefined;
    }
  }

  async set(key: K, value: V, opts?: { ttlMs?: number }): Promise<void> {
    const serialized = JSON.stringify(value);
    if (opts?.ttlMs !== undefined && opts.ttlMs > 0) {
      await this.client.send("SET", [
        this.key(key),
        serialized,
        "PX",
        String(opts.ttlMs),
      ]);
    } else {
      await this.client.send("SET", [this.key(key), serialized]);
    }
  }

  async delete(key: K): Promise<void> {
    await this.client.send("DEL", [this.key(key)]);
  }
}

// ---------------------------------------------------------------------------
// RedisCounterStore
// ---------------------------------------------------------------------------

class RedisCounterStore<K> implements CounterStore<K> {
  constructor(
    private readonly client: RedisClientLike,
    private readonly namespace: string,
  ) {}

  private key(k: K, windowMs: number): string {
    // Fixed-window bucket: floor(now / windowMs) * windowMs
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    return `${this.namespace}:${serializeKey(k)}:${windowStart}`;
  }

  async incr(key: K, by: number, windowMs: number): Promise<number> {
    const redisKey = this.key(key, windowMs);
    const res = await this.client.send("EVAL", [
      INCR_WINDOW_LUA,
      "1",
      redisKey,
      String(Math.max(1, Math.round(by))),
      String(windowMs),
    ]);
    const value = typeof res === "number" ? res : Number(res);
    return Number.isFinite(value) ? value : 0;
  }
}

// ---------------------------------------------------------------------------
// RedisStoreFactory
// ---------------------------------------------------------------------------

export interface RedisStoreFactoryOptions {
  /** Redis connection URL. */
  url: string;
  /** Optional logger for connection/fallback messages. */
  logger?: Logger;
}

/**
 * Factory producing namespace-isolated Redis-backed stores.
 * Uses Bun's native RedisClient under the hood.
 */
export class RedisStoreFactory implements StoreFactory {
  private readonly client: RedisClientLike;

  constructor(options: RedisStoreFactoryOptions) {
    const client = createRedisClient<RedisClientLike>(
      options.url,
      "RedisStoreFactory",
      options.logger,
    );
    if (client === undefined) {
      throw new Error(
        "RedisStoreFactory: Bun RedisClient is unavailable — cannot construct Redis-backed store",
      );
    }
    this.client = client;
  }

  keyValue<K, V>(namespace: string): Store<K, V> {
    return new RedisStore<K, V>(this.client, namespace);
  }

  counter<K>(namespace: string): CounterStore<K> {
    return new RedisCounterStore<K>(this.client, namespace);
  }

  backing(): "redis" {
    return "redis";
  }
}
