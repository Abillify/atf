// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Request, RequestHandler } from "express";
import { createStaticTokenMatcher, safeEqual } from "@atf/security-kit";
import type { JwtVerifier } from "./jwt-verifier.js";
import {
  readAssertedIdentity,
  setPrincipal,
  SERVICE_PRINCIPAL,
  type PrincipalSource,
  type RequestPrincipal,
} from "./request-principal.js";

/**
 * Scope a static-token service principal must carry before the gateway-
 * asserted `X-User`/`X-Groups` headers are honoured (Req 3.4). Without it the
 * headers are ignored and the caller stays a plain service context — asserting
 * an end-user identity on behalf of others is a privilege, not a default.
 */
export const ASSERT_IDENTITY_SCOPE = "search.assert-identity";

/**
 * Build a principal from asserted headers, falling back to the service context
 * when nothing is asserted. Shared by the static-token and token-session paths,
 * which have identical trust characteristics.
 */
function assertedOrService(
  req: Request,
  source: PrincipalSource,
): RequestPrincipal {
  const asserted = readAssertedIdentity(req);
  if (asserted.userId !== undefined || asserted.userGroups !== undefined) {
    return { ...asserted, source };
  }
  return SERVICE_PRINCIPAL;
}

/**
 * Derive the acting identity from a verified OIDC browser session.
 *
 * The session object is provider-shaped, so the identity claims are read
 * defensively. When the session carries a usable subject it is authoritative
 * (headers ignored, same rule as the JWT path); otherwise the request is treated
 * as an operator session and asserted headers apply.
 */
function _resolveOidcSessionPrincipal(
  req: Request,
  session: unknown,
): RequestPrincipal {
  if (session !== null && typeof session === "object") {
    const s = session as Record<string, unknown>;
    const sub =
      typeof s["sub"] === "string" && s["sub"].trim().length > 0
        ? s["sub"].trim()
        : typeof s["preferred_username"] === "string"
          ? (s["preferred_username"] as string).trim()
          : undefined;
    const rawGroups = s["groups"];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.map((g) => String(g).trim()).filter((g) => g.length > 0)
      : [];
    if (sub !== undefined && sub.length > 0) {
      return {
        userId: sub,
        userGroups: groups.length > 0 ? groups : undefined,
        source: "session",
      };
    }
  }
  return assertedOrService(req, "session");
}

/**
 * Minimal contract the auth middleware needs from the OIDC provider.
 * Kept structural (not importing OidcProvider) so auth.ts has no hard
 * dependency on the oidc module.
 */
export interface OidcSessionChecker {
  /** Path that starts the OIDC login flow (e.g. "/auth/login"). */
  loginPath: string;
  /** Resolve to a truthy session when the request carries a valid OIDC session. */
  verifySession(req: Request): Promise<unknown>;
}

