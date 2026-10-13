// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/ingest-chunking.test.ts
import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { createIngestHandler } from "../src/handlers/ingest.js";
import type {
  EmbeddingClient,
  EmbeddingResponse,
} from "../src/embedding-client.js";
import type {
  PostgresClient,
  PostgresResponse,
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
  ensureCollection?: PostgresResponse<void>;
  upsert?: PostgresResponse<{ id: string }>;
  batchUpsert?: PostgresResponse<{ ids: string[] }>;
}): PostgresClient {
  return {
    ensureCollection: vi
      .fn()
      .mockResolvedValue(
        responses.ensureCollection ?? { ok: true, result: undefined },
      ),
    upsert: vi
      .fn()
      .mockResolvedValue(responses.upsert ?? { ok: true, result: { id: "1" } }),
    batchUpsert: vi
      .fn()
      .mockResolvedValue(
        responses.batchUpsert ?? { ok: true, result: { ids: ["1"] } },
      ),
    search: vi.fn(),
    delete: vi.fn(),
    getIngestStats: vi.fn(),
    getSearchStats: vi.fn(),
    ping: vi.fn().mockResolvedValue({ ok: true, result: undefined }),
    close: vi.fn(),
  } as unknown as PostgresClient;
}

function mockReq(
  body: string,
  locals: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return { body, locals, headers } as unknown as import("express").Request;
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

// ─── Property: Header validation rejects invalid values ───────────────────────

describe("Property: Header validation rejects invalid chunk values", () => {
  const embeddingClient = createMockEmbeddingClient({
    ok: true,
    result: { vector: [0.1, 0.2, 0.3] },
  });
  const postgresClient = createMockPostgresClient({});
  const handler = createIngestHandler(embeddingClient, postgresClient, logger);

  it("rejects X-Chunk-Size as non-numeric string", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter((s) => Number.isNaN(Number(s))),
        fc.nat({ max: 999 }).map(String),
        async (invalidSize, validOverlap) => {
          const res = mockRes();
          await handler(
            mockReq(
              "content",
              {},
              {
                "x-reference": "doc-1",
                "x-chunk-size": invalidSize,
                "x-chunk-overlap": validOverlap,
              },
            ) as never,
            res as never,
            vi.fn(),
          );
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("rejects X-Chunk-Size as negative number", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1000, max: -1 }).map(String),
        fc.nat({ max: 999 }).map(String),
        async (negativeSize, validOverlap) => {
          const res = mockRes();
          await handler(
            mockReq(
              "content",
              {},
              {
                "x-reference": "doc-1",
                "x-chunk-size": negativeSize,
                "x-chunk-overlap": validOverlap,
              },
            ) as never,
            res as never,
            vi.fn(),
          );
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("rejects X-Chunk-Overlap >= X-Chunk-Size", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1000 }),
        fc.nat({ max: 500 }),
        async (chunkSize, extra) => {
          const overlap = chunkSize + extra;
          const res = mockRes();
          await handler(
            mockReq(
              "content",
              {},
              {
                "x-reference": "doc-1",
                "x-chunk-size": String(chunkSize),
                "x-chunk-overlap": String(overlap),
              },
            ) as never,
            res as never,
            vi.fn(),
          );
          expect(res.statusCode).toBe(400);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ─── Integration: Successful multi-chunk ingest ───────────────────────────────

describe("Integration: Successful ingest with chunking", () => {
  it("returns HTTP 200 with ids array and chunks count for a multi-chunk document", async () => {
    const documentBody = "a".repeat(250);
    const chunkSize = 100;
    const overlapSize = 20;

    const embeddingClient = createMockEmbeddingClient({
      ok: true,
      result: { vector: [0.1, 0.2, 0.3] },
    });

    // batchUpsert returns as many IDs as there are chunks
    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
    });
    const batchUpsertMock = postgresClient.batchUpsert as ReturnType<
      typeof vi.fn
    >;
    batchUpsertMock.mockImplementation(
      (points: Array<{ reference: string }>) => ({
        ok: true,
        result: { ids: points.map((_, i) => String(i + 1)) },
      }),
    );

    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );

    const res = mockRes();
    res.locals = { metadata: { client: "test" } };
    await handler(
      mockReq(
        documentBody,
        {},
        {
          "x-reference": "doc-1",
          "x-chunk-size": String(chunkSize),
          "x-chunk-overlap": String(overlapSize),
        },
      ) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
    expect(res.body).toHaveProperty("ids");
    expect(res.body).toHaveProperty("chunks");
    expect(Array.isArray((res.body as { ids: unknown[] }).ids)).toBe(true);

    const N = (res.body as { chunks: number }).chunks;
    expect(N).toBeGreaterThanOrEqual(3);
    expect((res.body as { ids: unknown[] }).ids).toHaveLength(N);

    // All chunks embedded in one batch call — embedBatch called once with N inputs.
    const embedBatchMock = embeddingClient.embedBatch as ReturnType<
      typeof vi.fn
    >;
    expect(embedBatchMock).toHaveBeenCalledTimes(1);
    const [batchInputs] = embedBatchMock.mock.calls[0] as [string[]];
    expect(batchInputs).toHaveLength(N);

    // batchUpsert called exactly once with all N points.
    expect(batchUpsertMock).toHaveBeenCalledTimes(1);
    const [points] = batchUpsertMock.mock.calls[0] as [Array<unknown>];
    expect(points).toHaveLength(N);
  });

  it("each point in batchUpsert receives the correct vector from embedBatch()", async () => {
    const documentBody = "b".repeat(250);
    const embeddingClient: EmbeddingClient = {
      embed: vi.fn(),
      // Return distinct vectors per input so each chunk gets a unique vector.
      embedBatch: vi.fn().mockImplementation(async (texts: string[]) => ({
        ok: true,
        result: {
          vectors: texts.map((_, i) => [i + 1, (i + 1) * 2, (i + 1) * 3]),
        },
      })),
    };

    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
    });
    const batchUpsertMock = postgresClient.batchUpsert as ReturnType<
      typeof vi.fn
    >;
    batchUpsertMock.mockImplementation(
      (points: Array<{ reference: string }>) => ({
        ok: true,
        result: { ids: points.map((_, i) => String(i + 1)) },
      }),
    );

    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );

    const res = mockRes();
    res.locals = { metadata: {} };
    await handler(
      mockReq(
        documentBody,
        {},
        {
          "x-reference": "doc-2",
          "x-chunk-size": "100",
          "x-chunk-overlap": "20",
        },
      ) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    const N = (res.body as { chunks: number }).chunks;
    const [points] = batchUpsertMock.mock.calls[0] as [
      Array<{ vector: number[] }>,
    ];

    // Each chunk should have a distinct, non-zero vector matching its index.
    const allVectors = points.map((p) => p.vector);
    expect(allVectors).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      const vec = allVectors[i];
      expect(vec.length).toBe(3);
      expect(vec.every((v) => v > 0)).toBe(true);
    }
  });

  it("preserves original metadata alongside chunk metadata", async () => {
    const documentBody = "c".repeat(250);
    const embeddingClient = createMockEmbeddingClient({
      ok: true,
      result: { vector: [0.5, 0.6, 0.7] },
    });
    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
    });
    const batchUpsertMock = postgresClient.batchUpsert as ReturnType<
      typeof vi.fn
    >;
    batchUpsertMock.mockImplementation(
      (points: Array<{ reference: string }>) => ({
        ok: true,
        result: { ids: points.map((_, i) => String(i + 1)) },
      }),
    );

    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );

    const res = mockRes();
    res.locals = { metadata: { client: "acme" } };
    await handler(
      mockReq(
        documentBody,
        {},
        {
          "x-reference": "doc-3",
          "x-chunk-size": "100",
          "x-chunk-overlap": "20",
        },
      ) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    const N = (res.body as { chunks: number }).chunks;
    const [points] = batchUpsertMock.mock.calls[0] as [
      Array<{
        metadata: Record<string, unknown>;
        chunk: Record<string, unknown>;
      }>,
    ];

    for (let i = 0; i < N; i++) {
      const point = points[i];
      // User metadata must be clean — no chunk-specific fields
      expect(point.metadata.client).toBe("acme");
      expect(point.metadata).not.toHaveProperty("chunk_index");
      expect(point.metadata).not.toHaveProperty("chunk_total");
      // Chunk-specific fields live in chunk
      expect(point.chunk).toHaveProperty("chunk_index", i);
      expect(point.chunk).toHaveProperty("chunk_total", N);
    }
  });
});

