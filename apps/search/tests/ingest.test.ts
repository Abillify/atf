// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/ingest.test.ts
import { describe, it, expect, vi } from "vitest";
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
}): PostgresClient {
  return {
    ensureCollection: vi
      .fn()
      .mockResolvedValue(
        responses.ensureCollection ?? { ok: true, result: undefined },
      ),
    upsert: vi
      .fn()
      .mockResolvedValue(
        responses.upsert ?? { ok: true, result: { id: "42" } },
      ),
    batchUpsert: vi
      .fn()
      .mockResolvedValue({ ok: true, result: { ids: ["42"] } }),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ingest handler", () => {
  it("returns HTTP 400 when X-Reference header is missing", async () => {
    const embeddingClient = createMockEmbeddingClient({
      ok: true,
      result: { vector: [0.1, 0.2, 0.3] },
    });
    const postgresClient = createMockPostgresClient({});

    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );
    const req = mockReq("Some content");
    const res = mockRes();
    await handler(req, res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it('returns HTTP 200 with { status: "ok", id: <string> } on successful ingest', async () => {
    const embeddingClient = createMockEmbeddingClient({
      ok: true,
      result: { vector: [0.1, 0.2, 0.3] },
    });
    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
      upsert: { ok: true, result: { id: "7" } },
    });

    const handler = createIngestHandler(
      embeddingClient,
      postgresClient,
      logger,
    );
    const req = mockReq(
      "# Hello World\nSome markdown content.",
      {},
      { "x-reference": "doc-1" },
    );
    const res = mockRes();
    await handler(req, res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", id: "7" });
  });

  it("returns HTTP 400 when body is empty string", async () => {
    const handler = createIngestHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [] } }),
      createMockPostgresClient({}),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("", {}, { "x-reference": "doc-1" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 400 when body is whitespace-only", async () => {
    const handler = createIngestHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [] } }),
      createMockPostgresClient({}),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("   ", {}, { "x-reference": "doc-1" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 502 when embedding client returns an error", async () => {
    const handler = createIngestHandler(
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
    await handler(
      mockReq("Some valid content", {}, { "x-reference": "doc-1" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 502 when ensureCollection fails", async () => {
    const handler = createIngestHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({
        ensureCollection: {
          ok: false,
          error: { code: "POSTGRES_SQL_ERROR", message: "DB error" },
        },
      }),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("Some valid content", {}, { "x-reference": "doc-1" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 400 when collection name is invalid", async () => {
    const handler = createIngestHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({
        ensureCollection: {
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
      mockReq(
        "Some valid content",
        {},
        { "x-reference": "doc-1", "x-collection": "bad name" },
      ) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns HTTP 502 when upsert fails", async () => {
    const handler = createIngestHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      createMockPostgresClient({
        ensureCollection: { ok: true, result: undefined },
        upsert: {
          ok: false,
          error: { code: "POSTGRES_SQL_ERROR", message: "DB error" },
        },
      }),
      logger,
    );
    const res = mockRes();
    await handler(
      mockReq("Some valid content", {}, { "x-reference": "doc-1" }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("returns the same id for repeated calls with the same reference (upsert semantics)", async () => {
    const postgresClient = createMockPostgresClient({
      ensureCollection: { ok: true, result: undefined },
      upsert: { ok: true, result: { id: "99" } },
    });
    const handler = createIngestHandler(
      createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
      postgresClient,
      logger,
    );

    const res1 = mockRes();
    await handler(
      mockReq("Content v1", {}, { "x-reference": "doc-123" }) as never,
      res1 as never,
      vi.fn(),
    );
    const res2 = mockRes();
    await handler(
      mockReq("Content v2", {}, { "x-reference": "doc-123" }) as never,
      res2 as never,
      vi.fn(),
    );

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    // Both calls return the id from the upsert result.
    expect((res1.body as { id: string }).id).toBe("99");
    expect((res2.body as { id: string }).id).toBe("99");
  });

  // ── Chunking header validation ─────────────────────────────────────────────

  describe("chunking header validation", () => {
    it("continues without chunking when both headers are missing", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq("Some content", {}, { "x-reference": "doc-1" }) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(200);
    });

    it("returns HTTP 400 when only X-Chunk-Size is present", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          { "x-reference": "doc-1", "x-chunk-size": "100" },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "Both X-Chunk-Size and X-Chunk-Overlap headers are required",
      );
    });

    it("returns HTTP 400 when only X-Chunk-Overlap is present", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          { "x-reference": "doc-1", "x-chunk-overlap": "20" },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "Both X-Chunk-Size and X-Chunk-Overlap headers are required",
      );
    });

    it("returns HTTP 400 when X-Chunk-Size is not a positive integer (string)", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          {
            "x-reference": "doc-1",
            "x-chunk-size": "abc",
            "x-chunk-overlap": "20",
          },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "X-Chunk-Size must be a positive integer",
      );
    });

    it("returns HTTP 400 when X-Chunk-Size is zero", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          {
            "x-reference": "doc-1",
            "x-chunk-size": "0",
            "x-chunk-overlap": "0",
          },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "X-Chunk-Size must be a positive integer",
      );
    });

    it("returns HTTP 400 when X-Chunk-Size is negative", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          {
            "x-reference": "doc-1",
            "x-chunk-size": "-5",
            "x-chunk-overlap": "0",
          },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "X-Chunk-Size must be a positive integer",
      );
    });

    it("returns HTTP 400 when X-Chunk-Size is a float", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          {
            "x-reference": "doc-1",
            "x-chunk-size": "10.5",
            "x-chunk-overlap": "2",
          },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "X-Chunk-Size must be a positive integer",
      );
    });

    it("returns HTTP 400 when X-Chunk-Overlap is negative", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          {
            "x-reference": "doc-1",
            "x-chunk-size": "100",
            "x-chunk-overlap": "-1",
          },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "X-Chunk-Overlap must be a non-negative integer",
      );
    });

    it("returns HTTP 400 when X-Chunk-Overlap is a float", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          {
            "x-reference": "doc-1",
            "x-chunk-size": "100",
            "x-chunk-overlap": "5.5",
          },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "X-Chunk-Overlap must be a non-negative integer",
      );
    });

    it("returns HTTP 400 when X-Chunk-Overlap equals X-Chunk-Size", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          {
            "x-reference": "doc-1",
            "x-chunk-size": "100",
            "x-chunk-overlap": "100",
          },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as { error: string }).error).toBe(
        "X-Chunk-Overlap must be less than X-Chunk-Size",
      );
    });

    it("accepts valid chunking headers (overlap < size)", async () => {
      const handler = createIngestHandler(
        createMockEmbeddingClient({ ok: true, result: { vector: [0.1] } }),
        createMockPostgresClient({}),
        logger,
      );
      const res = mockRes();
      await handler(
        mockReq(
          "Some content",
          {},
          {
            "x-reference": "doc-1",
            "x-chunk-size": "100",
            "x-chunk-overlap": "20",
          },
        ) as never,
        res as never,
        vi.fn(),
      );
      expect(res.statusCode).toBe(200);
    });
  });
});
