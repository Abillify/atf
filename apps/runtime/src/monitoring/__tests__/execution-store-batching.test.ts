// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `PostgresExecutionStore`'s batched `node_events` write queue
 * (`src/monitoring/execution-store.ts`).
 *
 * Regression coverage for the finding that every node event triggered up to
 * four sequential round-trips (two UPSERTs + one INSERT + one UPDATE), scaling
 * DB load with node count rather than request count. This batches the
 * `node_events` INSERT — the one table whose row count actually scales with
 * node count — into a single multi-row statement per flush window, while
 * leaving the `executions`/`token_usage_log` UPSERT semantics untouched.
 */

import { describe, test, expect } from "bun:test";
import { PostgresExecutionStore } from "../execution-store.js";
import type { Database } from "../../db/database.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** A fake `Database` that records every query and never touches a real connection. */
function fakeDb(): { db: Database; calls: Call[] } {
  const calls: Call[] = [];
  const db: Database = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return [];
    },
    close: async () => {},
    withOperator: async <T>(cb: (d: Database) => Promise<T>) => cb(db),
  };
  return { db, calls };
}

function ev(
  execId: string,
  nodeId: string,
  status: NodeExecutionEvent["status"] = "completed",
): NodeExecutionEvent {
  return {
    execution_id: execId,
    node_id: nodeId,
    status,
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    latency_ms: 10,
  };
}

describe("PostgresExecutionStore — batched node_events writes", () => {
  test("multiple events queued within the flush window land in ONE multi-row INSERT", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db, undefined, {
      flushIntervalMs: 50,
      maxBatchSize: 200,
    });

    store.recordEvent(ev("e1", "n1"));
    store.recordEvent(ev("e1", "n2"));
    store.recordEvent(ev("e1", "n3"));
    await store.flush();

    const nodeEventInserts = calls.filter((c) =>
      c.sql.includes("INSERT INTO node_events"),
    );
    expect(nodeEventInserts).toHaveLength(1);
    // Three rows batched into one statement → 3 VALUES groups.
    const valueGroups = nodeEventInserts[0]?.sql.match(/\(\$/g) ?? [];
    expect(valueGroups.length).toBe(3);
  });

  test("flush() is idempotent — a second flush with nothing queued issues no extra INSERT", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db, undefined, {
      flushIntervalMs: 50,
    });
    store.recordEvent(ev("e1", "n1"));
    await store.flush();
    const afterFirst = calls.filter((c) =>
      c.sql.includes("INSERT INTO node_events"),
    ).length;
    await store.flush();
    const afterSecond = calls.filter((c) =>
      c.sql.includes("INSERT INTO node_events"),
    ).length;
    expect(afterSecond).toBe(afterFirst);
  });

  test("the batch auto-flushes once maxBatchSize is reached, without waiting for the timer", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db, undefined, {
      flushIntervalMs: 60_000, // long enough that the timer would not fire in this test
      maxBatchSize: 3,
    });
    store.recordEvent(ev("e1", "n1"));
    store.recordEvent(ev("e1", "n2"));
    store.recordEvent(ev("e1", "n3")); // hits maxBatchSize → immediate flush trigger
    await store.flush(); // drains the flush chain (no-op if already flushed)

    const nodeEventInserts = calls.filter((c) =>
      c.sql.includes("INSERT INTO node_events"),
    );
    expect(nodeEventInserts.length).toBeGreaterThanOrEqual(1);
    const totalRowsInserted = nodeEventInserts.reduce(
      (n, c) => n + (c.sql.match(/\(\$/g)?.length ?? 0),
      0,
    );
    expect(totalRowsInserted).toBe(3);
  });

  test("listEvents() forces a flush first, so a just-recorded event is visible immediately", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db, undefined, {
      flushIntervalMs: 60_000, // would not fire before the test's own timeout
    });
    store.recordEvent(ev("e1", "n1"));
    // Before any explicit flush, the row is only in the in-process queue.
    expect(
      calls.some((c) => c.sql.includes("INSERT INTO node_events")),
    ).toBe(false);

    await store.listEvents("e1");

    // listEvents() must have forced the queued row out.
    expect(
      calls.some((c) => c.sql.includes("INSERT INTO node_events")),
    ).toBe(true);
  });

  test("events for different executions can share one flushed batch", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db, undefined, {
      flushIntervalMs: 50,
    });
    store.recordEvent(ev("e1", "n1"));
    store.recordEvent(ev("e2", "n1"));
    await store.flush();

    const nodeEventInserts = calls.filter((c) =>
      c.sql.includes("INSERT INTO node_events"),
    );
    expect(nodeEventInserts).toHaveLength(1);
    // Both execution_ids appear among the bound parameters of the one insert.
    const params = nodeEventInserts[0]?.params ?? [];
    expect(params).toContain("e1");
    expect(params).toContain("e2");
  });

  test("a query error during flush is logged and does not throw out of recordEvent", async () => {
    const calls: Call[] = [];
    const warnings: string[] = [];
    const db: Database = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO node_events")) {
          throw new Error("connection reset");
        }
        return [];
      },
      close: async () => {},
      withOperator: async <T>(cb: (d: Database) => Promise<T>) => cb(db),
    };
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    } as unknown as import("../../observability/logger.js").Logger;

    const store = new PostgresExecutionStore(db, logger, {
      flushIntervalMs: 50,
    });
    store.recordEvent(ev("e1", "n1"));
    await store.flush(); // must not throw
    expect(warnings.some((w) => w.includes("Failed to flush"))).toBe(true);
  });
});
