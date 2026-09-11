// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ui-auth.ts
 *
 * The browser backend-for-frontend boundary.
 *
 * Cookie-only, and that is the whole point. This middleware never reads
 * `Authorization` and never reads the asserted `X-User` / `X-Groups` headers —
 * a page running in a browser must not be able to nominate its own identity or
 * present a machine credential. The tenant and the operation scopes come from
 * *server* configuration (`UI_TENANT_ID`, `UI_SCOPES`), never from the ID token,
 * so an IdP misconfiguration cannot widen what the UI may do.
 *
 * Mirrors `apps/search/src/ui-auth.ts`.
 */

import type { RequestHandler } from "express";
import type { AuthnMode } from "./config.js";
import type { OidcSessionChecker } from "./auth.js";
import { getPrincipal, setPrincipal } from "./request-principal.js";

export interface UiPrincipalOptions {
  authnMode: AuthnMode;
  tenantId: string;
  scopes: string[];
  allowedGroups: string[];
  operatorGroup: string | null;
  authzEnabled: boolean;
}

interface VerifiedUiSession {
  sub: string;
  groups?: string[];
}

function parseVerifiedSession(session: unknown): VerifiedUiSession | null {
  if (session === null || typeof session !== "object") return null;
  const value = session as Record<string, unknown>;
  const sub = typeof value["sub"] === "string" ? value["sub"].trim() : "";
  if (sub === "") return null;
  const groups = Array.isArray(value["groups"])
    ? [
        ...new Set(
          value["groups"]
            .filter((group): group is string => typeof group === "string")
            .map((group) => group.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  return { sub, ...(groups.length > 0 ? { groups } : {}) };
}

export function createUiPrincipalMiddleware(
  oidc: OidcSessionChecker | null,
  options: UiPrincipalOptions,
): RequestHandler {
  const allowedGroups = new Set(options.allowedGroups);
  const scopes = [...new Set(options.scopes.map((scope) => scope.trim()).filter(Boolean))];

  return async (req, res, next) => {
    if (options.authnMode === "disabled") {
      setPrincipal(req, {
        source: "anonymous",
        userId: undefined,
        userGroups: undefined,
        tenantId: options.tenantId,
        scopes: [],
        authorizationBypass: true,
      });
      next();
      return;
    }
    if (oidc === null) {
      res.status(401).json({ error: "A verified OIDC web session is required" });
      return;
    }
    try {
      const session = parseVerifiedSession(await oidc.verifySession(req));
      if (session === null) {
        res.status(401).json({ error: "Web session expired or invalid" });
        return;
      }
      // An empty allowlist means no filtering; otherwise only groups the operator
      // explicitly permits survive, so an IdP that starts emitting extra groups
      // cannot silently grant more.
      const groups =
        allowedGroups.size === 0
          ? (session.groups ?? [])
          : (session.groups ?? []).filter((group) => allowedGroups.has(group));
      setPrincipal(req, {
        source: "session",
        userId: session.sub,
        userGroups: groups.length > 0 ? groups : undefined,
        tenantId: options.tenantId,
        scopes,
        ...(!options.authzEnabled ? { authorizationBypass: true } : {}),
      });
      next();
    } catch {
      res.status(401).json({ error: "Web session expired or invalid" });
    }
  };
}

/** UI administration requires an operator group unless authentication is disabled. */
export function createRequireUiOperatorMiddleware(
  operatorGroup: string | null,
  authnMode: AuthnMode,
): RequestHandler {
  return (req, res, next) => {
    if (authnMode === "disabled") {
      next();
      return;
    }
    const principal = getPrincipal(req);
    if (
      operatorGroup !== null &&
      principal.source === "session" &&
      principal.userGroups?.includes(operatorGroup)
    ) {
      next();
      return;
    }
    res.status(403).json({ error: "UI operator privileges required" });
  };
}

/**
 * Reject cross-origin cookie-authenticated mutations.
 *
 * Without this, any page on the internet can make a logged-in operator's browser
 * upload a document and ingest it. `Sec-Fetch-Site` is the modern signal;
 * `Origin` is checked as a fallback for older clients.
 */
export function createUiMutationGuard(
  resolveBaseUrl: (req: Parameters<RequestHandler>[0]) => string,
): RequestHandler {
  return (req, res, next) => {
    if (req.get("sec-fetch-site") === "same-origin") {
      next();
      return;
    }
    const origin = req.get("origin");
    try {
      if (origin !== undefined && new URL(origin).origin === new URL(resolveBaseUrl(req)).origin) {
        next();
        return;
      }
    } catch {
      // Invalid origins fall through to the rejection below.
    }
    res.status(403).json({ error: "Cross-origin UI mutation denied" });
  };
}
