// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Store } from "express-rate-limit";
import type { ServerConfig } from "../config/schema.ts";
import { logger } from "../logger.ts";

/**
 * Build the backing store for express-rate-limit.
 *
 * - `memory` (default): returns `undefined` so express-rate-limit uses its
 *   built-in in-process store. Correct for a single instance.
 * - `redis`: returns a shared Redis-backed store so the limit is enforced
 *   across instances behind a load balancer. The `redis` and `rate-limit-redis`
 *   packages are optional and loaded lazily; a clear error is thrown when the
 *   store is selected but the packages are not installed.
 *
 * The factory is async so the (optional) Redis client can connect before the
 * limiter middleware is constructed.
 */
export async function createRateLimitStore(
  cfg: ServerConfig["rateLimit"],
): Promise<Store | undefined> {
  const store = cfg.store;
  if (!store || store.type === "memory") return undefined;

  if (store.type === "redis") {
    if (!store.redisUrl) {
      throw new Error("server.rateLimit.store.redisUrl is required when store.type is 'redis'");
    }
    let redisMod: { createClient: (opts: { url: string }) => RedisLike };
    let rlRedisMod: { RedisStore: new (opts: RedisStoreOptions) => Store };
    try {
      // Variable specifiers keep these out of the static dependency graph so the
      // build does not require the optional packages to be present.
      const redisName = "redis";
      const rlRedisName = "rate-limit-redis";
      redisMod = (await import(redisName)) as typeof redisMod;
      rlRedisMod = (await import(rlRedisName)) as typeof rlRedisMod;
    } catch {
      throw new Error(
        "server.rateLimit.store.type is 'redis' but the optional packages are missing. " +
          "Install them with: bun add redis rate-limit-redis",
      );
    }

    const client = redisMod.createClient({ url: store.redisUrl });
    client.on?.("error", (err: Error) => logger.error(`rate-limit redis error: ${err.message}`));
    await client.connect();
    logger.info(`rate limiting using shared redis store at ${store.redisUrl}`);

    return new rlRedisMod.RedisStore({
      sendCommand: (...args: string[]) => client.sendCommand(args),
      prefix: store.prefix,
    });
  }

  return undefined;
}

/** Minimal shape of the parts of the redis client we use. */
interface RedisLike {
  connect(): Promise<unknown>;
  sendCommand(args: string[]): Promise<unknown>;
  on?(event: string, listener: (err: Error) => void): void;
}

interface RedisStoreOptions {
  sendCommand: (...args: string[]) => Promise<unknown>;
  prefix?: string;
}
