// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OAuth 2.0 Token Exchange (RFC 8693) — shared security building block.
 *
 * Exchanges the caller's own verified bearer for a downstream-scoped token via
 * RFC 8693, so a downstream service (an MCP server, an LLM gateway, …) receives
 * a token that was minted *for it* — right audience, minimal scope, short
 * lifetime — instead of the raw login token that authenticated the caller.
 *
 * ## Why this exists (and why it is not the same as passthrough)
 *
 * Forwarding the caller's login token verbatim gives every downstream service
 * the same credential the caller presented to the gateway. That token carries
 * the gateway's own audience, so every downstream server must accept it, and a
 * compromised or buggy server can replay it against the gateway itself or any
 * other service the user can reach — the classic confused-deputy problem. Token
 * exchange narrows the blast radius: the exchanged token is bound to one
 * audience and can be issued with a reduced scope, so it is useless anywhere
 * else. The subject stays the user, so per-user ACLs on the far side still work.
 *
 * ## Delegation (`act`)
 *
 * With an {@link ActorTokenProvider} configured, the exchange becomes an
 * on-behalf-of (OBO) delegation: it additionally sends `actor_token`, and the
 * IdP records the gateway as the acting party in the issued token's RFC 8693
 * `act` claim (`{ sub: <user>, act: { sub: <actor> } }`). The far side can then
 * distinguish "the user did this directly" from "the agent did this for the
 * user" — for audit and for actor-scoped policy. `sub` is unchanged, so servers
 * that ignore `act` behave exactly as before.
 *
 * ## Caching
 *
 * A single interactive turn can fan out into dozens of tool calls against the
 * same server. Exchanging on each one would multiply IdP round trips and — worse
 * — mint a fresh session bearer every call, defeating a per-caller session pool.
 * The cache is process-local (exchanged tokens live minutes; replicas mint
 * independently without conflict) and keyed by everything that changes the
 * *result*: the subject token, the target audience, the requested scope, and the
 * actor. In-flight requests for the same key are coalesced.
 *
 * ## Fail-closed
 *
 * Every transport, status, or shape error resolves to a typed failure, never a
 * throw into the calling path and never a fallback to the un-exchanged token: a
 * token exchange that silently degraded to passthrough would reintroduce exactly
 * the audience problem it exists to remove. Token material never appears in a
 * log field or an error message.
 *
 * No `any` at module boundaries.
 */

import { createHash } from "node:crypto";

/**
 * Minimal structural logger this module depends on. Deliberately narrower than
 * any concrete platform logger so a caller's `Logger` satisfies it without an
 * adapter, and so the kit stays free of app-specific observability imports.
 */
export interface ExchangeLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// RFC 8693 constants
// ---------------------------------------------------------------------------

const GRANT_TYPE_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const GRANT_TYPE_CLIENT_CREDENTIALS = "client_credentials";
export const TOKEN_TYPE_ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
export const TOKEN_TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";

/**
 * Default lifetime assumed when the IdP omits `expires_in`. Deliberately short:
 * a wrong long guess produces intermittent authorization failures that read like
 * permission bugs; re-minting slightly too often is the cheaper mistake.
 */
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;

/**
 * Safety margin before expiry. A token with only seconds left is not usable: the
 * downstream call it authorises may still be in flight when it lapses.
 */
export const EXCHANGE_EXPIRY_MARGIN_MS = 60_000;

/** Network timeout for a single token-endpoint request. */
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;

/** Bound on cached tokens so a large tenant cannot grow a cache without limit. */
const MAX_CACHE_ENTRIES = 5_000;

// ---------------------------------------------------------------------------
// Injected collaborators (tests need no network and no IdP)
// ---------------------------------------------------------------------------

