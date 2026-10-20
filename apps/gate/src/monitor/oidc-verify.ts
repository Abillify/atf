// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { constants, createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Minimal ID token (JWT) verification against a provider's JWKS — no external
 * dependency. Supports the RSA/ECDSA/RSA-PSS families every mainstream OIDC
 * provider (Authentik, Keycloak, Okta, Auth0, Azure AD, ...) issues by default.
 */

interface Jwks { keys: Array<JsonWebKey & { kid?: string }>; }

const HASH_BY_ALG: Record<string, string> = {
  RS256: "sha256",
  RS384: "sha384",
  RS512: "sha512",
  PS256: "sha256",
  PS384: "sha384",
  PS512: "sha512",
  ES256: "sha256",
  ES384: "sha384",
  ES512: "sha512",
};

/** A provider that does not answer must not hold a login request open. */
const FETCH_TIMEOUT_MS = 10_000;
/** How long a fetched JWKS is trusted before it is fetched again. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** Allowed clock skew for `nbf`/`iat`, in seconds (`exp` is checked strictly). */
const CLOCK_TOLERANCE_SEC = 60;
const jwksCache = new Map<string, { doc: Jwks; fetchedAt: number }>();
async function fetchJwks(jwksUri: string, forceRefresh = false): Promise<Jwks> {
  if (!forceRefresh) {
    const cached = jwksCache.get(jwksUri);
    if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.doc;
  }
  const res = await fetch(jwksUri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`JWKS fetch from ${jwksUri} failed: HTTP ${res.status}`);
  const doc = (await res.json()) as Jwks;
  if (!Array.isArray(doc.keys)) throw new Error(`JWKS response from ${jwksUri} has no 'keys' array`);
  jwksCache.set(jwksUri, { doc, fetchedAt: Date.now() });
  return doc;
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, "");
}

function verifySignature(alg: string, jwk: JsonWebKey, data: Buffer, signature: Buffer): boolean {
  const hash = HASH_BY_ALG[alg];
  if (!hash) return false;
  const publicKey = createPublicKey({ key: jwk, format: "jwk" });
  if (alg.startsWith("ES")) {
    // JWS ECDSA signatures are raw R||S; Node's default is DER, so request IEEE P1363.
    return cryptoVerify(hash, data, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  }
  if (alg.startsWith("PS")) {
    return cryptoVerify(
      hash,
      data,
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      signature,
    );
  }
  return cryptoVerify(hash, data, publicKey, signature);
}

export interface VerifiedIdToken {
  sub: string;
  claims: Record<string, unknown>;
}

/**
 * Verify an OIDC ID token's signature against the provider's JWKS, plus the
 * `iss`, `aud` and `exp` claims. Throws on any failure — callers must treat
 * verification failure as a failed login, never fall back to trusting the
 * unverified payload.
 */
export async function verifyIdToken(
  idToken: string,
  opts: {
    issuer: string;
    clientId: string;
    jwksUri: string;
    /**
     * The `nonce` sent in the authorization request. When given, the token must
     * carry exactly that value: it ties the ID token to THIS login attempt, so
     * a token captured or replayed from another login is refused.
     */
    nonce?: string;
  },
): Promise<VerifiedIdToken> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed ID token (expected header.payload.signature)");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString()) as { alg?: string; kid?: string };
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as Record<string, unknown>;

  const alg = header.alg;
  if (!alg || !(alg in HASH_BY_ALG)) {
    throw new Error(`unsupported or missing ID token alg: ${String(alg)}`);
  }

  const data = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(sigB64, "base64url");

  let { keys } = await fetchJwks(opts.jwksUri);
  let candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
  if (candidates.length === 0 && header.kid) {
    // The signing key may have rotated since we last cached the JWKS; refetch once.
    ({ keys } = await fetchJwks(opts.jwksUri, true));
    candidates = keys.filter((k) => k.kid === header.kid);
  }
  if (candidates.length === 0) {
    throw new Error(`no JWKS key matches ID token kid='${header.kid ?? ""}'`);
  }

  const verified = candidates.some((jwk) => {
    try {
      return verifySignature(alg, jwk, data, signature);
    } catch {
      return false;
    }
  });
  if (!verified) throw new Error("ID token signature verification failed");

  const now = Math.floor(Date.now() / 1000);
  const exp = payload.exp;
  if (typeof exp !== "number" || exp <= now) throw new Error("ID token is expired");
  // `nbf` and `iat` in the future (beyond clock skew) mean the token is not
  // valid yet or was minted by a clock we do not agree with.
  const nbf = payload.nbf;
  if (typeof nbf === "number" && nbf > now + CLOCK_TOLERANCE_SEC) {
    throw new Error("ID token is not valid yet (nbf)");
  }
  const iat = payload.iat;
  if (typeof iat === "number" && iat > now + CLOCK_TOLERANCE_SEC) {
    throw new Error("ID token was issued in the future (iat)");
  }

  const iss = payload.iss;
  if (typeof iss !== "string" || normalizeIssuer(iss) !== normalizeIssuer(opts.issuer)) {
    throw new Error(`ID token 'iss' mismatch: ${String(iss)}`);
  }

  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud : [aud];
  if (!audList.includes(opts.clientId)) {
    throw new Error(`ID token 'aud' does not include configured clientId`);
  }

  // OIDC Core 3.1.3.7: with several audiences the authorized party must be us.
  if (audList.length > 1 && payload.azp !== opts.clientId) {
    throw new Error("ID token has several audiences and 'azp' is not the configured clientId");
  }
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) {
    throw new Error("ID token 'nonce' does not match the login attempt");
  }
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) throw new Error("ID token missing 'sub' claim");

  return { sub, claims: payload };
}
