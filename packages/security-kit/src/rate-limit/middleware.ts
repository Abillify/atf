// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * middleware.ts
 *
 * HTTP middleware around the GCRA core (Req 11.1/11.2): one shared
 * implementation of the per-client request budget the ATF services used to
 * each hand-roll. Without an explicit `backend` the decision is made by the
 * memory backend's synchronous path, so the middleware answers within the
 * current tick like the hand-rolled sliding windows it replaces.
 *
 * Multi-replica: pass `backend: createRedisRateLimitBackend(client)` and the
 * whole budget is shared across replicas (one atomic Lua check per request).
 * A backend without a synchronous `takeSync` makes the middleware return a
 * promise — Express and Hono both await that. If an async backend throws,
 * the request fails OPEN (availability first, matching the Runtime limiter)
 * and `onBackendError` is invoked for logging/metrics; the kit's Redis
 * backend never throws — it applies its own `failMode` internally.
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
 *   without bound. (`maxKeys`/`nowUs` apply to the default memory backend
 *   only — a shared backend owns its own state policy.)
 *
 * `max: 0` disables limiting entirely. The types are structural so the kit
 * stays free of an Express dependency.
 */

import type { RateLimitBackend, RateLimitResult } from "./gcra.ts";
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
  /**
   * Returns a promise only when the backend has no synchronous path (e.g.
   * Redis); with the default memory backend the decision stays in the
   * current tick. Express/Hono both accept either shape.
   */
  middleware(
    req: RateLimitRequest,
    res: RateLimitResponse,
    next: () => void,
  ): void | Promise<void>;
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
  /**
   * Shared decision backend, e.g. `createRedisRateLimitBackend(client)` so
   * several replicas enforce ONE budget. Defaults to a process-local memory
   * backend (per-replica budget — fine for a single replica).
   */
  backend?: RateLimitBackend;
  /**
   * Hook invoked when an async backend throws (the request then fails open).
   * For logging/metrics. Not called for the memory backend, which cannot throw.
   */
  onBackendError?: (err: unknown) => void;
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
    backend: sharedBackend,
    onBackendError,
  } = options;

  const config = { limit: max, burstMs: windowMs };

  // The memory backend exposes a synchronous path; a shared backend (Redis)
  // may not, in which case the middleware returns a promise and the decision
  // happens after an await.
  const takeSync =
    sharedBackend === undefined
      ? (() => {
          const backendOptions: MemoryBackendOptions = { maxKeys };
          if (nowUs !== undefined) backendOptions.nowUs = nowUs;
          return createMemoryRateLimitBackend(backendOptions).takeSync;
        })()
      : (
          sharedBackend as Partial<
            ReturnType<typeof createMemoryRateLimitBackend>
          >
        ).takeSync;

  const deny = (res: RateLimitResponse, result: RateLimitResult): void => {
    res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    res.status(429).json(rejectBody);
  };

  const clientKey = (req: RateLimitRequest): string =>
    trustProxy
      ? (req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
        req.socket?.remoteAddress ??
        "unknown")
      : (req.socket?.remoteAddress ?? "unknown");

  const middleware = (
    req: RateLimitRequest,
    res: RateLimitResponse,
    next: () => void,
  ): void | Promise<void> => {
    const ip = clientKey(req);
    if (takeSync !== undefined) {
      const result = takeSync(ip, config, 1);
      if (!result.allowed) {
        deny(res, result);
        return;
      }
      next();
      return;
    }
    // Async backend: await the shared decision. A backend error fails OPEN
    // (the request proceeds) so a store outage degrades to "no limiting"
    // rather than blocking all traffic — the kit's Redis backend applies its
    // own failMode internally and does not rely on this path. Reaching this
    // branch without a backend is impossible (the memory backend always
    // provides `takeSync`), but guard anyway instead of asserting.
    if (sharedBackend === undefined) {
      next();
      return;
    }
    return sharedBackend.take(ip, config, 1).then(
      (result) => {
        if (!result.allowed) {
          deny(res, result);
          return;
        }
        next();
      },
      (err: unknown) => {
        onBackendError?.(err);
        next();
      },
    );
  };

  return {
    middleware,
    // The memory backend cleans up opportunistically — nothing to stop, but
    // the API keeps a shutdown hook so callers do not special-case backends.
    close() {},
  };
}
