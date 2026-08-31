// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Assigns each retrieved document a GLOBAL, contiguous 1-based citation
 * number `[n]` keyed by its stable document identity, so multiple emitters in
 * ONE stream (a grounding tool/parallel/retrieval node AND a responder's own
 * vectorsearch tool call) share ONE numbering — the same document keeps the
 * same `[n]` and each source is streamed to the client exactly once. The
 * client filter maps the `[n]` the answer references to these sources by
 * index.
 *
 * Extracted from `_executeFlowInternal` (handler-factories.ts) — this state
 * (citationIndexByKey + the running counter) is only ever touched here, so
 * unlike the tool-tracking / node-monitoring / debug-trace machinery it lifts
 * out with no shared state left behind.
 */
import type {
  ChatCompletionChunk,
  Citation,
  CitationSource,
} from "../../types/openai.js";
import { batchCitationSources } from "../exec-runtime.js";

export class CitationRegistry {
  private readonly citationIndexByKey = new Map<string, number>();
  private readonly citationByKey = new Map<string, Citation>();
  private nextCitationIndex = 1;

  constructor(
    private readonly onChunk: (chunk: ChatCompletionChunk) => Promise<void>,
    private readonly model: string,
  ) {}

  /**
   * Number of distinct sources registered (and therefore streamed to the
   * client) so far. Used to detect the failure mode where sources exist but
   * the answer references none of them via `[n]`, which makes the client show
   * no citations at all.
   */
  get size(): number {
    return this.citationIndexByKey.size;
  }

  registerCitations = async (
    entries: { key: string; citation: Citation }[],
  ): Promise<number[]> => {
    const indices: number[] = [];
    const fresh: Array<{ index: number; c: Citation }> = [];
    for (const { key, citation } of entries) {
      let idx = this.citationIndexByKey.get(key);
      if (idx === undefined) {
        idx = this.nextCitationIndex++;
        this.citationIndexByKey.set(key, idx);
        const stored = {
          ...citation,
          ...(citation.evidence !== undefined ? { evidence: [...citation.evidence] } : {}),
        };
        this.citationByKey.set(key, stored);
        fresh.push({ index: idx, c: stored });
      } else {
        const stored = this.citationByKey.get(key);
        if (stored !== undefined && citation.evidence !== undefined) {
          const merged = stored.evidence ?? [];
          const seen = new Set(merged.map((evidence) => JSON.stringify(evidence)));
          let changed = false;
          for (const evidence of citation.evidence) {
            const evidenceKey = JSON.stringify(evidence);
            if (!seen.has(evidenceKey)) {
              merged.push(evidence);
              seen.add(evidenceKey);
              changed = true;
            }
          }
          if (changed) {
            stored.evidence = merged;
            for (const field of ["citation_id", "document_id", "version", "page", "section", "char_start", "char_end", "chunk_id"] as const) {
              if (stored[field] === undefined && citation[field] !== undefined) {
                (stored as unknown as Record<string, unknown>)[field] = citation[field];
              }
            }
            fresh.push({ index: idx, c: stored });
          }
        }
      }
      indices.push(idx);
    }
    // Stream only newly-seen sources (each with its global index); a source
    // already sent is not re-emitted (the filter keys by index).
    //
    // Sources are emitted in byte-bounded batches so no single SSE line
    // exceeds the aiohttp 131072-byte (128 KiB) per-line cap of Open WebUI's
    // client. A grounding node can register 150+ documents at once (e.g. the
    // `tool` node after `vectorsearch/get_summaries`), which serialises well
    // past the limit in ONE chunk and aborts the client read with
    // "Got more than 131072 bytes when reading". Open WebUI merges the
    // `sources` arrays across chunks by `index`, so splitting one logical
    // registration into several `chat.completion.chunk` frames is transparent
    // to the client and keeps the `[n]` numbering intact.
    if (fresh.length > 0) {
      const makeSourcesChunk = (
        sources: CitationSource[],
      ): ChatCompletionChunk => ({
        id: crypto.randomUUID(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{ index: 0, delta: {}, finish_reason: null }],
        sources,
      });
      const allSources: CitationSource[] = fresh.map((f) => ({
        index: f.index,
        // Keep raw Citation.title stable for document identity and prompts;
        // source chips may use the richer chapter-aware display title.
        title: f.c.displayTitle ?? f.c.title,
        url: f.c.url,
        snippet: f.c.snippet,
        score: f.c.similarity_score,
        ...(f.c.citation_id !== undefined ? { citation_id: f.c.citation_id } : {}),
        ...(f.c.document_id !== undefined ? { document_id: f.c.document_id } : {}),
        ...(f.c.version !== undefined ? { version: f.c.version } : {}),
        ...(f.c.page !== undefined ? { page: f.c.page } : {}),
        ...(f.c.section !== undefined ? { section: f.c.section } : {}),
        ...(f.c.char_start !== undefined ? { char_start: f.c.char_start } : {}),
        ...(f.c.char_end !== undefined ? { char_end: f.c.char_end } : {}),
        ...(f.c.chunk_id !== undefined ? { chunk_id: f.c.chunk_id } : {}),
        ...(f.c.evidence !== undefined ? { evidence: f.c.evidence } : {}),
      }));
      // Baseline size of the chunk envelope with an empty sources array,
      // counted toward each batch's byte budget (default 120_000, safely
      // below the 131072-byte per-line cap).
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify(makeSourcesChunk([])),
      );
      for (const batch of batchCitationSources(
        allSources,
        120_000,
        envelopeBytes,
      )) {
        await this.onChunk(makeSourcesChunk(batch));
      }
    }
    return indices;
  };

  /**
   * Backward-compatible wrapper: nodes that emit an already-ordered citation
   * list (retrieval/parallel) keep calling this. The first emitter in a
   * stream gets indices 1..k — matching the [1..k] it numbered its own
   * grounding block with. Keyed by url→title (the historical dedup key).
   * Nodes that need cross-node-stable keys (the `tool` node) call
   * registerCitations directly with explicit document keys.
   */
  onCitations = async (sources: Citation[]): Promise<void> => {
    if (sources.length === 0) return;
    await this.registerCitations(
      sources.map((c) => ({
        key: c.url.length > 0 ? c.url : c.title,
        citation: c,
      })),
    );
  };
}
