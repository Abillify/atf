// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 6: tenant isolation of all ranked lists (task 6.3, Requirement 3.5):
 *
 *   For arbitrary tenants, ACLs and queries, no result from dense, FTS,
 *   sparse, identifier or fusion contains a row of a foreign tenant or an
 *   ACL-forbidden row.
 *
 * fast-check generates a random mix of units across three tenants, each with
 * a random allowed_users/allowed_groups pattern, plus a query scope (tenant,
 * user id, groups, service flag). Every iteration inserts the mix, queries it
 * through ALL ranked-list paths of
 * PostgresClient.search (dense, FTS-only, hybrid fusion, hybrid+sparse,
 * hybrid+identifier list) and compares the returned reference set with the
 * set the model predicts as visible for this scope: only rows of the own
 * tenant, with ACL rules applied. A foreign tenant row or an ACL-forbidden
 * row in any list falsifies the property, as does a missing row (the lists
 * must report neither too much nor too little).
 *
 * The binary dense path shares buildAccessSql with the dense path (covered by
 * the query-builder unit tests) and is not run against the DB again here.
 *
 * The second describe block covers the second part of Requirement 3.5
 * ("missing scopes"): every query builder throws AccessScopeRequiredError
 * without a scope, and search() fails (ok:false, no rows) instead of
 * returning unscoped results.
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites).
 */

import * as fc from "fast-check";
import { Pool } from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessScope } from "../src/access-scope.js";
import {
	AccessScopeRequiredError,
	buildBinaryDenseQuery,
	buildDenseQuery,
	buildFtsQuery,
	buildHybridQuery,
} from "../src/query-builder.js";
import { collectionTableName } from "../src/collection-ddl.js";
import { buildIdentifierText } from "../src/identifier.js";
import {
	createPostgresClient,
	type PostgresClient,
} from "../src/postgres-client.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const SPARSE_DIM = 64;
/** Identifier every generated row carries; the query repeats it. */
const CODE = "WE-01/A";
const CODE_NORM = "WE01A";
/** Prose word in every row so the FTS list matches all of them. */
const WORD = "isotestwort";
const QUERY_TEXT = `${WORD} ${CODE}`;
// 0-based for the SparseVector API; the pgvector literal is 1-based
// (sparseVectorToPg adds the offset at the DB boundary).
const QUERY_SPARSE = { indices: [0, 5], values: [1, 1], dim: SPARSE_DIM };
const QUERY_SPARSE_PG = `{1:1,5:1}/${SPARSE_DIM}`;

const STAMP = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const TENANT_KEYS = [`iso-a-${STAMP}`, `iso-b-${STAMP}`, `iso-c-${STAMP}`];
const collection = `isotest_${STAMP}`;
const table = collectionTableName(collection);
/** Own table for the missing-scope block — its afterAll must never DROP the
 * property table while property iterations are still in flight. */
const nsCollection = `isotest_ns_${STAMP}`;
const nsTable = collectionTableName(nsCollection);
const logger = pino({ level: "silent" });

/** Uniform query vector: every row is a candidate in the dense lists. */
const QUERY_VECTOR: number[] = Array<number>(VECTOR_SIZE).fill(1 / Math.sqrt(VECTOR_SIZE));

/** Axis vector of the row's tenant with a small tilt, so order is stable. */
function rowVector(tenantIdx: number, rowIdx: number): number[] {
	const v = new Array<number>(VECTOR_SIZE).fill(0);
	v[tenantIdx] = 1;
	v[(tenantIdx + 1) % VECTOR_SIZE] = 0.01 * (rowIdx + 1);
	return v;
}

function userScope(
	tenantId: string,
	userId: string | undefined,
	userGroups: string[],
	service = false,
): AccessScope {
	return {
		principal: { userId, userGroups, scopes: ["vectorsearch.read"], source: "asserted" },
		userId,
		userGroups,
		tenantId,
		scopes: ["vectorsearch.read"],
		service,
	};
}

/** One generated unit row, relative to its tenant. */
interface GenRow {
	tenantIdx: number;
	users: string[];
	groups: string[];
}

/** One generated query: which scope asks. */
interface GenQuery {
	tenantIdx: number;
	userId: string | undefined;
	userGroups: string[];
	service: boolean;
}

interface GenCase {
	rows: GenRow[];
	query: GenQuery;
}

