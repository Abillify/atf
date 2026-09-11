// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * request-principal.ts
 *
 * The single place that decides *who* a request is acting as.
 *
 * Same model as `apps/search/src/request-principal.ts`, and the rule it encodes
 * is the same: **a verified identity always wins and can never be overridden by
 * a header.** Header assertion (`X-User` / `X-Groups`) stays supported because a
 * trusted middle tier legitimately needs it — but only for callers that
 * authenticated as a service with a static token, never as a way to relabel a
 * JWT-authenticated user.
 *
 * Why this service needs a principal at all, given it stores nothing: the
 * identity is forwarded to Search on ingest as `X-Allowed-Users` /
 * `X-Allowed-Groups`. Getting it wrong here does not leak anything from this
 * process — it writes the wrong ACL onto documents in the index, which is worse,
 * because it is persistent and invisible until someone retrieves a document they
 * should not see.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler } from "express";
import { readHeader, readListHeader } from "./header-utils.js";

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
  /** Identity forwarded to Search as `allowed_users`. Undefined for a service. */
  userId: string | undefined;
  /** Groups forwarded to Search as `allowed_groups`. Undefined for a service. */
  userGroups: string[] | undefined;
  /** Tenant from a verified credential or explicit service configuration. */
  tenantId?: string;
  /** Normalized scopes from the credential or the configured service principal. */
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
  /** True only when AUTHZ_ENABLED=false; bypasses operation checks. */
  authorizationBypass?: boolean;
}

/** Express request augmented with the resolved principal. */
export interface RequestWithPrincipal extends Request {
  principal?: RequestPrincipal;
}

/** The service context: authenticated, but acting as nobody in particular. */
export const SERVICE_PRINCIPAL: RequestPrincipal = {
  userId: undefined,
  userGroups: undefined,
  scopes: [],
  source: "service",
};

/**
 * Read the caller-asserted identity from `X-User` / `X-Groups`.
 *
 * Exported separately so it is obvious at every call site that these are
 * *claims by the caller*, not verified facts.
 */
export function readAssertedIdentity(req: Request): {
  userId: string | undefined;
  userGroups: string[] | undefined;
} {
  const userId = readHeader(req, "x-user") || undefined;
  const groups = readListHeader(req, "x-groups");
  return { userId, userGroups: groups.length > 0 ? groups : undefined };
}

/** Attach the resolved principal, once, from the auth middleware. */
export function setPrincipal(req: Request, principal: RequestPrincipal): void {
  (req as RequestWithPrincipal).principal = principal;
}

/**
 * Read the principal attached by the auth middleware.
 *
 * Falls back to the *asserted* headers only when nothing was attached, which
 * happens when auth is disabled. That keeps local development working without
 * turning a forgotten middleware into silent full access, because with auth
 * disabled there was no credential to escalate from in the first place.
 */
export function getPrincipal(req: Request): RequestPrincipal {
  const attached = (req as RequestWithPrincipal).principal;
  if (attached) return attached;
  return { ...readAssertedIdentity(req), source: "anonymous" };
}

/** True when this principal represents a specific end user rather than a service. */
export function hasIdentity(principal: RequestPrincipal): boolean {
  return Boolean(principal.userId) || (principal.userGroups?.length ?? 0) > 0;
}

/**
 * Refuse a request that establishes no end-user identity.
 *
 * Off by default: a legitimate service-to-service conversion has no end user.
 * Enabled when every ingested document must carry an attributable ACL, in which
 * case a missing `X-User` becomes a 403 rather than a document written with an
 * empty — that is, unrestricted — ACL.
 */
export function createRequireIdentityMiddleware(enabled: boolean): RequestHandler {
  return (req, res, next) => {
    if (!enabled) {
      next();
      return;
    }
    if (hasIdentity(getPrincipal(req))) {
      next();
      return;
    }
    res.status(403).json({
      error:
        "No end-user identity established. Present an end-user JWT, or assert " +
        "X-User/X-Groups as a service caller.",
      code: "VALIDATION_FAILED",
      retryable: false,
    });
  };
}

/**
 * Ambient principal for work that outlives the request handler.
 *
 * An async conversion continues after the HTTP response has been sent, and the
 * ingest it performs at the end still has to carry the requester's ACL. Reading
 * it from `req` at that point is not possible, and capturing it in a closure per
 * job is easy to forget — so it travels through AsyncLocalStorage, the same
 * mechanism used for trace context.
 */
const principalStorage = new AsyncLocalStorage<RequestPrincipal>();

/** Run `fn` with `principal` visible to {@link getAmbientPrincipal}. */
export function runWithPrincipal<T>(principal: RequestPrincipal, fn: () => T): T {
  return principalStorage.run(principal, fn);
}

/**
 * The principal for the in-flight work, when one was established.
 *
 * Returns undefined outside a `runWithPrincipal` scope. Callers must decide what
 * that means; this module deliberately does not invent a default, because "no
 * principal" must never silently mean "unrestricted".
 */
export function getAmbientPrincipal(): RequestPrincipal | undefined {
  return principalStorage.getStore();
}
