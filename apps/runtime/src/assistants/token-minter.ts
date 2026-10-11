// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Delegated access-token minting (`src/assistants/token-minter.ts`)
 *
 * Exchanges a stored refresh token for a short-lived access token via the OIDC
 * `refresh_token` grant, and caches the result for the few minutes it is valid.
 *
 * ## Cache lifecycle
 *
 * The cache is process-local, bounded, and keyed by (assistant, issuer). It is
 * intentionally *not* a distributed cache: access tokens live minutes, replicas
 * mint independently without conflict, and putting live credentials in Redis
 * would add a place they can leak from to save one IdP round trip per replica per
 * token lifetime.
 *
 * In-flight requests are coalesced. Without that, a burst of background turns for
 * the same assistant issues one refresh call each; with most IdPs that also
 * rotates the refresh token concurrently, and all but one rotation is lost — the
 * grant then breaks on the next use. Coalescing is a correctness requirement
 * here, not an optimisation.
 *
 * ## Rotation
 *
 * When the IdP returns a new refresh token, it is written back through the
 * credential store before the access token is handed out. Order matters: if the
 * process died between handing out the token and persisting the rotation, the
 * stored refresh token would already be invalid at the IdP.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import type { CredentialStore } from "./credential-store.js";
import {
  ACCESS_TOKEN_EXPIRY_MARGIN_MS,
  isAccessTokenFresh,
  type CachedAccessToken,
} from "./execution-authority.js";
import { scopeKey, type AssistantScope } from "./types.js";
import { egressFetch } from "../security/egress.js";
import { createDiscoveryClient } from "@atf/security-kit";

// ---------------------------------------------------------------------------
// OIDC plumbing
// ---------------------------------------------------------------------------

/** The single endpoint this module needs from discovery. */
export interface TokenEndpointMetadata {
  token_endpoint: string;
}

/** Injected so tests need no network and no IdP. */
export type TokenEndpointResolver = (issuer: string) => Promise<TokenEndpointMetadata>;

/** Injected `fetch` so tests can assert the exact request shape. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** Fields of the token response this module consumes. */
interface RefreshResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/**
 * Default access-token lifetime when the IdP omits `expires_in`.
 *
 * Five minutes, deliberately short: assuming a long life for a token whose real
 * lifetime is unknown produces intermittent authorisation failures that look like
 * permission problems. Re-minting more often than necessary is the cheaper error.
 */
const DEFAULT_ACCESS_TOKEN_TTL_MS = 5 * 60_000;

/** Bound on cached tokens, so a large tenant cannot grow the cache without limit. */
const MAX_CACHE_ENTRIES = 2_000;

/** Network timeout for the token request. */
const REFRESH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Outcome of a mint attempt. */
export type MintResult =
  | { ok: true; token: CachedAccessToken }
  | {
      ok: false;
      /** Operator/model-facing reason. Never contains token material. */
      detail: string;
      /** True when the failure is likely transient (network, 5xx). */
      transient: boolean;
    };

// ---------------------------------------------------------------------------
// Minter
// ---------------------------------------------------------------------------

export interface TokenMinterOptions {
  credentials: CredentialStore;
  clientId: string;
  clientSecret: string;
  resolveTokenEndpoint: TokenEndpointResolver;
  fetchImpl?: FetchLike;
  logger?: Logger;
  now?: () => number;
}

