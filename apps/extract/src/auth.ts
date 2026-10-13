// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * auth.ts
 *
 * Authentication for the API and for the browser UI — kept as two separate
 * middlewares on purpose.
 *
 * The separation is the security boundary. `createAuthMiddleware` accepts only
 * *machine* credentials (a static Bearer token, or a Bearer JWT verified against
 * the configured issuers). It never looks at cookies. `createWebAuthMiddleware`
 * accepts only *browser* credentials (an OIDC session cookie, or a token-login
 * cookie). Letting a cookie authenticate an API call is how a CSRF becomes a
 * document upload; letting a Bearer token authenticate the UI means the UI's
 * credential grants full programmatic access.
 *
 * Mirrors `apps/search/src/auth.ts` so an operator configures one credential
 * model for the whole fabric.
 */

import { createStaticTokenMatcher, safeEqual } from "@atf/security-kit";
import type { Request, RequestHandler } from "express";
import type { AuthnMode } from "./config.js";
import type { JwtVerifier } from "./jwt-verifier.js";
import {
  SERVICE_PRINCIPAL,
  readAssertedIdentity,
  setPrincipal,
  type RequestPrincipal,
} from "./request-principal.js";

export type { AuthnMode };

/**
 * The minimum this module needs from the OIDC provider.
 *
 * Structural rather than importing `OidcProvider` so auth.ts has no hard
 * dependency on the oidc module and stays trivially testable with a stub.
 */
export interface OidcSessionChecker {
  /** Path that starts the OIDC login flow (e.g. "/auth/login"). */
  loginPath: string;
  /** Resolve to a truthy session when the request carries a valid one. */
  verifySession(req: Request): Promise<unknown>;
}

