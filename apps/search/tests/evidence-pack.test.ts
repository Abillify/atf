// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { buildVerifiedEvidencePack } from "../src/evidence-pack.js";
import type { SearchResult } from "../src/postgres-client.js";

const instant = new Date("2026-03-01T00:00:00.000Z");

function result(validFrom: Date | null): SearchResult {
  return {
    id: "1",
    score: 0.9,
    content: "policy text",
    metadata: { version: "v1" },
    reference: "policy_v1",
    base_ref: "policy",
    created: instant,
    modified: instant,
    valid_from: validFrom,
    effective_valid_from: instant,
  };
}

function pack(validFrom: Date | null) {
  return buildVerifiedEvidencePack({
    collection: "policies",
    query: "retention",
    effectiveQuery: "retention",
    accessScopeFingerprint: "scope",
    results: [result(validFrom)],
    requestedLimit: 10,
    retrievedAt: "2026-09-11T00:00:00.000Z",
    hybrid: false,
    hydeApplied: false,
    reranked: false,
    includeAllVersions: false,
    candidateMultiplier: 4,
    fetchLimit: 10,
    sparseApplied: false,
  });
}

describe("verified evidence temporal provenance", () => {
  it("binds explicit valid_from separately from the created-time fallback", () => {
    const legacy = pack(null);
    const explicit = pack(instant);

    expect(legacy.evidence[0]?.provenance.effectiveValidFrom).toBe(
      explicit.evidence[0]?.provenance.effectiveValidFrom,
    );
    expect(legacy.evidence[0]?.provenance.validFrom).toBeNull();
    expect(explicit.evidence[0]?.provenance.validFrom).toBe(instant.toISOString());
    expect(legacy.evidence[0]?.provenance.snapshotHash).not.toBe(
      explicit.evidence[0]?.provenance.snapshotHash,
    );
    expect(legacy.evidencePackHash).not.toBe(explicit.evidencePackHash);
  });
});
