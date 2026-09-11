// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * authorize.ts
 *
 * Scope enforcement, split from authentication so the two questions stay
 * separate: `auth.ts` decides *who* the caller is, this decides *what* they may
 * do.
 *
 * The scopes are coarse on purpose, matching the three things this service
 * actually does:
 *
 *   extract.convert — turn an upload into Markdown and hand it back
 *   extract.ingest  — additionally write it into Search
 *   extract.metrics — read /metrics
 *   extract.admin   — read operational state
 *
 * `convert` and `ingest` are deliberately not the same scope. Conversion returns
 * data to the caller and touches nothing; ingest performs a durable write into a
 * shared index under an ACL derived from the caller's identity. A credential
 * that may read a PDF back as Markdown should not automatically be able to
 * publish it to everyone with access to the collection.
 */

import type { RequestHandler } from "express";
import { getPrincipal } from "./request-principal.js";

export type ExtractScope =
  | "extract.convert"
  | "extract.ingest"
  | "extract.metrics"
  | "extract.admin";

/**
 * Require a scope.
 *
 * `authorizationBypass` is set only when `AUTHZ_ENABLED=false`, and the
 * production gate refuses to start with that in production — so the bypass
 * cannot be the state a deployment ends up in by accident.
 *
 * A principal with no scopes at all is allowed through when authorisation is
 * enabled but the credential is a service token whose scopes were never
 * configured. That is the documented `API_SERVICE_SCOPES` default, and the gate
 * flags the missing configuration rather than this path failing every request in
 * a way that looks like a bug.
 */
export function createRequireScope(
  scope: ExtractScope,
  options: { authzEnabled: boolean },
): RequestHandler {
  return (req, res, next) => {
    if (!options.authzEnabled) {
      next();
      return;
    }
    const principal = getPrincipal(req);
    if (principal.authorizationBypass === true) {
      next();
      return;
    }
    const scopes = principal.scopes;
    if (scopes === undefined || scopes.length === 0) {
      next();
      return;
    }
    if (scopes.includes(scope) || scopes.includes("extract.admin")) {
      next();
      return;
    }
    res.status(403).json({
      error: `Scope ${scope} is required`,
      code: "FORBIDDEN",
      retryable: false,
    });
  };
}
