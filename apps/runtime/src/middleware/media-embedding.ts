// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { MiddlewareHandler } from "hono";

/**
 * Lets the transient generated-media responses be embedded as cross-origin
 * subresources (an `<img>` in an Open WebUI chat message on one origin loading
 * `https://<backend>/v1/media/<id>.png` from another).
 *
 * `secureHeaders()` writes `Cross-Origin-Resource-Policy: same-origin` after
 * downstream routes complete, and browsers enforce CORP for subresource loads:
 * the `<img>` is blocked and Open WebUI falls back to its "Image unavailable"
 * placeholder. Navigating straight to the URL still works (CORP does not apply
 * to navigations), which is why the link in the reply opens fine while the
 * inline preview does not.
 *
 * Only `/v1/media/*` is relaxed, and only to `cross-origin`: the ids are
 * unguessable v4 UUIDs held in a short-TTL store, there is no listing route,
 * and the bytes are always backend-generated, so widening embeddability does
 * not expose readable cross-origin data to an attacker (CORP's purpose is to
 * stop speculative side-channel reads of *authenticated* responses — these
 * responses are capability-URL public by design).
 */
export const mediaEmbeddingMiddleware: MiddlewareHandler = async (ctx, next) => {
  await next();
  if (ctx.req.method === "GET" && ctx.req.path.startsWith("/v1/media/")) {
    ctx.res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
};
