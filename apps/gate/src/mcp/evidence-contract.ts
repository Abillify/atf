// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";

export const EVIDENCE_ACTION_CONTRACT_META_KEY = "evidence/actionContract";
export const EVIDENCE_ACTION_CONTRACT_HASH_META_KEY = "evidence/actionContractHash";
export const EVIDENCE_CONTRACT_HASH_META_KEY = "evidence/evidenceContractHash";
export const EVIDENCE_PACK_HASH_META_KEY = "evidence/evidencePackHash";
export const EVIDENCE_ACTION_CONTRACTS_META_KEY = "evidence/actionContracts";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/iu.test(result)) {
    throw new Error(`${label} must be a SHA-256 hex digest`);
  }
  return result.toLowerCase();
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
  if (stable(value) !== raw) {
    throw new Error("Evidence action contract must use canonical JSON");
  }

  const contract = record(value, "Evidence action contract");
  allowOnly(contract, ["schemaVersion", "action", "evidence"], "Evidence action contract");
  if (contract.schemaVersion !== "v1") {
    throw new Error("Evidence action contract schemaVersion must be v1");
  }
  const action = record(contract.action, "Evidence action contract action");
  allowOnly(action, ["tool", "argsHash"], "Evidence action contract action");
  if (nonEmptyString(action.tool, "Evidence action contract action.tool") !== tool) {
    throw new Error("Evidence action contract tool does not match the requested tool");
  }
  if (hash(action.argsHash, "Evidence action contract action.argsHash") !== sha256(stable(args))) {
    throw new Error("Evidence action contract arguments do not match the requested action");
  }

  const evidence = record(contract.evidence, "Evidence action contract evidence");
  allowOnly(evidence, ["packId", "retrievedAt", "items"], "Evidence action contract evidence");
  const evidencePackHash = hash(evidence.packId, "Evidence action contract evidence.packId");
  if (declaredEvidencePackHash !== undefined && declaredEvidencePackHash !== evidencePackHash) {
    throw new Error("Evidence pack hash does not match the contract");
  }
  nonEmptyString(evidence.retrievedAt, "Evidence action contract evidence.retrievedAt");
  if (!Array.isArray(evidence.items) || evidence.items.length === 0) {
    throw new Error("Evidence action contract must bind at least one evidence item");
  }
  const evidenceIds = new Set<string>();
  let previousId: string | undefined;
  for (const item of evidence.items) {
    const entry = record(item, "Evidence action contract evidence item");
    allowOnly(
      entry,
      ["evidenceId", "snapshotHash", "contentHash", "version", "modifiedAt", "dataClassification"],
      "Evidence action contract evidence item",
    );
    const evidenceId = hash(entry.evidenceId, "Evidence action contract evidence item ID");
    if (previousId !== undefined && previousId.localeCompare(evidenceId) >= 0) {
      throw new Error("Evidence action contract evidence items must be sorted and unique");
    }
    previousId = evidenceId;
    evidenceIds.add(evidenceId);
    hash(entry.snapshotHash, "Evidence action contract snapshot hash");
    hash(entry.contentHash, "Evidence action contract content hash");
    nonEmptyString(entry.version, "Evidence action contract evidence version");
    nonEmptyString(entry.modifiedAt, "Evidence action contract evidence modifiedAt");
  }
  if (evidenceIds.size !== evidence.items.length) {
    throw new Error("Evidence action contract evidence item IDs must be unique");
  }

  const computedHash = sha256(raw);
  if (declaredHash !== undefined && declaredHash !== computedHash) {
    throw new Error("Evidence action contract hash does not match the contract");
  }
  return computedHash;
}
