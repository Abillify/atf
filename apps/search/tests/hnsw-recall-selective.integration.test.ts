// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Recall under a selective filter (task 6.5, Requirement 4.11):
 *
 *   A dense HNSW search with a highly selective tenant/ACL filter must reach,
 *   with iterative scan (default `relaxed_order`, task 6.4), at least 95 % of
 *   the unfiltered exact recall, i.e. find ≥ 95 % of the true top-K neighbors
 *   among the visible rows.
 *
 * Setup: a collection with ~21,000 rows, of which 1,000 belong to the visible
 * tenant (≈ 4.7 % selectivity). Without iterative scan the ANN search would
 * stop after the ef_search window and return far fewer than `limit` visible
 * rows; the iterative scan keeps expanding until `limit` is met.
 *
 * The exact baseline is computed deterministically by brute force in the test
 * (cosine similarity over all visible rows), independent of the plan the
 * database chooses. An EXPLAIN cross-check makes sure the search actually
 * runs through the HNSW index (with a seq scan the test would be
 * meaningless because it would be exact by definition).
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites).
 */

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccessScope } from "../src/access-scope.js";
import { collectionTableName } from "../src/collection-ddl.js";
import {
	createPostgresClient,
	type PostgresClient,
} from "../src/postgres-client.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 64;
const TOP_K = 20;
/** Visible-tenant rows; the ACL test halves visibility again via allowed_users. */
const TARGET_ROWS = 1_000;
/** Noise rows in a foreign tenant → makes the tenant filter ~4.7 % selective. */
const OTHER_ROWS = 20_000;
const INSERT_BATCH = 1_000;

const STAMP = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const collection = `recall_${STAMP}`;
const table = collectionTableName(collection);
const TENANT_VISIBLE = `recall-visible-${STAMP}`;
const TENANT_OTHER = `recall-other-${STAMP}`;
const logger = pino({ level: "silent" });

/** Deterministic PRNG (mulberry32) so the dataset and baseline are stable. */
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

/** Seed derived from the run stamp so vectors differ per run but stay stable. */
function seedFrom(label: string): number {
	return createHash("sha256").update(label).digest().readUInt32BE(0);
}

function randomVector(rand: () => number): number[] {
	const v = new Array<number>(VECTOR_SIZE);
	for (let i = 0; i < VECTOR_SIZE; i++) v[i] = rand() * 2 - 1;
	return v;
}

