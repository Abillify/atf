// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it, vi } from "vitest";
import {
  decomposeQuestion,
  dedupe,
  fuseRrf,
  MAX_CHUNKS_PER_DOCUMENT_IN_PACK,
  nearDuplicateKey,
  packEvidence,
  retrieveForAnswer,
  RRF_K,
} from "../src/retrieve-for-answer.js";
import type { SearchResult } from "../src/pg-types.js";

const instant = new Date("2026-03-01T00:00:00.000Z");

function hit(id: string, content = `Inhalt ${id}`, baseRef = id): SearchResult {
  return {
    id,
    score: 0.5,
    content,
    metadata: {},
    reference: `${baseRef}#${id}`,
    base_ref: baseRef,
    created: instant,
    modified: instant,
    valid_from: null,
    effective_valid_from: instant,
  };
}

describe("decomposeQuestion", () => {
  it("returns the question plus its two parts when both have at least three words", () => {
    const parts = decomposeQuestion(
      "Welche Pflichtfelder hat die Maske M-2 und welche Rechte braucht der Benutzer dafür?",
    );
    expect(parts).toEqual([
      "Welche Pflichtfelder hat die Maske M-2 und welche Rechte braucht der Benutzer dafür?",
      "Welche Pflichtfelder hat die Maske M-2",
      "welche Rechte braucht der Benutzer dafür?",
    ]);
  });

  it("does not cut when a side has fewer than three words", () => {
    expect(decomposeQuestion("Miete und Nebenkosten")).toEqual(["Miete und Nebenkosten"]);
    expect(decomposeQuestion("Wie hoch ist die Kaution und die Miete?")).toEqual([
      "Wie hoch ist die Kaution und die Miete?",
    ]);
  });

  it("cuts at question marks and semicolons between long enough parts", () => {
    expect(decomposeQuestion("Wer unterschreibt den Vertrag? Wann endet die Laufzeit des Vertrags?")).toEqual([
      "Wer unterschreibt den Vertrag? Wann endet die Laufzeit des Vertrags?",
      "Wer unterschreibt den Vertrag?",
      "Wann endet die Laufzeit des Vertrags?",
    ]);
    expect(decomposeQuestion("Wer unterschreibt den Vertrag; wann endet die Laufzeit des Vertrags")).toHaveLength(3);
  });

  it("cuts at english conjunctions, case-insensitively", () => {
    expect(decomposeQuestion("What are the notice periods AND who must sign the amendment")).toEqual([
      "What are the notice periods AND who must sign the amendment",
      "What are the notice periods",
      "who must sign the amendment",
    ]);
    expect(decomposeQuestion("List the fees as well as the payment terms for the lease")).toHaveLength(3);
  });

  it("removes duplicates (case, trailing punctuation) and keeps the first occurrence order", () => {
    // The only "part" is the question itself.
    expect(decomposeQuestion("Wie hoch ist die monatliche Miete?")).toEqual(["Wie hoch ist die monatliche Miete?"]);
    expect(
      decomposeQuestion("Wer zahlt die Miete? wer zahlt die miete? Wann ist die Zahlung fällig?"),
    ).toEqual([
      "Wer zahlt die Miete? wer zahlt die miete? Wann ist die Zahlung fällig?",
      "Wer zahlt die Miete?",
      "Wann ist die Zahlung fällig?",
    ]);
  });

  it("truncates to maxSubqueries with the original counted and first", () => {
    const question = "Erste Teilfrage hier? Zweite Teilfrage hier? Dritte Teilfrage hier? Vierte Teilfrage hier?";
    const all = decomposeQuestion(question, 10);
    expect(all).toHaveLength(5);
    expect(decomposeQuestion(question, 2)).toEqual([all[0], all[1]]);
    expect(decomposeQuestion(question, 1)).toEqual([all[0]]);
  });
});

describe("fuseRrf", () => {
  it("scores 1/(60+rank) per list and sums over lists", () => {
    const fused = fuseRrf([
      [hit("a"), hit("b"), hit("c")],
      [hit("c"), hit("a")],
    ]);
    const expected = {
      a: 1 / (RRF_K + 1) + 1 / (RRF_K + 2),
      c: 1 / (RRF_K + 3) + 1 / (RRF_K + 1),
      b: 1 / (RRF_K + 2),
    };
    // a and c are close; the exact order follows the sums.
    expect(fused.map((f) => f.result.id)).toEqual(["a", "c", "b"]);
    for (const f of fused) expect(f.score).toBeCloseTo(expected[f.result.id as "a" | "b" | "c"], 12);
    expect(fused[0]?.matchedSubqueries).toEqual([0, 1]);
    expect(fused[2]?.matchedSubqueries).toEqual([0]);
  });

  it("breaks ties by the earlier first appearance", () => {
    const fused = fuseRrf([[hit("x")], [hit("y")]]);
    expect(fused.map((f) => f.result.id)).toEqual(["x", "y"]);
    expect(fused[0]?.score).toBe(fused[1]?.score);
  });

  it("is empty for no lists", () => {
    expect(fuseRrf([])).toEqual([]);
    expect(fuseRrf([[], []])).toEqual([]);
  });
});