/** Mints and caches delegated access tokens. */
export class DelegatedTokenMinter {
  private readonly cache = new Map<string, CachedAccessToken>();
  /** In-flight mints, keyed identically to the cache. See the module note. */
  private readonly inFlight = new Map<string, Promise<MintResult>>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: TokenMinterOptions) {
    // Egress_Guard by default (SSRF-safe); tests inject a FetchLike stub.
    this.fetchImpl = options.fetchImpl ?? (egressFetch as unknown as FetchLike);
    this.now = options.now ?? (() => Date.now());
  }

  private cacheKey(scope: AssistantScope, issuer: string): string {
    return `${scopeKey(scope)}\u001f${issuer}`;
  }

  /** Returns a cached token when one is still comfortably valid. */
  cached(scope: AssistantScope, issuer: string): CachedAccessToken | undefined {
    const key = this.cacheKey(scope, issuer);
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (!isAccessTokenFresh(entry, this.now())) {
      // Evict eagerly rather than leaving a stale entry to be re-checked on every
      // turn; the cache is also how `size()` reports pressure.
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Mints an access token, reusing an in-flight request for the same key.
   *
   * Callers should consult {@link cached} first (the authority decision already
   * does); this method re-checks anyway so a coalesced waiter that arrives after a
   * successful mint gets the fresh token instead of triggering another exchange.
   */
  async mint(scope: AssistantScope, issuer: string): Promise<MintResult> {
    const key = this.cacheKey(scope, issuer);
    const fresh = this.cached(scope, issuer);
    if (fresh !== undefined) return { ok: true, token: fresh };

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const attempt = this.performMint(scope, issuer).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async performMint(scope: AssistantScope, issuer: string): Promise<MintResult> {
    const credential = await this.options.credentials.read(scope, issuer);
    if (credential === undefined) {
      return {
        ok: false,
        transient: false,
        detail: "no delegation grant is stored for this assistant and issuer.",
      };
    }
    if (credential.revokedAt !== undefined) {
      return {
        ok: false,
        transient: false,
        detail: "the delegation grant was revoked.",
      };
    }

    let endpoint: string;
    try {
      endpoint = (await this.options.resolveTokenEndpoint(issuer)).token_endpoint;
    } catch (err) {
      // Discovery failure is an infrastructure problem, not a bad grant, so it
      // must NOT count against the failure budget — three unreachable-IdP
      // moments would otherwise permanently mark a healthy grant as broken.
      return {
        ok: false,
        transient: true,
        detail: `identity provider discovery failed (${err instanceof Error ? err.message : String(err)}).`,
      };
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      // Re-assert the consented scope so a compromised or buggy caller cannot
      // widen it: the IdP will only ever narrow, never grant more than the grant
      // itself carries.
      scope: credential.consentedScope,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        transient: true,
        detail: `the token request failed (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    clearTimeout(timer);

    if (!response.ok) {
      // 4xx means the IdP rejected the grant itself (invalid/expired/revoked
      // refresh token) — that is a real failure and counts. 5xx is the provider
      // being unwell and must not.
      const transient = response.status >= 500;
      if (!transient) {
        const failures = await this.options.credentials.recordRefreshFailure(scope, issuer);
        this.options.logger?.warn("Delegated token refresh rejected", {
          assistantId: scope.assistantId,
          issuer,
          status: response.status,
          failures,
        });
      }
      return {
        ok: false,
        transient,
        detail: `the identity provider rejected the refresh (HTTP ${response.status}).`,
      };
    }

    let parsed: RefreshResponse;
    try {
      parsed = (await response.json()) as RefreshResponse;
    } catch {
      return {
        ok: false,
        transient: true,
        detail: "the identity provider returned a malformed token response.",
      };
    }

    const accessToken =
      typeof parsed.access_token === "string" && parsed.access_token.length > 0
        ? parsed.access_token
        : undefined;
    if (accessToken === undefined) {
      const failures = await this.options.credentials.recordRefreshFailure(scope, issuer);
      this.options.logger?.warn("Delegated token refresh returned no access token", {
        assistantId: scope.assistantId,
        issuer,
        failures,
      });
      return {
        ok: false,
        transient: false,
        detail: "the identity provider returned no access token.",
      };
    }

    const rotated =
      typeof parsed.refresh_token === "string" &&
      parsed.refresh_token.length > 0 &&
      parsed.refresh_token !== credential.refreshToken
        ? parsed.refresh_token
        : undefined;

    // Persist rotation BEFORE handing the access token out. If the process dies
    // in between, we lose an access token (harmless, it is re-minted) rather than
    // a rotated refresh token (fatal, the grant is already dead at the IdP).
    await this.options.credentials.recordRefreshSuccess({
      scope,
      issuer,
      ...(rotated !== undefined ? { rotatedRefreshToken: rotated } : {}),
    });

    const ttlMs =
      typeof parsed.expires_in === "number" &&
      Number.isFinite(parsed.expires_in) &&
      parsed.expires_in > 0
        ? Math.floor(parsed.expires_in * 1000)
        : DEFAULT_ACCESS_TOKEN_TTL_MS;
    const grantedScope =
      typeof parsed.scope === "string" && parsed.scope.length > 0
        ? parsed.scope
        : credential.consentedScope;

    const token: CachedAccessToken = {
      token: accessToken,
      scope: grantedScope,
      expiresAt: this.now() + ttlMs,
    };

    // A token whose whole lifetime is inside the safety margin is not cacheable —
    // storing it would guarantee a miss on the next read. Hand it out for this
    // run only.
    if (ttlMs > ACCESS_TOKEN_EXPIRY_MARGIN_MS) {
      this.evictIfFull();
      this.cache.set(this.cacheKey(scope, issuer), token);
    }
    return { ok: true, token };
  }

  /** Drops the cached token for one assistant/issuer. */
  invalidate(scope: AssistantScope, issuer: string): void {
    this.cache.delete(this.cacheKey(scope, issuer));
  }

  /** Drops every cached token. Used on shutdown and by tests. */
  clear(): void {
    this.cache.clear();
  }

  /** Current cache occupancy, for diagnostics. */
  size(): number {
    return this.cache.size;
  }

  /**
   * Bounds the cache. Expired entries go first; if none are expired, the oldest
   * insertion is dropped (Map preserves insertion order), which for
   * similar-lifetime tokens is also the soonest to expire.
   */
  private evictIfFull(): void {
    if (this.cache.size < MAX_CACHE_ENTRIES) return;
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (!isAccessTokenFresh(entry, now)) this.cache.delete(key);
    }
    if (this.cache.size < MAX_CACHE_ENTRIES) return;
    const oldest = this.cache.keys().next();
    if (!oldest.done) this.cache.delete(oldest.value);
  }
}

/**
 * OIDC discovery for the token endpoint, backed by the shared
 * `@atf/security-kit` client (Req 11.2): single-flight, cached (positive
 * ≥ 5 min instead of permanent), exact issuer match and `jwks_uri`
 * validation (Req 7.3).
 *
 * Separate from the operator-plane discovery in `routes/auth-oidc.ts` because
 * that module's cache is private to its router. Sharing a cache across the two
 * would couple the assistant runtime's lifetime to the operator router's, for a
 * saving of one HTTP request per issuer per process.
 */
export function createTokenEndpointResolver(fetchImpl?: FetchLike): TokenEndpointResolver {
  const doFetch = fetchImpl ?? (egressFetch as unknown as FetchLike);
  const clients = new Map<string, ReturnType<typeof createDiscoveryClient>>();
  return async (issuer: string): Promise<TokenEndpointMetadata> => {
    let client = clients.get(issuer);
    if (client === undefined) {
      client = createDiscoveryClient(issuer, {
        // FetchLike has no response Headers object; the kit only reads
        // Cache-Control, and its 5-minute positive-cache floor applies anyway.
        fetchImpl: async (url, init) => {
          const res = await doFetch(url, {
            ...(init?.headers !== undefined ? { headers: init.headers } : {}),
            ...(init?.signal !== undefined ? { signal: init.signal } : {}),
          });
          return {
            ok: res.ok,
            status: res.status,
            headers: { get: (): string | null => null },
            json: () => res.json(),
          };
        },
      });
      clients.set(issuer, client);
    }
    const doc = (await client.getMetadata()) as { token_endpoint?: unknown };
    if (typeof doc.token_endpoint !== "string") {
      throw new Error("OIDC discovery document has no token_endpoint.");
    }
    return { token_endpoint: doc.token_endpoint };
  };
}
