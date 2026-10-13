// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  enforceRetrievalBudget,
  canonicalActionContractHash,
  extractTransactionToken,
  runWithTransaction,
  stableHash,
  TransactionError,
  verifyTransactionToken,
  type TransactionConfig,
} from "../src/transaction-context.js";
import type { RequestPrincipal } from "../src/request-principal.js";

const secret = "0123456789abcdef0123456789abcdef";
const config: TransactionConfig = { enforcement: "required", secret, issuer: "issuer", audience: "vectorsearch", clockToleranceSeconds: 0, maxTtlSeconds: 300 };
const principal: RequestPrincipal = { userId: "alice", userGroups: ["legal"], source: "jwt" };
const base = (now: number) => ({ version: "v1", iss: "issuer", aud: "vectorsearch", iat: now, exp: now + 60, jti: "jti", executionId: "exec", invocationId: "invoke", userId: "alice", scopes: ["retrieve"], groups: ["legal"], budget: { maxRetrievalDocuments: 2 }, delegationChain: [], trace: { traceId: "trace" } });
async function token(payload: Record<string, unknown>, key = secret) { return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(key)); }

function expectCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ body: { code } });
}

describe("Agent Transaction Fabric v1", () => {
  it("accepts the shared aiperator v1 claims including jti, invocation binding and epoch-ms deadline", async () => {
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const payload = { ...base(now), iss: "issuer", jti: "task-8-contract-jti", invocationId: "task-8-vector-invocation", trace: { traceId: "trace", deadlineAt: nowMs + 10_000 } };
    const context = await verifyTransactionToken(await token(payload), config, principal, nowMs);
    expect(context.envelope).toMatchObject({ version: "v1", aud: "vectorsearch", jti: "task-8-contract-jti", invocationId: "task-8-vector-invocation", budget: { maxRetrievalDocuments: 2 } });
  });
  it("rejects an elapsed epoch-ms deadline", async () => {
    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    await expectCode(verifyTransactionToken(await token({ ...base(now), trace: { deadlineAt: nowMs - 1 } }), config, principal, nowMs), "TRANSACTION_DEADLINE_EXCEEDED");
  });
  it("rejects tampered tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectCode(verifyTransactionToken(await token(base(now), "different-secret-012345678901234"), config, principal), "TRANSACTION_TOKEN_INVALID");
  });
  it("rejects expired tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectCode(verifyTransactionToken(await token({ ...base(now - 120), exp: now - 60 }), config, principal), "TRANSACTION_TOKEN_INVALID");
  });
  it("rejects the wrong audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectCode(verifyTransactionToken(await token({ ...base(now), aud: "other" }), config, principal), "TRANSACTION_TOKEN_INVALID");
  });
  it("fails closed on principal identity mismatch", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectCode(verifyTransactionToken(await token({ ...base(now), userId: "mallory" }), config, principal), "TRANSACTION_IDENTITY_MISMATCH");
  });
  it("requires envelope groups to be a subset of authenticated principal groups", async () => {
    const now = Math.floor(Date.now() / 1000);
    const broaderPrincipal = { ...principal, userGroups: ["legal", "reviewers"] };
    await expect(verifyTransactionToken(await token(base(now)), config, broaderPrincipal)).resolves.toMatchObject({ legacy: false });
    await expectCode(
      verifyTransactionToken(await token({ ...base(now), groups: ["legal", "admins"] }), config, broaderPrincipal),
      "TRANSACTION_IDENTITY_MISMATCH",
    );
  });
  it("enforces maxRetrievalDocuments strictly", async () => {
    const now = Math.floor(Date.now() / 1000);
    const context = await verifyTransactionToken(await token(base(now)), config, principal);
    expect(() => runWithTransaction(context, () => enforceRetrievalBudget(3))).toThrowError(TransactionError);
    expect(runWithTransaction(context, () => enforceRetrievalBudget(2))).toBe(2);
  });
  it("keeps evidence and query hashes stable", () => {
    expect(stableHash("collection\nreference\n0\nversion\nhash")).toBe(stableHash("collection\nreference\n0\nversion\nhash"));
    expect(stableHash("query")).not.toBe(stableHash("other query"));
  });
  it("accepts evidenceContractHash and canonicalizes tenant, scopes, groups and hash casing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const hash = stableHash("evidence-contract");
    const context = await verifyTransactionToken(await token({
      ...base(now), tenantId: " tenant-a ", scopes: [" retrieve ", "read", "retrieve"],
      groups: [" legal ", "legal"], evidenceContractHash: hash.toUpperCase(),
    }), config, { ...principal, tenantId: "tenant-a" });
    expect(context.envelope).toMatchObject({ tenantId: "tenant-a", scopes: ["read", "retrieve"], groups: ["legal"], evidenceContractHash: hash });
    expect(canonicalActionContractHash(context.envelope)).toBe(hash);
  });
  it("prefers actionContractHash, accepts an identical case-insensitive alias, and rejects conflicts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const hash = stableHash("action-contract");
    const accepted = await verifyTransactionToken(await token({
      ...base(now), actionContractHash: hash.toUpperCase(), evidenceContractHash: hash,
    }), config, principal);
    expect(accepted.envelope).toMatchObject({ actionContractHash: hash, evidenceContractHash: hash });
    expect(canonicalActionContractHash(accepted.envelope)).toBe(hash);
    await expectCode(verifyTransactionToken(await token({
      ...base(now), actionContractHash: hash, evidenceContractHash: stableHash("different"),
    }), config, principal), "TRANSACTION_ENVELOPE_INVALID");
  });
  it("keeps evidencePackHash out of the strict transaction envelope", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectCode(verifyTransactionToken(await token({
      ...base(now), evidencePackHash: stableHash("response-only"),
    }), config, principal), "TRANSACTION_ENVELOPE_INVALID");
  });
  it("extracts neutral, header and legacy compatibility token locations", () => {
    expect(extractTransactionToken({ params: { _meta: { "transaction/token": "neutral" } } })).toBe("neutral");
    expect(extractTransactionToken({}, "header-token")).toBe("header-token");
    expect(extractTransactionToken({ params: { _meta: { "aiperator/transactionToken": "legacy" } } })).toBe("legacy");
  });
  it("allows legacy calls only in optional mode", async () => {
    await expect(verifyTransactionToken(undefined, { ...config, enforcement: "optional" }, principal)).resolves.toEqual({ envelope: null, legacy: true });
    await expectCode(verifyTransactionToken(undefined, config, principal), "TRANSACTION_TOKEN_REQUIRED");
  });
});
