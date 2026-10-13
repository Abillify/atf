// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { base64UrlDecode } from "@atf/security-kit";
import {
  AUTH_PRINCIPAL_KEY,
  TOKEN_KEY,
  type AuthContext,
  type AuthPrincipal,
} from "../../middleware/auth.js";
import { createReceiptJwksRouter } from "../receipt-jwks.js";
import { createReceiptsRouter } from "../receipts.js";
import { InMemoryReceiptStore } from "../../receipts/receipt-store.js";
import {
  InMemoryTransparencyLog,
  verifyReceiptInclusion,
} from "../../receipts/transparency-log.js";
import { parseReceiptSigningKey } from "../../receipts/signing-key.js";
import { signReceiptPayload } from "../../receipts/receipt-builder.js";
import type {
  DecisionReceiptPayload,
  SignedDecisionReceipt,
} from "../../receipts/types.js";

// A fixed 32-byte Ed25519 seed (base64) so the kid is deterministic.
const SEED_B64 = Buffer.alloc(32, 7).toString("base64");

function fixturePayload(
  receiptId: string,
  tenantId: string,
): DecisionReceiptPayload {
  return {
    receipt_id: receiptId,
    typ: "atf.decision-receipt",
    version: 1,
    kind: "chat_completion",
    parent_receipt_id: null,
    execution_id: `exec-${receiptId}`,
    tenant_id: tenantId,
    flow_id: "flows/test",
    flow_version: "1.0.0",
    status: "completed",
    policy_hashes: {
      prompt_template: null,
      tool_authz: "atf:tool-authz:noop",
      compliance: "atf:compliance:none",
    },
    models: [{ model: "openai/gpt-4o", provider: "openai" }],
    pii: null,
    retrieval_sources: [],
    approvals: [],
    tool_calls: [],
    cost: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      usd: 0.01,
    },
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:01.000Z",
    response_hash: "a".repeat(64),
  };
}

interface PrincipalFixture {
  verified?: boolean;
  tenantId?: string;
}

/** Mounts the receipts router behind a stand-in for the auth middleware. */
function appWith(
  store: InMemoryReceiptStore,
  transparencyLog?: InMemoryTransparencyLog,
  fixture: PrincipalFixture = {},
) {
  const app = new Hono<AuthContext>();
  app.use("*", async (c, next) => {
    const principal: AuthPrincipal = {
      method: "token",
      verified: fixture.verified ?? true,
      claims: null,
      ...(fixture.tenantId !== undefined
        ? { tenantId: fixture.tenantId }
        : {}),
    };
    c.set(TOKEN_KEY, "t");
    c.set(AUTH_PRINCIPAL_KEY, principal);
    await next();
  });
  app.route(
    "/",
    createReceiptsRouter({
      receiptStore: store,
      ...(transparencyLog !== undefined ? { transparencyLog } : {}),
    }),
  );
  return app;
}

async function makeSigned(
  receiptId: string,
  tenantId: string,
): Promise<SignedDecisionReceipt> {
  const key = await parseReceiptSigningKey(SEED_B64);
  return signReceiptPayload(
    fixturePayload(receiptId, tenantId),
    key.privateKey,
    key.kid,
  );
}

