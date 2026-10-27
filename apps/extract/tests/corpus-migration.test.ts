// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * corpus-migration.test.ts
 *
 * Unit + property tests for the PURE core of the corpus re-ingest / migration
 * tool (task 5.6, requirements 17.3, 17.4): the manifest parser, the
 * usage-ordering (Req 17.3), the asset-id-stability check (Req 17.4), the plan
 * builder, the run summary and the formatters. Everything here runs offline —
 * no Extract/Search server — which is exactly the guarantee the tool upholds.
 *
 * The asset-id proof imports the REAL `buildAssetId` from `@atf/extract-contract`
 * (never a re-implemented hash), so the test pins that a re-extraction of an
 * existing corpus produces byte-identical ids for the same reference + local id.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildAssetId, figureLocalId, pageLocalId } from "@atf/extract-contract";
import {
  buildMigrationPlan,
  checkAssetIdStability,
  expectedAssetIds,
  formatPlan,
  formatSummary,
  localIdFor,
  type ManifestAsset,
  type ManifestEntry,
  type MigrationOutcome,
  orderByUsage,
  parseManifest,
  summarizeRun,
  usageWeight,
} from "../src/jobs/corpus-migration.js";

// ─── parseManifest ─────────────────────────────────────────────────────────────

describe("parseManifest", () => {
  it("parses a JSON array", () => {
    const { entries, warnings } = parseManifest('[{"reference":"a.pdf"},{"reference":"b.pdf"}]');
    expect(entries.map((e) => e.reference)).toEqual(["a.pdf", "b.pdf"]);
    expect(warnings).toEqual([]);
  });

  it("parses a { documents: [] } wrapper", () => {
    const { entries } = parseManifest('{"documents":[{"reference":"a.pdf"}]}');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reference).toBe("a.pdf");
  });

  it("parses a single object", () => {
    const { entries } = parseManifest('{"reference":"solo.pdf","hitCount":3}');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.hitCount).toBe(3);
  });

  it("parses NDJSON, one object per line", () => {
    const { entries } = parseManifest('{"reference":"a.pdf"}\n\n{"reference":"b.pdf"}\n');
    expect(entries.map((e) => e.reference)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("returns empty for empty text", () => {
    expect(parseManifest("   ").entries).toEqual([]);
  });

  it("skips entries with no reference and warns", () => {
    const { entries, warnings } = parseManifest('[{"reference":"a.pdf"},{"foo":1}]');
    expect(entries).toHaveLength(1);
    expect(warnings.some((w) => w.includes("reference"))).toBe(true);
  });

  it("skips malformed NDJSON lines and warns with a line number", () => {
    const { entries, warnings } = parseManifest('{"reference":"a.pdf"}\nnot json\n{"reference":"b.pdf"}');
    expect(entries.map((e) => e.reference)).toEqual(["a.pdf", "b.pdf"]);
    expect(warnings.some((w) => w.includes("Line 2"))).toBe(true);
  });

  it("ignores a bad sourceSha256 but keeps the entry", () => {
    const { entries, warnings } = parseManifest('[{"reference":"a.pdf","sourceSha256":"nothex"}]');
    expect(entries[0]?.sourceSha256).toBeUndefined();
    expect(warnings.some((w) => w.includes("sourceSha256"))).toBe(true);
  });

  it("normalises assets and drops ones with unknown kind", () => {
    const { entries, warnings } = parseManifest(
      JSON.stringify([
        {
          reference: "a.pdf",
          assets: [
            { kind: "figure", id: "p1-f1" },
            { kind: "bogus", id: "x" },
            { kind: "page", id: "" },
          ],
        },
      ]),
    );
    expect(entries[0]?.assets).toHaveLength(1);
    expect(warnings.some((w) => w.includes("unknown kind"))).toBe(true);
    expect(warnings.some((w) => w.includes("missing"))).toBe(true);
  });
});

// ─── usageWeight ───────────────────────────────────────────────────────────────

describe("usageWeight", () => {
  it("prefers hitCount over usage", () => {
    expect(usageWeight({ reference: "a", hitCount: 10, usage: 99 })).toBe(10);
  });

  it("falls back to usage", () => {
    expect(usageWeight({ reference: "a", usage: 7 })).toBe(7);
  });

  it("falls back to lastAccessed epoch ms", () => {
    const iso = "2026-02-01T00:00:00.000Z";
    expect(usageWeight({ reference: "a", lastAccessed: iso })).toBe(Date.parse(iso));
  });

  it("is null with no signal", () => {
    expect(usageWeight({ reference: "a" })).toBeNull();
  });

  it("is null for an unparseable lastAccessed", () => {
    expect(usageWeight({ reference: "a", lastAccessed: "not-a-date" })).toBeNull();
  });
});

// ─── orderByUsage (Req 17.3) ─────────────────────────────────────────────────────

describe("orderByUsage", () => {
  it("orders most-used first", () => {
    const entries: ManifestEntry[] = [
      { reference: "low", hitCount: 1 },
      { reference: "high", hitCount: 100 },
      { reference: "mid", hitCount: 50 },
    ];
    expect(orderByUsage(entries).map((e) => e.reference)).toEqual(["high", "mid", "low"]);
  });

  it("puts documents with no usage signal last", () => {
    const entries: ManifestEntry[] = [
      { reference: "unknown" },
      { reference: "used", hitCount: 0 },
    ];
    // Even a measured zero outranks "unknown".
    expect(orderByUsage(entries).map((e) => e.reference)).toEqual(["used", "unknown"]);
  });

  it("breaks ties by reference ascending, deterministically", () => {
    const entries: ManifestEntry[] = [
      { reference: "zebra", hitCount: 5 },
      { reference: "alpha", hitCount: 5 },
      { reference: "mike", hitCount: 5 },
    ];
    expect(orderByUsage(entries).map((e) => e.reference)).toEqual(["alpha", "mike", "zebra"]);
  });

  it("orders unknown-usage documents by reference too", () => {
    const entries: ManifestEntry[] = [{ reference: "y" }, { reference: "x" }, { reference: "z" }];
    expect(orderByUsage(entries).map((e) => e.reference)).toEqual(["x", "y", "z"]);
  });

  it("does not mutate the input", () => {
    const entries: ManifestEntry[] = [{ reference: "b", hitCount: 1 }, { reference: "a", hitCount: 2 }];
    const snapshot = entries.map((e) => e.reference);
    orderByUsage(entries);
    expect(entries.map((e) => e.reference)).toEqual(snapshot);
  });

  it("PROPERTY: the ordering is deterministic and total (Req 17.3)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            reference: fc.string({ minLength: 1, maxLength: 6 }),
            hitCount: fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
          }),
          { maxLength: 40 },
        ),
        (raw) => {
          // De-dup references so the tie-break is a strict total order.
          const seen = new Set<string>();
          const entries: ManifestEntry[] = [];
          for (const r of raw) {
            if (seen.has(r.reference)) continue;
            seen.add(r.reference);
            entries.push(r.hitCount === undefined ? { reference: r.reference } : { reference: r.reference, hitCount: r.hitCount });
          }
          const a = orderByUsage(entries).map((e) => e.reference);
          // Same input, shuffled, must yield the identical order.
          const b = orderByUsage([...entries].reverse()).map((e) => e.reference);
          expect(b).toEqual(a);
          // Every input reference appears exactly once (total, no drops/dupes).
          expect([...a].sort()).toEqual([...seen].sort());
          // Non-increasing usage among the signalled prefix.
          const weights = orderByUsage(entries).map(usageWeight);
          for (let i = 1; i < weights.length; i++) {
            const prev = weights[i - 1] ?? null;
            const cur = weights[i] ?? null;
            if (prev !== null && cur !== null) expect(prev).toBeGreaterThanOrEqual(cur);
            if (prev === null) expect(cur).toBeNull(); // nulls only at the tail
          }
        },
      ),
    );
  });
});

