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
});
