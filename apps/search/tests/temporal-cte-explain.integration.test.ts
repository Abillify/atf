// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Temporal visibility as a CTE (task 6.8, Requirement 4.6):
 *
 *   1. The default path (only `is_latest`, without validAt/includeAllVersions)
 *      must keep using the partial HNSW index: the EXPLAIN guard the design
 *      plan (design.md §Search, "temporal CTE") requires; the visibility
 *      predicates stay INLINE there so the
 *      `*_vector_latest_hnsw_idx` index stays scannable.
 *   2. The validAt path (shared `visible` CTE) must execute and filter
 *      correctly in time: per document exactly the version that was valid
 *      at query time.
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites).
 */

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessScope } from "../src/access-scope.js";
import { collectionTableName } from "../src/collection-ddl.js";
import { createPostgresClient } from "../src/postgres-client.js";
import { buildHybridQuery } from "../src/query-builder.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 32;
const STAMP = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const collection = `tcte_${STAMP}`;
const table = collectionTableName(collection);
const TENANT = `tcte-tenant-${STAMP}`;
const QUERY_TEXT = "dokument";
const CONTENT = "temporal cte test dokument";
/** Fillers do NOT contain the search word; txt only matches the version rows. */
const FILLER_CONTENT = "fueller fueller fueller";

/** Deterministic PRNG (mulberry32) so vectors are stable per run. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function seedFrom(label: string): number {
	return createHash("sha256").update(label).digest().readUInt32BE(0);
}

function randomVector(rand: () => number): number[] {
	const v = new Array<number>(VECTOR_SIZE);
	for (let i = 0; i < VECTOR_SIZE; i++) v[i] = rand() * 2 - 1;
	return v;
}

const serviceScope: AccessScope = {
	principal: {
		userId: undefined,
		userGroups: undefined,
		scopes: ["vectorsearch.read"],
		source: "asserted",
	},
	userId: undefined,
	userGroups: [],
	tenantId: TENANT,
	scopes: ["vectorsearch.read"],
	service: true,
};

/** Build the hybrid SQL exactly like production would for this scope. */
function hybrid(validAt?: string, includeAllVersions = false) {
	return buildHybridQuery(
		table,
		`vector(${VECTOR_SIZE})`,
		60,
		"simple",
		10,
		undefined,
		includeAllVersions,
		4,
		0,
		false,
		null,
		JSON.stringify(randomVector(mulberry32(seedFrom(`${STAMP}:query`)))),
		QUERY_TEXT,
		undefined,
		undefined,
		null,
		serviceScope,
		undefined,
		undefined,
		undefined,
		validAt,
		undefined,
	);
}

