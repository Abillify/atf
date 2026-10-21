// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash, createHmac } from "node:crypto";
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

function fakeDb(rows: unknown[] | unknown[][]): {
  db: DbProvider;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const batches =
    rows.length > 0 && Array.isArray(rows[0])
      ? (rows as unknown[][])
      : [rows as unknown[]];
  const runner: QueryRunner = {
    raw: async (sql: string, bindings?: unknown) => {
      const batch = batches[Math.min(calls.length, batches.length - 1)] ?? [];
      calls.push({ sql, bindings });
      return { rows: batch };
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
    const payload = JSON.parse(res.content[0].text);
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
    const payload = JSON.parse(res.content[0].text);
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
    const payload = JSON.parse(res.content[0].text);
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
    const payload = JSON.parse(res.content[0].text);
    expect(payload.rows[0].email).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.rows[0].email).not.toBe("a@example.com");
  });

  it("keys the hash strategy with MCPGATE_REDACTION_HASH_SECRET (HMAC-SHA256)", async () => {
    const saved = process.env.MCPGATE_REDACTION_HASH_SECRET;
    const run = async (): Promise<string> => {
      const { db } = fakeDb([{ id: 1, email: "a@example.com" }]);
      const cfg = DatabaseToolSchema.parse({
        name: "t",
        type: "database",
        database: "main",
        query: "select 1",
        redact: [{ column: "email", strategy: "hash" }],
      });
      const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
      const res = await exec.execute({}, ctx);
      return JSON.parse(res.content[0].text).rows[0].email as string;
    };
    try {
      delete process.env.MCPGATE_REDACTION_HASH_SECRET;
      const unkeyed = await run();
      expect(unkeyed).toBe(createHash("sha256").update("a@example.com").digest("hex").slice(0, 16));

      process.env.MCPGATE_REDACTION_HASH_SECRET = "redaction-secret-0123456789";
      const keyed = await run();
      expect(keyed).toBe(
        createHmac("sha256", "redaction-secret-0123456789").update("a@example.com").digest("hex").slice(0, 16),
      );
      expect(keyed).not.toBe(unkeyed);
    } finally {
      if (saved === undefined) delete process.env.MCPGATE_REDACTION_HASH_SECRET;
      else process.env.MCPGATE_REDACTION_HASH_SECRET = saved;
    }
  });
});

