// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  adaptRuntimePrincipal,
  applyContractPolicy,
  assessSchemaEvolution,
  parseTransactionEnvelopeConsumer,
  parseTransactionEnvelopeProducer,
} from "../src/index.ts";

const envelope = {
  version: "v1",
  iss: "runtime",
  aud: "gate",
  iat: 1,
  exp: 2,
  jti: "tx-1",
  executionId: "execution-1",
  invocationId: "invocation-1",
  scopes: ["tool:read"],
  groups: [],
  budget: {},
  delegationChain: [],
  trace: { deadlineAt: 1_000 },
};

describe("contract adapter", () => {
  test("keeps producer strict while preserving the Gate consumer's string deadline compatibility", () => {
    expect(parseTransactionEnvelopeProducer(envelope).ok).toBe(true);
    expect(parseTransactionEnvelopeProducer({ ...envelope, trace: { deadlineAt: "2026-01-01T00:00:00Z" } }).ok).toBe(false);
    expect(parseTransactionEnvelopeConsumer({ ...envelope, trace: { deadlineAt: "2026-01-01T00:00:00Z" } }).ok).toBe(true);
  });

  test("rejects conflicting compatibility hash aliases", () => {
    expect(parseTransactionEnvelopeConsumer({ ...envelope, actionContractHash: "a".repeat(64), evidenceContractHash: "b".repeat(64) }).ok).toBe(false);
  });

  test("does not invent an unverified runtime identity", () => {
    const result = adaptRuntimePrincipal(
      { method: "anonymous", verified: false, claims: null },
      { issuer: "runtime", authenticatedAt: "2026-01-01T00:00:00.000Z" },
    );
    expect(result.ok).toBe(false);
    expect(() => applyContractPolicy(result, { mode: "enforce" })).toThrow("Contract validation failed");
  });

  test("delegates schema evolution classification", () => {
    const diff = assessSchemaEvolution(
      { inputSchema: { type: "object", properties: {} } },
      { inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    );
    expect(diff.nonBreaking.length).toBeGreaterThan(0);
  });
});
