// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure-logic tests for the revision store's building blocks: the
 * Content-Digest normalisation, page-range algebra used to compute missing
 * ranges on commit, contract validation of an NDJSON batch, and referenced-
 * asset collection. These need no database — they pin the semantics the SQL
 * layer and the routes rely on.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAssetId } from "@atf/extract-contract";
import {
  collectReferencedAssetIds,
  commitCompleteness,
  computeBodyDigest,
  extractProvenanceOf,
  isUnitVisible,
  parseExtractProvenance,
  type UnitVisibilityContext,
  mergeRanges,
  missingRanges,
  normalizeContentDigest,
  validateBatchBody,
} from "../src/revision-store.js";

const REFERENCE = "akte/2026/doc.pdf";

/** A minimal valid v2 page record (page records carry no reference field). */
function pageRecord(page: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "page",
    page,
    size: { wPt: 595, hPt: 842 },
    class: "text",
    blocks: [],
    ...extra,
  });
}

describe("normalizeContentDigest", () => {
  it("accepts a bare lowercase hex sha256", () => {
    const hex = "a".repeat(64);
    expect(normalizeContentDigest(hex)).toBe(hex);
  });

  it("lowercases an uppercase hex digest", () => {
    const hex = "A".repeat(64);
    expect(normalizeContentDigest(hex)).toBe("a".repeat(64));
  });

  it("decodes an RFC 9530 structured sha-256 field to hex", () => {
    const body = Buffer.from("hello");
    const hex = createHash("sha256").update(body).digest("hex");
    const b64 = createHash("sha256").update(body).digest("base64");
    expect(normalizeContentDigest(`sha-256=:${b64}:`)).toBe(hex);
  });

  it("rejects an empty or malformed digest", () => {
    expect(normalizeContentDigest("")).toBeNull();
    expect(normalizeContentDigest("not-a-digest")).toBeNull();
    expect(normalizeContentDigest("md5=:abc:")).toBeNull();
  });

  it("computeBodyDigest agrees with a manual sha256", () => {
    const body = Buffer.from("some ndjson\n");
    expect(computeBodyDigest(body)).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
  });
});

describe("mergeRanges", () => {
  it("merges overlapping and adjacent ranges into a minimal cover", () => {
    expect(
      mergeRanges([
        { from: 1, to: 10 },
        { from: 11, to: 20 },
        { from: 5, to: 8 },
      ]),
    ).toEqual([{ from: 1, to: 20 }]);
  });

  it("keeps a genuine gap separate", () => {
    expect(
      mergeRanges([
        { from: 1, to: 10 },
        { from: 12, to: 20 },
      ]),
    ).toEqual([
      { from: 1, to: 10 },
      { from: 12, to: 20 },
    ]);
  });

  it("drops degenerate ranges (to < from)", () => {
    expect(mergeRanges([{ from: 5, to: 1 }])).toEqual([]);
  });
});

describe("missingRanges", () => {
  it("reports no gaps when the span is fully covered", () => {
    const covered = [
      { from: 1, to: 250 },
      { from: 251, to: 500 },
    ];
    expect(missingRanges(covered, { from: 1, to: 500 })).toEqual([]);
  });

  it("reports an interior gap", () => {
    const covered = [
      { from: 1, to: 100 },
      { from: 201, to: 300 },
    ];
    expect(missingRanges(covered, { from: 1, to: 300 })).toEqual([
      { from: 101, to: 200 },
    ]);
  });

  it("reports a leading and trailing gap", () => {
    const covered = [{ from: 50, to: 100 }];
    expect(missingRanges(covered, { from: 1, to: 200 })).toEqual([
      { from: 1, to: 49 },
      { from: 101, to: 200 },
    ]);
  });

  it("reports the whole span when nothing is covered", () => {
    expect(missingRanges([], { from: 1, to: 10 })).toEqual([{ from: 1, to: 10 }]);
  });
});

describe("validateBatchBody", () => {
  it("accepts a valid NDJSON page batch and derives its page range", () => {
    const body = Buffer.from(`${pageRecord(3)}\n${pageRecord(5)}\n`);
    const result = validateBatchBody(body, REFERENCE);
    expect(result.ok).toBe(true);
    expect(result.pages).toEqual({ from: 3, to: 5 });
  });

  it("rejects an empty batch with a machine-readable issue", () => {
    const result = validateBatchBody(Buffer.from("\n\n"), REFERENCE);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("empty"))).toBe(true);
  });

  it("rejects a non-JSON line with the offending line in the path", () => {
    const body = Buffer.from(`${pageRecord(1)}\nnot json here\n`);
    const result = validateBatchBody(body, REFERENCE);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.path).toContain("line[1]");
  });

  it("rejects a record that violates the contract schema with its issue list", () => {
    // A page record missing the required `size` field.
    const bad = JSON.stringify({ type: "page", page: 1, class: "text", blocks: [] });
    const result = validateBatchBody(Buffer.from(`${bad}\n`), REFERENCE);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.severity).toBe("error");
  });

  it("rejects a figure whose assetId is not derived from the reference", () => {
    const body = Buffer.from(
      `${pageRecord(1, {
        blocks: [
          {
            type: "figure",
            id: "b1",
            page: 1,
            figureId: "p1-f1",
            kind: "diagram",
            description: "A flow chart of the process.",
            assetId: "0".repeat(64), // wrong: not sha256(ref \n figureId)
          },
        ],
      })}\n`,
    );
    const result = validateBatchBody(body, REFERENCE);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path.includes("assetId"))).toBe(true);
  });
});

