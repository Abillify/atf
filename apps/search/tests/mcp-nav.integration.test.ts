// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the v2 navigation query methods against a
 * REAL PostgreSQL + pgvector instance. They verify the SQL-level behaviour the
 * handler tests cannot: the outline/section/page/context/table/identifier
 * reads over the real indexed unit columns + vs_identifiers, all under the
 * tenant/ACL/current-revision gates (a restricted unit never leaks, a foreign
 * document never bleeds in).
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites).
 *
 *   TEST_POSTGRES_URL=postgres://user:pw@localhost:5432/db npx vitest run
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { collectionTableName, ensureIdentifiersTable } from "../src/collection-ddl.js";
import type { AccessScope } from "../src/access-scope.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `navtest-${Date.now()}`;
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

function userScope(userId: string, userGroups: string[] = []): AccessScope {
  return {
    principal: { userId, userGroups, scopes: [], source: "asserted" },
    userId,
    userGroups,
    tenantId: TENANT,
    scopes: [],
    service: false,
  };
}

describeIfPg("v2 navigation reads · real postgres (task 3.9)", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `navtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  async function insertUnit(row: {
    unitId: string;
    baseRef: string;
    content: string;
    unitType: string;
    sectionId?: string | null;
    sectionPath?: string[] | null;
    pageStart?: number | null;
    pageEnd?: number | null;
    figureKind?: string | null;
    figureId?: string | null;
    assetId?: string | null;
    tableId?: string | null;
    prevUnitId?: string | null;
    nextUnitId?: string | null;
    figureRefs?: string[] | null;
    allowedUsers?: string[];
  }): Promise<void> {
    const meta: Record<string, unknown> = {
      unit_id: row.unitId,
      unit_type: row.unitType,
      ...(row.sectionId ? { section_id: row.sectionId } : {}),
      ...(row.sectionPath ? { section_path: row.sectionPath } : {}),
      ...(row.figureId ? { figure_id: row.figureId } : {}),
      ...(row.assetId ? { asset_id: row.assetId } : {}),
      ...(row.figureRefs ? { figure_refs: row.figureRefs } : {}),
    };
    await pool.query(
      `INSERT INTO "${table}"
        (tenant_id, reference, base_ref, is_latest, content, vector, metadata,
         unit_id, unit_type, section_id, section_path, page_start, page_end,
         figure_kind, table_id, prev_unit_id, next_unit_id, figure_refs,
         allowed_users, allowed_groups)
       VALUES ($1,$2,$3,TRUE,$4,$5::vector,$6::jsonb,$7,$8,$9,$10::text[],$11,$12,
               $13,$14,$15,$16,$17::text[],$18::text[],$19::text[])`,
      [
        TENANT,
        `${row.baseRef}::${row.unitId}`,
        row.baseRef,
        row.content,
        JSON.stringify(zeroVector),
        JSON.stringify(meta),
        row.unitId,
        row.unitType,
        row.sectionId ?? null,
        row.sectionPath ?? null,
        row.pageStart ?? null,
        row.pageEnd ?? null,
        row.figureKind ?? null,
        row.tableId ?? null,
        row.prevUnitId ?? null,
        row.nextUnitId ?? null,
        row.figureRefs ?? null,
        row.allowedUsers ?? [],
        [],
      ],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({ connectionString: CONNECTION ?? "", logger, statsFlushIntervalMs: 3_600_000 });
    const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);
    const client = await pool.connect();
    try {
      await ensureIdentifiersTable(client);
    } finally {
      client.release();
    }

    // Two sections (outline).
    await insertUnit({ unitId: "s1", baseRef: "docA", content: "1 Einleitung", unitType: "section", sectionId: "sec-1", sectionPath: ["1 Einleitung"], pageStart: 0, pageEnd: 0 });
    await insertUnit({ unitId: "s2", baseRef: "docA", content: "2 Wareneingang", unitType: "section", sectionId: "sec-2", sectionPath: ["2 Wareneingang"], pageStart: 0, pageEnd: 0 });
    await insertUnit({ unitId: "s2a", baseRef: "docA", content: "2.1 Anmeldung", unitType: "section", sectionId: "sec-2a", sectionPath: ["2 Wareneingang", "2.1 Anmeldung"], pageStart: 0, pageEnd: 0 });

    // Reading-order chunks on pages 4 and 5 in section 2, prev/next linked.
    await insertUnit({ unitId: "c1", baseRef: "docA", content: "## 2 Wareneingang\n\nErster Text", unitType: "chunk", sectionId: "sec-2", sectionPath: ["2 Wareneingang"], pageStart: 4, pageEnd: 4, nextUnitId: "c2", figureRefs: ["fig-7"] });
    await insertUnit({ unitId: "c2", baseRef: "docA", content: "Zweiter Text auf Seite 5", unitType: "chunk", sectionId: "sec-2", sectionPath: ["2 Wareneingang"], pageStart: 5, pageEnd: 5, prevUnitId: "c1", nextUnitId: "c3" });
    await insertUnit({ unitId: "c3", baseRef: "docA", content: "Dritter Text auf Seite 6", unitType: "chunk", sectionId: "sec-2", sectionPath: ["2 Wareneingang"], pageStart: 6, pageEnd: 6, prevUnitId: "c2" });

    // A table spanning pages 10-11.
    await insertUnit({ unitId: "tbl-a", baseRef: "docA", content: "| A | B |\n|---|---|\n| 1 | 2 |", unitType: "table", sectionId: "sec-2", sectionPath: ["2 Wareneingang"], pageStart: 10, pageEnd: 10, tableId: "table-1" });
    await insertUnit({ unitId: "tbl-b", baseRef: "docA", content: "| 3 | 4 |", unitType: "table", sectionId: "sec-2", sectionPath: ["2 Wareneingang"], pageStart: 11, pageEnd: 11, tableId: "table-1" });

    // Figures: a visible ui_mask on page 4, a bpmn on page 60, and a restricted one.
    await insertUnit({ unitId: "f1", baseRef: "docA", content: "Abbildung 7: Maske\ndesc", unitType: "figure", figureKind: "ui_mask", sectionPath: ["2 Wareneingang"], pageStart: 4, pageEnd: 4, figureId: "fig-7", assetId: "asset-7" });
    await insertUnit({ unitId: "f2", baseRef: "docA", content: "Abbildung 99: Prozess", unitType: "figure", figureKind: "bpmn", pageStart: 60, pageEnd: 60, figureId: "fig-99", assetId: "asset-99" });
    await insertUnit({ unitId: "f3", baseRef: "docA", content: "Abbildung geheim", unitType: "figure", figureKind: "drawing", pageStart: 4, pageEnd: 4, figureId: "fig-secret", assetId: "asset-secret", allowedUsers: ["vip"] });

    // identifiers: WE01A occurs on c1 (page 4) and a restricted unit r1 (vip-only).
    await insertUnit({ unitId: "r1", baseRef: "docA", content: "WE-01/A steht hier geheim", unitType: "chunk", sectionId: "sec-2", sectionPath: ["2 Wareneingang"], pageStart: 7, pageEnd: 7, allowedUsers: ["vip"] });
    const idClient = await pool.connect();
    try {
      await idClient.query(
        `INSERT INTO vs_identifiers (tenant_id, collection, value_norm, unit_id, page, kind)
         VALUES ($1,$2,'WE01A','c1',4,'code'), ($1,$2,'WE01A','r1',7,'code')
         ON CONFLICT DO NOTHING`,
        [TENANT, collection],
      );
    } finally {
      idClient.release();
    }
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
    await pool?.query(`DELETE FROM vs_identifiers WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pg?.close();
    await pool?.end();
  });

  it("getOutline returns sections with ids + pages, depth-limited and paginated", async () => {
    const all = await pg.getOutline(collection, serviceScope(), "docA");
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.result.total).toBe(3);
    // Depth 1 excludes the 2-level "2.1 Anmeldung".
    const depth1 = await pg.getOutline(collection, serviceScope(), "docA", { depth: 1 });
    expect(depth1.ok && depth1.result.entries.every((e) => e.depth <= 1)).toBe(true);
    // Pagination.
    const page = await pg.getOutline(collection, serviceScope(), "docA", { limit: 2, offset: 0 });
    expect(page.ok && page.result.entries).toHaveLength(2);
  });

  it("getSectionUnits returns a section's units by id, in reading order", async () => {
    const res = await pg.getSectionUnits(collection, serviceScope(), "docA", { sectionId: "sec-2" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.result.map((u) => u.unit_id);
    expect(ids).toContain("c1");
    // ordered by page ascending.
    const pages = res.result.map((u) => u.page_start ?? 0);
    expect([...pages]).toEqual([...pages].sort((a, b) => a - b));
  });

  it("getPageUnits returns the units overlapping a page range", async () => {
    const res = await pg.getPageUnits(collection, serviceScope(), "docA", 4, 5);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = new Set(res.result.map((u) => u.unit_id));
    expect(ids.has("c1")).toBe(true);
    expect(ids.has("c2")).toBe(true);
    expect(ids.has("c3")).toBe(false); // page 6 is outside 4..5
  });

  it("getContextUnits walks prev/next neighbours around a unit", async () => {
    const res = await pg.getContextUnits(collection, serviceScope(), "c2", 1, 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.unit?.unit_id).toBe("c2");
    expect(res.result.before.map((u) => u.unit_id)).toEqual(["c1"]);
    expect(res.result.after.map((u) => u.unit_id)).toEqual(["c3"]);
  });

  it("listFigureUnits lists figures of a range, filterable by kind, paginated", async () => {
    const all = await pg.listFigureUnits(collection, serviceScope(), "docA");
    expect(all.ok && all.result.total).toBe(3);
    const masks = await pg.listFigureUnits(collection, serviceScope(), "docA", { kind: "ui_mask" });
    expect(masks.ok && masks.result.figures.every((f) => f.figure_kind === "ui_mask")).toBe(true);
    const ranged = await pg.listFigureUnits(collection, serviceScope(), "docA", { fromPage: 1, toPage: 10 });
    expect(ranged.ok && ranged.result.figures.map((f) => f.figure_id).sort()).toEqual(["fig-7", "fig-secret"]);
  });

  it("getTableUnits reassembles a table's row-groups across pages", async () => {
    const res = await pg.getTableUnits(collection, serviceScope(), "table-1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.total).toBe(2);
    expect(res.result.units.map((u) => u.unit_id)).toEqual(["tbl-a", "tbl-b"]);
  });

  it("getUnitById surfaces the unit and its figure_refs", async () => {
    const res = await pg.getUnitById(collection, serviceScope(), "c1");
    expect(res.ok).toBe(true);
    if (!res.ok || res.result === null) return;
    expect(res.result.unit_id).toBe("c1");
    expect(res.result.metadata.figure_refs).toEqual(["fig-7"]);
    expect(res.result.metadata.base_ref).toBe("docA");
  });

  it("findIdentifierOccurrences returns visible occurrences and hides restricted ones", async () => {
    // Service scope sees both occurrences.
    const svc = await pg.findIdentifierOccurrences(collection, serviceScope(), "WE01A");
    expect(svc.ok && svc.result.total).toBe(2);
    // A non-vip user must NOT see the restricted r1 occurrence — only c1.
    const user = await pg.findIdentifierOccurrences(collection, userScope("bob", ["staff"]), "WE01A");
    expect(user.ok).toBe(true);
    if (!user.ok) return;
    expect(user.result.total).toBe(1);
    expect(user.result.occurrences[0]?.unit_id).toBe("c1");
  });

  it("ACL: a restricted figure never leaks to a non-authorized user", async () => {
    const user = await pg.listFigureUnits(collection, userScope("bob", ["staff"]), "docA");
    expect(user.ok).toBe(true);
    if (!user.ok) return;
    const ids = user.result.figures.map((f) => f.figure_id);
    expect(ids).not.toContain("fig-secret");
  });
});
