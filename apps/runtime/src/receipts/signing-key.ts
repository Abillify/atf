// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision_Receipt signing key (Req 15.3, 15.4).
 *
 * Parses `RECEIPT_SIGNING_KEY` (PEM PKCS#8 or base64-encoded 32-byte Ed25519
 * seed — same accepted forms as `ERASURE_RECEIPT_SIGNING_KEY`) into a WebCrypto
 * signing key, and derives the public side for the JWKS endpoint. The `kid` is
 * the base64url SHA-256 thumbprint of the raw public key, so it is stable
 * across restarts and matches what `atf-verify` resolves via JWKS.
 */

import { createPrivateKey } from "node:crypto";

import {
  base64UrlEncode,
  ed25519RawKeyToJwk,
  exportEd25519RawPublicKey,
  importEd25519PrivateKeySeed,
  type Ed25519PublicJwk,
} from "@atf/security-kit";

/** PKCS#8 DER prefix wrapping a raw 32-byte Ed25519 seed (RFC 8410). */
const ED25519_PKCS8_SEED_PREFIX = "302e020100300506032b657004220420";

/** The parsed receipt signing key pair (private for signing, raw public for JWKS). */
export interface ReceiptSigningKey {
  /** WebCrypto Ed25519 private key for COSE_Sign1. */
  readonly privateKey: CryptoKey;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKeyRaw: Uint8Array;
  /** Key id: base64url(sha256(publicKeyRaw)), RFC 7638-style thumbprint. */
  readonly kid: string;
  /** Public JWK for the JWKS endpoint. */
  readonly jwk: Ed25519PublicJwk;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return new Uint8Array(digest);
}

/**
 * Parse the configured signing key. Accepts a PEM private key or a raw
 * base64-encoded 32-byte Ed25519 seed. Throws on malformed input — receipts
 * require an asymmetric key, there is no HMAC fallback (unlike erasure
 * receipts), so a broken configuration must fail loudly at startup.
 */
export async function parseReceiptSigningKey(
  value: string,
): Promise<ReceiptSigningKey> {
  let seed: Uint8Array;
  if (value.startsWith("-----BEGIN")) {
    // Normalize PEM → DER via node:crypto, then extract the trailing seed.
    const der = createPrivateKey({ key: value, format: "pem", type: "pkcs8" })
      .export({ format: "der", type: "pkcs8" });
    const hex = Buffer.from(der).toString("hex");
    if (!hex.startsWith(ED25519_PKCS8_SEED_PREFIX)) {
      throw new Error(
        "RECEIPT_SIGNING_KEY PEM is not an Ed25519 PKCS#8 key — receipts require Ed25519",
      );
    }
    seed = hexToBytes(hex.slice(ED25519_PKCS8_SEED_PREFIX.length));
  } else {
    seed = new Uint8Array(Buffer.from(value, "base64"));
    if (seed.length !== 32) {
      throw new Error(
        "RECEIPT_SIGNING_KEY must be a PEM Ed25519 private key or a base64-encoded 32-byte seed",
      );
    }
  }
  const privateKey = await importEd25519PrivateKeySeed(seed);
  const publicKeyRaw = await exportEd25519RawPublicKey(privateKey);
  const thumbprint = await sha256(publicKeyRaw);
  const kid = base64UrlEncode(thumbprint);
  return {
    privateKey,
    publicKeyRaw,
    kid,
    jwk: ed25519RawKeyToJwk(publicKeyRaw, kid),
  };
}