describe("collectReferencedAssetIds", () => {
  it("collects asset ids from page.assets and figure blocks", () => {
    const figureAssetId = buildAssetId(REFERENCE, "p1-f1");
    const pageAssetId = buildAssetId(REFERENCE, "page:p1");
    const body = Buffer.from(
      `${pageRecord(1, {
        assets: [
          { assetId: pageAssetId, localId: "page:p1", kind: "page", page: 1 },
        ],
        blocks: [
          {
            type: "figure",
            id: "b1",
            page: 1,
            figureId: "p1-f1",
            kind: "diagram",
            description: "A flow chart of the process.",
            assetId: figureAssetId,
          },
        ],
      })}\n`,
    );
    const ids = collectReferencedAssetIds([body]);
    expect(ids.has(figureAssetId)).toBe(true);
    expect(ids.has(pageAssetId)).toBe(true);
  });

  it("skips unparseable payloads without throwing", () => {
    const ids = collectReferencedAssetIds([Buffer.from("garbage"), null]);
    expect(ids.size).toBe(0);
  });
});

describe("commitCompleteness (Req 5.9)", () => {
  it("accepts full coverage of the declared page count", () => {
    expect(commitCompleteness({ accepted: [{ from: 1, to: 10 }], pageCount: 10, hasDocumentEnd: false })).toEqual({ ok: true });
  });

  it("reports a missing last page and missing first pages against the page count", () => {
    const last = commitCompleteness({ accepted: [{ from: 1, to: 9 }], pageCount: 10, hasDocumentEnd: true });
    expect(last.ok === false && last.missingRanges).toEqual([{ from: 10, to: 10 }]);
    const first = commitCompleteness({ accepted: [{ from: 3, to: 10 }], pageCount: 10, hasDocumentEnd: true });
    expect(first.ok === false && first.missingRanges).toEqual([{ from: 1, to: 2 }]);
  });

  it("requires document.end when the page count is unknown", () => {
    const res = commitCompleteness({ accepted: [{ from: 2, to: 5 }], pageCount: null, hasDocumentEnd: false });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("COMMIT_DOCUMENT_END_MISSING");
      expect(res.missingRanges).toEqual([{ from: 1, to: 1 }]);
    }
    const none = commitCompleteness({ accepted: [], pageCount: null, hasDocumentEnd: false });
    expect(none.ok === false && none.code).toBe("COMMIT_NO_BATCHES");
  });

  it("accepts an empty document declared with pageCount 0", () => {
    expect(commitCompleteness({ accepted: [], pageCount: 0, hasDocumentEnd: true })).toEqual({ ok: true });
  });
  describe("a pages window (contract 2.4, firstPage > 1)", () => {
    it("checks coverage over [firstPage, pageCount], not over [1, pageCount]", () => {
      expect(
        commitCompleteness({ accepted: [{ from: 5, to: 9 }], pageCount: 9, hasDocumentEnd: true, firstPage: 5 }),
      ).toEqual({ ok: true });
    });
    it("still reports a gap inside the window and a missing first or last page of it", () => {
      const inner = commitCompleteness({
        accepted: [{ from: 5, to: 6 }, { from: 8, to: 9 }],
        pageCount: 9,
        hasDocumentEnd: true,
        firstPage: 5,
      });
      expect(inner.ok === false && inner.missingRanges).toEqual([{ from: 7, to: 7 }]);
      const first = commitCompleteness({ accepted: [{ from: 6, to: 9 }], pageCount: 9, hasDocumentEnd: true, firstPage: 5 });
      expect(first.ok === false && first.missingRanges).toEqual([{ from: 5, to: 5 }]);
      const last = commitCompleteness({ accepted: [{ from: 5, to: 8 }], pageCount: 9, hasDocumentEnd: true, firstPage: 5 });
      expect(last.ok === false && last.missingRanges).toEqual([{ from: 9, to: 9 }]);
    });
    it("without a firstPage the pages before the window are missing (a 2.3 stream is unchanged)", () => {
      const res = commitCompleteness({ accepted: [{ from: 5, to: 9 }], pageCount: 9, hasDocumentEnd: true });
      expect(res.ok === false && res.missingRanges).toEqual([{ from: 1, to: 4 }]);
    });
    it("uses firstPage for the gaps of an open stream too", () => {
      const res = commitCompleteness({ accepted: [{ from: 6, to: 7 }], pageCount: null, hasDocumentEnd: false, firstPage: 5 });
      expect(res.ok === false && res.missingRanges).toEqual([{ from: 5, to: 5 }]);
    });
  });
});

