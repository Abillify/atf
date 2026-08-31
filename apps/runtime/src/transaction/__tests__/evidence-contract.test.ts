// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  createEvidenceActionContract,
  serializeEvidenceActionContract,
} from "../evidence-contract.js";

const hash = (character: string) => character.repeat(64);
const evidencePack = (contentHash = hash("c")) => ({
  schemaVersion: "v1",
  packId: hash("a"),
  retrievedAt: "2026-08-05T12:00:00.000Z",
  safety: { contentTrust: "untrusted" },
  evidence: [
    {
      evidenceId: hash("e"),
      provenance: {
        snapshotHash: hash("b"),
        contentHash,
        version: "42",
        modifiedAt: "2026-08-05T11:00:00.000Z",
      },
      safety: { contentTrust: "untrusted", dataClassification: "internal" },
    },
  ],
});

function requiredContract(
  args: Record<string, unknown>,
  pack: unknown = evidencePack(),
) {
  const contract = createEvidenceActionContract("write_order", args, pack);
  if (contract === undefined) throw new Error("expected verified evidence contract");
  return contract;
}

describe("Evidence-Bound Action Contract", () => {
  test("binds an action and verified provenance without serializing evidence text", () => {
    const contract = requiredContract(
      { orderId: "42", amount: 10 },
    );
    expect(contract).toMatchObject({
      schemaVersion: "v1",
      action: { tool: "write_order" },
      evidence: { packId: hash("a"), items: [{ evidenceId: hash("e") }] },
    });
    const serialized = serializeEvidenceActionContract(contract);
    expect(serialized.serialized).not.toContain('"content":');
    expect(serialized.hash).toHaveLength(64);
  });

  test("accepts vectorsearch v2 while retaining v1 packId compatibility", () => {
    const v1 = requiredContract({ orderId: "42" });
    const v2 = requiredContract(
      { orderId: "42" },
      {
        ...evidencePack(),
        schemaVersion: "v2",
        packId: undefined,
        evidencePackHash: hash("d"),
      },
    );

    expect(v1.evidence.packId).toBe(hash("a"));
    expect(v2.evidence.packId).toBe(hash("d"));
    expect(serializeEvidenceActionContract(v2).evidencePackHash).toBe(hash("d"));
  });

  test("changes the contract hash when action arguments or evidence provenance changes", () => {
    const first = serializeEvidenceActionContract(
      requiredContract({ orderId: "42" }),
    );
    const changedArgs = serializeEvidenceActionContract(
      requiredContract({ orderId: "43" }),
    );
    const changedEvidence = serializeEvidenceActionContract(
      requiredContract({ orderId: "42" }, evidencePack(hash("d"))),
    );
    expect(changedArgs.hash).not.toBe(first.hash);
    expect(changedEvidence.hash).not.toBe(first.hash);
  });

  test("rejects a pack that does not preserve the untrusted-content boundary", () => {
    expect(() =>
      createEvidenceActionContract("write_order", {}, {
        ...evidencePack(),
        safety: { contentTrust: "trusted" },
      }),
    ).toThrow("untrusted content");
  });
});
