// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Erasure_Receipt (Req 2.11): a signed proof of what was forgotten, when and
 * how much of it — without repeating any personal data.
 *
 * The payload follows `@atf/erasure-contract` (`ErasureReceiptPayloadSchema`):
 * the subject appears only as `sha256(tenantId + "|" + identifier)`. The byte
 * source for signing is the canonical JSON form (recursively sorted keys).
 *
 * Signing algorithm (design.md §Erasure): Ed25519, precedence
 * `ERASURE_RECEIPT_SIGNING_KEY` → `EVIDENCE_SIGNING_KEY` → the audit-anchor
 * HMAC secret (`AUDIT_ANCHOR_SECRET`) as documented fallback. The algorithm
 * is recorded in the envelope's `alg` field and, for Ed25519, the key id
 * (`kid`, the SHA-256 thumbprint of the public key) in the envelope's `kid`
 * field — both outside the payload, so the payload stays byte-stable across
 * key rotations.
 */

import {
  createHmac,
  type createPrivateKey,
  sign,
  verify,
  timingSafeEqual,
} from "node:crypto";
import { randomUUID } from "node:crypto";

import {
  canonicalizeJson,
  erasureSubjectHash,
  ERASURE_RECEIPT_TYPE,
  ErasureReceiptPayloadSchema,
  type ErasureReceiptPayload,
} from "@atf/erasure-contract";

import { parseEvidenceSigningKey } from "../observability/evidence-key.js";
import type { ErasureOperation } from "./erasure-orchestrator.js";

/** Algorithm recorded in the signed envelope (not in the payload). */
export type ErasureReceiptAlg = "Ed25519" | "HS256";

/** A parsed signing key: Ed25519 private key or the audit-anchor HMAC secret. */
export type ErasureReceiptKey =
  | {
      readonly alg: "Ed25519";
      readonly key: ReturnType<typeof createPrivateKey>;
      /** base64url SHA-256 thumbprint of the public key (the envelope `kid`). */
      readonly kid: string;
    }
  | { readonly alg: "HS256"; readonly secret: string };

/** The signed envelope persisted with the operation and served by the API. */
export interface ErasureReceiptEnvelope {
  readonly typ: typeof ERASURE_RECEIPT_TYPE;
  readonly alg: ErasureReceiptAlg;
  /**
   * Key id (SHA-256 thumbprint) of the Ed25519 signing key, published in the
   * evidence JWKS. Absent for HS256. Outside `payload`, so payload bytes stay
   * stable across key rotations.
   */
  readonly kid?: string;
  readonly payload: ErasureReceiptPayload;
  /** base64url signature over the canonical JSON bytes of `payload`. */
  readonly signature: string;
}

/**
 * Parse the configured signing key. Accepts a PEM private key or a raw
 * base64-encoded 32-byte Ed25519 seed — the same formats as
 * `EVIDENCE_SIGNING_KEY`, parsed by the same code so the `kid` thumbprint is
 * computed identically. Returns `undefined` when no key is configured; the
 * caller may then fall back to {@link hmacReceiptKey}.
 */
export function ed25519ReceiptKey(value: string | undefined): ErasureReceiptKey | undefined {
  const parsed = parseEvidenceSigningKey(value);
  if (parsed === undefined) return undefined;
  return { alg: "Ed25519", key: parsed.privateKey, kid: parsed.kid };
}

/** Documented fallback: audit-anchor HMAC (Req 2.11, design.md). */
export function hmacReceiptKey(secret: string | undefined): ErasureReceiptKey | undefined {
  if (secret === undefined || secret.length === 0) return undefined;
  return { alg: "HS256", secret };
}

/**
 * Subject identifiers of an operation: userId, email and every external id —
 * never the tenant-wide scope (whose hashes would be empty by contract).
 */
function subjectHashes(operation: ErasureOperation): string[] {
  if (operation.scope === "tenant") return [];
  const subject = operation.subject;
  if (subject === undefined) return [];
  const identifiers = [
    ...(subject.userId !== undefined ? [subject.userId] : []),
    ...(subject.email !== undefined ? [subject.email] : []),
    ...subject.externalIds,
  ];
  return [
    ...new Set(identifiers.map((id) => erasureSubjectHash(operation.tenantId, id))),
  ];
}

/**
 * Build the receipt payload for a completed operation. Returns `undefined`
 * when there is nothing to attest (no store results) — a receipt always
 * carries at least one per-store result.
 */
export function buildReceiptPayload(
  operation: ErasureOperation,
  completedAt: string = new Date().toISOString(),
): ErasureReceiptPayload | undefined {
  if (operation.results.length === 0) return undefined;
  return ErasureReceiptPayloadSchema.parse({
    receiptId: randomUUID(),
    requestId: operation.requestId,
    tenantId: operation.tenantId,
    scope: operation.scope,
    subjectHashes: subjectHashes(operation),
    completedAt,
    results: operation.results,
    // A failed operation never yields a receipt; `partial` covers both a
    // partial success and (defensively) a total failure.
    status: operation.status === "complete" ? "complete" : "partial",
  });
}

/** Sign the canonical JSON bytes of the payload with the given key. */
export function signReceipt(
  payload: ErasureReceiptPayload,
  key: ErasureReceiptKey,
): ErasureReceiptEnvelope {
  const bytes = Buffer.from(canonicalizeJson(payload), "utf8");
  const signature =
    key.alg === "Ed25519"
      ? sign(null, bytes, key.key)
      : createHmac("sha256", key.secret).update(bytes).digest();
  return {
    typ: ERASURE_RECEIPT_TYPE,
    alg: key.alg,
    ...(key.alg === "Ed25519" ? { kid: key.kid } : {}),
    payload,
    signature: signature.toString("base64url"),
  };
}

/**
 * Verify a receipt envelope. Any bit change in the payload or the signature
 * yields `false` (Property 5). The key must match the envelope's `alg`.
 */
export function verifyReceipt(
  envelope: ErasureReceiptEnvelope,
  key: ErasureReceiptKey,
): boolean {
  if (envelope.typ !== ERASURE_RECEIPT_TYPE) return false;
  if (envelope.alg !== key.alg) return false;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(canonicalizeJson(envelope.payload), "utf8");
  } catch {
    return false;
  }
  const signature = Buffer.from(envelope.signature, "base64url");
  if (key.alg === "Ed25519") {
    try {
      return verify(null, bytes, key.key, signature);
    } catch {
      return false;
    }
  }
  const expected = createHmac("sha256", key.secret).update(bytes).digest();
  return expected.length === signature.length && timingSafeEqual(expected, signature);
}

/** Build and sign a receipt for a completed operation in one step. */
export function createSignedReceipt(
  operation: ErasureOperation,
  key: ErasureReceiptKey,
  completedAt?: string,
): ErasureReceiptEnvelope | undefined {
  const payload = buildReceiptPayload(operation, completedAt);
  if (payload === undefined) return undefined;
  return signReceipt(payload, key);
}
