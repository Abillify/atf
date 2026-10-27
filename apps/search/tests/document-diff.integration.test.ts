// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * `document_diff` against a REAL PostgreSQL + pgvector instance (traceability):
 * two committed revisions of one document, the units loaded at an instant
 * inside each revision's visibility window through the same navigation reads
 * behind `get_pages` (`getOutline` + `getSectionUnits`, each with the temporal
 * `valid_at` rule), and the unit diff (added / removed / changed / unchanged).
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
import { buildDocumentDiff } from "../src/handlers/document-diff-v2.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `docdiff-${Date.now()}`;
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

const BASE_REF = "richtlinie/Richtlinie-2.pdf";

// A long reworded unit exercises the 300-char head excerpt on both sides.
const LONG_FILLER = "Vorwort und Begriffe. ".repeat(30);
const ANWENDUNG_HEAD = "1 Anwendung";
const ANWENDUNG_KEEP = "Anwendungstext bleibt unverändert.";
const ANWENDUNG_OLD = "Der alte Absatz der Anwendung.";
const ANWENDUNG_NEW = "Der neue Absatz der Anwendung.";
const ANTRAGSEINGANG_HEAD = "4 Antragseingang";
const ANTRAGSEINGANG_OLD = `Antragseingang Fassung 2024. ${LONG_FILLER}Prüfung bei Eingang.`;
const ANTRAGSEINGANG_NEW = `Antragseingang Fassung 2025. ${LONG_FILLER}Prüfung nach Erfassung.`;
const ALT_HEAD = "9 Altes Verfahren";
const ALT = "Das überholte Verfahren ist ersatzlos entfallen.";
const NEU_HEAD = "9 Neues Verfahren";
const NEU = "Das neue Verfahren ergänzt die Stichprobenprüfung.";

interface NavSeed {
  revision: string;
  unitId: string;
  unitType: string;
  sectionPath: string[];
  content: string;
  ordinal: number;
  created: string;
  latest: boolean;
  pageStart?: number;
}

