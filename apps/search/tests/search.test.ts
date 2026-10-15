// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/search.test.ts
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import {
  createSearchHandler,
  parseRerankFlag,
  parseHybridFlag,
} from "../src/handlers/search.js";
import type {
  EmbeddingClient,
  EmbeddingResponse,
} from "../src/embedding-client.js";
import type { RerankerClient, RerankResponse } from "../src/reranker-client.js";
import type {
  PostgresClient,
  PostgresResponse,
  SearchResult,
} from "../src/postgres-client.js";
import pino from "pino";

// ─── Mock factories ───────────────────────────────────────────────────────────

function createMockEmbeddingClient(
  response: EmbeddingResponse,
): EmbeddingClient {
  const baseVector = response.ok ? response.result.vector : [];
  return {
    embed: vi.fn().mockResolvedValue(response),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) => {
      if (!response.ok) return response;
      return { ok: true, result: { vectors: texts.map(() => baseVector) } };
    }),
  };
}

function createMockPostgresClient(responses: {
  search?: PostgresResponse<SearchResult[]>;
}): PostgresClient {
  return {
    ensureCollection: vi.fn(),
    upsert: vi.fn(),
    batchUpsert: vi.fn(),
    search: vi
      .fn()
      .mockResolvedValue(responses.search ?? { ok: true, result: [] }),
    delete: vi.fn(),
    getIngestStats: vi.fn(),
    getSearchStats: vi.fn(),
    listCollections: vi.fn(),
    deleteCollection: vi.fn(),
    ping: vi.fn().mockResolvedValue({ ok: true, result: undefined }),
    close: vi.fn(),
    getStatsCounters: vi
      .fn()
      .mockReturnValue({ ingestTotal: 0, searchTotal: 0, flushErrors: 0 }),
    recordSearchStat: vi.fn(),
    expandUnit: vi.fn().mockResolvedValue({ ok: true, result: [] }),
  } as unknown as PostgresClient;
}

function createMockRerankerClient(response: RerankResponse): RerankerClient {
  return { rerank: vi.fn().mockResolvedValue(response) };
}

function mockReq(
  body: string,
  headers: Record<string, string> = {},
  locals: Record<string, unknown> = {},
) {
  return {
    body,
    headers,
    locals,
    principal: { userId: undefined, userGroups: undefined, source: "service" },
  } as unknown as import("express").Request;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    locals: {} as Record<string, unknown>,
  };
  const r = res as typeof res & {
    status: (code: number) => typeof r;
    json: (data: unknown) => typeof r;
  };
  r.status = (code: number) => {
    r.statusCode = code;
    return r;
  };
  r.json = (data: unknown) => {
    r.body = data;
    return r;
  };
  return r;
}

const logger = pino({ level: "silent" });

// ─── Basic search tests ───────────────────────────────────────────────────────