describe("DatabaseToolExecutor · cursor pagination", () => {
  const SECRET = "test-cursor-secret-0123456789";

  function payloadOf(res: { content: { text?: string }[] }) {
    return JSON.parse(res.content[0]?.text ?? "{}") as {
      rows?: unknown[];
      nextCursor?: string;
    };
  }
  function sqlOf(calls: Recorded[], index: number): string {
    return calls[index]?.sql ?? "";
  }

  function paginationCfg(extra: Record<string, unknown> = {}) {
    return DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select id from x",
      pagination: { enabled: true, pageSize: 2, orderBy: ["id"], ...extra },
    });
  }

  it("returns a signed nextCursor when more rows remain and advances the offset", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const { db, calls } = fakeDb(rows);
    const exec = new DatabaseToolExecutor(paginationCfg(), {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });

    const first = await exec.execute({}, ctx);
    const firstPayload = payloadOf(first);
    expect(firstPayload.rows).toEqual([{ id: 1 }, { id: 2 }]);
    // Req 6.6: the cursor is an opaque HMAC token, not a bare offset.
    expect(firstPayload.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(firstPayload.nextCursor).not.toBe("2");
    expect(sqlOf(calls, 0)).toContain("LIMIT 3");
    expect(sqlOf(calls, 0)).toContain("ORDER BY id");
    expect(sqlOf(calls, 0)).not.toContain("OFFSET");
  });

  it("accepts its own cursor and applies it as an offset", async () => {
    const { db, calls } = fakeDb([
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ id: 3 }],
    ]);
    const exec = new DatabaseToolExecutor(paginationCfg(), {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });
    const first = await exec.execute({}, ctx);
    const cursor = payloadOf(first).nextCursor ?? "";

    const second = await exec.execute({ cursor }, ctx);
    expect(sqlOf(calls, 1)).toContain("OFFSET 2");
    expect(payloadOf(second).rows).toEqual([{ id: 3 }]);
  });

  it("rejects a tampered cursor signature", async () => {
    const { db } = fakeDb([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const exec = new DatabaseToolExecutor(paginationCfg(), {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });
    const first = await exec.execute({}, ctx);
    const cursor = payloadOf(first).nextCursor ?? "";
    const signature = cursor.slice(cursor.lastIndexOf(".") + 1);
    const forged = `${Buffer.from(JSON.stringify({ o: 99, fp: "x", sub: "attacker" })).toString("base64url")}.${signature}`;
    await expect(exec.execute({ cursor: forged }, ctx)).rejects.toThrow(
      "Invalid pagination cursor",
    );
  });

  it("rejects a plain decimal offset cursor", async () => {
    const { db } = fakeDb([{ id: 1 }]);
    const exec = new DatabaseToolExecutor(paginationCfg(), {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });
    await expect(exec.execute({ cursor: "2" }, ctx)).rejects.toThrow(
      "Invalid pagination cursor",
    );
  });

  it("rejects a cursor minted for a different principal", async () => {
    const { db } = fakeDb([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const exec = new DatabaseToolExecutor(paginationCfg(), {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });
    const first = await exec.execute({}, ctx);
    const cursor = payloadOf(first).nextCursor ?? "";
    const otherCtx: AuthContext = { ...ctx, subject: "mallory" };
    await expect(exec.execute({ cursor }, otherCtx)).rejects.toThrow(
      "Invalid pagination cursor",
    );
  });

  it("rejects a cursor reused with different query arguments", async () => {
    const { db } = fakeDb([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select id from x where tenant = :tenantId",
      pagination: { enabled: true, pageSize: 2, orderBy: ["id"] },
    });
    const exec = new DatabaseToolExecutor(cfg, {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });
    const first = await exec.execute({ tenantId: "a" }, ctx);
    const cursor = payloadOf(first).nextCursor ?? "";
    await expect(exec.execute({ cursor, tenantId: "b" }, ctx)).rejects.toThrow(
      "Invalid pagination cursor",
    );
    // The same args (plus a changed pageSize, which is a pagination knob) stay valid.
    await expect(
      exec.execute({ cursor, tenantId: "a", pageSize: 1 }, ctx),
    ).resolves.toBeTruthy();
  });

  it("rejects a cursor minted by a different tool", async () => {
    const { db } = fakeDb([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const execA = new DatabaseToolExecutor(paginationCfg(), {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });
    const cfgB = DatabaseToolSchema.parse({
      name: "other",
      type: "database",
      database: "main",
      query: "select id from y",
      pagination: { enabled: true, pageSize: 2, orderBy: ["id"] },
    });
    const execB = new DatabaseToolExecutor(cfgB, {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });
    const first = await execA.execute({}, ctx);
    const cursor = payloadOf(first).nextCursor ?? "";
    await expect(execB.execute({ cursor }, ctx)).rejects.toThrow(
      "Invalid pagination cursor",
    );
  });

  it("uses a keyset predicate instead of OFFSET when keyset is configured", async () => {
    const { db, calls } = fakeDb([
      [{ id: 1 }, { id: 2 }, { id: 3 }],
      [{ id: 3 }],
    ]);
    const exec = new DatabaseToolExecutor(paginationCfg({ keyset: ["id"] }), {
      db,
      bus: new MonitorBus(),
      paginationCursorSecret: SECRET,
    });
    const first = await exec.execute({}, ctx);
    const cursor = payloadOf(first).nextCursor ?? "";
    const second = await exec.execute({ cursor }, ctx);
    expect(sqlOf(calls, 1)).toContain("WHERE ((id > ?))");
    expect(sqlOf(calls, 1)).not.toContain("OFFSET");
    expect(calls[1]?.bindings).toEqual([2]);
    expect(payloadOf(second).rows).toEqual([{ id: 3 }]);
  });

  it("binds one value per placeholder for a multi-column keyset (Req 6.6)", async () => {
    const { db, calls } = fakeDb([
      [
        { grp: 1, id: 1 },
        { grp: 1, id: 2 },
        { grp: 2, id: 3 },
      ],
      [{ grp: 2, id: 3 }],
    ]);
    const exec = new DatabaseToolExecutor(
      paginationCfg({ orderBy: ["grp", "id"], keyset: ["grp", "id"] }),
      { db, bus: new MonitorBus(), paginationCursorSecret: SECRET },
    );
    const first = await exec.execute({}, ctx);
    await exec.execute({ cursor: payloadOf(first).nextCursor ?? "" }, ctx);
    const sql = sqlOf(calls, 1);
    expect(sql).toContain("WHERE ((grp > ?) OR (grp = ? AND id > ?))");
    expect(calls[1]?.bindings).toEqual([1, 1, 2]);
    expect(calls[1]?.bindings).toHaveLength((sql.match(/\?/g) ?? []).length);
  });

  it("seeks with < for DESC keyset columns (Req 6.6)", async () => {
    const { db, calls } = fakeDb([
      [
        { grp: 2, id: 9 },
        { grp: 2, id: 7 },
        { grp: 1, id: 5 },
      ],
      [{ grp: 1, id: 5 }],
    ]);
    const exec = new DatabaseToolExecutor(
      paginationCfg({ orderBy: ["grp DESC", "id"], keyset: ["grp", "id"] }),
      { db, bus: new MonitorBus(), paginationCursorSecret: SECRET },
    );
    const first = await exec.execute({}, ctx);
    await exec.execute({ cursor: payloadOf(first).nextCursor ?? "" }, ctx);
    expect(sqlOf(calls, 1)).toContain(
      "WHERE ((grp < ?) OR (grp = ? AND id > ?))",
    );
    expect(calls[1]?.bindings).toEqual([2, 2, 7]);
  });

  it("advertises a cursor input parameter when pagination is enabled", () => {
    const cfg = paginationCfg();
    const { db } = fakeDb([]);
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
    expect(
      (exec.definition.inputSchema.properties as Record<string, unknown>)
        .cursor,
    ).toBeDefined();
  });
});
