// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { expect, test } from "bun:test";
import { buildTransactionMeta } from "../../mcp/wrapper/client.js";

test("propagates product-neutral transaction metadata with a rolling-upgrade token alias", () => {
  expect(
    buildTransactionMeta("inv", {
      token: "jwt",
      invocationId: "ignored",
      trace: {
        traceId: "trace",
        spanId: "span",
        traceparent: "00-trace-span-01",
        deadlineAt: 123,
      },
    }),
  ).toEqual({
    "transaction/invocationId": "inv",
    "transaction/idempotencyKey": "inv",
    "aiperator/invocationId": "inv",
    "aiperator/idempotencyKey": "inv",
    "transaction/token": "jwt",
    "aiperator/transactionToken": "jwt",
    "transaction/traceId": "trace",
    "transaction/spanId": "span",
    traceparent: "00-trace-span-01",
    "transaction/deadlineAt": 123,
  });
});

test("keeps product-neutral identity metadata when transaction context is absent", () => {
  expect(buildTransactionMeta("inv")).toEqual({
    "transaction/invocationId": "inv",
    "transaction/idempotencyKey": "inv",
    "aiperator/invocationId": "inv",
    "aiperator/idempotencyKey": "inv",
  });
});


test("propagates the canonical Evidence-Bound Action Contract alongside the matching transaction claim", () => {
  const evidenceContract = {
    contract: {
      schemaVersion: "v1" as const,
      action: { tool: "write", argsHash: "a".repeat(64) },
      evidence: {
        packId: "b".repeat(64),
        retrievedAt: "2026-08-05T12:00:00.000Z",
        items: [{
          evidenceId: "c".repeat(64),
          snapshotHash: "d".repeat(64),
          contentHash: "e".repeat(64),
          version: "1",
          modifiedAt: "2026-08-05T11:00:00.000Z",
        }],
      },
    },
    serialized: `{"action":{"argsHash":"${"a".repeat(64)}","tool":"write"},"evidence":{"items":[{"contentHash":"${"e".repeat(64)}","evidenceId":"${"c".repeat(64)}","modifiedAt":"2026-08-05T11:00:00.000Z","snapshotHash":"${"d".repeat(64)}","version":"1"}],"packId":"${"b".repeat(64)}","retrievedAt":"2026-08-05T12:00:00.000Z"},"schemaVersion":"v1"}`,
    actionContractHash: "F".repeat(64),
    evidenceContractHash: "f".repeat(64),
    evidencePackHash: "B".repeat(64),
    hash: "f".repeat(64),
  };
  expect(
    buildTransactionMeta(
      "inv",
      {
        actionContractHash: evidenceContract.actionContractHash,
        evidenceContractHash: evidenceContract.evidenceContractHash,
      },
      evidenceContract,
    ),
  ).toMatchObject({
    "evidence/actionContract": evidenceContract.serialized,
    "evidence/actionContractHash": evidenceContract.hash,
    "evidence/evidenceContractHash": evidenceContract.hash,
    "evidence/evidencePackHash": "b".repeat(64),
  });
});