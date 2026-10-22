// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * tests/traceability.test.ts — Epic E7 (K1): pure diff + excerpt logic of the
 * `trace` tool (no database).
 */

import { describe, expect, it } from "vitest";
import {
  centeredExcerpt,
  contentHash,
  diffTraceOccurrences,
  normalizeForHash,
  traceIdentifier,
  traceOccurrenceKey,
  TRACE_EXCERPT_MAX_CHARS,
  type TraceOccurrence,
} from "../src/traceability.js";

function occ(
  baseRef: string,
  content: string,
  section?: string,
  pageStart?: number,
): TraceOccurrence {
  return {
    base_ref: baseRef,
    reference: `${baseRef}#unit:x`,
    ...(section !== undefined ? { section } : {}),
    ...(pageStart !== undefined ? { page_start: pageStart } : {}),
    excerpt: content.slice(0, 50),
    content_hash: contentHash(content),
  };
}

describe("contentHash", () => {
  it("is stable for identical content", () => {
    expect(contentHash("Hallo Welt")).toBe(contentHash("Hallo Welt"));
  });

  it("ignores whitespace differences", () => {
    expect(contentHash("Hallo   Welt\n\tund mehr")).toBe(
      contentHash("Hallo Welt und mehr"),
    );
  });

  it("differs for different content", () => {
    expect(contentHash("Hallo Welt")).not.toBe(contentHash("Hallo Welt!"));
  });

  it("is the SHA-256 hex of the normalized content", () => {
    // Known vector: sha256("a b")
    expect(normalizeForHash("  a\n b  ")).toBe("a b");
    expect(contentHash("  a\n b  ")).toBe(
      "c8687a08aa5d6ed2044328fa6a697ab8e96dc34291e8c2034ae8c38e6fcc6d65",
    );
  });
});

describe("traceOccurrenceKey", () => {
  it("joins base_ref and section with NUL", () => {
    expect(traceOccurrenceKey(occ("doc/a", "x"))).toBe("doc/a\u0000");
    expect(traceOccurrenceKey(occ("doc/a", "x", "4 Wareneingang"))).toBe(
      "doc/a\u00004 Wareneingang",
    );
  });

  it("treats missing and empty section as the same key", () => {
    expect(traceOccurrenceKey(occ("d", "x"))).toBe(traceOccurrenceKey(occ("d", "x", "")));
  });
});

describe("diffTraceOccurrences", () => {
  it("classifies added, removed, changed and unchanged", () => {
    const a = [
      occ("doc/keep", "gleicher Text", "1"),
      occ("doc/change", "alter Text", "2"),
      occ("doc/gone", "nur in a", "3"),
    ];
    const b = [
      occ("doc/keep", "gleicher Text", "1"),
      occ("doc/change", "neuer Text", "2"),
      occ("doc/new", "nur in b", "4"),
    ];
    const diff = diffTraceOccurrences(a, b);
    expect(diff.added.map((o) => o.base_ref)).toEqual(["doc/new"]);
    expect(diff.removed.map((o) => o.base_ref)).toEqual(["doc/gone"]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].key).toBe("doc/change\u00002");
    expect(diff.changed[0].a.content_hash).not.toBe(diff.changed[0].b.content_hash);
    expect(diff.unchanged_count).toBe(1);
  });

  it("returns empty diff for empty inputs", () => {
    const diff = diffTraceOccurrences([], []);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged_count).toBe(0);
  });

  it("keys on section: same document, different section is added+removed", () => {
    const a = [occ("doc/x", "text", "alt/1")];
    const b = [occ("doc/x", "text", "neu/2")];
    const diff = diffTraceOccurrences(a, b);
    expect(diff.removed).toHaveLength(1);
    expect(diff.added).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
  });

  it("collapses duplicate keys to the first occurrence", () => {
    const a = [occ("doc/x", "erst", "s"), occ("doc/x", "zweit", "s")];
    const b = [occ("doc/x", "erst", "s")];
    const diff = diffTraceOccurrences(a, b);
    // First occurrence on each side matches → unchanged, no dupes.
    expect(diff.unchanged_count).toBe(1);
    expect(diff.changed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });
});

describe("traceIdentifier", () => {
  it("queries both time points and diffs the results", async () => {
    const calls: Array<{ id: string; validAt: string; limit: number }> = [];
    const diff = await traceIdentifier(
      {
        identifier: "WE-01/A",
        valid_at_a: "2025-01-01T00:00:00Z",
        valid_at_b: "2025-06-01T00:00:00Z",
        limit: 50,
      },
      async (id, validAt, limit) => {
        calls.push({ id, validAt, limit });
        if (validAt === "2025-01-01T00:00:00Z") {
          return [occ("doc/a", "Text mit WE-01/A", "1")];
        }
        return [occ("doc/a", "Text mit WE-01/A geändert", "1"), occ("doc/b", "neu WE-01/A", "2")];
      },
    );
    expect(calls).toEqual([
      { id: "WE-01/A", validAt: "2025-01-01T00:00:00Z", limit: 50 },
      { id: "WE-01/A", validAt: "2025-06-01T00:00:00Z", limit: 50 },
    ]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.added.map((o) => o.base_ref)).toEqual(["doc/b"]);
    expect(diff.unchanged_count).toBe(0);
  });
});

describe("centeredExcerpt", () => {
  it("returns short content unchanged", () => {
    expect(centeredExcerpt("kurzer text mit WE-01/A", "WE-01/A")).toBe(
      "kurzer text mit WE-01/A",
    );
  });

  it("flattens whitespace", () => {
    expect(centeredExcerpt("a\n\n b\t c", "b")).toBe("a b c");
  });

  it("centres the window on the hit and marks both sides", () => {
    const content = `${"x".repeat(1000)} WE-01/A ${"y".repeat(1000)}`;
    const ex = centeredExcerpt(content, "WE-01/A");
    expect(ex.length).toBeLessThanOrEqual(TRACE_EXCERPT_MAX_CHARS);
    expect(ex.startsWith("…")).toBe(true);
    expect(ex.endsWith("…")).toBe(true);
    expect(ex).toContain("WE-01/A");
  });

  it("matches case-insensitively", () => {
    const content = `${"x".repeat(500)} we-01/a ${"y".repeat(500)}`;
    const ex = centeredExcerpt(content, "WE-01/A");
    expect(ex).toContain("we-01/a");
  });

  it("omits the ellipsis on the side that is not truncated", () => {
    const content = `WE-01/A steht am Anfang ${"z".repeat(500)}`;
    const ex = centeredExcerpt(content, "WE-01/A");
    expect(ex.startsWith("WE-01/A")).toBe(true);
    expect(ex.endsWith("…")).toBe(true);
  });

  it("falls back to the head when the needle is absent", () => {
    const content = "q".repeat(400);
    const ex = centeredExcerpt(content, "WE-01/A");
    expect(ex.length).toBe(TRACE_EXCERPT_MAX_CHARS);
    expect(ex.endsWith("…")).toBe(true);
    expect(ex.startsWith("qqqq")).toBe(true);
  });
});
