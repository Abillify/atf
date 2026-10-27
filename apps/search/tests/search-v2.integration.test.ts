// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the v2 search filters + figure lookup
 * against a REAL PostgreSQL + pgvector instance. These verify the SQL-level
 * behaviour the handler/unit tests cannot:
 *
 *   - the v2 unit filter (UNIT_FILTER_V2) actually filters on the real indexed
 *     columns: unit_type / figure_kind (equality), page range (overlap),
 *     section_path (array-prefix);
 *   - PostgresClient.lookupFigureUnits resolves referenced figures within a
 *     document, honouring tenant/ACL/visibility (never leaks a foreign document
 *     or a row the caller's ACL forbids).
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites).
 *
 *   TEST_POSTGRES_URL=postgres://user:pw@localhost:5432/db npx vitest run
 */

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import {
	createPostgresClient,
	type PostgresClient,
	type SearchFilter,
} from "../src/postgres-client.js";
import { collectionTableName } from "../src/collection-ddl.js";
import { UNIT_FILTER_V2, type UnitFilterV2 } from "../src/metadata.js";
import type { AccessScope } from "../src/access-scope.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `v2test-${Date.now()}`;
const logger = pino({ level: "silent" });
const zeroVector = new Array<number>(VECTOR_SIZE).fill(0);

function serviceScope(tenantId = TENANT): AccessScope {
	return {
		principal: {
			userId: undefined,
			userGroups: [],
			scopes: [],
			source: "asserted",
		},
		userId: undefined,
		userGroups: [],
		tenantId,
		scopes: [],
		service: true,
	};
}

function userScope(
	userId: string,
	userGroups: string[] = [],
	tenantId = TENANT,
): AccessScope {
	return {
		principal: { userId, userGroups, scopes: [], source: "asserted" },
		userId,
		userGroups,
		tenantId,
		scopes: [],
		service: false,
	};
}

function withUnitFilter(unit: UnitFilterV2): SearchFilter {
	const filter: SearchFilter = {};
	(filter as SearchFilter & { [UNIT_FILTER_V2]?: UnitFilterV2 })[
		UNIT_FILTER_V2
	] = unit;
	return filter;
}

