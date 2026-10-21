// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import {
  enforceRetrievalBudget,
  canonicalActionContractHash,
  extractTransactionToken,
  isAcceptedTransactionTyp,
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
// The new stricter behaviour requires an accepted `typ`; tokens minted by ATF
// Runtime always carry `at+jwt`. Pass `null` to mint a token without a `typ`.
async function token(payload: Record<string, unknown>, key = secret, typ: string | null = "at+jwt") { return new SignJWT(payload).setProtectedHeader({ alg: "HS256", ...(typ === null ? {} : { typ }) }).sign(new TextEncoder().encode(key)); }

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
  it("strips unknown additional claims instead of rejecting them", async () => {
    const now = Math.floor(Date.now() / 1000);
    const context = await verifyTransactionToken(await token({
      ...base(now), evidencePackHash: stableHash("response-only"), nbf: now,
    }), config, principal);
    expect(context.envelope).toMatchObject({ version: "v1" });
    expect(context.envelope).not.toHaveProperty("evidencePackHash");
    expect(context.envelope).not.toHaveProperty("nbf");
  });
  it("rejects a contract hash that is not a 64-character hex SHA-256", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expectCode(verifyTransactionToken(await token({
      ...base(now), actionContractHash: "not-a-hash",
    }), config, principal), "TRANSACTION_ENVELOPE_INVALID");
    await expectCode(verifyTransactionToken(await token({
      ...base(now), evidenceContractHash: stableHash("x").slice(0, 63),
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

describe("transaction token typ header", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("normalizes case and the optional application/ prefix", () => {
    expect(isAcceptedTransactionTyp("at+jwt")).toBe(true);
    expect(isAcceptedTransactionTyp("AT+JWT")).toBe(true);
    expect(isAcceptedTransactionTyp("application/txn+jwt")).toBe(true);
    expect(isAcceptedTransactionTyp("JWT")).toBe(false);
    expect(isAcceptedTransactionTyp(undefined)).toBe(false);
  });

  it("accepts typ at+jwt and application/txn+jwt", async () => {
    await expect(verifyTransactionToken(await token(base(now())), config, principal)).resolves.toMatchObject({ legacy: false });
    await expect(verifyTransactionToken(await token(base(now()), secret, "application/txn+jwt"), config, principal)).resolves.toMatchObject({ legacy: false });
  });

  it("rejects typ JWT and a missing typ", async () => {
    await expectCode(verifyTransactionToken(await token(base(now()), secret, "JWT"), config, principal), "TRANSACTION_TOKEN_INVALID");
    await expectCode(verifyTransactionToken(await token(base(now()), secret, null), config, principal), "TRANSACTION_TOKEN_INVALID");
  });
});

describe("asymmetric transaction tokens (ES256 / EdDSA through the issuer's JWKS)", () => {
  async function issuer(alg: "EdDSA" | "ES256", kid = `key-${alg}`) {
    const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
    const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });
    const sign = (payload: Record<string, unknown>) =>
      new SignJWT(payload).setProtectedHeader({ alg, kid, typ: "at+jwt" }).sign(privateKey);
    return { jwks, sign, privateKey };
  }
  const now = () => Math.floor(Date.now() / 1000);

  it.each(["EdDSA", "ES256"] as const)("verifies a %s token against the JWKS", async (alg) => {
    const { jwks, sign } = await issuer(alg);
    const cfg: TransactionConfig = { ...config, secret: null, algorithms: [alg], jwks };
    await expect(verifyTransactionToken(await sign(base(now())), cfg, principal)).resolves.toMatchObject({ legacy: false });
  });

  it("accepts HS256 and EdDSA side by side during a rolling migration", async () => {
    const { jwks, sign } = await issuer("EdDSA");
    const cfg: TransactionConfig = { ...config, algorithms: ["HS256", "EdDSA"], jwks };
    await expect(verifyTransactionToken(await token(base(now())), cfg, principal)).resolves.toMatchObject({ legacy: false });
    await expect(verifyTransactionToken(await sign(base(now())), cfg, principal)).resolves.toMatchObject({ legacy: false });
  });

  it("rejects an algorithm the deployment does not accept, whichever key would verify it", async () => {
    const { jwks, sign } = await issuer("EdDSA");
    // The shared secret is gone: a leaked HS256 token (or one forged with it) is refused outright.
    const asymmetricOnly: TransactionConfig = { ...config, secret: null, algorithms: ["EdDSA"], jwks };
    await expectCode(verifyTransactionToken(await token(base(now())), asymmetricOnly, principal), "TRANSACTION_TOKEN_INVALID");
    // And the other way round: a deployment still on HS256 does not trust a JWKS-signed token.
    const hsOnly: TransactionConfig = { ...config, algorithms: ["HS256"], jwks };
    await expectCode(verifyTransactionToken(await sign(base(now())), hsOnly, principal), "TRANSACTION_TOKEN_INVALID");
    // The default (no `algorithms`) is HS256 only, exactly as before asymmetric tokens existed.
    await expectCode(verifyTransactionToken(await sign(base(now())), { ...config, jwks }, principal), "TRANSACTION_TOKEN_INVALID");
  });

  it("rejects a token signed by a key that is not in the JWKS, and `none`", async () => {
    const { jwks } = await issuer("EdDSA");
    const stranger = await issuer("EdDSA", "key-EdDSA");
    const cfg: TransactionConfig = { ...config, secret: null, algorithms: ["EdDSA"], jwks };
    await expectCode(verifyTransactionToken(await stranger.sign(base(now())), cfg, principal), "TRANSACTION_TOKEN_INVALID");
    const unsecured = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(base(now()))).toString("base64url")}.`;
    await expectCode(verifyTransactionToken(unsecured, cfg, principal), "TRANSACTION_TOKEN_INVALID");
    await expectCode(verifyTransactionToken("not.a.jwt", cfg, principal), "TRANSACTION_TOKEN_INVALID");
  });

  it("still enforces issuer and audience, so a token minted for another service is refused", async () => {
    const { jwks, sign } = await issuer("EdDSA");
    const cfg: TransactionConfig = { ...config, secret: null, algorithms: ["EdDSA"], jwks };
    await expectCode(verifyTransactionToken(await sign({ ...base(now()), aud: "mcpgate" }), cfg, principal), "TRANSACTION_TOKEN_INVALID");
    await expectCode(verifyTransactionToken(await sign({ ...base(now()), iss: "someone-else" }), cfg, principal), "TRANSACTION_TOKEN_INVALID");
  });

  it("reports an unreachable JWKS as a retryable 503 instead of an invalid token", async () => {
    const { sign } = await issuer("EdDSA");
    const timeoutResolver: JWTVerifyGetKey = () => {
      throw Object.assign(new Error("timeout"), { code: "ERR_JWKS_TIMEOUT" });
    };
    const cfg: TransactionConfig = { ...config, secret: null, algorithms: ["EdDSA"], jwks: timeoutResolver };
    await expect(verifyTransactionToken(await sign(base(now())), cfg, principal)).rejects.toMatchObject({
      status: 503,
      body: { code: "TRANSACTION_KEYS_UNAVAILABLE", category: "unavailable", retryable: true },
    });
    // A raw fetch failure surfaces as a TypeError from fetch().
    const networkResolver: JWTVerifyGetKey = () => {
      throw new TypeError("fetch failed");
    };
    await expect(verifyTransactionToken(await sign(base(now())), { ...cfg, jwks: networkResolver }, principal)).rejects.toMatchObject({
      status: 503,
      body: { code: "TRANSACTION_KEYS_UNAVAILABLE", retryable: true },
    });
  });

  it("keeps a non-matching key (ERR_JWKS_NO_MATCHING_KEY) a 401", async () => {
    const { jwks } = await issuer("EdDSA");
    const cfg: TransactionConfig = { ...config, secret: null, algorithms: ["EdDSA"], jwks };
    // A token whose `kid` is absent from the JWKS: jose fails with
    // ERR_JWKS_NO_MATCHING_KEY, which must stay a 401, not a 503.
    const foreign = await issuer("EdDSA", "unknown-kid");
    await expectCode(verifyTransactionToken(await foreign.sign(base(now())), cfg, principal), "TRANSACTION_TOKEN_INVALID");
  });

  it("reports a misconfiguration (an accepted asymmetric algorithm without a key source) as a server error", async () => {
    const { sign } = await issuer("EdDSA");
    const cfg: TransactionConfig = { ...config, secret: null, algorithms: ["EdDSA"] };
    await expectCode(verifyTransactionToken(await sign(base(now())), cfg, principal), "TRANSACTION_CONFIG_INVALID");
    const noSecret: TransactionConfig = { ...config, secret: null, algorithms: ["HS256"] };
    await expectCode(verifyTransactionToken(await token(base(now())), noSecret, principal), "TRANSACTION_CONFIG_INVALID");
  });
});
