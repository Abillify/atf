// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * redis.ts
 *
 * Redis GCRA backend. The whole check is one Lua script so the read of the
 * TAT, the GCRA arithmetic and the write back happen atomically server-side —
 * two replicas racing on the same key cannot both consume the same cell.
 *
 * The client is a minimal structural interface (`eval`), satisfied by the
 * `redis` package client (v4/v5 options-object form:
 * `eval(script, { keys, arguments })`); no dependency on a specific client
 * version. The legacy v3 positional form `eval(script, numKeys, keys, args)`
 * is NOT compatible with redis v4+ — there it is parsed as an options object,
 * the keys/args are silently dropped and the script runs with zero keys.
 */

import type { GcraConfig, RateLimitBackend, RateLimitResult } from "./gcra.ts";

export interface RedisEvalClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: (string | number)[] },
  ): Promise<unknown>;
}

export interface RedisBackendOptions {
  /** Key prefix to avoid collisions with other users of the same Redis (default "rl"). */
  keyPrefix?: string;
  /** Fail open (allow) or closed (deny) when Redis errors (default "closed"). */
  failMode?: "open" | "closed";
  /** Error hook for logging/metrics. */
  onError?: (err: unknown) => void;
}

/**
 * KEYS[1] = limiter key
 * ARGV[1] = emission microseconds per cell
 * ARGV[2] = window microseconds (limit * emission)
 * ARGV[3] = cost (cells)
 * ARGV[4] = now microseconds
 * Returns { allowed(0/1), remaining, retryAfterMs, resetAfterMs, tatUs }
 */
export const GCRA_LUA = `
local key = KEYS[1]
local emission = tonumber(ARGV[1])
local fill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local raw = redis.call("GET", key)
local tat = now
if raw then tat = tonumber(raw) end
if tat < now then tat = now end

local new_tat = tat + cost * emission
local delay = new_tat - now
if delay > fill then
  local retry_ms = math.ceil((new_tat - fill - now) / 1000)
  local reset_ms = math.ceil((tat - now) / 1000)
  -- keep the (clamped) TAT so an idle key still expires
  redis.call("SET", key, tostring(tat), "PX", math.max(math.ceil((tat - now) / 1000) + fill / 1000, 1))
  return {0, 0, retry_ms, reset_ms, tat}
end

local limit = math.floor(fill / emission)
local remaining = math.floor((fill - delay) / emission)
if remaining < 0 then remaining = 0 end
if remaining > limit - 1 then remaining = limit - 1 end
local reset_ms = math.ceil((new_tat - now) / 1000)
redis.call("SET", key, tostring(new_tat), "PX", math.max(math.ceil((new_tat - now) / 1000) + 1, math.ceil(fill / 1000)))
return {1, remaining, 0, reset_ms, new_tat}
`;

export function createRedisRateLimitBackend(
  client: RedisEvalClient,
  options: RedisBackendOptions = {},
): RateLimitBackend {
  const keyPrefix = options.keyPrefix ?? "rl";
  const failMode = options.failMode ?? "closed";
  const onError = options.onError;

  const take = async (key: string, config: GcraConfig, cost = 1): Promise<RateLimitResult> => {
    const emissionUs = (config.burstMs * 1000) / config.limit;
    const fillUs = config.limit * emissionUs;
    const nowUs = Date.now() * 1000;
    try {
      const raw = (await client.eval(GCRA_LUA, {
        keys: [`${keyPrefix}:${key}`],
        arguments: [emissionUs, fillUs, cost, nowUs],
      })) as (number | string)[];
      const allowed = Number(raw[0]) === 1;
      return {
        allowed,
        limit: config.limit,
        remaining: Number(raw[1] ?? 0),
        retryAfterMs: Number(raw[2] ?? 0),
        resetAfterMs: Number(raw[3] ?? 0),
      };
    } catch (err) {
      onError?.(err);
      if (failMode === "open") {
        return { allowed: true, limit: config.limit, remaining: config.limit, retryAfterMs: 0, resetAfterMs: 0 };
      }
      return { allowed: false, limit: config.limit, remaining: 0, retryAfterMs: config.burstMs, resetAfterMs: config.burstMs };
    }
  };

  return { take };
}

/** Structural shape of the `redis` package pieces the lazy backend uses (v4/v5 API). */
interface RedisClientLike {
  eval(
    script: string,
    options: { keys: string[]; arguments: (string | number)[] },
  ): Promise<unknown>;
  connect(): Promise<unknown>;
  on?(event: string, listener: (err: Error) => void): void;
  quit?(): Promise<unknown>;
}

interface RedisModuleLike {
  createClient(options: { url: string }): RedisClientLike;
}

export interface LazyRedisBackendOptions {
  /** Connection URL, e.g. `redis://:pw@host:6379/0`. */
  redisUrl: string;
  /** Key prefix to avoid collisions with other users of the same Redis (default "rl"). */
  keyPrefix?: string;
  /** Fail open (allow) or closed (deny) when Redis errors (default "closed"). */
  failMode?: "open" | "closed";
  /** Error hook for logging/metrics. */
  onError?: (err: unknown) => void;
  /** Called once after the client connects successfully. */
  onConnect?: () => void;
}

export interface LazyRedisRateLimitBackend extends RateLimitBackend {
  /** Quit the Redis client if it was ever connected. Idempotent. */
  close(): Promise<void>;
}

/**
 * Redis GCRA backend that connects lazily: the `redis` package is loaded and
 * the client connects on the first `take()` (cached promise), so building an
 * HTTP server stays synchronous and startup does not hard-depend on Redis
 * availability. A failed connect is not cached — the next request retries.
 *
 * The `redis` package is imported dynamically by name so the kit itself keeps
 * no dependency on it; services that set a Redis URL must install it
 * (`bun add redis` / it ships in their image).
 */
export function createLazyRedisRateLimitBackend(
  options: LazyRedisBackendOptions,
): LazyRedisRateLimitBackend {
  const keyPrefix = options.keyPrefix ?? "rl";
  const failMode = options.failMode ?? "closed";
  let connecting: Promise<{ backend: RateLimitBackend; client: RedisClientLike }> | null =
    null;

  const connect = () => {
    if (!connecting) {
      connecting = (async () => {
        const redisName = "redis";
        let redisMod: RedisModuleLike;
        try {
          redisMod = (await import(redisName)) as unknown as RedisModuleLike;
        } catch {
          throw new Error(
            `A Redis rate limit backend is configured but the "${redisName}" package is not installed. Install it with: bun add redis`,
          );
        }
        const client = redisMod.createClient({ url: options.redisUrl });
        client.on?.("error", (err) => options.onError?.(err));
        await client.connect();
        options.onConnect?.();
        return {
          backend: createRedisRateLimitBackend(client, {
            keyPrefix,
            failMode,
            onError: options.onError,
          }),
          client,
        };
      })();
      // Do not cache a failed connect — the next request retries.
      connecting.catch(() => {
        connecting = null;
      });
    }
    return connecting;
  };

  return {
    take: async (key, config, cost) => {
      const { backend } = await connect();
      return backend.take(key, config, cost);
    },
    close: async () => {
      const pending = connecting;
      if (!pending) return;
      const settled = await pending.catch(() => null);
      if (settled) await settled.client.quit?.();
    },
  };
}
