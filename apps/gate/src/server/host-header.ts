// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Host-header handling (Req 6.12).
 *
 * Two defects are fixed here:
 *  - IPv6: a bracketed literal like `[::1]:3000` was split at the FIRST colon,
 *    yielding `"["` — never matchable, so every IPv6 request was rejected (or,
 *    combined with the empty-host bypass below, silently mishandled).
 *  - Empty Host: a missing or empty Host header was falsy and skipped the
 *    allow-list check entirely — the one value an attacker can always send.
 *    HTTP/1.1 requires Host; an empty one is rejected with 400 unconditionally.
 */

import type { NextFunction, Request, Response } from "express";
import { logger } from "../logger.ts";

/**
 * Extract the lowercase hostname from a Host header value, stripping the port.
 *
 *  - `[::1]:3000` → `::1` (bracketed IPv6 literal, port after `]:`)
 *  - `[::1]`      → `::1`
 *  - `Example.COM:8080` → `example.com`
 *  - `example.com`      → `example.com`
 *  - `""` / missing     → `undefined`
 *
 * A bare (unbracketed) IPv6 like `::1:3000` is malformed per RFC 3986/6874 —
 * the port split takes the LAST colon for non-bracketed values, which keeps
 * ordinary host:port parsing correct; bracketed form is the canonical one and
 * what clients (and Node itself) send for IPv6.
 */
export function parseHostHostname(hostHeader: string | undefined): string | undefined {
  const raw = hostHeader?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return undefined; // malformed bracketed literal
    const host = raw.slice(1, end).toLowerCase();
    return host.length > 0 ? host : undefined;
  }
  // Hostnames cannot contain ':', so at most one separator exists; splitting
  // at the last colon is safe and also tolerates a stray extra colon.
  const colon = raw.lastIndexOf(":");
  const host = colon === -1 ? raw : raw.slice(0, colon);
  return host.length > 0 ? host.toLowerCase() : undefined;
}

/**
 * DNS-rebinding / Host allow-list middleware. Always installed: an empty or
 * absent Host header is rejected with 400 regardless of configuration. When
 * `allowedHosts` is non-empty, hostnames outside the allow-list get 403.
 */
export function createHostAllowListMiddleware(
  allowedHosts: readonly string[],
): (req: Request, res: Response, next: NextFunction) => void {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = parseHostHostname(req.headers.host);
    if (host === undefined) {
      logger.warn("rejected request: empty or malformed Host header");
      res.status(400).json({ error: "Host header required" });
      return;
    }
    if (allowed.size > 0 && !allowed.has(host)) {
      logger.warn("rejected request: host not allowed", { host });
      res.status(403).json({ error: "Host not allowed" });
      return;
    }
    next();
  };
}
