// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * rate-limiter.ts
 *
 * In-memory sliding-window rate limiter (per IP, no dependencies), same
 * implementation as `apps/search/src/rate-limiter.ts`.
 *
 * A true sliding window rather than a fixed one: with fixed windows a client can
 * send 2× the limit across a window boundary. That matters more here than in a
 * read service, because every accepted request spawns a document converter and
 * spends model tokens — a burst is a bill, not just load.
 *
 * Security notes:
 *  - `trustProxy: true` only behind a trusted reverse proxy. When false, the TCP
 *    address is used, which makes `X-Forwarded-For` spoofing impossible.
 *  - Per-IP hit arrays are bounded to `max`, so memory is O(max) per active IP.
 *  - The IP store is bounded to `maxKeys`; the oldest 10% are evicted when it is
 *    exceeded, so many unique source IPs cannot grow memory without bound.
 *
 * `max: 0` disables limiting entirely.
 */

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
 * `RATE_LIMIT_REDIS_URL`. On Redis errors the limiter fails open: a Redis
 * outage must not take the whole service down; the errors are logged.
 *
 * `max: 0` disables limiting entirely.
 */
export function createRateLimiter(options: {
  max: number;
  windowMs: number;
  trustProxy?: boolean;
  maxKeys?: number;
  redisUrl?: string | null;
  /** Redis key prefix — must differ per limiter sharing the same Redis. */
  keyPrefix?: string;
  logger?: {
    info(obj: unknown, msg?: string): void;
    warn(obj: unknown, msg?: string): void;
  };
}): RateLimiter {
  const redisBackend =
    options.redisUrl && options.max > 0
      ? createLazyRedisRateLimitBackend({
          redisUrl: options.redisUrl,
          keyPrefix: options.keyPrefix ?? "extract:rl",
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
    rejectBody: {
      error: "Too Many Requests",
      code: "RATE_LIMITED",
      retryable: true,
    },
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