function cosine(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		na += av * av;
		nb += bv * bv;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function userScope(tenantId: string, userId?: string): AccessScope {
	return {
		principal: {
			userId,
			userGroups: undefined,
			scopes: ["vectorsearch.read"],
			source: "asserted",
		},
		userId,
		userGroups: userId === undefined ? [] : [userId],
		tenantId,
		scopes: ["vectorsearch.read"],
		service: false,
	};
}

interface Row {
	reference: string;
	tenant: string;
	vector: number[];
	users: string[];
}

const QUERY_VECTOR = randomVector(mulberry32(seedFrom(`${STAMP}:query`)));

/** Brute-force exact top-K (cosine) over all visible rows. */
function exactTopK(rows: readonly Row[], k: number): string[] {
	return [...rows]
		.sort(
			(a, b) =>
				cosine(b.vector, QUERY_VECTOR) - cosine(a.vector, QUERY_VECTOR),
		)
		.slice(0, k)
		.map((r) => r.reference);
}

describeIfPg("Recall unter selektivem Filter · iterativer Scan (real postgres)", () => {
	let pool: Pool;
	let pg: PostgresClient;
	/** Visible-tenant rows: first half ACL alice, second half ACL bob. */
	let targetRows: Row[] = [];

	beforeAll(async () => {
		pool = new Pool({ connectionString: CONNECTION });
		pg = createPostgresClient({
			connectionString: CONNECTION ?? "",
			logger,
			statementTimeoutMs: 0,
			statsFlushIntervalMs: 3_600_000,
		});
		const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
		expect(ensured.ok).toBe(true);

		const rand = mulberry32(seedFrom(`${STAMP}:rows`));
		const rows: Row[] = [];
		for (let i = 0; i < TARGET_ROWS; i++) {
			rows.push({
				reference: `visible::r${i}`,
				tenant: TENANT_VISIBLE,
				vector: randomVector(rand),
				// ACL selective: only Alice's half is visible to scope alice.
				users: i < TARGET_ROWS / 2 ? ["alice"] : ["bob"],
			});
		}
		for (let i = 0; i < OTHER_ROWS; i++) {
			rows.push({
				reference: `other::r${i}`,
				tenant: TENANT_OTHER,
				vector: randomVector(rand),
				users: [],
			});
		}
		targetRows = rows.filter((r) => r.tenant === TENANT_VISIBLE);

		for (let start = 0; start < rows.length; start += INSERT_BATCH) {
			const batch = rows.slice(start, start + INSERT_BATCH);
			const placeholders: string[] = [];
			const params: unknown[] = [];
			batch.forEach((row, i) => {
				const b = i * 5;
				placeholders.push(
					`($${b + 1},$${b + 2},$${b + 2},TRUE,'recall test',` +
						`$${b + 3}::vector,to_tsvector('simple','recall test'),` +
						`$${b + 4}::text[],'{}'::text[],$${b + 5},'chunk')`,
				);
				params.push(
					row.tenant,
					row.reference,
					JSON.stringify(row.vector),
					row.users,
					`u${start + i}`,
				);
			});
			await pool.query(
				`INSERT INTO "${table}"
				   (tenant_id, reference, base_ref, is_latest, content, vector,
				    ts_search, allowed_users, allowed_groups, unit_id, unit_type)
				 VALUES ${placeholders.join(",")}`,
				params,
			);
		}
		// Fresh statistics: without ANALYZE the planner badly underestimates the
		// tenant selectivity and picks bitmap+sort instead of HNSW.
		await pool.query(`ANALYZE "${table}"`);
	}, 180_000);

	afterAll(async () => {
		await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
		await pg?.close();
		await pool?.end();
	});

	/**
	 * Cross-check: the dense search must run through the HNSW index. A seq
	 * scan would be exact and make the recall test meaningless.
	 */
	async function expectHnswIndexScan(): Promise<void> {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET LOCAL hnsw.ef_search = 100");
			await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
			// EXPLAIN in exactly the form buildDenseQuery produces:
			// ORDER BY (vector <=> $2::vector) ASC, id ASC; only this raw
			// distance ordering is HNSW-index compatible (the similarity
			// expression `1 - dist` is not).
			const res = await client.query<{ plan: unknown[] }>(
				`EXPLAIN (FORMAT JSON)
				 SELECT id FROM "${table}"
				 WHERE tenant_id = $1 AND is_latest = TRUE
				 ORDER BY (vector <=> $2::vector) ASC, id ASC
				 LIMIT $3`,
				[TENANT_VISIBLE, JSON.stringify(QUERY_VECTOR), TOP_K],
			);
			await client.query("COMMIT");
			const planText = JSON.stringify(res.rows);
			// The plan must use an index scan over one of the HNSW indexes
			// (full or partial `*_vector_latest_hnsw_idx`); no bitmap/seq.
			expect(planText).toContain("Index Scan");
			expect(planText).toMatch(/_hnsw_idx/);
			expect(planText).not.toContain("Bitmap");
		} finally {
			await client.release();
		}
	}

	async function recallOf(scope: AccessScope, visible: Row[]): Promise<number> {
		const res = await pg.search(
			"recall test",
			QUERY_VECTOR,
			TOP_K,
			collection,
			scope,
			undefined,
			false, // dense: no hybrid, no FTS
		);
		if (!res.ok) throw new Error(`search fehlgeschlagen: ${JSON.stringify(res.error)}`);
		const exact = new Set(exactTopK(visible, TOP_K));
		const hits = res.result.filter((r) => exact.has(r.reference)).length;
		return hits / TOP_K;
	}

	it("uses the HNSW index for the dense search (no seq scan)", async () => {
		await expectHnswIndexScan();
	}, 60_000);

	it("tenant filter (~4.7 % selectivity): iterative scan ≥ 95 % exact recall", async () => {
		// Service scope: purely tenant selective (would see all rows of the tenant,
		// including ACL-protected ones); the tenant filter is the only selector here.
		const visible = targetRows;
		const recall = await recallOf({ ...userScope(TENANT_VISIBLE), service: true }, visible);
		// 95 % of TOP_K = 20 → at least 19 of the true top 20.
		expect(recall).toBeGreaterThanOrEqual(0.95);
	}, 120_000);

	it("tenant + ACL filter (~2.4 % selectivity): ≥ 95 % exact recall", async () => {
		const visible = targetRows.filter((r) => r.users.includes("alice"));
		const recall = await recallOf(userScope(TENANT_VISIBLE, "alice"), visible);
		expect(recall).toBeGreaterThanOrEqual(0.95);
	}, 120_000);
});
