// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared OIDC plumbing for the Extract auth flows. `fetch` and the clock are
 * injected so the flows run against a fake IdP in tests and never touch the
 * network in unit tests.
 */

import { trimTrailingChar } from "../text-trim.js";

/** Minimal fetch surface used by the auth module. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Subset of the OIDC discovery document the outpost needs. */
export interface OidcDiscovery {
  token_endpoint: string;
  device_authorization_endpoint?: string;
  authorization_endpoint?: string;
}

/** Raised for IdP/transport problems during a flow. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

/** Fetch and validate the OIDC discovery document for `issuer`. */
export async function discover(
  issuer: string,
  fetchImpl: FetchLike,
): Promise<OidcDiscovery> {
  const url = `${trimTrailingChar(issuer, "/")}/.well-known/openid-configuration`;
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, { method: "GET" });
  } catch (cause) {
    throw new AuthError("OIDC discovery failed", "discovery_unavailable", { cause });
  }
  if (!response.ok) {
    throw new AuthError(`OIDC discovery returned ${response.status}`, "discovery_failed");
  }
  const doc = (await response.json()) as Partial<OidcDiscovery>;
  if (typeof doc.token_endpoint !== "string") {
    throw new AuthError("OIDC discovery missing token_endpoint", "discovery_invalid");
  }
  return {
    token_endpoint: doc.token_endpoint,
    device_authorization_endpoint: doc.device_authorization_endpoint,
    authorization_endpoint: doc.authorization_endpoint,
  };
}

/** A parsed OAuth token response. */
export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * POST form-encoded parameters to a token endpoint and parse the response.
 * Non-2xx responses become {@link AuthError} carrying the OAuth `error` code
 * when present.
 */
export async function tokenRequest(
  endpoint: string,
  params: Record<string, string>,
  fetchImpl: FetchLike,
  extraHeaders: Record<string, string> = {},
): Promise<TokenResponse> {
  const body = new URLSearchParams(params).toString();
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        ...extraHeaders,
      },
      body,
    });
  } catch (cause) {
    throw new AuthError("token request failed", "network", { cause });
  }
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Non-JSON body: fall through to the status-based error below.
  }
  if (!response.ok) {
    const oauthError =
      typeof parsed["error"] === "string" ? (parsed["error"] as string) : `http_${response.status}`;
    throw new AuthError(`token endpoint returned ${response.status}`, oauthError);
  }
  const accessToken = parsed["access_token"];
  if (typeof accessToken !== "string") {
    throw new AuthError("token response missing access_token", "invalid_response");
  }
  const result: TokenResponse = { access_token: accessToken };
  if (typeof parsed["token_type"] === "string") result.token_type = parsed["token_type"];
  if (typeof parsed["expires_in"] === "number") result.expires_in = parsed["expires_in"];
  if (typeof parsed["refresh_token"] === "string") result.refresh_token = parsed["refresh_token"];
  if (typeof parsed["scope"] === "string") result.scope = parsed["scope"];
  return result;
}

/**
 * Merge the configured scopes with `offline_access` for interactive flows so
 * a refresh token is issued (requirements 2.3, 4.5).
 */
export function interactiveScopes(configured: readonly string[]): string[] {
  const set = new Set(configured);
  set.add("offline_access");
  return [...set];
}