describe("search handler", () => {
  it("never logs the raw query or the acting identity", async () => {
    const lines: string[] = [];
    const capture = pino(
      { level: "trace" },
      { write: (line: string) => void lines.push(line) },
    );
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1, 0.2] } }),
      createMockPostgresClient({ search: { ok: true, result: [] } }),
      capture,
    );
    const req = mockReq("Kündigung Max Mustermann");
    (req as unknown as { principal: unknown }).principal = {
      userId: "max@example.test",
      userGroups: ["hr-confidential"],
      source: "jwt",
    };
    await handler(req as never, mockRes() as never, vi.fn());

    const logged = lines.join("\n");
    expect(logged).toContain("Incoming search query");
    expect(logged).not.toContain("Mustermann");
    expect(logged).not.toContain("max@example.test");
    expect(logged).not.toContain("hr-confidential");
  });

  it("returns HTTP 200 with { results: [...] } on successful search", async () => {
    const mockResults: SearchResult[] = [
      {
        id: "1",
        score: 0.95,
        content: "# Doc\nContent",
        metadata: { client: "acme" },
        reference: "doc-1",
        created: new Date(),
        modified: new Date(),
      },
    ];
    const handler = createSearchHandler(
      createMockEmbeddingClient({
        ok: true,
        result: { vector: [0.1, 0.2, 0.3] },
      }),
      createMockPostgresClient({ search: { ok: true, result: mockResults } }),
      logger,
    );
    const res = mockRes();
    await handler(mockReq("search query") as never, res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ results: mockResults });
  });

  it("returns HTTP 400 when body is empty string", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({}),
      logger,
    );
    const res = mockRes();
    await handler(mockReq("") as never, res as never, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 400 when body is whitespace-only", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({}),
      logger,
    );
    const res = mockRes();
    await handler(mockReq("   ") as never, res as never, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 400 for an offset-less X-Valid-At", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({}),
      logger,
    );
    const res = mockRes();
    await handler(mockReq("search query", { "x-valid-at": "2026-03-01T12:00:00" }) as never, res as never, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("explicit timezone") });
  });

  it("canonicalizes and forwards X-Valid-At independently of include-all", async () => {
    const postgresClient = createMockPostgresClient({ search: { ok: true, result: [] } });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(mockReq("search query", { "x-valid-at": "2026-03-01T12:00:00+01:00", "x-include-all-versions": "true" }) as never, res as never, vi.fn());
    expect(res.statusCode).toBe(200);
    const args = (postgresClient.search as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(args[7]).toBe(true);
    expect(args[19]).toBe("2026-03-01T11:00:00.000Z");
  });

  it("uses default limit of 10 when X-Max-Results header is absent", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [] },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(mockReq("search query") as never, res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    const [, , limit] = (postgresClient.search as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(limit).toBe(10);
  });

  it("uses provided limit when X-Max-Results is 50", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [] },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("search query", { "x-max-results": "50" }) as never,
      res as never,
      vi.fn(),
    );

    const [, , limit] = (postgresClient.search as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(limit).toBe(50);
  });

  it("clamps X-Max-Results to 100 when value exceeds maximum", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [] },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("search query", { "x-max-results": "200" }) as never,
      res as never,
      vi.fn(),
    );

    const [, , limit] = (postgresClient.search as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(limit).toBe(100);
  });

  it("returns HTTP 400 when X-Max-Results is non-numeric", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({}),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("search query", { "x-max-results": "abc" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 400 when X-Max-Results is negative", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({}),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("search query", { "x-max-results": "-5" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns HTTP 200 with empty results when collection does not exist", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({ search: { ok: true, result: [] } }),
      logger,
    );
    const res = mockRes();
    await handler(mockReq("search query") as never, res as never, vi.fn());
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ results: [] });
  });

  it("returns HTTP 502 when embedding fails", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({
        ok: false,
        error: {
          code: "LLM_UNREACHABLE",
          message: "LLM server is not reachable",
        },
      }),
      createMockPostgresClient({}),
      logger,
    );
    const res = mockRes();
    await handler(mockReq("search query") as never, res as never, vi.fn());
    expect(res.statusCode).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 400 when collection name is invalid", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({
        search: {
          ok: false,
          error: {
            code: "INVALID_COLLECTION_NAME",
            message: "Invalid collection name",
          },
        },
      }),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("search query", { "x-collection": "bad name" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});

// ─── Reranking tests ──────────────────────────────────────────────────────────

