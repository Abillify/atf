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

interface Hit {
  /** Timestamp of the request in ms. */
  ts: number;
}

export interface RateLimiter {
  middleware: RequestHandler;
  /** Stop the background cleanup interval. Call during graceful shutdown. */
  close(): void;
}

export function createRateLimiter(options: {
  max: number;
  windowMs: number;
  trustProxy?: boolean;
  maxKeys?: number;
}): RateLimiter {
  if (options.max === 0) {
    return {
      middleware: (_req, _res, next) => next(),
      close() {},
    };
  }

  const { max, windowMs, trustProxy = false, maxKeys = 50_000 } = options;
  const store = new Map<string, Hit[]>();

  const cleanupInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, hits] of store) {
      const fresh = hits.filter((h) => h.ts > cutoff);
      if (fresh.length === 0) store.delete(key);
      else store.set(key, fresh);
    }
  }, windowMs).unref();

  function evictOldest(): void {
    const evictCount = Math.ceil(store.size * 0.1);
    let deleted = 0;
    for (const key of store.keys()) {
      store.delete(key);
      if (++deleted >= evictCount) break;
    }
  }

  const middleware: RequestHandler = (req, res, next) => {
    const ip = trustProxy
      ? ((req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        "unknown")
      : (req.socket.remoteAddress ?? "unknown");

    const now = Date.now();
    const cutoff = now - windowMs;
    let hits = store.get(ip);

    if (!hits) {
      if (store.size >= maxKeys) evictOldest();
      store.set(ip, [{ ts: now }]);
      next();
      return;
    }

    // Entries are ascending, so everything expired is at the front.
    let pruneIdx = 0;
    while (pruneIdx < hits.length && (hits[pruneIdx]?.ts ?? 0) <= cutoff) pruneIdx++;
    if (pruneIdx > 0) hits = hits.slice(pruneIdx);

    if (hits.length >= max) {
      const oldestTs = hits[0]?.ts ?? now;
      const retryAfterMs = oldestTs + windowMs - now;
      store.set(ip, hits);
      res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({ error: "Too Many Requests", code: "RATE_LIMITED", retryable: true });
      return;
    }

    hits.push({ ts: now });
    store.set(ip, hits);
    next();
  };

  return {
    middleware,
    close() {
      clearInterval(cleanupInterval);
    },
  };
}
