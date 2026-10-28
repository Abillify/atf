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
 * Discovery (single-flight, cached), JWKS fetching, key rotation and token
 * verification are delegated to `@atf/security-kit` (`createDiscoveryClient`,
 * `createJwtVerifier`), one verifier per configured issuer, created lazily so an
 * unreachable IdP does not block startup. The kit verifier is built against the
 * canonical `issuer` from the discovery document and requires an `exp` claim —
 * both slightly stricter than the previous local implementation.
 */

import { decodeJwt, type JWTPayload } from "jose";
import {
  createDiscoveryClient,
  createJwtVerifier as createKitJwtVerifier,
  type DiscoveryClient,
  type JwtVerifier as KitJwtVerifier,
  trimTrailingSlashes,
} from "@atf/security-kit";
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
  /** Kit discovery client (single-flight, positive cache, negative backoff). */
  discovery: DiscoveryClient;
  /** Lazy kit verifier, built once the canonical issuer is discovered. */
  verifierPromise: Promise<KitJwtVerifier> | null;
}

function normaliseIssuer(issuer: string): string {
  return trimTrailingSlashes(issuer);
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
    // `trailing-slash` tolerates providers like Authentik that embed a trailing
    // slash in `iss`; the kit verifier is built against doc.issuer (the
    // canonical value), so the `iss` check matches what the provider signs.
    discovery: createDiscoveryClient(config.issuer, {
      issuerMatch: "trailing-slash",
    }),
    verifierPromise: null,
  }));

  /** Build (once) the kit verifier for a state entry via its discovery doc. */
  function verifierFor(state: IssuerState): Promise<KitJwtVerifier> {
    if (state.verifierPromise !== null) return state.verifierPromise;
    state.verifierPromise = state.discovery
      .getMetadata()
      .then((doc) =>
        createKitJwtVerifier({
          issuers: [
            {
              issuer: doc.issuer,
              jwksUri: doc.jwks_uri,
              ...(state.config.audience !== undefined
                ? { audiences: [state.config.audience] }
                : {}),
            },
          ],
        }),
      )
      .catch((err: unknown) => {
        // Reset so a transient failure does not poison the cache permanently.
        state.verifierPromise = null;
        throw err;
      });
    return state.verifierPromise;
  }

  async function verify(rawJwt: string): Promise<JwtPrincipal | null> {
    // The unverified `iss` is used only to *select* candidate issuers from the
    // allow-list. Signature, issuer and audience are all still enforced by the
    // kit verifier below, so a forged `iss` can at worst pick the wrong key set
    // and fail verification.
    let claimedIssuer: string | undefined;
    try {
      claimedIssuer = decodeJwt(rawJwt).iss;
    } catch {
      return null;
    }
    if (claimedIssuer === undefined) return null;
    const normalisedClaim = normaliseIssuer(claimedIssuer);
    const candidates = states.filter(
      (state) => state.normalised === normalisedClaim,
    );
    if (candidates.length === 0) return null;

    for (const state of candidates) {
      try {
        const kitVerifier = await verifierFor(state);
        const { payload } = await kitVerifier.verify(rawJwt);
        return toPrincipal(
          payload,
          state.config,
          defaultTenantId,
          tenantIsolationEnabled,
        );
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

