// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * verifier.ts
 *
 * Shared JWT verification built on `jose`, with the properties every service
 * must share:
 *
 *   - Algorithm allowlist fixed at construction; `alg: none` and HS/RS
 *     confusion are impossible because keys are looked up per issuer and the
 *     `algorithms` option is passed to `jwtVerify`.
 *   - Issuer and audience are bound at construction and enforced by jose.
 *   - Multi-issuer routing: the (unverified) `iss` claim selects the issuer
 *     configuration; the signature is then verified against THAT issuer's
 *     keys only, so a token from issuer A can never pass as issuer B.
 *   - Errors are generic: the caller receives {@link JwtVerificationError}
 *     with a coarse reason; the underlying jose message never leaks to the
 *     client.
 */

import {
  jwtVerify,
  createRemoteJWKSet,
  createLocalJWKSet,
  type JWTPayload,
  type JWK,
  type JWTVerifyOptions,
  type JWTVerifyGetKey,
} from "jose";
import { createDiscoveryClient, type DiscoveryClient, type OidcDiscoveryDocument } from "./discovery.ts";

export interface IssuerConfig {
  /** Exact `iss` value this configuration handles. */
  issuer: string;
  /** Audience(s) the `aud` claim must contain. Empty = audience not checked. */
  audiences?: readonly string[];
  /**
   * JWKS source, exactly one of:
   * - `jwksUri`: fetch remotely (jose caches + rotates),
   * - `jwks`: static key set (tests, air-gapped static keys),
   * - omitted: discover `jwks_uri` from `<issuer>/.well-known/openid-configuration`.
   */
  jwksUri?: string;
  jwks?: { keys: JWK[] };
  /** Override the discovery client (tests / guarded fetch). */
  discovery?: DiscoveryClient;
}

export interface JwtVerifierOptions {
  issuers: readonly IssuerConfig[];
  /** Allowed JWS algorithms (default RS256, ES256, EdDSA — never HS*, never none). */
  algorithms?: readonly string[];
  /** Maximum token age clock tolerance in seconds (default 0). */
  clockToleranceSec?: number;
  /** Require an `exp` claim (default true). */
  requireExpiry?: boolean;
}

export type JwtRejectionReason =
  | "unknown_issuer"
  | "invalid_token"
  | "expired"
  | "bad_audience"
  | "bad_issuer"
  | "bad_signature"
  | "missing_claim"
  | "key_unavailable";

/** Plain fields (no parameter properties) for Node type-stripping compatibility. */
export class JwtVerificationError extends Error {
  readonly reason: JwtRejectionReason;
  constructor(reason: JwtRejectionReason, message: string) {
    super(message);
    this.name = "JwtVerificationError";
    this.reason = reason;
  }
}

export interface VerifiedJwt {
  payload: JWTPayload;
  /** The issuer configuration that verified the token. */
  issuer: string;
}

export interface JwtVerifier {
  /** Verify a compact JWS; throws {@link JwtVerificationError} on any failure. */
  verify(token: string): Promise<VerifiedJwt>;
  /** Configured issuer values. */
  readonly issuers: readonly string[];
}

/** Read the unverified `iss` claim purely for routing. Never trust its value. */
function routingIssuer(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecodeSegment(parts[1] ?? "")),
    ) as unknown;
    if (typeof payload === "object" && payload !== null) {
      const iss = (payload as { iss?: unknown }).iss;
      if (typeof iss === "string") return iss;
    }
  } catch {
    /* fall through — routing simply fails, verification reports invalid_token */
  }
  return undefined;
}

