// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Integration test for FTS_CONTEXTUAL_HEADER against a REAL PostgreSQL +
 * pgvector instance.
 *
 * The behaviour it pins: with the flag on, ingest writes
 * `ts_search = setweight(to_tsvector(lang, header), 'D') || to_tsvector(lang, content)`
 * where the header is the document title plus the section path. A lexical
 * query for a term that appears ONLY in the title therefore finds the chunk,
 * while the same chunk is invisible to that query when the flag is off.
 *
 * The chunk under test is NOT the first chunk (chunk_index > 0), so the
 * default FTS text does not already contain the title (buildFtsText only
 * prepends the title to chunk 0). The header is therefore the only source of
 * the title term.
 *
 * Self-skips when TEST_POSTGRES_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import {
  createPostgresClient,
  type PostgresClient,
} from "../src/postgres-client.js";
import { collectionTableName } from "../src/collection-ddl.js";
import type { AccessScope } from "../src/access-scope.js";
import type { DocumentPoint } from "../src/pg-types.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;
const VECTOR_SIZE = 8;
const TENANT = `ftsctx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const logger = pino({ level: "silent" });

/** A term that lives only in the document title, never in the chunk text. */
const TITLE = "Fernwartungsrichtlinie";
const TITLE_TERM = "Fernwartungsrichtlinie";
const CONTENT =
  "Zugriffe auf Kundensysteme sind nur nach ausdruecklicher Freigabe erlaubt.";

function serviceScope(): AccessScope {
  return {
    principal: {
      userId: undefined,
      userGroups: [],
      scopes: [],
      source: "asserted",
    },
    userId: undefined,
    userGroups: [],
    tenantId: TENANT,
    scopes: [],
    service: true,
  };
}

function point(reference: string, content: string): DocumentPoint {
  const vector = new Array<number>(VECTOR_SIZE).fill(0);
  vector[0] = 1;
  return {
    tenantId: TENANT,
    reference,
    content,
    vector,
    metadata: {},
    title: TITLE,
    chunk: {
      chunk_index: 1,
      chunk_total: 2,
      chunk_size: 200,
      section_path: ["Kapitel 2", "Zugriff"],
    },
  };
}

describeIfPg("FTS contextual header · real postgres", () => {
  let pool: Pool;
  let pgOff: PostgresClient;
  let pgOn: PostgresClient;
  const collectionOff = `ftsctx_off_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const collectionOn = `ftsctx_on_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const tableOff = collectionTableName(collectionOff);
  const tableOn = collectionTableName(collectionOn);
  const tables = [tableOff, tableOn];

  const lexical = (client: PostgresClient, collection: string) =>
    client.search(
      TITLE_TERM,
      new Array<number>(VECTOR_SIZE).fill(0),
      5,
      collection,
      serviceScope(),
      undefined,
      true,
      false,
      0,
      4,
      undefined,
      undefined,
      undefined,
      true, // FTS only
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pgOff = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    pgOn = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
      ftsContextualHeader: true,
    });

    for (const [client, collection] of [
      [pgOff, collectionOff],
      [pgOn, collectionOn],
    ] as const) {
      const ensured = await client.ensureCollection(collection, VECTOR_SIZE, {
        language: "german",
      });
      expect(ensured.ok).toBe(true);
      const upserted = await client.upsert(point("doc", CONTENT), collection);
      expect(upserted.ok).toBe(true);
    }
  });

  afterAll(async () => {
    for (const table of tables) {
      await pool
        ?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`)
        .catch(() => {});
    }
    await pgOff?.close();
    await pgOn?.close();
    await pool?.end();
  });

  it("indexes the title at weight D only when the flag is on", async () => {
    // A weight-restricted tsquery proves the title lexeme carries weight D.
    const weightQuery = (table: string) =>
      `SELECT count(*)::int AS n FROM "${table}"
        WHERE tenant_id = $1 AND ts_search @@ to_tsquery('german', 'fernwartungsrichtlini:D')`;
    const on = await pool.query(weightQuery(tableOn), [TENANT]);
    const off = await pool.query(weightQuery(tableOff), [TENANT]);
    expect(on.rows[0].n).toBe(1);
    expect(off.rows[0].n).toBe(0);
  });

  it("finds the chunk for a title-only term when the flag is on", async () => {
    const res = await lexical(pgOn, collectionOn);
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    if (res.ok) expect(res.result.map((r) => r.reference)).toContain("doc");
  });

  it("does not find the chunk for a title-only term when the flag is off", async () => {
    const res = await lexical(pgOff, collectionOff);
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    if (res.ok) expect(res.result.map((r) => r.reference)).toEqual([]);
  });

  it("still finds the chunk for a term in the content with the flag on", async () => {
    const res = await pgOn.search(
      "Kundensysteme Freigabe",
      new Array<number>(VECTOR_SIZE).fill(0),
      5,
      collectionOn,
      serviceScope(),
      undefined,
      true,
      false,
      0,
      4,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    if (res.ok) expect(res.result.map((r) => r.reference)).toContain("doc");
  });
});
