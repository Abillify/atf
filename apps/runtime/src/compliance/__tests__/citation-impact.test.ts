// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the citation impact core (`src/compliance/citation-impact.ts`).
 *
 * Pins pair grouping (distinct pairs, deduplicated executions), block
 * formation for the Search citation check (> 500 pairs), the report
 * aggregation (affected = executions with a changed/removed cited pair,
 * distinct-pair chunk counters) and the Ed25519 signature envelope over the
 * canonical JSON form without `signature`.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  buildCitationImpactReport,
  chunkCheckItems,
  citationImpactSigningBytes,
  CITATION_CHECK_MAX_ITEMS,
  type CitationCheckResult,
  type CitationPairGroup,
  groupRowsByPair,
  parseCitationCheckResponse,
  signCitationImpact,
} from "../citation-impact.js";
import {
  parseEvidenceSigningKey,
  verifyEvidenceBytes,
  evidencePublicKeyFromRaw,
} from "../../observability/evidence-key.js";

function exec(executionId: string, overrides = {}) {
  return {
    executionId,
    flowId: "flows/test",
    flowVersion: "1.0.0",
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("groupRowsByPair", () => {
  it("groups rows into distinct pairs preserving first-seen order", () => {
    const groups = groupRowsByPair([
      { ...exec("e1"), baseRef: "doc-a", chunkId: "c1" },
      { ...exec("e2"), baseRef: "doc-b", chunkId: "c2" },
      { ...exec("e3"), baseRef: "doc-a", chunkId: "c1" },
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]?.baseRef).toBe("doc-a");
    expect(groups[0]?.executions.map((e) => e.executionId)).toEqual([
      "e1",
      "e3",
    ]);
    expect(groups[1]?.executions.map((e) => e.executionId)).toEqual(["e2"]);
  });

  it("deduplicates the same execution appearing twice for one pair", () => {
    const groups = groupRowsByPair([
      { ...exec("e1"), baseRef: "doc-a", chunkId: "c1" },
      { ...exec("e1"), baseRef: "doc-a", chunkId: "c1" },
    ]);
    expect(groups.length).toBe(1);
    expect(groups[0]?.executions.length).toBe(1);
  });

  it("deduplicates an execution repeated across interleaved pairs", () => {
    const groups = groupRowsByPair([
      { ...exec("e1"), baseRef: "doc-a", chunkId: "c1" },
      { ...exec("e1"), baseRef: "doc-b", chunkId: "c2" },
      { ...exec("e1"), baseRef: "doc-a", chunkId: "c1" },
    ]);
    expect(groups.length).toBe(2);
    expect(groups[0]?.executions.length).toBe(1);
    expect(groups[1]?.executions.length).toBe(1);
  });

  it("keeps executions of different pairs separate", () => {
    const groups = groupRowsByPair([
      { ...exec("e1"), baseRef: "doc-a", chunkId: "c1" },
      { ...exec("e1"), baseRef: "doc-a", chunkId: "c2" },
    ]);
    expect(groups.length).toBe(2);
    expect(groups.every((g) => g.executions.length === 1)).toBe(true);
  });
});

describe("chunkCheckItems", () => {
  it("splits more than 500 pairs into blocks of at most 500", () => {
    const items = Array.from({ length: 1_201 }, (_, i) => ({
      base_ref: `doc-${i}`,
      chunk_id: `c-${i}`,
    }));
    const blocks = chunkCheckItems(items);
    expect(blocks.length).toBe(3);
    expect(blocks[0]?.length).toBe(CITATION_CHECK_MAX_ITEMS);
    expect(blocks[1]?.length).toBe(CITATION_CHECK_MAX_ITEMS);
    expect(blocks[2]?.length).toBe(201);
    // No pair lost or duplicated.
    const flat = blocks.flat();
    expect(flat.length).toBe(1_201);
    expect(flat[0]?.base_ref).toBe("doc-0");
    expect(flat[1_200]?.base_ref).toBe("doc-1200");
  });

  it("returns no block for an empty input", () => {
    expect(chunkCheckItems([]).length).toBe(0);
  });
});

describe("parseCitationCheckResponse", () => {
  it("degrades an unknown status value to unknown", () => {
    const parsed = parseCitationCheckResponse({
      checked_at: "2026-10-20T00:00:00Z",
      results: [
        { base_ref: "a", chunk_id: "c", status: "exploded" },
        { base_ref: "b", chunk_id: "c", status: "removed" },
      ],
    });
    expect(parsed.results[0]?.status).toBe("unknown");
    expect(parsed.results[1]?.status).toBe("removed");
  });

  it("throws on a body without a results array", () => {
    expect(() => parseCitationCheckResponse({})).toThrow();
    expect(() => parseCitationCheckResponse(null)).toThrow();
  });
});

function group(
  baseRef: string,
  chunkId: string,
  executionIds: string[],
): CitationPairGroup {
  return {
    baseRef,
    chunkId,
    executions: executionIds.map((id) => exec(id)),
  };
}

describe("buildCitationImpactReport", () => {
  const since = "2026-07-01T00:00:00.000Z";

  it("marks an execution affected on a changed pair and counts statuses", () => {
    const groups = [
      group("doc-a", "c1", ["e1", "e2"]),
      group("doc-a", "c2", ["e1"]),
      group("doc-b", "c9", ["e3"]),
    ];
    const results: CitationCheckResult[] = [
      { base_ref: "doc-a", chunk_id: "c1", status: "changed", current_revision: "7" },
      { base_ref: "doc-a", chunk_id: "c2", status: "current" },
      { base_ref: "doc-b", chunk_id: "c9", status: "removed" },
    ];
    const report = buildCitationImpactReport(groups, results, {
      generatedAt: "2026-10-20T12:00:00.000Z",
      since,
      tenantId: "acme",
    });
    expect(report.summary).toEqual({
      executions_checked: 3,
      executions_affected: 3,
      chunks: { current: 1, carried: 0, changed: 1, removed: 1, unknown: 0 },
    });
    const e1 = report.affected.find((a) => a.execution_id === "e1");
    expect(e1?.chunks).toEqual([
      {
        base_ref: "doc-a",
        chunk_id: "c1",
        status: "changed",
        current_revision: "7",
      },
    ]);
    const e2 = report.affected.find((a) => a.execution_id === "e2");
    expect(e2?.flow_id).toBe("flows/test");
    const e3 = report.affected.find((a) => a.execution_id === "e3");
    expect(e3?.chunks[0]?.status).toBe("removed");
    expect(report.tenant_id).toBe("acme");
  });

  it("counts a pair without a check result as unknown", () => {
    const report = buildCitationImpactReport(
      [group("doc-a", "c1", ["e1"])],
      [],
      { generatedAt: "2026-10-20T12:00:00.000Z", since, tenantId: null },
    );
    expect(report.summary.chunks.unknown).toBe(1);
    expect(report.summary.executions_affected).toBe(0);
    expect(report.tenant_id).toBeNull();
  });

  it("carried pairs do not make an execution affected", () => {
    const report = buildCitationImpactReport(
      [group("doc-a", "c1", ["e1"])],
      [{ base_ref: "doc-a", chunk_id: "c1", status: "carried" }],
      { generatedAt: "2026-10-20T12:00:00.000Z", since, tenantId: null },
    );
    expect(report.summary.executions_affected).toBe(0);
    expect(report.affected.length).toBe(0);
  });
});

describe("signCitationImpact / citationImpactSigningBytes", () => {
  // A fixed 32-byte Ed25519 seed (base64) so the kid is deterministic.
  const key = parseEvidenceSigningKey(
    Buffer.alloc(32, 11).toString("base64"),
  ) as NonNullable<ReturnType<typeof parseEvidenceSigningKey>>;

  const unsigned = {
    generated_at: "2026-10-20T12:00:00.000Z",
    since: "2026-07-01T00:00:00.000Z",
    tenant_id: "acme",
    summary: {
      executions_checked: 3,
      executions_affected: 1,
      chunks: { current: 1, carried: 0, changed: 1, removed: 0, unknown: 1 },
    },
    affected: [
      {
        execution_id: "e1",
        flow_id: "flows/test",
        flow_version: "1.0.0",
        created_at: "2026-10-01T10:00:00.000Z",
        chunks: [
          {
            base_ref: "doc-a",
            chunk_id: "c1",
            status: "changed" as const,
            current_revision: "7",
          },
        ],
      },
    ],
  };

  it("produces a signature that verifies against the public key", () => {
    const signed = signCitationImpact(unsigned, key);
    expect(signed.signature?.alg).toBe("EdDSA");
    expect(signed.signature?.kid).toBe(key.kid);
    expect(
      verifyEvidenceBytes(
        evidencePublicKeyFromRaw(key.publicKeyRaw),
        citationImpactSigningBytes(signed),
        signed.signature?.value ?? "",
      ),
    ).toBe(true);
  });

  it("signing bytes exclude the signature field", () => {
    const signed = signCitationImpact(unsigned, key);
    // Adding a signature must not change the bytes covered by the signature.
    expect(citationImpactSigningBytes(signed)).toBe(
      citationImpactSigningBytes(unsigned),
    );
  });

  it("a tampered report no longer verifies", () => {
    const signed = signCitationImpact(unsigned, key);
    const tampered = {
      ...signed,
      summary: { ...signed.summary, executions_affected: 99 },
    };
    expect(
      verifyEvidenceBytes(
        evidencePublicKeyFromRaw(key.publicKeyRaw),
        citationImpactSigningBytes(tampered),
        signed.signature?.value ?? "",
      ),
    ).toBe(false);
  });

  it("a key generated at runtime verifies independently", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seed = privateKey
      .export({ format: "jwk" })
      .d as string;
    const runtimeKey = parseEvidenceSigningKey(
      Buffer.from(seed, "base64url").toString("base64"),
    ) as NonNullable<ReturnType<typeof parseEvidenceSigningKey>>;
    const signed = signCitationImpact(unsigned, runtimeKey);
    expect(
      verifyEvidenceBytes(
        publicKey,
        citationImpactSigningBytes(signed),
        signed.signature?.value ?? "",
      ),
    ).toBe(true);
  });
});