describeIfPg(
	"v2 search filters + figure lookup · real postgres (task 3.7)",
	() => {
		let pool: Pool;
		let pg: PostgresClient;
		const collection = `v2test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
		const table = collectionTableName(collection);

		async function insertUnit(row: {
			unitId: string;
			baseRef: string;
			content: string;
			unitType?: string;
			figureKind?: string | null;
			sectionPath?: string[] | null;
			pageStart?: number | null;
			pageEnd?: number | null;
			figureId?: string | null;
			assetId?: string | null;
			bbox?: number[] | null;
			allowedUsers?: string[];
		}): Promise<void> {
			const meta: Record<string, unknown> = {
				unit_id: row.unitId,
				...(row.unitType ? { unit_type: row.unitType } : {}),
				...(row.figureKind ? { figure_kind: row.figureKind } : {}),
				...(row.sectionPath ? { section_path: row.sectionPath } : {}),
				...(row.pageStart != null ? { page_start: row.pageStart } : {}),
				...(row.pageEnd != null ? { page_end: row.pageEnd } : {}),
				...(row.figureId ? { figure_id: row.figureId } : {}),
				...(row.assetId ? { asset_id: row.assetId } : {}),
				...(row.bbox ? { bbox: row.bbox } : {}),
			};
			await pool.query(
				`INSERT INTO "${table}"
         (tenant_id, reference, base_ref, is_latest, content, vector, metadata,
          unit_id, unit_type, section_path, page_start, page_end, figure_kind,
          allowed_users, allowed_groups)
       VALUES ($1,$2,$3,TRUE,$4,$5::vector,$6::jsonb,$7,$8,$9::text[],$10,$11,$12,$13::text[],$14::text[])`,
				[
					TENANT,
					`${row.baseRef}::${row.unitId}`,
					row.baseRef,
					row.content,
					JSON.stringify(zeroVector),
					JSON.stringify(meta),
					row.unitId,
					row.unitType ?? null,
					row.sectionPath ?? null,
					row.pageStart ?? null,
					row.pageEnd ?? null,
					row.figureKind ?? null,
					row.allowedUsers ?? [],
					[],
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
			const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
			expect(ensured.ok).toBe(true);

			await insertUnit({
				unitId: "c1",
				baseRef: "docA",
				content: "chunk one",
				unitType: "chunk",
				sectionPath: ["4 Antragseingang", "4.2 Anmeldung"],
				pageStart: 37,
				pageEnd: 38,
			});
			await insertUnit({
				unitId: "t1",
				baseRef: "docA",
				content: "table one",
				unitType: "table",
				sectionPath: ["4 Antragseingang"],
				pageStart: 40,
				pageEnd: 40,
			});
			await insertUnit({
				unitId: "f1",
				baseRef: "docA",
				content: "Abbildung 12: Maske WE01\ndesc",
				unitType: "figure",
				figureKind: "ui_mask",
				sectionPath: ["4 Antragseingang", "4.2 Anmeldung"],
				pageStart: 37,
				pageEnd: 37,
				figureId: "fig-12",
				assetId: "asset-12",
				bbox: [0.1, 0.2, 0.3, 0.4],
			});
			await insertUnit({
				unitId: "f2",
				baseRef: "docA",
				content: "Abbildung 99: Prozess\ndesc",
				unitType: "figure",
				figureKind: "bpmn",
				sectionPath: ["5 Versand"],
				pageStart: 60,
				pageEnd: 60,
				figureId: "fig-99",
				assetId: "asset-99",
				bbox: [0.5, 0.5, 0.6, 0.6],
			});
			// A restricted figure in the same document, visible only to "vip".
			await insertUnit({
				unitId: "f3",
				baseRef: "docA",
				content: "Abbildung 7: geheim",
				unitType: "figure",
				figureKind: "drawing",
				pageStart: 37,
				pageEnd: 37,
				figureId: "fig-7",
				assetId: "asset-7",
				allowedUsers: ["vip"],
			});
			// A figure in a DIFFERENT document that shares a figure id — must not leak.
			await insertUnit({
				unitId: "b1",
				baseRef: "docB",
				content: "other doc figure",
				unitType: "figure",
				figureKind: "ui_mask",
				figureId: "fig-12",
				assetId: "asset-B12",
				pageStart: 1,
				pageEnd: 1,
			});
		});

		afterAll(async () => {
			await pool
				?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`)
				.catch(() => {});
			await pg?.close();
			await pool?.end();
		});

		const search = (filter: SearchFilter) =>
			pg.search(
				"query",
				zeroVector,
				50,
				collection,
				serviceScope(),
				filter,
				false,
			);

		it("unit_type filters to figures only", async () => {
			const res = await search(withUnitFilter({ unitType: "figure" }));
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const types = new Set(
				res.result.map((r) => (r.metadata as { unit_type?: string }).unit_type),
			);
			expect(types).toEqual(new Set(["figure"]));
		});

		it("figure_kind filters to a single kind", async () => {
			const res = await search(
				withUnitFilter({ unitType: "figure", figureKind: "bpmn" }),
			);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			expect(res.result.map((r) => r.reference)).toEqual(["docA::f2"]);
		});

		it("pages filters by range overlap", async () => {
			const res = await search(withUnitFilter({ pageStart: 37, pageEnd: 38 }));
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const refs = new Set(res.result.map((r) => r.reference));
			// c1 (37-38) and f1 (37) overlap; t1 (40) and f2 (60) do not.
			expect(refs.has("docA::c1")).toBe(true);
			expect(refs.has("docA::f1")).toBe(true);
			expect(refs.has("docA::t1")).toBe(false);
			expect(refs.has("docA::f2")).toBe(false);
		});

		it("section_prefix filters by section_path array prefix", async () => {
			const res = await search(
				withUnitFilter({ sectionPrefix: ["4 Antragseingang", "4.2 Anmeldung"] }),
			);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const refs = new Set(res.result.map((r) => r.reference));
			// c1 and f1 are under "4 / 4.2"; t1 is only under "4"; f2 is under "5".
			expect(refs.has("docA::c1")).toBe(true);
			expect(refs.has("docA::f1")).toBe(true);
			expect(refs.has("docA::t1")).toBe(false);
			expect(refs.has("docA::f2")).toBe(false);
		});

		it("lookupFigureUnits resolves referenced figures within the document", async () => {
			const res = await pg.lookupFigureUnits(
				collection,
				serviceScope(),
				"docA",
				["fig-12", "fig-99"],
			);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			const byId = new Map(res.result.map((f) => [f.figure_id, f]));
			expect(byId.get("fig-12")).toMatchObject({
				asset_id: "asset-12",
				figure_kind: "ui_mask",
				caption: "Abbildung 12: Maske WE01",
				page: 37,
				bbox: [0.1, 0.2, 0.3, 0.4],
			});
			expect(byId.get("fig-99")).toMatchObject({
				figure_kind: "bpmn",
				asset_id: "asset-99",
				page: 60,
			});
		});

		it("lookupFigureUnits never leaks a figure from another document", async () => {
			const res = await pg.lookupFigureUnits(
				collection,
				serviceScope(),
				"docA",
				["fig-12"],
			);
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			// Only docA's fig-12 (asset-12), never docB's fig-12 (asset-B12).
			expect(res.result.map((f) => f.asset_id)).toEqual(["asset-12"]);
		});

		it("lookupFigureUnits honours the row ACL (restricted figure hidden)", async () => {
			const denied = await pg.lookupFigureUnits(
				collection,
				userScope("nobody"),
				"docA",
				["fig-7"],
			);
			expect(denied.ok).toBe(true);
			if (!denied.ok) return;
			expect(denied.result).toHaveLength(0);

			const allowed = await pg.lookupFigureUnits(
				collection,
				userScope("vip"),
				"docA",
				["fig-7"],
			);
			expect(allowed.ok).toBe(true);
			if (!allowed.ok) return;
			expect(allowed.result.map((f) => f.figure_id)).toEqual(["fig-7"]);
		});
	},
);
