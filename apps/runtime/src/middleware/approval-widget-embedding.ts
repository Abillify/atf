// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { MiddlewareHandler } from "hono";

/**
 * Keeps the globally hardened response headers while allowing the two
 * capability-token-protected approval HTML pages to be embedded by an allowed
 * Open WebUI parent (`frame-ancestors` is set by the control router).
 */
export const approvalWidgetEmbeddingMiddleware: MiddlewareHandler = async (ctx, next) => {
  await next();
  if (
    ctx.req.method === "GET" &&
    /^\/monitoring\/approvals\/[^/]+\/(?:widget|decide)$/.test(ctx.req.path)
  ) {
    // `secureHeaders()` writes these after downstream routes complete. They
    // prohibit all cross-origin iframe loads, irrespective of CSP.
    ctx.res.headers.delete("X-Frame-Options");
    ctx.res.headers.delete("Cross-Origin-Resource-Policy");
  }
};
