// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Query-embedding LRU cache and semantic chunking.
 *
 * Both were effectively untested (3% and 0%). The cache matters for cost as much
 * as latency — every miss is a paid embedding call — and its in-flight
 * coalescing is the kind of concurrency detail that is easy to get subtly wrong
 * and impossible to notice from the outside. The semantic chunker matters
 * because its fallback paths decide what happens when the embedding server
 * misbehaves, and a silent wrong answer there corrupts an entire ingest.
 */

import { describe, expect, it, vi } from "vitest";
import { createQueryEmbeddingCache } from "../src/query-cache.js";
import { semanticChunk, semanticChunkBatch } from "../src/semantic-chunker.js";
import {
  normalizeChapterTitle,
  splitByHeadingLevel,
} from "../src/chapter-splitter.js";

// ---------------------------------------------------------------------------
// Query embedding cache
// ---------------------------------------------------------------------------

describe("query embedding cache", () => {
  it("computes on a miss and serves from cache on a hit", async () => {
    const cache = createQueryEmbeddingCache(10);
    const embed = vi.fn(async () => [1, 2, 3]);

    expect(await cache.getOrEmbed("mietvertrag", embed)).toEqual([1, 2, 3]);
    expect(await cache.getOrEmbed("mietvertrag", embed)).toEqual([1, 2, 3]);
    expect(embed).toHaveBeenCalledOnce();
    expect(cache.size).toBe(1);
  });

  it("keys on the exact string (normalisation is the caller's job)", async () => {
    const cache = createQueryEmbeddingCache(10);
    const embed = vi.fn(async () => [1]);
    await cache.getOrEmbed("Mietvertrag", embed);
    await cache.getOrEmbed("mietvertrag", embed);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("evicts the least-recently-used entry when full", async () => {
    const cache = createQueryEmbeddingCache(2);
    const embed = vi.fn(async () => [1]);
    await cache.getOrEmbed("a", embed);
    await cache.getOrEmbed("b", embed);
    // Touch "a" so "b" becomes the least recently used.
    await cache.getOrEmbed("a", embed);
    await cache.getOrEmbed("c", embed);
    expect(cache.size).toBe(2);

    // "b" was evicted → recompute; "a" survived → no recompute.
    const before = embed.mock.calls.length;
    await cache.getOrEmbed("a", embed);
    expect(embed.mock.calls.length).toBe(before);
    await cache.getOrEmbed("b", embed);
    expect(embed.mock.calls.length).toBe(before + 1);
  });

  /**
   * In-flight coalescing: two concurrent requests for the same query must share
   * one embedding call. Without this, a burst of identical queries (a RAG loop,
   * a retried request) pays N times for one answer.
   */
  it("coalesces concurrent requests for the same query", async () => {
    const cache = createQueryEmbeddingCache(10);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const embed = vi.fn(async () => {
      await gate;
      return [7];
    });

    const a = cache.getOrEmbed("q", embed);
    const b = cache.getOrEmbed("q", embed);
    release();
    expect(await a).toEqual([7]);
    expect(await b).toEqual([7]);
    expect(embed).toHaveBeenCalledOnce();
  });

  it("does not coalesce different queries", async () => {
    const cache = createQueryEmbeddingCache(10);
    const embed = vi.fn(async () => [1]);
    await Promise.all([
      cache.getOrEmbed("a", embed),
      cache.getOrEmbed("b", embed),
    ]);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed embed, and clears the in-flight entry", async () => {
    // A cached rejection would turn one transient upstream failure into a
    // permanent one for that query.
    const cache = createQueryEmbeddingCache(10);
    const failing = vi.fn(async () => {
      throw new Error("embed server down");
    });
    await expect(cache.getOrEmbed("q", failing)).rejects.toThrow("embed server down");
    expect(cache.size).toBe(0);

    const working = vi.fn(async () => [1]);
    expect(await cache.getOrEmbed("q", working)).toEqual([1]);
  });

  it("maxSize 0 disables caching entirely", async () => {
    const cache = createQueryEmbeddingCache(0);
    const embed = vi.fn(async () => [1]);
    await cache.getOrEmbed("q", embed);
    await cache.getOrEmbed("q", embed);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("a negative maxSize is treated as disabled rather than throwing", async () => {
    const cache = createQueryEmbeddingCache(-5);
    const embed = vi.fn(async () => [1]);
    await cache.getOrEmbed("q", embed);
    await cache.getOrEmbed("q", embed);
    expect(embed).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Semantic chunking
// ---------------------------------------------------------------------------

describe("semanticChunk", () => {
  /** Embeddings that make sentence i similar to i-1 unless i is in `breakAt`. */
  const embedWithBreaks =
    (breakAt: number[]) =>
    async (texts: string[]): Promise<number[][]> =>
      texts.map((_t, i) => {
        // Flip the dominant axis at each requested breakpoint so the cosine
        // distance to the previous sentence spikes there.
        const group = breakAt.filter((b) => b <= i).length;
        return group % 2 === 0 ? [1, 0] : [0, 1];
      });

  const opts = {
    maxChunkSize: 1000,
    maxChunkOverlap: 0,
    breakpointPercentile: 75,
  };

  it("falls back to text chunking for one or two sentences", async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    const chunks = await semanticChunk("Only one sentence here.", embed, opts);
    expect(embed).not.toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("splits at a semantic shift", async () => {
    const text =
      "Der Mietvertrag beginnt am 1. Januar. Die Miete ist monatlich fällig. " +
      "Ganz anderes Thema jetzt. Es geht um Fahrzeuge und Reifen.";
    // The threshold is the Nth PERCENTILE of the observed distances, so with a
    // single large gap a 75th percentile lands ON that gap and nothing exceeds
    // it. Using the median makes the one shift an outlier, which is the shape
    // the algorithm is meant to detect.
    const chunks = await semanticChunk(text, embedWithBreaks([2]), {
      ...opts,
      breakpointPercentile: 50,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // Indices and totals must be self-consistent for downstream chunk metadata.
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.total).toBe(chunks.length);
    });
  });

  it("falls back to text chunking when the embedding count does not match", async () => {
    // A server returning the wrong number of vectors is a real failure mode; the
    // chunker must not zip mismatched arrays and produce nonsense breakpoints.
    const bad = vi.fn(async () => [[1, 0]]);
    const text = "One. Two. Three. Four.";
    const chunks = await semanticChunk(text, bad, opts);
    expect(bad).toHaveBeenCalledOnce();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("propagates an embedding failure to the caller", async () => {
    await expect(
      semanticChunk("One. Two. Three.", async () => {
        throw new Error("embed down");
      }, opts),
    ).rejects.toThrow("embed down");
  });

  it("splits an oversized semantic segment with the text chunker", async () => {
    const long = `${"a".repeat(300)}. ${"b".repeat(300)}. ${"c".repeat(300)}.`;
    const chunks = await semanticChunk(long, embedWithBreaks([]), {
      ...opts,
      maxChunkSize: 200,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(260);
  });

  it("reports zero overlap, since semantic chunking does not overlap", async () => {
    const chunks = await semanticChunk(
      "One. Two. Three. Four.",
      embedWithBreaks([2]),
      opts,
    );
    for (const c of chunks) {
      expect(c.overlapStart).toBe(0);
      expect(c.overlapEnd).toBe(0);
    }
  });
});

describe("semanticChunkBatch", () => {
  const opts = {
    maxChunkSize: 1000,
    maxChunkOverlap: 0,
    breakpointPercentile: 75,
  };

  it("embeds all documents' sentences in ONE call", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const result = await semanticChunkBatch(
      ["One. Two. Three.", "Four. Five. Six."],
      embed,
      opts,
    );
    expect(embed).toHaveBeenCalledOnce();
    expect(result).toHaveLength(2);
  });

  it("does not include short documents in the embedding batch", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    await semanticChunkBatch(["Short one.", "One. Two. Three."], embed, opts);
    // Only the second document's 3 sentences are embedded.
    expect(embed.mock.calls[0]?.[0]).toHaveLength(3);
  });

  it("skips the embedding call entirely when every document is short", async () => {
    const embed = vi.fn(async () => []);
    const result = await semanticChunkBatch(["A.", "B."], embed, opts);
    expect(embed).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it("falls back for ALL documents on a count mismatch", async () => {
    const embed = vi.fn(async () => [[1, 0]]);
    const result = await semanticChunkBatch(
      ["One. Two. Three.", "Four. Five. Six."],
      embed,
      opts,
    );
    expect(result).toHaveLength(2);
    for (const chunks of result) expect(chunks.length).toBeGreaterThan(0);
  });

  it("keeps per-document offsets correct so documents do not bleed together", async () => {
    // The batch call flattens sentences across documents; a wrong offset would
    // slice another document's embeddings and produce breakpoints from unrelated
    // text — a corruption that is invisible without this check.
    const embed = async (texts: string[]) =>
      texts.map((t) => (t.startsWith("A") ? [1, 0] : [0, 1]));
    const result = await semanticChunkBatch(
      ["A1. A2. A3.", "B1. B2. B3."],
      embed,
      opts,
    );
    expect(result[0]?.every((c) => !c.content.includes("B"))).toBe(true);
    expect(result[1]?.every((c) => !c.content.includes("A"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chapter splitting
// ---------------------------------------------------------------------------

describe("normalizeChapterTitle", () => {
  it("strips leading hashes and whitespace", () => {
    expect(normalizeChapterTitle("##   Kapitel 1  ")).toBe("Kapitel 1");
  });

  it("replaces slashes so a title cannot forge a base_ref path segment", () => {
    // base_ref uses "/" structurally and is matched with LIKE by the
    // X-Path-Prefix filter, so a slash in a heading would invent a folder.
    expect(normalizeChapterTitle("## Teil 1/2")).toBe("Teil 1|2");
  });

  it("leaves a hash run without a following space untouched", () => {
    // "###" is not a heading (Markdown requires whitespace), so there is nothing
    // to strip.
    expect(normalizeChapterTitle("###")).toBe("###");
  });
});

describe("splitByHeadingLevel", () => {
  const doc = [
    "# Titel",
    "",
    "Einleitung.",
    "",
    "## Kapitel A",
    "",
    "Inhalt A.",
    "",
    "## Kapitel B",
    "",
    "Inhalt B.",
  ].join("\n");

  const headings = (parts: { headingText: string | null }[]) =>
    parts.map((p) => (p.headingText === null ? null : normalizeChapterTitle(p.headingText)));

  it("splits at the requested heading level", () => {
    const parts = splitByHeadingLevel(doc, 2);
    expect(headings(parts)).toContain("Kapitel A");
    expect(headings(parts)).toContain("Kapitel B");
  });

  it("returns the leading text as a preamble section with no heading", () => {
    const parts = splitByHeadingLevel(doc, 2);
    expect(parts[0]?.headingText).toBeNull();
    expect(parts[0]?.content).toContain("Einleitung.");
  });

  it("keeps each section's own content, including its heading line", () => {
    const parts = splitByHeadingLevel(doc, 2);
    const a = parts.find((p) => p.headingText?.includes("Kapitel A"));
    expect(a?.content).toContain("## Kapitel A");
    expect(a?.content).toContain("Inhalt A.");
    expect(a?.content).not.toContain("Inhalt B.");
  });

  it("does not split on a different heading level", () => {
    const parts = splitByHeadingLevel(doc, 1);
    expect(headings(parts)).not.toContain("Kapitel A");
  });

  it("returns a single section for a document without matching headings", () => {
    expect(splitByHeadingLevel("Just text, no headings.", 2)).toHaveLength(1);
  });

  it("is lossless: concatenating the sections reproduces the input", () => {
    // Splitting must never drop a line — a chapter split that silently loses
    // content would corrupt the ingest with no error.
    const parts = splitByHeadingLevel(doc, 2);
    expect(parts.map((p) => p.content).join("\n")).toContain("Inhalt A.");
    expect(parts.map((p) => p.content).join("\n")).toContain("Inhalt B.");
    expect(parts.map((p) => p.content).join("\n")).toContain("# Titel");
  });
});
