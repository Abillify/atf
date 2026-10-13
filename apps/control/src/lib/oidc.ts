// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OIDC login for the admin UI — backend-driven (BFF) client (`src/lib/oidc.ts`).
 *
 * The whole OpenID Connect flow runs on the BACKEND with a CONFIDENTIAL client
 * (see src/routes/auth-oidc.ts), so the browser never handles a client secret
 * and there is NO build-time (`NEXT_PUBLIC_OIDC_*`) config — everything is
 * discovered at runtime from the backend:
 *
 *   1. `getAuthConfig()` asks the backend whether SSO is enabled + auto-login.
 *   2. `beginLogin()` navigates (top-level) to the backend `/monitoring/auth/login`,
 *      which redirects to the IdP and, after the callback, sends the browser
 *      back here with a short-lived session token in the URL fragment.
 *   3. `consumeSessionFromUrl()` reads that token from the fragment (and any
 *      `auth_error`), returning it so it can be stored as the operator token.
 *   4. `logout()` asks the backend for an optional IdP end-session URL.
 *
 * The token transport to the operator plane is unchanged (stored via
 * `AuthProvider`, sent as `?token=` / Bearer) — only its origin moved to the
 * backend.
 */

import { base64UrlDecodeToString } from "@atf/security-kit/browser";

import { backendUrl } from "./backend-url";

export interface AuthConfig {
  /** True when the backend has the confidential OIDC client configured. */
  enabled: boolean;
  /** True when unauthenticated visitors should be redirected to SSO. */
  autoLogin: boolean;
  /** True when the operator plane requires an authenticated identity. */
  required: boolean;
  /**
   * Host (with port) of the configured IdP issuer, reported by the backend.
   * Used to validate the `endSessionUrl` before navigating to it (Req 8.4).
   * `null` for older backends that do not report it — end-session URLs are
   * then refused (fail closed).
   */
  issuerHost: string | null;
}

// Fail closed for unreachable or older backends that do not expose `required`.
const AUTH_CONFIG_UNSET: AuthConfig = {
  enabled: false,
  autoLogin: false,
  required: true,
  issuerHost: null,
};

let cachedConfig: AuthConfig | null = null;

/**
 * Upper bound (ms) for the auth-config probe. Without it, a request that
 * never settles (a hung proxy/extension interception of the localhost call,
 * a half-open socket while the backend restarts) would keep
 * `AuthProvider.ready` false forever and the dashboard would be stuck on its
 * loading spinner with no way out but to guess the cause.
 */
const AUTH_CONFIG_TIMEOUT_MS = 5_000;

/**
 * Fetches (once, then memoised) whether backend-driven SSO is available. Never
 * throws — a network/parse failure or a timeout resolves to "disabled" so the
 * manual token box stays usable. Failures are deliberately NOT memoised, so a
 * later page load retries the probe once the backend answers again.
 */
