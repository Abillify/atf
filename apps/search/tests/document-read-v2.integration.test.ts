// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The whole-document reads (`get_document`, `get_documents`, `get_summary`,
 * `get_summaries`, the summary backfill) over v2 units against a REAL
 * PostgreSQL + pgvector instance.
 *
 * v2 units carry no chunk JSON and share their table with Extract's summary
 * units (`section`/`page`/`document`). These reads used to merge every row in
 * insertion order — summaries read back as the original, tables twice, figures
 * before the text — and to find neither title nor summary.
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

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `docread-${Date.now()}`;
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

describeIfPg("v2 whole-document reads · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `docread_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  async function insertUnit(row: {
    unitId: string;
    baseRef: string;
    content: string;
    unitType: string;
    page: number;
    blockIds: string[];
    ordinal?: number;
    meta?: Record<string, unknown>;
    title?: string;
  }): Promise<void> {
    const meta = {
      unit_type: row.unitType,
      page_start: row.page,
      page_end: row.page,
      ...(row.ordinal !== undefined ? { ordinal: row.ordinal } : {}),
      ...(row.meta ?? {}),
    };
    await pool.query(
      `INSERT INTO "${table}"
        (tenant_id, reference, base_ref, is_latest, content, vector, metadata,
         unit_id, unit_type, page_start, page_end, block_ids, title,
         allowed_users, allowed_groups)
       VALUES ($1,$2,$3,TRUE,$4,$5::vector,$6::jsonb,$7,$8,$9,$9,$10::text[],$11,'{}','{}')`,
      [
        TENANT,
        `${row.baseRef}#unit:${row.unitId}`,
        row.baseRef,
        row.content,
        JSON.stringify(zeroVector),
        JSON.stringify(meta),
        row.unitId,
        row.unitType,
        row.page,
        row.blockIds,
        row.title ?? null,
      ],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({ connectionString: CONNECTION ?? "", logger, statsFlushIntervalMs: 3_600_000 });
    const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);

    // Inserted deliberately OUT of reading order, the way parallel batches and
    // the trailing document.end batch land: summaries first, page 2 before
    // page 1, the figure and table before the text they sit between.
    const spec = "Lastenheft/WE.docx";
    await insertUnit({ unitId: "doc", baseRef: spec, content: "Dokument-Summary: Wareneingang", unitType: "document", page: 1, blockIds: [spec], title: "Pflichtenheft Wareneingang" });
    await insertUnit({ unitId: "sec", baseRef: spec, content: "Abschnitts-Summary", unitType: "section", page: 1, blockIds: ["1 Einleitung"] });
    await insertUnit({ unitId: "pg1", baseRef: spec, content: "Seiten-Summary 1", unitType: "page", page: 1, blockIds: ["page:1"] });
    await insertUnit({ unitId: "p2", baseRef: spec, content: "Text auf Seite zwei.", unitType: "chunk", page: 2, blockIds: ["p2-b1"], ordinal: 0, title: "Pflichtenheft Wareneingang" });
    await insertUnit({
      unitId: "tbl",
      baseRef: spec,
      content: "Feld | Pflicht\nLieferant | ja\n\nFeld: Lieferant; Pflicht: ja",
      unitType: "table",
      page: 1,
      blockIds: ["p1-b3"],
      ordinal: 0,
      meta: { display_len: "Feld | Pflicht\nLieferant | ja".length, table_id: "t1" },
      title: "Pflichtenheft Wareneingang",
    });
    await insertUnit({
      unitId: "fig",
      baseRef: spec,
      content: "Abbildung 1: Maske WE-01",
      unitType: "figure",
      page: 1,
      blockIds: ["p1-b2"],
      ordinal: 0,
      meta: { figure_id: "fig-1", figure_kind: "ui_mask", asset_id: "a".repeat(64) },
      title: "Pflichtenheft Wareneingang",
    });
    await insertUnit({ unitId: "p1b", baseRef: spec, content: "Zweiter Teil von Block 1.", unitType: "chunk", page: 1, blockIds: ["p1-b1"], ordinal: 1, title: "Pflichtenheft Wareneingang" });
    await insertUnit({ unitId: "p1a", baseRef: spec, content: "Erster Teil von Block 1.", unitType: "chunk", page: 1, blockIds: ["p1-b1"], ordinal: 0, title: "Pflichtenheft Wareneingang" });

    // A v2 document the document pass produced no summary for.
    await insertUnit({ unitId: "n1", baseRef: "nosummary.pdf", content: "Nur Text.", unitType: "chunk", page: 1, blockIds: ["p1-b1"], ordinal: 0 });
    await insertUnit({ unitId: "n2", baseRef: "nosummary.pdf", content: "Mehr Text.", unitType: "chunk", page: 1, blockIds: ["p1-b2"], ordinal: 0 });
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
    await pg?.close();
    await pool?.end();
  });

  const expectedBody = [
    "Erster Teil von Block 1.",
    "Zweiter Teil von Block 1.",
    `[Abbildung fig-1 · ui_mask · asset_id=${"a".repeat(64)}]\nAbbildung 1: Maske WE-01`,
    "Feld | Pflicht\nLieferant | ja",
    "Text auf Seite zwei.",
  ].join("\n\n");

  it("get_document reads only the body units, in reading order, tables once", async () => {
    const res = await pg.getDocument(collection, serviceScope(), "Lastenheft/WE.docx");
    expect(res.ok).toBe(true);
    if (!res.ok || res.result === null) throw new Error("no document");
    const doc = res.result;
    expect(doc.content).toBe(expectedBody);
    expect(doc.content).not.toContain("Summary");
    expect(doc.content).not.toContain("Feld: Lieferant");
    expect(doc.chunks).toBe(5);
    expect(doc.title).toBe("Pflichtenheft Wareneingang");
  });

  it("get_document evidence spans carry the unit and its page", async () => {
    const res = await pg.getDocument(collection, serviceScope(), "Lastenheft/WE.docx");
    if (!res.ok || res.result === null) throw new Error("no document");
    const spans = res.result.evidence_spans ?? [];
    expect(spans.map((s) => s.unit_id)).toEqual(["p1a", "p1b", "fig", "tbl", "p2"]);
    const last = spans[spans.length - 1];
    if (last === undefined) throw new Error("no evidence span");
    expect(last.page_start).toBe(2);
    expect(res.result.content.slice(last.window_start, last.window_end)).toBe("Text auf Seite zwei.");
  });

  it("get_documents reassembles v2 documents the same way", async () => {
    const res = await pg.getDocumentsByPrefix(collection, serviceScope(), {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const spec = res.result.documents.find((d) => d.reference === "Lastenheft/WE.docx");
    expect(spec?.content).toBe(expectedBody);
  });

  it("get_summaries returns the document unit's summary and the title", async () => {
    const res = await pg.getSummaries(collection, serviceScope(), {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const spec = res.result.summaries.find((s) => s.reference === "Lastenheft/WE.docx");
    expect(spec?.summary).toBe("Dokument-Summary: Wareneingang");
    expect(spec?.title).toBe("Pflichtenheft Wareneingang");
    expect(spec?.isSummary).toBe(true);
    const single = await pg.getSummary(collection, serviceScope(), "Lastenheft/WE.docx");
    expect(single.ok && single.result?.summary).toBe("Dokument-Summary: Wareneingang");
  });

  it("the summary backfill lists a v2 document once and writes one row", async () => {
    const missing = await pg.listDocumentsMissingSummary(collection, serviceScope());
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    // The spec has a document unit; the other document appears exactly once.
    expect(missing.result).toEqual(["nosummary.pdf"]);

    const set = await pg.setDocumentSummary(collection, "nosummary.pdf", "Backfill-Summary", serviceScope());
    expect(set.ok && set.result.updated).toBe(1);

    const summaries = await pg.getSummaries(collection, serviceScope(), {});
    if (!summaries.ok) throw new Error("summaries failed");
    expect(summaries.result.summaries.find((s) => s.reference === "nosummary.pdf")?.summary).toBe("Backfill-Summary");
    const after = await pg.listDocumentsMissingSummary(collection, serviceScope());
    expect(after.ok && after.result).toEqual([]);
  });
});

describeIfPg("v2 whole-document reads at a point in time (valid_at) · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `docver_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);
  const tenant = `${TENANT}-ver`;
  const ref = "Lastenheft/Versioniert.docx";
  const scope = (): AccessScope => ({ ...serviceScope(), tenantId: tenant });

  async function unit(revision: string, unitId: string, type: string, page: number, block: string, content: string, created: string, latest: boolean): Promise<void> {
    await pool.query(
      `INSERT INTO "${table}"
        (tenant_id, reference, base_ref, is_latest, content, vector, metadata, unit_id, unit_type,
         page_start, page_end, block_ids, revision_id, document_id, created, allowed_users, allowed_groups)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7::jsonb,$8,$9,$10,$10,$11::text[],$12,$3,$13::timestamptz,'{}','{}')`,
      [tenant, `${ref}#unit:${unitId}`, ref, latest, content, JSON.stringify(zeroVector),
       JSON.stringify({ unit_type: type, ordinal: 0 }), unitId, type, page, [block], revision, created],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({ connectionString: CONNECTION ?? "", logger, statsFlushIntervalMs: 3_600_000 });
    expect((await pg.ensureCollection(collection, VECTOR_SIZE)).ok).toBe(true);
    const client = await pool.connect();
    try {
      // skipIfCurrent: the full DDL takes AccessExclusive locks on the live
      // revision tables and deadlocks against the suites running in parallel.
      await ensureRevisionSchema(client, { skipIfCurrent: true });
    } finally {
      client.release();
    }
    // rev1 (superseded), rev2 (current), rev3 (still being ingested).
    for (const [id, status] of [["rev1", "superseded"], ["rev2", "committed"], ["rev3", "staging"]] as const) {
      await pool.query(
        `INSERT INTO vs_revisions (tenant_id, collection, revision_id, reference, status) VALUES ($1,$2,$3,$4,$5)`,
        [tenant, collection, id, ref, status],
      );
    }
    await pool.query(
      `INSERT INTO vs_document_revisions (tenant_id, collection, reference, current_revision_id) VALUES ($1,$2,$3,'rev2')`,
      [tenant, collection, ref],
    );
    // Units of one revision are created a few seconds apart, like real batches.
    await unit("rev1", "r1a", "chunk", 1, "p1-b1", "Version 1, Seite 1.", "2025-01-01T10:00:00Z", false);
    await unit("rev1", "r1b", "chunk", 2, "p2-b1", "Version 1, Seite 2.", "2025-01-01T10:00:07Z", false);
    await unit("rev1", "r1d", "document", 1, ref, "Summary Version 1", "2025-01-01T10:00:09Z", false);
    await unit("rev2", "r2a", "chunk", 1, "p1-b1", "Version 2, Seite 1.", "2025-06-01T10:00:00Z", true);
    await unit("rev2", "r2b", "chunk", 2, "p2-b1", "Version 2, Seite 2.", "2025-06-01T10:00:05Z", true);
    await unit("rev2", "r2d", "document", 1, ref, "Summary Version 2", "2025-06-01T10:00:08Z", true);
    await unit("rev3", "r3a", "chunk", 1, "p1-b1", "Version 3 (unfertig).", "2025-07-01T10:00:00Z", false);
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
    await pool?.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [tenant]).catch(() => {});
    await pool?.query(`DELETE FROM vs_document_revisions WHERE tenant_id = $1`, [tenant]).catch(() => {});
    await pg?.close();
    await pool?.end();
  });

  async function text(validAt?: string): Promise<string | undefined> {
    const res = await pg.getDocument(collection, scope(), ref, validAt !== undefined ? { validAt } : undefined);
    if (!res.ok) throw new Error(res.error.message);
    return res.result?.content;
  }

  it("reads the current revision by default", async () => {
    expect(await text()).toBe("Version 2, Seite 1.\n\nVersion 2, Seite 2.");
  });

  it("reads the WHOLE revision valid at the instant, not one unit of it", async () => {
    expect(await text("2025-03-01T00:00:00Z")).toBe("Version 1, Seite 1.\n\nVersion 1, Seite 2.");
  });

  it("never reads a revision that is not committed yet", async () => {
    expect(await text("2025-08-01T00:00:00Z")).toBe("Version 2, Seite 1.\n\nVersion 2, Seite 2.");
  });

  it("returns the summary of the version valid at the instant", async () => {
    const res = await pg.getSummary(collection, scope(), ref, { validAt: "2025-03-01T00:00:00Z" });
    expect(res.ok && res.result?.summary).toBe("Summary Version 1");
    const all = await pg.getSummaries(collection, scope(), { validAt: "2025-03-01T00:00:00Z" });
    expect(all.ok && all.result.summaries.map((s) => s.summary)).toEqual(["Summary Version 1"]);
  });
});