describeIfPg("Temporale CTE · EXPLAIN (real postgres)", () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: CONNECTION, max: 4 });

		// Collection via production DDL (HNSW-Indizes inklusive partial latest).
		const pg = createPostgresClient({
			connectionString: CONNECTION ?? "",
			logger: pino({ level: "silent" }),
			statementTimeoutMs: 0,
			statsFlushIntervalMs: 3_600_000,
		});
		const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
		expect(ensured.ok).toBe(true);
		await pg.close();

		// --- Dataset A: fills the table for the index plan test. ----------
		const rand = mulberry32(seedFrom(`${STAMP}:rows`));
		const BATCH = 1_000;
		const TOTAL = 6_000;
		for (let start = 0; start < TOTAL; start += BATCH) {
			const placeholders: string[] = [];
			const params: unknown[] = [];
			for (let i = 0; i < BATCH; i++) {
				const n = start + i;
				const b = i * 5;
				placeholders.push(
					`($${b + 1},$${b + 2},$${b + 2},TRUE,$${b + 3},` +
						`$${b + 4}::vector,to_tsvector('simple',$${b + 3}),` +
						`'{}'::text[],'{}'::text[],$${b + 5},'chunk')`,
				);
				params.push(
					TENANT,
					`filler::r${n}`,
					FILLER_CONTENT,
					JSON.stringify(randomVector(rand)),
					`u${n}`,
				);
			}
			await pool.query(
				`INSERT INTO "${table}"
				   (tenant_id, reference, base_ref, is_latest, content, vector,
				    ts_search, allowed_users, allowed_groups, unit_id, unit_type)
				 VALUES ${placeholders.join(",")}`,
				params,
			);
		}

		// --- Dataset B: two versions per reference (v1 old, v2 current). ---
		const VERSIONS: Array<{ suffix: string; validFrom: string; latest: boolean }> = [
			{ suffix: "v1", validFrom: "2026-01-01T00:00:00Z", latest: false },
			{ suffix: "v2", validFrom: "2026-03-01T00:00:00Z", latest: true },
		];
		for (const version of VERSIONS) {
			const placeholders: string[] = [];
			const params: unknown[] = [];
			for (let i = 0; i < 50; i++) {
				const b = i * 8;
				placeholders.push(
					`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},` +
						`$${b + 6}::vector,to_tsvector('simple',$${b + 5}),` +
						`'{}'::text[],'{}'::text[],$${b + 7},'chunk',$${b + 8}::timestamptz)`,
				);
				params.push(
					TENANT,
					`doc::i${i}::${version.suffix}`,
					`doc::i${i}`,
					version.latest,
					CONTENT,
					JSON.stringify(randomVector(rand)),
					`vu${version.suffix}${i}`,
					version.validFrom,
				);
			}
			await pool.query(
				`INSERT INTO "${table}"
				   (tenant_id, reference, base_ref, is_latest, content, vector,
				    ts_search, allowed_users, allowed_groups, unit_id, unit_type,
				    valid_from)
				 VALUES ${placeholders.join(",")}`,
				params,
			);
		}

		// Fresh statistics: without ANALYZE the planner estimates wrongly and
		// avoids the HNSW index (see hnsw-recall-selective).
		await pool.query(`ANALYZE "${table}"`);
	}, 180_000);

	afterAll(async () => {
		await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
		await pool?.end();
	});

	it("default path (inline is_latest) keeps using the HNSW index", async () => {
		const built = hybrid();
		// The default stays inline, no visible CTE (unit tests pin the SQL
		// form; here we guard the plan choice).
		expect(built.sql).not.toContain("visible AS (");

		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET LOCAL hnsw.ef_search = 100");
			await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
			const res = await client.query<{ plan: unknown[] }>(
				`EXPLAIN (FORMAT JSON) ${built.sql}`,
				built.params,
			);
			await client.query("COMMIT");
			const planText = JSON.stringify(res.rows);
			// The vec branch must run through an HNSW index (partial
			// `*_vector_latest_hnsw_idx` or full); not a pure sort path.
			expect(planText).toContain("Index Scan");
			expect(planText).toMatch(/_hnsw_idx/);
		} finally {
			await client.release();
		}
	}, 120_000);

	it("validAt path executes and returns exactly the version valid at that time", async () => {
		const asOfJan = hybrid("2026-02-01T00:00:00.000Z");
		expect(asOfJan.sql).toContain("visible AS (");
		expect(asOfJan.sql).toContain("id IN (SELECT id FROM visible)");
		const jan = await pool.query<{ reference: string }>(
			asOfJan.sql,
			asOfJan.params,
		);
		expect(jan.rows.length).toBeGreaterThan(0);
		// February: v1 (valid_from 2026-01-01) is visible, v2 (March) is not.
		// (Filler rows may also be visible depending on created; what matters
		// is the version choice per document.)
		for (const row of jan.rows) {
			expect(row.reference.endsWith("::v2")).toBe(false);
		}
		expect(jan.rows.some((row) => row.reference.endsWith("::v1"))).toBe(true);

		const asOfApr = hybrid("2026-04-01T00:00:00.000Z");
		const apr = await pool.query<{ reference: string }>(
			asOfApr.sql,
			asOfApr.params,
		);
		expect(apr.rows.length).toBeGreaterThan(0);
		for (const row of apr.rows) {
			expect(row.reference.endsWith("::v1")).toBe(false);
		}
		expect(apr.rows.some((row) => row.reference.endsWith("::v2"))).toBe(true);
	}, 120_000);

	it("default latest path hides the old version v1", async () => {
		const built = hybrid();
		const res = await pool.query<{ reference: string }>(built.sql, built.params);
		expect(res.rows.length).toBeGreaterThan(0);
		// Filler rows are latest too; what matters is that the superseded v1
		// version never shows up in the latest path.
		for (const row of res.rows) {
			expect(row.reference.endsWith("::v1")).toBe(false);
		}
		expect(res.rows.some((row) => row.reference.endsWith("::v2"))).toBe(true);
	}, 120_000);
});

