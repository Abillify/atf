// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `POST /v2/citations/check` against a REAL PostgreSQL + pgvector instance
 * (task T-301): cited chunks in a superseded and in the current revision, the
 * content-hash carry-over, a document whose only revision was aborted, an
 * unknown id, and a foreign principal whose ACL hides everything.
 *
 * Self-skips when TEST_POSTGRES_URL is unset.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { collectionTableName } from "../src/collection-ddl.js";
import type { AccessScope } from "../src/access-scope.js";
import { ensureRevisionSchema } from "../src/revision-schema.js";
import { buildCitationsCheck } from "../src/handlers/citations-check-v2.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `citcheck-${Date.now()}`;
const logger = pino({ level: "silent" });
const zeroVector = new Array<number>(VECTOR_SIZE).fill(0);

// "Today" for the check: after both revisions were written.
const NOW = new Date("2026-01-15T00:00:00Z");

const REV1 = "2025-01-01T10:00:00Z";
const REV2 = "2025-06-01T10:00:00Z";

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

function viewerScope(): AccessScope {
  return {
    principal: { userId: "viewer", userGroups: [], scopes: [], source: "asserted" },
    userId: "viewer",
    userGroups: [],
    tenantId: TENANT,
    scopes: [],
  };
}

interface Seed {
  baseRef: string;
  revision: string | null;
  content: string;
  created: string;
  latest: boolean;
  /** v2 identity column. */
  unitId?: string;
  /** v1 identity: the chunk jsonb's chunk_id. */
  chunkId?: string;
  /** When set, the row is visible to this user only. */
  allowedUsers?: string[];
}

