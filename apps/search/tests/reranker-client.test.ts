// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/reranker-client.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRerankerClient } from "../src/reranker-client.js";
import pino from "pino";

const logger = pino({ level: "silent" });

function makeClient(separator = "\n") {
  return createRerankerClient({
    rerankUrl: "http://llm:8080",
    rerankModel: "awenleven/bge-reranker-v2-m3",
    separator,
    endpoint: "embeddings",
    logger,
  });
}

// ── Rank-pooling helpers (1-dim embeddings) ───────────────────────────────────

function rankPoolingResponse(embeddings: number[][]) {
  return {
    ok: true,
    json: async () => ({
      data: embeddings.map((e, i) => ({ index: i, embedding: e })),
    }),
    text: async () => "",
  };
}

// ── Bi-encoder helpers (N-dim embeddings) ─────────────────────────────────────

/** Build a mock fetch that handles the two calls in bi-encoder mode:
 *  1. query alone               → queryEmbedding (N-dim, probe + mode detection)
 *  2. batch of documents alone  → docEmbeddings (used for scoring)
 */
function biEncoderFetch(queryVec: number[], docVecs: number[][]) {
  let callCount = 0;
  return vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
    callCount++;
    const body = JSON.parse(opts.body as string) as {
      input: string | string[];
    };
    const input = body.input;

    if (callCount === 1) {
      // First call: query alone (probe) — return N-dim to trigger bi-encoder
      return {
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: queryVec }] }),
        text: async () => "",
      };
    }
    // Second call: documents alone
    const inputs = Array.isArray(input) ? input : [input];
    return {
      ok: true,
      json: async () => ({
        data: inputs.map((_: string, i: number) => ({
          index: i,
          embedding: docVecs[i] ?? docVecs[0],
        })),
      }),
      text: async () => "",
    };
  });
}

describe("createRerankerClient — rank-pooling mode (1-dim embeddings)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns [] without calling fetch when documents is empty", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const result = await makeClient().rerank("query", []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends combined query+separator+document inputs in one batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(rankPoolingResponse([[1.0], [-1.0]])),
    );
    await makeClient(" [SEP] ").rerank("q", ["docA", "docB"]);
    // First call is the probe (query alone); second call carries the pairs.
    const call = vi.mocked(fetch).mock.calls[1];
    const body = JSON.parse(call![1]!.body as string) as { input: string[] };
    expect(body.input).toEqual(["q [SEP] docA", "q [SEP] docB"]);
  });

  it("sigmoid-normalizes 1-dim embeddings to [0,1]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(rankPoolingResponse([[0], [100], [-100]])),
    );
    const result = await makeClient().rerank("q", ["a", "b", "c"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const byIdx = new Map(result.result.map((s) => [s.index, s.score]));
      expect(byIdx.get(0)).toBeCloseTo(0.5, 5);
      expect(byIdx.get(1)!).toBeGreaterThan(0.99);
      expect(byIdx.get(2)!).toBeLessThan(0.01);
      for (const s of result.result) {
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("preserves the server-provided index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { index: 5, embedding: [2.0] },
            { index: 3, embedding: [1.0] },
          ],
        }),
        text: async () => "",
      }),
    );
    const result = await makeClient().rerank("q", ["x", "y"]);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.result.map((s) => s.index).sort()).toEqual([3, 5]);
  });
});

