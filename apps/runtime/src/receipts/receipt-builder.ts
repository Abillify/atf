// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision_Receipt builder (Req 15.1, 15.2, 15.6).
 *
 * Assembles the receipt payload for one finished execution from data the
 * runtime already records — the sealed Debug_Trace, the PII-Vault action
 * summary, resolved approvals, the tool-authz / compliance policy hashes and
 * the flow definition — and signs it as COSE_Sign1 (Ed25519, WebCrypto) over
 * the deterministic CBOR encoding of the payload.
 *
 * PII constraint (Req 15.6): nothing personal enters the payload. Content is
 * reduced to SHA-256 digests, PII to type/count maps, retrieval to chunk ids.
 * The builder runs INSIDE the engine decorator stack below the PII vault, so
 * the trace it reads still carries vault placeholders, not raw PII.
 *
 * One chat completion yields one `chat_completion` receipt plus one
 * `tool_call` receipt per tool call observed in the trace (Req 15.1), each
 * child linked to the parent via `parent_receipt_id`.
 */

import { createHash } from "node:crypto";

import { canonicalJson as canonicalizeJson } from "@atf/canonical-json";
import {
  cborDecode,
  cborDecodeSign1,
  cborEncode,
  coseSign1,
  cborEncodeSign1,
  type CborValue,
} from "@atf/security-kit";

import type { DebugTrace, DebugToolCall } from "../types/debug-trace.js";
import type { PiiVaultActionSummary } from "../graph/pii-vault.js";
import type { ResolvedApproval } from "../graph/approval-gate.js";
import type {
  DecisionReceiptPayload,
  ReceiptApproval,
  ReceiptCost,
  ReceiptModelUsage,
  ReceiptRetrievalSource,
  ReceiptToolCallRef,
  SignedDecisionReceipt,
} from "./types.js";
import {
  DECISION_RECEIPT_TYPE,
  DECISION_RECEIPT_VERSION,
} from "./types.js";

/** Marker recorded as the compliance policy hash when no policy is loaded. */
export const COMPLIANCE_NONE_MARKER = "atf:compliance:none";

/** SHA-256 hex over a UTF-8 string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** SHA-256 hex over the canonical JSON form of a structured value. */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalizeJson(value));
}

/** Inputs the builder needs beyond the sealed trace. */
export interface ReceiptBuildContext {
  /** Stable receipt id (UUID) for the chat-completion receipt. */
  receiptId: string;
  /** Tenant (client id) scope, when the request was authenticated. */
  tenantId: string | null;
  /** SHA-256 over the canonical flow definition (prompt template), or null. */
  promptTemplateHash: string | null;
  /** `ToolAuthzEngine.policyHash()` at execution time. */
  toolAuthzHash: string;
  /** SHA-256 over the canonical compliance policy, or the none-marker. */
  complianceHash: string;
  /** PII-Vault action summary for this execution, when the vault is active. */
  piiSummary: PiiVaultActionSummary | undefined;
  /** Approvals resolved during this execution. */
  approvals: readonly ResolvedApproval[];
}

function toNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Split "provider/model" into its parts; provider is null when unqualified. */
function splitModel(model: string): ReceiptModelUsage {
  const slash = model.indexOf("/");
  return slash > 0
    ? { model, provider: model.slice(0, slash) }
    : { model, provider: null };
}

function collectModels(trace: DebugTrace): ReceiptModelUsage[] {
  const seen = new Map<string, ReceiptModelUsage>();
  for (const node of trace.nodes) {
    if (typeof node.model !== "string" || node.model.length === 0) continue;
    if (!seen.has(node.model)) seen.set(node.model, splitModel(node.model));
  }
  return [...seen.values()];
}

function collectCost(trace: DebugTrace): ReceiptCost {
  let usd = 0;
  for (const node of trace.nodes) usd += toNumber(node.cost);
  return {
    prompt_tokens: toNumber(trace.usage?.prompt_tokens),
    completion_tokens: toNumber(trace.usage?.completion_tokens),
    total_tokens: toNumber(trace.usage?.total_tokens),
    usd: Math.round(usd * 1e9) / 1e9,
  };
}

