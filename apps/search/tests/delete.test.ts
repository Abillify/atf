// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/delete.test.ts
import { describe, it, expect, vi } from "vitest";
import { createDeleteHandler } from "../src/handlers/delete.js";
import type {
  PostgresClient,
  PostgresResponse,
} from "../src/postgres-client.js";
import pino from "pino";

// ─── Mock factories ───────────────────────────────────────────────────────────

function createMockPostgresClient(responses: {
  delete?: PostgresResponse<{ deleted: number }>;
}): PostgresClient {
  return {
    ensureCollection: vi.fn(),
    upsert: vi.fn(),
    batchUpsert: vi.fn(),
    search: vi.fn(),
    delete: vi
      .fn()
      .mockResolvedValue(
        responses.delete ?? { ok: true, result: { deleted: 0 } },
      ),
    getIngestStats: vi.fn(),
    getSearchStats: vi.fn(),
    ping: vi.fn().mockResolvedValue({ ok: true, result: undefined }),
    close: vi.fn(),
  } as unknown as PostgresClient;
}

function mockReq(headers: Record<string, string> = {}) {
  return {
    headers,
    locals: {},
    principal: { userId: undefined, userGroups: undefined, source: "service" },
  } as unknown as import("express").Request;
}

function mockRes(locals: Record<string, unknown> = {}) {
  const res = {
    statusCode: 200,
    body: null as unknown,
    locals: { ...locals },
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

describe("delete handler", () => {
  it('returns HTTP 200 with { status: "ok", deleted: N } on successful delete', async () => {
    const postgresClient = createMockPostgresClient({
      delete: { ok: true, result: { deleted: 3 } },
    });
    const handler = createDeleteHandler(postgresClient, logger);
    const res = mockRes({ metadata: { client: "acme" } });
    await handler(mockReq() as never, res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "ok", deleted: 3 });
  });

  it("returns HTTP 400 when metadata filter is empty", async () => {
    const postgresClient = createMockPostgresClient({});
    const handler = createDeleteHandler(postgresClient, logger);
    const res = mockRes({ metadata: {} });
    await handler(mockReq() as never, res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error:
        "Either X-Reference or at least one metadata filter is required for deletion",
    });
  });

  it("returns HTTP 400 when metadata is missing entirely", async () => {
    const postgresClient = createMockPostgresClient({});
    const handler = createDeleteHandler(postgresClient, logger);
    const res = mockRes({}); // no metadata in locals
    await handler(mockReq() as never, res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error:
        "Either X-Reference or at least one metadata filter is required for deletion",
    });
  });

  it("returns HTTP 502 when postgres returns an error", async () => {
    const postgresClient = createMockPostgresClient({
      delete: {
        ok: false,
        error: {
          code: "POSTGRES_SQL_ERROR",
          message: "Internal database error",
        },
      },
    });
    const handler = createDeleteHandler(postgresClient, logger);
    const res = mockRes({ metadata: { client: "acme" } });
    await handler(mockReq() as never, res as never, vi.fn());

    expect(res.statusCode).toBe(502);
    expect(res.body).toHaveProperty("error");
    expect((res.body as { error: string }).error).toContain(
      "Internal database error",
    );
  });

  it("returns HTTP 400 when collection name is invalid", async () => {
    const postgresClient = createMockPostgresClient({
      delete: {
        ok: false,
        error: {
          code: "INVALID_COLLECTION_NAME",
          message: "Invalid collection name",
        },
      },
    });
    const handler = createDeleteHandler(postgresClient, logger);
    const res = mockRes({ metadata: { client: "acme" } });
    await handler(
      mockReq({ "x-collection": "bad name" }) as never,
      res as never,
      vi.fn(),
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("passes the correct filter to postgresClient.delete", async () => {
    const postgresClient = createMockPostgresClient({
      delete: { ok: true, result: { deleted: 1 } },
    });
    const handler = createDeleteHandler(postgresClient, logger);
    const res = mockRes({ metadata: { client: "acme", property: "prop-1" } });
    await handler(mockReq() as never, res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    const deleteMock = postgresClient.delete as ReturnType<typeof vi.fn>;
    const [filter] = deleteMock.mock.calls[0];
    expect(filter).toEqual({ client: "acme", property: "prop-1" });
  });

  it("does not call postgresClient.delete when filter is empty", async () => {
    const postgresClient = createMockPostgresClient({});
    const handler = createDeleteHandler(postgresClient, logger);
    const res = mockRes({ metadata: {} });
    await handler(mockReq() as never, res as never, vi.fn());

    expect(res.statusCode).toBe(400);
    expect(postgresClient.delete).not.toHaveBeenCalled();
  });
});
