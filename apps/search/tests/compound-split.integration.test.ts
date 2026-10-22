// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Integration test for FTS_COMPOUND_SPLIT against a REAL PostgreSQL +
 * pgvector instance.
 *
 * The German stemmer keeps compounds as a single lexeme, so the status quo
 * (flag off) is: a chunk containing `Kommissionierarbeitsplatz` is NOT found
 * by the query `Arbeitsplatz`. With the flag on, the query-side splitter adds
 * the compound's parts to the lexical OR list, so the query
 * `Kommissionierarbeitsplatz` DOES find a chunk that only contains
 * `Arbeitsplatz`.
 *
 * The lexicon is the collection's own vocabulary (ts_stat, ndoc >= 2), so the
 * ON collection ingests enough chunks for BOTH `arbeitsplatz` and
 * `kommission` to reach ndoc >= 2 — the split of `kommissionierarbeitsplatz`
 * needs both sides to be known lexemes. The lexicon is built ASYNCHRONOUSLY on
 * first need (the triggering query runs WITHOUT splitting), so the ON query is
 * polled until the target chunk appears or a bounded timeout elapses.
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
const TENANT = `csplit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const logger = pino({ level: "silent" });

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
    title: "Lagerdokument",
    chunk: {
      chunk_index: 1,
      chunk_total: 2,
      chunk_size: 200,
      section_path: ["Kapitel 1"],
    },
  };
}

/** FTS-only lexical search (14 positional args, ftsOnly = true). */
function lexical(client: PostgresClient, collection: string, query: string) {
  return client.search(
    query,
    new Array<number>(VECTOR_SIZE).fill(0),
    10,
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
}

describeIfPg("compound split · real postgres", () => {
  let pool: Pool;
  let pgOff: PostgresClient;
  let pgOn: PostgresClient;
  const collectionOff = `csplit_off_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const collectionOn = `csplit_on_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const tableOff = collectionTableName(collectionOff);
  const tableOn = collectionTableName(collectionOn);
  const tables = [tableOff, tableOn];

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
      ftsCompoundSplit: true,
    });

    // OFF collection: a single chunk holding the full compound.
    const ensuredOff = await pgOff.ensureCollection(collectionOff, VECTOR_SIZE, {
      language: "german",
    });
    expect(ensuredOff.ok).toBe(true);
    expect(
      (
        await pgOff.upsert(
          point("compound", "Der Kommissionierarbeitsplatz ist neu."),
          collectionOff,
        )
      ).ok,
    ).toBe(true);

    // ON collection: enough chunks that BOTH `arbeitsplatz` and `kommission`
    // reach ndoc >= 2 in the lexicon. `target` only ever holds `Arbeitsplatz`.
    const ensuredOn = await pgOn.ensureCollection(collectionOn, VECTOR_SIZE, {
      language: "german",
    });
    expect(ensuredOn.ok).toBe(true);
    const onChunks: Array<[string, string]> = [
      ["target", "Der neue Arbeitsplatz befindet sich im Hallenbereich."],
      ["beleg1", "Die Kommission am Arbeitsplatz wurde abgeschlossen."],
      ["beleg2", "Die Kommission umfasst mehrere Artikel."],
    ];
    for (const [reference, content] of onChunks) {
      expect((await pgOn.upsert(point(reference, content), collectionOn)).ok).toBe(
        true,
      );
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

  it("status quo (off): compound chunk is NOT found by a part query", async () => {
    const res = await lexical(pgOff, collectionOff, "Arbeitsplatz");
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    if (res.ok) expect(res.result.map((r) => r.reference)).toEqual([]);
  });

  it("on: part query finds the compound chunk once the lexicon is built", async () => {
    // The first query triggers the async lexicon build and runs WITHOUT
    // splitting; poll until the split OR list makes `target` match.
    let found = false;
    for (let attempt = 0; attempt < 40 && !found; attempt++) {
      const res = await lexical(pgOn, collectionOn, "Kommissionierarbeitsplatz");
      expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
      if (res.ok) found = res.result.map((r) => r.reference).includes("target");
      if (!found) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(found).toBe(true);
  });
});
