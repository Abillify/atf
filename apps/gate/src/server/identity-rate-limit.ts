// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

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
 * Fixed-window counter, one bucket per identity key. Cheap, dependency-free,
 * correct for a single instance. Buckets are lazily swept on access (no
 * background timer needed): once a bucket's window has elapsed, it resets on
 * the next check() for that key.
 */
class MemoryIdentityRateLimiter implements IdentityRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }
    bucket.count++;
    if (bucket.count > this.max) {
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    }
    return { allowed: true };
  }
}

/** Minimal shape of the parts of the redis client we use (mirrors rate-limit-store.ts). */
interface RedisLike {
  connect(): Promise<unknown>;
  sendCommand(args: string[]): Promise<unknown>;
  on?(event: string, listener: (err: Error) => void): void;
}

/**
 * Redis-backed fixed-window counter, shared across instances. Uses a single
 * INCR + (conditional) PEXPIRE per check — no separate script/library needed
 * beyond the same optional `redis` package used by the IP-based limiter.
 */
class RedisIdentityRateLimiter implements IdentityRateLimiter {
  constructor(
    private readonly client: RedisLike,
    private readonly windowMs: number,
    private readonly max: number,
    private readonly prefix: string,
  ) {}

  async check(key: string): Promise<RateLimitDecision> {
    const redisKey = `${this.prefix}${key}`;
    const count = Number(await this.client.sendCommand(["INCR", redisKey]));
    if (count === 1) {
      await this.client.sendCommand(["PEXPIRE", redisKey, String(this.windowMs)]);
    }
    if (count > this.max) {
      const ttl = Number(await this.client.sendCommand(["PTTL", redisKey]));
      return { allowed: false, retryAfterMs: ttl > 0 ? ttl : this.windowMs };
    }
    return { allowed: true };
  }

  async close(): Promise<void> {
    await (this.client as unknown as { quit?: () => Promise<unknown> }).quit?.();
  }
}

/**
 * Build the per-identity rate limiter described by
 * `server.rateLimit.perIdentity`, or `undefined` when disabled. Independent
 * of (and additive to) the IP-based limiter in server/rate-limit-store.ts.
 */
export async function createIdentityRateLimiter(
  cfg: ServerConfig["rateLimit"]["perIdentity"],
): Promise<IdentityRateLimiter | undefined> {
  if (!cfg.enabled) return undefined;

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
    client.on?.("error", (err: Error) => logger.error(`identity rate-limit redis error: ${err.message}`));
    await client.connect();
    logger.info(`per-identity rate limiting using shared redis store at ${cfg.store.redisUrl}`);
    return new RedisIdentityRateLimiter(client, cfg.windowMs, cfg.max, cfg.store.prefix);
  }

  return new MemoryIdentityRateLimiter(cfg.windowMs, cfg.max);
}