/** Pull chunk ids / revision ids out of a RAG retrieval tool result. */
function parseRetrievalResult(
  name: string,
  result: unknown,
): ReceiptRetrievalSource {
  const collection = name.startsWith("retrieval/")
    ? name.slice("retrieval/".length)
    : name;
  const source: ReceiptRetrievalSource = {
    collection,
    retrieved: 0,
    chunk_ids: [],
    revision_ids: [],
  };
  if (result === null || typeof result !== "object") return source;
  const rec = result as Record<string, unknown>;
  if (typeof rec.retrieved === "number") source.retrieved = rec.retrieved;
  const chunks = rec.chunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      if (chunk === null || typeof chunk !== "object") continue;
      const c = chunk as Record<string, unknown>;
      if (typeof c.id === "string") source.chunk_ids.push(c.id);
      const revision =
        typeof c.revision_id === "string"
          ? c.revision_id
          : c.metadata !== null && typeof c.metadata === "object"
            ? (c.metadata as Record<string, unknown>).revision_id
            : undefined;
      if (typeof revision === "string" && !source.revision_ids.includes(revision))
        source.revision_ids.push(revision);
    }
  }
  return source;
}

function toolCallRef(nodeId: string, call: DebugToolCall): ReceiptToolCallRef {
  return {
    id: call.id,
    name: call.name,
    node_id: nodeId,
    argument_hash: sha256Canonical(call.arguments ?? null),
    result_hash:
      call.result === null || call.result === undefined
        ? ""
        : sha256Canonical(call.result),
    is_error: call.is_error,
    called_at: call.called_at,
  };
}

function approvalRecord(a: ResolvedApproval): ReceiptApproval {
  return {
    id: a.id,
    approved: a.approved,
    tool: a.tool ?? null,
    approver: a.by ?? null,
    evidence_hash: sha256Canonical({
      id: a.id,
      approved: a.approved,
      tool: a.tool ?? null,
      node_id: a.nodeId ?? null,
      execution_id: a.executionId ?? null,
      by: a.by ?? null,
      timed_out: a.timedOut ?? false,
    }),
  };
}

/** Encode the payload into a deterministic CBOR map (all keys explicit). */
export function cborEncodeReceiptPayload(
  payload: DecisionReceiptPayload,
): Uint8Array {
  const models: CborValue[] = payload.models.map((m) => ({
    model: m.model,
    provider: m.provider,
  }));
  const retrieval: CborValue[] = payload.retrieval_sources.map((s) => ({
    collection: s.collection,
    retrieved: s.retrieved,
    chunk_ids: s.chunk_ids,
    revision_ids: s.revision_ids,
  }));
  const approvals: CborValue[] = payload.approvals.map((a) => ({
    id: a.id,
    approved: a.approved,
    tool: a.tool,
    approver: a.approver,
    evidence_hash: a.evidence_hash,
  }));
  const toolCalls: CborValue[] = payload.tool_calls.map((t) => ({
    id: t.id,
    name: t.name,
    node_id: t.node_id,
    argument_hash: t.argument_hash,
    result_hash: t.result_hash,
    is_error: t.is_error,
    called_at: t.called_at,
  }));
  return cborEncode({
    receipt_id: payload.receipt_id,
    typ: payload.typ,
    version: payload.version,
    kind: payload.kind,
    parent_receipt_id: payload.parent_receipt_id,
    execution_id: payload.execution_id,
    tenant_id: payload.tenant_id,
    flow_id: payload.flow_id,
    flow_version: payload.flow_version,
    status: payload.status,
    policy_hashes: {
      prompt_template: payload.policy_hashes.prompt_template,
      tool_authz: payload.policy_hashes.tool_authz,
      compliance: payload.policy_hashes.compliance,
    },
    models,
    pii:
      payload.pii === null
        ? null
        : {
            total_tokenized: payload.pii.total_tokenized,
            by_type: payload.pii.by_type,
            by_detector: payload.pii.by_detector,
          },
    retrieval_sources: retrieval,
    approvals,
    tool_calls: toolCalls,
    cost: {
      prompt_tokens: payload.cost.prompt_tokens,
      completion_tokens: payload.cost.completion_tokens,
      total_tokens: payload.cost.total_tokens,
      usd: payload.cost.usd,
    },
    started_at: payload.started_at,
    finished_at: payload.finished_at,
    response_hash: payload.response_hash,
  });
}

/**
 * Decode the payload of a signed receipt (COSE_Sign1 bytes) back into its
 * JSON view — the inverse of {@link cborEncodeReceiptPayload}, which writes
 * every field explicitly. Used to serve receipts that are no longer in the
 * in-memory store but are still in the durable transparency log. Does NOT
 * verify the signature (the COSE bytes stay the authoritative artifact);
 * returns `undefined` for anything that is not a receipt payload.
 */
