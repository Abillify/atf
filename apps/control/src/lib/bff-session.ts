// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Server-side session store for the optional BFF mode (Req 8.7).
 *
 * Holds the operator access token in an encrypted (AES-256-GCM,
 * `session-crypto.ts`), HttpOnly, Secure, SameSite=Strict cookie. Only the
 * Next.js route handlers (`app/api/session`, `app/api/backend/[...path]`)
 * read it; the browser never sees the token itself.
 *
 * Server-only module — reads deployment secrets from the environment.
 */

import {
  deriveSessionKey,
  sealSessionPayload,
  unsealSessionPayload,
  type SessionPayload,
} from "./session-crypto";
import { decodeJwtClaims } from "./jwt-claims";

/** Name of the encrypted BFF session cookie. */
export const BFF_SESSION_COOKIE = "atf_control_session";

/** Upper bound for the cookie lifetime even when the token has no `exp`. */
const MAX_SESSION_COOKIE_AGE_SECONDS = 12 * 60 * 60;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Origin of the Runtime the BFF proxies to. `CONTROL_BACKEND_URL` is the
 * server-side setting (never exposed to the browser); it falls back to the
 * development `NEXT_PUBLIC_BACKEND_URL` and finally to the Runtime's default
 * local port.
 */
export function backendOrigin(): string | null {
  const raw =
    process.env["CONTROL_BACKEND_URL"] ??
    process.env["NEXT_PUBLIC_BACKEND_URL"] ??
    "http://127.0.0.1:3000";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

let cachedKey: CryptoKey | null | undefined;

/** AES key derived from `CONTROL_SESSION_SECRET`; `null` when unusable. */
export async function sessionKey(): Promise<CryptoKey | null> {
  if (cachedKey !== undefined) return cachedKey;
  const secret = process.env["CONTROL_SESSION_SECRET"] ?? "";
  cachedKey = await deriveSessionKey(secret);
  return cachedKey;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/** True when the (possibly proxied) request arrived over TLS. */
export function requestIsSecure(request: Request): boolean {
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Reads the BFF session cookie value from a request. */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null || header === "") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === BFF_SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

/**
 * Set-Cookie header for a sealed session. HttpOnly + Secure (on TLS) +
 * SameSite=Strict per Req 8.7; lifetime mirrors the token `exp` (capped at
 * 12 h) so a stolen cookie cannot outlive the credential it carries.
 */
export function sessionCookieHeader(
  sealed: string,
  secure: boolean,
  expiresAt: number | null,
): string {
  const parts = [
    `${BFF_SESSION_COOKIE}=${encodeURIComponent(sealed)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  const remaining =
    expiresAt === null
      ? MAX_SESSION_COOKIE_AGE_SECONDS
      : Math.min(
          Math.max(1, Math.floor(expiresAt - Date.now() / 1000)),
          MAX_SESSION_COOKIE_AGE_SECONDS,
        );
  parts.push(`Max-Age=${remaining}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie header that clears the session cookie. */
export function clearSessionCookieHeader(secure: boolean): string {
  const parts = [
    `${BFF_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Creates a sealed cookie value from a raw operator token. */
export async function sealTokenForCookie(
  token: string,
): Promise<{ sealed: string; role: string | null; expiresAt: number | null } | null> {
  const key = await sessionKey();
  if (key === null) return null;
  const claims = decodeJwtClaims(token);
  const payload: SessionPayload = {
    token,
    role: claims.role,
    expiresAt: claims.exp,
  };
  const sealed = await sealSessionPayload(payload, key);
  return { sealed, role: claims.role, expiresAt: claims.exp };
}

/**
 * Resolves the current session from a request. Returns `null` when there is
 * no cookie, the cookie fails authentication, or the token inside it has
 * expired — every failure is treated identically (fail closed).
 */
export async function resolveSession(
  request: Request,
): Promise<SessionPayload | null> {
  const raw = readSessionCookie(request);
  if (raw === null) return null;
  const key = await sessionKey();
  if (key === null) return null;
  const payload = await unsealSessionPayload(raw, key);
  if (payload === null) return null;
  if (payload.expiresAt !== null && payload.expiresAt * 1000 <= Date.now()) {
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Backend auth-config passthrough (cached)
// ---------------------------------------------------------------------------

export interface BackendAuthConfig {
  enabled: boolean;
  required: boolean;
  issuerHost: string | null;
}

const BACKEND_CONFIG_UNSET: BackendAuthConfig = {
  enabled: false,
  required: true,
  issuerHost: null,
};

let cachedBackendConfig: { value: BackendAuthConfig; fetchedAt: number } | null =
  null;
const BACKEND_CONFIG_TTL_MS = 60_000;

/** Fetches the Runtime's auth config (60 s cache). Never throws. */
export async function fetchBackendAuthConfig(
  fetchFn: typeof fetch = fetch,
): Promise<BackendAuthConfig> {
  const now = Date.now();
  if (cachedBackendConfig !== null && now - cachedBackendConfig.fetchedAt < BACKEND_CONFIG_TTL_MS) {
    return cachedBackendConfig.value;
  }
  const origin = backendOrigin();
  if (origin === null) return BACKEND_CONFIG_UNSET;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetchFn(`${origin}/monitoring/auth/config`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return BACKEND_CONFIG_UNSET;
    const data = (await res.json()) as Record<string, unknown>;
    const value: BackendAuthConfig = {
      enabled: data["enabled"] === true,
      required: data["required"] !== false,
      issuerHost:
        typeof data["issuerHost"] === "string" && data["issuerHost"] !== ""
          ? (data["issuerHost"] as string)
          : null,
    };
    cachedBackendConfig = { value, fetchedAt: now };
    return value;
  } catch {
    return BACKEND_CONFIG_UNSET;
  }
}

/** Test hook: drop the cached backend config. */
export function __resetBackendConfigCache(): void {
  cachedBackendConfig = null;
  cachedKey = undefined;
}