describe("dedupe", () => {
  const chunk = (id: string, content: string, score: number) => ({
    result: hit(id, content),
    score,
    matchedSubqueries: [0],
  });

  it("removes a repeated chunk id, keeping the higher-fused one", () => {
    const kept = dedupe([chunk("a", "text eins", 0.9), chunk("a", "text zwei", 0.5)]);
    expect(kept.map((k) => k.score)).toEqual([0.9]);
  });

  it("removes a near-duplicate text (case and whitespace folded), keeping the first", () => {
    const kept = dedupe([
      chunk("a", "Der  Mieter   zahlt\nmonatlich.", 0.9),
      chunk("b", "der mieter zahlt monatlich.", 0.8),
      chunk("c", "Etwas ganz anderes.", 0.7),
    ]);
    expect(kept.map((k) => k.result.id)).toEqual(["a", "c"]);
  });

  it("compares only the first 512 characters", () => {
    const head = "x".repeat(512);
    expect(nearDuplicateKey(`${head}A`)).toBe(nearDuplicateKey(`${head}B`));
    expect(nearDuplicateKey("a")).not.toBe(nearDuplicateKey("b"));
  });
});

describe("packEvidence", () => {
  const fused = (id: string, baseRef = id) => ({ result: hit(id, `Text ${id}`, baseRef), score: 1, matchedSubqueries: [0] });
  const fortyTokens = async () => 40;

  it("budget 100 with 40-token chunks packs two and reports truncated", async () => {
    const packed = await packEvidence([fused("a"), fused("b"), fused("c"), fused("d")], 100, fortyTokens);
    expect(packed.evidence.map((e) => e.id)).toEqual(["a", "b"]);
    expect(packed.usedTokens).toBe(80);
    expect(packed.truncated).toBe(true);
  });

  it("skips a chunk that does not fit and goes on with the next", async () => {
    const sizes: Record<string, number> = { "Text a": 30, "Text b": 500, "Text c": 30 };
    const packed = await packEvidence([fused("a"), fused("b"), fused("c")], 200, async (t) => sizes[t] ?? 0);
    expect(packed.evidence.map((e) => e.id)).toEqual(["a", "c"]);
    expect(packed.usedTokens).toBe(60);
    expect(packed.truncated).toBe(true);
  });

  it("is not truncated when everything fits", async () => {
    const packed = await packEvidence([fused("a"), fused("b")], 1000, fortyTokens);
    expect(packed.evidence).toHaveLength(2);
    expect(packed.truncated).toBe(false);
  });

  it("takes at most three chunks per document", async () => {
    const chunks = ["a", "b", "c", "d", "e"].map((id) => fused(id, "doc.pdf"));
    chunks.push(fused("z", "other.pdf"));
    const packed = await packEvidence(chunks, 10_000, async () => 10);
    expect(MAX_CHUNKS_PER_DOCUMENT_IN_PACK).toBe(3);
    expect(packed.evidence.map((e) => e.id)).toEqual(["a", "b", "c", "z"]);
    // The surplus of a document is redundancy, not a budget cut.
    expect(packed.truncated).toBe(false);
  });

  it("stops looking for smaller chunks once fewer than 64 tokens remain after a skip", async () => {
    // 80 used, c (40) does not fit and only 20 are left → stop; d (10 tokens) is never tried.
    const sizes: Record<string, number> = { "Text a": 40, "Text b": 40, "Text c": 40, "Text d": 10 };
    const counted: string[] = [];
    const packed = await packEvidence([fused("a"), fused("b"), fused("c"), fused("d")], 100, async (t) => {
      counted.push(t);
      return sizes[t] ?? 0;
    });
    expect(packed.evidence.map((e) => e.id)).toEqual(["a", "b"]);
    expect(counted).not.toContain("Text d");
    // With plenty of budget left after a skip, a later smaller chunk still goes in.
    const roomy = await packEvidence(
      [fused("a"), fused("c"), fused("d")],
      200,
      async (t) => ({ "Text a": 40, "Text c": 500, "Text d": 10 })[t] ?? 0,
    );
    expect(roomy.evidence.map((e) => e.id)).toEqual(["a", "d"]);
    expect(roomy.truncated).toBe(true);
    // An exact fit leaves nothing out.
    const tight = await packEvidence([fused("a"), fused("b")], 100, async () => 50);
    expect(tight.evidence.map((e) => e.id)).toEqual(["a", "b"]);
    expect(tight.truncated).toBe(false);
  });

  it("carries citation fields from the hit", async () => {
    const result = hit("a");
    result.title = "Handbuch";
    result.evidence = {
      section_path: ["2 Wareneingang", "2.1 Maske"],
      page_start: 4,
      page_end: 5,
    } as SearchResult["evidence"];
    const packed = await packEvidence([{ result, score: 0.5, matchedSubqueries: [0, 1] }], 1000, async () => 10);
    expect(packed.evidence[0]).toMatchObject({
      id: "a",
      title: "Handbuch",
      section: "2 Wareneingang > 2.1 Maske",
      page_start: 4,
      page_end: 5,
      matched_subqueries: [0, 1],
    });
  });
});