describe("search handler reranking", () => {
  function threeResults(): SearchResult[] {
    return [
      {
        id: "a",
        score: 0.9,
        content: "doc A",
        metadata: {},
        reference: "a",
        created: new Date(),
        modified: new Date(),
      },
      {
        id: "b",
        score: 0.8,
        content: "doc B",
        metadata: {},
        reference: "b",
        created: new Date(),
        modified: new Date(),
      },
      {
        id: "c",
        score: 0.7,
        content: "doc C",
        metadata: {},
        reference: "c",
        created: new Date(),
        modified: new Date(),
      },
    ];
  }

  it("parseRerankFlag handles truthy, falsy, async, and invalid values", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      expect(parseRerankFlag(v)).toBe(true);
    }
    for (const v of [undefined, "", "0", "false", "no", "off"]) {
      expect(parseRerankFlag(v)).toBe(false);
    }
    expect(parseRerankFlag("async")).toBe("async");
    expect(parseRerankFlag("ASYNC")).toBe("async");
    for (const v of ["maybe", "2", "xyz"]) {
      expect(parseRerankFlag(v)).toBeNull();
    }
  });

  it("returns HTTP 400 for an invalid X-Rerank value", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({ search: { ok: true, result: [] } }),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-rerank": "maybe" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("does not rerank or over-fetch when X-Rerank is absent", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: threeResults() },
    });
    const reranker = createMockRerankerClient({ ok: true, result: [] });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
      { rerankerClient: reranker, candidateMultiplier: 4 },
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-max-results": "3" }) as never,
      res as never,
      vi.fn(),
    );

    expect(reranker.rerank).not.toHaveBeenCalled();
    const [, , limit] = (postgresClient.search as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(limit).toBe(3);
  });

  it("over-fetches limit × multiplier (capped at 100) when reranking", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: threeResults() },
    });
    const reranker = createMockRerankerClient({
      ok: true,
      result: [
        { index: 0, score: 0.1 },
        { index: 1, score: 0.2 },
        { index: 2, score: 0.3 },
      ],
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
      { rerankerClient: reranker, candidateMultiplier: 5 },
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-max-results": "10", "x-rerank": "1" }) as never,
      res as never,
      vi.fn(),
    );

    const [, , limit] = (postgresClient.search as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(limit).toBe(50); // 10 × 5
  });

  it("reorders results by reranker score and trims to the requested limit", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: threeResults() },
    });
    const reranker = createMockRerankerClient({
      ok: true,
      result: [
        { index: 0, score: 0.1 }, // doc A
        { index: 1, score: 0.5 }, // doc B
        { index: 2, score: 0.99 }, // doc C
      ],
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
      { rerankerClient: reranker, candidateMultiplier: 4 },
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-max-results": "2", "x-rerank": "true" }) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(reranker.rerank).toHaveBeenCalledOnce();
    const out = (res.body as { results: SearchResult[] }).results;
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("c");
    expect(out[0].score).toBeCloseTo(0.99);
    expect(out[0].vector_score).toBeCloseTo(0.7);
    expect(out[1].id).toBe("b");
  });

  it("falls back to vector-search order when the reranker fails", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: threeResults() },
    });
    const reranker = createMockRerankerClient({
      ok: false,
      error: { code: "RERANK_UNREACHABLE", message: "down" },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
      { rerankerClient: reranker, candidateMultiplier: 4 },
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-max-results": "3", "x-rerank": "1" }) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    const out = (res.body as { results: SearchResult[] }).results;
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores X-Rerank when no reranker is configured", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: threeResults() },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-max-results": "3", "x-rerank": "1" }) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    const [, , limit] = (postgresClient.search as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(limit).toBe(3); // no over-fetch
    const out = (res.body as { results: SearchResult[] }).results;
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("X-Rerank: async sends SSE stream with results then rerank events", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: threeResults() },
    });
    const reranker = createMockRerankerClient({
      ok: true,
      result: [
        { index: 0, score: 0.1 },
        { index: 1, score: 0.5 },
        { index: 2, score: 0.99 },
      ],
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
      { rerankerClient: reranker, candidateMultiplier: 4 },
    );

    const written: string[] = [];
    const sseRes = {
      statusCode: 200,
      body: null as unknown,
      headers: {} as Record<string, string>,
      ended: false,
      locals: {} as Record<string, unknown>,
      setHeader: (k: string, v: string) => {
        (sseRes.headers as Record<string, string>)[k] = v;
      },
      status: (code: number) => {
        sseRes.statusCode = code;
        return sseRes;
      },
      json: (data: unknown) => {
        sseRes.body = data;
        return sseRes;
      },
      write: (chunk: string) => {
        written.push(chunk);
      },
      end: () => {
        sseRes.ended = true;
      },
    };

    await handler(
      mockReq("q", { "x-max-results": "2", "x-rerank": "async" }) as never,
      sseRes as never,
      vi.fn(),
    );

    expect(sseRes.headers["Content-Type"]).toBe("text/event-stream");
    expect(sseRes.ended).toBe(true);

    const allText = written.join("");
    expect(allText).toContain("event: results");
    expect(allText).toContain("event: rerank");
    expect(allText).toContain("event: done");

    const resultsMatch = allText.match(/event: results\ndata: ({.*?})\n/);
    expect(resultsMatch).not.toBeNull();
    const resultsPayload = JSON.parse(resultsMatch[1]) as {
      results: SearchResult[];
    };
    expect(resultsPayload.results).toHaveLength(2);
    expect(resultsPayload.results[0].id).toBe("a"); // vector order

    const rerankMatch = allText.match(/event: rerank\ndata: ({.*?})\n/);
    expect(rerankMatch).not.toBeNull();
    const rerankPayload = JSON.parse(rerankMatch[1]) as {
      scores: Array<{ score: number }>;
    };
    expect(rerankPayload.scores[0].score).toBeCloseTo(0.99);
  });
});

