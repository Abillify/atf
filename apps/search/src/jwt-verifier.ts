// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jwt-verifier.ts
 *
 * Multi-issuer OIDC JWT Bearer verification for API / MCP endpoints.
 *
 * Each configured issuer is backed by:
 *   • a lazy-fetched, in-process-cached discovery document
 *     (`<issuer>/.well-known/openid-configuration`)
 *   • a jose `RemoteJWKSet` that fetches and caches the provider's public keys
 *     and handles key rotation automatically
 *
 * Verification flow for an incoming `Authorization: Bearer <jwt>`:
 *   1. Decode the JWT payload (without verification) to read `iss`.
 *   2. Find the matching `ApiOidcIssuerConfig` by normalising trailing slashes.
 *   3. Fetch/reuse the discovery document and JWKS for that issuer.
 *   4. Call `jwtVerify` — validates signature, `exp`, `iss`, and optionally `aud`.
 *   5. Return `{ iss, sub }` on success, `null` on any failure.
 *
 * Unknown issuers are rejected immediately (no network calls, no fallback).
 */

import { decodeJwt, type JWTPayload } from "jose";
import {
  createDiscoveryClient,
  createJwtVerifier as createKitJwtVerifier,
  type DiscoveryClient,
  type JwtVerifier as KitJwtVerifier,
} from "@atf/security-kit";
import type { ApiOidcIssuerConfig } from "./config.js";

export interface JwtPrincipal {
  /** `iss` claim — the issuer that signed the token. */
  iss: string;
  /** `sub` claim — the subject (client or user identity). */
  sub: string;
  /** Verified tenant claim when tenant isolation is enabled. */
  tenantId?: string;
  /** Normalized, de-duplicated authorization scopes. */
  scopes: string[];
  /** Verified JWT audience and optional configured client identifier. */
  audience: string | string[] | undefined;
  clientId: string | undefined;
  /** JWT ID, suitable only as a credential correlation identifier. */
  jti: string | undefined;
  /** The identity used for ACL evaluation. */
  userId: string;
  /** Group memberships used for ACL evaluation. */
  groups: string[];
}

/**
 * Normalise a claim value into a list of group names.
 *
 * IdPs are inconsistent here: Keycloak emits a JSON array, some gateways emit a
 * space-separated string, others comma-separated. All three are accepted rather
 * than silently producing an empty group list for two of them.
 */
export function normaliseGroupsClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

