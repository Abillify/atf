// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { RequestHandler } from "express";
import {
  createLazyRedisRateLimitBackend,
  createRateLimitMiddleware,
} from "@atf/security-kit";

export interface RateLimiter {
  middleware: RequestHandler;
  /** Release limiter resources. Call during graceful shutdown. */
  close(): void;
}

/**
 * Per-IP rate limiter built on the shared `@atf/security-kit` GCRA core
 * (Req 11.2). The kit middleware is typed structurally so it stays free of
 * an Express dependency; the shapes line up with Express's
 * `Request`/`Response`, hence the cast here.
 *
 * Verhaltensunterschied to the previous hand-rolled sliding window: the
 * bucket now refills smoothly (one credit per `windowMs/max`) instead of
 * dropping whole hits at the window edge. Every pinned contract still
 * holds: `max` back-to-back requests pass, the next one is denied with
 * `Retry-After`, limits are per-IP, and `max: 0` disables limiting.
 *
 * With `redisUrl` set, the budget is shared across replicas through the
 * kit's Redis GCRA backend (one atomic Lua script per check, lazily
 * connected); without it, the limit is per-process — which is why the
 * production readiness gate flags `REPLICAS > 1` without
 * `RATE_LIMIT_REDIS_URL`. On Redis errors the limiter fails open —
 * availability parity with the in-memory limiter it replaces.
 *
 * Pass max=0 to disable rate limiting entirely.
 */
export function createRateLimiter(options: {
  max: number;
  windowMs: number;
  trustProxy?: boolean;
  maxKeys?: number;
  redisUrl?: string | null;
  logger?: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}): RateLimiter {
  const redisBackend =
    options.redisUrl && options.max > 0
      ? createLazyRedisRateLimitBackend({
          redisUrl: options.redisUrl,
          keyPrefix: "vectorsearch:rl",
          failMode: "open",
          onError: (err) =>
            options.logger?.warn(
              { err },
              "rate limit redis error — failing open",
            ),
          onConnect: () =>
            options.logger?.info(
              {},
              "rate limiter backed by shared Redis store",
            ),
        })
      : null;
  const limiter = createRateLimitMiddleware({
    ...options,
    ...(redisBackend ? { backend: redisBackend } : {}),
  });
  return {
    middleware: limiter.middleware as unknown as RequestHandler,
    close: () => {
      limiter.close();
      void redisBackend?.close().catch((err) => {
        options.logger?.warn({ err }, "error closing rate limit redis client");
      });
    },
  };
}
