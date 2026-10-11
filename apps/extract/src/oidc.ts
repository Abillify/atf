// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * oidc.ts
 *
 * OpenID Connect login for the upload UI, using the Authorization Code flow with
 * PKCE:
 *
 *   1. GET /auth/login    → redirect to the provider, carrying a signed
 *                           transaction cookie (state + nonce + PKCE verifier).
 *   2. GET /auth/callback → validate state, exchange the code, verify the ID
 *                           token against the provider's JWKS, check
 *                           nonce/issuer/audience, enforce the email allow-list,
 *                           then issue our own short-lived session cookie.
 *   3. GET /auth/logout   → clear the session and bounce through the provider's
 *                           end-session endpoint when it has one.
 *
 * Deliberately the same implementation as `apps/search/src/oidc.ts`, so one IdP
 * client can serve both services and an operator debugs one flow, not two.
 *
 * No server-side session store: both the login transaction and the session are
 * HS256-signed cookies. That keeps the service horizontally scalable with no
 * shared state, which matters because conversions are long-running and instances
 * are recycled.
 *
 * Cookie names are prefixed `atf_extract_` rather than reusing Search's
 * `oidc_session`. Behind a path-routing reverse proxy both services share an
 * origin, and identically named cookies would silently overwrite each other —
 * logging into one would log you out of the other.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  base64UrlEncode,
  createDiscoveryClient,
  safeEqual,
} from "@atf/security-kit";
import type { Logger } from "pino";
import type { OidcConfig } from "./config.js";

const TX_COOKIE = "atf_extract_tx";
const SESSION_COOKIE = "atf_extract_session";
const TX_TTL_SECONDS = 600; // 10 minutes to complete the login round-trip
const CALLBACK_PATH = "/auth/callback";
const SESSION_ISSUER = "atf-extract-ui";
const SESSION_AUDIENCE = "atf-extract-ui-session";

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
  /** Verify the session cookie; returns the identity or null. */
  verifySession(req: Request): Promise<OidcSession | null>;
}

export interface OidcProviderDeps {
  logger: Logger;
  /** Add the Secure attribute to cookies (enable behind TLS). */
  secureCookie: boolean;
  /** Resolve the public base URL for the current request. */
  resolveBaseUrl: (req: Request) => string;
}

