// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
  canonicalJson,
  EVIDENCE_ACTION_CONTRACT_HASH_META_KEY,
  EVIDENCE_ACTION_CONTRACT_META_KEY,
  EVIDENCE_CONTRACT_HASH_META_KEY,
  EVIDENCE_PACK_HASH_META_KEY,
  inspectEvidenceActionContract,
  sha256Hex,
  type EvidenceActionContractV1,
} from "@atf/evidence-contract";

// The wire metadata keys and the action-contract shape are defined once in
// `@atf/evidence-contract` (Req 11.3); the Runtime re-exports them under its
// established names instead of keeping its own copies.
export {
  EVIDENCE_ACTION_CONTRACT_HASH_META_KEY,
  EVIDENCE_ACTION_CONTRACT_META_KEY,
  EVIDENCE_CONTRACT_HASH_META_KEY,
  EVIDENCE_PACK_HASH_META_KEY,
};

export type EvidenceActionContract = EvidenceActionContractV1;

export interface EvidenceActionContractMeta {
  contract: EvidenceActionContract;
  serialized: string;
  /** Preferred name: hash of the canonical action contract. */
  actionContractHash: string;
  /** Compatibility alias for actionContractHash during migration. */
  evidenceContractHash: string;
  /** Hash of the response evidence pack only (the verified packId). */
  evidencePackHash: string;
  /** @deprecated Use actionContractHash. */
  hash: string;
}

const stable = canonicalJson;
const sha256 = sha256Hex;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest`);
  }
  return result;
}

function candidates(value: unknown): Record<string, unknown>[] {
  const queue: unknown[] = [value];
  const found: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "string") {
      try {
        queue.push(JSON.parse(current) as unknown);
      } catch {
        // A non-JSON text result cannot be a verified evidence pack.
      }
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const entry = object(current);
    if (entry === undefined || seen.has(entry)) continue;
    seen.add(entry);
    found.push(entry);
    if (entry.content !== undefined) queue.push(entry.content);
    if (entry.structuredContent !== undefined) queue.push(entry.structuredContent);
  }
  return found;
}

interface VerifiedEvidencePack {
  pack: Record<string, unknown>;
  evidencePackHash: unknown;
}

function packFrom(value: unknown): VerifiedEvidencePack | undefined {
  for (const candidate of candidates(value)) {
    if (candidate.evidence === undefined) continue;
    if (candidate.schemaVersion === "v2" && candidate.evidencePackHash !== undefined) {
      return { pack: candidate, evidencePackHash: candidate.evidencePackHash };
    }
    if (candidate.schemaVersion === "v1" && candidate.packId !== undefined) {
      return { pack: candidate, evidencePackHash: candidate.packId };
    }
  }
  return undefined;
}

/**
 * Builds a compact, canonical action contract from a vectorsearch verified
 * evidence pack. It intentionally excludes query and passage text: provenance
 * hashes are sufficient to bind the action without copying untrusted content
 * into governance metadata.
 */
export function createEvidenceActionContract(
  tool: string,
  args: Record<string, unknown>,
  evidence: unknown,
): EvidenceActionContract | undefined {
  const verifiedPack = packFrom(evidence);
  if (verifiedPack === undefined) return undefined;
  const { pack, evidencePackHash } = verifiedPack;
  const safety = object(pack.safety);
  if (safety?.contentTrust !== "untrusted") {
    throw new Error("Verified evidence pack must declare untrusted content");
  }
  const rawEvidence = pack.evidence;
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
    throw new Error("Verified evidence pack must contain at least one evidence item");
  }

  const items = rawEvidence.map((value) => {
    const item = object(value);
    if (item === undefined) throw new Error("Verified evidence pack item must be an object");
    const provenance = object(item.provenance);
    if (provenance === undefined) throw new Error("Verified evidence pack item provenance is required");
    const itemSafety = object(item.safety);
    if (itemSafety?.contentTrust !== "untrusted") {
      throw new Error("Verified evidence pack item must declare untrusted content");
    }
    return {
      evidenceId: hash(item.evidenceId, "Evidence ID"),
      snapshotHash: hash(provenance.snapshotHash, "Evidence snapshot hash"),
      contentHash: hash(provenance.contentHash, "Evidence content hash"),
      version: nonEmptyString(provenance.version, "Evidence version"),
      modifiedAt: nonEmptyString(provenance.modifiedAt, "Evidence modifiedAt"),
      ...(typeof itemSafety?.dataClassification === "string" && itemSafety.dataClassification !== ""
        ? { dataClassification: itemSafety.dataClassification }
        : {}),
    };
  });
  items.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (new Set(items.map((item) => item.evidenceId)).size !== items.length) {
    throw new Error("Verified evidence pack contains duplicate evidence IDs");
  }

  return {
    schemaVersion: "v1",
    action: { tool, argsHash: sha256(stable(args)) },
    evidence: {
      // The v1 contract field name is retained for hash compatibility; its
      // value is the canonical pack hash from either v1 or v2.
      packId: hash(evidencePackHash, "Evidence pack hash"),
      retrievedAt: nonEmptyString(pack.retrievedAt, "Evidence pack retrievedAt"),
      items,
    },
  };
}

export function serializeEvidenceActionContract(
  contract: EvidenceActionContract,
): EvidenceActionContractMeta {
  // Canonicalisation, hashing and schema validation come from the contract
  // package; the deprecated `hash` alias stays for current consumers.
  const inspected = inspectEvidenceActionContract(contract);
  return {
    ...inspected,
    contract,
    hash: inspected.actionContractHash,
  };
}

/** Rebinds an existing provenance contract to the final wire-level action arguments. */
export function bindEvidenceActionContract(
  contract: EvidenceActionContract,
  args: Record<string, unknown>,
): EvidenceActionContractMeta {
  return serializeEvidenceActionContract({
    ...contract,
    action: { ...contract.action, argsHash: sha256(stable(args)) },
  });
}
