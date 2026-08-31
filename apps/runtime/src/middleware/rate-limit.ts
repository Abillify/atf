// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Rate-Limit Middleware (`src/middleware/rate-limit.ts`)
 *
 * Fixed-window rate limiter for `/v1/*` routes, keyed by caller identity
 * (Bearer token by default, falling back to forwarded IP). Returns HTTP 429
 * with a `Retry-After` header when the per-window budget is exhausted.
 *
 * Backing store selection is centralised via {@link StoreFactory} from
 * `src/db/store`. The factory's `counter(namespace)` provides the atomic
 * increment operation cluster-wide (Redis/Postgres) or per-replica (memory).
 * Legacy ad-hoc Redis/in-memory stores are retained for backward compatibility
 * but new consumers should pass a `CounterStore` via `createStoreBackedRateLimitStore`.
 *
 * Availability: Store errors fail OPEN (the request is allowed) so a store
 * outage degrades to "no limiting" rather than blocking all traffic.
 *
 * No `any` at module boundaries.
 */

import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { getConnInfo } from "hono/bun";
import crypto from "node:crypto";
import {
  AUTH_PRINCIPAL_KEY,
  extractBearerToken,
  type AuthContext,
  type AuthPrincipal,
} from "./auth.js";
import type { Logger } from "../observability/logger.js";
import { createRedisClient } from "../util/redis-client.js";
import type { CounterStore } from "../db/store/index.js";

const WINDOW_MS = 60_000;
const REDIS_KEY_PREFIX = "aiperator:ratelimit";

// ---------------------------------------------------------------------------
// Store abstraction
// ---------------------------------------------------------------------------

/** Result of registering a hit against a key's current window. */
export interface RateLimitHit {
  /** Number of hits recorded in the current window (including this one). */
  count: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

/**
 * Backing store for fixed-window counters. Implementations must be safe to call
 * concurrently and atomic per (key, window).
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory store (single replica)
// ---------------------------------------------------------------------------

interface WindowState {
  /** Start (epoch ms) of the current window bucket. */
  windowStart: number;
  /** Hits recorded in the current window bucket. */
  current: number;
  /** Hits recorded in the immediately previous window bucket. */
  previous: number;
}

/**
 * Sliding-window-counter estimate. Weights the previous window by the fraction
 * of it still overlapping the rolling window, smoothing out the burst-at-the-
 * boundary problem of a naive fixed window (which allows up to 2× the limit
 * across a boundary).
 */
function slidingEstimate(
  state: WindowState,
  now: number,
  windowMs: number,
): number {
  const elapsed = now - state.windowStart;
  const prevWeight = Math.max(0, (windowMs - elapsed) / windowMs);
  return state.current + state.previous * prevWeight;
}

