// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * request-principal.ts
 *
 * The single place that decides *who* a request is acting as, for ACL purposes.
 *
 * The problem this fixes
 * ─────────────────────
 * The previous design read the end-user identity exclusively from the `X-User` /
 * `X-Groups` request headers, on the stated assumption that the API-token-holding
 * caller asserts it truthfully. Two consequences made the ACLs ineffective in
 * practice:
 *
 *  1. **Header-less meant admin.** A caller that sent no `X-User` and no
 *     `X-Groups` was treated as a service/admin context and received every row
 *     of every collection. So the ACL could be bypassed by *removing* a header —
 *     the easiest possible bypass, and one that looks like a normal request.
 *
 *  2. **A verified JWT was thrown away.** `jwt-verifier.ts` validated the
 *     bearer correctly, but `auth.ts` discarded the resulting principal and
 *     never attached it to the request. So a caller presenting a real end-user
 *     token — which is exactly what aiperator does with `forwardAuthToken` —
 *     arrived downstream as *no identity at all*, i.e. as an admin. The ACLs
 *     were inert on the primary integration path.
 *
 * The rule now
 * ────────────
 * A **verified** identity always wins and can never be overridden by a header.
 * Header assertion remains supported, because a trusted middle tier legitimately
 * needs it — but only for callers that authenticated as a service (static API
 * token), and never as a way to relabel or escalate a JWT-authenticated user.
 *
 * `requireIdentity` closes the remaining hole: when set, a request that
 * establishes no identity at all is refused instead of being promoted to a
 * service context.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler } from "express";
import { readHeader } from "./header-utils.js";

/** How the acting identity was established. */
export type PrincipalSource =
  /** Verified JWT bearer — authoritative, never overridable by headers. */
  | "jwt"
  /** Static API token plus asserted X-User/X-Groups headers. */
  | "asserted"
  /** Browser session (token login or OIDC) — a human operator. */
  | "session"
  /** Authenticated as a service with no identity asserted. */
  | "service"
  /** Authentication is disabled entirely (development only). */
  | "anonymous";

export interface RequestPrincipal {
  /** Identity matched against `allowed_users`. Undefined for a service context. */
  userId: string | undefined;
  /** Groups matched against `allowed_groups`. Undefined for a service context. */
  userGroups: string[] | undefined;
  /** Tenant from a verified credential or explicit service configuration. */
  tenantId?: string;
  /** Normalized scopes from the verified credential or configured service principal. */
  scopes?: string[];
  /** JWT issuer, when the credential is a JWT. */
  issuer?: string;
  /** JWT audience/client binding, when present. */
  audience?: string | string[];
  clientId?: string;
  /** Credential identifier (JWT jti), if available. */
  credentialId?: string;
  /** How this identity was established. */
  source: PrincipalSource;
  /** True only when AUTHZ_ENABLED=false; bypasses operation and ACL checks. */
  authorizationBypass?: boolean;
}

/** Express request augmented with the resolved principal. */
export interface RequestWithPrincipal extends Request {
  principal?: RequestPrincipal;
}

/** The service/admin context: authenticated, but acting as nobody in particular. */
export const SERVICE_PRINCIPAL: RequestPrincipal = {
  userId: undefined,
  userGroups: undefined,
  scopes: [],
  source: "service",
};

/** Parse the `X-Groups` header (comma-separated). */
export function parseGroupsHeader(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

/**
 * Read the caller-asserted identity from `X-User` / `X-Groups`.
 *
 * Exported separately from {@link resolvePrincipal} so it is obvious at every
 * call site that these values are *claims by the caller*, not verified facts.
 */
export function readAssertedIdentity(req: Request): {
  userId: string | undefined;
  userGroups: string[] | undefined;
} {
  const userId = readHeader(req, "x-user") || undefined;
  const groups = parseGroupsHeader(readHeader(req, "x-groups") || undefined);
  return {
    userId,
    userGroups: groups.length > 0 ? groups : undefined,
  };
}

/**
 * Attach the resolved principal to the request.
 *
 * Called by the auth middleware once the credential has been checked, so every
 * downstream handler reads one consistent answer instead of re-deriving it from
 * headers.
 */
export function setPrincipal(req: Request, principal: RequestPrincipal): void {
  (req as RequestWithPrincipal).principal = principal;
}

/**
 * Read the principal attached by the auth middleware.
 *
 * Falls back to the *asserted* headers only when no principal was attached,
 * which happens when auth is disabled entirely. That fallback keeps local
 * development working without turning a missing middleware into silent full
 * access in a deployment — because with auth disabled the request had no
 * credential to escalate from in the first place.
 */
export function getPrincipal(req: Request): RequestPrincipal {
  const attached = (req as RequestWithPrincipal).principal;
  if (attached) return attached;
  const asserted = readAssertedIdentity(req);
  return { ...asserted, source: "anonymous" };
}

/** True when this principal represents a specific end user rather than a service. */
export function hasIdentity(principal: RequestPrincipal): boolean {
  return (
    Boolean(principal.userId) || (principal.userGroups?.length ?? 0) > 0
  );
}

/**
 * Middleware that refuses a request which establishes no end-user identity.
 *
 * Off by default for backward compatibility, since a legitimate service-to-
 * service ingest has no end user. Enabled via `ACL_REQUIRE_IDENTITY=true` for
 * deployments where every read must be attributable — in which case a missing
 * `X-User` becomes a 403 rather than an escalation to full access.
 */
export function createRequireIdentityMiddleware(
  enabled: boolean,
): RequestHandler {
  return (req, res, next) => {
    if (!enabled) {
      next();
      return;
    }
    const principal = getPrincipal(req);
    if (hasIdentity(principal)) {
      next();
      return;
    }
    res.status(403).json({
      error:
        "No end-user identity established. ACL_REQUIRE_IDENTITY is enabled: " +
        "present an end-user JWT, or assert X-User/X-Groups as a service caller.",
    });
  };
}

// ---------------------------------------------------------------------------
// Ambient principal for the MCP transport
// ---------------------------------------------------------------------------

/**
 * The MCP tool handlers are closures created once per SESSION, not per request,
 * so they cannot receive the Express `req`. Without a channel from the HTTP
 * layer down to the tool, `handlers/mcp.ts` hard-coded `undefined` for
 * userId/userGroups — meaning **every MCP search bypassed row-level ACLs
 * entirely**, and MCP is the primary way aiperator talks to this service.
 *
 * AsyncLocalStorage carries the principal across that gap. This mirrors the
 * pattern already used in this codebase for `usageStorage` and trace context,
 * rather than introducing a second mechanism.
 *
 * Binding the principal to the session instead would be wrong: a session is
 * long-lived, so the identity captured at `initialize` would keep applying after
 * the caller's token changed or expired.
 */
const principalStorage = new AsyncLocalStorage<RequestPrincipal>();

/** Run `fn` with `principal` visible to {@link getAmbientPrincipal}. */
export function runWithPrincipal<T>(
  principal: RequestPrincipal,
  fn: () => T,
): T {
  return principalStorage.run(principal, fn);
}

/**
 * The principal for the in-flight request, when one was established.
 *
 * Returns undefined outside a `runWithPrincipal` scope. Callers must decide what
 * that means for them — this module deliberately does not invent a default,
 * because "no principal" previously meant "full access".
 */
export function getAmbientPrincipal(): RequestPrincipal | undefined {
  return principalStorage.getStore();
}
