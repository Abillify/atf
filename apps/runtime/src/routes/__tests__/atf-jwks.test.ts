// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The combined public JWKS lists every published signing key with its purpose
 * and leaves the per-purpose endpoints alone.
 */
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import type { JSONWebKeySet } from "jose";
import { createAtfJwksRouter } from "../atf-jwks.js";
import { createEvidenceJwksRouter } from "../evidence-jwks.js";
import { parseEvidenceSigningKey } from "../../observability/evidence-key.js";
import { parseReceiptSigningKey } from "../../receipts/signing-key.js";

const seed = (n: number): string =>
  Buffer.from(Array.from({ length: 32 }, (_, i) => i + n)).toString("base64");

type Entry = { kid: string; alg: string; use: string; atf_purpose: string; kty: string; d?: string };
const fetchKeys = async (app: Hono): Promise<{ status: number; keys: Entry[]; cache: string | null }> => {
  const res = await app.request("/.well-known/atf-jwks.json");
  const body = (await res.json()) as { keys?: Entry[] };
  return { status: res.status, keys: body.keys ?? [], cache: res.headers.get("Cache-Control") };
};

describe("GET /.well-known/atf-jwks.json", () => {
  it("lists every key with kid, alg, use and its purpose", async () => {
    const evidence = parseEvidenceSigningKey(seed(1));
    const erasure = parseEvidenceSigningKey(seed(50));
    const receipt = await parseReceiptSigningKey(seed(100));
    if (!evidence || !erasure || !receipt) throw new Error("expected keys");
    const transaction: JSONWebKeySet = {
      keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "tx-1", alg: "ES256", use: "sig" }],
    };
    const app = new Hono().route(
      "/",
      createAtfJwksRouter({
        evidenceKey: evidence,
        erasureKey: erasure,
        receiptKey: receipt,
        transactionJwks: async () => transaction,
      }),
    );
    const { status, keys, cache } = await fetchKeys(app);
    expect(status).toBe(200);
    expect(cache).toContain("public");
    expect(keys.map((k) => k.atf_purpose)).toEqual([
      "evidence",
      "erasure-receipt",
      "decision-receipt",
      "transaction",
    ]);
    expect(keys.find((k) => k.atf_purpose === "evidence")).toMatchObject({
      kid: evidence.kid,
      alg: "EdDSA",
      use: "sig",
      kty: "OKP",
    });
    expect(keys.find((k) => k.atf_purpose === "decision-receipt")?.kid).toBe(receipt.kid);
    expect(keys.find((k) => k.atf_purpose === "transaction")).toMatchObject({
      kid: "tx-1",
      alg: "ES256",
      use: "sig",
    });
    for (const key of keys) expect(key).not.toHaveProperty("d");
  });

  it("does not merge keys: a key shared by two purposes appears once per purpose", async () => {
    const shared = parseEvidenceSigningKey(seed(7));
    if (!shared) throw new Error("expected a key");
    const app = new Hono().route("/", createAtfJwksRouter({ evidenceKey: shared, erasureKey: shared }));
    const { keys } = await fetchKeys(app);
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.kid)).toEqual([shared.kid, shared.kid]);
    expect(keys.map((k) => k.atf_purpose)).toEqual(["evidence", "erasure-receipt"]);
  });

  it("leaves the per-purpose endpoint unchanged", async () => {
    const key = parseEvidenceSigningKey(seed(3));
    if (!key) throw new Error("expected a key");
    const app = new Hono().route("/", createEvidenceJwksRouter(key));
    const res = await app.request("/.well-known/atf-evidence-jwks.json");
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys[0]).not.toHaveProperty("atf_purpose");
  });

  it("serves an empty set when nothing is configured (HS256 transaction mode)", async () => {
    const app = new Hono().route(
      "/",
      createAtfJwksRouter({ transactionJwks: async () => ({ keys: [] }) }),
    );
    expect((await fetchKeys(app)).keys).toEqual([]);
    expect((await fetchKeys(new Hono().route("/", createAtfJwksRouter({})))).keys).toEqual([]);
  });

  it("fails closed when the transaction key source fails", async () => {
    const evidence = parseEvidenceSigningKey(seed(9));
    const app = new Hono().route(
      "/",
      createAtfJwksRouter({
        evidenceKey: evidence,
        transactionJwks: async () => {
          throw new Error("bad key");
        },
      }),
    );
    const res = await app.request("/.well-known/atf-jwks.json");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "atf_jwks_unavailable" });
  });

  it("publishes a real ES256 transaction key via the shared source", async () => {
    const { createTransactionJwksSource } = await import("../transaction-jwks.js");
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const source = createTransactionJwksSource({
      env: { TRANSACTION_SIGNING_ALG: "ES256", TRANSACTION_SIGNING_KEY: pem },
    });
    const app = new Hono().route("/", createAtfJwksRouter({ transactionJwks: source }));
    const { keys } = await fetchKeys(app);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ atf_purpose: "transaction", alg: "ES256", use: "sig", kty: "EC" });
    expect(keys[0]).not.toHaveProperty("d");
  });
});