describe("GET /v1/receipts/:id", () => {
  it("returns 401 when the principal is not verified", async () => {
    const store = new InMemoryReceiptStore();
    const app = appWith(store, undefined, { verified: false, tenantId: "acme" });
    const res = await app.request("/v1/receipts/r1", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
  });

  it("returns 401 when the principal carries no tenant", async () => {
    const store = new InMemoryReceiptStore();
    const app = appWith(store, undefined, { verified: true });
    const res = await app.request("/v1/receipts/r1", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown receipt id", async () => {
    const store = new InMemoryReceiptStore();
    const app = appWith(store, undefined, { tenantId: "acme" });
    const res = await app.request("/v1/receipts/nope", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found_error");
  });

  it("returns 404 for a foreign-tenant receipt", async () => {
    const store = new InMemoryReceiptStore();
    store.put(await makeSigned("r1", "other"));
    const app = appWith(store, undefined, { tenantId: "acme" });
    const res = await app.request("/v1/receipts/r1", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(404);
  });

  it("returns the receipt for its own tenant, with decodable COSE bytes", async () => {
    const store = new InMemoryReceiptStore();
    const signed = await makeSigned("r1", "acme");
    store.put(signed);
    const app = appWith(store, undefined, { tenantId: "acme" });
    const res = await app.request("/v1/receipts/r1", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      receipt_id: string;
      cose_base64: string;
      payload: DecisionReceiptPayload;
    };
    expect(body.receipt_id).toBe("r1");
    expect(body.payload.tenant_id).toBe("acme");
    // The base64url COSE bytes must round-trip back to the stored bytes.
    const decoded = base64UrlDecode(body.cose_base64);
    expect(Array.from(decoded)).toEqual(Array.from(signed.coseBytes));
  });

  it("falls back to the durable transparency log when the store no longer holds the receipt", async () => {
    // Simulates a restarted replica: empty store, log rebuilt from receipt_log.
    const key = await parseReceiptSigningKey(SEED_B64);
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    const signed = await makeSigned("r-durable", "acme");
    await log.append("r-durable", signed.coseBytes);
    const app = appWith(new InMemoryReceiptStore(), log, { tenantId: "acme" });
    const res = await app.request("/v1/receipts/r-durable", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      receipt_id: string;
      cose_base64: string;
      payload: DecisionReceiptPayload;
    };
    expect(body.receipt_id).toBe("r-durable");
    // The decoded payload is the same JSON view the live store serves.
    expect(body.payload).toEqual(signed.payload);
    expect(Array.from(base64UrlDecode(body.cose_base64))).toEqual(
      Array.from(signed.coseBytes),
    );
    const proof = await app.request("/v1/receipts/r-durable/proof", {
      headers: { Authorization: "Bearer t" },
    });
    expect(proof.status).toBe(200);
  });

  it("applies the tenant check to durable receipts too (foreign tenant → 404)", async () => {
    const key = await parseReceiptSigningKey(SEED_B64);
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    const signed = await makeSigned("r-foreign", "other");
    await log.append("r-foreign", signed.coseBytes);
    const app = appWith(new InMemoryReceiptStore(), log, { tenantId: "acme" });
    for (const path of ["/v1/receipts/r-foreign", "/v1/receipts/r-foreign/proof"]) {
      const res = await app.request(path, {
        headers: { Authorization: "Bearer t" },
      });
      expect(res.status).toBe(404);
    }
  });
});

describe("GET /v1/receipts?execution_id=", () => {
  it("returns 401 when the principal is not verified", async () => {
    const store = new InMemoryReceiptStore();
    const app = appWith(store, undefined, { verified: false, tenantId: "acme" });
    const res = await app.request("/v1/receipts?execution_id=exec-r1", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when execution_id is missing or blank", async () => {
    const store = new InMemoryReceiptStore();
    const app = appWith(store, undefined, { tenantId: "acme" });
    const missing = await app.request("/v1/receipts", {
      headers: { Authorization: "Bearer t" },
    });
    expect(missing.status).toBe(400);
    const blank = await app.request("/v1/receipts?execution_id=%20", {
      headers: { Authorization: "Bearer t" },
    });
    expect(blank.status).toBe(400);
  });

  it("lists all receipts of the execution, parent first, tenant-scoped", async () => {
    const store = new InMemoryReceiptStore();
    const parent = await makeSigned("rp", "acme");
    // A tool-call child sharing the parent's execution id.
    const childPayload: DecisionReceiptPayload = {
      ...fixturePayload("rc", "acme"),
      kind: "tool_call",
      execution_id: parent.payload.execution_id,
      parent_receipt_id: parent.payload.receipt_id,
    };
    const key = await parseReceiptSigningKey(SEED_B64);
    const child = await signReceiptPayload(childPayload, key.privateKey, key.kid);
    // A foreign-tenant receipt on the same execution id must never leak.
    const foreignPayload: DecisionReceiptPayload = {
      ...fixturePayload("rf", "other"),
      execution_id: parent.payload.execution_id,
    };
    const foreign = await signReceiptPayload(foreignPayload, key.privateKey, key.kid);
    // Insert child first so the sort (not insertion order) is what orders them.
    store.put(child);
    store.put(parent);
    store.put(foreign);
    const app = appWith(store, undefined, { tenantId: "acme" });
    const res = await app.request(
      `/v1/receipts?execution_id=${encodeURIComponent(parent.payload.execution_id)}`,
      { headers: { Authorization: "Bearer t" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      execution_id: string;
      receipts: Array<{
        receipt_id: string;
        kind: string;
        cose_base64: string;
        payload: DecisionReceiptPayload;
      }>;
    };
    expect(body.execution_id).toBe(parent.payload.execution_id);
    expect(body.receipts.map((r) => r.receipt_id)).toEqual(["rp", "rc"]);
    expect(body.receipts[0]?.kind).toBe("chat_completion");
    expect(body.receipts[1]?.kind).toBe("tool_call");
    // COSE bytes round-trip for every listed receipt.
    expect(base64UrlDecode(body.receipts[0]?.cose_base64 ?? "").length).toBe(
      parent.coseBytes.length,
    );
  });

  it("returns an empty list for an unknown execution", async () => {
    const store = new InMemoryReceiptStore();
    store.put(await makeSigned("r1", "acme"));
    const app = appWith(store, undefined, { tenantId: "acme" });
    const res = await app.request("/v1/receipts?execution_id=exec-unknown", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { receipts: unknown[] };
    expect(body.receipts).toEqual([]);
  });
});

describe("GET /v1/receipts/:id/proof", () => {
  it("returns 503 when the transparency log is unavailable", async () => {
    const store = new InMemoryReceiptStore();
    store.put(await makeSigned("r1", "acme"));
    const app = appWith(store, undefined, { tenantId: "acme" });
    const res = await app.request("/v1/receipts/r1/proof", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("service_unavailable_error");
  });

  it("returns 404 when the receipt is not part of the log", async () => {
    const store = new InMemoryReceiptStore();
    const signed = await makeSigned("r1", "acme");
    store.put(signed);
    const key = await parseReceiptSigningKey(SEED_B64);
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    const app = appWith(store, log, { tenantId: "acme" });
    const res = await app.request("/v1/receipts/r1/proof", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(404);
  });

  it("returns an inclusion proof that verifies offline against the key", async () => {
    const store = new InMemoryReceiptStore();
    const signed = await makeSigned("r1", "acme");
    store.put(signed);
    const key = await parseReceiptSigningKey(SEED_B64);
    const log = new InMemoryTransparencyLog(key.privateKey, key.kid);
    await log.append(signed.payload.receipt_id, signed.coseBytes);
    const app = appWith(store, log, { tenantId: "acme" });

    const res = await app.request("/v1/receipts/r1/proof", {
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      receipt_id: string;
      proof: {
        leaf_index: number;
        tree_size: number;
        node_hashes: string[];
      };
      tree_head: { tree_size: number; cose_base64: string };
    };
    expect(body.receipt_id).toBe("r1");
    expect(body.proof.leaf_index).toBe(0);
    expect(body.proof.tree_size).toBe(1);
    expect(body.tree_head.tree_size).toBe(1);

    // Offline verification: signed head + proof recompute the leaf's root.
    const signedHead = base64UrlDecode(body.tree_head.cose_base64);
    const check = await verifyReceiptInclusion(
      signed.coseBytes,
      signedHead,
      {
        leafIndex: body.proof.leaf_index,
        treeSize: body.proof.tree_size,
        nodeHashes: body.proof.node_hashes,
      },
      key.publicKeyRaw,
    );
    expect(check).toBeDefined();
    expect(check?.headSignatureValid).toBe(true);
    expect(check?.inclusionValid).toBe(true);
  });
});

describe("GET /.well-known/atf-receipt-jwks.json", () => {
  it("publishes the signing key with EdDSA metadata and cache header", async () => {
    const key = await parseReceiptSigningKey(SEED_B64);
    const app = new Hono();
    app.route("/", createReceiptJwksRouter(key));
    const res = await app.request("/.well-known/atf-receipt-jwks.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = (await res.json()) as {
      keys: Array<{ kid: string; alg: string; use: string; kty: string }>;
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.kid).toBe(key.kid);
    expect(body.keys[0]?.alg).toBe("EdDSA");
    expect(body.keys[0]?.use).toBe("sig");
    expect(body.keys[0]?.kty).toBe("OKP");
  });
});
