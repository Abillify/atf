// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Code exchange and refresh for cloud sources (requirements 6.9, 6.12, 6.13,
 * 6.14, 6.16, 6.18, 6.20, 4.6).
 *
 * Strictly separated from the Extract auth manager: cloud tokens never reach
 * the Extract client and vice versa. Error classification follows 6.12/6.18:
 * `invalid_grant`/`401` means the authorization was rejected — the stored
 * refresh token is NOT deleted (a brief provider outage must not destroy a
 * working token). 5xx and network failures are transient source errors and
 * never count as rejected. Error messages never contain token contents.
 */

import type { SecretRedactor } from "../../log/redact.js";
import { sourceOauthRefreshKey } from "../../credentials/keys.js";
import type { CredentialStore } from "../../credentials/store.js";
import type { Env } from "../../config/secrets-file.js";
import type { FetchLike } from "../idp.js";
import { PROVIDERS, type ProviderId } from "./providers.js";

/** Keychain key holding the (non-confidential but secret-graded) Google client secret. */
export const GDRIVE_CLIENT_SECRET_KEY = "auth:gdrive:client-secret";

/** Environment variable carrying the Google client secret (Docker; `_FILE` folded by resolveSecretEnv). */
export const GDRIVE_CLIENT_SECRET_ENV = "OUTPOST_GDRIVE_CLIENT_SECRET";

/** Transient provider/transport failure — NOT a rejection (6.12). */
export class SourceTransientError extends Error {
  constructor(
    message: string,
    readonly options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SourceTransientError";
  }
}

export type SourceTokenResult =
  | {
      kind: "ok";
      accessToken: string;
      refreshToken?: string;
      expiresInSec?: number;
    }
  | { kind: "rejected"; detail?: string };

interface TokenEndpointResponse {
  status: number;
  parsed: Record<string, unknown>;
}

/** POST form-encoded to a token endpoint; network failure → transient. */
async function postTokenForm(
  endpoint: string,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenEndpointResponse> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (cause) {
    // Never include request contents (they carry tokens) in the message.
    throw new SourceTransientError("Token-Endpunkt nicht erreichbar", { cause });
  }
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Non-JSON body: the status-based classification below handles it.
  }
  return { status: response.status, parsed };
}

/** Map a token-endpoint response onto ok / rejected / transient (6.12, 6.18). */
export function classifyTokenResponse(
  status: number,
  parsed: Record<string, unknown>,
): SourceTokenResult {
  const error = typeof parsed["error"] === "string" ? (parsed["error"] as string) : undefined;
  if (status >= 200 && status < 300) {
    const accessToken = parsed["access_token"];
    if (typeof accessToken !== "string" || accessToken === "") {
      throw new SourceTransientError("Token-Antwort ohne access_token");
    }
    const refreshToken =
      typeof parsed["refresh_token"] === "string" ? (parsed["refresh_token"] as string) : undefined;
    const expiresInSec =
      typeof parsed["expires_in"] === "number" ? (parsed["expires_in"] as number) : undefined;
    return { kind: "ok", accessToken, refreshToken, expiresInSec };
  }
  if (status >= 500) {
    throw new SourceTransientError(`Token-Endpunkt antwortete mit ${status}`);
  }
  // invalid_grant or 401 → rejected; other 4xx (invalid_client, …) mean the
  // stored authorization cannot work either. Only the OAuth error CODE is
  // reported — never response bodies, which could echo token material.
  return { kind: "rejected", detail: error ?? `http_${status}` };
}

export interface ExchangeCodeArgs {
  clientId: string;
  /** Google only; Dropbox works without a secret (6.9). */
  clientSecret?: string;
  code: string;
  /** Locally generated PKCE verifier binding the exchange (15.2). */
  codeVerifier: string;
  redirectUri?: string;
}

/** Exchange an authorization code for tokens (PKCE, no client auth beyond the id). */
export async function exchangeCodeForTokens(
  provider: ProviderId,
  args: ExchangeCodeArgs,
  fetchImpl: FetchLike,
): Promise<SourceTokenResult> {
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.codeVerifier,
    client_id: args.clientId,
  };
  if (args.redirectUri !== undefined) params["redirect_uri"] = args.redirectUri;
  if (args.clientSecret !== undefined) params["client_secret"] = args.clientSecret;
  const { status, parsed } = await postTokenForm(
    PROVIDERS[provider].tokenEndpoint,
    params,
    fetchImpl,
  );
  return classifyTokenResponse(status, parsed);
}

export interface RefreshArgs {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

/** Refresh an access token; a rotated refresh token comes back in the result. */
export async function refreshSourceToken(
  provider: ProviderId,
  args: RefreshArgs,
  fetchImpl: FetchLike,
): Promise<SourceTokenResult> {
  const params: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  };
  if (args.clientSecret !== undefined) params["client_secret"] = args.clientSecret;
  const { status, parsed } = await postTokenForm(
    PROVIDERS[provider].tokenEndpoint,
    params,
    fetchImpl,
  );
  return classifyTokenResponse(status, parsed);
}

/**
 * Persist a rotated refresh token atomically to `source:<id>:oauth-refresh`
 * (6.17). The store writes tmp → fsync → rename, so a concurrent
 * `source-login` simply wins by writing later (last-writer-wins); both
 * values are valid. No-op when the provider did not rotate.
 */
export async function persistRotatedRefreshToken(
  store: CredentialStore,
  sourceId: string,
  result: SourceTokenResult,
): Promise<string | undefined> {
  if (result.kind !== "ok" || result.refreshToken === undefined) return undefined;
  await store.set(sourceOauthRefreshKey(sourceId), result.refreshToken);
  return result.refreshToken;
}

/**
 * Read the Google client secret from the environment (already `_FILE`-folded)
 * or the keychain, registering the value with the redactor (4.6). Returns
 * `undefined` when unset — the caller decides whether that is an error.
 */
export async function loadGoogleClientSecret(
  env: Env,
  store: CredentialStore,
  redactor?: SecretRedactor,
): Promise<string | undefined> {
  const fromEnv = env[GDRIVE_CLIENT_SECRET_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    redactor?.register(fromEnv);
    return fromEnv;
  }
  const fromStore = await store.get(GDRIVE_CLIENT_SECRET_KEY);
  if (fromStore !== null && fromStore !== "") {
    redactor?.register(fromStore);
    return fromStore;
  }
  return undefined;
}
