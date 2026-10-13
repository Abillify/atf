// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision_Receipt builder tests (Req 15.1, 15.2, 15.6).
 *
 * Builds receipts from a synthetic sealed Debug_Trace and asserts every
 * required field is present, the payload stays PII-free, child ids are
 * deterministic, and the COSE_Sign1 round-trip verifies (with bit-flip
 * rejection) against the raw public key.
 */

import { describe, expect, test } from "bun:test";

import {
  cborDecodeSign1,
  coseSign1Verify,
  exportEd25519RawPublicKey,
} from "@atf/security-kit";

import type { DebugTrace } from "../../types/debug-trace.js";
import {
  buildReceiptPayloads,
  cborEncodeReceiptPayload,
  childReceiptId,
  COMPLIANCE_NONE_MARKER,
  sha256Canonical,
  sha256Hex,
  signReceiptPayload,
  type ReceiptBuildContext,
} from "../receipt-builder.js";
import {
  DECISION_RECEIPT_TYPE,
  DECISION_RECEIPT_VERSION,
} from "../types.js";

const EXECUTION_ID = "11111111-2222-3333-4444-555555555555";
const PARENT_RECEIPT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeTrace(): DebugTrace {
  return {
    execution_id: EXECUTION_ID,
    flow_id: "support-flow",
    flow_version: "3.1.0",
    status: "completed",
    started_at: "2026-01-01T10:00:00.000Z",
    finished_at: "2026-01-01T10:00:05.000Z",
    context: {},
    input_messages: [{ role: "user", content: "Meine E-Mail ist [PII:EMAIL_1]" }],
    nodes: [
      {
        node_id: "answer",
        node_type: "llm",
        status: "completed",
        started_at: "2026-01-01T10:00:00.100Z",
        finished_at: "2026-01-01T10:00:04.900Z",
        latency_ms: 4800,
        model: "openai/gpt-4o",
        input_tokens: 120,
        output_tokens: 60,
        cost: 0.0042,
        tool_calls: [
          {
            id: "call_rag_1",
            name: "retrieval/policy-docs",
            arguments: { query: "Kündigung Frist" },
            result: {
              collection: "policy-docs",
              retrieved: 2,
              chunks: [
                {
                  id: "chunk-1",
                  text: "geheimer Chunk-Text",
                  score: 0.9,
                  metadata: { revision_id: "rev-7" },
                },
                { id: "chunk-2", text: "noch mehr Text", score: 0.8 },
              ],
            },
            is_error: false,
            called_at: "2026-01-01T10:00:01.000Z",
          },
          {
            id: "call_tool_2",
            name: "crm/get_customer",
            arguments: { customer_id: "c-9" },
            result: { name: "[PII:NAME_1]" },
            is_error: false,
            called_at: "2026-01-01T10:00:02.000Z",
          },
        ],
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
    errors: [],
    final_response: "Die Kündigungsfrist beträgt 3 Monate.",
  };
}

function makeCtx(overrides: Partial<ReceiptBuildContext> = {}): ReceiptBuildContext {
  return {
    receiptId: PARENT_RECEIPT_ID,
    tenantId: "tenant-a",
    promptTemplateHash: sha256Canonical({ id: "support-flow" }),
    toolAuthzHash: "a".repeat(64),
    complianceHash: "b".repeat(64),
    piiSummary: {
      executionId: EXECUTION_ID,
      totalTokenized: 3,
      byType: { EMAIL: 2, IBAN: 1 },
      byDetector: { regex: 3 },
    },
    approvals: [
      {
        id: "appr-1",
        approved: true,
        tool: "crm/get_customer",
        nodeId: "answer",
        executionId: EXECUTION_ID,
        by: "reviewer@example.com",
        decidedAt: "2026-01-01T10:00:03.000Z",
      },
    ],
    ...overrides,
  };
}

describe("buildReceiptPayloads (Req 15.1, 15.2)", () => {
  test("one parent + one child per tool call", () => {
    const payloads = buildReceiptPayloads(makeTrace(), makeCtx());
    expect(payloads).toHaveLength(3);
    const parent = payloads[0];
    const children = payloads.slice(1);
    expect(parent?.kind).toBe("chat_completion");
    expect(parent?.parent_receipt_id).toBeNull();
    for (const child of children) {
      expect(child?.kind).toBe("tool_call");
      expect(child?.parent_receipt_id).toBe(PARENT_RECEIPT_ID);
      expect(child?.tool_calls).toHaveLength(1);
    }
  });

  test("parent carries every Req 15.2 field", () => {
    const [parent] = buildReceiptPayloads(makeTrace(), makeCtx());
    if (parent === undefined) throw new Error("missing parent payload");
    expect(parent.receipt_id).toBe(PARENT_RECEIPT_ID);
    expect(parent.typ).toBe(DECISION_RECEIPT_TYPE);
    expect(parent.version).toBe(DECISION_RECEIPT_VERSION);
    expect(parent.execution_id).toBe(EXECUTION_ID);
    expect(parent.tenant_id).toBe("tenant-a");
    expect(parent.flow_id).toBe("support-flow");
    expect(parent.flow_version).toBe("3.1.0");
    expect(parent.status).toBe("completed");
    // Policy hashes: prompt template, tool-authz, compliance.
    expect(parent.policy_hashes.prompt_template).toHaveLength(64);
    expect(parent.policy_hashes.tool_authz).toBe("a".repeat(64));
    expect(parent.policy_hashes.compliance).toBe("b".repeat(64));
    // Model + provider.
    expect(parent.models).toEqual([
      { model: "openai/gpt-4o", provider: "openai" },
    ]);
    // PII proof: types + counts, no values.
    expect(parent.pii).toEqual({
      total_tokenized: 3,
      by_type: { EMAIL: 2, IBAN: 1 },
      by_detector: { regex: 3 },
    });
    // Retrieval sources with revision ids.
    expect(parent.retrieval_sources).toHaveLength(1);
    const src = parent.retrieval_sources[0];
    if (src === undefined) throw new Error("missing retrieval source");
    expect(src.collection).toBe("policy-docs");
    expect(src.retrieved).toBe(2);
    expect(src.chunk_ids).toEqual(["chunk-1", "chunk-2"]);
    expect(src.revision_ids).toEqual(["rev-7"]);
    // Approval chain with approver + evidence hash.
    expect(parent.approvals).toHaveLength(1);
    const appr = parent.approvals[0];
    if (appr === undefined) throw new Error("missing approval");
    expect(appr.id).toBe("appr-1");
    expect(appr.approved).toBe(true);
    expect(appr.approver).toBe("reviewer@example.com");
    expect(appr.evidence_hash).toHaveLength(64);
    // Cost ledger.
    expect(parent.cost).toEqual({
      prompt_tokens: 120,
      completion_tokens: 60,
      total_tokens: 180,
      usd: 0.0042,
    });
    // Timestamps + response hash.
    expect(parent.started_at).toBe("2026-01-01T10:00:00.000Z");
    expect(parent.finished_at).toBe("2026-01-01T10:00:05.000Z");
    expect(parent.response_hash).toBe(
      sha256Hex("Die Kündigungsfrist beträgt 3 Monate."),
    );
    // Tool-call refs (hashes only).
    expect(parent.tool_calls).toHaveLength(2);
    for (const ref of parent.tool_calls) {
      expect(ref.argument_hash).toHaveLength(64);
      expect(ref.result_hash).toHaveLength(64);
    }
  });

  test("error trace yields status=error", () => {
    const trace = makeTrace();
    trace.status = "error";
    trace.final_response = undefined;
    const [parent] = buildReceiptPayloads(trace, makeCtx());
    expect(parent?.status).toBe("error");
    expect(parent?.response_hash).toBe("");
  });

  test("missing flow_version / tenant / pii degrade to null, never crash", () => {
    const trace = makeTrace();
    trace.flow_version = undefined;
    const payloads = buildReceiptPayloads(
      trace,
      makeCtx({ tenantId: null, piiSummary: undefined }),
    );
    const parent = payloads[0];
    expect(parent?.flow_version).toBeNull();
    expect(parent?.tenant_id).toBeNull();
    expect(parent?.pii).toBeNull();
  });

  test("no approvals / no tool calls yield empty collections", () => {
    const trace = makeTrace();
    trace.nodes = [{ ...trace.nodes[0] as (typeof trace.nodes)[number], tool_calls: [] }];
    const payloads = buildReceiptPayloads(trace, makeCtx({ approvals: [] }));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.approvals).toEqual([]);
    expect(payloads[0]?.tool_calls).toEqual([]);
    expect(payloads[0]?.retrieval_sources).toEqual([]);
  });
});

describe("childReceiptId (deterministic)", () => {
  test("same inputs → same id, UUID-shaped", () => {
    const a = childReceiptId(PARENT_RECEIPT_ID, "call_1");
    const b = childReceiptId(PARENT_RECEIPT_ID, "call_1");
    expect(a).toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(childReceiptId(PARENT_RECEIPT_ID, "call_2")).not.toBe(a);
  });
});

describe("payload PII-frei (Req 15.6)", () => {
  test("no raw content strings appear anywhere in the payload", () => {
    const payloads = buildReceiptPayloads(makeTrace(), makeCtx());
    const json = JSON.stringify(payloads);
    for (const secret of [
      "geheimer Chunk-Text",
      "noch mehr Text",
      "Kündigung Frist",
      "Die Kündigungsfrist beträgt 3 Monate.",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  test("rebuilding from the same trace is stable", () => {
    const trace = makeTrace();
    const a = JSON.stringify(buildReceiptPayloads(trace, makeCtx()));
    const b = JSON.stringify(buildReceiptPayloads(trace, makeCtx()));
    expect(a).toBe(b);
  });
});

describe("signReceiptPayload (COSE_Sign1 round-trip, Req 15.3)", () => {
  test("signature verifies against the raw public key", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKeyRaw = await exportEd25519RawPublicKey(pair.privateKey);
    const [payload] = buildReceiptPayloads(makeTrace(), makeCtx());
    if (payload === undefined) throw new Error("missing payload");
    const signed = await signReceiptPayload(payload, pair.privateKey, "kid-1");
    expect(signed.coseBytes.length).toBeGreaterThan(0);

    const decoded = cborDecodeSign1(signed.coseBytes);
    expect(await coseSign1Verify(decoded, publicKeyRaw)).toBe(true);
    // kid travels in the protected header.
    const header = decoded.protectedBytes;
    expect(header.length).toBeGreaterThan(0);
  });

  test("bit flip in the COSE bytes breaks verification", async () => {
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    const publicKeyRaw = await exportEd25519RawPublicKey(pair.privateKey);
    const [payload] = buildReceiptPayloads(makeTrace(), makeCtx());
    if (payload === undefined) throw new Error("missing payload");
    const signed = await signReceiptPayload(payload, pair.privateKey, "kid-1");
    const tampered = signed.coseBytes.slice();
    // Flip a byte inside the trailing signature byte string — the COSE
    // structure stays decodable, only the signature becomes invalid.
    const at = tampered.length - 5;
    tampered[at] = (tampered[at] ?? 0) ^ 0x01;
    const decoded = cborDecodeSign1(tampered);
    expect(await coseSign1Verify(decoded, publicKeyRaw)).toBe(false);
  });

  test("payload CBOR encoding is deterministic", () => {
    const [a] = buildReceiptPayloads(makeTrace(), makeCtx());
    const [b] = buildReceiptPayloads(makeTrace(), makeCtx());
    if (a === undefined || b === undefined) throw new Error("missing payload");
    const ha = sha256Hex(Buffer.from(cborEncodeReceiptPayload(a)).toString("hex"));
    const hb = sha256Hex(Buffer.from(cborEncodeReceiptPayload(b)).toString("hex"));
    expect(ha).toBe(hb);
  });
});

describe("marker constants", () => {
  test("COMPLIANCE_NONE_MARKER is stable", () => {
    expect(COMPLIANCE_NONE_MARKER).toBe("atf:compliance:none");
  });
});