describeIfPg("document_diff · units across two points in time · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `docdiff_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  /** Inserts one v2 nav unit (section or chunk) of a revision. */
  async function navUnit(seed: NavSeed): Promise<void> {
    const sectionId = seed.sectionPath.join("/");
    await pool.query(
      `INSERT INTO "${table}"
        (tenant_id, reference, base_ref, is_latest, content, vector, metadata,
         unit_id, unit_type, section_id, section_path, page_start, page_end,
         revision_id, document_id, created, ts_search, allowed_users, allowed_groups)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7::jsonb,$8,$9,$10,$11,$12,$12,$13,$14,$15::timestamptz,
         to_tsvector('simple', $5),'{}','{}')`,
      [
        TENANT,
        `${BASE_REF}#unit:${seed.unitId}`,
        BASE_REF,
        seed.latest,
        seed.content,
        JSON.stringify(zeroVector),
        JSON.stringify({ unit_type: seed.unitType, ordinal: seed.ordinal }),
        seed.unitId,
        seed.unitType,
        sectionId,
        seed.sectionPath,
        seed.pageStart ?? 0,
        seed.revision,
        BASE_REF,
        seed.created,
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

    // rev1 is valid from 2025-01-01, rev2 from 2025-06-01. Each section unit's
    // section_path equals its chunks' paths so the loader's prefix query finds
    // them. Section units carry the sentinel page 0; chunks a real page.
    const rev1 = "2025-01-01T10:00:00Z";
    const rev2 = "2025-06-01T10:00:00Z";
    await navUnit({ revision: "rev1", unitId: "s1a", unitType: "section", sectionPath: [ANWENDUNG_HEAD], content: ANWENDUNG_HEAD, ordinal: 0, created: rev1, latest: false });
    await navUnit({ revision: "rev1", unitId: "u1a1", unitType: "chunk", sectionPath: [ANWENDUNG_HEAD], content: ANWENDUNG_KEEP, ordinal: 0, created: rev1, latest: false, pageStart: 3 });
    await navUnit({ revision: "rev1", unitId: "u1a2", unitType: "chunk", sectionPath: [ANWENDUNG_HEAD], content: ANWENDUNG_OLD, ordinal: 1, created: rev1, latest: false, pageStart: 3 });
    await navUnit({ revision: "rev1", unitId: "s1w", unitType: "section", sectionPath: [ANTRAGSEINGANG_HEAD], content: ANTRAGSEINGANG_HEAD, ordinal: 0, created: rev1, latest: false });
    await navUnit({ revision: "rev1", unitId: "u1w1", unitType: "chunk", sectionPath: [ANTRAGSEINGANG_HEAD], content: ANTRAGSEINGANG_OLD, ordinal: 0, created: rev1, latest: false, pageStart: 7 });
    await navUnit({ revision: "rev1", unitId: "s1o", unitType: "section", sectionPath: [ALT_HEAD], content: ALT_HEAD, ordinal: 0, created: rev1, latest: false });
    await navUnit({ revision: "rev1", unitId: "u1o1", unitType: "chunk", sectionPath: [ALT_HEAD], content: ALT, ordinal: 0, created: rev1, latest: false, pageStart: 9 });

    await navUnit({ revision: "rev2", unitId: "s2a", unitType: "section", sectionPath: [ANWENDUNG_HEAD], content: ANWENDUNG_HEAD, ordinal: 0, created: rev2, latest: true });
    await navUnit({ revision: "rev2", unitId: "u2a1", unitType: "chunk", sectionPath: [ANWENDUNG_HEAD], content: ANWENDUNG_KEEP, ordinal: 0, created: rev2, latest: true, pageStart: 3 });
    await navUnit({ revision: "rev2", unitId: "u2a2", unitType: "chunk", sectionPath: [ANWENDUNG_HEAD], content: ANWENDUNG_NEW, ordinal: 1, created: rev2, latest: true, pageStart: 3 });
    await navUnit({ revision: "rev2", unitId: "s2w", unitType: "section", sectionPath: [ANTRAGSEINGANG_HEAD], content: ANTRAGSEINGANG_HEAD, ordinal: 0, created: rev2, latest: true });
    await navUnit({ revision: "rev2", unitId: "u2w1", unitType: "chunk", sectionPath: [ANTRAGSEINGANG_HEAD], content: ANTRAGSEINGANG_NEW, ordinal: 0, created: rev2, latest: true, pageStart: 7 });
    await navUnit({ revision: "rev2", unitId: "s2n", unitType: "section", sectionPath: [NEU_HEAD], content: NEU_HEAD, ordinal: 0, created: rev2, latest: true });
    await navUnit({ revision: "rev2", unitId: "u2n1", unitType: "chunk", sectionPath: [NEU_HEAD], content: NEU, ordinal: 0, created: rev2, latest: true, pageStart: 11 });
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

  it("diffs added / removed / changed / unchanged between the two instants", async () => {
    const payload = await buildDocumentDiff(
      pg,
      collection,
      serviceScope(),
      BASE_REF,
      "2025-03-01T00:00:00Z",
      "2025-07-01T00:00:00Z",
    );
    expect(payload.base_ref).toBe(BASE_REF);
    expect(payload.from).toBe("2025-03-01T00:00:00Z");
    expect(payload.to).toBe("2025-07-01T00:00:00Z");

    // The vanished section (heading + its chunk) is removed; the new section
    // (heading + its chunk) is added.
    expect(payload.removed.map((u) => u.section_id).sort()).toEqual([ALT_HEAD, ALT_HEAD]);
    expect(payload.added.map((u) => u.section_id).sort()).toEqual([NEU_HEAD, NEU_HEAD]);

    // Two reworded chunks: the second "1 Anwendung" chunk and the "4 Antragseingang" chunk.
    expect(payload.changed).toHaveLength(2);
    const keys = payload.changed.map((c) => c.key).sort();
    expect(keys.some((k) => k.includes(ANWENDUNG_HEAD))).toBe(true);
    expect(keys.some((k) => k.includes(ANTRAGSEINGANG_HEAD))).toBe(true);

    // Unchanged: the two section headings that persist and the kept chunk.
    expect(payload.unchanged_count).toBe(3);
  });

  it("keeps excerpts within 300 chars and marks the cut", async () => {
    const payload = await buildDocumentDiff(
      pg,
      collection,
      serviceScope(),
      BASE_REF,
      "2025-03-01T00:00:00Z",
      "2025-07-01T00:00:00Z",
    );
    const antragseingang = payload.changed.find((c) => c.key.includes(ANTRAGSEINGANG_HEAD));
    if (!antragseingang) {
      throw new Error("Antragseingang unit missing from changed bucket");
    }
    expect(antragseingang.before_excerpt.length).toBeLessThanOrEqual(300);
    expect(antragseingang.after_excerpt.length).toBeLessThanOrEqual(300);
    expect(antragseingang.before_excerpt.endsWith("…")).toBe(true);
    expect(antragseingang.after_excerpt.startsWith("Antragseingang Fassung 2025.")).toBe(true);
    for (const u of [...payload.added, ...payload.removed]) {
      expect(u.excerpt.length).toBeLessThanOrEqual(300);
    }
  });

  it("reports everything unchanged when both instants see the same revision", async () => {
    const payload = await buildDocumentDiff(
      pg,
      collection,
      serviceScope(),
      BASE_REF,
      "2025-07-01T00:00:00Z",
      "2025-09-01T00:00:00Z",
    );
    expect(payload.added).toEqual([]);
    expect(payload.removed).toEqual([]);
    expect(payload.changed).toEqual([]);
    // rev2 has 7 units (3 sections + 4 chunks).
    expect(payload.unchanged_count).toBe(7);
  });

  it("loads the whole document in one read and reports a capped read as truncated", async () => {
    const full = await pg.getDocumentUnits(collection, serviceScope(), BASE_REF, { validAt: "2025-07-01T00:00:00Z" });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.result.truncated).toBe(false);
    expect(full.result.units.map((u) => u.unit_id)).toHaveLength(7);
    const capped = await pg.getDocumentUnits(collection, serviceScope(), BASE_REF, {
      validAt: "2025-07-01T00:00:00Z",
      limit: 3,
    });
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.result.truncated).toBe(true);
    expect(capped.result.units).toHaveLength(3);
    // The capped read is the head of the full read (same reading order).
    expect(capped.result.units.map((u) => u.unit_id)).toEqual(
      full.result.units.slice(0, 3).map((u) => u.unit_id),
    );
  });
});