// ─── MIN_RERANK_SCORE / abstention tests (task 6.10, Requirement 4.8) ────────

describe("search handler MIN_RERANK_SCORE abstention", () => {
  function threeResults(): SearchResult[] {
    return [
      {
        id: "a",
        score: 0.9,
        content: "doc A",
        metadata: {},
        reference: "a",
        created: new Date(),
        modified: new Date(),
      },
      {
        id: "b",
        score: 0.8,
        content: "doc B",
        metadata: {},
        reference: "b",
        created: new Date(),
        modified: new Date(),
      },
      {
        id: "c",
        score: 0.7,
        content: "doc C",
        metadata: {},
        reference: "c",
        created: new Date(),
        modified: new Date(),
      },
    ];
  }

  function handlerWith(minRerankScore?: number | null) {
    return createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({ search: { ok: true, result: threeResults() } }),
      logger,
      minRerankScore === undefined ? {} : { minRerankScore },
    );
  }

  it("filters below-threshold hits and reports the abstention signal", async () => {
    const handler = handlerWith(0.75);
    const res = mockRes();
    await handler(mockReq("q") as never, res as never, vi.fn());
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      results: SearchResult[];
      abstention?: Record<string, unknown>;
    };
    expect(body.results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(body.abstention).toEqual({
      threshold: 0.75,
      score_kind: "retrieval",
      candidates: 3,
      kept: 2,
      abstain: false,
    });
  });

  it("abstains with an empty result list when all hits fall below", async () => {
    const handler = handlerWith(0.95);
    const res = mockRes();
    await handler(mockReq("q") as never, res as never, vi.fn());
    const body = res.body as {
      results: SearchResult[];
      abstention?: { abstain: boolean; kept: number };
    };
    expect(body.results).toEqual([]);
    expect(body.abstention?.abstain).toBe(true);
    expect(body.abstention?.kept).toBe(0);
  });

  it("emits no abstention field when the threshold is unset", async () => {
    for (const options of [undefined, null] as const) {
      const handler = handlerWith(options);
      const res = mockRes();
      await handler(mockReq("q") as never, res as never, vi.fn());
      const body = res.body as Record<string, unknown>;
      expect((body["results"] as SearchResult[]).map((r) => r.id)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(body).not.toHaveProperty("abstention");
    }
  });
});

// ─── Hybrid flag tests ────────────────────────────────────────────────────────

describe("search handler hybrid flag", () => {
  it("parseHybridFlag handles truthy, falsy, absent, and invalid values", () => {
    for (const v of ["1", "true", "YES", "on"]) {
      expect(parseHybridFlag(v)).toBe(true);
    }
    for (const v of ["0", "false", "no", "off"]) {
      expect(parseHybridFlag(v)).toBe(false);
    }
    for (const v of [undefined, ""]) {
      expect(parseHybridFlag(v)).toBeUndefined();
    }
    for (const v of ["maybe", "2", "xyz"]) {
      expect(parseHybridFlag(v)).toBeNull();
    }
  });

  it("returns HTTP 400 for an invalid X-Hybrid value", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({ search: { ok: true, result: [] } }),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-hybrid": "maybe" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("passes hybridSearch=true to postgres when X-Hybrid is on", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [] },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-hybrid": "1" }) as never,
      res as never,
      vi.fn(),
    );

    const [, , , , , , hybrid] = (
      postgresClient.search as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(hybrid).toBe(true);
  });

  it("passes hybridSearch=false to postgres when X-Hybrid is off", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [] },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
      { hybridSearch: true }, // server default is on
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-hybrid": "off" }) as never,
      res as never,
      vi.fn(),
    );

    const [, , , , , , hybrid] = (
      postgresClient.search as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(hybrid).toBe(false);
  });

  it("uses server hybrid default when no X-Hybrid header is sent", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [] },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
      { hybridSearch: true },
    );
    const res = mockRes();
    await handler(mockReq("q") as never, res as never, vi.fn());

    const [, , , , , , hybrid] = (
      postgresClient.search as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(hybrid).toBe(true);
  });
});

// ─── Property-based: X-Max-Results clamping ───────────────────────────────────