describe("retrieveForAnswer", () => {
  const question = "Welche Pflichtfelder hat die Maske M-2 und welche Rechte braucht der Benutzer dafür?";

  function deps(overrides: Partial<Parameters<typeof retrieveForAnswer>[0]> = {}) {
    const calls: Array<{ query: string; limit: number }> = [];
    return {
      calls,
      deps: {
        search: vi.fn(async (query: string, limit: number) => {
          calls.push({ query, limit });
          if (query.includes("Pflichtfelder hat die Maske M-2") && !query.includes("Rechte")) {
            return [hit("p1", "Pflichtfeld Lieferant"), hit("shared", "Gemeinsam relevant")];
          }
          if (query.startsWith("welche Rechte")) return [hit("r1", "Recht WE-01"), hit("shared", "Gemeinsam relevant")];
          return [hit("shared", "Gemeinsam relevant"), hit("p1", "Pflichtfeld Lieferant")];
        }),
        countTokens: async (text: string) => text.length,
        ...overrides,
      },
    };
  }

  it("searches the question and its parts, fuses, and packs", async () => {
    const { deps: d, calls } = deps();
    const out = await retrieveForAnswer(d, { question });
    expect(out.subqueries).toHaveLength(3);
    expect(calls.every((c) => c.limit === 20)).toBe(true);
    // "shared" is in every list → fused first.
    expect(out.evidence.map((e) => e.id)[0]).toBe("shared");
    expect(out.evidence.find((e) => e.id === "shared")?.matched_subqueries).toEqual([0, 1, 2]);
    expect(new Set(out.evidence.map((e) => e.id))).toEqual(new Set(["shared", "p1", "r1"]));
    expect(out).toMatchObject({ question, budget_tokens: 4000, truncated: false, content_trust: "untrusted", reranked: false });
    expect(out.used_tokens).toBe(out.evidence.reduce((n, e) => n + e.content.length, 0));
  });

  it("reranks the fused head against the ORIGINAL question", async () => {
    const rerank = vi.fn(async (_q: string, results: SearchResult[]) =>
      [...results].sort((a, b) => Number(b.content.startsWith("Recht")) - Number(a.content.startsWith("Recht"))),
    );
    const { deps: d } = deps({ rerank });
    const out = await retrieveForAnswer(d, { question });
    expect(rerank).toHaveBeenCalledTimes(1);
    expect(rerank.mock.calls[0]?.[0]).toBe(question);
    expect(out.evidence[0]?.id).toBe("r1");
    expect(out.reranked).toBe(true);
    // The reranker saw the fused, de-duplicated head, not the raw lists.
    expect(rerank.mock.calls[0]?.[1].map((r) => r.id).sort()).toEqual(["p1", "r1", "shared"]);
  });

  it("a chunk the reranker leaves out keeps its fusion position behind the ranked ones", async () => {
    const rerank = async (_q: string, results: SearchResult[]) => results.filter((r) => r.id === "r1");
    const { deps: d } = deps({ rerank });
    const out = await retrieveForAnswer(d, { question });
    expect(out.evidence.map((e) => e.id)).toEqual(["r1", "shared", "p1"]);
    expect(out.reranked).toBe(true);
  });

  it("keeps the fusion order when the reranker gives nothing back", async () => {
    const { deps: d } = deps({ rerank: async () => undefined });
    const out = await retrieveForAnswer(d, { question });
    expect(out.evidence[0]?.id).toBe("shared");
    expect(out.reranked).toBe(false);
  });

  it("a failing sub-question narrows the recall, a failing original question fails", async () => {
    const failPart = {
      search: async (query: string) => {
        if (query === question) return [hit("only")];
        throw new Error("boom");
      },
      countTokens: async () => 10,
    };
    const out = await retrieveForAnswer(failPart, { question });
    expect(out.evidence.map((e) => e.id)).toEqual(["only"]);
    await expect(
      retrieveForAnswer(
        { search: async () => Promise.reject(new Error("down")), countTokens: async () => 1 },
        { question },
      ),
    ).rejects.toThrow("down");
  });

  it("honours budget_tokens and max_subqueries", async () => {
    const { deps: d } = deps();
    const out = await retrieveForAnswer(d, { question, budgetTokens: 256, maxSubqueries: 1 });
    expect(out.subqueries).toHaveLength(1);
    expect(out.budget_tokens).toBe(256);
  });
});