export function createOidcProvider(
  config: OidcConfig,
  deps: OidcProviderDeps,
): OidcProvider {
  const { logger, secureCookie, resolveBaseUrl } = deps;
  const hmacKey = new TextEncoder().encode(config.sessionSecret);

  // ── Lazy, cached provider discovery + JWKS ────────────────────────────────
  // Kit discovery: single-flight, positive cache (min 5 min), negative backoff
  // (30 s → 5 min) and jwks_uri validation (Req 7.3). `issuerMatch:
  // "trailing-slash"` tolerates providers like Authentik that embed a trailing
  // slash in `iss`; token verification below uses doc.issuer, the canonical
  // value, so the `iss` claim always matches.
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
    const log: Logger = (req as Request & { log?: Logger }).log ?? logger;
    try {
      const doc = await discover();

      const state = base64UrlEncode(randomBytes(32));
      const nonce = base64UrlEncode(randomBytes(32));
      const codeVerifier = base64UrlEncode(randomBytes(32));
      const codeChallenge = base64UrlEncode(
        createHash("sha256").update(codeVerifier).digest(),
      );

      // Open-redirect guard: only same-site absolute paths survive, and `//`
      // is rejected because it is a protocol-relative URL to another host.
      const rawReturnTo = req.query["returnTo"];
      const returnTo =
        typeof rawReturnTo === "string" &&
        rawReturnTo.startsWith("/") &&
        !rawReturnTo.startsWith("//")
          ? rawReturnTo
          : "/";

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

  // ── GET /auth/callback ────────────────────────────────────────────────────
  const callbackHandler: RequestHandler = async (req, res) => {
    const log: Logger = (req as Request & { log?: Logger }).log ?? logger;
    try {
      const providerError = req.query["error"];
      if (typeof providerError === "string") {
        log.warn(
          { providerError, description: req.query["error_description"] },
          "OIDC provider returned an error",
        );
        sendAuthError(res, `Anmeldung fehlgeschlagen: ${providerError}`);
        return;
      }

      const code = req.query["code"];
      const state = req.query["state"];
      if (typeof code !== "string" || typeof state !== "string") {
        sendAuthError(res, "Autorisierungscode oder State fehlt");
        return;
      }

      const txCookie = parseCookieValue(req.headers["cookie"] ?? "", TX_COOKIE);
      if (txCookie === null) {
        sendAuthError(res, "Anmeldevorgang abgelaufen, bitte erneut versuchen");
        return;
      }

      let tx: JWTPayload;
      try {
        tx = (await jwtVerify(txCookie, hmacKey)).payload;
      } catch {
        sendAuthError(res, "Ungültiger Anmeldevorgang, bitte erneut versuchen");
        return;
      }

      const txState = tx["state"];
      if (typeof txState !== "string" || !safeEqual(txState, state)) {
        log.warn("OIDC state mismatch");
        sendAuthError(
          res,
          "State stimmt nicht überein, bitte erneut versuchen",
        );
        return;
      }

      const codeVerifier = tx["cv"];
      const nonce = tx["nonce"];
      if (typeof codeVerifier !== "string" || typeof nonce !== "string") {
        sendAuthError(res, "Ungültiger Anmeldevorgang, bitte erneut versuchen");
        return;
      }

      const doc = await discover();
      const idToken = await exchangeCode({
        tokenEndpoint: doc.token_endpoint,
        code,
        redirectUri: redirectUriFor(req),
        codeVerifier,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });

      // `doc.issuer` rather than the configured value: providers such as
      // Authentik include a trailing slash in `iss`, and pinning the configured
      // string turns that into a permanent verification failure.
      const keys = await getJwks();
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: doc.issuer,
        audience: config.clientId,
      });

      if (payload["nonce"] !== nonce) {
        log.warn("OIDC nonce mismatch");
        sendAuthError(
          res,
          "Nonce stimmt nicht überein, bitte erneut versuchen",
        );
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
        sendAuthError(res, "Dieses Konto hat keine verwertbare Identität");
        return;
      }
      if (!isEmailAllowed(email, config)) {
        log.warn({ email }, "OIDC login rejected: email not allowed");
        sendAuthError(res, "Dieses Konto ist nicht zur Anmeldung berechtigt");
        return;
      }

      // Only verified ID-token values are carried forward. Tenant and scopes stay
      // server-side (see ui-auth.ts) so the cookie cannot widen authority.
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
      appendCookie(res, buildCookie(TX_COOKIE, "", 0, secureCookie));

      const rt = tx["rt"];
      const returnTo =
        typeof rt === "string" && rt.startsWith("/") && !rt.startsWith("//")
          ? rt
          : "/";
      log.info({ sub: subject, email }, "OIDC login successful");
      res.redirect(returnTo);
    } catch (err) {
      log.error({ err }, "OIDC callback failed");
      sendAuthError(res, "Anmeldung fehlgeschlagen, bitte erneut versuchen");
    }
  };

  // ── GET /auth/logout ──────────────────────────────────────────────────────
  const logoutHandler: RequestHandler = async (req, res, next) => {
    const log: Logger = (req as Request & { log?: Logger }).log ?? logger;
    try {
      appendCookie(res, buildCookie(SESSION_COOKIE, "", 0, secureCookie));
      const doc = await discover().catch(() => null);
      if (doc?.end_session_endpoint) {
        const url = new URL(doc.end_session_endpoint);
        url.searchParams.set(
          "post_logout_redirect_uri",
          `${resolveBaseUrl(req)}/`,
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
      if (typeof payload.sub !== "string" || payload.sub.trim() === "")
        return null;
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
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return [
    ...new Set(
      raw
        .filter((group): group is string => typeof group === "string")
        .map((group) => group.trim())
        .filter(Boolean),
    ),
  ];
}

function isEmailAllowed(email: string | undefined, config: OidcConfig): boolean {
  const hasEmailRule = config.allowedEmails.length > 0;
  const hasDomainRule = config.allowedEmailDomains.length > 0;
  if (!hasEmailRule && !hasDomainRule) return true;

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
  // SameSite=Lax rather than Strict: the OIDC callback is a top-level
  // cross-site navigation back from the provider, and Strict would not send the
  // transaction cookie. CSRF on mutations is handled separately by
  // createUiMutationGuard.
  const parts = [`${name}=${value}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function appendCookie(
  res: {
    getHeader: (name: string) => unknown;
    setHeader: (name: string, value: string[]) => void;
  },
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

function sendAuthError(
  res: {
    status: (code: number) => { type: (t: string) => { send: (body: string) => void } };
  },
  message: string,
): void {
  res
    .status(401)
    .type("html")
    .send(
      `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8" /><title>ATF Extract — Anmeldung fehlgeschlagen</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;margin:3rem">
  <h1 style="font-size:1.25rem">Anmeldung fehlgeschlagen</h1>
  <p>${htmlEscape(message)}</p>
  <p><a href="/auth/login">Erneut versuchen</a></p>
</body>
</html>`,
    );
}