// ─── localIdFor + expectedAssetIds (Req 17.4) ────────────────────────────────────

describe("localIdFor", () => {
  it("returns a figure id verbatim (v1 continuity)", () => {
    expect(localIdFor({ kind: "figure", id: "p12-f3" })).toBe("p12-f3");
  });

  it("prefixes a page id, accepting 37 or p37", () => {
    expect(localIdFor({ kind: "page", id: "37" })).toBe("page:p37");
    expect(localIdFor({ kind: "page", id: "p37" })).toBe("page:p37");
  });

  it("prefixes tile and native (idempotently)", () => {
    expect(localIdFor({ kind: "tile", id: "p37-f1-r2c3" })).toBe("tile:p37-f1-r2c3");
    expect(localIdFor({ kind: "tile", id: "tile:p37-f1-r2c3" })).toBe("tile:p37-f1-r2c3");
    expect(localIdFor({ kind: "native", id: "source" })).toBe("native:source");
  });

  it("hashes a raw local id verbatim", () => {
    expect(localIdFor({ kind: "raw", id: "page:p9" })).toBe("page:p9");
  });
});

describe("expectedAssetIds", () => {
  it("recomputes ids through the REAL contract buildAssetId", () => {
    const reference = "specs/alpha.pdf";
    const assets: ManifestAsset[] = [
      { kind: "figure", id: "p1-f1" },
      { kind: "page", id: "5" },
    ];
    const result = expectedAssetIds(reference, assets);
    expect(result[0]?.assetId).toBe(buildAssetId(reference, figureLocalId("p1-f1")));
    expect(result[1]?.assetId).toBe(buildAssetId(reference, pageLocalId(5)));
  });
});

// ─── checkAssetIdStability (Req 17.4) ────────────────────────────────────────────

