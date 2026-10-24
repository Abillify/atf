// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the shared retrieval core (`handlers/retrieval-pipeline.ts`)
 * behind `/v2/search` and the MCP `search` tool. The two endpoints differ only
 * by explicit stage configuration, so the tests pin each configuration axis:
 * threshold position (before vs. after the limit slice), the rerank gate
 * (`minResults`) and token fitting, the score scale a threshold is compared
 * on, and the error mapping the call-sites rely on.
 */

import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  CandidateSearchError,
  EmbeddingFailedError,
  embedQuery,
  fetchCandidates,
  rankResults,
  rerankStage,
  restoreOriginalContent,
  runRetrievalPipeline,
  type RankingOptions,
  type RetrievalClients,
  type RetrievalPipelineConfig,
} from "../src/handlers/retrieval-pipeline.js";
import type { EmbeddingClient } from "../src/embedding-client.js";
import type { PostgresClient, SearchResult } from "../src/postgres-client.js";
import type { RerankerClient, RerankResponse } from "../src/reranker-client.js";
import type { TokenCounter } from "../src/token-counter.js";

const instant = new Date("2026-03-01T00:00:00.000Z");
const silent = pino({ level: "silent" });

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: overrides.id ?? "1",
    score: overrides.score ?? 0.9,
    content: overrides.content ?? "some content",
    metadata: overrides.metadata ?? {},
    reference: overrides.reference ?? `${overrides.id ?? "1"}#0`,
    base_ref: overrides.base_ref ?? overrides.id ?? "1",
    created: instant,
    modified: instant,
    valid_from: null,
    effective_valid_from: instant,
    ...overrides,
  };
}

const baseRanking: RankingOptions = {
  limit: 10,
  legacyGroupByDocument: false,
  diversify: "none",
  groupBy: "none",
  minScore: null,
  scoreKind: "rrf",
};

// ─── rankResults ─────────────────────────────────────────────────────────────

