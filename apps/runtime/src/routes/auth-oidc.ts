// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OIDC login for the operator/frontend plane — backend-driven (BFF).
 * (`src/routes/auth-oidc.ts`)
 *
 * Implements a **confidential-client** OpenID Connect Authorization-Code flow
 * that runs entirely on the BACKEND, so the client secret never reaches the
 * browser and the dashboard needs no build-time (`NEXT_PUBLIC_*`) OIDC config —
 * only runtime env on the backend.
 *
 * Flow (all under `/monitoring/auth/*`, which the reverse proxy already routes
 * to the backend, so no extra proxy rule is needed):
 *   GET  /monitoring/auth/config    — { enabled, autoLogin } for the dashboard
 *   GET  /monitoring/auth/login     — 302 → IdP authorize (state/nonce/PKCE in a
 *                                     short-lived signed HttpOnly cookie)
 *   GET  /monitoring/auth/callback  — IdP redirects back; the backend exchanges
 *                                     the code (client_id+secret), verifies the
 *                                     id_token (JWKS+iss+aud+nonce), maps the
 *                                     identity to an operator role, MINTS a
 *                                     short-lived HS256 session token, and
 *                                     redirects to the dashboard with it in the
 *                                     URL fragment (never logged server-side).
 *   POST /monitoring/auth/logout    — best-effort IdP end-session URL
 *
 * The minted session token is a normal HS256 JWT carrying the resolved `role`
 * claim, signed with OIDC_SESSION_SECRET. The operator plane verifies it via the
 * operator verifier (HMAC over that secret) and reads the role through the
 * existing RBAC — so this touches ONLY the operator/monitoring auth, never the
 * `/v1` API plane.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet, SignJWT } from "jose";
import {
  resolveOperatorRoleFromClaims,
  type OperatorRole,
} from "../middleware/operator-rbac.js";
import type { Logger } from "../observability/logger.js";
import type { OidcSessionStore } from "./oidc-session-store.js";

export interface OidcAuthConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
  sessionTtlSeconds: number;
  scopes: string;
  audience?: string;
  redirectUri?: string;
  dashboardUrl?: string;
  autoLogin: boolean;
  /**
   * Lifetime (seconds) of the server-side refresh session (the window in which
   * the dashboard can silently renew without a fresh interactive login).
   * Should not exceed the IdP refresh-token lifetime. Default 30 days.
   */
  refreshSessionTtlSeconds?: number;
  // Role resolution (shared with the operator authorizer).
  roleClaim?: string;
  groupsClaim?: string;
  roleMap?: Record<string, OperatorRole>;
  defaultRole?: OperatorRole;
}

export interface OidcAuthRouterDeps {
  config: OidcAuthConfig;
  /**
   * Server-side store holding the IdP refresh token keyed by an opaque session
   * id (kept in an HttpOnly cookie). When present, `GET /monitoring/auth/refresh`
   * can mint a fresh session token without an interactive login. When omitted,
   * refresh is disabled (pre-refresh behaviour) and that endpoint 401s.
   */
  sessionStore?: OidcSessionStore;
  logger?: Logger;
}

const FLOW_COOKIE = "aiperator_oidc_flow";
/** HttpOnly cookie holding the opaque refresh-session id (never the token itself). */
const SESSION_COOKIE = "aiperator_oidc_session";
const DEFAULT_REFRESH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Guarantees the authorize request asks for the scopes refresh requires:
 * `openid` (to get an id_token) and `offline_access` (to get a refresh_token).
 * Configured scopes are preserved and de-duplicated; order is not significant.
 */
function ensureRefreshScopes(scopes: string): string {
  const set = new Set(scopes.split(/\s+/).filter((s) => s.length > 0));
  set.add("openid");
  set.add("offline_access");
  return [...set].join(" ");
}

interface OidcMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

