// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * server-url.ts
 *
 * Resolving this service's own public base URL.
 *
 * Needed by the OIDC flow (the `redirect_uri` must match exactly what the
 * provider has registered) and by the CSRF origin check. Getting it wrong
 * produces a login loop that is hard to diagnose, because everything looks
 * correct from inside the container.
 *
 * Resolution order, most to least trustworthy:
 *
 *  1. `PUBLIC_URL` — explicit configuration. The only source that is correct by
 *     construction, and the only one to use behind a proxy that rewrites paths.
 *  2. `X-Forwarded-Proto` / `X-Forwarded-Host` — but *only* when `TRUST_PROXY` is
 *     on. These are attacker-controlled otherwise, and an attacker who can set
 *     the host used to build a redirect URI has a phishing primitive.
 *  3. The request's own `Host` header and scheme.
 */

import type { Request } from "express";

export interface ServerUrlOptions {
  /** PUBLIC_URL, when configured. */
  publicUrl: string | null;
  /** Listening port, used when the Host header carries none. */
  port: number;
  /** TRUST_PROXY — whether X-Forwarded-* may be believed. */
  trustProxy: boolean;
}

function firstHeaderValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const first = value.split(",")[0]?.trim();
  return first === undefined || first === "" ? undefined : first;
}

/** Build a resolver bound to the current configuration. */
export function createServerUrlResolver(
  options: ServerUrlOptions,
): (req: Request) => string {
  const configured = options.publicUrl?.replace(/\/+$/, "") ?? null;

  return (req: Request): string => {
    if (configured !== null) return configured;

    const forwardedProto = options.trustProxy
      ? firstHeaderValue(req.headers["x-forwarded-proto"])
      : undefined;
    const forwardedHost = options.trustProxy
      ? firstHeaderValue(req.headers["x-forwarded-host"])
      : undefined;

    const protocol = forwardedProto ?? (req.secure ? "https" : "http");
    const host = forwardedHost ?? firstHeaderValue(req.headers["host"]);

    if (host !== undefined) return `${protocol}://${host}`;
    return `${protocol}://127.0.0.1:${options.port}`;
  };
}
