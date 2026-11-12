// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure helpers of the MCP wrapper: transaction metadata, contract hashes, capability
 * documents, approval input requests. Split out of `client.ts` unchanged.
 */

import crypto from "node:crypto";
import {
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
export { StreamableHTTPError };
import type {
  CapabilityDocument,
  EnforcementMode,
  TransactionMeta,
} from "../../transaction/types.js";
import {
  EVIDENCE_ACTION_CONTRACT_HASH_META_KEY,
  EVIDENCE_ACTION_CONTRACT_META_KEY,
  EVIDENCE_CONTRACT_HASH_META_KEY,
  EVIDENCE_PACK_HASH_META_KEY,
  type EvidenceActionContractMeta,
} from "../../transaction/evidence-contract.js";
import type { McpApprovalInputRequest } from "./tool-proxy.js";

/**
 * Hashes a caller bearer so it can key a cache entry without keeping the
 * credential itself in a long-lived map key.
 */
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalContractHash(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

/** Builds additive MCP metadata understood by v1 peers and ignored by legacy peers. */
export function buildTransactionMeta(
  invocationId: string,
  transaction?: TransactionMeta,
  evidenceContract?: EvidenceActionContractMeta,
): Record<string, string | number> {
  const preferredActionHash =
    transaction?.actionContractHash === undefined
      ? undefined
      : canonicalContractHash(transaction.actionContractHash, "Action-contract hash");
  const compatibilityActionHash =
    transaction?.evidenceContractHash === undefined
      ? undefined
      : canonicalContractHash(transaction.evidenceContractHash, "Evidence-contract hash");
  if (
    preferredActionHash !== undefined &&
    compatibilityActionHash !== undefined &&
    preferredActionHash !== compatibilityActionHash
  ) {
    throw new Error("Action-contract hash aliases must be identical");
  }
  const suppliedActionHash = preferredActionHash ?? compatibilityActionHash;
  const evidenceActionHash =
    evidenceContract === undefined
      ? undefined
      : canonicalContractHash(evidenceContract.actionContractHash, "Evidence action-contract hash");
  const evidenceCompatibilityHash =
    evidenceContract === undefined
      ? undefined
      : canonicalContractHash(evidenceContract.evidenceContractHash, "Evidence contract hash");
  if (
    evidenceActionHash !== undefined &&
    evidenceCompatibilityHash !== undefined &&
    evidenceActionHash !== evidenceCompatibilityHash
  ) {
    throw new Error("Evidence action-contract hash aliases must be identical");
  }
  if (
    suppliedActionHash !== undefined &&
    evidenceActionHash !== undefined &&
    suppliedActionHash !== evidenceActionHash
  ) {
    throw new Error("Evidence action contract does not match the transaction token");
  }
  const evidencePackHash =
    evidenceContract === undefined
      ? undefined
      : canonicalContractHash(evidenceContract.evidencePackHash, "Evidence pack hash");
  const trace = transaction?.trace;
  return {
    "transaction/invocationId": invocationId,
    "transaction/idempotencyKey": invocationId,
    // Compatibility aliases retained for existing peers during rolling upgrades.
    "aiperator/invocationId": invocationId,
    "aiperator/idempotencyKey": invocationId,
    ...(transaction?.token !== undefined
      ? {
          "transaction/token": transaction.token,
          // Compatibility during rolling upgrades of downstream peers.
          "aiperator/transactionToken": transaction.token,
        }
      : {}),
    ...(evidenceContract !== undefined
      ? {
          [EVIDENCE_ACTION_CONTRACT_META_KEY]: evidenceContract.serialized,
          [EVIDENCE_ACTION_CONTRACT_HASH_META_KEY]: evidenceActionHash,
          [EVIDENCE_CONTRACT_HASH_META_KEY]: evidenceActionHash,
          [EVIDENCE_PACK_HASH_META_KEY]: evidencePackHash,
        }
      : {}),
    ...(trace?.traceId !== undefined ? { "transaction/traceId": trace.traceId } : {}),
    ...(trace?.spanId !== undefined ? { "transaction/spanId": trace.spanId } : {}),
    ...(trace?.traceparent !== undefined ? { traceparent: trace.traceparent } : {}),
    ...(trace?.deadlineAt !== undefined ? { "transaction/deadlineAt": trace.deadlineAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Recursively Unicode-normalizes every string in a tool-argument value to NFC
 * (canonical composition), the W3C-recommended interchange form.
 *
 * Why: a model copies path-like arguments (`reference`, `path_prefix`, …) from
 * text we injected — filenames that, on macOS-ingested stores, are keyed in NFD
 * (decomposed, e.g. "a" + U+0308 for "ä"). The model reliably emits the
 * visually identical *precomposed* NFC form (U+00E4), so a byte-exact server
 * lookup misses and returns "0 results / not found" (observed in trace
 * 7c8b7dc5: every `list_documents`/`get_document` into `…/Qualitätsmanagement/…`
 * failed while ASCII paths worked). Normalizing outgoing args to the canonical
 * NFC form here — the single chokepoint through which ALL MCP tool calls pass —
 * makes the wire form deterministic regardless of which normalization the model
 * happened to copy, so it matches an NFC-normalizing store (see the sibling
 * vectorsearch server fix). NFC is idempotent and meaning-preserving for text,
 * so this is a no-op for ASCII args and safe for every server.
 */
export function nfcNormalizeDeep(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(nfcNormalizeDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = nfcNormalizeDeep(v);
    }
    return out;
  }
  return value;
}

export function parseCapabilityDocument(
  serverName: string,
  result: unknown,
): CapabilityDocument | undefined {
  const content =
    result !== null && typeof result === "object" && "content" in result
      ? (result as { content?: unknown }).content
      : undefined;
  const text = Array.isArray(content)
    ? content.find(
        (part): part is { text: string } =>
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string",
      )?.text
    : undefined;
  if (text === undefined) return undefined;

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (raw.protocol !== "v1" && raw.version !== "v1" && raw.schemaVersion !== "v1") {
    return undefined;
  }
  const token =
    raw.token !== null && typeof raw.token === "object"
      ? (raw.token as Record<string, unknown>)
      : {};
  const algorithms = Array.isArray(raw.signingAlgorithms)
    ? raw.signingAlgorithms.filter((value): value is string => typeof value === "string")
    : typeof token.algorithm === "string"
      ? [token.algorithm]
      : [];
  if (!algorithms.includes("HS256")) return undefined;
  const enforcement: EnforcementMode =
    raw.enforcement === "off" || raw.enforcement === "optional" || raw.enforcement === "required"
      ? raw.enforcement
      : "optional";
  const audiences = Array.isArray(raw.audiences)
    ? raw.audiences.filter((value): value is string => typeof value === "string")
    : typeof raw.audience === "string"
      ? [raw.audience]
      : [serverName];
  const features =
    raw.features !== null && typeof raw.features === "object"
      ? (raw.features as Record<string, unknown>)
      : {};
  return {
    protocol: "v1",
    issuer: typeof raw.issuer === "string" ? raw.issuer : serverName,
    audiences: audiences.length > 0 ? audiences : [serverName],
    enforcement,
    signingAlgorithms: ["HS256"],
    features: {
      idempotency:
        features.idempotency === true ||
        (raw.idempotency !== null && typeof raw.idempotency === "object"),
      budgets: features.budgets === true || Array.isArray(raw.budgets),
      compensation: features.compensation === true,
      evidenceLineage: features.evidenceLineage === true,
    },
    maxTokenTtlSeconds:
      typeof raw.maxTokenTtlSeconds === "number" && raw.maxTokenTtlSeconds > 0
        ? raw.maxTokenTtlSeconds
        : 300,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Accepts only the MCP-2026 approval request shape; unknown input kinds stay opaque. */
export function parseApprovalInputRequests(value: unknown): McpApprovalInputRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): McpApprovalInputRequest[] => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const request = candidate as Record<string, unknown>;
    if (
      request.type !== "approval" ||
      typeof request.requestState !== "string" ||
      request.requestState === "" ||
      typeof request.title !== "string" ||
      typeof request.message !== "string"
    )
      return [];
    const fields = Array.isArray(request.fields)
      ? request.fields.flatMap((candidate): NonNullable<McpApprovalInputRequest["fields"]> => {
          if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
            return [];
          const field = candidate as Record<string, unknown>;
          return typeof field.name === "string" &&
            typeof field.label === "string" &&
            "value" in field
            ? [{ name: field.name, label: field.label, value: field.value }]
            : [];
        })
      : undefined;
    return [
      {
        type: "approval",
        requestState: request.requestState,
        title: request.title,
        message: request.message,
        ...(fields !== undefined ? { fields } : {}),
        ...(typeof request.expiresAt === "string" ? { expiresAt: request.expiresAt } : {}),
      },
    ];
  });
}
