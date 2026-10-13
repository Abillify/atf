// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/security-kit/browser
 *
 * Browser-safe surface: the base64url codec (TextEncoder/TextDecoder only)
 * plus the CBOR codec and COSE_Sign1 verification, which use only WebCrypto
 * (`crypto.subtle`) — needed by the Control trace viewer to verify decision
 * receipts client-side. Deliberately does NOT re-export the Node-only modules
 * (compare, egress, jwt, rate-limit, prod-gate) so a bundler can never pull
 * `node:crypto` into a client bundle through this entry point.
 */

export {
  base64UrlEncode,
  base64UrlEncodePadded,
  base64UrlDecode,
  base64UrlDecodeToString,
  base64UrlEncodeString,
} from "./base64url.ts";
export {
  cborEncode,
  cborDecode,
  cborTagged,
  cborMap,
  CborEncodeError,
  CborDecodeError,
  type CborValue,
  type CborTagged,
  type CborMap,
} from "./cbor/index.ts";
export {
  COSE_ALG_EDDSA,
  ED25519_PUB_KEY_BYTES,
  ED25519_SIG_BYTES,
  coseSign1,
  coseSign1Verify,
  cborEncodeSign1,
  cborDecodeSign1,
  decodeProtectedHeader,
  ed25519RawKeyToJwk,
  jwkToEd25519RawKey,
  type CoseSign1,
  type CoseSign1Options,
} from "./cose/index.ts";
