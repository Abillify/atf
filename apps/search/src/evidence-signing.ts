// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Optional Ed25519 signature for verified evidence packs
 * (`SEARCH_EVIDENCE_SIGNING_KEY`).
 *
 * The key format matches the Runtime's `EVIDENCE_SIGNING_KEY`: a PEM PKCS#8
 * Ed25519 private key or a base64-encoded raw 32-byte seed. The parsing is
 * kept here on purpose — Search never imports Runtime code. `kid` is the
 * base64url SHA-256 thumbprint of the raw public key, as in the Runtime, so
 * tooling treats both keys alike.
 *
 * The signature covers the canonical bytes (`canonicalJson` of
 * `@atf/canonical-json`, the mode of the Runtime's evidence bundles) of the
 * pack WITHOUT its `signature` member.
 */

import {
  createHash,
  createPrivateKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "@atf/canonical-json";
import { base64UrlEncode, ed25519RawKeyToJwk } from "@atf/security-kit";
import type { VerifiedEvidencePack } from "./evidence-pack.js";

/** PKCS#8 DER prefix of an Ed25519 private key wrapping a raw 32-byte seed (RFC 8410). */
const ED25519_PKCS8_SEED_PREFIX = "302e020100300506032b657004220420";

const KEY_FORMAT_ERROR =
  "SEARCH_EVIDENCE_SIGNING_KEY must be a PEM PKCS#8 Ed25519 private key or a base64-encoded 32-byte Ed25519 seed";

export interface EvidenceSigningKey {
  readonly privateKey: KeyObject;
  /** base64url SHA-256 thumbprint of the raw public key. */
  readonly kid: string;
  /** Public JWK (OKP/Ed25519) including `kid`. */
  readonly jwk: ReturnType<typeof ed25519RawKeyToJwk>;
}

export interface EvidencePackSignature {
  alg: "EdDSA";
  kid: string;
  /** base64url Ed25519 signature over the canonical pack bytes. */
  value: string;
}

/**
 * Parse the configured key. Blank/absent input means "not configured"
 * (`null`); malformed input throws so a misconfiguration never silently
 * produces unsigned packs.
 */
export function parseEvidenceSigningKey(
  value: string | null | undefined,
): EvidenceSigningKey | null {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  let privateKey: KeyObject;
  try {
    if (value.startsWith("-----BEGIN")) {
      privateKey = createPrivateKey({ key: value, format: "pem", type: "pkcs8" });
    } else {
      const seed = Buffer.from(value, "base64");
      if (seed.length !== 32) throw new Error("bad seed length");
      privateKey = createPrivateKey({
        key: Buffer.from(ED25519_PKCS8_SEED_PREFIX + seed.toString("hex"), "hex"),
        format: "der",
        type: "pkcs8",
      });
    }
  } catch {
    throw new Error(KEY_FORMAT_ERROR);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("SEARCH_EVIDENCE_SIGNING_KEY must be an Ed25519 key");
  }
  const x = privateKey.export({ format: "jwk" }).x;
  if (typeof x !== "string") {
    throw new Error("SEARCH_EVIDENCE_SIGNING_KEY: unable to export the Ed25519 public key");
  }
  const publicKeyRaw = new Uint8Array(Buffer.from(x, "base64url"));
  const kid = base64UrlEncode(createHash("sha256").update(publicKeyRaw).digest());
  return { privateKey, kid, jwk: ed25519RawKeyToJwk(publicKeyRaw, kid) };
}

/** The bytes the signature covers: the canonical pack without `signature`. */
export function evidencePackSigningBytes(
  pack: Omit<VerifiedEvidencePack, "signature"> | VerifiedEvidencePack,
): Buffer {
  const { signature: _signature, ...unsigned } = pack as VerifiedEvidencePack;
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

/** Returns the pack with an additive `signature` member. */
export function signEvidencePack(
  pack: VerifiedEvidencePack,
  key: EvidenceSigningKey,
): VerifiedEvidencePack {
  const value = sign(null, evidencePackSigningBytes(pack), key.privateKey).toString(
    "base64url",
  );
  return { ...pack, signature: { alg: "EdDSA", kid: key.kid, value } };
}

/** JWKS document published at `/.well-known/atf-search-evidence-jwks.json`. */
export function evidenceJwks(key: EvidenceSigningKey): { keys: [EvidenceSigningKey["jwk"]] } {
  return { keys: [key.jwk] };
}
