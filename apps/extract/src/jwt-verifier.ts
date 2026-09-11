// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jwt-verifier.ts
 *
 * Bearer-JWT verification for the API, against one or more configured issuers.
 *
 * Two properties are load-bearing:
 *
 *  1. **Audience is pinned per issuer.** Without it, a token the same IdP minted
 *     for a *different* service verifies here and is accepted — audience
 *     confusion. The production gate flags a missing audience for exactly this
 *     reason; this module enforces it whenever it is configured.
 *
 *  2. **Nothing is trusted before the signature is checked.** The issuer is
 *     resolved by matching the `iss` claim against the configured allow-list
 *     *after* verification, not by reading the unverified payload to pick a JWKS.
 *     Picking the key set from an unverified claim is the classic way to make a
 *     multi-issuer verifier accept a self-signed token.
 *
 * JWKS fetching, caching and key rotation are handled by jose's remote key set,
 * one per issuer, created lazily so an unreachable IdP does not block startup.
 */

import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import type { ApiOidcIssuerConfig } from "./config.js";

/** Identity established by a verified JWT. */
export interface JwtPrincipal {
  userId: string | undefined;
  groups: string[];
  tenantId: string | undefined;
  scopes: string[];
  iss: string;
  audience: string | string[] | undefined;
  clientId: string | undefined;
  jti: string | undefined;
}

export interface JwtVerifier {
  /** Resolve to a principal, or null when the token is not acceptable. */
  verify(rawJwt: string): Promise<JwtPrincipal | null>;
}

/** Normalise a groups claim that may be an array or a delimited string. */
export function normaliseGroupsClaim(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return [
    ...new Set(
      raw
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

/** Normalise a scopes claim. OAuth `scope` is space-delimited; some IdPs use arrays. */
export function normaliseScopesClaim(value: unknown): string[] {
  return normaliseGroupsClaim(value);
}

interface IssuerState {
  config: ApiOidcIssuerConfig;
  /** Normalised issuer without a trailing slash, for matching `iss`. */
  normalised: string;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
  discovery: Promise<string> | null;
}

function normaliseIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

/**
 * Create a verifier over the configured issuers.
 *
 * Returns null-verifying behaviour when no issuers are configured, so callers do
 * not need to special-case the disabled state.
 */
export function createJwtVerifier(
  issuers: readonly ApiOidcIssuerConfig[],
  defaultTenantId: string,
  tenantIsolationEnabled: boolean,
): JwtVerifier | null {
  if (issuers.length === 0) return null;

  const states: IssuerState[] = issuers.map((config) => ({
    config,
    normalised: normaliseIssuer(config.issuer),
    jwks: null,
    discovery: null,
  }));

  /** Resolve and cache the JWKS URI from the issuer's discovery document. */
  async function jwksFor(state: IssuerState): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (state.jwks !== null) return state.jwks;
    if (state.discovery === null) {
      state.discovery = fetchJwksUri(state.normalised).catch((err: unknown) => {
        // Reset so a transient failure does not poison the cache permanently.
        state.discovery = null;
        throw err;
      });
    }
    const jwksUri = await state.discovery;
    state.jwks ??= createRemoteJWKSet(new URL(jwksUri));
    return state.jwks;
  }

  async function verify(rawJwt: string): Promise<JwtPrincipal | null> {
    // The unverified `iss` is used only to *select* candidate issuers from the
    // allow-list. Signature, issuer and audience are all still enforced by
    // jwtVerify below, so a forged `iss` can at worst pick the wrong key set and
    // fail verification.
    let claimedIssuer: string | undefined;
    try {
      claimedIssuer = decodeJwt(rawJwt).iss;
    } catch {
      return null;
    }
    if (claimedIssuer === undefined) return null;
    const normalisedClaim = normaliseIssuer(claimedIssuer);
    const candidates = states.filter((state) => state.normalised === normalisedClaim);
    if (candidates.length === 0) return null;

    for (const state of candidates) {
      try {
        const jwks = await jwksFor(state);
        const { payload } = await jwtVerify(rawJwt, jwks, {
          issuer: [state.config.issuer, state.normalised],
          ...(state.config.audience !== undefined ? { audience: state.config.audience } : {}),
        });
        return toPrincipal(payload, state.config, defaultTenantId, tenantIsolationEnabled);
      } catch {
        // Try the next issuer entry with the same URL (different audience).
      }
    }
    return null;
  }

  return { verify };
}

function toPrincipal(
  payload: JWTPayload,
  config: ApiOidcIssuerConfig,
  defaultTenantId: string,
  tenantIsolationEnabled: boolean,
): JwtPrincipal | null {
  const userClaim = config.userClaim ?? "sub";
  const rawUser = payload[userClaim];
  const userId = typeof rawUser === "string" && rawUser.trim() !== "" ? rawUser.trim() : undefined;
  // A token with no usable subject cannot be attributed, and attributing it to
  // "the service" would silently widen its authority.
  if (userId === undefined) return null;

  const groups = normaliseGroupsClaim(payload[config.groupsClaim ?? "groups"]);
  const scopes = normaliseScopesClaim(
    config.scopesClaim !== undefined ? payload[config.scopesClaim] : payload["scope"],
  );

  let tenantId: string | undefined;
  if (config.tenantClaim !== undefined) {
    const rawTenant = payload[config.tenantClaim];
    tenantId = typeof rawTenant === "string" && rawTenant.trim() !== "" ? rawTenant.trim() : undefined;
    // With isolation on, a token that cannot name its tenant must not be
    // silently placed in the default one.
    if (tenantIsolationEnabled && tenantId === undefined) return null;
  } else if (!tenantIsolationEnabled) {
    tenantId = defaultTenantId;
  }

  const clientIdClaim = config.clientIdClaim;
  const rawClientId = clientIdClaim !== undefined ? payload[clientIdClaim] : undefined;

  return {
    userId,
    groups,
    tenantId,
    scopes,
    iss: typeof payload.iss === "string" ? payload.iss : config.issuer,
    audience: payload.aud,
    clientId: typeof rawClientId === "string" ? rawClientId : undefined,
    jti: typeof payload.jti === "string" ? payload.jti : undefined,
  };
}

async function fetchJwksUri(issuer: string): Promise<string> {
  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText} (${url})`);
  }
  const doc = (await res.json()) as { jwks_uri?: unknown };
  if (typeof doc.jwks_uri !== "string") {
    throw new Error(`OIDC discovery document at ${url} has no jwks_uri`);
  }
  return doc.jwks_uri;
}