/** Creates an in-memory sliding-window store with periodic eviction of stale keys. */
export function createInMemoryStore(): RateLimitStore {
  const windows = new Map<string, WindowState>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, state] of windows) {
      // Drop keys whose current AND previous windows are both fully in the past.
      if (state.windowStart + 2 * WINDOW_MS <= now) windows.delete(key);
    }
  }, WINDOW_MS);
  (sweep as unknown as { unref?: () => void }).unref?.();

  return {
    async hit(key: string, windowMs: number): Promise<RateLimitHit> {
      const now = Date.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      let state = windows.get(key);
      if (state === undefined) {
        state = { windowStart, current: 0, previous: 0 };
        windows.set(key, state);
      } else if (state.windowStart !== windowStart) {
        // Roll the window forward. Carry the previous count only if the last
        // bucket was the immediately preceding window; otherwise it's stale.
        state.previous =
          state.windowStart === windowStart - windowMs ? state.current : 0;
        state.current = 0;
        state.windowStart = windowStart;
      }
      state.current += 1;
      const estimate = slidingEstimate(state, now, windowMs);
      return { count: Math.ceil(estimate), resetAt: windowStart + windowMs };
    },
    async close(): Promise<void> {
      clearInterval(sweep);
      windows.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Redis store (cluster-wide)
// ---------------------------------------------------------------------------

/** Minimal shape of the Bun-native RedisClient commands we use. */
interface RedisCommandClient {
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<unknown>;
  close?(): void;
}

/**
 * Creates a Redis-backed sliding-window-counter store using Bun's native
 * RedisClient. Returns undefined when the runtime does not expose RedisClient
 * (e.g. older Bun), letting the caller fall back to the in-memory store.
 *
 * Algorithm: two adjacent fixed buckets derived from wall-clock time (so every
 * replica agrees on the boundaries). `INCR` on the current bucket is atomic;
 * the previous bucket is read and weighted by its remaining overlap with the
 * rolling window, smoothing the fixed-window boundary burst. The first writer
 * of a bucket sets an `EXPIRE` so keys self-clean after two windows.
 */
export function createRedisRateLimitStore(
  redisUrl: string,
  logger?: Logger,
): RateLimitStore | undefined {
  const client = createRedisClient<RedisCommandClient>(
    redisUrl,
    "Redis rate limiting",
    logger,
  );
  if (client === undefined) return undefined;

  return {
    async hit(key: string, windowMs: number): Promise<RateLimitHit> {
      const now = Date.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const prevStart = windowStart - windowMs;
      const resetAt = windowStart + windowMs;
      const currKey = `${REDIS_KEY_PREFIX}:${key}:${windowStart}`;
      const prevKey = `${REDIS_KEY_PREFIX}:${key}:${prevStart}`;

      const current = await client.incr(currKey);
      if (current === 1) {
        // First writer in this bucket sets the TTL (two windows + grace).
        try {
          await client.expire(currKey, Math.ceil((windowMs * 2) / 1000) + 1);
        } catch {
          /* TTL best-effort; key still expires via subsequent windows */
        }
      }

      let previous = 0;
      try {
        const raw = await client.get(prevKey);
        if (raw !== null) {
          const n = Number.parseInt(raw, 10);
          if (Number.isFinite(n)) previous = n;
        }
      } catch {
        /* previous bucket unreadable — treat as 0 (conservative, fail-open) */
      }

      const elapsed = now - windowStart;
      const prevWeight = Math.max(0, (windowMs - elapsed) / windowMs);
      const estimate = current + previous * prevWeight;
      return { count: Math.ceil(estimate), resetAt };
    },
    async close(): Promise<void> {
      client.close?.();
    },
  };
}

// ---------------------------------------------------------------------------
// StoreFactory-backed adapter (Requirement 1.3 — no duplicated store pattern)
// ---------------------------------------------------------------------------

/**
 * Creates a {@link RateLimitStore} backed by a {@link CounterStore} from the
 * central {@link StoreFactory}. This eliminates ad-hoc Redis/in-memory store
 * creation inside this file — the backing selection is centralised in
 * `bootstrap/persistence.ts`.
 *
 * The counter store uses fixed-window buckets, so the estimate returned is the
 * raw counter WITHOUT sliding-window smoothing. The `CounterStore` contract
 * guarantees atomic cluster-wide increments within a window, so the count is
 * exact — but a fixed window still allows up to ~2× the limit across a window
 * boundary (a caller can spend the full budget at the end of one window and the
 * full budget again at the start of the next). When that boundary burst matters,
 * configure `REDIS_URL`: the bootstrap then prefers {@link createRedisRateLimitStore},
 * which weights the previous window for a true sliding-window counter. This
 * adapter is the fallback when Redis is not available.
 */
export function createStoreBackedRateLimitStore(
  counter: CounterStore<string>,
): RateLimitStore {
  return {
    async hit(key: string, windowMs: number): Promise<RateLimitHit> {
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;
      const count = await counter.incr(key, 1, windowMs);
      return { count, resetAt };
    },
  };
}

// ---------------------------------------------------------------------------
// Identity extraction
// ---------------------------------------------------------------------------

/** Full, deterministic digest used wherever a credential contributes to a key. */
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** Default identity key: digested Bearer token, else the historical IP bucket. */
export function legacyRateLimitKey(headers: {
  authorization?: string;
  forwardedFor?: string;
  realIp?: string;
}): string {
  const token = extractBearerToken(headers.authorization);
  if (token !== null) {
    return `legacy:credential:sha256:${sha256(token)}`;
  }
  const ip =
    headers.forwardedFor?.split(",")[0]?.trim() ??
    headers.realIp ??
    "anonymous";
  return `ip:${ip}`;
}

/**
 * Builds a composite rate-limit key that scopes limiting to a (tenant, user)
 * pair. This is the "user-level" rate limiter — it lets a shared tenant have
 * many users without any single user exhausting the shared token-level budget.
 */
/**
 * Extracts the `sub` (subject) claim from a JWT WITHOUT verifying its signature.
 * Used ONLY as a rate-limit bucket key — never for authorization. A forged
 * `sub` cannot help an attacker exceed limits: they would still be bounded by
 * the token/IP-level limiter, and picking a different bucket only rate-limits a
 * different key. Returns null when the token is absent or malformed.
 */
function decodeJwtSub(authHeader: string | undefined): string | null {
  const token = extractBearerToken(authHeader);
  if (token === null) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(payloadB64, "base64").toString("utf-8");
    const claims = JSON.parse(json) as Record<string, unknown>;
    const sub = claims.sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Builds a per-user rate-limit key from the signals available at middleware
 * time (before the full RequestContext is built). Priority:
 *   1. Open WebUI user id header (`X-OpenWebUI-User-Id`), optionally scoped by
 *      an `X-OpenWebUI-User-Role`-independent tenant header when present.
 *   2. The JWT `sub` claim (decoded, unverified — key only).
 * Returns null when no per-user identity can be derived, so the caller skips
 * the per-user limit and relies on the token/IP-level limiter alone.
 */
export function userScopedKeyFn(headers: {
  authorization?: string;
  owuiUserId?: string;
  tenantId?: string;
}): string | null {
  const owui = headers.owuiUserId;
  const user =
    owui !== undefined && owui !== ""
      ? owui
      : (decodeJwtSub(headers.authorization) ?? undefined);
  if (user === undefined) return null;
  const tenant =
    headers.tenantId !== undefined && headers.tenantId !== ""
      ? headers.tenantId
      : "_";
  return `tenant:${tenant}:user:${user}`;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Creates a fixed-window rate-limit middleware.
 *
 * @param limitPerMinute Maximum requests per identity per 60s window.
 *                       Values <= 0 disable limiting (pass-through middleware).
 * @param store          Backing store. Defaults to a fresh in-memory store.
 * @param logger         Optional logger for store errors.
 * @param failMode       Behaviour when the backing store errors. "open" (default)
 *                       allows the request through so a store outage never blocks
 *                       traffic; "closed" rejects with HTTP 503 so abuse cannot
 *                       slip past during an outage. Choose "closed" when abuse
 *                       protection outweighs availability.
 * @param userLimitPerMinute When set, applies an ADDITIONAL per-(tenant,user) limit
 *                           so that individual users within a shared tenant cannot
 *                           exhaust the shared token-level budget. Requires the
 *                           `tenantId` and `userId` extractors to be set via
 *                           `userContext`. Falls back to token-level limiting when
 *                           the context is unavailable.
 */
export function rateLimitMiddleware(
  limitPerMinute: number,
  store?: RateLimitStore,
  logger?: Logger,
  failMode: "open" | "closed" = "open",
  userLimitPerMinute = 0,
): MiddlewareHandler {
  if (limitPerMinute <= 0 && userLimitPerMinute <= 0) {
    return createMiddleware(async (_ctx, next) => {
      await next();
    });
  }

  const backing = store ?? createInMemoryStore();

  return createMiddleware(async (ctx, next) => {
    const authHeader = ctx.req.header("Authorization");
    const forwardedFor = ctx.req.header("X-Forwarded-For");
    const realIp = ctx.req.header("X-Real-IP");

    // ── Token/IP-level limit (existing behaviour) ───────────────────────────
    if (limitPerMinute > 0) {
      const key = legacyRateLimitKey({ authorization: authHeader, forwardedFor, realIp });
      let result: RateLimitHit;
      try {
        result = await backing.hit(key, WINDOW_MS);
      } catch (err) {
        if (failMode === "closed") {
          logger?.warn("Rate-limit store error — rejecting request (fail-closed)", {
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.header("Retry-After", "5");
          return ctx.json(
            { error: { message: "Rate limiter temporarily unavailable. Retry shortly.", type: "rate_limit_error" } },
            503,
          );
        }
        logger?.warn("Rate-limit store error — allowing request (fail-open)", {
          error: err instanceof Error ? err.message : String(err),
        });
        await next();
        return;
      }

      const remaining = Math.max(0, limitPerMinute - result.count);
      ctx.header("X-RateLimit-Limit", String(limitPerMinute));
      ctx.header("X-RateLimit-Remaining", String(remaining));
      ctx.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

      if (result.count > limitPerMinute) {
        const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
        ctx.header("Retry-After", String(retryAfterSec));
        return ctx.json(
          { error: { message: "Rate limit exceeded. Slow down and retry shortly.", type: "rate_limit_error" } },
          429,
        );
      }
    }

    // ── Per-user limit (user-level limiting) ────────────────────────────────
    // Derives the user identity from headers available at middleware time (the
    // Open WebUI user id header, else the decoded JWT `sub`). When no per-user
    // identity can be derived, this limit is skipped and the token/IP-level
    // limiter above is the only gate.
    if (userLimitPerMinute > 0) {
      const userKey = userScopedKeyFn({
        ...(authHeader !== undefined ? { authorization: authHeader } : {}),
        ...(ctx.req.header("X-OpenWebUI-User-Id") !== undefined
          ? { owuiUserId: ctx.req.header("X-OpenWebUI-User-Id") }
          : {}),
        ...(ctx.req.header("X-Tenant-Id") !== undefined
          ? { tenantId: ctx.req.header("X-Tenant-Id") }
          : {}),
      });

      if (userKey !== null) {
        let userResult: RateLimitHit;
        try {
          userResult = await backing.hit(userKey, WINDOW_MS);
        } catch {
          if (failMode === "closed") {
            ctx.header("Retry-After", "5");
            return ctx.json(
              { error: { message: "Rate limiter temporarily unavailable. Retry shortly.", type: "rate_limit_error" } },
              503,
            );
          }
          // fail-open: skip user-level check
          await next();
          return;
        }

        const userRemaining = Math.max(0, userLimitPerMinute - userResult.count);
        ctx.header("X-RateLimit-User-Limit", String(userLimitPerMinute));
        ctx.header("X-RateLimit-User-Remaining", String(userRemaining));

        if (userResult.count > userLimitPerMinute) {
          const retryAfterSec = Math.max(1, Math.ceil((userResult.resetAt - Date.now()) / 1000));
          ctx.header("Retry-After", String(retryAfterSec));
          return ctx.json(
            {
              error: {
                message: `Per-user rate limit exceeded (${userLimitPerMinute} req/min). Slow down and retry shortly.`,
                type: "rate_limit_error",
              },
            },
            429,
          );
        }
      }
    }

    await next();
  });
}

// ---------------------------------------------------------------------------
// Additive authentication-boundary limits
// ---------------------------------------------------------------------------

/** Stable pre-auth key from the transport peer, never caller headers. */
export function preAuthRateLimitKey(remoteAddress?: string): string {
  return `pre-auth:ip:${remoteAddress ?? "anonymous"}`;
}

/**
 * Stable post-auth key derived exclusively from the verified principal. The
 * digest keeps subject/tenant identifiers out of backing-store keys while the
 * namespace prevents collisions with legacy and pre-auth buckets.
 */
export function postAuthRateLimitKey(
  principal: AuthPrincipal | undefined,
): string | null {
  if (principal?.verified !== true) return null;
  const subject =
    typeof principal.claims?.sub === "string" && principal.claims.sub !== ""
      ? principal.claims.sub
      : "_";
  const tenant = principal.tenantId ?? "_";
  return `post-auth:principal:sha256:${sha256(
    `${principal.method}\u0000${tenant}\u0000${subject}`,
  )}`;
}

function boundaryRateLimitMiddleware(opts: {
  limitPerMinute: number;
  store?: RateLimitStore;
  logger?: Logger;
  failMode: "open" | "closed";
  boundary: "Pre-Auth" | "Post-Auth";
  key: (ctx: Parameters<MiddlewareHandler<AuthContext>>[0]) => string | null;
}): MiddlewareHandler<AuthContext> {
  if (opts.limitPerMinute <= 0) {
    return createMiddleware<AuthContext>(async (_ctx, next) => {
      await next();
    });
  }

  const backing = opts.store ?? createInMemoryStore();
  return createMiddleware<AuthContext>(async (ctx, next) => {
    const key = opts.key(ctx);
    if (key === null) {
      await next();
      return;
    }

    let result: RateLimitHit;
    try {
      result = await backing.hit(key, WINDOW_MS);
    } catch (err) {
      if (opts.failMode === "closed") {
        opts.logger?.warn(
          `${opts.boundary} rate-limit store error — rejecting request (fail-closed)`,
          { error: err instanceof Error ? err.message : String(err) },
        );
        ctx.header("Retry-After", "5");
        return ctx.json(
          {
            error: {
              message: "Rate limiter temporarily unavailable. Retry shortly.",
              type: "rate_limit_error",
            },
          },
          503,
        );
      }
      opts.logger?.warn(
        `${opts.boundary} rate-limit store error — allowing request (fail-open)`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      await next();
      return;
    }

    const prefix = `X-RateLimit-${opts.boundary}`;
    ctx.header(`${prefix}-Limit`, String(opts.limitPerMinute));
    ctx.header(
      `${prefix}-Remaining`,
      String(Math.max(0, opts.limitPerMinute - result.count)),
    );
    ctx.header(`${prefix}-Reset`, String(Math.ceil(result.resetAt / 1000)));

    if (result.count > opts.limitPerMinute) {
      ctx.header(
        "Retry-After",
        String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))),
      );
      return ctx.json(
        {
          error: {
            message: "Rate limit exceeded. Slow down and retry shortly.",
            type: "rate_limit_error",
          },
        },
        429,
      );
    }
    await next();
  });
}

/** IP-based additive limiter intended to be mounted immediately before auth. */
export function preAuthRateLimitMiddleware(
  limitPerMinute: number,
  store?: RateLimitStore,
  logger?: Logger,
  failMode: "open" | "closed" = "open",
): MiddlewareHandler<AuthContext> {
  return boundaryRateLimitMiddleware({
    limitPerMinute,
    ...(store !== undefined ? { store } : {}),
    ...(logger !== undefined ? { logger } : {}),
    failMode,
    boundary: "Pre-Auth",
    key: (ctx) => {
      try {
        return preAuthRateLimitKey(getConnInfo(ctx).remote.address);
      } catch {
        // Hono unit tests and non-Bun embeddings may not provide a server
        // adapter. Use one conservative shared bucket rather than trusting
        // caller-controlled forwarding headers.
        return preAuthRateLimitKey();
      }
    },
  });
}

/** Verified-principal/tenant additive limiter intended to be mounted after auth. */
export function postAuthRateLimitMiddleware(
  limitPerMinute: number,
  store?: RateLimitStore,
  logger?: Logger,
  failMode: "open" | "closed" = "open",
): MiddlewareHandler<AuthContext> {
  return boundaryRateLimitMiddleware({
    limitPerMinute,
    ...(store !== undefined ? { store } : {}),
    ...(logger !== undefined ? { logger } : {}),
    failMode,
    boundary: "Post-Auth",
    key: (ctx) => postAuthRateLimitKey(ctx.get(AUTH_PRINCIPAL_KEY)),
  });
}