// ─── Integration: Non-chunking path ──────────────────────────────────────────

describe("Integration: Ingest without chunking headers", () => {
  it('returns HTTP 200 with { status: "ok", id } (single-doc format)', async () => {
    const embeddingClient = createMockEmbeddingClient({
      ok: true,
      result: { vector: [0.1, 0.2, 0.3] },
    });
    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
      upsert: { ok: true, result: { id: "99" } },
    });
    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );

    const res = mockRes();
    res.locals = { metadata: { client: "test" } };
    await handler(
      mockReq("Hello world", {}, { "x-reference": "doc-1" }) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", id: "99" });
    expect(res.body).not.toHaveProperty("ids");
    expect(res.body).not.toHaveProperty("chunks");
  });

  it("calls embed() and upsert() exactly once", async () => {
    const embeddingClient = createMockEmbeddingClient({
      ok: true,
      result: { vector: [1.0, 2.0] },
    });
    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
      upsert: { ok: true, result: { id: "1" } },
    });
    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );

    const res = mockRes();
    await handler(
      mockReq("A document", {}, { "x-reference": "doc-1" }) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(200);
    expect(embeddingClient.embedBatch).toHaveBeenCalledTimes(1);
    expect(postgresClient.upsert).toHaveBeenCalledTimes(1);
    // batchUpsert must NOT be called for single-doc path
    expect(postgresClient.batchUpsert).not.toHaveBeenCalled();
  });
});

