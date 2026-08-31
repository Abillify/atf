// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { DatabaseToolExecutor } from "../../src/tools/database-tool.ts";
import { DatabaseToolSchema } from "../../src/config/schema.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import type { DbProvider, QueryRunner } from "../../src/db/manager.ts";
import type { AuthContext } from "../../src/auth/context.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "s",
  username: "alice",
  scopes: [],
  claims: {},
  headers: {},
  rawToken: "t",
};

interface Recorded {
  sql: string;
  bindings: unknown;
}

/** A DbProvider whose client name is configurable and that records queries. */
function fakeDb(client: string, rows: unknown[]): { db: DbProvider; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const runner: QueryRunner = {
    raw: async (sql: string, bindings?: unknown) => {
      calls.push({ sql, bindings });
      return { rows };
    },
  };
  const db: DbProvider = {
    get: () => runner,
    names: () => ["main"],
    clientName: () => client,
    healthcheck: async () => true,
    destroyAll: async () => {},
  };
  return { db, calls };
}

function tool(extra: Record<string, unknown>) {
  return DatabaseToolSchema.parse({
    name: "t",
    type: "database",
    database: "main",
    query: "SELECT id FROM orders WHERE u = :ctx.username",
    ...extra,
  });
}

describe("DatabaseToolExecutor · autoLimit pushdown", () => {
  it("wraps pg queries in a LIMIT subquery (rowLimit+1) without changing bindings", async () => {
    const { db, calls } = fakeDb("pg", [{ id: 1 }]);
    const exec = new DatabaseToolExecutor(tool({ rowLimit: 50 }), { db, bus: new MonitorBus() });
    await exec.execute({}, ctx);
    expect(calls[0]!.sql).toBe("SELECT * FROM (SELECT id FROM orders WHERE u = ?) AS _mcpgate_q LIMIT 51");
    expect(calls[0]!.bindings).toEqual(["alice"]);
  });

  it("uses TOP for mssql", async () => {
    const { db, calls } = fakeDb("mssql", []);
    const exec = new DatabaseToolExecutor(tool({ rowLimit: 10 }), { db, bus: new MonitorBus() });
    await exec.execute({}, ctx);
    expect(calls[0]!.sql).toBe("SELECT TOP (11) * FROM (SELECT id FROM orders WHERE u = ?) AS _mcpgate_q");
  });

  it("uses ROWNUM for oracle", async () => {
    const { db, calls } = fakeDb("oracledb", []);
    const exec = new DatabaseToolExecutor(tool({ rowLimit: 5 }), { db, bus: new MonitorBus() });
    await exec.execute({}, ctx);
    expect(calls[0]!.sql).toBe("SELECT * FROM (SELECT id FROM orders WHERE u = ?) WHERE ROWNUM <= 6");
  });

  it("does not wrap when autoLimit is disabled", async () => {
    const { db, calls } = fakeDb("pg", []);
    const exec = new DatabaseToolExecutor(tool({ autoLimit: false }), { db, bus: new MonitorBus() });
    await exec.execute({}, ctx);
    expect(calls[0]!.sql).toBe("SELECT id FROM orders WHERE u = ?");
  });

  it("does not double-wrap a query that already has a LIMIT", async () => {
    const { db, calls } = fakeDb("pg", []);
    const exec = new DatabaseToolExecutor(
      tool({ query: "SELECT id FROM orders LIMIT 3" }),
      { db, bus: new MonitorBus() },
    );
    await exec.execute({}, ctx);
    expect(calls[0]!.sql).toBe("SELECT id FROM orders LIMIT 3");
  });
});

describe("DatabaseToolExecutor · result shaping", () => {
  it("reports truncation when more than rowLimit rows are returned", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { db } = fakeDb("pg", rows);
    const exec = new DatabaseToolExecutor(tool({ rowLimit: 2 }), { db, bus: new MonitorBus() });
    const res = await exec.execute({}, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.rowCount).toBe(2);
    expect(payload.truncated).toBe(true);
  });

  it("returns rows compactly with rowCount and truncated=false", async () => {
    const { db } = fakeDb("pg", [{ id: 1 }]);
    const exec = new DatabaseToolExecutor(tool({ rowLimit: 10 }), { db, bus: new MonitorBus() });
    const res = await exec.execute({}, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload).toEqual({ rowCount: 1, truncated: false, rows: [{ id: 1 }] });
  });
});


describe("DatabaseToolExecutor · top-level LIMIT scanner", () => {
  for (const [label, query] of [
    ["string literal", "SELECT 'LIMIT 1' AS note FROM orders"],
    ["quoted identifier", 'SELECT "TOP" FROM orders'],
    ["line comment", "SELECT id FROM orders -- LIMIT 1"],
    ["block comment", "SELECT id /* TOP 1 */ FROM orders"],
    ["nested query", "SELECT * FROM (SELECT id FROM orders LIMIT 1) nested"],
  ] as const) {
    it(`still wraps LIMIT/TOP appearing only in a ${label}`, async () => {
      const { db, calls } = fakeDb("pg", []);
      const exec = new DatabaseToolExecutor(tool({ query, rowLimit: 4 }), { db, bus: new MonitorBus() });
      await exec.execute({}, ctx);
      expect(calls[0]!.sql).toStartWith("SELECT * FROM (");
      expect(calls[0]!.sql).toEndWith("LIMIT 5");
    });
  }

  it("recognizes an outer TOP clause", async () => {
    const { db, calls } = fakeDb("mssql", []);
    const query = "SELECT TOP (3) id FROM orders";
    const exec = new DatabaseToolExecutor(tool({ query }), { db, bus: new MonitorBus() });
    await exec.execute({}, ctx);
    expect(calls[0]!.sql).toBe(query);
  });
});