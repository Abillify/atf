// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit test for LLM self-search citations (`annotateVectorSearchCitations`,
 * src/graph/agent-tools.ts).
 *
 * When a responder calls a vectorsearch tool itself, the result it reads is
 * annotated with the GLOBAL citation numbers `[n]` (assigned by the shared
 * per-execution registry, deduped against grounding) so the model can cite the
 * self-fetched sources inline — the gap that previously left LLM-tool search
 * results out of the client's source panel.
 *
 * The `register` here is a stateful mock mimicking the real registry: it dedups
 * by document key and hands out contiguous global indices, so the test also
 * proves that a document already surfaced earlier reuses its existing [n].
 */

import { describe, test, expect } from "bun:test";
import { annotateVectorSearchCitations } from "../agent-tools.js";
import type { Citation } from "../../types/openai.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

/** Stateful registry mock: dedups by key, assigns contiguous global [n]. */
function makeRegistry() {
  const byKey = new Map<string, number>();
  let next = 1;
  const calls: { key: string; citation: Citation }[][] = [];
  const hook = {
    register: async (
      entries: { key: string; citation: Citation }[],
    ): Promise<number[]> => {
      calls.push(entries);
      return entries.map((e) => {
        let idx = byKey.get(e.key);
        if (idx === undefined) {
          idx = next++;
          byKey.set(e.key, idx);
        }
        return idx;
      });
    },
  };
  return { hook, calls, byKey };
}

/** MCP text-content wrapper for a vectorsearch `search` result. */
function searchContent(results: unknown[]): unknown {
  return [
    { type: "text", text: JSON.stringify({ results, count: results.length }) },
  ];
}

describe("annotateVectorSearchCitations", () => {
  test("annotates a search result with global [n] and registers by base_ref", async () => {
    const { hook, calls } = makeRegistry();
    const content = searchContent([
      {
        id: "a1",
        base_ref: "/akte/A",
        title: "Doc A",
        content: "Passage A.",
        score: 0.7,
      },
      {
        id: "b1",
        base_ref: "/akte/B",
        title: "Doc B",
        content: "Passage B.",
        score: 0.5,
      },
    ]);

    const out = (await annotateVectorSearchCitations(content, hook)) as Array<{
      type: string;
      text: string;
    }>;

    // The note is APPENDED as a trailing text part; the original payload stays
    // as content[0] (so any downstream re-parse still sees the raw JSON).
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(2);
    expect(at(out, 0).text).toContain("Passage A."); // original payload preserved
    const note = at(out, out.length - 1).text;
    expect(note).toContain("[1] Doc A (Ref: /akte/A)");
    expect(note).toContain("[2] Doc B (Ref: /akte/B)");

    // Registered under base_ref keys, in order.
    expect(at(calls, 0).map((e) => e.key)).toEqual(["/akte/A", "/akte/B"]);
  });

  test("reuses an existing [n] for a document already surfaced (global dedup)", async () => {
    const { hook } = makeRegistry();
    // First: a grounding-like registration claims [1] for /akte/A.
    await hook.register([
      {
        key: "/akte/A",
        citation: { title: "Doc A", url: "", snippet: "", similarity_score: 0 },
      },
    ]);
    // Then the model self-searches and hits /akte/A again + a new /akte/C.
    const out = (await annotateVectorSearchCitations(
      searchContent([
        {
          id: "a2",
          base_ref: "/akte/A",
          title: "Doc A",
          content: "More A.",
          score: 0.6,
        },
        {
          id: "c1",
          base_ref: "/akte/C",
          title: "Doc C",
          content: "Passage C.",
          score: 0.4,
        },
      ]),
      hook,
    )) as Array<{ text: string }>;
    const note = at(out, out.length - 1).text;
    // /akte/A keeps [1]; the new /akte/C continues at [2].
    expect(note).toContain("[1] Doc A (Ref: /akte/A)");
    expect(note).toContain("[2] Doc C (Ref: /akte/C)");
  });

  test("annotates a get_summaries result", async () => {
    const { hook } = makeRegistry();
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          summaries: [
            { reference: "/akte/A", title: "Doc A", summary: "Summary A" },
          ],
          count: 1,
          total: 1,
        }),
      },
    ];
    const out = (await annotateVectorSearchCitations(content, hook)) as Array<{
      text: string;
    }>;
    expect(at(out, out.length - 1).text).toContain("[1] Doc A (Ref: /akte/A)");
  });

  test("returns non-vectorsearch content UNCHANGED (no register call)", async () => {
    const { hook, calls } = makeRegistry();
    const content = [
      { type: "text", text: JSON.stringify({ status: "ok", data: 42 }) },
    ];
    const out = await annotateVectorSearchCitations(content, hook);
    expect(out).toBe(content); // same reference, untouched
    expect(calls).toHaveLength(0);
  });

  test("does NOT fire for a {results:[...]} payload WITHOUT document identity", async () => {
    // A generic non-RAG tool that happens to return a `results` array (no
    // base_ref / reference) must be left untouched — no note, no register call.
    const { hook, calls } = makeRegistry();
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          results: [
            { id: "x", name: "some row" },
            { id: "y", name: "other" },
          ],
          count: 2,
        }),
      },
    ];
    const out = await annotateVectorSearchCitations(content, hook);
    expect(out).toBe(content); // untouched
    expect(calls).toHaveLength(0);
  });

  test("appends the note after the JSON for a raw string payload (re-parseable JSON stays first)", async () => {
    const { hook } = makeRegistry();
    const raw = JSON.stringify({
      results: [
        {
          id: "a1",
          base_ref: "/akte/A",
          title: "Doc A",
          content: "P.",
          score: 0.5,
        },
      ],
      count: 1,
    });
    const out = (await annotateVectorSearchCitations(raw, hook)) as string;
    expect(typeof out).toBe("string");
    expect(out.indexOf('"results"')).toBeLessThan(
      out.indexOf("Zitier-Hinweis:"),
    );
    expect(out).toContain("[1] Doc A (Ref: /akte/A)");
  });
});