function base64UrlDecodeSegment(segment: string): Uint8Array {
  const pad = segment.length % 4 === 0 ? "" : "=".repeat(4 - (segment.length % 4));
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createJwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  if (options.issuers.length === 0) {
    throw new Error("createJwtVerifier requires at least one issuer configuration");
  }
  const algorithms = options.algorithms ?? ["RS256", "ES256", "EdDSA"];
  if (algorithms.some((alg) => alg.toLowerCase() === "none")) {
    throw new Error('the algorithm allowlist must never include "none"');
  }
  const requireExpiry = options.requireExpiry ?? true;
  const byIssuer = new Map<string, IssuerConfig>();
  for (const config of options.issuers) {
    if (byIssuer.has(config.issuer)) {
      throw new Error(`duplicate issuer configuration for "${config.issuer}"`);
    }
    byIssuer.set(config.issuer, config);
  }

  const keyProviderCache = new Map<string, Promise<JWTVerifyGetKey>>();

  const keyProviderFor = (config: IssuerConfig): Promise<JWTVerifyGetKey> => {
    const existing = keyProviderCache.get(config.issuer);
    if (existing !== undefined) return existing;
    const built = (async (): Promise<JWTVerifyGetKey> => {
      if (config.jwks !== undefined) {
        return createLocalJWKSet(config.jwks);
      }
      let uri = config.jwksUri;
      if (uri === undefined) {
        const discovery = config.discovery ?? createDiscoveryClient(config.issuer);
        const document: OidcDiscoveryDocument = await discovery.getMetadata();
        uri = document.jwks_uri;
      }
      return createRemoteJWKSet(new URL(uri));
    })();
    keyProviderCache.set(config.issuer, built);
    return built;
  };

  const verify = async (token: string): Promise<VerifiedJwt> => {
    const iss = routingIssuer(token);
    if (iss === undefined) {
      throw new JwtVerificationError("invalid_token", "token is not a JWT with an issuer claim");
    }
    const config = byIssuer.get(iss);
    if (config === undefined) {
      throw new JwtVerificationError("unknown_issuer", "token issuer is not trusted");
    }
    let keyProvider: JWTVerifyGetKey;
    try {
      keyProvider = await keyProviderFor(config);
    } catch {
      throw new JwtVerificationError("key_unavailable", "verification keys are unavailable");
    }
    const verifyOptions: JWTVerifyOptions = {
      issuer: config.issuer,
      algorithms: [...algorithms],
      ...(options.clockToleranceSec !== undefined
        ? { clockTolerance: options.clockToleranceSec }
        : {}),
      ...(config.audiences && config.audiences.length > 0
        ? { audience: [...config.audiences] }
        : {}),
    };
    try {
      const { payload } = await jwtVerify(token, keyProvider, verifyOptions);
      if (requireExpiry && typeof payload.exp !== "number") {
        throw new JwtVerificationError("missing_claim", "token is missing an expiry claim");
      }
      return { payload, issuer: config.issuer };
    } catch (err) {
      if (err instanceof JwtVerificationError) throw err;
      throw mapJoseError(err);
    }
  };

  return { verify, issuers: [...byIssuer.keys()] };
}

/** Map jose errors onto coarse reasons without leaking internals. */
function mapJoseError(err: unknown): JwtVerificationError {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  const name = err instanceof Error ? err.name : "";
  if (code === "ERR_JWT_EXPIRED") return new JwtVerificationError("expired", "token has expired");
  if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
    return new JwtVerificationError("bad_signature", "token signature is invalid");
  }
  if (code === "ERR_JWS_INVALID" || name === "JWSInvalid") {
    return new JwtVerificationError("invalid_token", "token is malformed");
  }
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" || name === "JWTClaimValidationFailed") {
    const claim =
      typeof err === "object" && err !== null && "claim" in err
        ? String((err as { claim: unknown }).claim)
        : "";
    if (claim === "aud") return new JwtVerificationError("bad_audience", "token audience is invalid");
    if (claim === "iss") return new JwtVerificationError("bad_issuer", "token issuer is invalid");
    return new JwtVerificationError("invalid_token", "token claim validation failed");
  }
  if (
    code === "ERR_JWKS_NO_MATCHING_KEY" ||
    code === "ERR_JWK_FAILED_TO_RESOLVE" ||
    code === "ERR_JWKS_TIMEDOUT"
  ) {
    return new JwtVerificationError("key_unavailable", "verification keys are unavailable");
  }
  return new JwtVerificationError("invalid_token", "token could not be verified");
}