function parseCookieValue(cookieHeader: string, name: string): string | null {
  for (const pair of cookieHeader.split(";")) {
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
    ? `<p><a class="sso" href="${htmlEscape(oidcLoginPath)}">Mit SSO anmelden</a></p>`
    : "";
  const tokenBlock = showTokenForm
    ? `<form method="POST" action="/login">
      <label for="token">Token</label>
      <input id="token" type="password" name="token" autocomplete="current-password" />
      <button type="submit">Anmelden</button>
    </form>`
    : "";
  const separator = ssoBlock && tokenBlock ? '<p class="or">oder</p>' : "";
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ATF Extract — Anmeldung</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 16px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; }
    main { width: min(22rem, 90vw); }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; }
    label { display: block; margin-bottom: .25rem; font-weight: 500; }
    input, button, .sso { width: 100%; box-sizing: border-box; padding: .6rem .75rem; border-radius: .375rem; font: inherit; }
    input { border: 1px solid currentColor; background: transparent; color: inherit; }
    button, .sso { margin-top: .75rem; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; display: block; text-align: center; text-decoration: none; }
    .or { text-align: center; opacity: .7; margin: 1rem 0; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <main>
    <h1>ATF Extract</h1>
    ${error ? `<p class="error" role="alert">${htmlEscape(error)}</p>` : ""}
    ${ssoBlock}
    ${separator}
    ${tokenBlock}
  </main>
</body>
</html>`;
}

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
 * API authentication.
 *
 * Accepted credentials are determined exclusively by `AUTHN_MODE`:
 *
 *   `token` / `token_or_oidc` — Bearer `API_TOKEN`
 *   `oidc`  / `token_or_oidc` — Bearer JWT verified against `API_OIDC_ISSUERS`
 *   `disabled`                — anonymous principal (development only)
 *
 * Browser cookies are intentionally never API credentials.
 */
export function createAuthMiddleware(
  apiToken: string | null,
  jwtVerifier: JwtVerifier | null,
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

  const normalize = (principal: RequestPrincipal): RequestPrincipal => ({
    ...principal,
    tenantId: tenantIsolationEnabled ? principal.tenantId : defaultTenantId,
    ...(!authzEnabled ? { authorizationBypass: true } : {}),
  });

  const unauthorized = (res: Parameters<RequestHandler>[1]): void => {
    // WWW-Authenticate so a CLI or SDK can discover the scheme instead of
    // guessing from a bare 401.
    res.setHeader("WWW-Authenticate", 'Bearer realm="atf-extract"');
    res
      .status(401)
      .json({ error: "Unauthorized", code: "UNAUTHORIZED", retryable: false });
  };

  return (req, res, next) => {
    if (mode === "disabled") {
      setPrincipal(
        req,
        normalize({
          userId: undefined,
          userGroups: undefined,
          source: "anonymous",
          tenantId: tenantIsolationEnabled ? undefined : defaultTenantId,
        }),
      );
      next();
      return;
    }

    const authHeader = req.headers["authorization"];
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
    if (bearerToken === null) {
      unauthorized(res);
      return;
    }

    if (
      (mode === "token" || mode === "token_or_oidc") &&
      tokenMatcher(bearerToken)
    ) {
      const asserted = readAssertedIdentity(req);
      const base =
        asserted.userId !== undefined || asserted.userGroups !== undefined
          ? { ...asserted, source: "asserted" as const }
          : SERVICE_PRINCIPAL;
      setPrincipal(
        req,
        normalize({
          ...base,
          ...(servicePrincipal.scopes?.length
            ? { scopes: servicePrincipal.scopes }
            : {}),
          tenantId: tenantIsolationEnabled
            ? servicePrincipal.tenantId
            : defaultTenantId,
        }),
      );
      next();
      return;
    }

    if ((mode === "oidc" || mode === "token_or_oidc") && jwtVerifier) {
      void jwtVerifier
        .verify(bearerToken)
        .then((principal) => {
          if (!principal) {
            unauthorized(res);
            return;
          }
          setPrincipal(
            req,
            normalize({
              userId: principal.userId,
              userGroups:
                principal.groups.length > 0 ? principal.groups : undefined,
              tenantId: principal.tenantId,
              ...(principal.scopes.length ? { scopes: principal.scopes } : {}),
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
        .catch(() => unauthorized(res));
      return;
    }

    unauthorized(res);
  };
}

/**
 * Browser UI authentication.
 *
 * Behaviour matrix:
 *   monitorToken set + no OIDC → token login page
 *   monitorToken set + OIDC    → login page with an SSO button
 *   no monitorToken  + OIDC    → direct 302 to /auth/login (no click needed)
 *   mode `disabled`            → everything passes through
 *
 * With neither credential configured and a mode other than `disabled`, this
 * fails closed with 401 rather than serving the UI: an unauthenticated upload
 * page is precisely what the production gate exists to prevent.
 */
export function createWebAuthMiddleware(
  monitorToken: string | null,
  oidc: OidcSessionChecker | undefined,
  options: { mode: AuthnMode },
): RequestHandler {
  const oidcOnly = monitorToken === null && oidc !== undefined;

  const redirectToOidc = (
    req: Parameters<RequestHandler>[0],
    res: Parameters<RequestHandler>[1],
  ): void => {
    if (oidc === undefined) {
      res.status(401).json({ error: "Web authentication is not configured" });
      return;
    }
    res.redirect(`${oidc.loginPath}?returnTo=${encodeURIComponent(req.originalUrl || "/")}`);
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
          ...(oidc !== undefined ? { oidcLoginPath: oidc.loginPath } : {}),
        }),
      );
  };

  return (req, res, next) => {
    if (options.mode === "disabled") {
      next();
      return;
    }
    if (monitorToken === null && oidc === undefined) {
      res
        .status(401)
        .json({ error: "Web authentication is not configured", code: "UNAUTHORIZED" });
      return;
    }

    if (monitorToken !== null) {
      const sessionCookie = parseCookieValue(req.headers["cookie"] ?? "", "session_token");
      if (sessionCookie !== null && safeEqual(sessionCookie, monitorToken)) {
        next();
        return;
      }
    }

    if (oidc !== undefined) {
      oidc
        .verifySession(req)
        .then((session) => {
          if (session) next();
          else renderLogin(req, res);
        })
        .catch(() => renderLogin(req, res));
      return;
    }

    renderLogin(req, res);
  };
}

/**
 * `POST /login` — validates the submitted token against `MONITOR_TOKEN`.
 *
 * On success sets an HttpOnly session cookie. `SameSite=Strict` because this
 * cookie authenticates the UI, and the UI performs uploads.
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
    const token: unknown = (req.body as Record<string, unknown> | undefined)?.["token"];
    const tokenStr = typeof token === "string" ? token : "";

    if (safeEqual(tokenStr, monitorToken)) {
      const secure = secureCookie ? "; Secure" : "";
      res.setHeader("Set-Cookie", [
        `session_token=${encodeURIComponent(tokenStr)}; HttpOnly; SameSite=Strict; Max-Age=86400; Path=/${secure}`,
      ]);
      res.redirect("/");
      return;
    }
    res.status(200).type("html").send(getLoginPageHtml({ error: "Ungültiger Token" }));
  };
}