describe("createRerankerClient — bi-encoder mode (N-dim embeddings)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("makes 2 fetch calls and scores by dot product when model returns N-dim", async () => {
    // query vec = [1, 0], doc vecs = [[1,0], [0,1], [-1,0]]
    // dot products: 1.0, 0.0, -1.0 → min-max normalized: 1.0, 0.5, 0.0
    const queryVec = [1, 0];
    const docVecs = [
      [1, 0],
      [0, 1],
      [-1, 0],
    ];
    vi.stubGlobal("fetch", biEncoderFetch(queryVec, docVecs));

    const result = await makeClient().rerank("q", ["a", "b", "c"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Probe (query) + docs = 2 calls (was 3 with the old wasted pairs probe)
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
      const byIdx = new Map(result.result.map((s) => [s.index, s.score]));
      expect(byIdx.get(0)).toBeCloseTo(1.0, 5); // best
      expect(byIdx.get(1)).toBeCloseTo(0.5, 5); // middle
      expect(byIdx.get(2)).toBeCloseTo(0.0, 5); // worst
      for (const s of result.result) {
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns 1.0 for all docs when all dot products are equal (no ranking info)", async () => {
    const queryVec = [1, 0];
    const docVecs = [
      [1, 0],
      [1, 0],
    ]; // identical → same dot product
    vi.stubGlobal("fetch", biEncoderFetch(queryVec, docVecs));

    const result = await makeClient().rerank("q", ["a", "b"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const s of result.result) expect(s.score).toBeCloseTo(1.0, 5);
    }
  });

  it("returns RERANK_INVALID_RESPONSE when query dim differs from doc dim", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: probe (query alone) → 4-dim, triggers bi-encoder
          return {
            ok: true,
            json: async () => ({
              data: [{ index: 0, embedding: [1, 2, 3, 4] }],
            }),
            text: async () => "",
          };
        }
        // Second call: docs → wrong dim (2 ≠ 4)
        return {
          ok: true,
          json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] }),
          text: async () => "",
        };
      }),
    );

    const result = await makeClient().rerank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RERANK_INVALID_RESPONSE");
  });
});

describe("createRerankerClient — native /v1/rerank endpoint (llama-server)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeRerankClient() {
    return createRerankerClient({
      rerankUrl: "http://llama-server:8082",
      rerankModel: "bge-reranker-v2-m3",
      separator: "\n",
      endpoint: "rerank",
      logger,
    });
  }

  it("calls reranker with { model, query, documents } and returns sigmoid scores", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { index: 0, relevance_score: 6.4 }, // high logit → sigmoid ≈ 0.998
          { index: 1, relevance_score: -2.1 }, // low logit  → sigmoid ≈ 0.109
        ],
      }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await makeRerankClient().rerank("sky color", [
      "The sky is blue",
      "Grass is green",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://llama-server:8082");
      const body = JSON.parse(opts.body as string) as {
        model: string;
        query: string;
        texts: string[];
      };
      expect(body.model).toBe("bge-reranker-v2-m3");
      expect(body.query).toBe("sky color");
      // documentsField defaults to "texts"
      expect(body.texts).toEqual(["The sky is blue", "Grass is green"]);

      const byIdx = new Map(result.result.map((s) => [s.index, s.score]));
      expect(byIdx.get(0)!).toBeGreaterThan(0.99);
      expect(byIdx.get(1)!).toBeLessThan(0.2);
      for (const s of result.result) {
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns RERANK_INVALID_RESPONSE when results array is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ nope: true }),
        text: async () => "",
      }),
    );
    const result = await makeRerankClient().rerank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RERANK_INVALID_RESPONSE");
  });

  it("returns RERANK_INVALID_RESPONSE when relevance_score is not a number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ index: 0, relevance_score: "high" }],
        }),
        text: async () => "",
      }),
    );
    const result = await makeRerankClient().rerank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RERANK_INVALID_RESPONSE");
  });

  it("returns RERANK_UNREACHABLE when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const result = await makeRerankClient().rerank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RERANK_UNREACHABLE");
  });
});

describe("createRerankerClient — error handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns RERANK_UNREACHABLE when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );
    const result = await makeClient().rerank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RERANK_UNREACHABLE");
  });

  it("returns RERANK_HTTP_ERROR on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "boom",
      }),
    );
    const result = await makeClient().rerank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RERANK_HTTP_ERROR");
  });

  it("returns RERANK_INVALID_RESPONSE when data field is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ nope: true }),
        text: async () => "",
      }),
    );
    const result = await makeClient().rerank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RERANK_INVALID_RESPONSE");
  });

  it("returns RERANK_INVALID_RESPONSE when an embedding entry is not an array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ index: 0, embedding: "nope" }] }),
        text: async () => "",
      }),
    );
    const result = await makeClient().rerank("q", ["doc"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RERANK_INVALID_RESPONSE");
  });
});
