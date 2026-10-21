// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Three small hardening fixes in the search handlers:
 *
 *  - the activity stream is process-wide, so its search summary must not carry
 *    the query text (GDPR data minimisation);
 *  - `attachExpansions` must not open one database query per hit at once;
 *  - `group_by_document` must not glue distant chunks together as if they were
 *    continuous text.
 */
import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  buildSearchSummary,
  CHUNK_GAP_MARKER,
  groupResultsByDocument,
} from "../src/handlers/search.js";
import {
  attachExpansions,
  EXPAND_CONCURRENCY,
} from "../src/handlers/expand-results.js";
import { mapWithConcurrency } from "../src/concurrency.js";
import type { SearchResult } from "../src/postgres-client.js";

const instant = new Date("2026-03-01T00:00:00.000Z");
const silent = pino({ level: "silent" });

function chunk(
  id: string,
  content: string,
  over: Partial<SearchResult> = {},
): SearchResult {
  return {
    id,
    score: 0.5,
    content,
    metadata: {},
    reference: `${id}`,
    base_ref: "doc",
    created: instant,
    modified: instant,
    valid_from: null,
    effective_valid_from: instant,
    ...over,
  };
}

describe("buildSearchSummary · no query text in the activity stream", () => {
  const base = {
    collection: "documents",
    mode: "hybrid" as const,
    reranked: false,
    results: [chunk("a", "x")],
  };

  it("reports the shape of the query, never its text", () => {
    const query = "Krankheitsstatus von Max Mustermann im März";
    const summary = buildSearchSummary({ ...base, query });
    expect(summary).not.toContain("Krankheit");
    expect(summary).not.toContain("Mustermann");
    expect(summary).toContain(`query[${query.length} chars]`);
  });

  it("keeps the collection and the mode in the summary", () => {
    const summary = buildSearchSummary({ ...base, collection: "fds", query: "x" });
    expect(summary).toContain("in fds");
    expect(summary).toContain("hybrid");
  });

  it("is the same for a short and a very long query apart from the length", () => {
    const long = buildSearchSummary({ ...base, query: "y".repeat(5000) });
    expect(long).toContain("query[5000 chars]");
    expect(long.length).toBeLessThan(200);
  });
});

describe("mapWithConcurrency / attachExpansions · bounded fan-out", () => {
  it("never runs more than `limit` calls at once and keeps the order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency(
      Array.from({ length: 40 }, (_, i) => i),
      5,
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return n * 2;
      },
    );
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
    expect(out).toEqual(Array.from({ length: 40 }, (_, i) => i * 2));
  });

  it("handles an empty list and a limit below 1", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });

  it("an error in one call rejects the whole mapping (no silent partial result)", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("attachExpansions queries the store for at most EXPAND_CONCURRENCY hits at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const postgresClient = {
      expandUnit: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return { ok: true, result: [] };
      }),
    };
    const hits = Array.from({ length: 100 }, (_, i) =>
      chunk(`h${i}`, "c", { metadata: { unit_id: `u${i}`, unit_type: "chunk" } }),
    );
    const out = await attachExpansions({
      postgresClient: postgresClient as never,
      collection: "docs",
      scope: {} as never,
      mode: "neighbors",
      budgetChars: 1000,
      includeAllVersions: false,
      results: hits,
      logger: silent,
    });
    expect(out).toHaveLength(100);
    expect(postgresClient.expandUnit).toHaveBeenCalledTimes(100);
    expect(peak).toBeLessThanOrEqual(EXPAND_CONCURRENCY);
    expect(out.map((r) => r.id)).toEqual(hits.map((h) => h.id));
  });
});

describe("groupResultsByDocument · gap marker between distant chunks", () => {
  const withIndex = (id: string, index: number, content: string) =>
    chunk(id, content, {
      chunk: {
        chunk_index: index,
        chunk_total: 10,
        chunk_size: content.length,
        parent_ref: "doc",
      } as never,
    });

  it("marks the gap when the retrieved chunks are not neighbours", () => {
    const [merged] = groupResultsByDocument([
      withIndex("c0", 0, "Anfang des Dokuments."),
      withIndex("c7", 7, "Ein Absatz weit hinten."),
    ]);
    expect(merged?.content).toContain(CHUNK_GAP_MARKER);
    expect(merged?.content.indexOf("Anfang")).toBeLessThan(
      merged?.content.indexOf(CHUNK_GAP_MARKER) ?? -1,
    );
    expect(merged?.content.indexOf(CHUNK_GAP_MARKER) ?? -1).toBeLessThan(
      merged?.content.indexOf("weit hinten") ?? -1,
    );
  });

  it("does not mark adjacent chunks", () => {
    const [merged] = groupResultsByDocument([
      withIndex("c3", 3, "Erster Teil."),
      withIndex("c4", 4, "Zweiter Teil."),
    ]);
    expect(merged?.content).not.toContain(CHUNK_GAP_MARKER);
  });

  it("claims no gap when the chunk index is unknown", () => {
    const [merged] = groupResultsByDocument([
      chunk("a", "Erster Teil."),
      chunk("b", "Zweiter Teil."),
    ]);
    expect(merged?.content).not.toContain(CHUNK_GAP_MARKER);
  });

  it("orders by chunk index before deciding adjacency", () => {
    const [merged] = groupResultsByDocument([
      withIndex("c5", 5, "Fünf."),
      withIndex("c4", 4, "Vier."),
    ]);
    expect(merged?.content).not.toContain(CHUNK_GAP_MARKER);
    expect(merged?.content.indexOf("Vier")).toBeLessThan(
      merged?.content.indexOf("Fünf") ?? -1,
    );
  });
});