describe("isUnitVisible (Req 6.4, 5.11)", () => {
  const base: UnitVisibilityContext = {
    status: "partial",
    visibility: "progressive",
    reference: REFERENCE,
    commitState: null,
    pointsHere: true,
    segments: [{ from: 1, to: 10 }],
  };

  it("is visible inside a committed segment of a progressive revision the pointer names", () => {
    expect(isUnitVisible(base, 3, 4)).toBe(true);
    expect(isUnitVisible(base, 11, 12)).toBe(false);
  });

  it("is never visible when the pointer names another revision", () => {
    expect(isUnitVisible({ ...base, pointsHere: false }, 3, 4)).toBe(false);
    expect(isUnitVisible({ ...base, pointsHere: false, status: "committed" }, 3, 4)).toBe(false);
  });

  it("an on_commit revision is visible only once committed", () => {
    expect(isUnitVisible({ ...base, visibility: "on_commit" }, 3, 4)).toBe(false);
    expect(isUnitVisible({ ...base, visibility: "on_commit", status: "committed" }, 3, 4)).toBe(true);
  });

  it("a unit without a page range overlaps any committed segment", () => {
    expect(isUnitVisible(base, null, null)).toBe(true);
    expect(isUnitVisible({ ...base, segments: [] }, null, null)).toBe(false);
  });
});

describe("validateBatchBody · staging metadata", () => {
  it("captures page count, document.end and referenced asset ids", () => {
    const figureAssetId = buildAssetId(REFERENCE, "p1-f1");
    const lines = [
      {
        type: "document.begin",
        contract: "atf-extract/2.0.0",
        reference: REFERENCE,
        source: { filename: "d.pdf", mimeType: "application/pdf", bytes: 1, sha256: "a".repeat(64) },
        pipeline: { extractor: "t" },
        pageCount: 4,
      },
      {
        type: "page",
        page: 1,
        size: { wPt: 1, hPt: 1 },
        class: "text",
        blocks: [{ type: "figure", id: "b1", page: 1, figureId: "p1-f1", kind: "diagram", description: "d", assetId: figureAssetId }],
      },
      { type: "document.end", reference: REFERENCE, pageCount: 5 },
    ];
    const body = Buffer.from(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const res = validateBatchBody(body, REFERENCE);
    expect(res.ok).toBe(true);
    expect(res.beginPageCount).toBe(4);
    expect(res.endPageCount).toBe(5);
    expect(res.hasDocumentEnd).toBe(true);
    expect(res.assetIds).toEqual([figureAssetId]);
    expect(res.pages).toEqual({ from: 1, to: 1 });
  });
});

describe("Extract provenance (Req 18.2)", () => {
  const begin = (pipeline: Record<string, unknown>) =>
    Buffer.from(
      `${JSON.stringify({
        type: "document.begin",
        contract: "atf-extract/2.0.0",
        reference: REFERENCE,
        source: { filename: "d.pdf", mimeType: "application/pdf", bytes: 1, sha256: "a".repeat(64) },
        pipeline: { extractor: "t", ...pipeline },
      })}\n`,
    );

  it("validateBatchBody captures contract, pipelineVersion and promptHash from document.begin", () => {
    const res = validateBatchBody(begin({ pipelineVersion: "pv-1", promptHash: "ph-1" }), REFERENCE);
    expect(res.ok).toBe(true);
    expect(res.extractProvenance).toEqual({
      contract: "atf-extract/2.0.0",
      pipelineVersion: "pv-1",
      promptHash: "ph-1",
    });
  });

  it("omits absent pipeline fields and yields no provenance for a batch without document.begin", () => {
    expect(validateBatchBody(begin({}), REFERENCE).extractProvenance).toEqual({
      contract: "atf-extract/2.0.0",
    });
    const page = Buffer.from(`${pageRecord(1)}\n`);
    expect(validateBatchBody(page, REFERENCE).extractProvenance).toBeUndefined();
  });

  it("parseExtractProvenance accepts the persisted shape and rejects malformed values", () => {
    expect(extractProvenanceOf({ contract: "c", pipeline: { promptHash: "h" } })).toEqual({
      contract: "c",
      promptHash: "h",
    });
    expect(parseExtractProvenance({ contract: "c", pipelineVersion: "v", promptHash: 3 })).toEqual({
      contract: "c",
      pipelineVersion: "v",
    });
    expect(parseExtractProvenance(null)).toBeUndefined();
    expect(parseExtractProvenance([])).toBeUndefined();
    expect(parseExtractProvenance({ pipelineVersion: "v" })).toBeUndefined();
  });
});
