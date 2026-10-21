// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { groupResultsBySection } from "../src/rerank-context.js";
import type { SearchResult } from "../src/postgres-client.js";

const instant = new Date("2026-03-01T00:00:00.000Z");

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: overrides.id ?? "1",
    score: overrides.score ?? 0.9,
    content: overrides.content ?? "some content",
    metadata: overrides.metadata ?? {},
    reference: overrides.reference ?? "doc#0",
    base_ref: overrides.base_ref ?? "doc",
    created: instant,
    modified: instant,
    valid_from: null,
    effective_valid_from: instant,
    ...overrides,
  };
}

describe("groupResultsBySection", () => {
  it("keeps equally named sections of two documents in separate groups", () => {
    const groups = groupResultsBySection([
      result({
        id: "a1",
        score: 0.9,
        base_ref: "doku-a",
        reference: "doku-a#0",
        metadata: { section_path: ["1 Einleitung"] },
      }),
      result({
        id: "b1",
        score: 0.8,
        base_ref: "doku-b",
        reference: "doku-b#0",
        metadata: { section_path: ["1 Einleitung"] },
      }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.base_ref).sort()).toEqual(["doku-a", "doku-b"]);
    expect(groups.every((g) => g.section_path === "1 Einleitung")).toBe(true);
  });

  it("merges hits of the same section within one document", () => {
    const groups = groupResultsBySection([
      result({
        id: "a1",
        score: 0.9,
        base_ref: "doku-a",
        metadata: { section_path: ["1 Einleitung"] },
      }),
      result({
        id: "a2",
        score: 0.7,
        base_ref: "doku-a",
        metadata: { section_path: ["1 Einleitung"] },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.base_ref).toBe("doku-a");
    expect(groups[0]?.results.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("reports the document of each group alongside the section path", () => {
    const groups = groupResultsBySection([
      result({
        id: "x",
        score: 0.5,
        base_ref: "doku-x",
        metadata: { section_path: ["A", "A.1"] },
      }),
      result({ id: "y", score: 0.4, base_ref: "doku-y", metadata: {} }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ section_path: "A / A.1", base_ref: "doku-x" });
    // Pathless hits fall back to the document key too.
    expect(groups[1]).toMatchObject({ section_path: "", base_ref: "doku-y" });
  });

  it("falls back to the reference when base_ref is empty", () => {
    const groups = groupResultsBySection([
      result({ id: "z", base_ref: "", reference: "ref-z", metadata: { section_path: ["S"] } }),
    ]);
    expect(groups[0]?.base_ref).toBe("ref-z");
  });
});
