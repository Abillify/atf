// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * middleware.ts
 *
 * HTTP middleware around the GCRA core (Req 11.1/11.2): one shared
 * implementation of the per-client request budget the ATF services used to
 * each hand-roll. The decision is made by the memory backend's synchronous
 * path, so the middleware answers within the current tick like the
 * hand-rolled sliding windows it replaces.
 *
 * Semantics (GCRA, `limit` cells over `burstMs`): up to `limit` requests may
 * fire back-to-back, then the bucket refills at one cell per `burstMs/limit`
 * — the same "limit per window with smooth refill" contract, without the
 * fixed-window double-burst at boundaries.
 *
 * Security notes:
 * - `trustProxy: true` only behind a trusted reverse proxy. When false
 *   (default), the TCP connection address is used, which makes
 *   `X-Forwarded-For` spoofing impossible.
 * - The key store is bounded (`maxKeys`); the entries whose buckets fill
 *   soonest are evicted first, so many unique source IPs cannot grow memory
 *   without bound.
 *
 * `max: 0` disables limiting entirely. The types are structural so the kit
 * stays free of an Express dependency.
 */

import {
  createMemoryRateLimitBackend,
  type MemoryBackendOptions,
} from "./memory.ts";

/** The request parts the middleware reads — structurally satisfied by Express. */
export interface RateLimitRequest {
  socket?: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
}

/** The response parts the middleware writes — structurally satisfied by Express. */
export interface RateLimitResponse {
  setHeader(name: string, value: string | number): unknown;
  status(code: number): { json(body: unknown): unknown };
}

export interface RateLimitMiddleware {
  middleware(
    req: RateLimitRequest,
    res: RateLimitResponse,
    next: () => void,
  ): void;
  /** Release resources. Call during graceful shutdown. Idempotent. */
  close(): void;
}

export interface RateLimitMiddlewareOptions {
  /** Requests allowed per `windowMs`; 0 disables the limiter. */
  max: number;
  /** Refill window in milliseconds. */
  windowMs: number;
  /** Trust the leftmost `X-Forwarded-For` entry (trusted proxy only). */
  trustProxy?: boolean;
  /** Maximum tracked client keys before eviction (default 50 000). */
  maxKeys?: number;
  /** Body sent with HTTP 429. Defaults to `{ error: "Too Many Requests" }`. */
  rejectBody?: Record<string, unknown>;
  /** Clock injection for tests (microseconds). */
  nowUs?: () => number;
}

const DEFAULT_REJECT_BODY: Record<string, unknown> = {
  error: "Too Many Requests",
};

export function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions,
): RateLimitMiddleware {
  if (options.max === 0) {
    return {
      middleware: (_req, _res, next) => next(),
      close() {},
    };
  }

  const {
    max,
    windowMs,
    trustProxy = false,
    maxKeys = 50_000,
    rejectBody = DEFAULT_REJECT_BODY,
    nowUs,
  } = options;

  const backendOptions: MemoryBackendOptions = { maxKeys };
  if (nowUs !== undefined) backendOptions.nowUs = nowUs;
  const backend = createMemoryRateLimitBackend(backendOptions);
  const config = { limit: max, burstMs: windowMs };

  const middleware = (
    req: RateLimitRequest,
    res: RateLimitResponse,
    next: () => void,
  ): void => {
    const ip = trustProxy
      ? (req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
        req.socket?.remoteAddress ??
        "unknown")
      : (req.socket?.remoteAddress ?? "unknown");

    const result = backend.takeSync(ip, config, 1);
    if (!result.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json(rejectBody);
      return;
    }
    next();
  };

  return {
    middleware,
    // The memory backend cleans up opportunistically — nothing to stop, but
    // the API keeps a shutdown hook so callers do not special-case backends.
    close() {},
  };
}
