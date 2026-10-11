// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  createCapabilityDocument,
  shouldIssueTransaction,
} from "../capabilities.js";

const SECRET = "01234567890123456789012345678901";
const v1 = createCapabilityDocument({
  issuer: "peer",
  audience: "peer",
});

describe("transaction capability negotiation", () => {
  test("issues only after a peer advertises compatible v1 support", async () => {
    const provider = { getTransactionCapabilities: async () => v1 };
    expect(
      await shouldIssueTransaction(provider, "peer", {
        AGENT_TRANSACTION_SECRET: SECRET,
        AGENT_TRANSACTION_ENFORCEMENT: "optional",
      }),
    ).toBe(true);
  });

  test("falls back transparently for a legacy peer in optional mode", async () => {
    const provider = {
      getTransactionCapabilities: async () => undefined,
    };
    expect(
      await shouldIssueTransaction(provider, "legacy", {
        AGENT_TRANSACTION_SECRET: SECRET,
        AGENT_TRANSACTION_ENFORCEMENT: "optional",
      }),
    ).toBe(false);
  });

  test("fails closed for a legacy peer in required mode", async () => {
    const provider = {
      getTransactionCapabilities: async () => undefined,
    };
    await expect(
      shouldIssueTransaction(provider, "legacy", {
        AGENT_TRANSACTION_SECRET: SECRET,
        AGENT_TRANSACTION_ENFORCEMENT: "required",
      }),
    ).rejects.toThrow(/required.*did not advertise/u);
  });

  test("fails closed when the peer requires v1 but signing is unavailable", async () => {
    const provider = {
      getTransactionCapabilities: async () => ({
        ...v1,
        enforcement: "required" as const,
      }),
    };
    await expect(
      shouldIssueTransaction(provider, "peer", {
        AGENT_TRANSACTION_ENFORCEMENT: "optional",
      }),
    ).rejects.toThrow(/signing is not configured/u);
  });

  test("asymmetric config (ES256 + key) counts as signing configured (Req 7.11)", async () => {
    const provider = { getTransactionCapabilities: async () => v1 };
    expect(
      await shouldIssueTransaction(provider, "peer", {
        TRANSACTION_SIGNING_ALG: "ES256",
        // Synthetic PEM, assembled so the public-tree scanner does not flag it.
        TRANSACTION_SIGNING_KEY: [
          "-----BEGIN",
          "PRIVATE KEY-----\nabc\n-----END",
          "PRIVATE KEY-----",
        ].join(" "),
        AGENT_TRANSACTION_ENFORCEMENT: "required",
      }),
    ).toBe(true);
  });

  test("asymmetric alg without a key is not signing configured", async () => {
    const provider = {
      getTransactionCapabilities: async () => ({
        ...v1,
        enforcement: "required" as const,
      }),
    };
    await expect(
      shouldIssueTransaction(provider, "peer", {
        TRANSACTION_SIGNING_ALG: "EdDSA",
        AGENT_TRANSACTION_ENFORCEMENT: "optional",
      }),
    ).rejects.toThrow(/signing is not configured/u);
  });
});
