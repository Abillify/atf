// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
  createMemoryRateLimitBackend,
  createRedisRateLimitBackend,
  type FailMode,
  type GcraConfig,
  type RateLimitBackend,
} from "@atf/security-kit";
import type { ServerConfig } from "../config/schema.ts";
import { logger } from "../logger.ts";

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the caller may retry, when `allowed` is false. */
  retryAfterMs?: number;
}

/** A limiter that can be checked per-identity-key on every MCP request. */
export interface IdentityRateLimiter {
  check(key: string): Promise<RateLimitDecision>;
  close?(): Promise<void>;
}

/**
 * Adapter from the Security_Kit GCRA backend to the gate's
 * `IdentityRateLimiter` surface. The GCRA emission interval is
 * `windowMs / max`, so `max` requests fit into `windowMs` on average while
 * a full burst of `max` is still allowed instantly — a smooth, atomic
 * replacement for the previous fixed-window counter (Req 6.9).
 */
class GcraIdentityRateLimiter implements IdentityRateLimiter {
  constructor(
    private readonly backend: RateLimitBackend,
    private readonly config: GcraConfig,
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const result = await this.backend.take(key, this.config, 1);
    return result.allowed
      ? { allowed: true }
      : { allowed: false, retryAfterMs: result.retryAfterMs };
  }
}

/** Minimal shape of the parts of the redis client we use (mirrors rate-limit-store.ts). */
interface RedisLike {
  connect(): Promise<unknown>;
  sendCommand(args: string[]): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: (string | number)[] },
  ): Promise<unknown>;
  on?(event: string, listener: (err: Error) => void): void;
  quit?(): Promise<unknown>;
}

/**
 * Build the per-identity rate limiter described by
 * `server.rateLimit.perIdentity`, or `undefined` when disabled. Independent
 * of (and additive to) the IP-based limiter in server/rate-limit-store.ts.
 *
 * Backed by the Security_Kit GCRA limiters (Req 6.9/11.2): the memory
 * backend is atomic per process with bounded key growth; the Redis backend
 * runs the whole check as one Lua script so replicas cannot consume the
 * same cell. `failMode` decides what happens when Redis errors — `closed`
 * (default) rejects, `open` lets traffic through.
 */
export async function createIdentityRateLimiter(
  cfg: ServerConfig["rateLimit"]["perIdentity"],
): Promise<IdentityRateLimiter | undefined> {
  if (!cfg.enabled) return undefined;

  const config: GcraConfig = { limit: cfg.max, burstMs: cfg.windowMs };
  const failMode: FailMode = cfg.failMode;

  if (cfg.store.type === "redis") {
    if (!cfg.store.redisUrl) {
      throw new Error(
        "server.rateLimit.perIdentity.store.redisUrl is required when store.type is 'redis'",
      );
    }
    let redisMod: { createClient: (opts: { url: string }) => RedisLike };
    try {
      const redisName = "redis";
      redisMod = (await import(redisName)) as typeof redisMod;
    } catch {
      throw new Error(
        "server.rateLimit.perIdentity.store.type is 'redis' but the optional 'redis' package is " +
          "missing. Install it with: bun add redis",
      );
    }
    const client = redisMod.createClient({ url: cfg.store.redisUrl });
    client.on?.("error", (err: Error) =>
      logger.error(`identity rate-limit redis error: ${err.message}`),
    );
    await client.connect();
    logger.info(
      `per-identity rate limiting (GCRA, failMode=${failMode}) using shared redis store at ${cfg.store.redisUrl}`,
    );
    const backend = createRedisRateLimitBackend(client, {
      // The configured prefix historically ends in ':'; the kit backend
      // joins with ':' itself, so strip one to keep the old key shape.
      keyPrefix: cfg.store.prefix.replace(/:$/, ""),
      failMode,
      onError: (err) =>
        logger.error(
          `identity rate-limit redis check failed (failMode=${failMode}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
    });
    const limiter = new GcraIdentityRateLimiter(backend, config);
    return {
      check: (key) => limiter.check(key),
      close: async () => {
        await client.quit?.();
      },
    };
  }

  const limiter = new GcraIdentityRateLimiter(
    createMemoryRateLimitBackend(),
    config,
  );
  return { check: (key) => limiter.check(key) };
}
