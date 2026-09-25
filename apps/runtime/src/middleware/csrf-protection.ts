// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * CSRF protection for state-changing requests.
 *
 * `authMiddleware` (src/middleware/auth.ts) accepts a `token` COOKIE as a full
 * credential on `/v1/*` (the Open WebUI OAuth-mode integration). A cookie is
 * attached by the browser to a cross-origin request automatically — including
 * a simple, non-JSON HTML <form> POST that a malicious page can auto-submit —
 * so without this, any state-changing endpoint accepting such a body
 * (form-urlencoded/multipart/text-plain) would execute with the victim's
 * session even though CORS never allowed the origin to read the response.
 * Hono's csrf() middleware closes exactly that vector: it checks
 * `Sec-Fetch-Site`/`Origin` and rejects an unsafe-method request with a
 * form-like content-type that did not originate same-site.
 *
 * Only POST is gated. An HTML form can submit nothing but GET and POST; a
 * cross-origin PUT/PATCH/DELETE needs script and therefore a CORS preflight,
 * which the app's cors() allowlist already governs. Hono's csrf() treats a
 * missing Content-Type as `text/plain`, so gating those methods too would
 * reject every body-less DELETE the dashboard sends from its own (allowlisted)
 * origin — e.g. deleting an eval case — without closing any real vector.
 *
 * Excluded: `/webhooks/*` (GitOps) and `/triggers/*` — server-to-server
 * callbacks authenticated by an HMAC signature over the body, never by a
 * browser-held cookie. Some Git providers also post with a content-type
 * csrf() would flag, and a server-side sender has no browser
 * Origin/Sec-Fetch-Site to evaluate in the first place.
 */

import type { MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";

export function csrfProtection(): MiddlewareHandler {
  const protect = csrf();
  return (ctx, next) =>
    ctx.req.method !== "POST" ||
    ctx.req.path.startsWith("/webhooks/") ||
    ctx.req.path.startsWith("/triggers/")
      ? next()
      : protect(ctx, next);
}
