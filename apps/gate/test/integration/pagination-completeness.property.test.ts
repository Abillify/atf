// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import type { AuthContext } from "../../src/auth/context.ts";
import { DatabaseConfigSchema, DatabaseToolSchema } from "../../src/config/schema.ts";
import { DatabaseManager, type DbProvider } from "../../src/db/manager.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import { DatabaseToolExecutor } from "../../src/tools/database-tool.ts";

/**
 * Property 10 (Req 6.5/6.6): paging a database tool to the end returns every
 * row of the ordered result exactly once — no gaps, no duplicates — and every
 * page except the last one is full. Checked for offset and keyset (seek)
 * pagination, with ascending, descending and mixed sort directions, against a
 * real SQLite (bun:sqlite, always) and a real PostgreSQL (only when
 * TEST_POSTGRES_URL is set, matching the other DB-gated suites).
 */

interface Row {
  id: number;
  grp: number;
  name: string;
}

interface Mode {
  label: string;
  orderBy: string[];
  keyset?: string[];
}

const MODES: Mode[] = [
  { label: "offset", orderBy: ["grp", "id"] },
  { label: "keyset ASC", orderBy: ["grp", "id"], keyset: ["grp", "id"] },
  { label: "keyset DESC", orderBy: ["grp DESC", "id DESC"], keyset: ["grp", "id"] },
  { label: "keyset mixed", orderBy: ["grp DESC", "id"], keyset: ["grp", "id"] },
];

const ctx: AuthContext = {
  method: "static",
  subject: "p10",
  username: "p10",
  scopes: [],
  claims: {},
  headers: {},
  rawToken: "t",
};

const SECRET = "p10-cursor-secret-0123456789abcdef";

/** Unique ids with a low-cardinality group column, so the order has ties on `grp`. */
const arbRows: fc.Arbitrary<Row[]> = fc
  .uniqueArray(fc.integer({ min: 1, max: 100_000 }), { minLength: 5, maxLength: 60 })
  .chain((ids) =>
    fc.tuple(
      fc.constant(ids),
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: ids.length, maxLength: ids.length }),
      // Printable ASCII: PostgreSQL TEXT rejects NUL characters.
      fc.array(fc.string({ unit: "grapheme-ascii", maxLength: 8 }), {
        minLength: ids.length,
        maxLength: ids.length,
      }),
    ),
  )
  .map(([ids, grps, names]) =>
    ids.map((id, i) => ({ id, grp: grps[i] ?? 0, name: names[i] ?? "" })),
  );

interface Backend {
  provider: DbProvider;
  client: string;
  table: string;
  load(rows: Row[]): Promise<void>;
  reference(orderBy: string[]): Promise<Row[]>;
}

/** Page through the tool until no cursor is returned; returns the pages. */
async function pageThrough(
  backend: Backend,
  mode: Mode,
  pageSize: number,
): Promise<Row[][]> {
  const cfg = DatabaseToolSchema.parse({
    name: "p10",
    type: "database",
    database: "main",
    query: `SELECT id, grp, name FROM ${backend.table}`,
    pagination: {
      enabled: true,
      pageSize,
      maxPageSize: 100,
      orderBy: mode.orderBy,
      ...(mode.keyset ? { keyset: mode.keyset } : {}),
    },
  });
  const exec = new DatabaseToolExecutor(cfg, {
    db: backend.provider,
    bus: new MonitorBus(),
    paginationCursorSecret: SECRET,
  });
  const pages: Row[][] = [];
  let cursor: string | undefined;
  // Hard cap: a broken cursor must fail the property, not hang the suite.
  for (let i = 0; i < 200; i++) {
    const res = await exec.execute(cursor ? { cursor } : {}, ctx);
    const payload = JSON.parse(res.content[0]?.text ?? "{}") as {
      rows: Row[];
      nextCursor?: string;
    };
    pages.push(payload.rows.map((r) => ({ id: Number(r.id), grp: Number(r.grp), name: r.name })));
    if (!payload.nextCursor) return pages;
    cursor = payload.nextCursor;
  }
  throw new Error("pagination did not terminate within 200 pages");
}

function propertyFor(backend: () => Backend, numRuns: number) {
  for (const mode of MODES) {
    it(`${mode.label}: pages concatenate to the ordered result without gaps or duplicates`, async () => {
      await fc.assert(
        fc.asyncProperty(arbRows, fc.integer({ min: 1, max: 9 }), async (rows, pageSize) => {
          const b = backend();
          await b.load(rows);
          const expected = await b.reference(mode.orderBy);
          const pages = await pageThrough(b, mode, pageSize);
          const all = pages.flat();
          expect(all).toEqual(expected);
          expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
          for (const page of pages.slice(0, -1)) expect(page.length).toBe(pageSize);
        }),
        { numRuns },
      );
    });
  }
}

/** A DbProvider over bun:sqlite: positional `?` bindings, bare-array rows. */
function sqliteBackend(): Backend {
  const db = new Database(":memory:");
  const table = "gate_p10";
  db.run(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, name TEXT NOT NULL)`);
  const provider: DbProvider = {
    get: () => ({
      raw: (sql: string, bindings?: unknown) =>
        db.query(sql).all(...((bindings as (string | number | null)[] | undefined) ?? [])),
    }),
    names: () => ["main"],
    clientName: () => "sqlite3",
    healthcheck: async () => true,
    destroyAll: async () => db.close(),
  };
  return {
    provider,
    client: "sqlite3",
    table,
    async load(rows) {
      db.run(`DELETE FROM ${table}`);
      const insert = db.prepare(`INSERT INTO ${table} (id, grp, name) VALUES (?, ?, ?)`);
      for (const r of rows) insert.run(r.id, r.grp, r.name);
    },
    async reference(orderBy) {
      return db.query(`SELECT id, grp, name FROM ${table} ORDER BY ${orderBy.join(", ")}`).all() as Row[];
    },
  };
}

describe("Property 10 · pagination completeness · SQLite", () => {
  let backend: Backend;
  beforeAll(() => {
    backend = sqliteBackend();
  });
  afterAll(async () => {
    await backend.provider.destroyAll();
  });
  propertyFor(() => backend, 50);
});

const PG_URL = process.env.TEST_POSTGRES_URL;

describe.skipIf(!PG_URL)("Property 10 · pagination completeness · PostgreSQL", () => {
  const table = `gate_p10_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let manager: DatabaseManager;
  let backend: Backend;
  beforeAll(async () => {
    manager = new DatabaseManager({
      main: DatabaseConfigSchema.parse({ client: "pg", connection: PG_URL, pool: { min: 0, max: 2 } }),
    });
    const knex = manager.get("main");
    await knex.raw(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, name TEXT NOT NULL)`);
    backend = {
      provider: manager,
      client: "pg",
      table,
      async load(rows) {
        await knex.raw(`TRUNCATE ${table}`);
        if (rows.length > 0) await knex(table).insert(rows);
      },
      async reference(orderBy) {
        const res = (await knex.raw(`SELECT id, grp, name FROM ${table} ORDER BY ${orderBy.join(", ")}`)) as {
          rows: Row[];
        };
        return res.rows.map((r) => ({ id: Number(r.id), grp: Number(r.grp), name: r.name }));
      },
    };
  }, 60_000);
  afterAll(async () => {
    await manager?.get("main").raw(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    await manager?.destroyAll();
  });
  propertyFor(() => backend, 25);
});
