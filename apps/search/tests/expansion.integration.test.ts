// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for small-to-big expansion (task 3.6, Requirement 13.4)
 * against a REAL PostgreSQL + pgvector instance. These verify the SQL-level
 * behaviour of PostgresClient.expandUnit that unit tests cannot:
 *
 *   - `neighbors` returns the hit plus its prev/next reading-order siblings;
 *   - `section` returns every unit sharing the hit's section_id in the document;
 *   - `page` returns every unit overlapping the hit's page range in the document;
 *   - the expansion is scoped to the hit's document (base_ref) — it never leaks
 *     units of another document, another tenant, a non-current revision, or a
 *     row the caller's ACL forbids (reuses buildTemporalFilterSql/buildAccessSql,
 *     the same predicates the search query uses).
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites);
 * fails rather than silently passing when it IS set but unreachable.
 *
 *   TEST_POSTGRES_URL=postgres://user:pw@localhost:5432/db npx vitest run
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

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `exptest-${Date.now()}`;
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

/** A non-service scope for a specific user with the given groups (row ACL applies). */
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

describeIfPg("small-to-big expansion · real postgres (task 3.6)", () => {
	let pool: Pool;
	let pg: PostgresClient;
	const collection = `exptest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
	const table = collectionTableName(collection);

	/**
	 * Insert one unit row directly. We bypass the batch worker to control the
	 * relationship-graph columns precisely; the DDL and columns are what task 3.2
	 * already created.
	 */
	async function insertUnit(row: {
		unitId: string;
		baseRef: string;
		content: string;
		sectionId?: string | null;
		pageStart?: number | null;
		pageEnd?: number | null;
		prevUnitId?: string | null;
		nextUnitId?: string | null;
		revisionId?: string | null;
		isLatest?: boolean;
		allowedUsers?: string[];
		allowedGroups?: string[];
		tenantId?: string;
	}): Promise<void> {
		const meta = {
			unit_id: row.unitId,
			...(row.sectionId ? { section_id: row.sectionId } : {}),
			...(row.prevUnitId ? { prev_unit_id: row.prevUnitId } : {}),
			...(row.nextUnitId ? { next_unit_id: row.nextUnitId } : {}),
			...(row.pageStart != null ? { page_start: row.pageStart } : {}),
			...(row.pageEnd != null ? { page_end: row.pageEnd } : {}),
		};
		await pool.query(
			`INSERT INTO "${table}"
         (tenant_id, reference, base_ref, is_latest, content, vector, metadata,
          unit_id, section_id, page_start, page_end, prev_unit_id, next_unit_id,
          revision_id, allowed_users, allowed_groups)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16::text[])`,
			[
				row.tenantId ?? TENANT,
				`${row.baseRef}::${row.unitId}`,
				row.baseRef,
				row.isLatest ?? true,
				row.content,
				JSON.stringify(zeroVector),
				JSON.stringify(meta),
				row.unitId,
				row.sectionId ?? null,
				row.pageStart ?? null,
				row.pageEnd ?? null,
				row.prevUnitId ?? null,
				row.nextUnitId ?? null,
				row.revisionId ?? null,
				row.allowedUsers ?? [],
				row.allowedGroups ?? [],
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

		// Document A: section sec-1 spans pages 1–2 with three units in reading order.
		await insertUnit({
			unitId: "a-1",
			baseRef: "docA",
			content: "A one",
			sectionId: "sec-1",
			pageStart: 1,
			pageEnd: 1,
			nextUnitId: "a-2",
		});
		await insertUnit({
			unitId: "a-2",
			baseRef: "docA",
			content: "A two (hit)",
			sectionId: "sec-1",
			pageStart: 1,
			pageEnd: 1,
			prevUnitId: "a-1",
			nextUnitId: "a-3",
		});
		await insertUnit({
			unitId: "a-3",
			baseRef: "docA",
			content: "A three",
			sectionId: "sec-1",
			pageStart: 2,
			pageEnd: 2,
			prevUnitId: "a-2",
		});
		// A unit in a DIFFERENT section / page of the same document — must not leak
		// into a sec-1 / page-1 expansion.
		await insertUnit({
			unitId: "a-9",
			baseRef: "docA",
			content: "A other section",
			sectionId: "sec-2",
			pageStart: 9,
			pageEnd: 9,
		});

		// Document B: shares section id "sec-1" but a different base_ref — must never
		// appear in document A's expansion (base_ref scoping).
		await insertUnit({
			unitId: "b-1",
			baseRef: "docB",
			content: "B leak?",
			sectionId: "sec-1",
			pageStart: 1,
			pageEnd: 1,
		});

		// A restricted unit in document A, sec-1, page 1 — visible only to user "vip".
		await insertUnit({
			unitId: "a-acl",
			baseRef: "docA",
			content: "A restricted",
			sectionId: "sec-1",
			pageStart: 1,
			pageEnd: 1,
			allowedUsers: ["vip"],
		});

		// A non-current-revision (is_latest = FALSE) unit in docA/sec-1/page1 — must
		// be filtered by the visibility predicate.
		await insertUnit({
			unitId: "a-old",
			baseRef: "docA",
			content: "A stale revision",
			sectionId: "sec-1",
			pageStart: 1,
			pageEnd: 1,
			isLatest: false,
		});
	}, 60_000);

	afterAll(async () => {
		try {
			await pg?.deleteCollection(collection);
		} catch {
			/* ignore */
		}
		await pg?.close();
		await pool.end();
	});

	it("neighbors returns the hit plus its prev/next siblings, in reading order", async () => {
		const res = await pg.expandUnit(collection, serviceScope(), "neighbors", {
			unitId: "a-2",
			baseRef: "docA",
			prevUnitId: "a-1",
			nextUnitId: "a-3",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const ids = res.result.map((r) => r.unit_id);
		expect(ids).toEqual(["a-1", "a-2", "a-3"]); // reading order by page then id
	});

	it("section returns every unit of the hit's section in this document only", async () => {
		const res = await pg.expandUnit(collection, serviceScope(), "section", {
			unitId: "a-2",
			baseRef: "docA",
			sectionId: "sec-1",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const ids = res.result.map((r) => r.unit_id).sort();
		// sec-1 units of docA that are current & unrestricted for a service scope:
		// a-1, a-2, a-3, a-acl (service sees ACL). NOT a-9 (sec-2), NOT b-1 (docB),
		// NOT a-old (is_latest = FALSE).
		expect(ids).toEqual(["a-1", "a-2", "a-3", "a-acl"]);
		expect(ids).not.toContain("b-1");
		expect(ids).not.toContain("a-9");
		expect(ids).not.toContain("a-old");
	});

	it("page returns every unit overlapping the hit's page range in this document", async () => {
		const res = await pg.expandUnit(collection, serviceScope(), "page", {
			unitId: "a-2",
			baseRef: "docA",
			pageStart: 1,
			pageEnd: 1,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const ids = res.result.map((r) => r.unit_id).sort();
		// page-1 units of docA (current, service): a-1, a-2, a-acl. NOT a-3 (page 2),
		// NOT a-9 (page 9), NOT b-1 (docB), NOT a-old (stale).
		expect(ids).toEqual(["a-1", "a-2", "a-acl"]);
	});

	it("respects row ACL: a restricted unit is hidden from a user who lacks access", async () => {
		const res = await pg.expandUnit(
			collection,
			userScope("nobody", []),
			"section",
			{
				unitId: "a-2",
				baseRef: "docA",
				sectionId: "sec-1",
			},
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const ids = res.result.map((r) => r.unit_id).sort();
		// The public units are visible; the vip-only "a-acl" is not.
		expect(ids).toEqual(["a-1", "a-2", "a-3"]);
		expect(ids).not.toContain("a-acl");
	});

	it("shows a restricted unit to the user who is allowed", async () => {
		const res = await pg.expandUnit(
			collection,
			userScope("vip", []),
			"section",
			{
				unitId: "a-2",
				baseRef: "docA",
				sectionId: "sec-1",
			},
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const ids = res.result.map((r) => r.unit_id).sort();
		expect(ids).toContain("a-acl");
	});

	it("never crosses tenants", async () => {
		const res = await pg.expandUnit(
			collection,
			serviceScope("other-tenant"),
			"section",
			{
				unitId: "a-2",
				baseRef: "docA",
				sectionId: "sec-1",
			},
		);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.result).toHaveLength(0);
	});

	it("returns [] for a mode whose coordinates are missing (no leak, no error)", async () => {
		const res = await pg.expandUnit(collection, serviceScope(), "section", {
			unitId: "a-2",
			baseRef: "docA",
			// sectionId omitted
		});
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.result).toHaveLength(0);
	});
});
