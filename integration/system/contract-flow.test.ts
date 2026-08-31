// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  parseEvidenceActionContract,
  parseTransactionEnvelopeConsumer,
  parseTransactionEnvelopeProducer,
} from "@atf/contract-adapter";
import {
  EVIDENCE_ACTION_CONTRACT_HASH_META_KEY,
  EVIDENCE_ACTION_CONTRACT_META_KEY,
  EVIDENCE_CONTRACT_HASH_META_KEY,
  EVIDENCE_PACK_HASH_META_KEY,
} from "@atf/evidence-contract";
import { inspectJobView } from "../../apps/control/src/contracts/jobs.ts";
import { InMemoryJobStore } from "../../apps/runtime/src/graph/job-store.ts";
import { createJobsRouter } from "../../apps/runtime/src/routes/jobs.ts";
import {
  createEvidenceActionContract,
  serializeEvidenceActionContract,
} from "../../apps/runtime/src/transaction/evidence-contract.ts";
import {
  TransactionTokenIssuer,
  TransactionTokenValidator,
} from "../../apps/runtime/src/transaction/token.ts";
import { evidenceActionContractHash } from "../../apps/gate/src/mcp/evidence-contract.ts";

const digest = (character: string): string => character.repeat(64);

describe("real application wire contracts", () => {
  test("Runtime transaction JWT satisfies producer and tolerant Gate consumer contracts", async () => {
    const now = () => 1_800_000_000_000;
    const signingKey = ["contract", "test", "only", "signing", "material"].join("-");
    const config = {
      issuer: "aiperator",
      audience: "agent-transaction-fabric",
      secret: signingKey,
    };
    const token = await new TransactionTokenIssuer(config, now).issue({
      executionId: "execution-1",
      invocationId: "invocation-1",
      scopes: ["tool:read"],
      groups: ["operators"],
      budget: { maxToolCalls: 2 },
      delegationChain: [],
      trace: { traceId: "trace-1", deadlineAt: now() + 30_000 },
    });
    const header = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(header.typ).toBe("at+jwt");
    const envelope = await new TransactionTokenValidator(config, now).validate(token);
    expect(parseTransactionEnvelopeProducer(envelope).ok).toBe(true);
    expect(parseTransactionEnvelopeConsumer(envelope).ok).toBe(true);
  });

  test("Runtime evidence metadata is accepted and hashed identically by Gate", () => {
    const args = { query: "contract boundary" };
    const contract = createEvidenceActionContract("vectorsearch", args, {
      schemaVersion: "v2",
      evidencePackHash: digest("d"),
      retrievedAt: "2026-08-29T00:00:00.000Z",
      safety: { contentTrust: "untrusted" },
      evidence: [{
        evidenceId: digest("a"),
        provenance: {
          snapshotHash: digest("b"),
          contentHash: digest("c"),
          version: "1",
          modifiedAt: "2026-08-28T00:00:00.000Z",
        },
        safety: { contentTrust: "untrusted", dataClassification: "internal" },
      }],
    });
    expect(contract).toBeDefined();
    const meta = serializeEvidenceActionContract(contract!);
    expect(parseEvidenceActionContract(meta.contract).ok).toBe(true);
    const consumed = evidenceActionContractHash({
      [EVIDENCE_ACTION_CONTRACT_META_KEY]: meta.serialized,
      [EVIDENCE_ACTION_CONTRACT_HASH_META_KEY]: meta.actionContractHash,
      [EVIDENCE_CONTRACT_HASH_META_KEY]: meta.evidenceContractHash,
      [EVIDENCE_PACK_HASH_META_KEY]: meta.evidencePackHash,
    }, "vectorsearch", args);
    expect(consumed).toBe(meta.actionContractHash);
  });

  test("actual Runtime jobs HTTP response satisfies the Control consumer", async () => {
    const store = new InMemoryJobStore({ clock: () => Date.parse("2026-08-29T00:00:00.000Z") });
    store.create({ id: "job-contract-1", model: "flow-contract" });
    const response = await createJobsRouter(store).request("/v1/jobs/job-contract-1");
    expect(response.status).toBe(200);
    const inspection = inspectJobView(await response.json());
    expect(inspection.ok).toBe(true);
    if (inspection.ok) {
      expect(inspection.value.status).toBe("queued");
      expect(inspection.value.attempt).toBe(1);
    }
  });
});
