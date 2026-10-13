// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Public JWKS for Decision_Receipt verification (Req 15.4). Unauthenticated —
 * public key material only, same convention as `transaction-jwks.ts`. When
 * receipts are disabled there is no key to publish, so the router is not
 * mounted at all.
 */

import { Hono } from "hono";
import type { ReceiptSigningKey } from "../receipts/signing-key.js";

export function createReceiptJwksRouter(
  signingKey: ReceiptSigningKey,
): Hono {
  const router = new Hono();
  router.get("/.well-known/atf-receipt-jwks.json", (ctx) => {
    return ctx.json(
      {
        keys: [
          {
            ...signingKey.jwk,
            kid: signingKey.kid,
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
