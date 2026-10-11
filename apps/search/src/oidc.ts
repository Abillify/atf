// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * oidc.ts
 *
 * OpenID Connect login for the admin UI.
 *
 * Implements the Authorization Code flow with PKCE:
 *
 *   1. GET  /auth/login    → redirect the browser to the provider, carrying a
 *                            signed transaction cookie (state + nonce + PKCE
 *                            code_verifier).
 *   2. GET  /auth/callback → validate state, exchange the code for tokens,
 *                            verify the ID token's signature against the
 *                            provider's JWKS, check nonce/issuer/audience,
 *                            enforce the email allow-list, then issue our own
 *                            short-lived signed session cookie.
 *   3. GET  /auth/logout   → clear the session cookie (and bounce through the
 *                            provider's end-session endpoint when available).
 *
 * Provider metadata (authorization/token/JWKS endpoints) is discovered from
 * `<issuer>/.well-known/openid-configuration` and cached in-process. The JWKS
 * is fetched lazily via jose's remote key set, which caches keys and handles
 * key rotation automatically.
 *
 * No server-side session store is required: both the login transaction and the
 * resulting session live entirely in HMAC-signed (HS256) cookies.
 */

import type { RequestHandler, Request } from "express";
import type { Logger } from "pino";
import { createHash, randomBytes } from "node:crypto";
import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  type JWTPayload,
} from "jose";
import {
  base64UrlEncode,
  createDiscoveryClient,
  safeEqual,
} from "@atf/security-kit";
import type { OidcConfig } from "./config.js";

const TX_COOKIE = "oidc_tx";
const SESSION_COOKIE = "oidc_session";
const TX_TTL_SECONDS = 600; // 10 minutes to complete the login round-trip
const CALLBACK_PATH = "/auth/callback";
const SESSION_ISSUER = "vectorsearch-ui";
const SESSION_AUDIENCE = "vectorsearch-ui-session";

/** Verified session identity extracted from the OIDC ID token. */
export interface OidcSession {
  sub: string;
  email?: string;
  name?: string;
  groups?: string[];
}

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface OidcProvider {
  /** Path clients hit to begin the login flow. */
  loginPath: string;
  loginHandler: RequestHandler;
  callbackHandler: RequestHandler;
  logoutHandler: RequestHandler;
  /**
   * Verify the session cookie on an incoming request.
   * Returns the session identity when valid, otherwise null.
   */
  verifySession(req: Request): Promise<OidcSession | null>;
}

export interface OidcProviderDeps {
  logger: Logger;
  /** Add the Secure attribute to cookies (enable behind TLS). */
  secureCookie: boolean;
  /** Resolve the public base URL (scheme + host) for the current request. */
  resolveBaseUrl: (req: Request) => string;
}

