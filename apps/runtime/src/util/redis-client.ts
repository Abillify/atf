// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared Bun RedisClient adapter (`src/util/redis-client.ts`)
 *
 * Every Redis-backed store (idempotency, jobs, response cache, distributed
 * semaphore, thread lock, rate limiter, …) used to repeat the same ~12 lines:
 * probe `globalThis.RedisClient`, log-and-return-undefined when it is missing
 * (off-Bun / Redis not wired), construct it inside a try/catch, and fall back
 * to the in-memory variant on failure. That boilerplate was copied verbatim
 * into a dozen files — a drift hazard and noise.
 *
 * This module owns that resolution once. Callers pass a human-readable
 * `purpose` (used in the fallback log line) and the concrete client surface
 * they need as the type parameter `T` — the stores use slightly different
 * subsets of the Redis command API (`send`, or `incr`/`get`, or get/set), so
 * `T` defaults to the common low-level {@link RedisClientLike} but can be any
 * structural shape the caller casts to.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";

/**
 * The low-level Redis surface most stores use: a single `send(command, args)`
 * entrypoint (for `EVAL`/`SET`/`GET`/…) plus an optional `close`. Stores that
 * need a richer typed surface declare their own interface and pass it as `T`.
 */
export interface RedisClientLike {
  send(command: string, args: string[]): Promise<unknown>;
  close?(): void;
}

/** Bun exposes its native client as the `RedisClient` global. */
type RedisCtor = new (url: string) => unknown;

function resolveRedisCtor(): RedisCtor | undefined {
  const ctor = (globalThis as { RedisClient?: RedisCtor }).RedisClient;
  return typeof ctor === "function" ? ctor : undefined;
}

/**
 * Constructs a Bun RedisClient for `purpose`, or returns `undefined` (logged at
 * warn) so the caller degrades to its in-memory variant. Resolution and
 * construction never throw into the caller.
 *
 * @param redisUrl Redis connection URL.
 * @param purpose  Short capability name for the fallback log line, e.g.
 *                 "Distributed job store" or "Redis rate limiting".
 * @param logger   Optional logger for the unavailable/failure paths.
 * @typeParam T    The client surface the caller needs (defaults to
 *                 {@link RedisClientLike}).
 */
export function createRedisClient<T = RedisClientLike>(
  redisUrl: string,
  purpose: string,
  logger?: Logger,
): T | undefined {
  const Ctor = resolveRedisCtor();
  if (Ctor === undefined) {
    logger?.warn(
      `${purpose}: Bun RedisClient is unavailable; falling back to the in-memory variant`,
    );
    return undefined;
  }
  try {
    return new Ctor(redisUrl) as T;
  } catch (err) {
    logger?.warn(
      `${purpose}: failed to create the Redis client; falling back to the in-memory variant`,
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }
}
