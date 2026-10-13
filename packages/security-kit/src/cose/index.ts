// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * cose/index.ts
 *
 * COSE_Sign1 (RFC 9052 §4.2) with Ed25519 (RFC 8032) via WebCrypto — the
 * SCITT-compatible signature format for decision receipts (Req 15.3).
 * Pure WebCrypto/Uint8Array: no Node APIs, so the same code runs in the
 * Runtime, the Control browser bundle, and the compiled `atf-verify` CLI.
 *
 * The signature covers the `Sig_structure` =
 * ["Signature1", protected, external_aad, payload] encoded as CBOR
 * (RFC 9052 §4.4). The protected header is a CBOR map serialized once and
 * carried verbatim as a byte string, so header and signature bind to exactly
 * the same bytes.
 */

import {
  cborDecode,
  cborEncode,
  cborMap,
  type CborMap,
  type CborValue,
} from "../cbor/index.ts";
import { base64UrlEncode, base64UrlDecode } from "../base64url.ts";

/** COSE algorithm identifier for EdDSA (pure Ed25519). */
export const COSE_ALG_EDDSA = -8;

/** COSE header label for the algorithm id. */
const COSE_HEADER_ALG = 1;
/** COSE header label for the key id. */
const COSE_HEADER_KID = 4;

/** Ed25519 public key length in bytes (raw). */
export const ED25519_PUB_KEY_BYTES = 32;
/** Ed25519 signature length in bytes. */
export const ED25519_SIG_BYTES = 64;

/** A decoded COSE_Sign1 message: the four wire fields. */
export interface CoseSign1 {
  /** Serialized CBOR protected header (carried verbatim as bytes). */
  readonly protectedBytes: Uint8Array;
  /** Unprotected header map (empty for receipts — kept for wire fidelity). */
  readonly unprotected: { readonly [key: string]: CborValue };
  /** Payload bytes; may be empty when transported detached. */
  readonly payload: Uint8Array;
  readonly signature: Uint8Array;
}

/** Options for creating a COSE_Sign1 message. */
export interface CoseSign1Options {
  /** Key id placed in the protected header (`kid`). */
  readonly kid?: string;
  /** Additional protected header entries (string keys only). */
  readonly extraProtected?: { readonly [key: string]: CborValue };
  /** Additional application data bound into the signature. */
  readonly externalAad?: Uint8Array;
}

/** A verification key: raw 32-byte Ed25519 public key. */
export interface CoseVerifyKey {
  readonly kid: string;
  readonly publicKey: Uint8Array;
}

function importEd25519VerifyKey(rawPublicKey: Uint8Array): Promise<CryptoKey> {
  if (rawPublicKey.length !== ED25519_PUB_KEY_BYTES) {
    return Promise.reject(
      new Error(`cose: public key must be ${ED25519_PUB_KEY_BYTES} bytes`),
    );
  }
  return crypto.subtle.importKey(
    "raw",
    rawPublicKey.slice(),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

/**
 * Import an Ed25519 private signing key from a raw 32-byte seed.
 * (The seed is the secret scalar of RFC 8032; PKCS#8 wrapping is handled by
 * callers that store keys in PEM form.)
 */
export async function importEd25519PrivateKeySeed(
  seed: Uint8Array,
): Promise<CryptoKey> {
  if (seed.length !== 32) {
    throw new Error("cose: Ed25519 seed must be 32 bytes");
  }
  // WebCrypto imports Ed25519 private keys as PKCS#8; wrap the raw seed with
  // the fixed prefix (RFC 8410, id-EdDSA 1.3.101.112).
  const prefix = hexToBytes("302e020100300506032b657004220420");
  const pkcs8 = new Uint8Array(prefix.length + seed.length);
  pkcs8.set(prefix, 0);
  pkcs8.set(seed, prefix.length);
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
}

/**
 * Export the raw 32-byte public key belonging to an Ed25519 private key.
 * WebCrypto cannot export `raw` from a private CryptoKey, so the key is
 * exported as JWK (which carries the public `x` coordinate) and re-encoded.
 */
export async function exportEd25519RawPublicKey(
  privateKey: CryptoKey,
): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  return jwkToEd25519RawKey(jwk);
}

/** Build the CBOR protected header bytes for a Sign1 message. */
function encodeProtectedHeader(options: CoseSign1Options): Uint8Array {
  // RFC 9052 header labels are integers: 1 = alg, 4 = kid.
  const entries: (readonly [number | string, CborValue])[] = [
    [COSE_HEADER_ALG, COSE_ALG_EDDSA],
  ];
  if (options.kid !== undefined) entries.push([COSE_HEADER_KID, options.kid]);
  if (options.extraProtected !== undefined) {
    for (const [k, v] of Object.entries(options.extraProtected)) {
      entries.push([k, v]);
    }
  }
  return cborEncode(cborMap(entries));
}

/** Build the Sig_structure for RFC 9052 §4.4 and encode it. */
function encodeSigStructure(
  protectedBytes: Uint8Array,
  externalAad: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  return cborEncode([
    "Signature1",
    protectedBytes,
    externalAad,
    payload,
  ] as CborValue[]);
}

/**
 * Create a COSE_Sign1 message over `payload` with an Ed25519 private key.
 * Returns the four wire fields; use {@link cborEncodeSign1} for the wire form.
 */
export async function coseSign1(
  privateKey: CryptoKey,
  payload: Uint8Array,
  options: CoseSign1Options = {},
): Promise<CoseSign1> {
  const protectedBytes = encodeProtectedHeader(options);
  const externalAad = options.externalAad ?? new Uint8Array(0);
  const toBeSigned = encodeSigStructure(protectedBytes, externalAad, payload);
  const sig = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    toBeSigned.slice(),
  );
  return {
    protectedBytes,
    unprotected: {},
    payload,
    signature: new Uint8Array(sig),
  };
}

