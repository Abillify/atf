// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the RAG reranker (`src/graph/reranker.ts`).
 *
 * Covers the pure helpers (parse vectorsearch payloads, rerank selection,
 * retrieval-score fallback) and the BedrockReranker against a structurally
 * mocked `send` so no AWS calls happen. The Rerank request shape is asserted so
 * a future SDK bump that changes the contract is caught here.
 */

import { afterEach, describe, test, expect } from "bun:test";
import {
  BedrockReranker,
  createBedrockReranker,
  rerankModelArn,
  parseVectorSearchResults,
  selectRerankedChunks,
  selectByRetrievalScore,
  docKeyOf,
  type RagChunk,
} from "../reranker.js";
import { setProviderRegistry } from "../../config/providers.js";
import type { AppConfig } from "../../config/index.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

/** Builds an MCP-style text-content wrapper around a vectorsearch payload. */
function mcpContent(results: unknown[]): unknown {
  return [
    { type: "text", text: JSON.stringify({ results, count: results.length }) },
  ];
}

const chunk = (over: Partial<RagChunk>): RagChunk => ({
  id: "x",
  title: "T",
  url: "",
  content: "c",
  retrievalScore: 0,
  ...over,
});

describe("parseVectorSearchResults", () => {
  test("extracts id/title/url/content/score from the MCP text wrapper", () => {
    const content = mcpContent([
      {
        id: "121",
        score: 0.42,
        title: "Client",
        link: "https://docs.example.com/x",
        content: "Ein CR ab 3h wird benötigt.",
        tags: ["ExampleCorp B2B"],
        metadata: { updatedBy: "Alice Example" },
      },
    ]);
    const out = parseVectorSearchResults(content);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "121",
      title: "Client",
      url: "https://docs.example.com/x",
      content: "Ein CR ab 3h wird benötigt.",
      retrievalScore: 0.42,
      tags: ["ExampleCorp B2B"],
      metadata: { updatedBy: "Alice Example" },
    });
  });

  test("falls back to metadata title and item.text, and synthesises a title", () => {
    const out = parseVectorSearchResults(
      mcpContent([
        { id: "9", text: "passage", metadata: { name: "Reporting" } },
        { score: 0.1 }, // no id/title → synthesised "Quelle 2"
      ]),
    );
    expect(at(out, 0).title).toBe("Reporting");
    expect(at(out, 0).content).toBe("passage");
    expect(at(out, 1).title).toBe("Quelle 2");
  });

  test("accepts an already-parsed object and a raw JSON string", () => {
    expect(
      parseVectorSearchResults({ results: [{ id: "1", title: "A" }] }),
    ).toHaveLength(1);
    expect(
      parseVectorSearchResults(
        JSON.stringify({ results: [{ id: "1", title: "A" }] }),
      ),
    ).toHaveLength(1);
  });

  test("returns [] for non-vectorsearch payloads", () => {
    expect(parseVectorSearchResults(undefined)).toEqual([]);
    expect(parseVectorSearchResults("not json")).toEqual([]);
    expect(parseVectorSearchResults([{ type: "text", text: "{}" }])).toEqual(
      [],
    );
    expect(parseVectorSearchResults({ foo: 1 })).toEqual([]);
  });

  test("parses v2 provenance: section_path, pages, figure_kind, caption, assets (Req 16.4)", () => {
    const out = parseVectorSearchResults(
      mcpContent([
        {
          id: "doc-1#4",
          title: "Handbuch",
          score: 0.8,
          content: "…",
          section_path: ["4 Antragseingang", "4.2 Anmeldung"],
          pages: [37, 38],
          assets: [
            {
              asset_id: "asset-12",
              kind: "figure",
              figure_kind: "ui_mask",
              caption: "Abbildung 12",
              page: 37,
              bbox: [1, 2, 3, 4],
              thumb_url: "https://a/thumb",
              url: "https://a/preview",
            },
          ],
        },
      ]),
    );
    const c = at(out, 0);
    expect(c.sectionPath).toEqual(["4 Antragseingang", "4.2 Anmeldung"]);
    expect(c.pages).toEqual([37, 38]);
    expect(c.assets).toHaveLength(1);
    expect(c.assets?.[0]).toEqual({
      assetId: "asset-12",
      kind: "figure",
      figureKind: "ui_mask",
      caption: "Abbildung 12",
      page: 37,
      bbox: [1, 2, 3, 4],
      thumbUrl: "https://a/thumb",
      url: "https://a/preview",
    });
  });

  test("carries no v2 provenance for a legacy hit (backward-compatible)", () => {
    const out = parseVectorSearchResults(
      mcpContent([{ id: "1", title: "A", content: "x", score: 0.5 }]),
    );
    const c = at(out, 0);
    expect(c.sectionPath).toBeUndefined();
    expect(c.pages).toBeUndefined();
    expect(c.figureKind).toBeUndefined();
    expect(c.caption).toBeUndefined();
    expect(c.assets).toBeUndefined();
  });

  test("carries no trust labels for an unlabelled payload (keys absent)", () => {
    const out = parseVectorSearchResults(
      mcpContent([{ id: "1", title: "A", content: "x", score: 0.5 }]),
    );
    const c = at(out, 0);
    expect("injectionRisk" in c).toBe(false);
    expect("contentTrust" in c).toBe(false);
  });

  test("parses a per-hit injection_risk / content_trust label from Search", () => {
    const out = parseVectorSearchResults(
      mcpContent([
        {
          id: "1",
          title: "A",
          content: "x",
          score: 0.5,
          injection_risk: "suspected",
          content_trust: "untrusted",
        },
      ]),
    );
    expect(at(out, 0).injectionRisk).toBe("suspected");
    expect(at(out, 0).contentTrust).toBe("untrusted");
  });

  test("an envelope label applies to hits without their own label", () => {
    const payload = JSON.stringify({
      results: [
        { id: "1", title: "A", content: "x", score: 0.5 },
        { id: "2", title: "B", content: "y", score: 0.4 },
      ],
      count: 2,
      injection_risk: "suspected",
      content_trust: "untrusted",
    });
    const out = parseVectorSearchResults([{ type: "text", text: payload }]);
    expect(at(out, 0).injectionRisk).toBe("suspected");
    expect(at(out, 1).injectionRisk).toBe("suspected");
    expect(at(out, 0).contentTrust).toBe("untrusted");
  });

  test("a per-hit label overrides the envelope label", () => {
    const payload = JSON.stringify({
      results: [
        {
          id: "1",
          title: "A",
          content: "x",
          score: 0.5,
          injection_risk: "none",
        },
      ],
      injection_risk: "suspected",
    });
    const out = parseVectorSearchResults([{ type: "text", text: payload }]);
    expect(at(out, 0).injectionRisk).toBe("none");
  });

  test("an unknown injection_risk value yields no label, never a wrong one", () => {
    const payload = JSON.stringify({
      results: [{ id: "1", title: "A", content: "x", score: 0.5 }],
      injection_risk: "maybe",
    });
    const out = parseVectorSearchResults([{ type: "text", text: payload }]);
    const c = at(out, 0);
    expect("injectionRisk" in c).toBe(false);
    expect("contentTrust" in c).toBe(false);
  });
});

