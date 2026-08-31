// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

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

/**
 * In-memory sliding-window rate limiter (per IP, no dependencies).
 *
 * Implements a true sliding window: for each IP, only requests within the
 * last `windowMs` milliseconds are counted. This eliminates the burst-at-
 * boundary problem of fixed-window implementations (where a client could
 * send 2× the limit in a short period straddling a window reset).
 *
 * Security notes:
 * - Set `trustProxy: true` only when running behind a trusted reverse proxy
 *   (nginx, AWS ALB, etc.). When false (default), the client's actual TCP
 *   address is used, making X-Forwarded-For spoofing impossible.
 * - The per-IP hit arrays are bounded to `max` entries: once the window is
 *   full and all entries are recent, new entries replace the oldest, keeping
 *   memory O(max) per active IP.
 * - The IP store is bounded to `maxKeys` entries (default 50 000). When
 *   exceeded, the oldest 10% of entries are evicted to prevent unbounded
 *   memory growth under DDoS traffic with many unique IPs.
 *
 * Pass max=0 to disable rate limiting entirely.
 */
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

  // Per-IP sliding window: array of recent hit timestamps (ascending order).
  const store = new Map<string, Hit[]>();

  // Periodic cleanup of IPs that have been inactive for a full window.
  const cleanupInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, hits] of store) {
      // Drop entries older than the window.
      const fresh = hits.filter((h) => h.ts > cutoff);
      if (fresh.length === 0) {
        store.delete(key);
      } else {
        store.set(key, fresh);
      }
    }
  }, windowMs).unref();

  function evictOldest(): void {
    // Delete the oldest 10% of IPs by insertion order.
    const evictCount = Math.ceil(store.size * 0.1);
    let deleted = 0;
    for (const key of store.keys()) {
      store.delete(key);
      if (++deleted >= evictCount) break;
    }
  }

  const middleware: RequestHandler = (req, res, next) => {
    let ip: string;

    if (trustProxy) {
      // Trust the leftmost IP in X-Forwarded-For (the original client).
      ip =
        (req.headers["x-forwarded-for"] as string | undefined)
          ?.split(",")[0]
          ?.trim() ??
        req.socket.remoteAddress ??
        "unknown";
    } else {
      // Ignore X-Forwarded-For entirely — use only the TCP connection address.
      ip = req.socket.remoteAddress ?? "unknown";
    }

    const now = Date.now();
    const cutoff = now - windowMs;

    let hits = store.get(ip);

    if (!hits) {
      // New IP — enforce store size cap before inserting.
      if (store.size >= maxKeys) evictOldest();
      store.set(ip, [{ ts: now }]);
      return next();
    }

    // Prune hits outside the current window (in-place, ascending order means
    // expired entries are always at the front).
    let pruneIdx = 0;
    while (pruneIdx < hits.length && hits[pruneIdx]!.ts <= cutoff) {
      pruneIdx++;
    }
    if (pruneIdx > 0) hits = hits.slice(pruneIdx);

    if (hits.length >= max) {
      // Window is full — compute when the oldest hit will fall out of the window.
      const oldestTs = hits[0]!.ts;
      const retryAfterMs = oldestTs + windowMs - now;
      store.set(ip, hits); // persist the pruned array
      res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({ error: "Too Many Requests" });
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
