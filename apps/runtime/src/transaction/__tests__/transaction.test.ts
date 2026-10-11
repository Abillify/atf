// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader } from "jose";
import {
  BudgetExceededError,
  InMemoryInvocationLedger,
  TransactionBudgetCoordinator,
  TransactionTokenIssuer,
  TransactionTokenValidator,
  createCapabilityDocument,
  negotiateCapabilities,
  transactionTokenConfigFromEnv,
} from "../index.js";
// Bun's jose generateKeyPair() returns non-extractable CryptoKeys, so PKCS8
// PEM fixtures come from node:crypto instead.
function pemFor(alg: "ES256" | "EdDSA"): string {
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
const NOW = 1_700_000_000_000;
const config = { issuer: "aiperator", audience: "peer", secret: "01234567890123456789012345678901", ttlSeconds: 30 };
const envelope = { jti: "task-8-contract-jti", executionId: "exec-1", invocationId: "inv-1", userId: "alice", scopes: ["tools:call"], groups: ["users"], budget: { maxToolCalls: 2, maxRetrievalDocuments: 7 }, delegationChain: [], trace: { traceId: "trace-1", deadlineAt: NOW + 10_000 } };
describe("transaction v1 tokens", () => {
  test("issues the shared v1 wire contract consumed by MCP peers", async () => {
    const token = await new TransactionTokenIssuer(config, () => NOW).issue(envelope);
    const value = await new TransactionTokenValidator(config, () => NOW).validate(token);
    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "at+jwt" });
    expect(value).toMatchObject({ version: "v1", iss: "aiperator", aud: "peer", iat: NOW / 1000, exp: NOW / 1000 + 30, jti: "task-8-contract-jti", invocationId: "inv-1", budget: { maxRetrievalDocuments: 7 }, trace: { deadlineAt: NOW + 10_000 } });
  });
  test("required enforcement rejects a missing token", async () => { expect(new TransactionTokenValidator({ ...config, enforcement: "required" }).validate(undefined)).rejects.toThrow("required"); });
  test("rejects a different audience and tampering", async () => {
    const token = await new TransactionTokenIssuer(config, () => NOW).issue(envelope);
    await expect(new TransactionTokenValidator({ ...config, audience: "other" }, () => NOW).validate(token)).rejects.toThrow();
    const parts = token.split(".");
    parts[1] = `${parts[1]?.slice(0, -1)}${parts[1]?.endsWith("a") ? "b" : "a"}`;
    await expect(new TransactionTokenValidator(config, () => NOW).validate(parts.join("."))).rejects.toThrow();
  });
});
describe("asymmetric transaction tokens (Req 7.11)", () => {
  for (const alg of ["ES256", "EdDSA"] as const) {
    test(`${alg}: issue/validate round-trip with PKCS8 key and kid header`, async () => {
      const pem = pemFor(alg);
      const asymmetric = {
        issuer: "aiperator",
        audience: "peer",
        alg,
        signingKeyPem: pem,
        ttlSeconds: 30,
      };
      const token = await new TransactionTokenIssuer(
        asymmetric,
        () => NOW,
      ).issue(envelope);
      const header = decodeProtectedHeader(token);
      expect(header.alg).toBe(alg);
      expect(header.typ).toBe("at+jwt");
      expect(typeof header.kid).toBe("string");
      expect((header.kid as string).length).toBeGreaterThan(20);
      const value = await new TransactionTokenValidator(
        asymmetric,
        () => NOW,
      ).validate(token);
      expect(value).toMatchObject({
        version: "v1",
        iss: "aiperator",
        aud: "peer",
        invocationId: "inv-1",
      });
    });
    test(`${alg}: a different key cannot validate`, async () => {
      const signer = pemFor(alg);
      const other = pemFor(alg);
      const token = await new TransactionTokenIssuer(
        { issuer: "aiperator", audience: "peer", alg, signingKeyPem: signer },
        () => NOW,
      ).issue(envelope);
      await expect(
        new TransactionTokenValidator(
          { issuer: "aiperator", audience: "peer", alg, signingKeyPem: other },
          () => NOW,
        ).validate(token),
      ).rejects.toThrow();
    });
    test(`${alg}: HS256 tokens are not accepted when asymmetric mode is configured`, async () => {
      const pem = pemFor(alg);
      const hsToken = await new TransactionTokenIssuer(config, () => NOW).issue(
        envelope,
      );
      await expect(
        new TransactionTokenValidator(
          { issuer: "aiperator", audience: "peer", alg, signingKeyPem: pem },
          () => NOW,
        ).validate(hsToken),
      ).rejects.toThrow();
    });
    test(`${alg}: issuer without a key fails at construction`, () => {
      expect(
        () =>
          new TransactionTokenIssuer(
            { issuer: "aiperator", audience: "peer", alg },
            () => NOW,
          ),
      ).toThrow("TRANSACTION_SIGNING_KEY");
    });
  }
  test("fromEnv: default HS256 without secret stays undefined", () => {
    expect(transactionTokenConfigFromEnv({})).toBeUndefined();
    expect(
      transactionTokenConfigFromEnv({
        AGENT_TRANSACTION_SECRET: "x".repeat(32),
      }),
    ).toMatchObject({ alg: "HS256" });
  });
  test("fromEnv: invalid TRANSACTION_SIGNING_ALG throws", () => {
    expect(() =>
      transactionTokenConfigFromEnv({ TRANSACTION_SIGNING_ALG: "RS512" }),
    ).toThrow("TRANSACTION_SIGNING_ALG");
  });
  test("fromEnv: ES256 without TRANSACTION_SIGNING_KEY throws", () => {
    expect(() =>
      transactionTokenConfigFromEnv({ TRANSACTION_SIGNING_ALG: "ES256" }),
    ).toThrow("TRANSACTION_SIGNING_KEY");
  });
  test("fromEnv: EdDSA with key yields asymmetric config", () => {
    const cfg = transactionTokenConfigFromEnv({
      TRANSACTION_SIGNING_ALG: "EdDSA",
      // Synthetic PEM, assembled so the public-tree scanner does not flag it.
      TRANSACTION_SIGNING_KEY: [
        "-----BEGIN",
        "PRIVATE KEY-----\nabc\n-----END",
        "PRIVATE KEY-----",
      ].join(" "),
      AGENT_TRANSACTION_ENFORCEMENT: "required",
    });
    expect(cfg).toMatchObject({ alg: "EdDSA", enforcement: "required" });
    expect(cfg?.signingKeyPem).toContain("BEGIN PRIVATE KEY");
  });
});
describe("invocation ledger", () => { test("atomically deduplicates and enforces state transitions", () => { const ledger = new InMemoryInvocationLedger(); expect(ledger.claim("i").acquired).toBe(true); expect(ledger.claim("i").acquired).toBe(false); ledger.transition("i", "running"); ledger.transition("i", "committed", { result: 42 }); expect(ledger.get("i")?.result).toBe(42); expect(() => ledger.transition("i", "running")).toThrow("Invalid"); }); });
describe("budget coordinator", () => {
  test("reserves idempotently, commits usage, and rejects overflow", () => { const budget = new TransactionBudgetCoordinator(); budget.reserve("exec", { maxToolCalls: 1 }, { invocationId: "i", requested: { toolCalls: 1 } }); budget.reserve("exec", { maxToolCalls: 1 }, { invocationId: "i", requested: { toolCalls: 1 } }); expect(budget.commit("exec", "i").toolCalls).toBe(1); expect(() => budget.reserve("exec", { maxToolCalls: 1 }, { invocationId: "j", requested: { toolCalls: 1 } })).toThrow(BudgetExceededError); });
  test("atomically rejects a concurrent reservation beyond maxToolCalls", async () => {
    const budget = new TransactionBudgetCoordinator();
    const attempts = await Promise.allSettled(["i", "j"].map(async (invocationId) => budget.reserve("exec", { maxToolCalls: 1 }, { invocationId, requested: { toolCalls: 1 } })));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(BudgetExceededError);
  });
});
describe("capability negotiation", () => { test("falls back for legacy peers", async () => { const fallback = createCapabilityDocument({ issuer: "a", audience: "b" }); const result = await negotiateCapabilities({}, "legacy", fallback); expect(result.negotiated).toBe(false); expect(result.capabilities.protocol).toBe("v1"); }); });