/** Minimal `fetch` surface this module depends on. Injectable for tests. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** Resolves an issuer to its OAuth token endpoint. */
export type TokenEndpointResolver = (issuer: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Client-authentication method against the token endpoint. `client_secret_post`
 * places the credentials in the form body; `client_secret_basic` uses the HTTP
 * `Authorization` header. Authentik accepts both; the default follows what most
 * IdPs treat as canonical for confidential clients.
 */
export type ClientAuthMethod = "client_secret_post" | "client_secret_basic";

/**
 * How the gateway obtains the actor token that identifies it as the acting party
 * in a delegation exchange. Only `client_credentials` is implemented; the shape
 * is a discriminated union so a future `private_key_jwt` can be added without a
 * breaking change to callers.
 */
export interface ActorClientCredentialsConfig {
  grant: "client_credentials";
  /** Token endpoint that issues the actor token. Defaults to the exchange endpoint. */
  tokenEndpoint?: string;
  clientId: string;
  clientSecret: string;
  clientAuth?: ClientAuthMethod;
  /** Scope requested for the actor token, if the IdP requires one. */
  scope?: string;
  /** Optional audience for the actor token itself. */
  audience?: string;
}

/** Fully-resolved configuration for one token-exchange target. */
export interface TokenExchangeConfig {
  /**
   * Token endpoint of the provider performing the exchange. Either this or
   * {@link issuer} (with a resolver) must be provided.
   */
  tokenEndpoint?: string;
  /** OIDC issuer whose discovery yields the token endpoint, resolved lazily. */
  issuer?: string;
  /** `client_id` of the confidential client performing the exchange. */
  clientId: string;
  /** Confidential client secret. Resolved from an env reference by the loader. */
  clientSecret: string;
  clientAuth?: ClientAuthMethod;
  /** Target provider's `client_id` (RFC 8693 `audience`). */
  audience: string;
  /** Space-delimited scopes to request. Sent verbatim; some IdPs mint no scope when omitted. */
  scope?: string;
  /** `subject_token_type`. Defaults to access_token. */
  subjectTokenType?: string;
  /** `requested_token_type`. Optional; IdP default is access_token. */
  requestedTokenType?: string;
  /** Actor for a delegation (OBO) exchange. Absent → impersonation. */
  actor?: ActorClientCredentialsConfig;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A minted downstream token with its expiry. Token material never logged. */
export interface ExchangedToken {
  token: string;
  /** Epoch millis after which the token must be re-minted. */
  expiresAt: number;
  /** Scopes the IdP granted, when it echoed them. */
  scope?: string;
  /** Whether this exchange carried an actor token (delegation). */
  delegated: boolean;
}

/** Outcome of an exchange attempt. Fail-closed: no fallback to the subject token. */
export type ExchangeResult =
  | { ok: true; token: ExchangedToken }
  | {
      ok: false;
      /** Operator/model-facing reason. Never contains token material. */
      detail: string;
      /** True when the failure is likely transient (network, 5xx). */
      transient: boolean;
    };

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface TokenEndpointResponse {
  access_token?: unknown;
  issued_token_type?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function ttlFromExpiresIn(expiresIn: unknown, now: number): number {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + Math.floor(expiresIn * 1000);
  }
  return now + DEFAULT_TOKEN_TTL_MS;
}

function applyClientAuth(
  body: URLSearchParams,
  headers: Record<string, string>,
  clientId: string,
  clientSecret: string,
  method: ClientAuthMethod,
): void {
  if (method === "client_secret_basic") {
    const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${encoded}`;
    body.set("client_id", clientId);
    return;
  }
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
}

// ---------------------------------------------------------------------------
// Actor token provider (delegation)
// ---------------------------------------------------------------------------

/**
 * Obtains and caches the actor token that identifies the gateway as the acting
 * party. The actor token is a workload credential, not a user credential, so it
 * is cached process-wide by (endpoint, clientId, scope, audience) rather than
 * per user.
 */
export class ActorTokenProvider {
  private cached: ExchangedToken | undefined;
  private inFlight: Promise<ExchangeResult> | undefined;
  private resolvedEndpoint: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly endpointResolver: TokenEndpointResolver | undefined;
  private readonly issuer: string | undefined;
  // No TypeScript parameter properties in this file: Node's strip-only
  // type-stripping (`node --test`) cannot parse them and this module is
  // reachable from the barrel export used by the Node test runner.
  private readonly config: ActorClientCredentialsConfig;

  constructor(
    config: ActorClientCredentialsConfig,
    endpoint: string | undefined,
    options: {
      fetchImpl?: FetchLike;
      now?: () => number;
      timeoutMs?: number;
      logger?: ExchangeLogger;
      endpointResolver?: TokenEndpointResolver;
      issuer?: string;
    } = {},
  ) {
    this.config = config;
    this.fetchImpl =
      options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
    this.endpointResolver = options.endpointResolver;
    this.issuer = options.issuer;
    this.resolvedEndpoint =
      endpoint !== undefined && endpoint.trim() !== "" ? endpoint : undefined;
  }

  private async endpoint(): Promise<string> {
    if (this.resolvedEndpoint !== undefined) return this.resolvedEndpoint;
    if (this.issuer === undefined || this.endpointResolver === undefined) {
      throw new Error(
        "Actor token provider has no token endpoint and no issuer resolver",
      );
    }
    const resolved = await this.endpointResolver(this.issuer);
    this.resolvedEndpoint = resolved;
    return resolved;
  }

  /** Returns a valid actor access token, minting one when the cache is cold/stale. */
  async token(): Promise<ExchangeResult> {
    const now = this.now();
    if (
      this.cached !== undefined &&
      this.cached.expiresAt - EXCHANGE_EXPIRY_MARGIN_MS > now
    ) {
      return { ok: true, token: this.cached };
    }
    if (this.inFlight !== undefined) return this.inFlight;
    const attempt = this.mint().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = attempt;
    return attempt;
  }

  private async mint(): Promise<ExchangeResult> {
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE_CLIENT_CREDENTIALS,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    applyClientAuth(
      body,
      headers,
      this.config.clientId,
      this.config.clientSecret,
      this.config.clientAuth ?? "client_secret_post",
    );
    if (this.config.scope !== undefined) body.set("scope", this.config.scope);
    if (this.config.audience !== undefined)
      body.set("audience", this.config.audience);

    let endpoint: string;
    try {
      endpoint = await this.endpoint();
    } catch (err) {
      return {
        ok: false,
        transient: true,
        detail: `actor token endpoint discovery failed (${err instanceof Error ? err.message : String(err)}).`,
      };
    }

    const result = await requestToken(
      this.fetchImpl,
      endpoint,
      body,
      headers,
      this.timeoutMs,
      this.now,
    );
    if (result.ok) this.cached = result.token;
    return result;
  }

  /** Drops the cached actor token. */
  clear(): void {
    this.cached = undefined;
  }
}

// ---------------------------------------------------------------------------
// Token exchanger
// ---------------------------------------------------------------------------

interface CacheEntry {
  token: ExchangedToken;
}

/**
 * Performs and caches RFC 8693 exchanges for one configured target. One instance
 * per downstream server (each has its own audience/scope/actor), constructed
 * from that server's `tokenExchange` config.
 */
export class TokenExchanger {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ExchangeResult>>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly logger: ExchangeLogger | undefined;
  private readonly actorProvider: ActorTokenProvider | undefined;

  private readonly endpointResolver: TokenEndpointResolver | undefined;
  private resolvedEndpoint: string | undefined;
  private readonly config: TokenExchangeConfig;

  constructor(
    config: TokenExchangeConfig,
    options: {
      fetchImpl?: FetchLike;
      now?: () => number;
      logger?: ExchangeLogger;
      actorProvider?: ActorTokenProvider;
      /** Resolves `config.issuer` to a token endpoint when `tokenEndpoint` is absent. */
      endpointResolver?: TokenEndpointResolver;
    } = {},
  ) {
    this.config = config;
    if (
      config.clientId.trim() === "" ||
      (config.clientSecret ?? "").trim() === "" ||
      config.audience.trim() === ""
    ) {
      throw new Error(
        "Token exchange requires a non-empty clientId, clientSecret and audience",
      );
    }
    if (
      (config.tokenEndpoint === undefined ||
        config.tokenEndpoint.trim() === "") &&
      config.issuer === undefined
    ) {
      throw new Error("Token exchange requires either tokenEndpoint or issuer");
    }
    this.fetchImpl =
      options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = config.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
    this.logger = options.logger;
    this.endpointResolver = options.endpointResolver;
    this.resolvedEndpoint =
      config.tokenEndpoint !== undefined && config.tokenEndpoint.trim() !== ""
        ? config.tokenEndpoint
        : undefined;
    this.actorProvider =
      options.actorProvider ??
      (config.actor !== undefined
        ? new ActorTokenProvider(
            config.actor,
            // The actor endpoint defaults to the exchange's own token endpoint;
            // fall back to issuer discovery only when neither is a concrete URL.
            config.actor.tokenEndpoint ?? config.tokenEndpoint,
            {
              ...(options.fetchImpl !== undefined
                ? { fetchImpl: options.fetchImpl }
                : {}),
              ...(options.now !== undefined ? { now: options.now } : {}),
              ...(options.logger !== undefined
                ? { logger: options.logger }
                : {}),
              ...(options.endpointResolver !== undefined
                ? { endpointResolver: options.endpointResolver }
                : {}),
              ...(config.issuer !== undefined ? { issuer: config.issuer } : {}),
              timeoutMs: this.timeoutMs,
            },
          )
        : undefined);
  }

  /** Resolves and memoises the token endpoint (via discovery when only an issuer is set). */
  private async endpoint(): Promise<string> {
    if (this.resolvedEndpoint !== undefined) return this.resolvedEndpoint;
    if (
      this.config.issuer === undefined ||
      this.endpointResolver === undefined
    ) {
      throw new Error(
        "Token exchange has no token endpoint and no issuer resolver",
      );
    }
    const resolved = await this.endpointResolver(this.config.issuer);
    this.resolvedEndpoint = resolved;
    return resolved;
  }

  /** True when this exchanger performs a delegation (OBO) exchange. */
  get isDelegating(): boolean {
    return this.actorProvider !== undefined;
  }

  private cacheKey(
    subjectToken: string,
    actorToken: string | undefined,
  ): string {
    // The subject token, target and requested scope determine the result; the
    // actor token participates because a different actor yields a different
    // `act` claim. Hash the credentials so no raw token becomes a live map key.
    return [
      sha256(subjectToken),
      this.config.audience,
      this.config.scope ?? "",
      actorToken === undefined ? "" : sha256(actorToken),
    ].join("\u001f");
  }

  /**
   * Returns a downstream token for `subjectToken`, reusing a cached one while it
   * is comfortably valid and coalescing concurrent misses.
   */
  async exchange(subjectToken: string): Promise<ExchangeResult> {
    if (subjectToken.trim() === "") {
      return {
        ok: false,
        transient: false,
        detail: "no subject token to exchange.",
      };
    }

    let actorToken: string | undefined;
    if (this.actorProvider !== undefined) {
      const actor = await this.actorProvider.token();
      if (!actor.ok) {
        // A failed actor mint must not silently degrade to impersonation: the
        // whole point of delegation is that the far side sees the actor.
        return {
          ok: false,
          transient: actor.transient,
          detail: `actor token could not be obtained (${actor.detail})`,
        };
      }
      actorToken = actor.token.token;
    }

    const key = this.cacheKey(subjectToken, actorToken);
    const cached = this.cache.get(key);
    if (
      cached !== undefined &&
      cached.token.expiresAt - EXCHANGE_EXPIRY_MARGIN_MS > this.now()
    ) {
      return { ok: true, token: cached.token };
    }
    this.cache.delete(key);

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const attempt = this.performExchange(subjectToken, actorToken).finally(
      () => {
        this.inFlight.delete(key);
      },
    );
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async performExchange(
    subjectToken: string,
    actorToken: string | undefined,
  ): Promise<ExchangeResult> {
    const body = new URLSearchParams({
      grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type:
        this.config.subjectTokenType ?? TOKEN_TYPE_ACCESS_TOKEN,
      audience: this.config.audience,
    });
    if (this.config.scope !== undefined) body.set("scope", this.config.scope);
    if (this.config.requestedTokenType !== undefined) {
      body.set("requested_token_type", this.config.requestedTokenType);
    }
    if (actorToken !== undefined) {
      body.set("actor_token", actorToken);
      body.set("actor_token_type", TOKEN_TYPE_ACCESS_TOKEN);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    applyClientAuth(
      body,
      headers,
      this.config.clientId,
      this.config.clientSecret,
      this.config.clientAuth ?? "client_secret_post",
    );

    let endpoint: string;
    try {
      endpoint = await this.endpoint();
    } catch (err) {
      return {
        ok: false,
        transient: true,
        detail: `token endpoint discovery failed (${err instanceof Error ? err.message : String(err)}).`,
      };
    }

    const result = await requestToken(
      this.fetchImpl,
      endpoint,
      body,
      headers,
      this.timeoutMs,
      this.now,
    );
    if (result.ok) {
      const token: ExchangedToken = {
        ...result.token,
        delegated: actorToken !== undefined,
      };
      this.evictIfFull();
      this.cache.set(this.cacheKey(subjectToken, actorToken), { token });
      this.logger?.debug("Token exchange succeeded", {
        audience: this.config.audience,
        delegated: token.delegated,
        // Never the token; the fingerprint lets two log lines be correlated.
        subjectFingerprint: sha256(subjectToken).slice(0, 12),
      });
      return { ok: true, token };
    }
    this.logger?.warn("Token exchange failed", {
      audience: this.config.audience,
      transient: result.transient,
      detail: result.detail,
    });
    return result;
  }

  /**
   * Drops every cached exchanged token for `subjectToken`, e.g. after the
   * downstream server rejected one (revocation, clock skew). The next
   * {@link exchange} for that subject then mints a fresh token.
   */
  invalidate(subjectToken: string): void {
    const prefix = `${sha256(subjectToken)}\u001f`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Drops every cached exchanged token. */
  clear(): void {
    this.cache.clear();
    this.actorProvider?.clear();
  }

  /** Current cache occupancy, for diagnostics. */
  size(): number {
    return this.cache.size;
  }

  private evictIfFull(): void {
    if (this.cache.size < MAX_CACHE_ENTRIES) return;
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (entry.token.expiresAt - EXCHANGE_EXPIRY_MARGIN_MS <= now)
        this.cache.delete(key);
    }
    if (this.cache.size < MAX_CACHE_ENTRIES) return;
    const oldest = this.cache.keys().next();
    if (!oldest.done) this.cache.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------
// Shared token-endpoint request
// ---------------------------------------------------------------------------

/**
 * POSTs a form-encoded grant to a token endpoint and maps the response to an
 * {@link ExchangeResult}. Fail-closed on every error; token material is never
 * placed in a returned `detail`.
 */
async function requestToken(
  fetchImpl: FetchLike,
  endpoint: string,
  body: URLSearchParams,
  headers: Record<string, string>,
  timeoutMs: number,
  now: () => number,
): Promise<ExchangeResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      transient: true,
      detail: `the token request failed (${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  if (!response.ok) {
    // 5xx is the IdP being unwell (transient); 4xx is a rejected grant
    // (invalid_target, invalid_grant, unauthorized_client …) and is terminal.
    const transient = response.status >= 500;
    let oauthError = "";
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === "string") oauthError = `: ${parsed.error}`;
    } catch {
      // Body may not be JSON; the status alone is enough to fail closed.
    }
    return {
      ok: false,
      transient,
      detail: `the identity provider rejected the exchange (HTTP ${response.status}${oauthError}).`,
    };
  }

  let parsed: TokenEndpointResponse;
  try {
    parsed = (await response.json()) as TokenEndpointResponse;
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
    return {
      ok: false,
      transient: false,
      detail: "the identity provider returned no access token.",
    };
  }

  return {
    ok: true,
    token: {
      token: accessToken,
      expiresAt: ttlFromExpiresIn(parsed.expires_in, now()),
      ...(typeof parsed.scope === "string" && parsed.scope.length > 0
        ? { scope: parsed.scope }
        : {}),
      delegated: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Token-endpoint discovery
// ---------------------------------------------------------------------------

/**
 * Memoised OIDC discovery of the token endpoint. Separate from the JWT- and
 * assistant-plane discovery caches on purpose: coupling their lifetimes to save
 * one HTTP request per issuer per process is not worth the shared mutable state.
 */
export function createTokenEndpointResolver(
  fetchImpl?: (
    input: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>,
): TokenEndpointResolver {
  const cache = new Map<string, string>();
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as NonNullable<typeof fetchImpl>);
  return async (issuer: string): Promise<string> => {
    const hit = cache.get(issuer);
    if (hit !== undefined) return hit;
    const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
    const res = await doFetch(`${base}/.well-known/openid-configuration`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DEFAULT_EXCHANGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`OIDC discovery failed for token endpoint: HTTP ${res.status}`);
    }
    const doc = (await res.json()) as { token_endpoint?: unknown };
    if (typeof doc.token_endpoint !== "string" || doc.token_endpoint.length === 0) {
      throw new Error("OIDC discovery document has no token_endpoint.");
    }
    cache.set(issuer, doc.token_endpoint);
    return doc.token_endpoint;
  };
}
