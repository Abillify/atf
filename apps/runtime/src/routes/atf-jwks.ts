// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Combined public JWKS (`GET /.well-known/atf-jwks.json`): every public signing
 * key the Runtime publishes, with the purpose it signs for, so a verifier can
 * be configured with one URL.
 *
 * Each key carries `kid`, `alg`, `use: "sig"` and `atf_purpose`:
 *
 *   evidence          audit anchors and Evidence Bundles (EVIDENCE_SIGNING_KEY)
 *   erasure-receipt   Erasure Receipts (ERASURE_RECEIPT_SIGNING_KEY)
 *   decision-receipt  Decision_Receipts (RECEIPT_SIGNING_KEY)
 *   transaction       transaction tokens (TRANSACTION_SIGNING_ALG ES256|EdDSA)
 *
 * The per-purpose endpoints (`atf-evidence-jwks.json`, `atf-receipt-jwks.json`,
 * `atf-transaction-jwks.json`) stay unchanged. Keys are NOT merged: when two
 * purposes share one key, it appears once per purpose, so a verifier that
 * selects by `kid` finds the same key and one that selects by purpose finds
 * the entry it needs. Unauthenticated — public key material only. A failing
 * transaction key source fails the whole response: a partial set could make a
 * verifier believe a key is not published.
 */

import { Hono } from "hono";
import type { JSONWebKeySet } from "jose";
import type { Ed25519EvidenceKey } from "../observability/evidence-key.js";
import type { ReceiptSigningKey } from "../receipts/signing-key.js";

export type AtfKeyPurpose =
  | "evidence"
  | "erasure-receipt"
  | "decision-receipt"
  | "transaction";

export interface AtfJwksSources {
  evidenceKey?: Ed25519EvidenceKey | undefined;
  erasureKey?: Ed25519EvidenceKey | undefined;
  receiptKey?: ReceiptSigningKey | undefined;
  /** The transaction key set (see `createTransactionJwksSource`). */
  transactionJwks?: (() => Promise<JSONWebKeySet>) | undefined;
}

type PublicKey = Record<string, unknown>;

function ed25519Entry(
  key: { jwk: object; kid: string },
  purpose: AtfKeyPurpose,
): PublicKey {
  return {
    ...key.jwk,
    kid: key.kid,
    alg: "EdDSA",
    use: "sig",
    ext: true,
    atf_purpose: purpose,
  };
}

export function createAtfJwksRouter(sources: AtfJwksSources): Hono {
  const router = new Hono();
  router.get("/.well-known/atf-jwks.json", async (ctx) => {
    const keys: PublicKey[] = [];
    if (sources.evidenceKey !== undefined) keys.push(ed25519Entry(sources.evidenceKey, "evidence"));
    if (sources.erasureKey !== undefined) keys.push(ed25519Entry(sources.erasureKey, "erasure-receipt"));
    if (sources.receiptKey !== undefined) keys.push(ed25519Entry(sources.receiptKey, "decision-receipt"));
    if (sources.transactionJwks !== undefined) {
      try {
        const set = await sources.transactionJwks();
        for (const key of set.keys) keys.push({ ...key, atf_purpose: "transaction" });
      } catch (error) {
        // Fail closed: never serve a partial key set.
        return ctx.json(
          {
            error: "atf_jwks_unavailable",
            message: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
    }
    return ctx.json({ keys }, 200, { "Cache-Control": "public, max-age=300" });
  });
  return router;
}
