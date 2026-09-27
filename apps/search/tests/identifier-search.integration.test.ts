// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the identifier RRF list (Requirements 12.1/12.3/13.7)
 * and the server-side source lookup behind `get_asset(region)` (14.4/14.5),
 * against a REAL PostgreSQL + pgvector instance:
 *
 *   - `ts_ident @@ to_tsquery('simple', …)` finds a unit whose identifier is
 *     ONLY in its `ts_ident` vector (not in vs_identifiers), including a value
 *     the simple parser splits (`ISO 9001:2015`, phrase match);
 *   - exact vs_identifiers hits and explicit identifiers join the same list;
 *   - the list is OPT-IN: a call without `identifierList` (v1 /search, legacy
 *     MCP) ranks exactly as dense+fts;
 *   - `lookupRevisionSourceSha256` reads `document.begin.source.sha256` from the
 *     revision's staged batch, scoped by tenant + collection + revision.
 *
 * Self-skips when TEST_POSTGRES_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { collectionTableName } from "../src/collection-ddl.js";
import { ensureRevisionTables } from "../src/revision-schema.js";
import { buildIdentifierText } from "../src/identifier.js";
import type { AccessScope } from "../src/access-scope.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `identtest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

/** A unit vector along axis 0 with a small per-row tilt, so dense order is stable. */
function proseVector(i: number): number[] {
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

describeIfPg("identifier RRF list + source lookup · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `identtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  async function insertUnit(unitId: string, content: string, vector: number[]): Promise<void> {
    await pool.query(
      `INSERT INTO "${table}"
         (tenant_id, reference, base_ref, is_latest, content, vector, ts_ident, metadata, unit_id, unit_type)
       VALUES ($1, $2, $3, TRUE, $4, $5::vector, to_tsvector('simple', $6), $7::jsonb, $8, 'chunk')`,
      [
        TENANT,
        `doc::${unitId}`,
        "doc",
        content,
        JSON.stringify(vector),
        buildIdentifierText(content),
        JSON.stringify({ unit_id: unitId, unit_type: "chunk" }),
        unitId,
      ],
    );
  }

  const search = (
    query: string,
    options?: { identifierList?: boolean; identifiers?: string[] },
  ) =>
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
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options,
    );

  const refs = (res: Awaited<ReturnType<typeof search>>): string[] => {
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
      await insertUnit(`prose-${i}`, `Allgemeiner Fließtext Nummer ${i} ohne Codes.`, proseVector(i));
    }
    // Identifier ONLY in ts_ident (no vs_identifiers row).
    await insertUnit("lex-we01a", "Die Maske WE-01/A dient der Anmeldung.", farVector(0));
    // A standard the simple parser splits at ':' (phrase match).
    await insertUnit("lex-iso", "Zertifiziert nach ISO 9001:2015.", farVector(1));
    // Only reachable through the vs_identifiers exact index.
    await insertUnit("exact-din", "Schweißnähte nach Norm.", farVector(2));
    await pool.query(
      `INSERT INTO vs_identifiers (tenant_id, collection, value_norm, unit_id, page, kind)
       VALUES ($1, $2, 'DINEN10902', 'exact-din', 3, 'standard')`,
      [TENANT, collection],
    );

    // Other suites create the shared revision tables concurrently; retry the
    // idempotent DDL on a transient deadlock / catalog race.
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
    await pool?.query(`DELETE FROM vs_identifiers WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pool?.query(`DELETE FROM vs_ingest_batches WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pool?.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pg?.close();
    await pool?.end();
  });

  it("without identifierList (v1 default) the identifier unit is not lifted", async () => {
    const top = refs(await search("Maske WE-01/A"));
    expect(top).not.toContain("doc::lex-we01a");
  });

  it("ts_ident lexical match lifts a unit that is not in vs_identifiers", async () => {
    const top = refs(await search("Maske WE-01/A", { identifierList: true }));
    expect(top[0]).toBe("doc::lex-we01a");
  });

  it("matches a separator-variant spelling (normalization on both sides)", async () => {
    const top = refs(await search("Maske WE01/A", { identifierList: true }));
    expect(top[0]).toBe("doc::lex-we01a");
  });

  it("phrase-matches a value the simple parser splits (ISO 9001:2015)", async () => {
    const top = refs(await search("Norm ISO 9001:2015", { identifierList: true }));
    expect(top[0]).toBe("doc::lex-iso");
  });

  it("exact vs_identifiers hits join the same list", async () => {
    const top = refs(await search("Norm DIN EN 1090-2", { identifierList: true }));
    expect(top[0]).toBe("doc::exact-din");
  });

  it("an explicit identifier resolves even when no recognizer class matches it", async () => {
    // "we 01 a" (lower-case, spaced) is not recognized in the text; passed explicitly.
    const plain = refs(await search("anmeldung", { identifierList: true }));
    expect(plain).not.toContain("doc::lex-we01a");
    const top = refs(await search("anmeldung", { identifierList: true, identifiers: ["we 01 a"] }));
    expect(top[0]).toBe("doc::lex-we01a");
  });

  it("an identifier from another tenant never matches (exact list is tenant-scoped)", async () => {
    const res = await pg.search(
      "DIN EN 1090-2", QUERY_VECTOR, 3, collection, serviceScope("other-tenant"),
      undefined, true, false, 0, 4, undefined, undefined, undefined, false,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { identifierList: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toHaveLength(0);
  });

  describe("lookupRevisionSourceSha256", () => {
    const SHA = "e".repeat(64);
    const REV = `rev-${Date.now()}`;

    beforeAll(async () => {
      await pool.query(
        `INSERT INTO vs_revisions (tenant_id, collection, revision_id, reference, status)
         VALUES ($1, $2, $3, 'doc', 'committed'), ($1, $2, $4, 'doc', 'committed'), ($1, $2, $5, 'doc', 'committed')`,
        [TENANT, collection, REV, `${REV}-bad`, `${REV}-nobegin`],
      );
      const begin = JSON.stringify({
        type: "document.begin",
        contract: "atf-extract/2.0.0",
        reference: "doc",
        source: { filename: "doc.pdf", mimeType: "application/pdf", bytes: 10, sha256: SHA },
        pipeline: { extractor: "test" },
      });
      const page = JSON.stringify({ type: "page", page: 1, blocks: [] });
      const bad = begin.replace(SHA, "../../etc/passwd");
      await pool.query(
        `INSERT INTO vs_ingest_batches (tenant_id, collection, revision_id, seq, status, digest, payload)
         VALUES ($1, $2, $3, 0, 'processed', 'd0', $4),
                ($1, $2, $3, 1, 'processed', 'd1', $5),
                ($1, $2, $6, 0, 'processed', 'd2', $7),
                ($1, $2, $8, 0, 'processed', 'd3', $5)`,
        [
          TENANT, collection, REV,
          Buffer.from(`${begin}\n${page}\n`),
          Buffer.from(`${page}\n`),
          `${REV}-bad`,
          Buffer.from(`${bad}\n`),
          `${REV}-nobegin`,
        ],
      );
    });

    it("returns the staged document.begin.source.sha256 of the revision", async () => {
      const res = await pg.lookupRevisionSourceSha256(collection, TENANT, REV);
      expect(res).toEqual({ ok: true, result: SHA });
    });

    it("is scoped by tenant, collection and revision", async () => {
      expect(await pg.lookupRevisionSourceSha256(collection, "other-tenant", REV)).toEqual({ ok: true, result: null });
      expect(await pg.lookupRevisionSourceSha256(`${collection}_x`, TENANT, REV)).toEqual({ ok: true, result: null });
      expect(await pg.lookupRevisionSourceSha256(collection, TENANT, "rev-unknown")).toEqual({ ok: true, result: null });
    });

    it("returns null for a malformed digest or a revision without document.begin", async () => {
      expect(await pg.lookupRevisionSourceSha256(collection, TENANT, `${REV}-bad`)).toEqual({ ok: true, result: null });
      expect(await pg.lookupRevisionSourceSha256(collection, TENANT, `${REV}-nobegin`)).toEqual({ ok: true, result: null });
    });
  });
});