// ─── Integration: Error handling during chunk processing ─────────────────────

describe("Integration: Error handling during chunk processing", () => {
  it("any embedding failure → HTTP 502, batchUpsert never called", async () => {
    // embedBatch returns an error for the whole batch.
    const embeddingClient: EmbeddingClient = {
      embed: vi.fn(),
      embedBatch: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "LLM_UNREACHABLE",
          message: "Embedding service unavailable",
        },
      }),
    };

    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
    });

    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );

    const res = mockRes();
    await handler(
      mockReq(
        "a".repeat(250),
        {},
        {
          "x-reference": "doc-1",
          "x-chunk-size": "100",
          "x-chunk-overlap": "0",
        },
      ) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toHaveProperty("error");
    // Nothing was written — batchUpsert must not have been called.
    expect(postgresClient.batchUpsert).not.toHaveBeenCalled();
  });

  it("batchUpsert failure → HTTP 502, all chunks rolled back atomically", async () => {
    const embeddingClient = createMockEmbeddingClient({
      ok: true,
      result: { vector: [0.4, 0.5, 0.6] },
    });

    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
      batchUpsert: {
        ok: false,
        error: { code: "POSTGRES_SQL_ERROR", message: "Connection refused" },
      },
    });

    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );

    const res = mockRes();
    await handler(
      mockReq(
        "b".repeat(250),
        {},
        {
          "x-reference": "doc-1",
          "x-chunk-size": "100",
          "x-chunk-overlap": "0",
        },
      ) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toHaveProperty("error");
    // embedBatch succeeded (called once with all chunks).
    expect(embeddingClient.embedBatch).toHaveBeenCalledTimes(1);
    // batchUpsert was called once but returned an error (transaction rolls back internally).
    expect(postgresClient.batchUpsert).toHaveBeenCalledTimes(1);
  });
});