export async function getAuthConfig(): Promise<AuthConfig> {
  if (cachedConfig !== null) return cachedConfig;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_CONFIG_TIMEOUT_MS);
  try {
    const res = await fetch(backendUrl("/monitoring/auth/config"), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return AUTH_CONFIG_UNSET;
    const data = (await res.json()) as Partial<AuthConfig>;
    cachedConfig = {
      enabled: data.enabled === true,
      autoLogin: data.autoLogin === true,
      // Missing field means an older backend: keep requiring auth.
      required: data.required !== false,
      issuerHost:
        typeof data.issuerHost === "string" && data.issuerHost !== ""
          ? data.issuerHost
          : null,
    };
    return cachedConfig;
  } catch {
    return AUTH_CONFIG_UNSET;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Navigates the browser to the backend login endpoint, passing the current
 * page (without any fragment) as the post-login return target.
 */
export function beginLogin(): void {
  const here = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  const url = backendUrl(
    `/monitoring/auth/login?redirect=${encodeURIComponent(here)}`,
  );
  window.location.assign(url);
}

export interface SessionHandoff {
  /** The minted operator session token, when present. */
  token: string | null;
  /** An error code the backend surfaced (e.g. "forbidden"), when present. */
  error: string | null;
}

/**
 * Reads a `#session=…` (or `#auth_error=…`) fragment left by the backend
 * callback redirect, then strips the fragment from the URL so the token does
 * not linger in the address bar / history. Returns nulls when absent.
 */
export function consumeSessionFromUrl(): SessionHandoff {
  if (typeof window === "undefined") return { token: null, error: null };
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (hash === "") return { token: null, error: null };

  const params = new URLSearchParams(hash);
  const token = params.get("session");
  const error = params.get("auth_error");
  if (token === null && error === null) return { token: null, error: null };

  // Clean the fragment out of the URL.
  const clean = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, "", clean);
  return { token, error };
}

/**
 * Validates an IdP end-session URL before the browser navigates to it (Req 8.4):
 * only an HTTPS URL whose host matches the configured IdP issuer host is
 * trusted. Anything else — plain HTTP, a foreign host, a malformed URL, or no
 * known issuer host at all — is refused so a compromised or misconfigured
 * backend cannot redirect the operator (with their session context) elsewhere.
 */
export function isTrustedEndSessionUrl(
  url: string,
  issuerHost: string | null,
): boolean {
  if (issuerHost === null || issuerHost === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === issuerHost;
  } catch {
    return false;
  }
}

/**
 * Logs out: asks the backend for an optional IdP end-session URL and, when one
 * is returned AND passes `isTrustedEndSessionUrl` (HTTPS + configured IdP host,
 * Req 8.4), navigates there (RP-initiated logout). The caller is expected to
 * clear the locally stored token regardless. Returns true when it redirected.
 */
export async function logout(): Promise<boolean> {
  try {
    const res = await fetch(backendUrl("/monitoring/auth/logout"), {
      method: "POST",
      headers: { Accept: "application/json" },
      // Send the refresh-session cookie so the backend can drop it server-side.
      credentials: "include",
    });
    if (res.ok) {
      const data = (await res.json()) as { endSessionUrl?: string | null };
      if (typeof data.endSessionUrl === "string" && data.endSessionUrl !== "") {
        const { issuerHost } = await getAuthConfig();
        if (isTrustedEndSessionUrl(data.endSessionUrl, issuerHost)) {
          window.location.assign(data.endSessionUrl);
          return true;
        }
        console.warn(
          "Refusing end-session URL: not HTTPS or host does not match the configured IdP",
        );
      }
    }
  } catch {
    /* ignore — local token clear still logs the operator out of the dashboard */
  }
  return false;
}

/**
 * Silently renews the operator session token using the server-side refresh
 * session (an HttpOnly cookie set at login). Resolves to the fresh token, or
 * null when renewal is impossible (no session, refresh rejected, SSO disabled)
 * — in which case the caller should fall back to an interactive login.
 *
 * The refresh token itself never touches the browser: the backend holds it and
 * this call only exchanges the cookie for a new short-lived session token.
 */
export async function refreshSession(): Promise<string | null> {
  try {
    const res = await fetch(backendUrl("/monitoring/auth/refresh"), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { session?: string };
    return typeof data.session === "string" && data.session !== ""
      ? data.session
      : null;
  } catch {
    return null;
  }
}

/**
 * Decodes a JWT's `exp` (seconds since epoch) WITHOUT verifying the signature —
 * used only to schedule client-side renewal ahead of expiry. Returns null when
 * the token is malformed or has no numeric `exp`.
 *
 * Decoding goes through the shared padding-correct base64url codec from
 * `@atf/security-kit/browser` (Req 8.5) — the same implementation as the
 * backend, so no second ad-hoc atob/Buffer path can drift from it.
 */
export function decodeTokenExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecodeToString(parts[1])) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
