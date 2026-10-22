// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * tests/document-diff.test.ts — traceability: pure unit-level diff logic of
 * `document_diff` (no database): alignment ladder (section_id → unit_id →
 * ordinal pair key → reading order) and the head excerpt.
 */

import { describe, expect, it, vi } from "vitest";
import { buildDocumentDiff } from "../src/handlers/document-diff-v2.js";
import type { PostgresClient } from "../src/postgres-client.js";
import type { AccessScope } from "../src/access-scope.js";
import {
  diffDocumentUnits,
  headExcerpt,
  TRACE_EXCERPT_MAX_CHARS,
  type DiffableUnit,
} from "../src/traceability.js";

function unit(
  overrides: Partial<DiffableUnit> & { content: string },
): DiffableUnit {
  return {
    unit_id: null,
    unit_type: "chunk",
    section_id: null,
    table_id: null,
    page_start: 1,
    page_end: 1,
    metadata: {},
    ...overrides,
  };
}

describe("headExcerpt", () => {
  it("flattens whitespace", () => {
    expect(headExcerpt("Hallo\n\tWelt   und mehr")).toBe("Hallo Welt und mehr");
  });

  it("keeps content at or below the limit untouched", () => {
    const text = "x".repeat(TRACE_EXCERPT_MAX_CHARS);
    expect(headExcerpt(text)).toBe(text);
  });

  it("cuts at the limit and marks the cut with …", () => {
    const text = "x".repeat(TRACE_EXCERPT_MAX_CHARS + 50);
    const excerpt = headExcerpt(text);
    expect(excerpt.length).toBe(TRACE_EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.startsWith("x".repeat(TRACE_EXCERPT_MAX_CHARS - 1))).toBe(true);
  });

  it("accepts an explicit maxChars", () => {
    expect(headExcerpt("abcdefgh", 4)).toBe("abc…");
  });
});

