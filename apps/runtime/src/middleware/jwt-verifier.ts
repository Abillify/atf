// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * JWT Verifier (`src/middleware/jwt-verifier.ts`)
 *
 * Optional cryptographic JWT verification using `jose`. When a verification
 * mode is configured (OIDC issuer, HS256 shared secret, or a JWKS endpoint),
 * tokens are fully verified (signature + expiry, plus issuer/audience for
 * OIDC). When none is configured, verification is skipped (format-only, handled
 * by the auth middleware) and a warning is logged once at startup.
 *
 * No `any` at module boundaries.
 *
 * Requirements: 2.x (extends format-only validation with real verification)
 */

import {
  jwtVerify,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
} from "jose";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";

export interface JwtVerifier {
  /**
   * Verifies a token. Resolves true if valid (or if verification is disabled),
   * false if cryptographic verification fails.
   */
  verify(token: string): Promise<boolean>;
  /**
   * Decodes and returns the JWT payload claims without signature verification.
   * Used to extract user attributes (roles, groups, custom claims) after the
   * token has been verified.
   * Returns null if the token cannot be decoded (malformed).
   */
  decodePayload(token: string): Record<string, unknown> | null;
  /** Whether cryptographic verification is active. */
  readonly enabled: boolean;
}

class NoopVerifier implements JwtVerifier {
  readonly enabled = false;
  async verify(): Promise<boolean> {
    return true;
  }
  decodePayload(token: string): Record<string, unknown> | null {
    return _decodePayloadSafe(token);
  }
}

class HmacVerifier implements JwtVerifier {
  readonly enabled = true;
  private readonly key: Uint8Array;
  private readonly logger: Logger | undefined;

  constructor(secret: string, logger?: Logger) {
    this.key = new TextEncoder().encode(secret);
    this.logger = logger;
  }

