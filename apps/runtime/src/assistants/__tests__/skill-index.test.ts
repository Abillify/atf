// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Skill index — prompt-cache byte stability, budget behaviour, and search.
 *
 * The stability tests are the important ones: they encode the decision that the
 * index is turn-invariant rather than relevance-ranked. A future change that
 * "improves" the index by sorting it per query would break exactly these.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeTriggerLine,
  renderSkillIndex,
  searchSkills,
  selectIndexEntries,
  skillSortKey,
  type SkillIndexEntry,
} from "../skill-index.js";

function entry(name: string, triggerLine: string, useCount = 0, canary = false): SkillIndexEntry {
  return {
    id: `id-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    triggerLine,
    sortKey: skillSortKey(name),
    useCount,
    ...(canary ? { canary: true } : {}),
  };
}

const SKILLS: SkillIndexEntry[] = [
  entry("Weekly report", "when the user asks for a weekly summary", 12),
  entry("Deploy check", "before deploying to production", 3),
  entry("Invoice lookup", "when an invoice number is mentioned", 7),
];

describe("byte stability", () => {
  test("input order does not change the rendered bytes", () => {
    const forward = renderSkillIndex(SKILLS).text;
    const reversed = renderSkillIndex([...SKILLS].reverse()).text;
    // The whole prompt-cache argument rests on this.
    expect(forward).toBe(reversed);
  });

  test("rendering is idempotent across calls", () => {
    expect(renderSkillIndex(SKILLS).text).toBe(renderSkillIndex(SKILLS).text);
  });

  test("selection returns render order, not popularity order", () => {
    const { selected } = selectIndexEntries(SKILLS, { maxEntries: 2 });
    // "Weekly report" (12) and "Invoice lookup" (7) win on useCount, but the
    // returned order must be lexicographic so the prefix stays stable.
    expect(selected.map((s) => s.name)).toEqual(["Invoice lookup", "Weekly report"]);
  });

  test("entries are ordered lexicographically in the output", () => {
    const text = renderSkillIndex(SKILLS).text;
    const deployAt = text.indexOf("Deploy check");
    const invoiceAt = text.indexOf("Invoice lookup");
    const weeklyAt = text.indexOf("Weekly report");
    expect(deployAt).toBeLessThan(invoiceAt);
    expect(invoiceAt).toBeLessThan(weeklyAt);
  });
});

describe("budget behaviour", () => {
  test("an empty skill set renders nothing at all", () => {
    const result = renderSkillIndex([]);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });

  test("entry-count overflow is reported and footnoted", () => {
    const result = renderSkillIndex(SKILLS, { maxEntries: 2 });
    expect(result.renderedCount).toBe(2);
    expect(result.omittedCount).toBe(1);
    expect(result.truncated).toBe(true);
    // The model must be told that more exist, or it treats the list as complete.
    expect(result.text).toContain("skill_search");
  });

  test("character overflow stops at the first line that does not fit", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      entry(`Skill ${String(i).padStart(2, "0")}`, "x".repeat(100)),
    );
    const result = renderSkillIndex(many, { maxChars: 900 });
    expect(result.chars).toBeLessThanOrEqual(900);
    expect(result.renderedCount).toBeGreaterThan(0);
    expect(result.omittedCount).toBeGreaterThan(0);
  });

  test("a budget too small for even one entry renders nothing rather than a bare heading", () => {
    const result = renderSkillIndex(SKILLS, { maxChars: 50 });
    expect(result.text).toBe("");
    expect(result.omittedCount).toBe(SKILLS.length);
    expect(result.truncated).toBe(true);
  });

  test("canary ids are reported so an outcome can be attributed later", () => {
    const withCanary = [...SKILLS, entry("Zeta trial", "experimental", 0, true)];
    expect(renderSkillIndex(withCanary).canaryIds).toEqual(["id-zeta-trial"]);
  });

  test("the read tool is named so bodies are reachable", () => {
    expect(renderSkillIndex(SKILLS).text).toContain("skill_read");
  });
});

describe("trigger line normalisation", () => {
  test("collapses to a single line and drops a trailing period", () => {
    expect(normalizeTriggerLine("  when   the user\nasks.  ")).toBe("when the user asks");
  });

  test("bounded with an ellipsis", () => {
    const long = "a".repeat(300);
    const result = normalizeTriggerLine(long);
    expect(result.length).toBe(160);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("search", () => {
  test("a name match outranks a trigger match", () => {
    const hits = searchSkills(SKILLS, "invoice");
    expect(hits[0]?.entry.name).toBe("Invoice lookup");
  });

  test("prefix matching catches inflections without a stemmer", () => {
    const hits = searchSkills(SKILLS, "deploying");
    expect(hits[0]?.entry.name).toBe("Deploy check");
  });

  test("an empty or noise-only query returns nothing", () => {
    expect(searchSkills(SKILLS, "   ")).toEqual([]);
    expect(searchSkills(SKILLS, "a")).toEqual([]);
  });

  test("results are bounded and deterministic", () => {
    const hits = searchSkills(SKILLS, "when the user", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits).toEqual(searchSkills(SKILLS, "when the user", 2));
  });
});

describe("sort key", () => {
  test("case-insensitive and control-character free", () => {
    expect(skillSortKey("  Weekly\u0000Report  ")).toBe("weeklyreport");
  });
});
