// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the transaction JWKS route (Req 7.11):
 * GET /.well-known/atf-transaction-jwks.json
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
} from "jose";
import { TransactionTokenIssuer } from "../../transaction/token.js";
import { createTransactionJwksRouter } from "../transaction-jwks.js";

const JWKS_PATH = "/.well-known/atf-transaction-jwks.json";

// Bun's jose generateKeyPair() returns non-extractable CryptoKeys, so PKCS8
// PEM fixtures come from node:crypto instead.
function pem(alg: "ES256" | "EdDSA"): string {
  return alg === "ES256"
    ? generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey.toString()
    : generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey.toString();
}

describe("GET /.well-known/atf-transaction-jwks.json", () => {
  test("empty key set when transaction signing is not configured", async () => {
    const res = await createTransactionJwksRouter({ env: {} }).request(
      JWKS_PATH,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: [] });
  });

  test("empty key set in HS256 mode (no public key to publish)", async () => {
    const res = await createTransactionJwksRouter({
      env: { AGENT_TRANSACTION_SECRET: "0".repeat(32) },
    }).request(JWKS_PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keys: [] });
  });

  test("publishes the ES256 public JWK with kid/alg/use", async () => {
    const keyPem = pem("ES256");
    const res = await createTransactionJwksRouter({
      env: { TRANSACTION_SIGNING_ALG: "ES256", TRANSACTION_SIGNING_KEY: keyPem },
    }).request(JWKS_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("max-age");
    const body = (await res.json()) as {
      keys: Record<string, string | undefined>[];
    };
    expect(body.keys).toHaveLength(1);
    const jwk = body.keys[0];
    expect(jwk?.kty).toBe("EC");
    expect(jwk?.crv).toBe("P-256");
    expect(typeof jwk?.x).toBe("string");
    expect(typeof jwk?.y).toBe("string");
    expect(jwk?.alg).toBe("ES256");
    expect(jwk?.use).toBe("sig");
    // The kid must match the thumbprint of the published public key.
    const thumbprint = await calculateJwkThumbprint({
      kty: "EC",
      crv: "P-256",
      x: jwk?.x ?? "",
      y: jwk?.y ?? "",
    });
    expect(jwk?.kid).toBe(thumbprint);
  });

  test("never leaks private key members (d/k/p/q/dp/dq/qi)", async () => {
    for (const alg of ["ES256", "EdDSA"] as const) {
      const res = await createTransactionJwksRouter({
        env: {
          TRANSACTION_SIGNING_ALG: alg,
          TRANSACTION_SIGNING_KEY: pem(alg),
        },
      }).request(JWKS_PATH);
      const body = (await res.json()) as { keys: Record<string, unknown>[] };
      expect(body.keys).toHaveLength(1);
      const jwk = body.keys[0] ?? {};
      for (const secret of ["d", "k", "p", "q", "dp", "dq", "qi"]) {
        expect(jwk[secret]).toBeUndefined();
      }
    }
  });

  test("EdDSA publishes an OKP key", async () => {
    const res = await createTransactionJwksRouter({
      env: {
        TRANSACTION_SIGNING_ALG: "EdDSA",
        TRANSACTION_SIGNING_KEY: pem("EdDSA"),
      },
    }).request(JWKS_PATH);
    const body = (await res.json()) as { keys: Record<string, string>[] };
    expect(body.keys[0]?.kty).toBe("OKP");
    expect(body.keys[0]?.crv).toBe("Ed25519");
    expect(body.keys[0]?.alg).toBe("EdDSA");
  });

  test("invalid PEM fails closed with 500 instead of a partial key set", async () => {
    const res = await createTransactionJwksRouter({
      env: {
        TRANSACTION_SIGNING_ALG: "ES256",
        TRANSACTION_SIGNING_KEY: "not a pem",
      },
    }).request(JWKS_PATH);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("transaction_jwks_unavailable");
  });

  test("published JWK verifies a token issued by TransactionTokenIssuer", async () => {
    const keyPem = pem("ES256");
    const envelope = {
      executionId: "exec-1",
      invocationId: "inv-1",
      scopes: [],
      groups: [],
      budget: { maxToolCalls: 1, maxRetrievalDocuments: 1 },
      delegationChain: [],
      trace: { traceId: "t", deadlineAt: Date.now() + 10_000 },
    };
    const token = await new TransactionTokenIssuer(
      {
        issuer: "aiperator",
        audience: "peer",
        alg: "ES256",
        signingKeyPem: keyPem,
      },
      () => 1_700_000_000_000,
    ).issue(envelope);
    const res = await createTransactionJwksRouter({
      env: { TRANSACTION_SIGNING_ALG: "ES256", TRANSACTION_SIGNING_KEY: keyPem },
    }).request(JWKS_PATH);
    const body = (await res.json()) as { keys: Record<string, string>[] };
    const published = body.keys[0] ?? {};
    // The token header kid must equal the published kid — this is how the
    // Gate (createRemoteJWKSet) selects the verification key.
    expect(decodeProtectedHeader(token).kid).toBe(published["kid"]);
    // And the published JWK (public-only) imports and verifies the token.
    const pubKey = await importJWK(
      { kty: "EC", crv: "P-256", x: published["x"] ?? "", y: published["y"] ?? "" },
      "ES256",
    );
    const { payload } = await jwtVerify(token, pubKey, {
      issuer: "aiperator",
      audience: "peer",
      algorithms: ["ES256"],
      // The issuer was constructed with a fixed clock, so verification must
      // use the same reference date or the short TTL would appear expired.
      currentDate: new Date(1_700_000_000_000),
    });
    expect(payload.invocationId).toBe("inv-1");
  });
});