export function decodeReceiptPayload(
  coseBytes: Uint8Array,
): DecisionReceiptPayload | undefined {
  let value: CborValue;
  try {
    value = cborDecode(cborDecodeSign1(coseBytes).payload);
  } catch {
    return undefined;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array ||
    "entries" in value ||
    "tag" in value
  ) {
    return undefined;
  }
  const record = value as Record<string, CborValue>;
  if (
    record["typ"] !== DECISION_RECEIPT_TYPE ||
    typeof record["receipt_id"] !== "string"
  ) {
    return undefined;
  }
  return record as unknown as DecisionReceiptPayload;
}

function basePayload(
  trace: DebugTrace,
  ctx: ReceiptBuildContext,
): DecisionReceiptPayload {
  const finishedAt =
    trace.finished_at ?? new Date().toISOString();
  const responseHash =
    typeof trace.final_response === "string"
      ? sha256Hex(trace.final_response)
      : "";
  return {
    receipt_id: ctx.receiptId,
    typ: DECISION_RECEIPT_TYPE,
    version: DECISION_RECEIPT_VERSION,
    kind: "chat_completion",
    parent_receipt_id: null,
    execution_id: trace.execution_id,
    tenant_id: ctx.tenantId,
    flow_id: trace.flow_id ?? "",
    flow_version: trace.flow_version ?? null,
    status: trace.status === "error" ? "error" : "completed",
    policy_hashes: {
      prompt_template: ctx.promptTemplateHash,
      tool_authz: ctx.toolAuthzHash,
      compliance: ctx.complianceHash,
    },
    models: collectModels(trace),
    pii:
      ctx.piiSummary === undefined
        ? null
        : {
            total_tokenized: ctx.piiSummary.totalTokenized,
            by_type: { ...ctx.piiSummary.byType },
            by_detector: { ...ctx.piiSummary.byDetector },
          },
    retrieval_sources: [],
    approvals: ctx.approvals.map(approvalRecord),
    tool_calls: [],
    cost: collectCost(trace),
    started_at: trace.started_at,
    finished_at: finishedAt,
    response_hash: responseHash,
  };
}

/** Every tool call observed in the trace, in node order. */
function allToolCalls(trace: DebugTrace): { nodeId: string; call: DebugToolCall }[] {
  const out: { nodeId: string; call: DebugToolCall }[] = [];
  for (const node of trace.nodes) {
    for (const call of node.tool_calls ?? []) {
      out.push({ nodeId: node.node_id, call });
    }
  }
  return out;
}

/**
 * Deterministic child receipt id: the first 32 hex digits of
 * `sha256(parent|tool-call id)` formatted as a UUID. Rebuilding a receipt from
 * the same trace yields the same child ids.
 */
export function childReceiptId(
  parentReceiptId: string,
  toolCallId: string,
): string {
  const h = sha256Hex(`${parentReceiptId}|${toolCallId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Build the chat-completion receipt payload plus one `tool_call` payload per
 * tool call in the trace (Req 15.1). Child receipt ids are derived
 * deterministically from the parent id and the tool-call id so a replay of
 * the same inputs yields the same ids.
 */
export function buildReceiptPayloads(
  trace: DebugTrace,
  ctx: ReceiptBuildContext,
): DecisionReceiptPayload[] {
  const parent = basePayload(trace, ctx);
  const calls = allToolCalls(trace);
  parent.tool_calls = calls.map(({ nodeId, call }) =>
    toolCallRef(nodeId, call),
  );
  parent.retrieval_sources = calls
    .filter(({ call }) => call.name.startsWith("retrieval/"))
    .map(({ call }) => parseRetrievalResult(call.name, call.result));

  const out: DecisionReceiptPayload[] = [parent];
  for (const { nodeId, call } of calls) {
    const child = basePayload(trace, {
      ...ctx,
      receiptId: childReceiptId(parent.receipt_id, call.id),
    });
    child.kind = "tool_call";
    child.parent_receipt_id = parent.receipt_id;
    child.tool_calls = [toolCallRef(nodeId, call)];
    child.retrieval_sources = call.name.startsWith("retrieval/")
      ? [parseRetrievalResult(call.name, call.result)]
      : [];
    child.response_hash =
      call.result === null || call.result === undefined
        ? ""
        : sha256Canonical(call.result);
    out.push(child);
  }
  return out;
}

/** Sign one payload as COSE_Sign1 (Ed25519) over its CBOR encoding. */
export async function signReceiptPayload(
  payload: DecisionReceiptPayload,
  privateKey: CryptoKey,
  kid: string,
): Promise<SignedDecisionReceipt> {
  const payloadBytes = cborEncodeReceiptPayload(payload);
  const message = await coseSign1(privateKey, payloadBytes, { kid });
  return { payload, coseBytes: cborEncodeSign1(message) };
}
