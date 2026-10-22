// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Keyset paging of the FTS-only list against a REAL PostgreSQL instance.
 *
 * The FTS order is two-tiered: chunks containing every query term first, then
 * the remaining any-term matches, each by score. The defect this pins: a
 * `(score, id)` cursor ignored the tier, so a page boundary inside the
 * all-terms tier dropped any-term hits scoring above it, and a boundary inside
 * the any-term tier repeated all-terms hits. Paging through a multi-word query
 * must return exactly the rows of one large query: no gap, no duplicate.
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
import type { SearchCursor, SearchResult } from "../src/pg-types.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;
const VECTOR_SIZE = 8;
const TENANT = `ftscursor-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const logger = pino({ level: "silent" });

function serviceScope(): AccessScope {
  return {
    principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" },
    userId: undefined,
    userGroups: [],
    tenantId: TENANT,
    scopes: [],
    service: true,
  };
}

const QUERY_VECTOR = (() => {
  const v = new Array<number>(VECTOR_SIZE).fill(0);
  v[0] = 1;
  return v;
})();

/**
 * Synthetic corpus. All-terms chunks mention both words once in long text
 * (low score); any-term chunks repeat a single word densely (high score), so
 * the score order runs against the tier order: exactly the case the cursor
 * has to get right.
 */
function corpus(): string[] {
  const filler = "lorem ipsum dolor sit amet ".repeat(30);
  const rows: string[] = [];
  for (let i = 0; i < 7; i++) rows.push(`${filler} wartung pumpe ${filler} ${i}`);
  for (let i = 0; i < 7; i++) rows.push(`wartung wartung wartung wartung ${i}`);
  for (let i = 0; i < 6; i++) rows.push(`pumpe pumpe pumpe ${i}`);
  return rows;
}

describeIfPg("FTS keyset paging over the all-terms tier · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `ftscursor_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  const fts = (limit: number, cursor?: SearchCursor) =>
    pg.search(
      "Wartung Pumpe",
      QUERY_VECTOR,
      limit,
      collection,
      serviceScope(),
      undefined,
      true,
      false,
      0,
      4,
      undefined,
      undefined,
      cursor,
      true, // ftsOnly
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);
    const rows = corpus();
    for (let i = 0; i < rows.length; i++) {
      await pool.query(
        `INSERT INTO "${table}"
           (tenant_id, reference, base_ref, is_latest, content, vector, ts_search, metadata, unit_id, unit_type)
         VALUES ($1, $2, $2, TRUE, $3, $4::vector, to_tsvector('simple', $3), '{}'::jsonb, $2, 'chunk')`,
        [TENANT, `doc-${i}`, rows[i], JSON.stringify(QUERY_VECTOR)],
      );
    }
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
    await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
    await pool?.query(`DELETE FROM vs_ingest_batches WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pool?.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pg?.close();
    await pool?.end();
  });

  it.each([3, 5, 7, 8])(
    "pages of %i return the single-query order without gap or duplicate",
    async (pageSize) => {
      const all = await fts(100);
      expect(all.ok).toBe(true);
      const expected = all.ok ? all.result.map((r) => r.reference) : [];
      expect(expected).toHaveLength(20);
      // The tiers really are inverted against the score: the first chunk is an
      // all-terms one although every any-term chunk scores higher.
      expect(expected.slice(0, 7).every((r) => Number(r.slice(4)) < 7)).toBe(true);

      const paged: string[] = [];
      let cursor: SearchCursor | undefined;
      for (let guard = 0; guard < 30; guard++) {
        const page = await fts(pageSize, cursor);
        expect(page.ok, page.ok ? "" : JSON.stringify(page.error)).toBe(true);
        const results: SearchResult[] = page.ok ? page.result : [];
        paged.push(...results.map((r) => r.reference));
        if (results.length < pageSize) break;
        const last = results[results.length - 1];
        cursor = { created: last.created.toISOString(), id: last.id, score: last.score };
      }
      expect(paged).toEqual(expected);
    },
  );
});
