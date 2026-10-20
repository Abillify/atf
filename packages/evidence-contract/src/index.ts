// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";
import { canonicalJsonLocale } from "@atf/canonical-json";
import { z } from "zod";

export const EVIDENCE_ACTION_CONTRACT_VERSION = "1.0.0" as const;
export const EvidenceActionSchema = z.object({
  version: z.literal(EVIDENCE_ACTION_CONTRACT_VERSION),
  transactionId: z.string().uuid(),
  action: z.string().min(1),
  outcome: z.enum(["allowed", "denied", "observed"]),
  recordedAt: z.string().datetime(),
  digest: z.string().min(16),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EvidenceAction = z.infer<typeof EvidenceActionSchema>;

export const EVIDENCE_ACTION_CONTRACT_META_KEY = "evidence/actionContract";
export const EVIDENCE_ACTION_CONTRACT_HASH_META_KEY = "evidence/actionContractHash";
export const EVIDENCE_CONTRACT_HASH_META_KEY = "evidence/evidenceContractHash";
export const EVIDENCE_PACK_HASH_META_KEY = "evidence/evidencePackHash";
export const EVIDENCE_ACTION_CONTRACTS_META_KEY = "evidence/actionContracts";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const EvidenceActionContractV1Schema = z.object({
  schemaVersion: z.literal("v1"),
  action: z.object({ tool: z.string().min(1), argsHash: Sha256Schema }).strict(),
  evidence: z.object({
    packId: Sha256Schema,
    retrievedAt: z.string().min(1),
    items: z.array(z.object({
      evidenceId: Sha256Schema,
      snapshotHash: Sha256Schema,
      contentHash: Sha256Schema,
      version: z.string().min(1),
      modifiedAt: z.string().min(1),
      dataClassification: z.string().optional(),
    }).strict()).min(1),
  }).strict(),
}).strict().superRefine((contract, context) => {
  const ids = contract.evidence.items.map((item) => item.evidenceId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && ids[index - 1]!.localeCompare(id) >= 0)) {
    context.addIssue({ code: "custom", path: ["evidence", "items"], message: "Evidence items must be sorted and unique" });
  }
});
export type EvidenceActionContractV1 = z.infer<typeof EvidenceActionContractV1Schema>;

export interface EvidenceActionContractMeta {
  contract: EvidenceActionContractV1;
  serialized: string;
  actionContractHash: string;
  evidenceContractHash: string;
  evidencePackHash: string;
}

/**
 * Canonical JSON for action contracts. The bytes are FROZEN: they feed
 * `actionContractHash` values that are issued, transmitted between Gate /
 * Runtime / Search, verified against previously recorded digests, and stored
 * in audit events. The implementation lives in `@atf/canonical-json` as the
 * `canonicalJsonLocale` mode (concat serializer, `localeCompare` key order,
 * `undefined` members serialised as `null`) — deliberately NOT the default
 * mode, because both the comparator and the serializer are observable in
 * already-issued hashes. Byte-identity is proven by
 * `packages/canonical-json/test/differential.test.ts`.
 */
export const canonicalJson = canonicalJsonLocale;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function inspectEvidenceActionContract(value: unknown): EvidenceActionContractMeta {
  const contract = EvidenceActionContractV1Schema.parse(value);
  const serialized = canonicalJson(contract);
  const actionContractHash = sha256Hex(serialized);
  return {
    contract,
    serialized,
    actionContractHash,
    evidenceContractHash: actionContractHash,
    evidencePackHash: contract.evidence.packId,
  };
}
