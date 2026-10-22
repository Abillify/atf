// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The `trace` tool's lookup + diff against a REAL PostgreSQL + pgvector
 * instance (Epic E7, K1): two committed revisions of one document, the
 * identifier looked up at an instant inside each revision's visibility window
 * (FTS-only search with the temporal `valid_at` rule), and the occurrence diff
 * (added / removed / changed / unchanged).
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
import {
  centeredExcerpt,
  contentHash,
  traceIdentifier,
  type TraceOccurrence,
} from "../src/traceability.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `trace-${Date.now()}`;
const logger = pino({ level: "silent" });
const zeroVector = new Array<number>(VECTOR_SIZE).fill(0);

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

const BASE_REF = "richtlinie/Richtlinie-1.pdf";
const IDENTIFIER = "WE-01/A";

// The identifier appears in four sections across the two revisions: one
// unchanged, one reworded (long enough to exercise the 300-char excerpt),
// one only in rev1 (removed), one only in rev2 (added).
const ANWENDUNG = "Diese Richtlinie gilt für alle Standorte; Bezug ist WE-01/A.";
const WARENEINGANG_REV1 = `Wareneingang Fassung 2024. ${"Vorwort und Begriffe. ".repeat(30)}Gemäß WE-01/A erfolgt die Prüfung direkt bei Anlieferung.`;
const WARENEINGANG_REV2 = `Wareneingang Fassung 2025. ${"Vorwort und Begriffe. ".repeat(30)}Gemäß WE-01/A erfolgt die Prüfung nach der Entladung.`;
const ALT = "Das überholte Verfahren zu WE-01/A ist ersatzlos entfallen.";
const NEU = "Das neue Verfahren ergänzt WE-01/A um die Stichprobenprüfung.";