describe("rankResults", () => {
  const scored = () => [
    hit({ id: "a", score: 0.9 }),
    hit({ id: "b", score: 0.4 }),
    hit({ id: "c", score: 0.8 }),
    hit({ id: "d", score: 0.7 }),
  ];

  it("without a threshold it only slices to the limit", () => {
    const out = rankResults(scored(), { ...baseRanking, limit: 3 });
    expect(out.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(out.qualified).toEqual(out.results);
    expect(out.countBeforeMinScore).toBe(3);
    expect(out.countAfterMinScore).toBe(3);
    expect(out.minScore.abstention).toBeUndefined();
  });

  it("after-slice (v2): the limit is consumed by hits the threshold then drops", () => {
    const out = rankResults(scored(), {
      ...baseRanking,
      limit: 2,
      scoreKind: "rerank",
      minScore: {
        threshold: { value: 0.5, kind: "rerank" },
        position: "after-slice",
      },
    });
    // Slice first -> [a 0.9, b 0.4]; threshold then drops b.
    expect(out.results.map((r) => r.id)).toEqual(["a"]);
    expect(out.countBeforeMinScore).toBe(2);
    expect(out.countAfterMinScore).toBe(1);
    expect(out.minScore.abstention?.kept).toBe(1);
  });

  it("before-slice (MCP): the page is filled from the qualified candidates", () => {
    const out = rankResults(scored(), {
      ...baseRanking,
      limit: 2,
      scoreKind: "rerank",
      minScore: {
        threshold: { value: 0.5, kind: "rerank" },
        position: "before-slice",
      },
    });
    // Filter first -> [a, c, d]; then slice to 2. `qualified` keeps all three.
    expect(out.results.map((r) => r.id)).toEqual(["a", "c"]);
    expect(out.qualified.map((r) => r.id)).toEqual(["a", "c", "d"]);
    expect(out.countBeforeMinScore).toBe(4);
    expect(out.countAfterMinScore).toBe(3);
  });

  it("reports abstention when no candidate reaches the threshold", () => {
    const out = rankResults(scored(), {
      ...baseRanking,
      scoreKind: "rerank",
      minScore: {
        threshold: { value: 0.99, kind: "rerank" },
        position: "after-slice",
      },
    });
    expect(out.results).toEqual([]);
    expect(out.minScore.abstention?.abstain).toBe(true);
  });

  it("skips a threshold set for another score scale (scale_mismatch)", () => {
    const out = rankResults(scored(), {
      ...baseRanking,
      scoreKind: "rrf",
      minScore: {
        threshold: { value: 0.99, kind: "rerank" },
        position: "after-slice",
      },
    });
    expect(out.results).toHaveLength(4);
    expect(out.minScore.abstention?.skipped).toBe("scale_mismatch");
    expect(out.minScore.abstention?.abstain).toBe(false);
  });

  it("a null threshold disables the stage entirely", () => {
    const out = rankResults(scored(), {
      ...baseRanking,
      minScore: { threshold: null, position: "before-slice" },
    });
    expect(out.results).toHaveLength(4);
    expect(out.minScore.abstention).toBeUndefined();
  });

  it("diversify 'default' caps a section per document, 'uncapped' only collapses", () => {
    const sameSection = Array.from({ length: 5 }, (_, i) =>
      hit({
        id: `s${i}`,
        score: 0.9 - i * 0.1,
        base_ref: "doc",
        reference: `doc#${i}`,
        metadata: { section_path: ["Einleitung"] },
      }),
    );
    expect(
      rankResults(sameSection, { ...baseRanking, diversify: "default" }).results,
    ).toHaveLength(3);
    expect(
      rankResults(sameSection, { ...baseRanking, diversify: "uncapped" })
        .results,
    ).toHaveLength(5);
  });

  it("diversify keeps the same table_id of two different documents", () => {
    const out = rankResults(
      [
        hit({
          id: "a",
          score: 0.9,
          base_ref: "sheet-a",
          metadata: { table_id: "T1" },
        }),
        hit({
          id: "b",
          score: 0.8,
          base_ref: "sheet-b",
          metadata: { table_id: "T1" },
        }),
      ],
      { ...baseRanking, diversify: "default" },
    );
    expect(out.results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("legacyGroupByDocument merges chunks of one document into one result", () => {
    const out = rankResults(
      [
        hit({
          id: "c0",
          score: 0.9,
          base_ref: "doc",
          reference: "doc#0",
          content: "alpha",
        }),
        hit({
          id: "c1",
          score: 0.5,
          base_ref: "doc",
          reference: "doc#1",
          content: "beta",
        }),
        hit({ id: "other", score: 0.4, base_ref: "other" }),
      ],
      { ...baseRanking, legacyGroupByDocument: true },
    );
    expect(out.results).toHaveLength(2);
  });
});

// ─── restoreOriginalContent ──────────────────────────────────────────────────

describe("restoreOriginalContent", () => {
  it("puts the untrimmed content back while keeping the rerank score", () => {
    const originals = [hit({ id: "a", content: "full text", score: 0.1 })];
    const reranked = [hit({ id: "a", content: "full", score: 0.97 })];
    const out = restoreOriginalContent(reranked, originals);
    expect(out[0]?.content).toBe("full text");
    expect(out[0]?.score).toBe(0.97);
  });

  it("keeps a result without an original as-is", () => {
    const reranked = [hit({ id: "ghost", content: "kept" })];
    expect(restoreOriginalContent(reranked, [])[0]?.content).toBe("kept");
  });

  it("returns the same object when the content is unchanged", () => {
    const original = hit({ id: "a", content: "same" });
    const reranked = hit({ id: "a", content: "same", score: 0.5 });
    expect(restoreOriginalContent([reranked], [original])[0]).toBe(reranked);
  });
});

// ─── rerankStage ─────────────────────────────────────────────────────────────

function fakeReranker(
  scoreFor: (index: number) => number,
  seen: { docs: string[] } = { docs: [] },
): RerankerClient {
  return {
    async rerank(_query, documents): Promise<RerankResponse> {
      seen.docs = documents;
      return {
        ok: true,
        result: documents.map((_d, index) => ({
          index,
          score: scoreFor(index),
        })),
      };
    },
  };
}

describe("rerankStage", () => {
  const candidates = () => [
    hit({ id: "a", score: 0.5, content: "aaa" }),
    hit({ id: "b", score: 0.4, content: "bbb" }),
  ];

  it("is a passthrough when rerank is inactive", async () => {
    const list = candidates();
    const out = await rerankStage(
      { embeddingClient: {} as EmbeddingClient, postgresClient: {} as never },
      "q",
      list,
      silent,
      { active: false },
    );
    expect(out.results).toBe(list);
    expect(out.outcome).toBeNull();
  });

  it("is a passthrough when no reranker client is configured", async () => {
    const list = candidates();
    const out = await rerankStage(
      {
        embeddingClient: {} as EmbeddingClient,
        postgresClient: {} as never,
        rerankerClient: null,
      },
      "q",
      list,
      silent,
      { active: true },
    );
    expect(out.outcome).toBeNull();
    expect(out.results).toBe(list);
  });

  it("skips reranking below minResults (v2: a single hit is not reranked)", async () => {
    const rerank = vi.fn();
    const out = await rerankStage(
      {
        embeddingClient: {} as EmbeddingClient,
        postgresClient: {} as never,
        rerankerClient: { rerank } as unknown as RerankerClient,
      },
      "q",
      [hit({ id: "only" })],
      silent,
      { active: true, minResults: 2 },
    );
    expect(rerank).not.toHaveBeenCalled();
    expect(out.outcome).toBeNull();
  });

  it("reranks a single hit when minResults is not set (MCP)", async () => {
    const out = await rerankStage(
      {
        embeddingClient: {} as EmbeddingClient,
        postgresClient: {} as never,
        rerankerClient: fakeReranker(() => 0.8),
      },
      "q",
      [hit({ id: "only", score: 0.1 })],
      silent,
      { active: true },
    );
    expect(out.outcome?.applied).toBe(true);
    expect(out.results[0]?.score).toBe(0.8);
  });

  it("reorders by rerank score", async () => {
    const out = await rerankStage(
      {
        embeddingClient: {} as EmbeddingClient,
        postgresClient: {} as never,
        // The second candidate scores higher.
        rerankerClient: fakeReranker((i) => (i === 1 ? 0.9 : 0.2)),
      },
      "q",
      candidates(),
      silent,
      { active: true },
    );
    expect(out.results.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("with a token counter, the reranker sees trimmed text but results keep the originals", async () => {
    const long = "x".repeat(40_000);
    const seen = { docs: [] as string[] };
    // One character is one token: the 40 000-character hits are far over any
    // rerank budget and have to be trimmed for the reranker.
    const counter: TokenCounter = {
      count: async (text: string) => text.length,
      countBatch: async (texts: string[]) => texts.map((t) => t.length),
      cacheSize: 0,
    };
    const out = await rerankStage(
      {
        embeddingClient: {} as EmbeddingClient,
        postgresClient: {} as never,
        rerankerClient: fakeReranker(() => 0.7, seen),
      },
      "q",
      [hit({ id: "a", content: long }), hit({ id: "b", content: long })],
      silent,
      { active: true, tokenCounter: counter },
    );
    expect(out.outcome?.applied).toBe(true);
    expect(seen.docs).toHaveLength(2);
    for (const doc of seen.docs) expect(doc.length).toBeLessThan(long.length);
    // The caller always gets the full content back, with the rerank score.
    for (const r of out.results) {
      expect(r.content).toBe(long);
      expect(r.score).toBe(0.7);
    }
  });

  it("falls back to the retrieval order when the reranker fails", async () => {
    const failing: RerankerClient = {
      async rerank(): Promise<RerankResponse> {
        return { ok: false, error: { code: "RERANK_UNREACHABLE", message: "x" } };
      },
    };
    const list = candidates();
    const out = await rerankStage(
      {
        embeddingClient: {} as EmbeddingClient,
        postgresClient: {} as never,
        rerankerClient: failing,
      },
      "q",
      list,
      silent,
      { active: true },
    );
    expect(out.outcome?.applied).toBe(false);
    expect(out.outcome?.fallbackReason).toBe("failed");
    expect(out.results.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

// ─── embedQuery / fetchCandidates error mapping ──────────────────────────────

describe("embedQuery", () => {
  const okEmbedder = (vector: number[]): EmbeddingClient =>
    ({
      embed: vi.fn(async () => ({ ok: true, result: { vector } })),
    }) as unknown as EmbeddingClient;

  it("returns the vector", async () => {
    const clients: RetrievalClients = {
      embeddingClient: okEmbedder([1, 2, 3]),
      postgresClient: {} as never,
    };
    expect(await embedQuery(clients, "hello")).toEqual([1, 2, 3]);
  });

  it("maps a backend failure to EmbeddingFailedError", async () => {
    const clients: RetrievalClients = {
      embeddingClient: {
        embed: async () => ({
          ok: false,
          error: { code: "LLM_UNREACHABLE", message: "embed down" },
        }),
      } as unknown as EmbeddingClient,
      postgresClient: {} as never,
    };
    await expect(embedQuery(clients, "q")).rejects.toThrow(EmbeddingFailedError);
    await expect(embedQuery(clients, "q")).rejects.toThrow("embed down");
  });

  it("maps a failure through the query cache to EmbeddingFailedError", async () => {
    const clients: RetrievalClients = {
      embeddingClient: {
        embed: async () => ({
          ok: false,
          error: { code: "LLM_UNREACHABLE", message: "cache path down" },
        }),
      } as unknown as EmbeddingClient,
      postgresClient: {} as never,
      queryCache: {
        getOrEmbed: async (text: string, fn: (t: string) => Promise<number[]>) =>
          fn(text),
      } as never,
    };
    await expect(embedQuery(clients, "q")).rejects.toThrow(EmbeddingFailedError);
  });
});

describe("fetchCandidates", () => {
  const params = {
    query: "q",
    vector: [0.1],
    limit: 5,
    collection: "documents",
    scope: {} as never,
    hybrid: true,
    includeAllVersions: false,
    offset: 0,
    candidateMultiplier: 4,
    ftsOnly: false,
  };

  it("surfaces the backend error code as CandidateSearchError", async () => {
    const clients: RetrievalClients = {
      embeddingClient: {} as EmbeddingClient,
      postgresClient: {
        search: async () => ({
          ok: false,
          error: { code: "COLLECTION_NOT_FOUND", message: "no such collection" },
        }),
      } as unknown as PostgresClient,
    };
    const err = await fetchCandidates(clients, params).catch((e) => e);
    expect(err).toBeInstanceOf(CandidateSearchError);
    expect((err as CandidateSearchError).code).toBe("COLLECTION_NOT_FOUND");
  });

  it("returns the candidate list on success", async () => {
    const list = [hit({ id: "a" })];
    const clients: RetrievalClients = {
      embeddingClient: {} as EmbeddingClient,
      postgresClient: {
        search: async () => ({ ok: true, result: list }),
      } as unknown as PostgresClient,
    };
    expect(await fetchCandidates(clients, params)).toBe(list);
  });
});

// ─── runRetrievalPipeline (both endpoint configurations) ─────────────────────

describe("runRetrievalPipeline", () => {
  function clientsFor(
    candidates: SearchResult[],
    reranker?: RerankerClient,
  ): { clients: RetrievalClients; search: ReturnType<typeof vi.fn> } {
    const search = vi.fn(async () => ({ ok: true, result: candidates }));
    return {
      search,
      clients: {
        embeddingClient: {
          embed: async () => ({ ok: true, result: { vector: [0.1, 0.2] } }),
        } as unknown as EmbeddingClient,
        postgresClient: {
          search,
          lookupFigureUnits: async () => ({ ok: true, result: [] }),
        } as unknown as PostgresClient,
        rerankerClient: reranker ?? null,
      },
    };
  }

  const cfg = (
    over: Partial<RetrievalPipelineConfig> = {},
  ): RetrievalPipelineConfig => ({
    query: "wie wird der wareneingang gebucht",
    embedText: "wie wird der wareneingang gebucht",
    collection: "documents",
    scope: {} as never,
    limit: 2,
    fetchLimit: 8,
    hybrid: true,
    includeAllVersions: false,
    offset: 0,
    candidateMultiplier: 4,
    ftsOnly: false,
    logSparseFailure: false,
    rerank: { active: false },
    documentGroups: false,
    legacyGroupByDocument: false,
    diversify: "none",
    groupBy: "none",
    minScore: null,
    resolveFigures: false,
    ...over,
  });

  it("derives the retrieval score scale from the mode when nothing was reranked", async () => {
    const list = [hit({ id: "a" })];
    const { clients } = clientsFor(list);
    expect(
      (await runRetrievalPipeline(clients, silent, cfg({ hybrid: true })))
        .scoreKind,
    ).toBe("rrf");
    expect(
      (await runRetrievalPipeline(clients, silent, cfg({ hybrid: false })))
        .scoreKind,
    ).toBe("cosine");
    expect(
      (
        await runRetrievalPipeline(
          clients,
          silent,
          cfg({ hybrid: true, ftsOnly: true }),
        )
      ).scoreKind,
    ).toBe("fts");
  });

  it("uses the rerank scale once reranking applied, and the threshold compares on it", async () => {
    const list = [
      hit({ id: "a", score: 0.5 }),
      hit({ id: "b", score: 0.4 }),
      hit({ id: "c", score: 0.3 }),
    ];
    const { clients } = clientsFor(
      list,
      fakeReranker((i) => [0.9, 0.2, 0.8][i] ?? 0),
    );
    const out = await runRetrievalPipeline(
      clients,
      silent,
      cfg({
        limit: 2,
        rerank: { active: true, minResults: 2 },
        minScore: {
          threshold: { value: 0.5, kind: "rerank" },
          position: "before-slice",
        },
      }),
    );
    expect(out.scoreKind).toBe("rerank");
    expect(out.candidateCount).toBe(3);
    expect(out.results.map((r) => r.id)).toEqual(["a", "c"]);
    expect(out.qualified.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("passes the over-fetch limit to the store, not the page size", async () => {
    const { clients, search } = clientsFor([hit({ id: "a" })]);
    await runRetrievalPipeline(clients, silent, cfg({ limit: 2, fetchLimit: 8 }));
    const call = search.mock.calls[0] as unknown[];
    expect(call[2]).toBe(8);
  });

  it("propagates an embedding failure as EmbeddingFailedError", async () => {
    const { clients } = clientsFor([]);
    clients.embeddingClient = {
      embed: async () => ({
        ok: false,
        error: { code: "LLM_UNREACHABLE", message: "down" },
      }),
    } as unknown as EmbeddingClient;
    await expect(
      runRetrievalPipeline(clients, silent, cfg()),
    ).rejects.toThrow(EmbeddingFailedError);
  });

  it("starts the dense and the sparse query embedding at the same time", async () => {
    const order: string[] = [];
    const { clients } = clientsFor([hit({ id: "a" })]);
    clients.embeddingClient = {
      embed: async () => {
        order.push("dense:start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("dense:end");
        return { ok: true, result: { vector: [0.1] } };
      },
    } as unknown as EmbeddingClient;
    clients.sparseClient = {
      embedSparse: async () => {
        order.push("sparse:start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("sparse:end");
        return { ok: true, result: { indices: [1], values: [1] } };
      },
    } as never;
    await runRetrievalPipeline(clients, silent, cfg({ hybrid: true }));
    // Sequential execution would put dense:end before sparse:start.
    expect(order.indexOf("sparse:start")).toBeLessThan(order.indexOf("dense:end"));
  });

  it("a sparse failure degrades to the dense list; a dense failure still throws", async () => {
    const { clients } = clientsFor([hit({ id: "a" })]);
    clients.sparseClient = {
      embedSparse: async () => ({ ok: false, error: { code: "X", message: "down" } }),
    } as never;
    const out = await runRetrievalPipeline(clients, silent, cfg({ hybrid: true }));
    expect(out.candidateCount).toBe(1);

    clients.embeddingClient = {
      embed: async () => ({ ok: false, error: { code: "X", message: "dense down" } }),
    } as unknown as EmbeddingClient;
    await expect(
      runRetrievalPipeline(clients, silent, cfg({ hybrid: true })),
    ).rejects.toThrow(EmbeddingFailedError);
  });

  it("embeds the embedText verbatim so a pure-noise query never embeds an empty string", async () => {
    // The call-sites pass `prepareFtsContent(q) || q` as `embedText`: a query
    // that preprocessing empties (e.g. only URLs) reaches the backend as the
    // raw query. The pipeline must embed exactly that text, unchanged.
    const embed = vi.fn(async () => ({ ok: true, result: { vector: [0.1] } }));
    const embedSparse = vi.fn(async () => ({
      ok: true,
      result: { indices: [1], values: [1] },
    }));
    const { clients } = clientsFor([hit({ id: "a" })]);
    clients.embeddingClient = { embed } as unknown as EmbeddingClient;
    clients.sparseClient = { embedSparse } as never;
    for (const embedText of ["???", "https://example.com/x"]) {
      await runRetrievalPipeline(
        clients,
        silent,
        cfg({ query: embedText, embedText, hybrid: true }),
      );
      expect(embed).toHaveBeenCalledWith(embedText);
      expect(embedSparse).toHaveBeenCalledWith(embedText);
    }
  });

  it("does not look up figures unless asked to", async () => {
    const lookup = vi.fn(async () => ({ ok: true, result: [] }));
    const { clients } = clientsFor([hit({ id: "a" })]);
    (clients.postgresClient as unknown as { lookupFigureUnits: unknown }).lookupFigureUnits =
      lookup;
    const out = await runRetrievalPipeline(
      clients,
      silent,
      cfg({ resolveFigures: false }),
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(out.figureInfo.size).toBe(0);
  });

  it("embeds the HyDE expansion while the lexical branch keeps the original query", async () => {
    const embed = vi.fn(async () => ({
      ok: true as const,
      result: { vector: [0.1, 0.2] },
    }));
    const expand = vi.fn(async () => ({
      ok: true as const,
      result: "Die Buchung erfolgt im Modul Wareneingang.",
    }));
    const { clients, search } = clientsFor([hit({ id: "a" })]);
    clients.embeddingClient = { embed } as unknown as EmbeddingClient;
    clients.hydeClient = { expand } as never;
    const out = await runRetrievalPipeline(
      clients,
      silent,
      cfg({ hyde: true }),
    );
    expect(expand).toHaveBeenCalledWith(cfg().query, undefined);
    expect(embed).toHaveBeenCalledWith(
      "Die Buchung erfolgt im Modul Wareneingang.",
    );
    // The PostgreSQL lexical branch still receives the original query.
    expect(search.mock.calls[0]?.[0]).toBe(cfg().query);
    expect(out.hyde).toEqual({ applied: true, fallbackReason: null });
  });

  it("reports HyDE as unavailable when no client is wired", async () => {
    const { clients } = clientsFor([hit({ id: "a" })]);
    const out = await runRetrievalPipeline(clients, silent, cfg({ hyde: true }));
    expect(out.hyde).toEqual({ applied: false, fallbackReason: "unavailable" });
  });

  it("falls back to the configured embed text when the expansion fails", async () => {
    const embed = vi.fn(async () => ({
      ok: true as const,
      result: { vector: [0.1, 0.2] },
    }));
    const { clients } = clientsFor([hit({ id: "a" })]);
    clients.embeddingClient = { embed } as unknown as EmbeddingClient;
    clients.hydeClient = {
      expand: async () => ({ ok: false as const, error: "upstream timeout" }),
    } as never;
    const base = cfg({ hyde: true });
    const out = await runRetrievalPipeline(clients, silent, base);
    expect(embed).toHaveBeenCalledWith(base.embedText);
    expect(out.hyde).toEqual({ applied: false, fallbackReason: "failed" });
  });

  it("never consults the HyDE client unless the config asks for it", async () => {
    const expand = vi.fn(async () => ({ ok: true as const, result: "x" }));
    const { clients } = clientsFor([hit({ id: "a" })]);
    clients.hydeClient = { expand } as never;
    const out = await runRetrievalPipeline(clients, silent, cfg());
    expect(expand).not.toHaveBeenCalled();
    expect(out.hyde).toEqual({
      applied: false,
      fallbackReason: "not-requested",
    });
  });
});