// ---------------------------------------------------------------------------
// Small helpers (crypto / cookies / URLs) — dependency-free.
// ---------------------------------------------------------------------------

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLength = 32): string {
  const b = new Uint8Array(byteLength);
  crypto.getRandomValues(b);
  return base64Url(b);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (cookieHeader === undefined || cookieHeader === "") return null;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/monitoring/auth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${opts.maxAge}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function requestOrigin(req: {
  header: (name: string) => string | undefined;
  url: string;
}): string {
  const fwdProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const fwdHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const u = new URL(req.url);
  const proto = fwdProto ?? u.protocol.replace(":", "");
  const host = fwdHost ?? req.header("host") ?? u.host;
  return `${proto}://${host}`;
}

function isSecure(origin: string): boolean {
  return origin.startsWith("https://");
}

/**
 * Chooses the post-login return URL, guarding against open redirects: an
 * absolute `redirect` param is accepted only when its origin matches the
 * configured dashboard origin (or, when none is configured, the request
 * origin). Otherwise falls back to the dashboard URL, then "/".
 */
function pickReturnUrl(
  redirectParam: string | undefined,
  dashboardUrl: string | undefined,
  reqOrigin: string,
): string {
  const allowedOrigin =
    dashboardUrl !== undefined ? safeOrigin(dashboardUrl) : reqOrigin;
  if (redirectParam !== undefined && redirectParam !== "") {
    const o = safeOrigin(redirectParam);
    if (o !== null && o === allowedOrigin) return redirectParam;
  }
  return dashboardUrl ?? "/";
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function withFragment(baseUrl: string, fragment: string): string {
  const hashIdx = baseUrl.indexOf("#");
  const clean = hashIdx === -1 ? baseUrl : baseUrl.slice(0, hashIdx);
  return `${clean}#${fragment}`;
}

// ---------------------------------------------------------------------------
// Discovery (memoised per issuer).
// ---------------------------------------------------------------------------

const metadataCache = new Map<string, OidcMetadata>();

async function discover(issuer: string): Promise<OidcMetadata> {
  const cached = metadataCache.get(issuer);
  if (cached !== undefined) return cached;
  const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  const res = await fetch(`${base}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  }
  const doc = (await res.json()) as Partial<OidcMetadata>;
  if (
    typeof doc.authorization_endpoint !== "string" ||
    typeof doc.token_endpoint !== "string" ||
    typeof doc.jwks_uri !== "string"
  ) {
    throw new Error("OIDC discovery document is missing required endpoints.");
  }
  const meta: OidcMetadata = {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    ...(typeof doc.end_session_endpoint === "string"
      ? { end_session_endpoint: doc.end_session_endpoint }
      : {}),
  };
  metadataCache.set(issuer, meta);
  return meta;
}

// Per-issuer JWKS set (cached + rotated internally by jose).
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwksFor(meta: OidcMetadata): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(meta.jwks_uri);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    jwksCache.set(meta.jwks_uri, jwks);
  }
  return jwks;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

interface FlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirect: string;
}

/** Token endpoint response shape we consume (extra fields are ignored). */
interface TokenResponse {
  id_token?: string;
  refresh_token?: string;
}

export function createOidcAuthRouter(deps: OidcAuthRouterDeps): Hono {
  const app = new Hono();
  const { config, sessionStore, logger } = deps;
  const sessionKey = new TextEncoder().encode(config.sessionSecret);
  const audience = config.audience ?? config.clientId;
  const scopes = ensureRefreshScopes(config.scopes);
  const refreshSessionTtl =
    config.refreshSessionTtlSeconds ?? DEFAULT_REFRESH_SESSION_TTL_SECONDS;

  /**
   * Verifies an id_token, resolves the operator role from its claims and mints
   * the short-lived HS256 operator session token. Returns the signed token plus
   * the identity subject, or undefined when the token is invalid / the identity
   * has no operator role. Shared by the login callback and the refresh path so
   * both apply the SAME authorization check on every (re)issue.
   */
  const verifyAndMintSession = async (
    idToken: string,
    meta: OidcMetadata,
    expectedNonce?: string,
  ): Promise<{ session: string; sub: string } | undefined> => {
    const { payload } = await jwtVerify(idToken, jwksFor(meta), {
      issuer: config.issuer,
      audience,
    });
    if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
      return undefined;
    }
    const claims = payload as Record<string, unknown>;
    const role = resolveOperatorRoleFromClaims(claims, {
      ...(config.roleClaim !== undefined
        ? { roleClaim: config.roleClaim }
        : {}),
      ...(config.groupsClaim !== undefined
        ? { groupsClaim: config.groupsClaim }
        : {}),
      ...(config.roleMap !== undefined ? { roleMap: config.roleMap } : {}),
      ...(config.defaultRole !== undefined
        ? { defaultRole: config.defaultRole }
        : {}),
    });
    if (role === undefined) return undefined;

    const email =
      typeof claims.email === "string" ? claims.email : undefined;
    const name =
      (typeof claims.name === "string" && claims.name) ||
      email ||
      (typeof claims.preferred_username === "string"
        ? (claims.preferred_username as string)
        : undefined);
    const sub = typeof claims.sub === "string" ? claims.sub : "operator";

    const session = await new SignJWT({
      role,
      ...(email !== undefined ? { email } : {}),
      ...(name !== undefined ? { name } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("aiperator")
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + config.sessionTtlSeconds,
      )
      .sign(sessionKey);
    return { session, sub };
  };

  app.get("/monitoring/auth/config", (ctx) =>
    ctx.json({ enabled: true, autoLogin: config.autoLogin, required: true }),
  );

  app.get("/monitoring/auth/login", async (ctx) => {
    try {
      const meta = await discover(config.issuer);
      const origin = requestOrigin(ctx.req);
      const redirectUri =
        config.redirectUri ?? `${origin}/monitoring/auth/callback`;
      const returnUrl = pickReturnUrl(
        ctx.req.query("redirect"),
        config.dashboardUrl,
        origin,
      );

      const flow: FlowState = {
        state: randomToken(16),
        nonce: randomToken(16),
        codeVerifier: randomToken(32),
        redirect: returnUrl,
      };
      const challenge = await pkceChallenge(flow.codeVerifier);

      // Stash the flow state in a short-lived signed HttpOnly cookie.
      const flowJwt = await new SignJWT({ ...flow })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(sessionKey);
      ctx.header(
        "Set-Cookie",
        serializeCookie(FLOW_COOKIE, flowJwt, {
          maxAge: 600,
          secure: isSecure(origin),
        }),
      );

      const params = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: scopes,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return ctx.redirect(
        `${meta.authorization_endpoint}?${params.toString()}`,
      );
    } catch (err) {
      logger?.error("OIDC login initiation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return ctx.json({ error: "oidc_login_failed" }, 500);
    }
  });

  app.get("/monitoring/auth/callback", async (ctx) => {
    const origin = requestOrigin(ctx.req);
    // Recover + clear the flow cookie regardless of outcome.
    const flowCookie = readCookie(ctx.req.header("Cookie"), FLOW_COOKIE);
    ctx.header(
      "Set-Cookie",
      serializeCookie(FLOW_COOKIE, "", { maxAge: 0, secure: isSecure(origin) }),
    );

    let flow: FlowState | null = null;
    if (flowCookie !== null) {
      try {
        const { payload } = await jwtVerify(flowCookie, sessionKey);
        flow = {
          state: String(payload.state ?? ""),
          nonce: String(payload.nonce ?? ""),
          codeVerifier: String(payload.codeVerifier ?? ""),
          redirect: String(payload.redirect ?? config.dashboardUrl ?? "/"),
        };
      } catch {
        flow = null;
      }
    }
    const returnUrl = flow?.redirect ?? config.dashboardUrl ?? "/";
    const fail = (reason: string): Response =>
      ctx.redirect(
        withFragment(returnUrl, `auth_error=${encodeURIComponent(reason)}`),
      );

    const idpError = ctx.req.query("error");
    if (idpError !== null && idpError !== undefined) return fail(idpError);
    if (flow === null) return fail("state_expired");

    const code = ctx.req.query("code");
    const state = ctx.req.query("state");
    if (typeof code !== "string" || code === "") return fail("missing_code");
    if (state !== flow.state) return fail("state_mismatch");

    try {
      const meta = await discover(config.issuer);
      const redirectUri =
        config.redirectUri ?? `${origin}/monitoring/auth/callback`;

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: flow.codeVerifier,
      });
      const tokenRes = await fetch(meta.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
      if (!tokenRes.ok) {
        logger?.warn("OIDC token exchange failed", { status: tokenRes.status });
        return fail("token_exchange_failed");
      }
      const tokens = (await tokenRes.json()) as TokenResponse;
      if (typeof tokens.id_token !== "string") return fail("no_id_token");

      // Verify the id_token (signature + iss + aud + nonce), resolve the role
      // and mint the operator session token.
      const minted = await verifyAndMintSession(
        tokens.id_token,
        meta,
        flow.nonce,
      );
      if (minted === undefined) {
        logger?.info(
          "OIDC login denied — invalid id_token or no operator role",
        );
        return fail("forbidden");
      }

      // Persist the refresh token server-side (never handed to the browser) so
      // the dashboard can silently renew. The browser only receives an opaque
      // session id in an HttpOnly cookie.
      if (
        sessionStore !== undefined &&
        typeof tokens.refresh_token === "string" &&
        tokens.refresh_token !== ""
      ) {
        const sessionId = randomToken(32);
        await sessionStore.set(
          sessionId,
          { refreshToken: tokens.refresh_token, sub: minted.sub },
          refreshSessionTtl,
        );
        ctx.header(
          "Set-Cookie",
          serializeCookie(SESSION_COOKIE, sessionId, {
            maxAge: refreshSessionTtl,
            secure: isSecure(origin),
          }),
        );
      }

      logger?.info("OIDC operator login", { sub: minted.sub });
      return ctx.redirect(withFragment(returnUrl, `session=${minted.session}`));
    } catch (err) {
      logger?.warn("OIDC callback failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return fail("callback_failed");
    }
  });

  // Silent renewal — exchanges the stored refresh token for a fresh id_token and
  // mints a new operator session token, WITHOUT an interactive login. Called by
  // the dashboard (fetch with credentials) shortly before the current session
  // token expires, or after a 401. Returns 401 when there is no valid session so
  // the client falls back to an interactive login.
  app.get("/monitoring/auth/refresh", async (ctx) => {
    const origin = requestOrigin(ctx.req);
    const clearSessionCookie = (): void =>
      ctx.header(
        "Set-Cookie",
        serializeCookie(SESSION_COOKIE, "", {
          maxAge: 0,
          secure: isSecure(origin),
        }),
      );

    if (sessionStore === undefined) {
      return ctx.json({ error: "refresh_unavailable" }, 401);
    }
    const sessionId = readCookie(ctx.req.header("Cookie"), SESSION_COOKIE);
    if (sessionId === null) {
      return ctx.json({ error: "no_session" }, 401);
    }
    const record = await sessionStore.get(sessionId);
    if (record === undefined) {
      clearSessionCookie();
      return ctx.json({ error: "session_expired" }, 401);
    }

    try {
      const meta = await discover(config.issuer);
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: record.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: scopes,
      });
      const tokenRes = await fetch(meta.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
      if (!tokenRes.ok) {
        // Refresh token rejected (revoked / expired) — drop the session so the
        // client re-authenticates instead of retrying a dead token forever.
        logger?.info("OIDC refresh rejected by IdP", {
          status: tokenRes.status,
        });
        await sessionStore.delete(sessionId);
        clearSessionCookie();
        return ctx.json({ error: "refresh_rejected" }, 401);
      }
      const tokens = (await tokenRes.json()) as TokenResponse;
      if (typeof tokens.id_token !== "string") {
        await sessionStore.delete(sessionId);
        clearSessionCookie();
        return ctx.json({ error: "no_id_token" }, 401);
      }

      // Re-verify + re-authorize on every renewal (role may have been revoked).
      const minted = await verifyAndMintSession(tokens.id_token, meta);
      if (minted === undefined) {
        await sessionStore.delete(sessionId);
        clearSessionCookie();
        return ctx.json({ error: "forbidden" }, 401);
      }

      // Rotate: persist a new refresh token when the IdP issues one, and reset
      // the session TTL either way so an active operator's window slides.
      const nextRefresh =
        typeof tokens.refresh_token === "string" && tokens.refresh_token !== ""
          ? tokens.refresh_token
          : record.refreshToken;
      await sessionStore.set(
        sessionId,
        {
          refreshToken: nextRefresh,
          ...(minted.sub !== undefined ? { sub: minted.sub } : {}),
        },
        refreshSessionTtl,
      );

      return ctx.json({
        session: minted.session,
        expiresIn: config.sessionTtlSeconds,
      });
    } catch (err) {
      logger?.warn("OIDC refresh failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return ctx.json({ error: "refresh_failed" }, 500);
    }
  });

  app.post("/monitoring/auth/logout", async (ctx) => {
    const origin = requestOrigin(ctx.req);
    // Drop the server-side refresh session (if any) and clear its cookie so a
    // logged-out browser cannot silently renew.
    const sessionId = readCookie(ctx.req.header("Cookie"), SESSION_COOKIE);
    if (sessionId !== null && sessionStore !== undefined) {
      await sessionStore.delete(sessionId);
    }
    ctx.header(
      "Set-Cookie",
      serializeCookie(SESSION_COOKIE, "", {
        maxAge: 0,
        secure: isSecure(origin),
      }),
    );

    // The client also drops its token. Offer the IdP end-session URL for
    // optional RP-initiated logout.
    try {
      const meta = await discover(config.issuer);
      if (meta.end_session_endpoint !== undefined) {
        const params = new URLSearchParams({ client_id: config.clientId });
        if (config.dashboardUrl !== undefined) {
          params.set("post_logout_redirect_uri", config.dashboardUrl);
        }
        return ctx.json({
          endSessionUrl: `${meta.end_session_endpoint}?${params.toString()}`,
        });
      }
    } catch {
      /* discovery unavailable — client-side token drop still logs out locally */
    }
    return ctx.json({ endSessionUrl: null });
  });

  return app;
}