const rowArb: fc.Arbitrary<GenRow> = fc.record({
	tenantIdx: fc.integer({ min: 0, max: 2 }),
	users: fc.constantFrom([], ["alice"], ["bob"], ["alice", "bob"], ["carla"]),
	groups: fc.constantFrom([], ["staff"], ["ops"], ["staff", "ops"], ["extern"]),
});

const caseArb: fc.Arbitrary<GenCase> = fc
	.record({
		rows: fc.array(rowArb, { minLength: 3, maxLength: 8 }),
		query: fc.record({
			tenantIdx: fc.integer({ min: 0, max: 2 }),
			userId: fc.constantFrom(undefined, "alice", "bob"),
			userGroups: fc.constantFrom<string[]>([], ["staff"], ["ops"]),
			service: fc.boolean(),
		}),
	})
	.map((c): GenCase => {
		// Every tenant must hold at least one row, so no iteration can pass by
		// simply having nothing to leak.
		const rows = [...c.rows];
		for (let t = 0; t < TENANT_KEYS.length; t++) {
			if (!rows.some((r) => r.tenantIdx === t)) {
				rows.push({ tenantIdx: t, users: [], groups: [] });
			}
		}
		return { rows, query: c.query };
	});

/** A materialised row of one iteration. */
interface InsertedRow {
	reference: string;
	unitId: string;
	tenantIdx: number;
	users: string[];
	groups: string[];
}

/** Model of Requirement 3.1/3.2 visibility for DOCUMENT_ACL_DEFAULT=allow. */
function modelVisible(row: InsertedRow, scope: AccessScope): boolean {
	if (scope.service) return true;
	if (row.users.length === 0 && row.groups.length === 0) return true;
	if (scope.userId !== undefined && row.users.includes(scope.userId)) return true;
	return scope.userGroups.some((g) => row.groups.includes(g));
}

describeIfPg("Tenant-Isolation aller Ranglisten · Property 6 (real postgres)", () => {
	let pool: Pool;
	let pg: PostgresClient;

	beforeAll(async () => {
		pool = new Pool({ connectionString: CONNECTION });
		pg = createPostgresClient({
			connectionString: CONNECTION ?? "",
			logger,
			statsFlushIntervalMs: 3_600_000,
		});
		const ensured = await pg.ensureCollection(collection, VECTOR_SIZE, {
			sparseVocabSize: SPARSE_DIM,
		});
		expect(ensured.ok).toBe(true);
	}, 60_000);

	afterAll(async () => {
		await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
		await pool?.query(`DELETE FROM vs_identifiers WHERE collection = $1`, [collection]).catch(() => {});
		await pg?.close();
		await pool?.end();
	});

	async function resetRows(): Promise<void> {
		await pool.query(`DELETE FROM "${table}" WHERE tenant_id = ANY($1)`, [TENANT_KEYS]);
		await pool.query(`DELETE FROM vs_identifiers WHERE collection = $1`, [collection]);
	}

	async function insertRows(rows: InsertedRow[]): Promise<void> {
		for (const row of rows) {
			await pool.query(
				`INSERT INTO "${table}"
				   (tenant_id, reference, base_ref, is_latest, content, vector, ts_search,
				    ts_ident, sparse_vector, allowed_users, allowed_groups, unit_id, unit_type)
				 VALUES ($1,$2,$3,TRUE,$4,$5::vector,to_tsvector('simple',$4),
				         to_tsvector('simple',$6),$7::sparsevec,$8::text[],$9::text[],$10,'chunk')`,
				[
					TENANT_KEYS[row.tenantIdx],
					row.reference,
					row.reference,
					`${QUERY_TEXT} einheit ${row.unitId}`,
					JSON.stringify(rowVector(row.tenantIdx, Number(row.unitId.slice(1)) || 0)),
					buildIdentifierText(`${QUERY_TEXT} einheit ${row.unitId}`),
					QUERY_SPARSE_PG,
					row.users,
					row.groups,
					row.unitId,
				],
			);
			await pool.query(
				`INSERT INTO vs_identifiers (tenant_id, collection, value_norm, unit_id, kind)
				 VALUES ($1,$2,$3,$4,'mask_code')`,
				[TENANT_KEYS[row.tenantIdx], collection, CODE_NORM, row.unitId],
			);
		}
	}

	it("returns no foreign-tenant or ACL-forbidden row in any ranked list", async () => {
		await fc.assert(
			fc.asyncProperty(caseArb, async (gen) => {
				const rows: InsertedRow[] = gen.rows.map((r, idx) => ({
					reference: `${TENANT_KEYS[r.tenantIdx]}::u${idx}`,
					unitId: `u${idx}`,
					tenantIdx: r.tenantIdx,
					users: r.users,
					groups: r.groups,
				}));
				await resetRows();
				await insertRows(rows);

				const q = gen.query;
				const scope = userScope(
					TENANT_KEYS[q.tenantIdx],
					q.userId,
					q.userGroups,
					q.service,
				);
				const expected = rows
					.filter((r) => r.tenantIdx === q.tenantIdx && modelVisible(r, scope))
					.map((r) => r.reference)
					.sort();

				const search = pg.search.bind(pg);
				const modes: Array<[string, () => Promise<Awaited<ReturnType<PostgresClient["search"]>>>]> = [
					["dense", () => search(QUERY_TEXT, QUERY_VECTOR, 50, collection, scope, undefined, false)],
					[
						"fts",
						() =>
							search(
								QUERY_TEXT,
								QUERY_VECTOR,
								50,
								collection,
								scope,
								undefined,
								true,
								false,
								0,
								4,
								undefined,
								undefined,
								undefined,
								true,
							),
					],
					["hybrid", () => search(QUERY_TEXT, QUERY_VECTOR, 50, collection, scope, undefined, true)],
					[
						"hybrid+sparse",
						() =>
							search(
								QUERY_TEXT,
								QUERY_VECTOR,
								50,
								collection,
								scope,
								undefined,
								true,
								false,
								0,
								4,
								QUERY_SPARSE,
							),
					],
					[
						"hybrid+identifier",
						() =>
							search(
								QUERY_TEXT,
								QUERY_VECTOR,
								50,
								collection,
								scope,
								undefined,
								true,
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
								{ identifierList: true },
							),
					],
				];

				for (const [name, run] of modes) {
					const res = await run();
					if (!res.ok) {
						throw new Error(`Rangliste ${name}: search fehlgeschlagen ${JSON.stringify(res.error)}`);
					}
					const got = res.result.map((r) => r.reference).sort();
					if (JSON.stringify(got) !== JSON.stringify(expected)) {
						throw new Error(
							`Rangliste ${name}: got=[${got.join(",")}] expected=[${expected.join(",")}]`,
						);
					}
				}
			}),
			{ numRuns: 20 },
		);
	}, 120_000);
});