function htmlEscape(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface LoginPageOptions {
  error?: string;
  /** Render the token login form. Default: true. */
  showTokenForm?: boolean;
  /** When set, render an SSO button linking to this OIDC login path. */
  oidcLoginPath?: string;
}

export function getLoginPageHtml(options: LoginPageOptions = {}): string {
  const { error, showTokenForm = true, oidcLoginPath } = options;
  const ssoBlock = oidcLoginPath
    ? `<p><a href="${htmlEscape(oidcLoginPath)}"><button type="button">Login with SSO</button></a></p>`
    : "";
  const tokenBlock = showTokenForm
    ? `<form method="POST" action="/login">
    <label>Token: <input type="password" name="token" /></label>
    <button type="submit">Login</button>
  </form>`
    : "";
  const separator = ssoBlock && tokenBlock ? "<hr />" : "";
  return `<!DOCTYPE html>
<html>
<head><title>vectorsearch — Login</title></head>
<body>
  <h1>Login</h1>
  ${error ? `<p style="color:red">${htmlEscape(error)}</p>` : ""}
  ${ssoBlock}
  ${separator}
  ${tokenBlock}
</body>
</html>`;
}

/**
 * API / MCP auth middleware.
 *
 * Accepted credentials are determined exclusively by `AUTHN_MODE`:
 *
 *   1. `token` / `token_or_oidc`: Bearer `API_TOKEN`
 *   2. `oidc` / `token_or_oidc`: Bearer JWT verified against `API_OIDC_ISSUERS`
 *   3. `disabled`: anonymous principal (only valid with tenant isolation off)
 *
 * Browser `session_token` and `oidc_session` cookies are intentionally not API
 * credentials; they are handled only by `createWebAuthMiddleware`.
 */
export type AuthnMode = "disabled" | "token" | "oidc" | "token_or_oidc";

export interface ApiAuthOptions {
  mode?: AuthnMode;
  authzEnabled?: boolean;
  tenantIsolationEnabled?: boolean;
  defaultTenantId?: string;
  /**
   * Optional rotation token (Req 11.8): while set, both this and the primary
   * `API_TOKEN` authenticate, allowing clients to roll over without downtime.
   */
  apiTokenNext?: string | null;
}

/**
 * API/MCP authentication. Only machine credentials are accepted here:
 * static Bearer API_TOKEN and/or verified OIDC Bearer JWT according to mode.
 * Browser cookies are intentionally never API credentials.
 */
export function createAuthMiddleware(
  apiToken: string | null,
  _oidc?: OidcSessionChecker,
  _monitorToken?: string | null,
  jwtVerifier?: JwtVerifier | null,
  servicePrincipal: Pick<
    RequestPrincipal,
    "scopes" | "tenantId"
  > = SERVICE_PRINCIPAL,
  options: ApiAuthOptions = {},
): RequestHandler {
  // Req 11.8: during a rotation both tokens are valid; the matcher ignores
  // null/empty entries, so a single-token setup behaves exactly as before.
  const tokenMatcher = createStaticTokenMatcher([
    apiToken,
    options.apiTokenNext,
  ]);
  const anyTokenConfigured = apiToken !== null || options.apiTokenNext != null;
  const mode: AuthnMode =
    options.mode ??
    (anyTokenConfigured && jwtVerifier
      ? "token_or_oidc"
      : anyTokenConfigured
        ? "token"
        : jwtVerifier
          ? "oidc"
          : "disabled");
  const authzEnabled = options.authzEnabled ?? true;
  const defaultTenantId = options.defaultTenantId?.trim() || "default";
  const tenantIsolationEnabled = options.tenantIsolationEnabled ?? true;

  const normalizePrincipal = (
    principal: RequestPrincipal,
  ): RequestPrincipal => ({
    ...principal,
    tenantId: tenantIsolationEnabled ? principal.tenantId : defaultTenantId,
    ...(!authzEnabled ? { authorizationBypass: true } : {}),
  });

  return (req, res, next) => {
    if (mode === "disabled") {
      setPrincipal(
        req,
        normalizePrincipal({
          userId: undefined,
          userGroups: undefined,
          source: "anonymous",
          tenantId: tenantIsolationEnabled ? undefined : defaultTenantId,
        }),
      );
      return next();
    }

    const authHeader = req.headers["authorization"];
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (bearerToken === null) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (
      (mode === "token" || mode === "token_or_oidc") &&
      tokenMatcher(bearerToken)
    ) {
      // Req 3.4: asserted identity headers are only trusted from a static
      // token whose configured scopes include search.assert-identity.
      const mayAssert =
        servicePrincipal.scopes?.includes(ASSERT_IDENTITY_SCOPE) === true;
      const asserted = mayAssert
        ? readAssertedIdentity(req)
        : { userId: undefined, userGroups: undefined };
      const base =
        asserted.userId !== undefined || asserted.userGroups !== undefined
          ? { ...asserted, source: "asserted" as const }
          : SERVICE_PRINCIPAL;
      setPrincipal(
        req,
        normalizePrincipal({
          ...base,
          ...(servicePrincipal.scopes?.length
            ? { scopes: servicePrincipal.scopes }
            : {}),
          tenantId: tenantIsolationEnabled
            ? servicePrincipal.tenantId
            : defaultTenantId,
        }),
      );
      return next();
    }

    if ((mode === "oidc" || mode === "token_or_oidc") && jwtVerifier) {
      void jwtVerifier
        .verify(bearerToken)
        .then((principal) => {
          if (!principal) {
            res.status(401).json({ error: "Unauthorized" });
            return;
          }
          setPrincipal(
            req,
            normalizePrincipal({
              userId: principal.userId,
              userGroups:
                principal.groups.length > 0 ? principal.groups : undefined,
              tenantId: principal.tenantId,
              ...(principal.scopes?.length ? { scopes: principal.scopes } : {}),
              issuer: principal.iss,
              ...(principal.audience !== undefined
                ? { audience: principal.audience }
                : {}),
              ...(principal.clientId ? { clientId: principal.clientId } : {}),
              ...(principal.jti ? { credentialId: principal.jti } : {}),
              source: "jwt",
            }),
          );
          next();
        })
        .catch(() => res.status(401).json({ error: "Unauthorized" }));
      return;
    }

    res.status(401).json({ error: "Unauthorized" });
  };
}

/**
 * Web UI auth middleware.
 *
 * Token model:
 *   MONITOR_TOKEN — shown on the login form; stored as session cookie.
 *   OIDC session  — accepted after SSO login.
 *
 * Behaviour matrix:
 *   monitorToken set  + no OIDC  → token login page
 *   monitorToken set  + OIDC     → token login page with SSO button
 *   no monitorToken   + OIDC     → direct 302 to /auth/login (no click needed)
 *   no monitorToken   + no OIDC  → all requests pass through (auth disabled)
 */
export function createWebAuthMiddleware(
  monitorToken: string | null,
  oidc?: OidcSessionChecker,
  options: { mode?: AuthnMode } = {},
): RequestHandler {
  const oidcOnly = monitorToken === null && oidc !== undefined;

  const redirectToOidc = (
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
  ): void => {
    const returnTo = encodeURIComponent(req.originalUrl || "/");
    res.redirect(`${oidc!.loginPath}?returnTo=${returnTo}`);
  };

  const renderLogin = (
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
  ): void => {
    if (oidcOnly) {
      redirectToOidc(req, res);
      return;
    }
    res
      .status(200)
      .type("html")
      .send(
        getLoginPageHtml({
          showTokenForm: monitorToken !== null,
          oidcLoginPath: oidc?.loginPath,
        }),
      );
  };

  return (req, res, next) => {
    if (options.mode === "disabled") {
      return next();
    }
    if (monitorToken === null && !oidc) {
      if (options.mode === undefined) {
        // Preserve the legacy standalone call contract. createApp always passes
        // an explicit mode and therefore fails closed outside disabled mode.
        return next();
      }
      res.status(401).json({ error: "Web authentication is not configured" });
      return;
    }

    // Check MONITOR_TOKEN session cookie
    if (monitorToken !== null) {
      const cookieHeader = req.headers["cookie"] ?? "";
      const sessionCookie = parseCookieValue(cookieHeader, "session_token");
      if (sessionCookie !== null && safeEqual(sessionCookie, monitorToken)) {
        return next();
      }
    }

    // Check OIDC session cookie
    if (oidc) {
      oidc
        .verifySession(req)
        .then((session) => {
          if (session) return next();
          renderLogin(req, res);
        })
        .catch(() => renderLogin(req, res));
      return;
    }

    renderLogin(req, res);
  };
}

/**
 * Login handler: POST /login.
 *
 * Validates the submitted token against MONITOR_TOKEN. On success, sets a
 * HttpOnly session cookie (24 h) and redirects to /. The session_token cookie
 * is HttpOnly so JavaScript cannot read it; the auth middleware accepts it
 * directly for subsequent API calls from the browser test page.
 */
export function createLoginHandler(
  monitorToken: string | null,
  secureCookie = false,
): RequestHandler {
  return (req, res) => {
    if (monitorToken === null) {
      res.redirect("/");
      return;
    }

    const token: unknown = (req.body as Record<string, unknown>)["token"];
    const tokenStr = typeof token === "string" ? token : "";

    if (safeEqual(tokenStr, monitorToken)) {
      const secure = secureCookie ? "; Secure" : "";
      res.setHeader("Set-Cookie", [
        `session_token=${encodeURIComponent(tokenStr)}; HttpOnly; SameSite=Strict; Max-Age=86400; Path=/${secure}`,
      ]);
      res.redirect("/");
    } else {
      res
        .status(200)
        .type("html")
        .send(getLoginPageHtml({ error: "Invalid token" }));
    }
  };
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [key, ...valueParts] = pair.split("=");
    if (key !== undefined && key.trim() === name) {
      const raw = valueParts.join("=").trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}
