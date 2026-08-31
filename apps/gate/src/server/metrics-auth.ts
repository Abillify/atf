// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Access control for the Prometheus metrics endpoint.
 *
 * The exposition is not neutral: it enumerates tool names and carries per-tool
 * call/error counts and latency buckets — a usage profile of the deployment and
 * an inventory of what the gateway exposes. Serving it openly is a disclosure,
 * so the endpoint is closed by default and opened deliberately:
 *
 *   1. `metrics.allowUnauthenticated: true` — open to everyone. Rejected by the
 *      production readiness gate.
 *   2. `metrics.token` set — `Authorization: Bearer <token>` required, compared
 *      in constant time.
 *   3. Neither set — loopback only. This is the common sidecar/agent case
 *      (`localhost:PORT/metrics`) and needs no shared secret, while a remote
 *      scrape gets 401 instead of the data.
 */

import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

/** The subset of `server.metrics` this module needs. */
export interface MetricsAuthConfig {
  token?: string | undefined;
  allowUnauthenticated: boolean;
}

/** Constant-time compare that does not leak length via early return timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * True when the request arrived over a loopback address.
 *
 * Note `req.ip` honours Express's `trust proxy` setting, which mcpgate sets to
 * `1`. That means a request forwarded by the trusted first hop is judged by its
 * `X-Forwarded-For` address, not the hop's — so a proxy on the same host cannot
 * be used to launder a remote scrape into a "loopback" one.
 */
export function isLoopbackRequest(req: Request): boolean {
  const ip = req.ip ?? req.socket?.remoteAddress ?? "";
  const normalized = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

/** Extract a bearer token from an Authorization header. */
function bearerOf(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function deny(res: Response): void {
  res.set("WWW-Authenticate", 'Bearer realm="metrics"');
  res.status(401).type("text/plain").send("Unauthorized\n");
}

export function createMetricsAuthMiddleware(
  config: MetricsAuthConfig,
): RequestHandler {
  return (req, res, next) => {
    if (config.allowUnauthenticated) {
      next();
      return;
    }

    const token = config.token;
    if (token !== undefined && token.length > 0) {
      const presented = bearerOf(req);
      if (presented !== undefined && safeEqual(presented, token)) {
        next();
        return;
      }
      deny(res);
      return;
    }

    // No token configured → loopback-only.
    if (isLoopbackRequest(req)) {
      next();
      return;
    }
    deny(res);
  };
}
