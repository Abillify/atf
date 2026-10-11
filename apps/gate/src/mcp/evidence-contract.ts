// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
  EvidenceActionContractV1Schema,
  EVIDENCE_ACTION_CONTRACT_HASH_META_KEY,
  EVIDENCE_ACTION_CONTRACT_META_KEY,
  EVIDENCE_ACTION_CONTRACTS_META_KEY,
  EVIDENCE_CONTRACT_HASH_META_KEY,
  EVIDENCE_PACK_HASH_META_KEY,
  canonicalJson,
  sha256Hex,
} from "@atf/evidence-contract";
import type { ZodIssue } from "zod";

/**
 * The wire metadata keys are defined once in `@atf/evidence-contract` (Req 11.3)
 * and re-exported here so gate modules keep a single import surface.
 */
export {
  EVIDENCE_ACTION_CONTRACT_HASH_META_KEY,
  EVIDENCE_ACTION_CONTRACT_META_KEY,
  EVIDENCE_ACTION_CONTRACTS_META_KEY,
  EVIDENCE_CONTRACT_HASH_META_KEY,
  EVIDENCE_PACK_HASH_META_KEY,
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function allowOnly(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field '${key}'`);
  }
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!/^[a-f0-9]{64}$/iu.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return value.toLowerCase();
}

/**
 * Lower-cases SHA-256 hex strings at the contract's hash positions so the shared
 * contract schema (lower-case only) keeps accepting the mixed-case encodings the
 * gate has always tolerated on the wire. Runs on the freshly parsed JSON, after
 * the canonical-string check, so the recomputed digest of `raw` is unaffected.
 */
function normalizeContractHashes(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const contract = value as Record<string, unknown>;
  const action = contract.action;
  if (action !== null && typeof action === "object" && !Array.isArray(action)) {
    const entry = action as Record<string, unknown>;
    if (typeof entry.argsHash === "string")
      entry.argsHash = entry.argsHash.toLowerCase();
  }
  const evidence = contract.evidence;
  if (
    evidence !== null &&
    typeof evidence === "object" &&
    !Array.isArray(evidence)
  ) {
    const pack = evidence as Record<string, unknown>;
    if (typeof pack.packId === "string")
      pack.packId = pack.packId.toLowerCase();
    if (Array.isArray(pack.items)) {
      for (const item of pack.items) {
        if (item === null || typeof item !== "object" || Array.isArray(item))
          continue;
        const entry = item as Record<string, unknown>;
        for (const key of [
          "evidenceId",
          "snapshotHash",
          "contentHash",
        ] as const) {
          const current = entry[key];
          if (typeof current === "string") entry[key] = current.toLowerCase();
        }
      }
    }
  }
  return contract;
}

/** Maps a contract-schema issue path onto the gate's stable wire error label. */
function contractLabel(path: PropertyKey[]): string {
  const [head, second, index, third] = path;
  if (path.length === 0) return "Evidence action contract";
  if (head === "schemaVersion") return "Evidence action contract schemaVersion";
  if (head === "action") {
    return second === undefined
      ? "Evidence action contract action"
      : `Evidence action contract action.${String(second)}`;
  }
  if (head === "evidence") {
    if (second === undefined) return "Evidence action contract evidence";
    if (second !== "items")
      return `Evidence action contract evidence.${String(second)}`;
    if (index === undefined) return "Evidence action contract evidence items";
    if (third === undefined) return "Evidence action contract evidence item";
    if (third === "evidenceId")
      return "Evidence action contract evidence item ID";
    if (third === "snapshotHash")
      return "Evidence action contract snapshot hash";
    if (third === "contentHash") return "Evidence action contract content hash";
    if (third === "version") return "Evidence action contract evidence version";
    if (third === "modifiedAt")
      return "Evidence action contract evidence modifiedAt";
    return `Evidence action contract evidence item.${String(third)}`;
  }
  return `Evidence action contract.${String(head)}`;
}

/** Translates a shared-schema violation into the gate's established error wording. */
function contractIssueMessage(issue: ZodIssue): string {
  if (issue.path[0] === "schemaVersion") {
    return "Evidence action contract schemaVersion must be v1";
  }
  const label = contractLabel(issue.path);
  switch (issue.code) {
    case "unrecognized_keys": {
      const [key] = issue.keys;
      return `${label} contains unsupported field '${key ?? ""}'`;
    }
    case "custom":
      return "Evidence action contract evidence items must be sorted and unique";
    case "too_small":
      return issue.path[issue.path.length - 1] === "items"
        ? "Evidence action contract must bind at least one evidence item"
        : `${label} must be a non-empty string`;
    case "invalid_format":
      return `${label} must be a SHA-256 hex digest`;
    case "invalid_type":
      if (issue.expected === "object") return `${label} must be an object`;
      if (issue.expected === "array")
        return "Evidence action contract must bind at least one evidence item";
      return `${label} must be a non-empty string`;
    default:
      return `${label} is invalid`;
  }
}

/**
 * Returns the canonical digest of an Evidence-Bound Action Contract carried in
 * MCP metadata. A contract is optional for legacy calls, but malformed,
 * non-canonical, or action-mismatched contracts fail closed.
 */
export function evidenceActionContractHash(
  meta: Record<string, unknown> | undefined,
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  const bundled = meta?.[EVIDENCE_ACTION_CONTRACTS_META_KEY];
  if (bundled !== undefined) {
    const singletonKeys = [
      EVIDENCE_ACTION_CONTRACT_META_KEY,
      EVIDENCE_ACTION_CONTRACT_HASH_META_KEY,
      EVIDENCE_CONTRACT_HASH_META_KEY,
      EVIDENCE_PACK_HASH_META_KEY,
    ];
    const mixedKeys = singletonKeys.filter((key) => meta?.[key] !== undefined);
    if (mixedKeys.length > 0) {
      throw new Error(
        `Evidence action contracts bundle cannot be combined with singleton metadata: ${mixedKeys.join(", ")}`,
      );
    }
    if (!Array.isArray(bundled) || bundled.length === 0) {
      throw new Error("Evidence action contracts metadata must be a non-empty array");
    }
    const matches: string[] = [];
    for (const candidate of bundled) {
      const item = record(candidate, "Evidence action contract bundle item");
      allowOnly(
        item,
        ["contract", "actionContractHash", "evidenceContractHash"],
        "Evidence action contract bundle item",
      );
      const preferred =
        item.actionContractHash === undefined
          ? undefined
          : hash(item.actionContractHash, "Action contract hash");
      const alias =
        item.evidenceContractHash === undefined
          ? undefined
          : hash(item.evidenceContractHash, "Evidence contract hash alias");
      if (preferred !== undefined && alias !== undefined && preferred !== alias) {
        throw new Error("Action contract hash conflicts with evidenceContractHash alias");
      }
      try {
        const result = evidenceActionContractHash(
          {
            [EVIDENCE_ACTION_CONTRACT_META_KEY]: item.contract,
            ...((preferred ?? alias) !== undefined
              ? { [EVIDENCE_ACTION_CONTRACT_HASH_META_KEY]: preferred ?? alias }
              : {}),
          },
          tool,
          args,
        );
        if (result !== undefined) matches.push(result);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!message.includes("does not match the requested")) throw cause;
      }
    }
    if (matches.length === 0) throw new Error("No Action Contract matches the requested action");
    if (matches.length > 1) throw new Error("Multiple Action Contracts match the requested action");
    return matches[0];
  }
  const raw = meta?.[EVIDENCE_ACTION_CONTRACT_META_KEY];
  const preferredHashValue = meta?.[EVIDENCE_ACTION_CONTRACT_HASH_META_KEY];
  const aliasHashValue = meta?.[EVIDENCE_CONTRACT_HASH_META_KEY];
  const evidencePackHashValue = meta?.[EVIDENCE_PACK_HASH_META_KEY];
  if (
    raw === undefined &&
    preferredHashValue === undefined &&
    aliasHashValue === undefined &&
    evidencePackHashValue === undefined
  )
    return undefined;
  if (typeof raw !== "string") {
    throw new Error("Evidence action contract metadata is required");
  }
  const preferredHash =
    preferredHashValue === undefined
      ? undefined
      : hash(preferredHashValue, "Evidence action contract hash");
  const aliasHash =
    aliasHashValue === undefined ? undefined : hash(aliasHashValue, "Evidence contract hash alias");
  if (preferredHash !== undefined && aliasHash !== undefined && preferredHash !== aliasHash) {
    throw new Error("Action contract hash conflicts with evidenceContractHash alias");
  }
  const declaredHash = preferredHash ?? aliasHash;
  const declaredEvidencePackHash =
    evidencePackHashValue === undefined
      ? undefined
      : hash(evidencePackHashValue, "Evidence pack hash");

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Evidence action contract must be valid JSON");
  }
  if (canonicalJson(value) !== raw) {
    throw new Error("Evidence action contract must use canonical JSON");
  }

  const parsed = EvidenceActionContractV1Schema.safeParse(
    normalizeContractHashes(value),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      issue === undefined
        ? "Evidence action contract is invalid"
        : contractIssueMessage(issue),
    );
  }

  if (parsed.data.action.tool !== tool) {
    throw new Error(
      "Evidence action contract tool does not match the requested tool",
    );
  }
  if (parsed.data.action.argsHash !== sha256Hex(canonicalJson(args))) {
    throw new Error(
      "Evidence action contract arguments do not match the requested action",
    );
  }
  if (
    declaredEvidencePackHash !== undefined &&
    declaredEvidencePackHash !== parsed.data.evidence.packId
  ) {
    throw new Error("Evidence pack hash does not match the contract");
  }

  const computedHash = sha256Hex(raw);
  if (declaredHash !== undefined && declaredHash !== computedHash) {
    throw new Error("Evidence action contract hash does not match the contract");
  }
  return computedHash;
}
