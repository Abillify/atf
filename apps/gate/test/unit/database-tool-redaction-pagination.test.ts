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
  claims: { role: "support" },
  headers: {},
  rawToken: "t",
};

const adminCtx: AuthContext = { ...ctx, claims: { role: "admin" } };

interface Recorded {
  sql: string;
  bindings: unknown;
}

function fakeDb(rows: unknown[]): { db: DbProvider; calls: Recorded[] } {
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
    clientName: () => "pg",
    healthcheck: async () => true,
    destroyAll: async () => {},
  };
  return { db, calls };
}

describe("DatabaseToolExecutor · redaction", () => {
  it("masks a column by default for callers who are not admin", async () => {
    const rows = [{ id: 1, email: "a@example.com" }];
    const { db } = fakeDb(rows);
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select 1",
      conditions: { notAdmin: { all: [{ context: "claims.role", equals: "support" }] } },
      redact: [{ column: "email", when: "notAdmin", strategy: "mask", placeholder: "[redacted]" }],
    });
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
    const res = await exec.execute({}, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.rows[0].email).toBe("[redacted]");
    expect(res.structuredContent).toEqual(payload);
  });

  it("does not redact when the caller does not match the condition", async () => {
    const rows = [{ id: 1, email: "a@example.com" }];
    const { db } = fakeDb(rows);
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select 1",
      conditions: { notAdmin: { all: [{ context: "claims.role", equals: "support" }] } },
      redact: [{ column: "email", when: "notAdmin" }],
    });
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
    const res = await exec.execute({}, adminCtx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.rows[0].email).toBe("a@example.com");
  });

  it("supports the omit strategy to drop a field entirely", async () => {
    const rows = [{ id: 1, ssn: "123-45-6789" }];
    const { db } = fakeDb(rows);
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select 1",
      redact: [{ column: "ssn", strategy: "omit" }],
    });
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
    const res = await exec.execute({}, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.rows[0]).toEqual({ id: 1 });
  });

  it("supports the hash strategy to replace a value with a stable digest", async () => {
    const rows = [{ id: 1, email: "a@example.com" }];
    const { db } = fakeDb(rows);
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select 1",
      redact: [{ column: "email", strategy: "hash" }],
    });
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
    const res = await exec.execute({}, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.rows[0].email).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.rows[0].email).not.toBe("a@example.com");
  });
});

describe("DatabaseToolExecutor · cursor pagination", () => {
  it("returns nextCursor when more rows remain and advances the offset", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { db, calls } = fakeDb(rows);
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select id from x",
      pagination: { enabled: true, pageSize: 2 },
    });
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });

    const first = await exec.execute({}, ctx);
    const firstPayload = JSON.parse(first.content[0]!.text);
    expect(firstPayload.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(firstPayload.nextCursor).toBe("2");
    expect(calls[0]!.sql).toContain("LIMIT 3");
    expect(calls[0]!.sql).not.toContain("OFFSET");
  });

  it("honours a caller-supplied cursor as an offset", async () => {
    const rows = [{ id: 3 }];
    const { db, calls } = fakeDb(rows);
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select id from x",
      pagination: { enabled: true, pageSize: 2 },
    });
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
    const res = await exec.execute({ cursor: "2" }, ctx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.rows).toEqual([{ id: 3 }]);
    expect(payload.nextCursor).toBeUndefined();
    expect(calls[0]!.sql).toContain("OFFSET 2");
  });

  it("advertises a cursor input parameter when pagination is enabled", () => {
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select id from x",
      pagination: { enabled: true },
    });
    const { db } = fakeDb([]);
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
    expect((exec.definition.inputSchema.properties as Record<string, unknown>).cursor).toBeDefined();
  });
});
