// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the opt-in post-answer sources check
 * (`src/graph/answer-sources-check.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { Citation } from "../../types/openai.js";
import {
  completeSourcesSection,
  findRuleMarkers,
  formatSourceEntry,
  parseSourcesCheckConfig,
  stripRuleMarkers,
} from "../answer-sources-check.js";

const citation = (title: string, extra: Partial<Citation> = {}): Citation => ({
  title,
  url: "",
  snippet: "",
  similarity_score: 0,
  ...extra,
});

const registry = new Map<number, Citation>([
  [1, citation("Doc A", { document_id: "/akte/A" })],
  [2, citation("Doc B", { document_id: "/akte/B", page_start: 18 })],
  [3, citation("Doc C", { url: "/akte/C", version: "2.2", page_start: 76, page_end: 78 })],
]);
const lookup = (n: number) => registry.get(n);

describe("parseSourcesCheckConfig", () => {
  test("off unless a switch is explicitly true", () => {
    expect(parseSourcesCheckConfig(undefined)).toBeUndefined();
    expect(parseSourcesCheckConfig({})).toBeUndefined();
    expect(parseSourcesCheckConfig({ completeSection: false })).toBeUndefined();
    expect(parseSourcesCheckConfig({ completeSection: "yes" })).toBeUndefined();
    expect(parseSourcesCheckConfig("on")).toBeUndefined();
  });

  test("defaults the heading and keeps the switches independent", () => {
    expect(parseSourcesCheckConfig({ completeSection: true })).toEqual({
      completeSection: true,
      heading: "## Quellen",
      stripRuleMarkers: false,
    });
    expect(
      parseSourcesCheckConfig({ stripRuleMarkers: true, heading: "## Sources" }),
    ).toEqual({
      completeSection: false,
      heading: "## Sources",
      stripRuleMarkers: true,
    });
  });
});

describe("completeSourcesSection", () => {
  test("appends a missing cited [n] to the trailing sources section", () => {
    const text = "Befund [1][2].\n\n## Quellen\n[1] Doc A; Ref: /akte/A";
    const r = completeSourcesSection(text, lookup);
    expect(r.appended).toEqual([2]);
    expect(r.unresolved).toEqual([]);
    expect(r.createdSection).toBe(false);
    expect(r.appendix).toBe("\n[2] Doc B, S. 18; Ref: /akte/B");
  });

  test("creates the section when it is missing", () => {
    const r = completeSourcesSection("Befund [3].\n", lookup);
    expect(r.createdSection).toBe(true);
    expect(r.appended).toEqual([3]);
    expect(r.appendix).toBe(
      "\n## Quellen\n[3] Doc C, Version 2.2, S. 76–78; Ref: /akte/C",
    );
  });

  test("creates a new section when the sources section is not the last one", () => {
    const text = "Befund [1][2].\n\n## Quellen\n[1] Doc A\n\n## Hinweis\nText";
    const r = completeSourcesSection(text, lookup);
    expect(r.createdSection).toBe(true);
    expect(r.appendix.startsWith("\n\n## Quellen\n[2] Doc B")).toBe(true);
  });

  test("duplicates: each missing number is appended once, listed ones never", () => {
    const text =
      "A [2]. B [2][1][2]. C [1].\n\n## Quellen\n- [1] Doc A\n- [1] Doc A";
    const r = completeSourcesSection(text, lookup);
    expect(r.appended).toEqual([2]);
    expect(r.appendix.match(/\[2\]/g)).toHaveLength(1);
    expect(r.appendix).not.toContain("[1]");
  });

  test("[n] without a registered source is reported, never invented", () => {
    const text = "Befund [1][9].\n\n## Quellen\n[1] Doc A";
    const r = completeSourcesSection(text, lookup);
    expect(r.unresolved).toEqual([9]);
    expect(r.appended).toEqual([]);
    expect(r.appendix).toBe("");
  });

  test("complete sections, empty answers and code are left alone", () => {
    expect(
      completeSourcesSection("X [1].\n\n## Quellen\n[1] Doc A", lookup).appendix,
    ).toBe("");
    expect(completeSourcesSection("   ", lookup).appendix).toBe("");
    const fenced = "Siehe\n```\narr[2] = 1\n```\n";
    expect(completeSourcesSection(fenced, lookup).appendix).toBe("");
  });
});

describe("rule markers", () => {
  test("only [Regel: …] is removed; other bracketed content stays", () => {
    const text =
      "Kein Mangel [Regel: ohne Beleg kein Mangel]. Wert [mm] und [1], [Ref: /a], [Regel].";
    const r = stripRuleMarkers(text);
    expect(r.text).toBe("Kein Mangel. Wert [mm] und [1], [Ref: /a], [Regel].");
    expect(r.removed).toEqual(["[Regel: ohne Beleg kein Mangel]"]);
    expect(findRuleMarkers(r.text)).toEqual([]);
    expect(findRuleMarkers(text)).toEqual(["[Regel: ohne Beleg kein Mangel]"]);
  });
});

describe("formatSourceEntry", () => {
  test("uses the display title and omits a ref equal to the title", () => {
    expect(
      formatSourceEntry(4, citation("raw", { displayTitle: "Doc — Kap. 2", page: 5 })),
    ).toBe("[4] Doc — Kap. 2, S. 5");
  });
});
