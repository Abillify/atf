// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the opt-in answer citation index
 * (`compliance/citation-index.ts`) and the registry accessor it builds on.
 *
 * Covers: `CitationRegistry.entries()` (every registered source with its
 * global `[n]`, ascending); `buildCitationIndexRows` (only sources carrying
 * BOTH a `chunk_id` and a `document_id` are recorded, `cited` follows the
 * `[n]` markers of the final answer with fenced code excluded); the
 * in-memory store's record/failure behaviour used by the engine tests.
 */

import { describe, expect, test } from "bun:test";
import {
  buildCitationIndexRows,
  InMemoryCitationIndexStore,
  type CitationIndexContext,
} from "../citation-index.js";
import { CitationRegistry } from "../../graph/graph-engine/citation-registry.js";
import type { Citation } from "../../types/openai.js";

function citation(overrides: Partial<Citation>): Citation {
  return {
    title: "Doc",
    url: "",
    snippet: "Passage.",
    similarity_score: 0.5,
    ...overrides,
  };
}

const context: CitationIndexContext = {
  tenantId: "tenant-a",
  userId: "user-1",
  executionId: "exec-1",
  flowId: "flow-x",
  flowVersion: "1.2.0",
};

describe("CitationRegistry.entries()", () => {
  test("returns every registered source with its global index, ascending", async () => {
    const registry = new CitationRegistry(async () => {}, "mock-model");
    const indices = await registry.registerCitations([
      {
        key: "doc-b",
        citation: citation({
          title: "Doc B",
          document_id: "/akte/B",
          chunk_id: "chunk-b",
        }),
      },
      {
        key: "doc-a",
        citation: citation({
          title: "Doc A",
          document_id: "/akte/A",
          chunk_id: "chunk-a",
          version: "v3",
        }),
      },
      { key: "doc-b", citation: citation({ title: "Doc B" }) },
    ]);
    expect(indices).toEqual([1, 2, 1]);

    const entries = registry.entries();
    expect(entries.map((e) => e.index)).toEqual([1, 2]);
    expect(entries[0]?.citation.title).toBe("Doc B");
    expect(entries[1]?.citation.chunk_id).toBe("chunk-a");
    expect(entries[1]?.citation.version).toBe("v3");
  });

  test("empty registry yields no entries", () => {
    const registry = new CitationRegistry(async () => {}, "mock-model");
    expect(registry.entries()).toEqual([]);
  });
});

describe("buildCitationIndexRows()", () => {
  const entries = [
    {
      index: 1,
      citation: citation({
        document_id: "/akte/A",
        chunk_id: "chunk-a",
        version: "v7",
      }),
    },
    // No chunk_id → skipped (the citation check cannot resolve it).
    { index: 2, citation: citation({ document_id: "/akte/B" }) },
    // No document_id → skipped.
    { index: 3, citation: citation({ chunk_id: "chunk-c" }) },
    // Empty strings count as missing too.
    { index: 4, citation: citation({ document_id: "/akte/D", chunk_id: "" }) },
    { index: 5, citation: citation({ document_id: "/akte/E", chunk_id: "chunk-e" }) },
  ];

  test("records only sources with chunk_id AND document_id; cited follows the markers", () => {
    const rows = buildCitationIndexRows(context, entries, "Befund [1] und [5].");
    expect(rows.map((r) => r.citationIndex)).toEqual([1, 5]);
    expect(rows.every((r) => r.cited)).toBe(true);
    expect(rows[0]).toEqual({
      tenantId: "tenant-a",
      userId: "user-1",
      executionId: "exec-1",
      flowId: "flow-x",
      flowVersion: "1.2.0",
      baseRef: "/akte/A",
      chunkId: "chunk-a",
      revision: "v7",
      citationIndex: 1,
      cited: true,
    });
    expect(rows[1]?.revision).toBeNull();
  });

  test("an answer citing nothing marks every row uncited", () => {
    const rows = buildCitationIndexRows(context, entries, "Befund ohne Belege.");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.cited)).toBe(true);
  });

  test("markers inside fenced code blocks do not count as citations", () => {
    const rows = buildCitationIndexRows(
      context,
      entries,
      "Befund [5].\n\n```markdown\nBeispiel [1]\n```\n",
    );
    expect(rows.find((r) => r.citationIndex === 1)?.cited).toBe(false);
    expect(rows.find((r) => r.citationIndex === 5)?.cited).toBe(true);
  });

  test("missing user / flow version become null", () => {
    const rows = buildCitationIndexRows(
      { tenantId: "t", executionId: "e", flowId: "f" },
      entries,
      "[1]",
    );
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.flowVersion).toBeNull();
  });
});

describe("InMemoryCitationIndexStore", () => {
  test("keeps every recorded row", async () => {
    const store = new InMemoryCitationIndexStore();
    const rows = buildCitationIndexRows(
      context,
      [{ index: 1, citation: citation({ document_id: "/a", chunk_id: "c1" }) }],
      "[1]",
    );
    await store.recordExecution(rows);
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]?.chunkId).toBe("c1");
  });

  test("failWith makes recordExecution reject — the engine must swallow it", async () => {
    const store = new InMemoryCitationIndexStore();
    store.failWith = new Error("db down");
    expect(store.failWith).toBeInstanceOf(Error);
    await expect(store.recordExecution([])).rejects.toThrow("db down");
  });
});
