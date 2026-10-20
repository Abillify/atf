// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Public JWKS for evidence-chain verification (ADR 0030). Unauthenticated —
 * public key material only, same convention as `receipt-jwks.ts`. The key
 * published here verifies Ed25519 audit anchors, Evidence Bundles, and
 * Erasure Receipts, so an auditor or regulator needs NOTHING but this JWKS
 * to check the chain offline. When no `EVIDENCE_SIGNING_KEY` is configured
 * there is no asymmetric key to publish and the router is not mounted.
 */

import { Hono } from "hono";
import type { Ed25519EvidenceKey } from "../observability/evidence-key.js";

export function createEvidenceJwksRouter(
  evidenceKey: Ed25519EvidenceKey,
): Hono {
  const router = new Hono();
  router.get("/.well-known/atf-evidence-jwks.json", (ctx) => {
    return ctx.json(
      {
        keys: [
          {
            ...evidenceKey.jwk,
            kid: evidenceKey.kid,
            alg: "EdDSA",
            use: "sig",
            ext: true,
          },
        ],
      },
      200,
      { "Cache-Control": "public, max-age=300" },
    );
  });
  return router;
}