describe("Property: X-Max-Results clamping", () => {
  it("clamps X-Max-Results to min(value, 100) for any positive integer", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1 }), async (value) => {
        const postgresClient = createMockPostgresClient({
          search: { ok: true, result: [] },
        });
        const handler = createSearchHandler(
          createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
          postgresClient,
          logger,
        );
        const res = mockRes();
        await handler(
          mockReq("search query", { "x-max-results": String(value) }) as never,
          res as never,
          vi.fn(),
        );

        const expectedLimit = Math.min(value, 100);
        const [, , actualLimit] = (
          postgresClient.search as ReturnType<typeof vi.fn>
        ).mock.calls[0];
        return actualLimit === expectedLimit;
      }),
      { numRuns: 100 },
    );
  });

  it("uses default limit of 10 when X-Max-Results header is absent", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [] },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(mockReq("search query") as never, res as never, vi.fn());

    const [, , actualLimit] = (
      postgresClient.search as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(actualLimit).toBe(10);
  });
});

// ─── Small-to-big expansion wiring (task 3.6, Requirement 13.4) ────────────────

describe("search handler — X-Expand / X-Budget-Chars", () => {
  const hitResult: SearchResult = {
    id: "1",
    score: 0.9,
    content: "the hit chunk",
    metadata: {
      unit_id: "u-hit",
      section_id: "sec-1",
      prev_unit_id: "u-prev",
      next_unit_id: "u-next",
      page_start: 3,
      page_end: 3,
    },
    reference: "doc-1_chunk_1",
    base_ref: "doc-1",
    created: new Date(),
    modified: new Date(),
  } as unknown as SearchResult;

  it("returns HTTP 400 for an invalid X-Expand value", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({ search: { ok: true, result: [hitResult] } }),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-expand": "chapter" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("X-Expand") });
  });

  it("returns HTTP 400 for a malformed X-Budget-Chars value", async () => {
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({ search: { ok: true, result: [hitResult] } }),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-expand": "section", "x-budget-chars": "-5" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("X-Budget-Chars"),
    });
  });

  it("does not call expandUnit and attaches no `expanded` when X-Expand is absent (v1 unchanged)", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [hitResult] },
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(mockReq("q") as never, res as never, vi.fn());
    expect(res.statusCode).toBe(200);
    expect((postgresClient.expandUnit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    const body = res.body as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).not.toHaveProperty("expanded");
  });

  it("attaches an `expanded` field with truncated flag when X-Expand=section", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [hitResult] },
    });
    // Section returns the hit plus two siblings; the hit is deduped.
    (postgresClient.expandUnit as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: [
        { unit_id: "u-a", content: "para A", page_start: 3, page_end: 3 },
        { unit_id: "u-hit", content: "the hit chunk", page_start: 3, page_end: 3 },
        { unit_id: "u-b", content: "para B", page_start: 3, page_end: 3 },
      ],
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-expand": "section", "x-budget-chars": "1000" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(200);

    const expandCall = (postgresClient.expandUnit as ReturnType<typeof vi.fn>).mock
      .calls[0];
    // (collection, scope, mode, coords, options)
    expect(expandCall[2]).toBe("section");
    expect(expandCall[3]).toMatchObject({
      baseRef: "doc-1",
      unitId: "u-hit",
      sectionId: "sec-1",
    });

    const body = res.body as {
      results: Array<{ expanded?: { content: string; truncated: boolean; mode: string } }>;
    };
    const expanded = body.results[0].expanded;
    expect(expanded).toBeDefined();
    expect(expanded?.mode).toBe("section");
    expect(expanded?.content).toBe("para A\n\npara B");
    expect(expanded?.truncated).toBe(false);
  });

  it("reports truncated=true when the budget drops units", async () => {
    const postgresClient = createMockPostgresClient({
      search: { ok: true, result: [hitResult] },
    });
    (postgresClient.expandUnit as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      result: [
        { unit_id: "u-a", content: "AAAA", page_start: 3, page_end: 3 },
        { unit_id: "u-b", content: "BBBB", page_start: 3, page_end: 3 },
      ],
    });
    const handler = createSearchHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("q", { "x-expand": "neighbors", "x-budget-chars": "4" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      results: Array<{ expanded?: { content: string; truncated: boolean } }>;
    };
    const expanded = body.results[0].expanded;
    expect(expanded?.content).toBe("AAAA");
    expect(expanded?.truncated).toBe(true);
  });
});