  async verify(token: string): Promise<boolean> {
    try {
      await jwtVerify(token, this.key);
      return true;
    } catch (err) {
      this.logger?.debug("HS256 token verification failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  decodePayload(token: string): Record<string, unknown> | null {
    return _decodePayloadSafe(token);
  }
}

class JwksVerifier implements JwtVerifier {
  readonly enabled = true;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly logger: Logger | undefined;

  constructor(
    jwksUrl: string,
    private readonly issuer: string | undefined,
    private readonly audience: string | undefined,
    logger?: Logger,
  ) {
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
    this.logger = logger;
  }

  async verify(token: string): Promise<boolean> {
    try {
      await jwtVerify(token, this.jwks, {
        ...(this.issuer !== undefined ? { issuer: this.issuer } : {}),
        ...(this.audience !== undefined ? { audience: this.audience } : {}),
      });
      return true;
    } catch (err) {
      // Surface WHY verification failed (wrong kid/alg, no applicable key,
      // signature mismatch, JWKS fetch error) — otherwise a JWKS/token mismatch
      // is invisible. Header claims help pinpoint an alg/kid mismatch fast.
      this.logger?.debug("JWKS token verification failed", {
        error: err instanceof Error ? err.message : String(err),
        header: _decodeHeaderSafe(token),
      });
      return false;
    }
  }

  decodePayload(token: string): Record<string, unknown> | null {
    return _decodePayloadSafe(token);
  }
}

/**
 * OIDC verifier — the strongest mode. Given an OIDC issuer URL it discovers the
 * `jwks_uri` from `<issuer>/.well-known/openid-configuration`, verifies the
 * token signature against that JWKS, and additionally enforces the `iss` claim
 * (and the `aud` claim when an audience is configured). This is what backs
 * OIDC/SSO login at the admin UI: the browser obtains an id/access token from
 * the IdP and the backend validates it here before the operator RBAC layer maps
 * its role/groups claims onto an operator role.
 *
 * Discovery is performed lazily on first verify and memoised; a failed
 * discovery is not cached so a transient IdP outage can recover on a later
 * request. `createRemoteJWKSet` handles JWKS caching + key rotation internally.
 */
class OidcVerifier implements JwtVerifier {
  readonly enabled = true;
  /** Issuer verbatim (used for the `iss` claim check — trailing slash matters). */
  private readonly issuer: string;
  private readonly audience: string | undefined;
  private readonly logger: Logger | undefined;
  private jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null =
    null;

  constructor(issuer: string, audience: string | undefined, logger?: Logger) {
    this.issuer = issuer;
    this.audience = audience;
    this.logger = logger;
  }

  /** Discovery URL, tolerant of a trailing slash on the issuer. */
  private discoveryUrl(): string {
    const base = this.issuer.endsWith("/")
      ? this.issuer.slice(0, -1)
      : this.issuer;
    return `${base}/.well-known/openid-configuration`;
  }

  private async resolveJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (this.jwksPromise === null) {
      this.jwksPromise = this.discover().catch((err: unknown) => {
        // Do not cache a failed discovery — allow a later request to retry.
        this.jwksPromise = null;
        throw err;
      });
    }
    return this.jwksPromise;
  }

  private async discover(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    const url = this.discoveryUrl();
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`OIDC discovery failed for ${url}: HTTP ${res.status}`);
    }
    const doc = (await res.json()) as { jwks_uri?: unknown };
    if (typeof doc.jwks_uri !== "string" || doc.jwks_uri.length === 0) {
      throw new Error(`OIDC discovery document at ${url} has no jwks_uri`);
    }
    this.logger?.info("OIDC discovery complete", {
      issuer: this.issuer,
      jwksUri: doc.jwks_uri,
    });
    return createRemoteJWKSet(new URL(doc.jwks_uri));
  }

  async verify(token: string): Promise<boolean> {
    try {
      const jwks = await this.resolveJwks();
      await jwtVerify(token, jwks, {
        issuer: this.issuer,
        ...(this.audience !== undefined ? { audience: this.audience } : {}),
      });
      return true;
    } catch (err) {
      this.logger?.debug("OIDC token verification failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  decodePayload(token: string): Record<string, unknown> | null {
    return _decodePayloadSafe(token);
  }
}

/**
 * Composite verifier for the inference plane: accepts a token when ANY of its
 * child verifiers accepts it. Used to let aiperator trust its own IdP
 * application AND one or more additional applications/issuers (e.g. the "taiga"
 * Authentik app) at the same time. `enabled` is true whenever at least one
 * child performs real verification; children that are format-only (NoopVerifier)
 * are never added here, so an accepted token always cleared a real signature
 * check by one of the issuers.
 */
class CompositeVerifier implements JwtVerifier {
  readonly enabled = true;
  private readonly verifiers: JwtVerifier[];
  private readonly logger: Logger | undefined;

  constructor(verifiers: JwtVerifier[], logger?: Logger) {
    this.verifiers = verifiers;
    this.logger = logger;
  }

  async verify(token: string): Promise<boolean> {
    for (const v of this.verifiers) {
      try {
        if (await v.verify(token)) return true;
      } catch (err) {
        this.logger?.debug("composite verifier child threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return false;
  }

  decodePayload(token: string): Record<string, unknown> | null {
    return _decodePayloadSafe(token);
  }
}

/**
 * Decodes the JWT payload without verification — safe to call after verify().
 */
function _decodePayloadSafe(token: string): Record<string, unknown> | null {
  try {
    const payload = decodeJwt(token);
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Decodes the JWT protected header (alg, kid, typ) without verification — used
 * only for diagnostics when verification fails, to pinpoint an alg/kid mismatch
 * against the configured JWKS.
 */
function _decodeHeaderSafe(token: string): Record<string, unknown> | null {
  try {
    return decodeProtectedHeader(token) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Builds the verifier for the INFERENCE plane (`/v1/*`).
 *
 * Precedence: JWKS URL > HMAC secret > OIDC issuer > no-op (format-only). OIDC
 * is the lowest-priority fallback here so that a deployment configuring ONLY an
 * OIDC issuer still verifies inference tokens, while a deployment that runs a
 * separate token source for `/v1/*` (e.g. an Open WebUI JWKS) keeps using it —
 * the OIDC issuer then applies only to the operator plane (see
 * {@link createOperatorVerifier}).
 */
/**
 * Builds a dedicated OIDC/JWKS-discovery verifier for each additional trusted
 * issuer (`JWT_ADDITIONAL_ISSUERS`). Used on the inference plane and, since the
 * approval gate lives on the operator plane, also folded into the operator
 * verifier so a token minted by an additional issuer can resolve approvals.
 */
function buildExtraOidcVerifiers(
  config: AppConfig,
  logger?: Logger,
): JwtVerifier[] {
  const extraIssuers = config.inferenceExtraOidcIssuers ?? [];
  return extraIssuers.map((e) => {
    logger?.info("Additional OIDC issuer trusted", {
      issuer: e.issuer,
      ...(e.audience !== undefined ? { audience: e.audience } : {}),
    });
    return new OidcVerifier(e.issuer, e.audience, logger);
  });
}

export function createJwtVerifier(
  config: AppConfig,
  logger?: Logger,
): JwtVerifier {
  const mode = config.authnMode;
  if (mode === "disabled") {
    logger?.warn("Authentication is disabled; requests use an anonymous principal");
    return new NoopVerifier();
  }

  const oidcPrimary = (): JwtVerifier | undefined =>
    config.oidcIssuer !== undefined
      ? new OidcVerifier(config.oidcIssuer, config.oidcAudience, logger)
      : undefined;

  // OIDC-only excludes local HMAC/API-key credentials, but may trust several
  // explicitly issuer/audience-pinned external OIDC applications. This is
  // required when the operator BFF and upstream clients use different IdP apps.
  if (mode === "oidc") {
    const children = [oidcPrimary(), ...buildExtraOidcVerifiers(config, logger)].filter(
      (verifier): verifier is JwtVerifier => verifier?.enabled === true,
    );
    if (children.length === 0) {
      logger?.warn("AUTHN_MODE=oidc but no OIDC issuer is configured");
      return new NoopVerifier();
    }
    return children.length === 1
      ? (children[0] as JwtVerifier)
      : new CompositeVerifier(children, logger);
  }

  // Additional trusted issuers are token credentials and therefore participate
  // only in legacy/token and explicit token_or_oidc modes.
  const extraVerifiers: JwtVerifier[] = buildExtraOidcVerifiers(config, logger);

  const tokenPrimary = (): JwtVerifier => {
    if (config.jwtJwksUrl !== undefined) {
      if (config.jwtIssuer === undefined || config.jwtAudience === undefined) {
        logger?.warn(
          "JWT_JWKS_URL ignored because JWT_ISSUER and JWT_AUDIENCE are both required",
        );
        return new NoopVerifier();
      }
      logger?.info("JWT verification enabled via issuer/audience-bound JWKS", {
        jwksUrl: config.jwtJwksUrl,
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      });
      return new JwksVerifier(
        config.jwtJwksUrl,
        config.jwtIssuer,
        config.jwtAudience,
        logger,
      );
    }
    if (config.jwtSecret !== undefined) {
      logger?.info("JWT verification enabled via HS256 shared secret");
      return new HmacVerifier(config.jwtSecret, logger);
    }
    return new NoopVerifier();
  };

  if (mode === "token_or_oidc") {
    const children = [tokenPrimary(), ...extraVerifiers, oidcPrimary()].filter(
      (verifier): verifier is JwtVerifier => verifier?.enabled === true,
    );
    return children.length === 0
      ? new NoopVerifier()
      : children.length === 1
        ? (children[0] as JwtVerifier)
        : new CompositeVerifier(children, logger);
  }

  if (mode === "token") {
    const primary = tokenPrimary();
    const children = primary.enabled ? [primary, ...extraVerifiers] : extraVerifiers;
    return children.length === 0
      ? primary
      : children.length === 1
        ? (children[0] as JwtVerifier)
        : new CompositeVerifier(children, logger);
  }

  // Legacy compatibility when AUTHN_MODE is absent: preserve historical
  // precedence and emit no behavioral migration surprise.
  const primary: JwtVerifier = (() => {
    if (config.jwtJwksUrl !== undefined) {
      if (config.jwtIssuer === undefined || config.jwtAudience === undefined) {
        return new NoopVerifier();
      }
      return new JwksVerifier(
        config.jwtJwksUrl,
        config.jwtIssuer,
        config.jwtAudience,
        logger,
      );
    }
    if (config.jwtSecret !== undefined) return new HmacVerifier(config.jwtSecret, logger);
    return oidcPrimary() ?? new NoopVerifier();
  })();
  if (extraVerifiers.length === 0) return primary;
  const children = primary.enabled ? [primary, ...extraVerifiers] : extraVerifiers;
  return new CompositeVerifier(children, logger);
}

/**
 * Builds the verifier for the OPERATOR / admin plane (dashboard, `/monitoring`,
 * `/flows`, control).
 *
 * When `OIDC_ISSUER` is configured it gets a DEDICATED verifier that validates
 * tokens against that issuer's discovered JWKS (with `iss`/optional `aud`
 * checks) — independent of the inference-plane verifier. This is what lets the
 * admin UI use a different IdP application than the `/v1/*` API (e.g. an
 * "aiperator" OIDC app for operators vs. an "Open WebUI" JWKS for inference).
 *
 * When `OIDC_ISSUER` is unset, the operator plane reuses the inference verifier
 * (`fallback`), preserving the single-token-source setup.
 *
 * In every mode the additional trusted issuers (`JWT_ADDITIONAL_ISSUERS`) are
 * also honoured: the approval gate is exposed on the operator plane, so a token
 * minted by an additional issuer (e.g. the taiga Authentik app) must be able to
 * clear operator auth to resolve approvals. The dedicated operator verifier is
 * therefore composed with the extra-issuer verifiers. In the fallback mode the
 * inference verifier already includes them, so it is returned unchanged.
 */
export function createOperatorVerifier(
  config: AppConfig,
  fallback: JwtVerifier,
  logger?: Logger,
): JwtVerifier {
  const extraVerifiers = buildExtraOidcVerifiers(config, logger);

  // Composes a dedicated operator-plane primary with any additional issuers so
  // the approval gate accepts every configured token source.
  const withExtras = (primary: JwtVerifier): JwtVerifier => {
    if (extraVerifiers.length === 0) return primary;
    logger?.info("Operator-plane JWT verification is multi-issuer", {
      issuers: extraVerifiers.length + 1,
    });
    return new CompositeVerifier([primary, ...extraVerifiers], logger);
  };

  // Backend-driven (BFF) SSO: the dashboard carries a session token that the
  // backend itself minted and HS256-signed with OIDC_SESSION_SECRET after the
  // confidential-client login. Verify against that secret.
  if (config.oidcSessionSecret !== undefined) {
    logger?.info(
      "Operator-plane session verification enabled (backend-minted HS256)",
    );
    return withExtras(new HmacVerifier(config.oidcSessionSecret, logger));
  }
  if (config.oidcIssuer !== undefined) {
    logger?.info("Operator-plane OIDC verification enabled", {
      issuer: config.oidcIssuer,
      ...(config.oidcAudience !== undefined
        ? { audience: config.oidcAudience }
        : {}),
    });
    return withExtras(
      new OidcVerifier(config.oidcIssuer, config.oidcAudience, logger),
    );
  }
  // Fallback: the inference verifier already folds in the extra issuers.
  return fallback;
}
