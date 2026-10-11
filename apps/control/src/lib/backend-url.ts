// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Returns the base URL for backend API calls.
 *
 * Strategy:
 * - In production the frontend and backend share a domain. Caddy (or any
 *   reverse proxy) forwards /v1/*, /monitoring/*, /health to the backend
 *   service. The browser therefore uses relative paths, which always resolve
 *   correctly regardless of which host the image is deployed to.
 * - For local development without a proxy, set NEXT_PUBLIC_BACKEND_URL to the
 *   backend origin in your local .env (e.g. http://localhost:3000). The value
 *   is intentionally NOT baked into the production image — the build always
 *   uses relative paths in the browser bundle.
 *
 * NOTE: NEXT_PUBLIC_* variables are frozen into the client bundle at build
 * time by Next.js. Injecting an absolute URL at build time makes the image
 * environment-specific and breaks relative-path routing. Always use the proxy
 * approach in production.
 *
 * BFF mode (Req 8.7, `CONTROL_SESSION_MODE=bff`): every backend call is
 * rewritten to the Next.js route handler `/api/backend/…`, which injects the
 * server-side session token. The browser then talks to its own origin only —
 * `NEXT_PUBLIC_BACKEND_URL` becomes irrelevant in that mode.
 */
import { isBffMode } from "./client-session-mode";

/** Prefix of the Next.js BFF proxy route (`app/api/backend/[...path]`). */
export const BFF_PROXY_PREFIX = "/api/backend";

export function backendBase(): string {
  if (isBffMode()) return BFF_PROXY_PREFIX;
  if (typeof process !== "undefined") {
    const configured = process.env["NEXT_PUBLIC_BACKEND_URL"] ?? "";
    // Only use an explicit non-default URL (e.g. local dev without a proxy).
    // Treat the localhost placeholder as "not set" so it never leaks into prod.
    if (configured && configured !== "http://localhost:3000") {
      return configured;
    }
  }
  // Default: relative paths — works behind any reverse proxy.
  return "";
}

/** Constructs a full URL or a relative path for a given backend route. */
export function backendUrl(path: string): string {
  const base = backendBase();
  return base ? `${base}${path}` : path;
}
