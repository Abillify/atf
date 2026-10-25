// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Auth_Manager / {@link TokenProvider} for the Extract service
 * (requirements 2.7, 2.9, 3.4, 3.5, 3.9, 4.2, 4.4).
 *
 * The method is selected once ({@link selectAuthMethod}) and is final: an
 * API-Token setup never falls back to Client_Credentials, Device_Code or PKCE
 * (2.9). Refresh failures surface as events — `auth.failed` for API-Token,
 * `auth.reauth_required` for the flows that can be re-run interactively.
 *
 * `logout()` deletes exactly {@link EXTRACT_AUTH_KEYS} plus the in-memory
 * cache; `source:*` keys (cloud refresh tokens) are never touched (3.5, 3.9).
 * Stopping runs and flushing state belong to the scheduler's logout sequence
 * not here.
 */

import type { Logger } from "pino";
import {
  EXTRACT_AUTH_KEYS,
  EXTRACT_CLIENT_SECRET_KEY,
  EXTRACT_REFRESH_TOKEN_KEY,
} from "../credentials/keys.js";
import type { CredentialStore } from "../credentials/store.js";
import { TokenCache, expiresAtFromNow } from "./token-cache.js";
import { refreshAccessToken } from "./refresh.js";
import { clientCredentialsToken } from "./client-credentials.js";
import { AuthError, type FetchLike } from "./idp.js";
import type { AuthMethod } from "./select.js";

/** The provider interface consumed by the HTTP client. */
export interface TokenProvider {
  /** Current access token; renews proactively when it expires within 60 s. */
  getAccessToken(now: number): Promise<string>;
  /** Renew after a 401 response. */
  forceRefresh(): Promise<string>;
  /** Remove Extract credentials only; cloud source keys stay untouched. */
  logout(): Promise<void>;
}

export type AuthEvent =
  | { type: "reauth_required"; method: AuthMethod; reason: string }
  | { type: "failed"; method: AuthMethod; message: string };

/** Token set produced by an interactive login (device-code or PKCE). */
export interface InteractiveTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  audience?: string;
  scopes?: readonly string[];
}

export interface AuthManagerOptions {
  method: AuthMethod;
  oidc: OidcSettings;
  store: CredentialStore;
  logger: Logger;
  fetchImpl: FetchLike;
  /**
   * Read the static API token (env, `_FILE`, keychain). Used only when the
   * selected method is `api-token`; `forceRefresh()` calls it again (2.9).
   */
  readApiToken?: () => Promise<string | null>;
  /**
   * Run the interactive login for `device-code` / `pkce` when no refresh
   * token exists. Provided by the runtime (Docker: device flow; desktop: PKCE
   * via the Rust host).
   */
  interactive?: () => Promise<InteractiveTokenSet>;
  onEvent?: (event: AuthEvent) => void;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
}

export class AuthManager implements TokenProvider {
  private readonly opts: AuthManagerOptions;
  private readonly cache = new TokenCache();
  /** The selected method, exposed for logs and status output. */
  readonly method: AuthMethod;

  constructor(options: AuthManagerOptions) {
    this.opts = options;
    this.method = options.method;
    // 2.7: the chosen method is logged once at startup.
    options.logger.info({ event: "auth.method", method: options.method }, "auth method selected");
  }

  async getAccessToken(now: number): Promise<string> {
    if (this.method === "api-token") return this.apiToken(false);
    if (!this.cache.isExpiring(now)) {
      return this.cache.current?.accessToken ?? this.refresh();
    }
    return this.refresh();
  }

  async forceRefresh(): Promise<string> {
    if (this.method === "api-token") return this.apiToken(true);
    return this.refresh();
  }

  /**
   * Delete exactly the Extract-SSO keys and the in-memory cache. Never calls
   * `delete` with a `source:` key (3.5, 3.9).
   */
  async logout(): Promise<void> {
    for (const key of EXTRACT_AUTH_KEYS) {
      await this.opts.store.delete(key);
    }
    this.cache.clear();
    this.opts.logger.info({ event: "auth.logout" }, "extract credentials removed");
  }

  /** Static API-Token path: read only, no IdP call, no fallback (2.9). */
  private async apiToken(force: boolean): Promise<string> {
    if (force || this.cache.current === null) {
      const token = (await this.opts.readApiToken?.()) ?? null;
      if (token === null || token.length === 0) {
        const message = "API-Token fehlt oder ist leer";
        this.opts.onEvent?.({ type: "failed", method: "api-token", message });
        this.opts.logger.error({ event: "auth.failed", method: "api-token" }, message);
        throw new AuthError(message, "api_token_missing");
      }
      // Static tokens have no expiry; cache far into the future so
      // getAccessToken does not re-read on every request.
      this.cache.set({ accessToken: token, expiresAt: Number.MAX_SAFE_INTEGER });
    }
    const current = this.cache.current;
    if (current === null) {
      throw new AuthError("API-Token cache leer", "api_token_missing");
    }
    return current.accessToken;
  }

  /** Renew the access token for the non-static methods. */
  private async refresh(): Promise<string> {
    try {
      const token = await this.refreshInner();
      return token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 4.4: renewal failed → re-authentication required. api-token never
      // reaches this path (handled in apiToken(), 2.9).
      this.opts.onEvent?.({ type: "reauth_required", method: this.method, reason: message });
      this.opts.logger.warn(
        { event: "auth.reauth_required", method: this.method },
        "token renewal failed, re-authentication required",
      );
      throw error;
    }
  }

  private async refreshInner(): Promise<string> {
    const { oidc, store } = this.opts;
    const now = (this.opts.now ?? Date.now)();
    const scopes = oidc.scopes ?? [];
    if (this.method === "client-credentials") {
      const clientSecret = await store.get(EXTRACT_CLIENT_SECRET_KEY);
      if (clientSecret === null) {
        throw new AuthError("client secret not found in credential store", "no_client_secret");
      }
      const tokens = await clientCredentialsToken(
        oidc.issuer,
        oidc.clientId,
        clientSecret,
        scopes,
        oidc.audience,
        { fetchImpl: this.opts.fetchImpl },
      );
      const expiresInSec = tokens.expires_in ?? 300;
      this.cache.set({
        accessToken: tokens.access_token,
        expiresAt: expiresAtFromNow(now, expiresInSec),
      });
      return tokens.access_token;
    }

    // device-code / pkce: prefer the stored refresh token (2.4).
    const refreshToken = await store.get(EXTRACT_REFRESH_TOKEN_KEY);
    if (refreshToken !== null) {
      const tokens = await refreshAccessToken(
        oidc.issuer,
        oidc.clientId,
        refreshToken,
        oidc.audience,
        { fetchImpl: this.opts.fetchImpl },
      );
      if (tokens.refresh_token !== undefined) {
        await store.set(EXTRACT_REFRESH_TOKEN_KEY, tokens.refresh_token);
      }
      const expiresInSec = tokens.expires_in ?? 300;
      this.cache.set({
        accessToken: tokens.access_token,
        expiresAt: expiresAtFromNow(now, expiresInSec),
      });
      return tokens.access_token;
    }

    // No refresh token: interactive login (device flow / PKCE).
    if (this.opts.interactive === undefined) {
      throw new AuthError("no refresh token and no interactive flow available", "reauth_required");
    }
    const set = await this.opts.interactive();
    await store.set(EXTRACT_REFRESH_TOKEN_KEY, set.refreshToken);
    this.cache.set({
      accessToken: set.accessToken,
      expiresAt: expiresAtFromNow(now, set.expiresInSec),
    });
    return set.accessToken;
  }
}