describeIfPg("citations_check · cited chunks vs the current revision · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `citcheck_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  async function seedRow(seed: Seed): Promise<void> {
    await pool.query(
      `INSERT INTO "${table}"
        (tenant_id, reference, base_ref, is_latest, content, vector, metadata,
         unit_id, chunk, revision_id, document_id, created,
         ts_search, allowed_users, allowed_groups)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7::jsonb,$8,$9::jsonb,$10,$11,$12::timestamptz,
         to_tsvector('simple', $5),$13,'{}')`,
      [
        TENANT,
        `${seed.baseRef}#${seed.unitId ?? seed.chunkId ?? "row"}`,
        seed.baseRef,
        seed.latest,
        seed.content,
        JSON.stringify(zeroVector),
        JSON.stringify({ unit_type: "chunk" }),
        seed.unitId ?? null,
        seed.chunkId === undefined ? null : JSON.stringify({ chunk_id: seed.chunkId }),
        seed.revision,
        seed.baseRef,
        seed.created,
        seed.allowedUsers ?? [],
      ],
    );
  }

  async function revision(revisionId: string, reference: string, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO vs_revisions (tenant_id, collection, revision_id, reference, status) VALUES ($1,$2,$3,$4,$5)`,
      [TENANT, collection, revisionId, reference, status],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    expect((await pg.ensureCollection(collection, VECTOR_SIZE)).ok).toBe(true);
    const client = await pool.connect();
    try {
      await ensureRevisionSchema(client, { skipIfCurrent: true });
    } finally {
      client.release();
    }

    // current.pdf — the cited v2 unit lives in the CURRENT revision.
    await revision("cur-rev1", "cites/current.pdf", "superseded");
    await revision("cur-rev2", "cites/current.pdf", "committed");
    await pool.query(
      `INSERT INTO vs_document_revisions (tenant_id, collection, reference, current_revision_id) VALUES ($1,$2,$3,'cur-rev2')`,
      [TENANT, collection, "cites/current.pdf"],
    );
    await seedRow({ baseRef: "cites/current.pdf", revision: "cur-rev1", content: "Fassung eins.", created: REV1, latest: false, unitId: "cur-u-old" });
    await seedRow({ baseRef: "cites/current.pdf", revision: "cur-rev2", content: "Fassung zwei.", created: REV2, latest: true, unitId: "cur-u-new" });

    // carried.pdf — the cited chunk is in the superseded revision, but its
    // exact content was carried over into the current revision verbatim.
    const carried = "Dieser Absatz wurde wortgleich übernommen.";
    await revision("car-rev1", "cites/carried.pdf", "superseded");
    await revision("car-rev2", "cites/carried.pdf", "committed");
    await pool.query(
      `INSERT INTO vs_document_revisions (tenant_id, collection, reference, current_revision_id) VALUES ($1,$2,$3,'car-rev2')`,
      [TENANT, collection, "cites/carried.pdf"],
    );
    await seedRow({ baseRef: "cites/carried.pdf", revision: "car-rev1", content: carried, created: REV1, latest: false, unitId: "car-u-old" });
    await seedRow({ baseRef: "cites/carried.pdf", revision: "car-rev2", content: carried, created: REV2, latest: true, unitId: "car-u-new" });
    await seedRow({ baseRef: "cites/carried.pdf", revision: "car-rev2", content: "Ein neuer Absatz.", created: REV2, latest: true, unitId: "car-u-extra" });

    // changed.pdf — the cited chunk is in the superseded revision and its
    // content is gone from the current revision.
    await revision("chg-rev1", "cites/changed.pdf", "superseded");
    await revision("chg-rev2", "cites/changed.pdf", "committed");
    await pool.query(
      `INSERT INTO vs_document_revisions (tenant_id, collection, reference, current_revision_id) VALUES ($1,$2,$3,'chg-rev2')`,
      [TENANT, collection, "cites/changed.pdf"],
    );
    await seedRow({ baseRef: "cites/changed.pdf", revision: "chg-rev1", content: "Alter Prüfschritt.", created: REV1, latest: false, unitId: "chg-u-old" });
    await seedRow({ baseRef: "cites/changed.pdf", revision: "chg-rev2", content: "Neuer Prüfschritt.", created: REV2, latest: true, unitId: "chg-u-new" });

    // gone.pdf — its only revision was aborted, so nothing is visible today.
    await revision("gone-rev", "cites/gone.pdf", "aborted");
    await seedRow({ baseRef: "cites/gone.pdf", revision: "gone-rev", content: "Nie committet.", created: REV1, latest: false, unitId: "gone-u" });

    // legacy.pdf — a v1 row: identity in the chunk jsonb, no revision at all.
    await seedRow({ baseRef: "cites/legacy.pdf", revision: null, content: "Legacy-Absatz.", created: REV1, latest: true, chunkId: "legacy-c1" });

    // private.pdf — visible to "owner" only; a foreign viewer sees nothing.
    await revision("priv-rev", "cites/private.pdf", "committed");
    await pool.query(
      `INSERT INTO vs_document_revisions (tenant_id, collection, reference, current_revision_id) VALUES ($1,$2,$3,'priv-rev')`,
      [TENANT, collection, "cites/private.pdf"],
    );
    await seedRow({ baseRef: "cites/private.pdf", revision: "priv-rev", content: "Nur für den Besitzer.", created: REV2, latest: true, unitId: "priv-u", allowedUsers: ["owner"] });
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    await pool.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]);
    await pool.query(`DELETE FROM vs_document_revisions WHERE tenant_id = $1`, [TENANT]);
    await pg.close();
    await pool.end();
  });

  it("classifies current, carried, changed, removed and unknown in input order", async () => {
    const payload = await buildCitationsCheck(pg, collection, serviceScope(), [
      { base_ref: "cites/current.pdf", chunk_id: "cur-u-new" },
      { base_ref: "cites/carried.pdf", chunk_id: "car-u-old" },
      { base_ref: "cites/changed.pdf", chunk_id: "chg-u-old" },
      { base_ref: "cites/gone.pdf", chunk_id: "gone-u" },
      { base_ref: "cites/current.pdf", chunk_id: "no-such-chunk" },
    ], NOW);
    expect(payload.checked_at).toBe("2026-01-15T00:00:00.000Z");
    expect(payload.results.map((r) => [r.base_ref, r.chunk_id, r.status])).toEqual([
      ["cites/current.pdf", "cur-u-new", "current"],
      ["cites/carried.pdf", "car-u-old", "carried"],
      ["cites/changed.pdf", "chg-u-old", "changed"],
      ["cites/gone.pdf", "gone-u", "removed"],
      ["cites/current.pdf", "no-such-chunk", "unknown"],
    ]);
    expect(payload.results[0].current_revision).toBe("cur-rev2");
    expect(payload.results[3].current_revision).toBeUndefined();
  });

  it("resolves a v1 chunk_id from the chunk jsonb of an unversioned document", async () => {
    const payload = await buildCitationsCheck(pg, collection, serviceScope(), [
      { base_ref: "cites/legacy.pdf", chunk_id: "legacy-c1" },
    ], NOW);
    expect(payload.results[0].status).toBe("current");
    expect(payload.results[0].current_revision).toBeUndefined();
  });

  it("reports unknown for a chunk the caller's ACL hides", async () => {
    const payload = await buildCitationsCheck(pg, collection, viewerScope(), [
      { base_ref: "cites/private.pdf", chunk_id: "priv-u" },
    ], NOW);
    expect(payload.results[0].status).toBe("unknown");
  });

  it("keeps a document's chunks distinguishable in one batch", async () => {
    const payload = await buildCitationsCheck(pg, collection, serviceScope(), [
      { base_ref: "cites/carried.pdf", chunk_id: "car-u-new" },
      { base_ref: "cites/carried.pdf", chunk_id: "car-u-old" },
      { base_ref: "cites/changed.pdf", chunk_id: "chg-u-new" },
    ], NOW);
    expect(payload.results.map((r) => r.status)).toEqual(["current", "carried", "current"]);
  });
});