describe("checkAssetIdStability", () => {
  it("reports stable when the recomputed id matches the prior id", () => {
    const reference = "a.pdf";
    const prior = buildAssetId(reference, "p1-f1");
    const report = checkAssetIdStability(reference, [{ kind: "figure", id: "p1-f1", priorAssetId: prior }]);
    expect(report.ok).toBe(true);
    expect(report.stable).toBe(1);
    expect(report.assets[0]?.status).toBe("stable");
  });

  it("reports changed (a real regression) when the prior id differs", () => {
    const report = checkAssetIdStability("a.pdf", [
      { kind: "figure", id: "p1-f1", priorAssetId: "0".repeat(64) },
    ]);
    expect(report.ok).toBe(false);
    expect(report.changed).toBe(1);
    expect(report.assets[0]?.status).toBe("changed");
  });

  it("reports unverified when no prior id is supplied", () => {
    const report = checkAssetIdStability("a.pdf", [{ kind: "figure", id: "p1-f1" }]);
    expect(report.ok).toBe(true); // nothing changed
    expect(report.unverified).toBe(1);
    expect(report.assets[0]?.status).toBe("unverified");
  });

  it("PROPERTY: re-extraction is byte-identical for the same reference + local id (Req 17.4)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (reference, figureId) => {
          // The "old corpus" id is buildAssetId(ref, figureId). Re-extracting
          // the same document must reproduce it byte-for-byte, so the tool's
          // check must report `stable`.
          const prior = buildAssetId(reference, figureLocalId(figureId));
          const report = checkAssetIdStability(reference, [
            { kind: "figure", id: figureId, priorAssetId: prior },
          ]);
          expect(report.ok).toBe(true);
          expect(report.assets[0]?.status).toBe("stable");
          expect(report.assets[0]?.assetId).toBe(prior);
        },
      ),
    );
  });

  it("PROPERTY: a different reference changes the id (detects a real regression)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (refA, refB, figureId) => {
          fc.pre(refA.normalize("NFC") !== refB.normalize("NFC"));
          const prior = buildAssetId(refA, figureLocalId(figureId));
          const report = checkAssetIdStability(refB, [{ kind: "figure", id: figureId, priorAssetId: prior }]);
          expect(report.ok).toBe(false);
          expect(report.assets[0]?.status).toBe("changed");
        },
      ),
    );
  });
});

// ─── buildMigrationPlan ──────────────────────────────────────────────────────────

describe("buildMigrationPlan", () => {
  it("orders by usage and numbers 1-based, attaching stability", () => {
    const entries: ManifestEntry[] = [
      { reference: "low.pdf", path: "/c/low.pdf", hitCount: 1 },
      { reference: "high.pdf", sourceSha256: "a".repeat(64), hitCount: 9, assets: [{ kind: "figure", id: "p1-f1", priorAssetId: buildAssetId("high.pdf", "p1-f1") }] },
    ];
    const plan = buildMigrationPlan(entries);
    expect(plan.map((p) => p.reference)).toEqual(["high.pdf", "low.pdf"]);
    expect(plan[0]?.order).toBe(1);
    expect(plan[0]?.sourceKind).toBe("sha256");
    expect(plan[0]?.stability.stable).toBe(1);
    expect(plan[1]?.sourceKind).toBe("upload");
  });

  it("marks a document with no source as sourceKind none", () => {
    const plan = buildMigrationPlan([{ reference: "orphan.pdf" }]);
    expect(plan[0]?.sourceKind).toBe("none");
  });
});

// ─── summarizeRun ────────────────────────────────────────────────────────────────

describe("summarizeRun", () => {
  it("counts outcomes and lists asset-id regressions", () => {
    const outcomes: MigrationOutcome[] = [
      { reference: "a", status: "migrated", stability: { reference: "a", assets: [], stable: 0, changed: 0, unverified: 0, ok: true } },
      { reference: "b", status: "migrated", stability: { reference: "b", assets: [], stable: 0, changed: 1, unverified: 0, ok: false } },
      { reference: "c", status: "failed" },
      { reference: "d", status: "skipped" },
    ];
    const summary = summarizeRun(outcomes);
    expect(summary).toMatchObject({ total: 4, migrated: 2, failed: 1, skipped: 1 });
    expect(summary.assetIdRegressions).toEqual(["b"]);
  });
});

// ─── formatters ──────────────────────────────────────────────────────────────────

describe("formatters", () => {
  it("formatPlan lists order, usage, source and stability marks", () => {
    const plan = buildMigrationPlan([
      { reference: "a.pdf", path: "/c/a.pdf", hitCount: 5, assets: [{ kind: "figure", id: "p1-f1", priorAssetId: buildAssetId("a.pdf", "p1-f1") }] },
    ]);
    const text = formatPlan(plan);
    expect(text).toContain("a.pdf");
    expect(text).toContain("usage: 5");
    expect(text).toContain("stable");
  });

  it("formatPlan handles an empty plan", () => {
    expect(formatPlan([])).toContain("empty");
  });

  it("formatSummary states no regressions when clean", () => {
    const text = formatSummary(summarizeRun([{ reference: "a", status: "migrated" }]));
    expect(text).toContain("regressions: none");
  });

  it("formatSummary lists regressions", () => {
    const text = formatSummary(
      summarizeRun([
        { reference: "b", status: "migrated", stability: { reference: "b", assets: [], stable: 0, changed: 1, unverified: 0, ok: false } },
      ]),
    );
    expect(text).toContain("regressions (1)");
    expect(text).toContain("b");
  });
});
