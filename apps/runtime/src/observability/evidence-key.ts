// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shared Ed25519 evidence signing key (`src/observability/evidence-key.ts`)
 *
 * Every artifact of the ATF evidence chain — audit-chain anchors, signed
 * evidence bundles, and (as a fallback) erasure receipts — used to be signed
 * with HMAC-SHA256 under an operator-held shared secret. That makes them
 * unverifiable by anyone who does not possess the secret: an auditor, a
 * regulator or a customer cannot check the artefact offline without being
 * handed the very secret whose secrecy the signature is supposed to rest on.
 *
 * This module introduces ONE asymmetric Ed25519 evidence key (ADR 0030) that
 * all three artefacts share. Third parties verify offline against the
 * published public key (`GET /.well-known/atf-evidence-jwks.json`) — no shared
 * secret required. HMAC remains supported for VERIFYING pre-existing
 * artefacts (long-lived anchors must stay checkable) and as a signing fallback
 * when no asymmetric key is configured.
 *
 * Key material format mirrors `RECEIPT_SIGNING_KEY`
 * (`src/receipts/signing-key.ts`): a PEM PKCS#8 Ed25519 private key or a
 * base64-encoded raw 32-byte seed. Unlike the receipt key (WebCrypto, async),
 * this module is node:crypto-based and SYNC so it composes with the existing
 * synchronous `signAuditAnchor`/`signEvidenceBundle` call sites — the same
 * choice `src/compliance/erasure-receipt.ts` already makes.
 *
 * `kid` is the base64url SHA-256 thumbprint of the raw public key, matching
 * the receipt-key convention so tooling (`--kid`) works uniformly.
 *
 * No `any` at module boundaries.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import {
  base64UrlEncode,
  ed25519RawKeyToJwk,
  type Ed25519PublicJwk,
} from "@atf/security-kit";

/**
 * PKCS#8 DER prefix for an Ed25519 private key wrapping a raw 32-byte seed
 * (RFC 8410) — identical to the constant in `compliance/erasure-receipt.ts`.
 */
const ED25519_PKCS8_SEED_PREFIX = "302e020100300506032b657004220420";

/**
 * SPKI DER prefix for a raw Ed25519 public key (RFC 8410): `SEQUENCE {
 * SEQUENCE { OID 1.3.101.112 }, BIT STRING { <32 raw bytes> } }`. Used to
 * import a bare 32-byte public key for verification without a JWKS round-trip.
 */
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";

/** Raw Ed25519 public key length in bytes. */
export const ED25519_EVIDENCE_PUB_KEY_BYTES = 32;

/**
 * A parsed Ed25519 evidence signing key: the private half for signing and the
 * public half (raw bytes + JWK + thumbprint `kid`) for publishing and
 * verification.
 */
export interface Ed25519EvidenceKey {
  /** The private key, ready for node:crypto `sign(null, bytes, privateKey)`. */
  readonly privateKey: KeyObject;
  /** The 32-byte raw Ed25519 public key. */
  readonly publicKeyRaw: Uint8Array;
  /** base64url SHA-256 thumbprint of {@link publicKeyRaw}. */
  readonly kid: string;
  /** Public JWK (OKP/Ed25519) including {@link kid} — for the JWKS endpoint. */
  readonly jwk: Ed25519PublicJwk;
}

/**
 * A public-only verification target: enough for a third party (CLI, auditor
 * tooling) to verify artefacts without any secret.
 */
export interface Ed25519EvidencePublicKey {
  readonly publicKeyRaw: Uint8Array;
  /** Optional thumbprint; when present it must match the artefact's `kid`. */
  readonly kid?: string;
}

/**
 * Parse the configured `EVIDENCE_SIGNING_KEY`. Accepts a PEM PKCS#8 Ed25519
 * private key or a base64-encoded raw 32-byte seed — the same formats as
 * `RECEIPT_SIGNING_KEY` and `ERASURE_RECEIPT_SIGNING_KEY`.
 *
 * Returns `undefined` for `undefined`/blank input (asymmetric signing not
 * configured — callers fall back to HMAC). Throws on malformed input: a
 * misconfigured evidence key must fail loudly, never silently downgrade.
 */
export function parseEvidenceSigningKey(
  value: string | undefined,
): Ed25519EvidenceKey | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  let privateKey: KeyObject;
  if (value.startsWith("-----BEGIN")) {
    try {
      privateKey = createPrivateKey({ key: value, format: "pem", type: "pkcs8" });
    } catch {
      throw new Error(
        "EVIDENCE_SIGNING_KEY must be a PEM PKCS#8 Ed25519 private key or a base64-encoded 32-byte Ed25519 seed",
      );
    }
  } else {
    const seed = Buffer.from(value, "base64");
    if (seed.length !== 32) {
      throw new Error(
        "EVIDENCE_SIGNING_KEY must be a PEM PKCS#8 Ed25519 private key or a base64-encoded 32-byte Ed25519 seed",
      );
    }
    const der = Buffer.from(ED25519_PKCS8_SEED_PREFIX + seed.toString("hex"), "hex");
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("EVIDENCE_SIGNING_KEY must be an Ed25519 key");
  }
  const publicJwk = privateKey.export({ format: "jwk" });
  const x = typeof publicJwk.x === "string" ? publicJwk.x : undefined;
  if (x === undefined) {
    throw new Error("EVIDENCE_SIGNING_KEY: unable to export Ed25519 public key");
  }
  const publicKeyRaw = new Uint8Array(Buffer.from(x, "base64url"));
  const kid = base64UrlEncode(createHash("sha256").update(publicKeyRaw).digest());
  return {
    privateKey,
    publicKeyRaw,
    kid,
    jwk: ed25519RawKeyToJwk(publicKeyRaw, kid),
  };
}

/**
 * Import a bare 32-byte Ed25519 public key (e.g. from a JWKS `x` value) for
 * verification. Throws on wrong length.
 */
export function evidencePublicKeyFromRaw(publicKeyRaw: Uint8Array): KeyObject {
  if (publicKeyRaw.length !== ED25519_EVIDENCE_PUB_KEY_BYTES) {
    throw new Error(
      `Ed25519 public key must be ${ED25519_EVIDENCE_PUB_KEY_BYTES} bytes`,
    );
  }
  const der = Buffer.from(
    ED25519_SPKI_PREFIX + Buffer.from(publicKeyRaw).toString("hex"),
    "hex",
  );
  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("Not a valid Ed25519 public key");
  }
}

/**
 * Sign arbitrary evidence bytes (a canonical JSON document, a chain-tip hash,
 * …) with the evidence key. Returns a base64url Ed25519 signature.
 */
export function signEvidenceBytes(
  key: Ed25519EvidenceKey,
  data: string | Uint8Array,
): string {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return sign(null, bytes, key.privateKey).toString("base64url");
}

/**
 * Verify an Ed25519 signature over `data` against a raw public key. Never
 * throws — malformed signatures simply verify as `false`.
 */
export function verifyEvidenceBytes(
  publicKey: Uint8Array | KeyObject,
  data: string | Uint8Array,
  signatureBase64url: string,
): boolean {
  try {
    const pub = publicKey instanceof Uint8Array ? evidencePublicKeyFromRaw(publicKey) : publicKey;
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    const signature = Buffer.from(signatureBase64url, "base64url");
    return verify(null, bytes, pub, signature);
  } catch {
    return false;
  }
}