export function normaliseScopesClaim(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export interface JwtVerifier {
  /**
   * Verify a raw JWT string obtained from an Authorization: Bearer header.
   * Returns the verified principal on success, or null on any failure
   * (invalid signature, expired token, unknown issuer, failed discovery, …).
   */
  verify(rawJwt: string): Promise<JwtPrincipal | null>;
}

interface IssuerState {
  config: ApiOidcIssuerConfig;
  /** Normalised issuer URL (no trailing slash) — used for URL construction. */
  normalised: string;
  /** Kit discovery client (single-flight, positive cache, negative backoff). */
  discovery: DiscoveryClient;
  /** Lazy kit verifier, built once the canonical issuer is discovered. */
  verifierPromise: Promise<KitJwtVerifier> | null;
}

/** Normalise an issuer URL for comparison (strip trailing slash, lowercase scheme+host). */
function normalise(issuer: string): string {
  return issuer.replace(/\/+$/, "");
}

export function createJwtVerifier(
  issuers: ApiOidcIssuerConfig[],
  defaultTenantId?: string,
  tenantIsolationEnabled?: boolean,
): JwtVerifier | null {
  if (issuers.length === 0) return null;
  const configuredDefaultTenantId = defaultTenantId?.trim() || undefined;

  // Build a lookup map: normalised issuer URL → mutable state object.
  const stateMap = new Map<string, IssuerState>();
  for (const cfg of issuers) {
    const norm = normalise(cfg.issuer);
    if (stateMap.has(norm)) {
      // Duplicate issuer entries — last one wins (consistent with env-var override convention).
      console.warn(
        `[jwt-verifier] Duplicate API_OIDC_ISSUERS entry for "${norm}" — using last occurrence`,
      );
    }
    stateMap.set(norm, {
      config: cfg,
      normalised: norm,
      // `trailing-slash` tolerates providers like Authentik that embed a
      // trailing slash in `iss`; the kit verifier below is built against
      // doc.issuer (the canonical value), so the `iss` check always matches
      // what the provider actually signs.
      discovery: createDiscoveryClient(cfg.issuer, {
        issuerMatch: "trailing-slash",
      }),
      verifierPromise: null,
    });
  }

  /**
   * Build (once) the kit JWT verifier for a state entry. The canonical issuer
   * is whatever the provider's discovery doc says — it is the value that
   * appears in `iss` claims and what jose validates against. The kit provides
   * the signature/issuer/audience/expiry checks; this module keeps issuer
   * routing and claim mapping.
   */
  function getVerifier(state: IssuerState): Promise<KitJwtVerifier> {
    if (state.verifierPromise === null) {
      state.verifierPromise = state.discovery
        .getMetadata()
        .then((doc) =>
          createKitJwtVerifier({
            issuers: [
              {
                issuer: doc.issuer, // canonical — may include trailing slash
                jwksUri: doc.jwks_uri,
                ...(state.config.audience !== undefined
                  ? { audiences: [state.config.audience] }
                  : {}),
              },
            ],
          }),
        )
        .catch((err: unknown) => {
          // Reset on transient failure so the next request retries.
          state.verifierPromise = null;
          throw err;
        });
    }
    return state.verifierPromise;
  }

  async function verify(rawJwt: string): Promise<JwtPrincipal | null> {
    // Step 1 — read `iss` without verifying the signature.
    let iss: string;
    try {
      const claims = decodeJwt(rawJwt);
      if (typeof claims.iss !== "string" || !claims.iss) return null;
      iss = claims.iss;
    } catch {
      return null; // not a valid JWT
    }

    // Step 2 — find the matching issuer config.
    const state = stateMap.get(normalise(iss));
    if (!state) return null; // unknown issuer — reject without network call

    // Step 3 — discovery + kit verifier construction (JWKS included).
    let kitVerifier: KitJwtVerifier;
    try {
      kitVerifier = await getVerifier(state);
    } catch {
      return null; // discovery failed
    }

    // Step 4 — verify signature and standard claims via the kit.
    let payload: JWTPayload;
    let canonicalIssuer: string;
    try {
      const verified = await kitVerifier.verify(rawJwt);
      payload = verified.payload;
      canonicalIssuer = verified.issuer;
    } catch {
      return null; // expired, bad signature, wrong audience, etc.
    }

    if (typeof payload.sub !== "string" || !payload.sub) return null;

    // Resolve the ACL identity from the configured claim, falling back to
    // `sub`. A configured claim that is present but not a usable string falls
    // back rather than yielding an empty identity, because an empty identity
    // used to mean "service context" downstream — i.e. full access.
    const userClaim = state.config.userClaim ?? "sub";
    const rawUser = payload[userClaim];
    const userId =
      typeof rawUser === "string" && rawUser.trim().length > 0
        ? rawUser.trim()
        : payload.sub;

    const groupsClaim = state.config.groupsClaim ?? "groups";
    const groups = normaliseGroupsClaim(payload[groupsClaim]);
    // Isolation requires the issuer-specific configured claim. In single-
    // tenant mode caller claims are ignored and the server default is used.
    const tenantClaim = state.config.tenantClaim ?? "tenantId";
    const rawTenant = payload[tenantClaim];
    const verifiedTenantId =
      typeof rawTenant === "string" && rawTenant.trim()
        ? rawTenant.trim()
        : undefined;
    const tenantId =
      tenantIsolationEnabled === true
        ? verifiedTenantId
        : tenantIsolationEnabled === false
          ? (configuredDefaultTenantId ?? "default")
          : (verifiedTenantId ?? configuredDefaultTenantId);
    if (!tenantId) return null;
    const scopesClaim = state.config.scopesClaim ?? "scope";
    const scopes = [
      ...normaliseScopesClaim(payload[scopesClaim]),
      ...normaliseScopesClaim(payload["kb"]).map(
        (collection) => `kb:${collection}`,
      ),
    ];
    const clientClaim = state.config.clientIdClaim ?? "client_id";
    const rawClientId = payload[clientClaim];
    const clientId =
      typeof rawClientId === "string" && rawClientId.trim()
        ? rawClientId.trim()
        : undefined;
    const audience =
      typeof payload.aud === "string" || Array.isArray(payload.aud)
        ? (payload.aud as string | string[])
        : undefined;
    const jti =
      typeof payload.jti === "string" && payload.jti.trim()
        ? payload.jti.trim()
        : undefined;

    return {
      iss: canonicalIssuer,
      sub: payload.sub,
      userId,
      groups,
      tenantId,
      scopes,
      audience,
      clientId,
      jti,
    };
  }

  return { verify };
}