describeIfPg("Fehlende Scopes · Requirement 3.5 (real postgres)", () => {
	let pool: Pool;
	let pg: PostgresClient;

	beforeAll(async () => {
		pool = new Pool({ connectionString: CONNECTION });
		pg = createPostgresClient({
			connectionString: CONNECTION ?? "",
			logger,
			statsFlushIntervalMs: 3_600_000,
		});
		const ensured = await pg.ensureCollection(nsCollection, VECTOR_SIZE);
		expect(ensured.ok).toBe(true);
	}, 60_000);

	afterAll(async () => {
		await pool?.query(`DROP TABLE IF EXISTS "${nsTable}" CASCADE`).catch(() => {});
		await pg?.close();
		await pool?.end();
	});

	const noScope = undefined as unknown as AccessScope;
	const vectorJson = JSON.stringify(QUERY_VECTOR);

	it("every query builder throws AccessScopeRequiredError without a scope", () => {
		expect(() =>
			buildDenseQuery(table, "vector", 10, undefined, false, 0, vectorJson, noScope),
		).toThrow(AccessScopeRequiredError);
		expect(() =>
			buildBinaryDenseQuery(
				table,
				"vector",
				VECTOR_SIZE,
				10,
				undefined,
				false,
				0,
				vectorJson,
				"0101",
				4,
				noScope,
			),
		).toThrow(AccessScopeRequiredError);
		expect(() => buildFtsQuery(table, "simple", 10, undefined, false, 0, QUERY_TEXT, noScope)).toThrow(
			AccessScopeRequiredError,
		);
		expect(() =>
			buildHybridQuery(
				table,
				"vector",
				60,
				"simple",
				10,
				undefined,
				false,
				4,
				0,
				false,
				null,
				vectorJson,
				QUERY_TEXT,
				undefined,
				undefined,
				null,
				noScope,
			),
		).toThrow(AccessScopeRequiredError);
	});

	it("search() fails without a scope instead of returning rows (fail closed)", async () => {
		const res = await pg.search(QUERY_TEXT, QUERY_VECTOR, 10, collection, noScope);
		expect(res.ok).toBe(false);
	});
});
