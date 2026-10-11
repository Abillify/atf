// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Transaction JWKS Route (`src/routes/transaction-jwks.ts`)
 *
 * Publishes the public verification key for asymmetrically signed
 * transaction tokens (Requirement 7.11):
 *
 *   GET /.well-known/atf-transaction-jwks.json
 *
 * When the runtime is configured with `TRANSACTION_SIGNING_ALG=ES256|EdDSA`
 * and a PKCS8 key in `TRANSACTION_SIGNING_KEY`, the route serves the
 * corresponding public JWK (with `kid`, `alg`, `use`). Verifiers — e.g. the
 * Gate via `MCPGATE_TRANSACTION_JWKS_URI` — resolve the key without ever
 * holding a shared secret.
 *
 * In HS256 mode (the default) there is no public key to publish, so the
 * route returns an empty key set `{"keys":[]}` rather than 404 — verifiers
 * can poll it uniformly and fall back to their configured secret.
 *
 * The route is intentionally unauthenticated: it only ever exposes public
 * key material. Runtime auth middleware guards `/v1/*` and `/mcp` only.
 *
 * Requirements: 7.11
 */

import { Hono } from "hono";
import type { JSONWebKeySet } from "jose";
import {
  isTransactionSigningAlg,
  transactionPublicJwk,
  transactionTokenConfigFromEnv,
} from "../transaction/token.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface TransactionJwksRouterOptions {
  env?: Record<string, string | undefined>;
}

export function createTransactionJwksRouter(
  options: TransactionJwksRouterOptions = {},
): Hono {
  const app = new Hono();
  // Cache the derived JWK set per (alg, PEM) so repeated polls do not
  // re-import the key on every request.
  let cacheKey: string | undefined;
  let cached: Promise<JSONWebKeySet> | undefined;

  const jwks = async (
    env: Record<string, string | undefined>,
  ): Promise<JSONWebKeySet> => {
    const config = transactionTokenConfigFromEnv(env);
    const alg = config?.alg ?? "HS256";
    if (alg === "HS256" || !isTransactionSigningAlg(alg)) {
      return { keys: [] };
    }
    const pem = config?.signingKeyPem ?? "";
    const key = `${alg}:${pem}`;
    if (cacheKey !== key || cached === undefined) {
      cacheKey = key;
      cached = (async () => {
        // transactionPublicJwk derives the public members via node:crypto —
        // jose's exportJWK fails on Bun's non-extractable imported keys.
        const { jwk: publicJwk, kid } = await transactionPublicJwk(pem, alg);
        return {
          keys: [
            {
              ...publicJwk,
              kid,
              alg,
              use: "sig",
              ext: true,
            },
          ],
        } as JSONWebKeySet;
      })();
    }
    return cached;
  };

  app.get("/.well-known/atf-transaction-jwks.json", async (c) => {
    const env = options.env ?? process.env;
    let set: JSONWebKeySet;
    try {
      set = await jwks(env);
    } catch (error) {
      // Fail closed: never serve a partial or guessed key set.
      return c.json(
        {
          error: "transaction_jwks_unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
    return c.json(set, 200, { "Cache-Control": "public, max-age=300" });
  });

  return app;
}
