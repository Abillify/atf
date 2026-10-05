// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for per-flow run statistics (`listFlowStats`) — the data behind the
 * flow table's stats columns (runs, avg runtime, avg/total cost) — covering
 * both store implementations and the monitoring route.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import {
  InMemoryExecutionStore,
  PostgresExecutionStore,
} from "../execution-store.js";
import {
  createMonitoringRouter,
  type MonitoringServiceInterface,
} from "../monitoring-service.js";
import type { Database } from "../../db/database.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";

/** Completed run for `flowId`, started at `startedAt`, with latency + cost. */
function recordRun(
  store: InMemoryExecutionStore,
  executionId: string,
  flowId: string,
  startedAt: string,
  latencyMs: number,
  cost: number | undefined,
): void {
  const node: NodeExecutionEvent = {
    execution_id: executionId,
    node_id: "n1",
    status: "completed",
    start_time: startedAt,
    end_time: startedAt,
    latency_ms: latencyMs,
    ...(cost !== undefined ? { cost } : {}),
  };
  store.recordEvent(node, { flowId });
  store.recordEvent(
    {
      execution_id: executionId,
      node_id: "__flow_end__",
      status: "completed",
      start_time: startedAt,
      end_time: startedAt,
      latency_ms: 0,
    },
    { flowId },
  );
}

describe("InMemoryExecutionStore.listFlowStats", () => {
  test("aggregates runs, avg latency, avg and total cost per flow", async () => {
    const store = new InMemoryExecutionStore();
    recordRun(store, "e1", "alpha", "2026-01-10T10:00:00.000Z", 100, 0.01);
    recordRun(store, "e2", "alpha", "2026-01-10T11:00:00.000Z", 300, 0.03);
    recordRun(store, "e3", "beta", "2026-01-10T12:00:00.000Z", 200, undefined);

    const stats = await store.listFlowStats("2026-01-10T00:00:00.000Z");
    expect(stats).toEqual([
      {
        flow_id: "alpha",
        runs: 2,
        avg_latency_ms: 200,
        avg_cost: 0.02,
        total_cost: 0.04,
      },
      {
        flow_id: "beta",
        runs: 1,
        avg_latency_ms: 200,
        avg_cost: null,
        total_cost: null,
      },
    ]);
  });

  test("excludes runs started before the window", async () => {
    const store = new InMemoryExecutionStore();
    recordRun(store, "old", "alpha", "2026-01-01T00:00:00.000Z", 500, 0.5);
    recordRun(store, "new", "alpha", "2026-01-10T00:00:00.000Z", 100, 0.01);

    const stats = await store.listFlowStats("2026-01-09T00:00:00.000Z");
    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({
      flow_id: "alpha",
      runs: 1,
      avg_latency_ms: 100,
      avg_cost: 0.01,
      total_cost: 0.01,
    });
  });

  test("runs without a flow id are omitted", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent({
      execution_id: "e1",
      node_id: "__request__",
      status: "completed",
      start_time: "2026-01-10T00:00:00.000Z",
      end_time: "2026-01-10T00:00:00.000Z",
      latency_ms: 5,
    });
    const stats = await store.listFlowStats("2026-01-01T00:00:00.000Z");
    expect(stats).toEqual([]);
  });
});

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** Fake `Database` returning canned rows and recording every query. */
function fakeDb(
  rows: Record<string, unknown>[],
): { db: Database; calls: Call[] } {
  const calls: Call[] = [];
  const db: Database = {
    query: async <T = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      calls.push({ sql, params });
      return rows as T[];
    },
    close: async () => {},
    withOperator: async <T>(cb: (d: Database) => Promise<T>) => cb(db),
  };
  return { db, calls };
}

describe("PostgresExecutionStore.listFlowStats", () => {
  test("groups by flow since the window and converts numeric strings", async () => {
    const { db, calls } = fakeDb([
      {
        flow_id: "alpha",
        runs: "3",
        avg_latency_ms: "150.5",
        avg_cost: "0.0125",
        total_cost: "0.0375",
      },
    ]);
    const store = new PostgresExecutionStore(db);
    const stats = await store.listFlowStats("2026-01-10T00:00:00.000Z");

    expect(stats).toEqual([
      {
        flow_id: "alpha",
        runs: 3,
        avg_latency_ms: 150.5,
        avg_cost: 0.0125,
        total_cost: 0.0375,
      },
    ]);
    const select = calls.find((c) => c.sql.includes("GROUP BY flow_id"));
    expect(select?.params).toEqual(["2026-01-10T00:00:00.000Z"]);
    expect(select?.sql).toContain("started_at >= $1::timestamptz");
  });

  test("null aggregates stay null", async () => {
    const { db } = fakeDb([
      {
        flow_id: "beta",
        runs: "1",
        avg_latency_ms: null,
        avg_cost: null,
        total_cost: null,
      },
    ]);
    const store = new PostgresExecutionStore(db);
    const stats = await store.listFlowStats("2026-01-10T00:00:00.000Z");
    expect(stats[0]).toEqual({
      flow_id: "beta",
      runs: 1,
      avg_latency_ms: null,
      avg_cost: null,
      total_cost: null,
    });
  });
});

describe("GET /monitoring/flow-stats", () => {
  /** Minimal service stub — the router only needs these to mount. */
  function fakeService(
    extra: Partial<MonitoringServiceInterface>,
  ): MonitoringServiceInterface {
    return {
      getTransportType: () => "sse",
      hasConnectionCapacity: () => true,
      subscribe: () => () => {},
      emitNodeEvent: () => {},
      ...extra,
    } as unknown as MonitoringServiceInterface;
  }

  function appWith(service: MonitoringServiceInterface): Hono {
    const a = new Hono();
    a.route("/", createMonitoringRouter(service));
    return a;
  }

  test("returns per-flow stats for a valid since", async () => {
    const service = fakeService({
      getFlowStats: async (_since: string) => [
        {
          flow_id: "alpha",
          runs: 2,
          avg_latency_ms: 200,
          avg_cost: 0.02,
          total_cost: 0.04,
        },
      ],
    });
    const res = await appWith(service).request(
      "/monitoring/flow-stats?since=2026-01-10T00%3A00%3A00.000Z",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: Array<{ flow_id: string; runs: number }>;
      since: string;
    };
    expect(body.stats).toHaveLength(1);
    expect(body.stats[0]?.flow_id).toBe("alpha");
    expect(body.since).toBe("2026-01-10T00:00:00.000Z");
  });

  test("rejects a missing or malformed since", async () => {
    const service = fakeService({ getFlowStats: async () => [] });
    const a = appWith(service);
    const missing = await a.request("/monitoring/flow-stats");
    expect(missing.status).toBe(400);
    const bogus = await a.request("/monitoring/flow-stats?since=not-a-date");
    expect(bogus.status).toBe(400);
  });

  test("services without stats support report an empty list", async () => {
    const service = fakeService({});
    const res = await appWith(service).request(
      "/monitoring/flow-stats?since=2026-01-10T00%3A00%3A00.000Z",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: unknown[] };
    expect(body.stats).toEqual([]);
  });
});