describe("diffDocumentUnits", () => {
  it("is empty for identical unit sets", () => {
    const a = [
      unit({ unit_id: "u1", section_id: "1 Anwendung", content: "A" }),
      unit({ unit_id: "u2", section_id: "1 Anwendung", content: "B" }),
    ];
    const b = a.map((u) => ({ ...u }));
    const diff = diffDocumentUnits(a, b);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged_count).toBe(2);
  });

  it("reports units only in the later set as added", () => {
    const from = [unit({ unit_id: "u1", section_id: "S", content: "A" })];
    const to = [
      unit({ unit_id: "u1", section_id: "S", content: "A" }),
      unit({ unit_id: "u2", section_id: "S", content: "B" }),
    ];
    const diff = diffDocumentUnits(from, to);
    expect(diff.added.map((u) => u.unit_id)).toEqual(["u2"]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged_count).toBe(1);
  });

  it("reports units only in the earlier set as removed", () => {
    const from = [
      unit({ unit_id: "u1", section_id: "S", content: "A" }),
      unit({ unit_id: "u2", section_id: "S", content: "B" }),
    ];
    const to = [unit({ unit_id: "u1", section_id: "S", content: "A" })];
    const diff = diffDocumentUnits(from, to);
    expect(diff.removed.map((u) => u.unit_id)).toEqual(["u2"]);
    expect(diff.added).toEqual([]);
    expect(diff.unchanged_count).toBe(1);
  });

  it("reports a whole section that vanished as removed", () => {
    const from = [
      unit({ unit_id: "u1", section_id: "S1", content: "A" }),
      unit({ unit_id: "u2", section_id: "S2", content: "B" }),
    ];
    const to = [unit({ unit_id: "u1", section_id: "S1", content: "A" })];
    const diff = diffDocumentUnits(from, to);
    expect(diff.removed.map((u) => u.unit_id)).toEqual(["u2"]);
  });

  it("reports a whole new section as added", () => {
    const from = [unit({ unit_id: "u1", section_id: "S1", content: "A" })];
    const to = [
      unit({ unit_id: "u1", section_id: "S1", content: "A" }),
      unit({ unit_id: "u2", section_id: "S2", content: "B" }),
    ];
    const diff = diffDocumentUnits(from, to);
    expect(diff.added.map((u) => u.unit_id)).toEqual(["u2"]);
  });

  it("pairs by unit_id even when the ordinal moved", () => {
    // Same unit id at both instants ⇒ the identical row is visible at both,
    // so it is unchanged even though the section-relative ordinal differs.
    const from = [
      unit({ unit_id: "u1", section_id: "S", content: "A", metadata: { ordinal: 0 } }),
    ];
    const to = [
      unit({ unit_id: "u1", section_id: "S", content: "A", metadata: { ordinal: 3 } }),
    ];
    const diff = diffDocumentUnits(from, to);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged_count).toBe(1);
  });

  it("pairs by unit_id and reports differing content as changed", () => {
    const from = [unit({ unit_id: "u1", section_id: "S", content: "alt" })];
    const to = [unit({ unit_id: "u1", section_id: "S", content: "neu" })];
    const diff = diffDocumentUnits(from, to);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].before.content).toBe("alt");
    expect(diff.changed[0].after.content).toBe("neu");
    expect(diff.changed[0].key).toContain("u1");
    expect(diff.unchanged_count).toBe(0);
  });

  it("pairs changed units by ordinal when the unit id was replaced", () => {
    // A reworded unit gets a new unit id (ids embed the revision id), so the
    // exact-id step misses; the ordinal pair key aligns them.
    const from = [
      unit({ unit_id: "old", section_id: "S", content: "alt", metadata: { ordinal: 1 } }),
    ];
    const to = [
      unit({ unit_id: "new", section_id: "S", content: "neu", metadata: { ordinal: 1 } }),
    ];
    const diff = diffDocumentUnits(from, to);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].before.content).toBe("alt");
    expect(diff.changed[0].after.content).toBe("neu");
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("scopes the ordinal pair key by unit type and table id", () => {
    // A chunk and a table row-group with the same ordinal in the same section
    // must not pair with each other.
    const from = [
      unit({ unit_id: "c1", section_id: "S", unit_type: "chunk", content: "text", metadata: { ordinal: 0 } }),
      unit({ unit_id: "t1", section_id: "S", unit_type: "table", table_id: "tab-1", content: "grid", metadata: { ordinal: 0 } }),
    ];
    const to = [
      unit({ unit_id: "c2", section_id: "S", unit_type: "chunk", content: "text", metadata: { ordinal: 0 } }),
      unit({ unit_id: "t2", section_id: "S", unit_type: "table", table_id: "tab-1", content: "grid", metadata: { ordinal: 0 } }),
    ];
    const diff = diffDocumentUnits(from, to);
    // Both pairs align on their own (type, table, ordinal) key and are
    // unchanged; nothing is added or removed.
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged_count).toBe(2);
  });

  it("falls back to reading order when no id or ordinal matches", () => {
    const from = [
      unit({ unit_id: "a1", section_id: "S", content: "eins" }),
      unit({ unit_id: "a2", section_id: "S", content: "zwei" }),
    ];
    const to = [
      unit({ unit_id: "b1", section_id: "S", content: "eins" }),
      unit({ unit_id: "b2", section_id: "S", content: "zwei geändert" }),
    ];
    const diff = diffDocumentUnits(from, to);
    expect(diff.unchanged_count).toBe(1);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].before.content).toBe("zwei");
    expect(diff.changed[0].after.content).toBe("zwei geändert");
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("splits surplus reading-order units into added / removed", () => {
    const from = [
      unit({ unit_id: "a1", section_id: "S", content: "eins" }),
      unit({ unit_id: "a2", section_id: "S", content: "zwei" }),
    ];
    const to = [unit({ unit_id: "b1", section_id: "S", content: "eins" })];
    const diff = diffDocumentUnits(from, to);
    expect(diff.unchanged_count).toBe(1);
    expect(diff.removed.map((u) => u.content)).toEqual(["zwei"]);
  });

  it("aligns section-less units by unit id, else reading order", () => {
    const from = [
      unit({ unit_id: "d1", unit_type: "document", section_id: null, content: "doc" }),
      unit({ unit_id: null, unit_type: "page", section_id: null, content: "page-alt" }),
    ];
    const to = [
      unit({ unit_id: "d1", unit_type: "document", section_id: null, content: "doc" }),
      unit({ unit_id: null, unit_type: "page", section_id: null, content: "page-neu" }),
    ];
    const diff = diffDocumentUnits(from, to);
    expect(diff.unchanged_count).toBe(1);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].before.content).toBe("page-alt");
    expect(diff.changed[0].after.content).toBe("page-neu");
  });

  it("does not mix sectioned and section-less units", () => {
    const from = [
      unit({ unit_id: "s1", section_id: "S", content: "A" }),
      unit({ unit_id: "p1", unit_type: "page", section_id: null, content: "P" }),
    ];
    const to = [unit({ unit_id: "s1", section_id: "S", content: "A" })];
    const diff = diffDocumentUnits(from, to);
    expect(diff.removed.map((u) => u.unit_id)).toEqual(["p1"]);
    expect(diff.unchanged_count).toBe(1);
  });

  it("counts every unit exactly once across the buckets", () => {
    const from = [
      unit({ unit_id: "keep", section_id: "S1", content: "gleich" }),
      unit({ unit_id: "old", section_id: "S1", content: "alt", metadata: { ordinal: 1 } }),
      unit({ unit_id: "gone", section_id: "S2", content: "fällt weg" }),
    ];
    const to = [
      unit({ unit_id: "keep", section_id: "S1", content: "gleich" }),
      unit({ unit_id: "new", section_id: "S1", content: "neu", metadata: { ordinal: 1 } }),
      unit({ unit_id: "fresh", section_id: "S3", content: "neu dazu" }),
    ];
    const diff = diffDocumentUnits(from, to);
    expect(diff.unchanged_count).toBe(1);
    expect(diff.changed).toHaveLength(1);
    expect(diff.removed.map((u) => u.unit_id)).toEqual(["gone"]);
    expect(diff.added.map((u) => u.unit_id)).toEqual(["fresh"]);
  });
});
describe("buildDocumentDiff loading", () => {
  const scope = { tenantId: "t1", service: true } as unknown as AccessScope;
  const row = (unitId: string, content: string) =>
    ({ ...unit({ unit_id: unitId, content }), reference: `doc#unit:${unitId}` }) as never;

  it("reads each instant in a single query and reports a truncated side", async () => {
    const getDocumentUnits = vi.fn(async (_c: string, _s: AccessScope, _r: string, o?: { validAt?: string }) => ({
      ok: true as const,
      result:
        o?.validAt === "2025-03-01T00:00:00Z"
          ? { units: [row("a", "eins")], truncated: false }
          : { units: [row("a", "eins"), row("b", "zwei")], truncated: true },
    }));
    const getSectionUnits = vi.fn();
    const pg = { getDocumentUnits, getSectionUnits } as unknown as PostgresClient;
    const payload = await buildDocumentDiff(
      pg,
      "documents",
      scope,
      "doc",
      "2025-03-01T00:00:00Z",
      "2025-07-01T00:00:00Z",
    );
    // One read per instant, never one per section.
    expect(getDocumentUnits).toHaveBeenCalledTimes(2);
    expect(getSectionUnits).not.toHaveBeenCalled();
    expect(payload.truncated).toBe(true);
    expect(payload.added.map((u) => u.unit_id)).toEqual(["b"]);
    expect(payload.unchanged_count).toBe(1);
  });

  it("is not truncated when both reads are complete", async () => {
    const pg = {
      getDocumentUnits: vi.fn(async () => ({ ok: true as const, result: { units: [], truncated: false } })),
    } as unknown as PostgresClient;
    const payload = await buildDocumentDiff(pg, "documents", scope, "doc", "2025-03-01T00:00:00Z", "2025-07-01T00:00:00Z");
    expect(payload.truncated).toBe(false);
  });

  it("fails instead of diffing a partial unit set", async () => {
    const pg = {
      getDocumentUnits: vi.fn(async () => ({ ok: false as const, error: { code: "POSTGRES_UNAVAILABLE", message: "down" } })),
    } as unknown as PostgresClient;
    await expect(
      buildDocumentDiff(pg, "documents", scope, "doc", "2025-03-01T00:00:00Z", "2025-07-01T00:00:00Z"),
    ).rejects.toThrow("Document units load failed: down");
  });
});