describeIfPg("trace tool · identifier across two points in time · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `trace_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  /** Inserts one unit of a revision with the lexical index and chunk JSON. */
  async function unit(
    revision: string,
    unitId: string,
    section: string[],
    content: string,
    created: string,
    latest: boolean,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO "${table}"
        (tenant_id, reference, base_ref, is_latest, content, vector, metadata,
         unit_id, unit_type, page_start, revision_id, document_id, created,
         ts_search, chunk, allowed_users, allowed_groups)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7::jsonb,$8,'paragraph',7,$9,$10,$11::timestamptz,
         to_tsvector('simple', $5),$12::jsonb,'{}','{}')`,
      [
        TENANT,
        `${BASE_REF}#unit:${unitId}`,
        BASE_REF,
        latest,
        content,
        JSON.stringify(zeroVector),
        JSON.stringify({ unit_type: "paragraph" }),
        unitId,
        revision,
        BASE_REF,
        created,
        JSON.stringify({ root_document_id: BASE_REF, section_path: section, page_start: 3 }),
      ],
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
      // skipIfCurrent: the full DDL takes AccessExclusive locks on the live
      // revision tables and deadlocks against the suites running in parallel.
      await ensureRevisionSchema(client, { skipIfCurrent: true });
    } finally {
      client.release();
    }
    for (const [id, status] of [
      ["rev1", "superseded"],
      ["rev2", "committed"],
    ] as const) {
      await pool.query(
        `INSERT INTO vs_revisions (tenant_id, collection, revision_id, reference, status) VALUES ($1,$2,$3,$4,$5)`,
        [TENANT, collection, id, BASE_REF, status],
      );
    }
    await pool.query(
      `INSERT INTO vs_document_revisions (tenant_id, collection, reference, current_revision_id) VALUES ($1,$2,$3,'rev2')`,
      [TENANT, collection, BASE_REF],
    );
    // rev1 is valid from 2025-01-01, rev2 from 2025-06-01.
    await unit("rev1", "u1a", ["1 Anwendungsbereich"], ANWENDUNG, "2025-01-01T10:00:00Z", false);
    await unit("rev1", "u1b", ["4 Wareneingang"], WARENEINGANG_REV1, "2025-01-01T10:00:03Z", false);
    await unit("rev1", "u1c", ["9 Altes Verfahren"], ALT, "2025-01-01T10:00:06Z", false);
    await unit("rev2", "u2a", ["1 Anwendungsbereich"], ANWENDUNG, "2025-06-01T10:00:00Z", true);
    await unit("rev2", "u2b", ["4 Wareneingang"], WARENEINGANG_REV2, "2025-06-01T10:00:04Z", true);
    await unit("rev2", "u2c", ["9 Neues Verfahren"], NEU, "2025-06-01T10:00:08Z", true);
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
    await pool?.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pool
      ?.query(`DELETE FROM vs_document_revisions WHERE tenant_id = $1`, [TENANT])
      .catch(() => {});
    await pg?.close();
    await pool?.end();
  });

  /** The handler's lookup: FTS-only search at one instant, shaped into occurrences. */
  async function lookupAt(validAt: string): Promise<TraceOccurrence[]> {
    const res = await pg.search(
      IDENTIFIER,
      [],
      50,
      collection,
      serviceScope(),
      undefined,
      false,
      false,
      0,
      4,
      undefined,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      validAt,
    );
    if (!res.ok) throw new Error(res.error.message);
    return res.result.map((hit) => {
      const sectionPath = hit.evidence?.section_path;
      return {
        base_ref: hit.base_ref ?? hit.reference,
        reference: hit.reference,
        ...(sectionPath !== undefined && sectionPath.length > 0
          ? { section: sectionPath.join(" > ") }
          : {}),
        ...(hit.evidence?.page_start !== undefined
          ? { page_start: hit.evidence.page_start }
          : {}),
        excerpt: centeredExcerpt(hit.content, IDENTIFIER),
        content_hash: contentHash(hit.content),
      };
    });
  }

  it("finds only the revision valid at each instant", async () => {
    const a = await lookupAt("2025-03-01T00:00:00Z");
    const b = await lookupAt("2025-07-01T00:00:00Z");
    expect(a.map((o) => o.section).sort()).toEqual([
      "1 Anwendungsbereich",
      "4 Wareneingang",
      "9 Altes Verfahren",
    ]);
    expect(b.map((o) => o.section).sort()).toEqual([
      "1 Anwendungsbereich",
      "4 Wareneingang",
      "9 Neues Verfahren",
    ]);
    for (const o of [...a, ...b]) {
      expect(o.base_ref).toBe(BASE_REF);
      expect(o.page_start).toBe(3);
    }
  });

  it("diffs added / removed / changed / unchanged between the two instants", async () => {
    const diff = await traceIdentifier(
      {
        identifier: IDENTIFIER,
        valid_at_a: "2025-03-01T00:00:00Z",
        valid_at_b: "2025-07-01T00:00:00Z",
        limit: 50,
      },
      async (_id, validAt, _limit) => lookupAt(validAt),
    );
    expect(diff.removed.map((o) => o.section)).toEqual(["9 Altes Verfahren"]);
    expect(diff.added.map((o) => o.section)).toEqual(["9 Neues Verfahren"]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.key).toBe(`${BASE_REF}\u00004 Wareneingang`);
    expect(diff.changed[0]?.a.content_hash).not.toBe(diff.changed[0]?.b.content_hash);
    expect(diff.unchanged_count).toBe(1);
  });

  it("keeps excerpts within 300 chars centred on the identifier", async () => {
    const b = await lookupAt("2025-07-01T00:00:00Z");
    const long = b.find((o) => o.section === "4 Wareneingang");
    expect(long).toBeDefined();
    for (const o of b) {
      expect(o.excerpt.length).toBeLessThanOrEqual(300);
      expect(o.excerpt.toLowerCase()).toContain("we-01/a");
    }
    // The reworded section is truncated and centred on the hit.
    expect(long?.excerpt.startsWith("…")).toBe(true);
  });

  it("reports everything unchanged when both instants see the same revision", async () => {
    const diff = await traceIdentifier(
      {
        identifier: IDENTIFIER,
        valid_at_a: "2025-07-01T00:00:00Z",
        valid_at_b: "2025-09-01T00:00:00Z",
        limit: 50,
      },
      async (_id, validAt, _limit) => lookupAt(validAt),
    );
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged_count).toBe(3);
  });
});
