// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `collection_stats.capabilities` (P1-S8) against a REAL PostgreSQL + pgvector.
 *
 * A collection ingested before the v2 pipeline has chunk rows but no unit
 * graph: `get_outline`, `get_pages`, `get_section` and `get_context` come back
 * empty for it, and a flow had no way to know. The stats now say what the
 * stored data supports, and a table that predates the v2 columns altogether
 * answers "nothing" instead of an error.
 *
 * Self-skips when TEST_POSTGRES_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { collectionTableName } from "../src/collection-ddl.js";
import { ensureRevisionTables } from "../src/revision-schema.js";
import type { AccessScope } from "../src/access-scope.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;
const VECTOR_SIZE = 4;
const TENANT = `capstest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const logger = pino({ level: "silent" });

const scope: AccessScope = {
  principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" },
  userId: undefined,
  userGroups: [],
  tenantId: TENANT,
  scopes: [],
  service: true,
};

describeIfPg("collection_stats capabilities · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const v2 = `caps_v2_${stamp}`;
  const legacy = `caps_legacy_${stamp}`;
  const noColumns = `caps_nocols_${stamp}`;

  async function insertRow(
    collection: string,
    ref: string,
    extra: { unitId?: string; sectionId?: string; pageStart?: number } = {},
  ): Promise<void> {
    const table = collectionTableName(collection);
    const cols = ["tenant_id", "reference", "base_ref", "is_latest", "content", "vector"];
    const vals: unknown[] = [TENANT, ref, ref, true, `Inhalt ${ref}`, JSON.stringify([1, 0, 0, 0])];
    const marks = ["$1", "$2", "$3", "$4", "$5", "$6::vector"];
    for (const [col, value] of [
      ["unit_id", extra.unitId],
      ["section_id", extra.sectionId],
      ["page_start", extra.pageStart],
    ] as const) {
      if (value === undefined) continue;
      cols.push(col);
      vals.push(value);
      marks.push(`$${vals.length}`);
    }
    await pool.query(
      `INSERT INTO "${table}" (${cols.join(", ")}) VALUES (${marks.join(", ")})`,
      vals,
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    for (const name of [v2, legacy, noColumns]) {
      expect((await pg.ensureCollection(name, VECTOR_SIZE)).ok).toBe(true);
    }
    // v2: rows with a unit graph, sections and pages.
    await insertRow(v2, "a.pdf#1", { unitId: "u1", sectionId: "s1", pageStart: 3 });
    await insertRow(v2, "a.pdf#2", { unitId: "u2" });
    // legacy-style: plain chunk rows, no unit columns filled.
    await insertRow(legacy, "old.pdf#1");
    await insertRow(legacy, "old.pdf#2");
    // a table that predates the v2 columns: they are gone altogether.
    await insertRow(noColumns, "ancient.pdf#1");
    await pool.query(
      `ALTER TABLE "${collectionTableName(noColumns)}"
         DROP COLUMN unit_id CASCADE, DROP COLUMN section_id CASCADE, DROP COLUMN page_start CASCADE`,
    );
    // Other suites create the shared revision tables concurrently.
    for (let attempt = 1; ; attempt++) {
      const client = await pool.connect();
      try {
        await ensureRevisionTables(client);
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt >= 5 || (code !== "40P01" && code !== "23505")) throw err;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      } finally {
        client.release();
      }
    }
  });

  afterAll(async () => {
    for (const name of [v2, legacy, noColumns]) {
      await pool?.query(`DROP TABLE IF EXISTS "${collectionTableName(name)}" CASCADE`).catch(() => {});
    }
    await pg?.close();
    await pool?.end();
  });

  it("a v2 collection reports its unit graph, outline and pages", async () => {
    const res = await pg.getCollectionStats(v2, scope);
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    if (!res.ok) return;
    expect(res.result.totalChunks).toBe(2);
    expect(res.result.capabilities).toEqual({
      unitRows: 2,
      unitGraph: true,
      outline: true,
      pages: true,
    });
  });

  it("a pre-v2 collection reports chunks but no unit graph", async () => {
    const res = await pg.getCollectionStats(legacy, scope);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.totalChunks).toBe(2);
    expect(res.result.capabilities).toEqual({
      unitRows: 0,
      unitGraph: false,
      outline: false,
      pages: false,
    });
  });

  it("a table without the v2 columns answers 'no capabilities', not an error", async () => {
    const res = await pg.getCollectionStats(noColumns, scope);
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    if (!res.ok) return;
    expect(res.result.totalChunks).toBe(1);
    expect(res.result.capabilities.unitGraph).toBe(false);
  });

  it("an unknown collection is still COLLECTION_NOT_FOUND", async () => {
    const res = await pg.getCollectionStats(`caps_missing_${stamp}`, scope);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("COLLECTION_NOT_FOUND");
  });
});
