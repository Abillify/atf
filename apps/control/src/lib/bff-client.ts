// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Browser client for the BFF session endpoints (Req 8.7).
 *
 * Talks to the Next.js route handlers under `/api/session` — always
 * same-origin, never through `backendUrl()` (which itself rewrites to the
 * `/api/backend` proxy). The responses carry only the session STATUS
 * (authenticated flag, role, expiry); the access token itself stays in the
 * HttpOnly cookie and is never returned to JS.
 */

export interface BffAuthConfig {
  enabled: boolean;
  required: boolean;
  issuerHost: string | null;
}

export interface BffSessionStatus {
  authenticated: boolean;
  role: string | null;
  expiresAt: number | null;
  config: BffAuthConfig;
}

const SESSION_ENDPOINT = "/api/session";
const REQUEST_TIMEOUT_MS = 5_000;

async function sessionFetch(
  init: RequestInit = {},
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(SESSION_ENDPOINT, {
      credentials: "same-origin",
      ...init,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readRole(data: Record<string, unknown>): string | null {
  return typeof data["role"] === "string" && data["role"] !== ""
    ? (data["role"] as string)
    : null;
}

function readExpiresAt(data: Record<string, unknown>): number | null {
  return typeof data["expiresAt"] === "number"
    ? (data["expiresAt"] as number)
    : null;
}

/**
 * Reads the current BFF session status + backend auth config. `null` on any
 * failure (endpoint absent → the server is not in BFF mode, or unreachable).
 */
export async function bffSessionStatus(): Promise<BffSessionStatus | null> {
  const res = await sessionFetch({ headers: { Accept: "application/json" } });
  if (res === null || !res.ok) return null;
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const config = (data["config"] ?? {}) as Record<string, unknown>;
  return {
    authenticated: data["authenticated"] === true,
    role: readRole(data),
    expiresAt: readExpiresAt(data),
    config: {
      enabled: config["enabled"] === true,
      // Fail closed for a missing field, mirroring lib/oidc.getAuthConfig.
      required: config["required"] !== false,
      issuerHost:
        typeof config["issuerHost"] === "string" && config["issuerHost"] !== ""
          ? (config["issuerHost"] as string)
          : null,
    },
  };
}

/**
 * Exchanges a raw operator token (OIDC handoff fragment or manual paste) for
 * the encrypted HttpOnly session cookie. Returns the sealed session's claims,
 * or `null` when the exchange failed (server not in BFF mode, secret
 * unconfigured, network error).
 */
export async function bffExchangeToken(
  token: string,
): Promise<{ role: string | null; expiresAt: number | null } | null> {
  const res = await sessionFetch({
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token }),
  });
  if (res === null || !res.ok) return null;
  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data["ok"] !== true) return null;
  return { role: readRole(data), expiresAt: readExpiresAt(data) };
}

/** Clears the BFF session cookie (sign-out). Never throws. */
export async function bffClearSession(): Promise<void> {
  await sessionFetch({ method: "DELETE" });
}