describe("selectRerankedChunks", () => {
  const chunks: RagChunk[] = [
    chunk({ id: "a", url: "u1", content: "a", retrievalScore: 0.1 }),
    chunk({ id: "b", url: "u2", content: "b", retrievalScore: 0.9 }),
    chunk({ id: "c", url: "u1", content: "c", retrievalScore: 0.2 }), // same doc as a
    chunk({ id: "d", url: "u3", content: "d", retrievalScore: 0.3 }),
  ];

  test("orders by rerank hits and overwrites score with the rerank relevance", () => {
    const hits = [
      { index: 3, score: 0.95 },
      { index: 0, score: 0.8 },
    ];
    const out = selectRerankedChunks(chunks, hits, 8);
    expect(out.map((c) => c.id)).toEqual(["d", "a"]);
    expect(at(out, 0).retrievalScore).toBe(0.95);
  });

  test("deduplicates by document (url) keeping the higher-ranked passage", () => {
    const hits = [
      { index: 0, score: 0.9 }, // u1 (a)
      { index: 2, score: 0.8 }, // u1 (c) — same doc, dropped
      { index: 1, score: 0.7 }, // u2 (b)
    ];
    const out = selectRerankedChunks(chunks, hits, 8);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("caps at topNDocs and ignores out-of-range indices", () => {
    const hits = [
      { index: 99, score: 0.99 }, // out of range — skipped
      { index: 1, score: 0.9 },
      { index: 3, score: 0.8 },
    ];
    expect(selectRerankedChunks(chunks, hits, 1).map((c) => c.id)).toEqual([
      "b",
    ]);
  });
});

describe("selectByRetrievalScore (fallback)", () => {
  test("orders by retrieval score desc, dedupes by doc, caps at topN", () => {
    const chunks: RagChunk[] = [
      chunk({ id: "a", url: "u1", retrievalScore: 0.1 }),
      chunk({ id: "b", url: "u2", retrievalScore: 0.9 }),
      chunk({ id: "c", url: "u1", retrievalScore: 0.5 }), // same doc as a, higher
      chunk({ id: "d", url: "u3", retrievalScore: 0.3 }),
    ];
    const out = selectByRetrievalScore(chunks, 2);
    expect(out.map((c) => c.id)).toEqual(["b", "c"]);
  });

  test("fuses scoreWeight: effective score = retrievalScore * scoreWeight", () => {
    // Raw score would rank the cross source (0.8) above the primary (0.6), but
    // the primary's weight 1.0 vs the cross source's 0.4 flips the order:
    // primary 0.6*1.0=0.60 > cross 0.8*0.4=0.32.
    const chunks: RagChunk[] = [
      chunk({ id: "cross", url: "u2", retrievalScore: 0.8, scoreWeight: 0.4 }),
      chunk({ id: "primary", url: "u1", retrievalScore: 0.6, scoreWeight: 1 }),
    ];
    const out = selectByRetrievalScore(chunks, 5);
    expect(out.map((c) => c.id)).toEqual(["primary", "cross"]);
  });

  test("applies minScore against the effective (weighted) score", () => {
    // 0.8 * 0.3 = 0.24 < 0.3 → dropped; 0.7 * 1 = 0.70 → kept.
    const chunks: RagChunk[] = [
      chunk({ id: "weak", url: "u2", retrievalScore: 0.8, scoreWeight: 0.3 }),
      chunk({ id: "strong", url: "u1", retrievalScore: 0.7, scoreWeight: 1 }),
    ];
    const out = selectByRetrievalScore(chunks, 5, 0.3);
    expect(out.map((c) => c.id)).toEqual(["strong"]);
  });

  test("treats a missing scoreWeight as 1.0 (unchanged behaviour)", () => {
    const chunks: RagChunk[] = [
      chunk({ id: "a", url: "u1", retrievalScore: 0.9 }),
      chunk({ id: "b", url: "u2", retrievalScore: 0.5, scoreWeight: 1 }),
    ];
    const out = selectByRetrievalScore(chunks, 5);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("docKeyOf + base_ref document dedup", () => {
  test("prefers base_ref, then url, then title", () => {
    expect(docKeyOf({ reference: "/akte/A", url: "u", title: "T" })).toBe(
      "/akte/A",
    );
    expect(docKeyOf({ reference: "", url: "u", title: "T" })).toBe("u");
    expect(docKeyOf({ url: "", title: "T" })).toBe("T");
  });

  test("selectByRetrievalScore dedupes two chunks of the SAME base_ref even when their url differs", () => {
    // Two passages of one document: same base_ref, different chunk urls. The
    // old url-only key would keep BOTH; base_ref keying collapses them to one.
    const chunks: RagChunk[] = [
      chunk({ id: "a", url: "u#0", baseRef: "/akte/A", retrievalScore: 0.4 }),
      chunk({ id: "b", url: "u#1", baseRef: "/akte/A", retrievalScore: 0.9 }),
      chunk({ id: "c", url: "u2", baseRef: "/akte/B", retrievalScore: 0.5 }),
    ];
    const out = selectByRetrievalScore(chunks, 8);
    expect(out.map((c) => c.id)).toEqual(["b", "c"]);
  });

  test("selectRerankedChunks dedupes by base_ref", () => {
    const chunks: RagChunk[] = [
      chunk({ id: "a", url: "u#0", baseRef: "/akte/A" }),
      chunk({ id: "b", url: "u#1", baseRef: "/akte/A" }), // same doc
      chunk({ id: "c", url: "u2", baseRef: "/akte/B" }),
    ];
    const hits = [
      { index: 0, score: 0.9 },
      { index: 1, score: 0.8 }, // same base_ref as index 0 → dropped
      { index: 2, score: 0.7 },
    ];
    expect(selectRerankedChunks(chunks, hits, 8).map((c) => c.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("createBedrockReranker — named provider", () => {
  const cfg = (over: Partial<AppConfig>): AppConfig =>
    ({ rerankEnabled: true, ...over }) as AppConfig;

  afterEach(() => {
    setProviderRegistry(undefined);
  });

  test("builds from the named bedrock provider's region and credentials", () => {
    setProviderRegistry([
      {
        name: "awseu",
        protocol: "bedrock",
        region: "eu-central-1",
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
      },
    ]);
    expect(
      createBedrockReranker(cfg({ rerankProvider: "awseu" })),
    ).toBeDefined();
  });

  test("RERANK_REGION overrides the provider region", () => {
    setProviderRegistry([
      { name: "awseu", protocol: "bedrock", region: "eu-central-1" },
    ]);
    expect(
      createBedrockReranker(
        cfg({ rerankProvider: "awseu", rerankRegion: "us-east-1" }),
      ),
    ).toBeDefined();
  });

  test("stays disabled for an unknown name, a non-bedrock protocol or no region", () => {
    setProviderRegistry([
      { name: "gpuvllm", protocol: "openai", url: "http://vllm:8000/v1" },
      { name: "awseu", protocol: "bedrock" },
    ]);
    // Unknown name: a typo must not silently fall back to ambient credentials.
    expect(createBedrockReranker(cfg({ rerankProvider: "typo" }))).toBeUndefined();
    // Wrong protocol: Rerank is a Bedrock API.
    expect(
      createBedrockReranker(cfg({ rerankProvider: "gpuvllm" })),
    ).toBeUndefined();
    // No region anywhere: Rerank is region-scoped, so staying off beats guessing.
    expect(createBedrockReranker(cfg({ rerankProvider: "awseu" }))).toBeUndefined();
  });
});

describe("rerankModelArn", () => {
  test("builds a foundation-model ARN from a model id + region", () => {
    expect(rerankModelArn("cohere.rerank-v3-5:0", "eu-central-1")).toBe(
      "arn:aws:bedrock:eu-central-1::foundation-model/cohere.rerank-v3-5:0",
    );
  });
  test("passes through an existing ARN unchanged", () => {
    const arn = "arn:aws:bedrock:us-west-2:123:inference-profile/x";
    expect(rerankModelArn(arn, "eu-central-1")).toBe(arn);
  });
});

describe("BedrockReranker", () => {
  test("maps results to {index, score} and sends a well-formed Rerank request", async () => {
    let captured: unknown;
    const client = {
      send: async (cmd: { input: unknown }) => {
        captured = cmd.input;
        return {
          results: [
            { index: 1, relevanceScore: 0.91 },
            { index: 0, relevanceScore: 0.42 },
          ],
        };
      },
    };
    const rr = new BedrockReranker(
      client as unknown as ConstructorParameters<typeof BedrockReranker>[0],
      "arn:aws:bedrock:eu-central-1::foundation-model/cohere.rerank-v3-5:0",
    );
    const hits = await rr.rerank("query?", ["doc a", "doc b"], 5);
    expect(hits).toEqual([
      { index: 1, score: 0.91 },
      { index: 0, score: 0.42 },
    ]);
    // Request shape: TEXT query, INLINE TEXT sources, model ARN + numberOfResults.
    const input = captured as {
      queries: Array<{ type: string; textQuery: { text: string } }>;
      sources: Array<{ type: string; inlineDocumentSource: { type: string } }>;
      rerankingConfiguration: {
        bedrockRerankingConfiguration: {
          numberOfResults: number;
          modelConfiguration: { modelArn: string };
        };
      };
    };
    const query0 = at(input.queries, 0);
    expect(query0.type).toBe("TEXT");
    expect(query0.textQuery.text).toBe("query?");
    expect(input.sources).toHaveLength(2);
    const source0 = at(input.sources, 0);
    expect(source0.type).toBe("INLINE");
    expect(source0.inlineDocumentSource.type).toBe("TEXT");
    expect(
      input.rerankingConfiguration.bedrockRerankingConfiguration
        .numberOfResults,
    ).toBe(2); // min(topN=5, docs=2)
    expect(
      input.rerankingConfiguration.bedrockRerankingConfiguration
        .modelConfiguration.modelArn,
    ).toContain("cohere.rerank-v3-5:0");
  });

  test("returns [] (no throw) on an empty query or empty documents without calling send", async () => {
    let called = false;
    const client = {
      send: async () => {
        called = true;
        return { results: [] };
      },
    };
    const rr = new BedrockReranker(
      client as unknown as ConstructorParameters<typeof BedrockReranker>[0],
      "arn",
    );
    expect(await rr.rerank("", ["d"], 5)).toEqual([]);
    expect(await rr.rerank("q", [], 5)).toEqual([]);
    expect(called).toBe(false);
  });

  test("swallows API errors and returns [] so callers fall back to retrieval order", async () => {
    const client = {
      send: async () => {
        throw new Error("AccessDeniedException: model not available in region");
      },
    };
    const rr = new BedrockReranker(
      client as unknown as ConstructorParameters<typeof BedrockReranker>[0],
      "arn",
    );
    expect(await rr.rerank("q", ["a", "b"], 5)).toEqual([]);
  });
});
