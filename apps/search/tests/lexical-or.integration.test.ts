// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Integration test for the OR-semantics lexical list against a REAL
 * PostgreSQL + pgvector instance.
 *
 * The defect it pins: the lexical branch used `websearch_to_tsquery`, which
 * ANDs bare terms. A natural-language question ("Wie hoch ist die Miete im
 * Mietvertrag?") almost never matches ONE chunk with every word, so the
 * lexical list came back empty and a "hybrid" search degraded to pure vector
 * search. The lexical list now ORs the query terms (`buildLexicalOrTsQuery`).
 *
 * The tests show before/after on the same data:
 *   - the legacy AND query (run as raw SQL) matches NOTHING;
 *   - `search(..., hybrid=true)` now surfaces the chunk whose vector is far
 *     from the query but which shares terms with it;
 *   - a query that is only punctuation yields no lexical match and no error;
 *   - tsquery syntax inside the question can never be interpreted as operators.
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
const VECTOR_SIZE = 8;
const TENANT = `lexor-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const logger = pino({ level: "silent" });

function serviceScope(tenantId = TENANT): AccessScope {
  return {
    principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" },
    userId: undefined,
    userGroups: [],
    tenantId,
    scopes: [],
    service: true,
  };
}

/** Close to the query vector: dense ranks these first. */
function nearVector(i: number): number[] {
  const v = new Array<number>(VECTOR_SIZE).fill(0);
  v[0] = 1;
  v[1] = 0.05 * (i + 1);
  return v;
}

/** Orthogonal to the query: dense ranks these last. */
function farVector(i: number): number[] {
  const v = new Array<number>(VECTOR_SIZE).fill(0);
  v[VECTOR_SIZE - 1] = 1;
  v[VECTOR_SIZE - 2] = 0.05 * (i + 1);
  return v;
}

const QUERY_VECTOR = (() => {
  const v = new Array<number>(VECTOR_SIZE).fill(0);
  v[0] = 1;
  return v;
})();

const QUESTION = "Wie hoch ist die Miete im Mietvertrag?";

describeIfPg("lexical OR list · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `lexor_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  async function insertUnit(
    unitId: string,
    content: string,
    vector: number[],
  ): Promise<void> {
    await pool.query(
      `INSERT INTO "${table}"
         (tenant_id, reference, base_ref, is_latest, content, vector, ts_search, metadata, unit_id, unit_type)
       VALUES ($1, $2, $3, TRUE, $4, $5::vector, to_tsvector('simple', $4), $6::jsonb, $7, 'chunk')`,
      [
        TENANT,
        `doc::${unitId}`,
        "doc",
        content,
        JSON.stringify(vector),
        JSON.stringify({ unit_id: unitId, unit_type: "chunk" }),
        unitId,
      ],
    );
  }

  const hybrid = (query: string, ftsOnly = false) =>
    pg.search(
      query,
      QUERY_VECTOR,
      3,
      collection,
      serviceScope(),
      undefined,
      true, // hybrid
      false,
      0,
      4,
      undefined,
      undefined,
      undefined,
      ftsOnly,
    );

  const refs = (res: Awaited<ReturnType<typeof hybrid>>): string[] => {
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    return res.ok ? res.result.map((r) => r.reference) : [];
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);

    for (let i = 0; i < 5; i++) {
      await insertUnit(
        `prose-${i}`,
        `Allgemeiner Fließtext Nummer ${i} ohne Bezug zur Frage.`,
        nearVector(i),
      );
    }
    // Shares terms with the question but NOT all of them ("wie", "hoch", "ist"
    // are missing) and sits far from the query vector.
    await insertUnit(
      "rent",
      "Die Miete beträgt 1200 Euro monatlich laut Mietvertrag.",
      farVector(0),
    );

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

  it("BEFORE: the legacy AND query matches nothing for the question", async () => {
    const legacy = await pool.query(
      `SELECT count(*)::int AS n FROM "${table}"
        WHERE ts_search @@ websearch_to_tsquery('simple', $1)`,
      [QUESTION],
    );
    expect(legacy.rows[0].n).toBe(0);
  });

  it("AFTER: the OR list matches the chunk that shares only some terms", async () => {
    const lexical = await pool.query(
      `SELECT count(*)::int AS n FROM "${table}"
        WHERE ts_search @@ to_tsquery('simple', $1)`,
      ["'Wie' | 'hoch' | 'ist' | 'die' | 'Miete' | 'im' | 'Mietvertrag'"],
    );
    expect(lexical.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("hybrid search lifts the lexical-only chunk into the top results", async () => {
    const top = refs(await hybrid(QUESTION));
    // Dense order alone would fill the page with the five near-vector chunks.
    expect(top).toContain("doc::rent");
  });

  it("FTS-only search finds the chunk for the question as well", async () => {
    const res = await hybrid(QUESTION, true);
    expect(refs(res)).toEqual(["doc::rent"]);
  });

  it("a punctuation-only query is not an error and matches nothing lexically", async () => {
    const res = await hybrid("?!:&|()", true);
    expect(refs(res)).toEqual([]);
  });

  it("tsquery operators inside the question are inert text", async () => {
    const res = await hybrid("Miete & !Mietvertrag | (x:*) 'quoted' \\ end", true);
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    expect(refs(res)).toContain("doc::rent");
  });
});
