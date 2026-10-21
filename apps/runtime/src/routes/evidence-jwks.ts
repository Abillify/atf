// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Public JWKS for evidence-chain verification (ADR 0030). Unauthenticated —
 * public key material only, same convention as `receipt-jwks.ts`. This JWKS
 * publishes the evidence key and, when `ERASURE_RECEIPT_SIGNING_KEY` is set,
 * that key too, so every Ed25519 artefact of the evidence chain — audit
 * anchors, Evidence Bundles, and Erasure Receipts — verifies against this
 * JWKS alone, by its `kid`. Keys are deduplicated by `kid` (the evidence key
 * and the erasure key are often the same key). When no key exists (no
 * `EVIDENCE_SIGNING_KEY` and no `ERASURE_RECEIPT_SIGNING_KEY`) there is
 * nothing to publish and the router is not mounted.
 */

import { Hono } from "hono";
import type { Ed25519EvidenceKey } from "../observability/evidence-key.js";

export function createEvidenceJwksRouter(
  evidenceKey: Ed25519EvidenceKey | undefined,
  extraKeys: readonly Ed25519EvidenceKey[] = [],
): Hono {
  const keys = [evidenceKey, ...extraKeys].filter((k) => k !== undefined);
  const byKid = new Map(keys.map((k) => [k.kid, k]));
  const router = new Hono();
  router.get("/.well-known/atf-evidence-jwks.json", (ctx) => {
    return ctx.json(
      {
        keys: [...byKid.values()].map((key) => ({
          ...key.jwk,
          kid: key.kid,
          alg: "EdDSA",
          use: "sig",
          ext: true,
        })),
      },
      200,
      { "Cache-Control": "public, max-age=300" },
    );
  });
  return router;
}