export function createOidcProvider(
  config: OidcConfig,
  deps: OidcProviderDeps,
): OidcProvider {
  const { logger, secureCookie, resolveBaseUrl } = deps;
  const hmacKey = new TextEncoder().encode(config.sessionSecret);

  // ── Lazy, cached provider discovery + JWKS ────────────────────────────────
  // The kit discovery client provides single-flight, positive caching (min
  // 5 min) and negative backoff (30 s → 5 min). `issuerMatch:
  // "trailing-slash"` accepts providers like Authentik that embed a trailing
  // slash in `iss`; token verification below therefore uses doc.issuer, the
  // canonical value from the discovery document.
  const discovery = createDiscoveryClient(config.issuer, {
    issuerMatch: "trailing-slash",
  });
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  async function discover(): Promise<DiscoveryDocument> {
    const doc = await discovery.getMetadata();
    if (!doc.authorization_endpoint || !doc.token_endpoint) {
      throw new Error("OIDC discovery document is missing required endpoints");
    }
    return doc as DiscoveryDocument;
  }

  async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (jwks === null) {
      const doc = await discover();
      jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    }
    return jwks;
  }

  function redirectUriFor(req: Request): string {
    if (config.redirectUri) return config.redirectUri;
    return `${resolveBaseUrl(req)}${CALLBACK_PATH}`;
  }

  // ── GET /auth/login ───────────────────────────────────────────────────────
  const loginHandler: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    try {
      const doc = await discover();

      const state = base64UrlEncode(randomBytes(32));
      const nonce = base64UrlEncode(randomBytes(32));
      const codeVerifier = base64UrlEncode(randomBytes(32));
      const codeChallenge = base64UrlEncode(
        createHash("sha256").update(codeVerifier).digest(),
      );

      const rawReturnTo = req.query["returnTo"];
      const returnTo =
        typeof rawReturnTo === "string" &&
        rawReturnTo.startsWith("/") &&
        !rawReturnTo.startsWith("//")
          ? rawReturnTo
          : "/";

      // Persist the transaction in a short-lived signed cookie.
      const tx = await new SignJWT({
        state,
        nonce,
        cv: codeVerifier,
        rt: returnTo,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(`${TX_TTL_SECONDS}s`)
        .sign(hmacKey);
      appendCookie(
        res,
        buildCookie(TX_COOKIE, tx, TX_TTL_SECONDS, secureCookie),
      );

      const authUrl = new URL(doc.authorization_endpoint);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUriFor(req));
      authUrl.searchParams.set("scope", config.scopes);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("nonce", nonce);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      res.redirect(authUrl.toString());
    } catch (err) {
      log.error({ err }, "OIDC login initiation failed");
      next(err);
    }
  };

  // ── GET /auth/callback ─────────────────────────────────────────────────────
  const callbackHandler: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    try {
      // Surface provider-side errors (access_denied, etc.).
      const providerError = req.query["error"];
      if (typeof providerError === "string") {
        const desc = req.query["error_description"];
        log.warn({ providerError, desc }, "OIDC provider returned an error");
        sendAuthError(res, `Login failed: ${providerError}`);
        return;
      }

      const code = req.query["code"];
      const state = req.query["state"];
      if (typeof code !== "string" || typeof state !== "string") {
        sendAuthError(res, "Missing authorization code or state");
        return;
      }

      // Recover and validate the transaction cookie.
      const txCookie = parseCookieValue(req.headers["cookie"] ?? "", TX_COOKIE);
      if (txCookie === null) {
        sendAuthError(res, "Login session expired, please try again");
        return;
      }

      let tx: JWTPayload;
      try {
        tx = (await jwtVerify(txCookie, hmacKey)).payload;
      } catch {
        sendAuthError(res, "Invalid login session, please try again");
        return;
      }

      if (typeof tx["state"] !== "string" || !safeEqual(tx["state"], state)) {
        log.warn("OIDC state mismatch");
        sendAuthError(res, "State mismatch, please try again");
        return;
      }

      const codeVerifier = tx["cv"];
      const nonce = tx["nonce"];
      if (typeof codeVerifier !== "string" || typeof nonce !== "string") {
        sendAuthError(res, "Invalid login session, please try again");
        return;
      }

      // Exchange the authorization code for tokens.
      const doc = await discover();
      const idToken = await exchangeCode({
        tokenEndpoint: doc.token_endpoint,
        code,
        redirectUri: redirectUriFor(req),
        codeVerifier,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });

      // Verify the ID token signature against the provider's JWKS.
      // Use doc.issuer (from the discovery document) as the expected `iss`
      // value — providers like Authentik include a trailing slash in `iss`
      // which may differ from the configured OIDC_ISSUER string.
      const keys = await getJwks();
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: doc.issuer,
        audience: config.clientId,
      });

      // Replay protection: the nonce must match the one we generated.
      if (payload["nonce"] !== nonce) {
        log.warn("OIDC nonce mismatch");
        sendAuthError(res, "Nonce mismatch, please try again");
        return;
      }

      const email =
        typeof payload["email"] === "string" ? payload["email"] : undefined;
      const name =
        typeof payload["name"] === "string" ? payload["name"] : undefined;
      const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
      const groups = normalizeGroups(payload[config.groupsClaim]);

      if (subject === "") {
        log.warn("OIDC login rejected: ID token has no subject");
        sendAuthError(res, "This account has no usable identity");
        return;
      }

      if (!isEmailAllowed(email, config)) {
        log.warn({ email }, "OIDC login rejected: email not allowed");
        sendAuthError(res, "This account is not authorized to sign in");
        return;
      }

      // Issue our own signed, purpose-bound session cookie. Only verified ID
      // token values are carried forward; tenant and scopes stay server-side.
      const session = await new SignJWT({
        email,
        name,
        ...(groups.length > 0 ? { groups } : {}),
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(subject)
        .setIssuer(SESSION_ISSUER)
        .setAudience(SESSION_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${config.sessionTtlSeconds}s`)
        .sign(hmacKey);

      appendCookie(
        res,
        buildCookie(
          SESSION_COOKIE,
          session,
          config.sessionTtlSeconds,
          secureCookie,
        ),
      );
      // Clear the now-consumed transaction cookie.
      appendCookie(res, buildCookie(TX_COOKIE, "", 0, secureCookie));

      const rt =
        typeof tx["rt"] === "string" &&
        tx["rt"].startsWith("/") &&
        !tx["rt"].startsWith("//")
          ? tx["rt"]
          : "/";
      log.info({ sub: subject, email }, "OIDC login successful");
      res.redirect(rt);
    } catch (err) {
      log.error({ err }, "OIDC callback failed");
      sendAuthError(res, "Login failed, please try again");
    }
  };

  // ── GET /auth/logout ───────────────────────────────────────────────────────
  const logoutHandler: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    try {
      appendCookie(res, buildCookie(SESSION_COOKIE, "", 0, secureCookie));

      const doc = await discover().catch(() => null);
      if (doc?.end_session_endpoint) {
        const url = new URL(doc.end_session_endpoint);
        url.searchParams.set(
          "post_logout_redirect_uri",
          resolveBaseUrl(req) + "/",
        );
        url.searchParams.set("client_id", config.clientId);
        res.redirect(url.toString());
        return;
      }
      res.redirect("/");
    } catch (err) {
      log.error({ err }, "OIDC logout failed");
      next(err);
    }
  };

  async function verifySession(req: Request): Promise<OidcSession | null> {
    const raw = parseCookieValue(req.headers["cookie"] ?? "", SESSION_COOKIE);
    if (raw === null) return null;
    try {
      const { payload } = await jwtVerify(raw, hmacKey, {
        issuer: SESSION_ISSUER,
        audience: SESSION_AUDIENCE,
      });
      if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
        return null;
      }
      const groups = normalizeGroups(payload["groups"]);
      return {
        sub: payload.sub.trim(),
        email:
          typeof payload["email"] === "string" ? payload["email"] : undefined,
        name: typeof payload["name"] === "string" ? payload["name"] : undefined,
        ...(groups.length > 0 ? { groups } : {}),
      };
    } catch {
      return null;
    }
  }

  return {
    loginPath: "/auth/login",
    loginHandler,
    callbackHandler,
    logoutHandler,
    verifySession,
  };
}

// ───────────────────────────── helpers ──────────────────────────────────────

interface ExchangeArgs {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
}

/** Exchange an authorization code for tokens; returns the raw id_token. */
async function exchangeCode(args: ExchangeArgs): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });

  const res = await fetch(args.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== "string") {
    throw new Error("Token response did not include an id_token");
  }
  return json.id_token;
}

function normalizeGroups(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return [...new Set(
    raw
      .filter((group): group is string => typeof group === "string")
      .map((group) => group.trim())
      .filter(Boolean),
  )];
}

function isEmailAllowed(
  email: string | undefined,
  config: OidcConfig,
): boolean {
  const hasEmailRule = config.allowedEmails.length > 0;
  const hasDomainRule = config.allowedEmailDomains.length > 0;
  if (!hasEmailRule && !hasDomainRule) return true; // no restriction configured

  if (!email) return false;
  const lower = email.toLowerCase();
  if (hasEmailRule && config.allowedEmails.includes(lower)) return true;

  if (hasDomainRule) {
    const at = lower.lastIndexOf("@");
    const domain = at >= 0 ? lower.slice(at + 1) : "";
    if (domain && config.allowedEmailDomains.includes(domain)) return true;
  }
  return false;
}

function buildCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${name}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function appendCookie(
  res: { getHeader: (n: string) => unknown; setHeader: (n: string, v: string[]) => void },
  cookie: string,
): void {
  const existing = res.getHeader("Set-Cookie");
  const list = Array.isArray(existing)
    ? existing.map(String)
    : existing !== undefined
      ? [String(existing)]
      : [];
  list.push(cookie);
  res.setHeader("Set-Cookie", list);
}

function sendAuthError(
  res: { status: (c: number) => { type: (t: string) => { send: (b: string) => void } } },
  message: string,
): void {
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  res
    .status(401)
    .type("html")
    .send(`<!DOCTYPE html>
<html>
<head><title>vectorsearch — Login</title></head>
<body>
  <h1>Login failed</h1>
  <p style="color:red">${safe}</p>
  <p><a href="/auth/login">Try again</a> — <a href="/">Back to start</a></p>
</body>
</html>`);
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
