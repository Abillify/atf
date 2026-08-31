// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit test for `batchCitationSources` (src/graph/exec-runtime.ts).
 *
 * A grounding node (the `tool` node after `vectorsearch/get_summaries`) can
 * register 150+ documents in one call. Emitting them all in a single
 * `sources` `chat.completion.chunk` produces an SSE line larger than the
 * aiohttp 131072-byte (128 KiB) per-line cap of Open WebUI's client, which
 * aborts the read with "Got more than 131072 bytes when reading". The helper
 * splits the sources into byte-bounded batches so each emitted frame stays
 * under the cap while preserving order and completeness.
 */
import { describe, test, expect } from "bun:test";
import {
  batchCitationSources,
  batchBySerializedBytes,
} from "../exec-runtime.js";
import type { CitationSource } from "../../types/openai.js";

/** Serialised byte size of the full SSE frame for a given sources batch. */
function frameBytes(sources: CitationSource[]): number {
  const chunk = {
    id: "e42076b9-5788-411f-9906-0710dbc19632",
    object: "chat.completion.chunk",
    created: 1784700000,
    model: "openai/qwen/qwen3.6-35b-a3b",
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    sources,
  };
  // Mirrors the wire line written by streaming.ts: `data: <json>\n\n`.
  return Buffer.byteLength(`data: ${JSON.stringify(chunk)}\n\n`, "utf8");
}

/** Builds `n` realistic example-records sources: 500-char German snippet + long UTF-8 path. */
function makeSources(n: number): CitationSource[] {
  const snippet = (
    "Example Records beschreibt die Weitergabe synthetischer " +
    "Datensätze an die Fachabteilung; Beispielunterlagen wurden auf " +
    "Vollständigkeit geprüft. Über das Ergebnis wurde Alice Example " +
    "schriftlich informiert. "
  )
    .repeat(4)
    .slice(0, 500);
  return Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    title: `Beispieldatensatz_${i}_geprüft.pdf`,
    url:
      `/ExampleRecords/Anfrage/Beispielunterlagen/` +
      `ExampleCorp/Fachbereich/01_2024 ` +
      `geprüft/Beispieldatensatz_${i}_geprüft.pdf`,
    snippet,
    score: 0,
  }));
}

describe("batchCitationSources", () => {
  test("splits many example-records sources so every SSE frame stays under 131072 bytes", () => {
    // The synthetic collection has 329 documents; a broad get_summaries grounding
    // registers well over a hundred at once. At ~800 bytes/source a single
    // frame crosses the 128 KiB cap around ~160 sources.
    const sources = makeSources(200);
    // Sanity: a single-frame emission (the old behaviour) exceeds the cap.
    expect(frameBytes(sources)).toBeGreaterThan(131072);

    const envelope = frameBytes([]);
    const batches = batchCitationSources(sources, 120_000, envelope);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(frameBytes(batch)).toBeLessThan(131072);
    }
  });

  test("preserves order and completeness across batches (no dropped/duplicated sources)", () => {
    const sources = makeSources(150);
    const batches = batchCitationSources(
      sources,
      120_000,
      frameBytes([]),
    );
    const flat = batches.flat();
    expect(flat).toHaveLength(sources.length);
    expect(flat.map((s) => s.index)).toEqual(sources.map((s) => s.index));
  });

  test("returns a single batch when everything fits in one frame", () => {
    const sources = makeSources(3);
    const batches = batchCitationSources(sources, 120_000, frameBytes([]));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  test("returns no batches for an empty input", () => {
    expect(batchCitationSources([], 120_000, 0)).toEqual([]);
  });

  test("keeps a lone oversized source on its own batch rather than dropping it", () => {
    // A source larger than the whole budget must still be emitted (correctness
    // over the byte budget); per-source size is bounded in practice anyway.
    const [big] = makeSources(1);
    if (big === undefined) throw new Error("expected a source");
    const batches = batchCitationSources([big], 10, 0);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([big]);
  });
});

/** Serialised byte size of the merged-sources SSE frame (flow-end shape). */
function mergedFrameBytes(sources: MergedSource[]): number {
  const chunk = {
    id: "2ce42413-05d8-436a-aecf-4f3748c12dd3",
    object: "chat.completion.chunk",
    created: 1784700000,
    model: "openai/qwen/qwen3.6-35b-a3b",
    choices: [],
    sources,
  };
  return Buffer.byteLength(`data: ${JSON.stringify(chunk)}\n\n`, "utf8");
}

/** Open WebUI merged-source shape emitted once at flow end. */
interface MergedSource {
  source: { name: string; url?: string };
  document: string[];
  metadata: { source: string; name?: string }[];
  distances: number[];
}

/** Builds `n` merged sources mirroring synthetic flow-end aggregation. */
function makeMergedSources(n: number): MergedSource[] {
  const snippet = (
    "Example Records beschreibt die Weitergabe synthetischer " +
    "Datensätze; Beispielunterlagen wurden auf Vollständigkeit geprüft. "
  )
    .repeat(4)
    .slice(0, 500);
  return Array.from({ length: n }, (_, i) => {
    const url =
      `/ExampleRecords/Records Part 1/Quality Records/` +
      `CASE-001_Alice Example_Correspondence/CASE-001-${i}-Info.pdf`;
    const title = `CASE-001-${i}-Info.pdf`;
    return {
      source: { name: title, url },
      document: [snippet],
      metadata: [{ source: url, name: title }],
      distances: [0],
    };
  });
}

describe("batchBySerializedBytes (merged flow-end sources chunk)", () => {
  test("splits 329 aggregated documents so every SSE frame stays under 131072 bytes", () => {
    // The synthetic research flow grounds on the full overview → 329 docs.
    const sources = makeMergedSources(329);
    expect(mergedFrameBytes(sources)).toBeGreaterThan(131072);

    const envelope = mergedFrameBytes([]);
    const batches = batchBySerializedBytes(sources, 120_000, envelope);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(mergedFrameBytes(batch)).toBeLessThan(131072);
    }
    // Completeness preserved.
    expect(batches.flat()).toHaveLength(sources.length);
  });
});
