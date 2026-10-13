// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision_Receipt payload model (Req 15.1, 15.2, 15.6).
 *
 * A Decision_Receipt attests ONE completed AI interaction: either a full chat
 * completion (`kind: "chat_completion"`) or a single tool call
 * (`kind: "tool_call"`, linked to its parent completion receipt via
 * `parent_receipt_id`). The payload is CBOR-encoded and signed as COSE_Sign1
 * (see `receipt-builder.ts`).
 *
 * PII constraint (Req 15.6): the payload carries NO personal data in clear
 * text — only hashes, counts, types, ids and structural metadata. Retrieval
 * sources list chunk ids, never chunk text; PII proof lists types and counts
 * without values; content appears only as SHA-256 hashes.
 */

/** Type URI placed in the COSE protected header and the payload. */
export const DECISION_RECEIPT_TYPE = "atf.decision-receipt";

/** Payload schema version — bump on incompatible field changes. */
export const DECISION_RECEIPT_VERSION = 1;

/** What a receipt attests. */
export type DecisionReceiptKind = "chat_completion" | "tool_call";

/** SHA-256 hex digests over the policy artifacts in force at execution time. */
export interface ReceiptPolicyHashes {
  /**
   * Hash over the canonical JSON of the resolved flow definition (the prompt
   * template and node configuration). `null` when the definition was not
   * reachable at build time (documented gap, never a fabricated digest).
   */
  prompt_template: string | null;
  /**
   * Hash over the canonical JSON of the active tool-authorization policy, or
   * the documented marker `atf:tool-authz:noop` / `atf:tool-authz:deny-all`
   * when no real policy was loaded.
   */
  tool_authz: string;
  /**
   * Hash over the canonical JSON of the active compliance policy, or the
   * marker `atf:compliance:none` when no policy is loaded.
   */
  compliance: string;
}

/** One model/provider pair observed in the execution (Req 15.2). */
export interface ReceiptModelUsage {
  model: string;
  /** Provider prefix of `model` ("openai" for "openai/gpt-4o"); null when unqualified. */
  provider: string | null;
}

/**
 * PII-tokenization proof (Req 15.2): types and counts WITHOUT any values.
 * Mirrors `PiiVaultActionSummary` from `graph/pii-vault.ts`.
 */
export interface ReceiptPiiProof {
  total_tokenized: number;
  by_type: Record<string, number>;
  by_detector: Record<string, number>;
}

/** One RAG retrieval source with its revision provenance (Req 15.2). */
export interface ReceiptRetrievalSource {
  collection: string;
  retrieved: number;
  /** Chunk ids returned by the retrieval call — never chunk text. */
  chunk_ids: string[];
  /**
   * Revision ids carried in the chunk metadata when the retrieval backend
   * supplies them (`revision_id` / `metadata.revision_id`); empty otherwise.
   */
  revision_ids: string[];
}

/** One resolved human approval in the approval chain (Req 15.2). */
export interface ReceiptApproval {
  id: string;
  approved: boolean;
  tool: string | null;
  /** Approver identifier (reviewer id / subject), null when unknown. */
  approver: string | null;
  /** SHA-256 over the canonical JSON of the approval record fields. */
  evidence_hash: string;
}

/** Reference to one tool call, content reduced to hashes (Req 15.1, 15.6). */
export interface ReceiptToolCallRef {
  /** Tool-call id assigned by the LLM (or synthetic id for retrieval). */
  id: string;
  /** Full tool reference, e.g. "myserver/tool" or "retrieval/my-collection". */
  name: string;
  /** Graph node that made the call. */
  node_id: string;
  /** SHA-256 over the canonical JSON of the (tokenized) call arguments. */
  argument_hash: string;
  /** SHA-256 over the canonical JSON of the tool result; empty string when null. */
  result_hash: string;
  is_error: boolean;
  /** ISO-8601 timestamp when the call was initiated. */
  called_at: string;
}

/** Cost ledger of the execution (Req 15.2). */
export interface ReceiptCost {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Sum of per-node estimated USD cost; 0 when unpriced. */
  usd: number;
}

/**
 * The complete Decision_Receipt payload. Every field is CBOR-encodable
 * (strings, numbers, booleans, null, arrays, string-keyed maps). `undefined`
 * never appears — absent values are `null` or empty collections.
 */
export interface DecisionReceiptPayload {
  receipt_id: string;
  typ: typeof DECISION_RECEIPT_TYPE;
  version: number;
  kind: DecisionReceiptKind;
  /** For `tool_call` receipts: the id of the enclosing chat-completion receipt. */
  parent_receipt_id: string | null;
  execution_id: string;
  /** Tenant (client id) scope of the execution; null when unauthenticated. */
  tenant_id: string | null;
  flow_id: string;
  flow_version: string | null;
  status: "completed" | "error";
  policy_hashes: ReceiptPolicyHashes;
  models: ReceiptModelUsage[];
  pii: ReceiptPiiProof | null;
  retrieval_sources: ReceiptRetrievalSource[];
  approvals: ReceiptApproval[];
  tool_calls: ReceiptToolCallRef[];
  cost: ReceiptCost;
  started_at: string;
  finished_at: string;
  /** SHA-256 over the response content (chat completion) or tool result. */
  response_hash: string;
}

/** A receipt after signing: payload plus the COSE_Sign1 wire form. */
export interface SignedDecisionReceipt {
  payload: DecisionReceiptPayload;
  /** Serialized CBOR COSE_Sign1 (RFC 9052 4-element array). */
  coseBytes: Uint8Array;
}