/**
 * Verify a COSE_Sign1 message against a raw Ed25519 public key.
 * Returns false (never throws) for any structural or signature failure.
 */
export async function coseSign1Verify(
  message: CoseSign1,
  publicKey: Uint8Array,
  externalAad: Uint8Array = new Uint8Array(0),
): Promise<boolean> {
  try {
    if (message.signature.length !== ED25519_SIG_BYTES) return false;
    const key = await importEd25519VerifyKey(publicKey);
    const toBeSigned = encodeSigStructure(
      message.protectedBytes,
      externalAad,
      message.payload,
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      message.signature.slice(),
      toBeSigned.slice(),
    );
  } catch {
    return false;
  }
}

/** Encode a CoseSign1 as the RFC 9052 4-element CBOR array. */
export function cborEncodeSign1(message: CoseSign1): Uint8Array {
  return cborEncode([
    message.protectedBytes,
    message.unprotected,
    // Tag 24: payload is a byte string containing embedded CBOR; the payload
    // itself stays opaque bytes here (detached transport keeps it separate).
    message.payload,
    message.signature,
  ] as CborValue[]);
}

/** Decode the RFC 9052 4-element CBOR array into a CoseSign1. */
export function cborDecodeSign1(bytes: Uint8Array): CoseSign1 {
  return decodeSign1Array(bytes);
}

function decodeSign1Array(bytes: Uint8Array): CoseSign1 {
  const v = cborDecode(bytes);
  if (!Array.isArray(v) || v.length !== 4) {
    throw new Error("cose: Sign1 must be a 4-element array");
  }
  const [prot, unp, payload, signature] = v as [
    CborValue,
    CborValue,
    CborValue,
    CborValue,
  ];
  if (!(prot instanceof Uint8Array)) {
    throw new Error("cose: protected header must be a byte string");
  }
  if (
    unp === null ||
    typeof unp !== "object" ||
    unp instanceof Uint8Array ||
    Array.isArray(unp) ||
    "tag" in unp
  ) {
    throw new Error("cose: unprotected header must be a map");
  }
  if (!(payload instanceof Uint8Array)) {
    throw new Error("cose: payload must be a byte string");
  }
  if (!(signature instanceof Uint8Array)) {
    throw new Error("cose: signature must be a byte string");
  }
  return {
    protectedBytes: prot,
    unprotected: unp as { readonly [key: string]: CborValue },
    payload,
    signature,
  };
}

/** Parse the protected header of a Sign1 message back into its fields. */
export function decodeProtectedHeader(
  protectedBytes: Uint8Array,
): { alg: number; kid?: string; rest: (readonly [string | number, CborValue])[] } {
  if (protectedBytes.length === 0) {
    throw new Error("cose: protected header missing");
  }
  const v = cborDecode(protectedBytes);
  if (
    v === null ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    v instanceof Uint8Array ||
    "tag" in v
  ) {
    throw new Error("cose: protected header is not a map");
  }
  const pairs: readonly (readonly [string | number, CborValue])[] =
    "entries" in v
      ? (v as unknown as CborMap).entries
      : Object.entries(v).map(([k, val]) => [k, val] as const);
  let alg: number | undefined;
  let kid: string | undefined;
  const rest: (readonly [string | number, CborValue])[] = [];
  for (const [k, val] of pairs) {
    if (k === COSE_HEADER_ALG) alg = typeof val === "number" ? val : undefined;
    else if (k === COSE_HEADER_KID && typeof val === "string") kid = val;
    else rest.push([k, val]);
  }
  if (alg === undefined) {
    throw new Error("cose: protected header missing alg");
  }
  return { alg, ...(kid !== undefined ? { kid } : {}), rest };
}

/** An OKP/Ed25519 public JWK (RFC 8037) with the fields we always emit. */
export type Ed25519PublicJwk = JsonWebKey & {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "EdDSA";
  kid: string;
};

/** Convert a raw Ed25519 public key to a JWK (RFC 8037, OKP/Ed25519). */
export function ed25519RawKeyToJwk(
  publicKey: Uint8Array,
  kid: string,
): Ed25519PublicJwk {
  if (publicKey.length !== ED25519_PUB_KEY_BYTES) {
    throw new Error("cose: Ed25519 public key must be 32 bytes");
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: base64UrlEncode(publicKey),
    alg: "EdDSA",
    kid,
    ext: true,
  };
}

/** Convert a JWK (OKP/Ed25519) back to a raw 32-byte public key. */
export function jwkToEd25519RawKey(jwk: JsonWebKey): Uint8Array {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("cose: not an OKP/Ed25519 public JWK");
  }
  const raw = base64UrlDecode(jwk.x);
  if (raw.length !== ED25519_PUB_KEY_BYTES) {
    throw new Error("cose: JWK x must decode to 32 bytes");
  }
  return raw;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
