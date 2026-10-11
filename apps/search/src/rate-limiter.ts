// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { RequestHandler } from "express";
import { createRateLimitMiddleware } from "@atf/security-kit";

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
 * Pass max=0 to disable rate limiting entirely.
 */
export function createRateLimiter(options: {
  max: number;
  windowMs: number;
  trustProxy?: boolean;
  maxKeys?: number;
}): RateLimiter {
  const limiter = createRateLimitMiddleware(options);
  return {
    middleware: limiter.middleware as unknown as RequestHandler,
    close: limiter.close,
  };
}
