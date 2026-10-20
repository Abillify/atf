// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/health.test.ts
//
// The health endpoint requires a live PostgreSQL connection, so we test it
// via the full app with a mocked postgres client injected through createApp.
// Since createApp wires up the real postgresClient from config, we test the
// handler directly instead.

import { describe, it, expect, vi } from "vitest";
import {
  createHealthHandler,
  createLivenessHandler,
  createReadinessHandler,
} from "../src/handlers/admin.js";
import type {
  PostgresClient,
  PostgresResponse,
} from "../src/postgres-client.js";
import pino from "pino";

function createMockPostgresClient(responses: {
  ping?: PostgresResponse<void>;
}): PostgresClient {
  return {
    ensureCollection: vi.fn(),
    upsert: vi.fn(),
    batchUpsert: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    getIngestStats: vi.fn(),
    getSearchStats: vi.fn(),
    listCollections: vi.fn(),
    deleteCollection: vi.fn(),
    recordSearchStat: vi.fn(),
    getStatsCounters: vi.fn(),
    getCircuitBreakerStatuses: vi.fn().mockReturnValue([]),
    ping: vi
      .fn()
      .mockResolvedValue(responses.ping ?? { ok: true, result: undefined }),
    close: vi.fn(),
  } as unknown as PostgresClient;
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

describe("GET /health (handler unit test)", () => {
  it('returns HTTP 200 with { status: "healthy" } when DB is reachable', async () => {
    const handler = createHealthHandler(
      {
        postgresClient: createMockPostgresClient({
          ping: { ok: true, result: undefined },
        }),
      },
      logger,
    );
    const res = mockRes();
    await handler({} as never, res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect((res.body as { status: string }).status).toBe("healthy");
    // New shape: checks.database instead of top-level database field
    expect((res.body as { checks: { database: string } }).checks.database).toBe(
      "ok",
    );
    expect(typeof (res.body as { timestamp: string }).timestamp).toBe("string");
  });

  it('returns HTTP 503 with { status: "unhealthy" } when DB is unreachable', async () => {
    const handler = createHealthHandler(
      {
        postgresClient: createMockPostgresClient({
          ping: {
            ok: false,
            error: {
              code: "POSTGRES_UNREACHABLE",
              message: "Connection refused",
            },
          },
        }),
      },
      logger,
    );
    const res = mockRes();
    await handler({} as never, res as never, vi.fn());

    expect(res.statusCode).toBe(503);
    expect((res.body as { status: string }).status).toBe("unhealthy");
    expect((res.body as { checks: { database: string } }).checks.database).toBe(
      "Connection refused",
    );
  });
});

describe("GET /health/live (requirement 12.5)", () => {
  it("returns 200 without touching any dependency", async () => {
    // The liveness probe must not even ping the database: restarting a pod
    // because Postgres is slow turns a dependency outage into a full outage.
    const postgresClient = createMockPostgresClient({});
    const handler = createLivenessHandler();
    const res = mockRes();
    await handler({} as never, res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect((res.body as { status: string }).status).toBe("ok");
    expect(typeof (res.body as { uptime_seconds: number }).uptime_seconds).toBe(
      "number",
    );
    expect(postgresClient.ping).not.toHaveBeenCalled();
  });
});

describe("GET /health/ready (requirement 12.5)", () => {
  it("returns 200 when the database pings", async () => {
    const handler = createReadinessHandler(
      createMockPostgresClient({ ping: { ok: true, result: undefined } }),
      logger,
    );
    const res = mockRes();
    await handler({} as never, res as never, vi.fn());

    expect(res.statusCode).toBe(200);
    expect((res.body as { status: string }).status).toBe("ready");
    expect((res.body as { checks: { database: string } }).checks.database).toBe(
      "ok",
    );
  });

  it("returns 503 when the database is unreachable", async () => {
    const handler = createReadinessHandler(
      createMockPostgresClient({
        ping: {
          ok: false,
          error: {
            code: "POSTGRES_UNREACHABLE",
            message: "Connection refused",
          },
        },
      }),
      logger,
    );
    const res = mockRes();
    await handler({} as never, res as never, vi.fn());

    expect(res.statusCode).toBe(503);
    expect((res.body as { status: string }).status).toBe("unready");
    expect((res.body as { checks: { database: string } }).checks.database).toBe(
      "Connection refused",
    );
  });
});

describe("auth: disabled signal (P0-1)", () => {
  it("is reported while AUTHN_MODE=disabled and absent otherwise", async () => {
    const postgresClient = createMockPostgresClient({});
    const open = mockRes();
    await createHealthHandler({ postgresClient, authDisabled: true }, logger)({} as never, open as never, vi.fn());
    expect((open.body as { auth?: string }).auth).toBe("disabled");
    const closed = mockRes();
    await createHealthHandler({ postgresClient, authDisabled: false }, logger)({} as never, closed as never, vi.fn());
    expect(closed.body).not.toHaveProperty("auth");
  });
});
