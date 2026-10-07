// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Recall unter selektivem Filter (task 6.5, Requirement 4.11):
 *
 *   Ein dichte HNSW-Suche mit stark selektivem Tenant-/ACL-Filter muss mit
 *   iterativem Scan (Default `relaxed_order`, task 6.4) mindestens 95 % des
 *   ungefilterten Exakt-Recall erreichen — also ≥ 95 % der echten Top-K Nachbarn
 *   innerhalb der sichtbaren Zeilen finden.
 *
 * Aufbau: eine Collection mit ~21 000 Zeilen, davon gehören 1 000 zum sichtbaren
 * Tenant (≈ 4,7 % Selektivität). Ohne iterativen Scan würde die ANN-Suche nach
 * dem ef_search-Fenster abbrechen und deutlich weniger als `limit` sichtbare
 * Zeilen liefern; der iterative Scan expandiert weiter, bis `limit` erfüllt ist.
 *
 * Die Exakt-Baseline wird deterministisch per Brute-Force im Test berechnet
 * (cosine similarity über alle sichtbaren Zeilen) — unabhängig davon, welchen
 * Plan die Datenbank wählt. Ein EXPLAIN-Gegencheck stellt sicher, dass die
 * Suche tatsächlich über den HNSW-Index läuft (bei einem Seq-Scan wäre der
 * Test bedeutungslos, weil er per Definition exakt wäre).
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

/** Brute-Force-Exakt-Top-K (cosine) über allen sichtbaren Zeilen. */
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
				// ACL-selektiv: nur die Alice-Hälfte ist für Scope alice sichtbar.
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
		// Frische Statistiken: ohne ANALYZE schätzt der Planner die Tenant-
		// Selektivität massiv zu niedrig und wählt Bitmap+Sort statt HNSW.
		await pool.query(`ANALYZE "${table}"`);
	}, 180_000);

	afterAll(async () => {
		await pool?.query(`DROP TABLE IF EXISTS "${table}" CASCADE`).catch(() => {});
		await pg?.close();
		await pool?.end();
	});

	/**
	 * Gegencheck: die dichte Suche muss über den HNSW-Index laufen. Ein
	 * Seq-Scan wäre exakt und würde den Recall-Test bedeutungslos machen.
	 */
	async function expectHnswIndexScan(): Promise<void> {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET LOCAL hnsw.ef_search = 100");
			await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
			// EXPLAIN in exakt der Form, die buildDenseQuery erzeugt:
			// ORDER BY (vector <=> $2::vector) ASC, id ASC — nur diese rohe
			// Distanzsortierung ist HNSW-indexkompatibel (die Similarität-
			// Expression `1 - dist` ist es nicht).
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
			// Der Plan muss einen Index-Scan über einen der HNSW-Indizes nutzen
			// (voll oder partial `*_vector_latest_hnsw_idx`) — kein Bitmap/Seq.
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
			false, // dense — kein hybrid, kein FTS
		);
		if (!res.ok) throw new Error(`search fehlgeschlagen: ${JSON.stringify(res.error)}`);
		const exact = new Set(exactTopK(visible, TOP_K));
		const hits = res.result.filter((r) => exact.has(r.reference)).length;
		return hits / TOP_K;
	}

	it("nutzt für die dichte Suche den HNSW-Index (kein Seq-Scan)", async () => {
		await expectHnswIndexScan();
	}, 60_000);

	it("Tenant-Filter (~4,7 % Selektivität): iterativer Scan ≥ 95 % Exakt-Recall", async () => {
		// Service-Scope: rein tenant-selektiv (sähe alle Zeilen des Tenants,
		// auch ACL-geschützte) — der Tenant-Filter ist hier der einzige Selektor.
		const visible = targetRows;
		const recall = await recallOf({ ...userScope(TENANT_VISIBLE), service: true }, visible);
		// 95 % von TOP_K = 20 → mindestens 19 der echten Top-20.
		expect(recall).toBeGreaterThanOrEqual(0.95);
	}, 120_000);

	it("Tenant- + ACL-Filter (~2,4 % Selektivität): ≥ 95 % Exakt-Recall", async () => {
		const visible = targetRows.filter((r) => r.users.includes("alice"));
		const recall = await recallOf(userScope(TENANT_VISIBLE, "alice"), visible);
		expect(recall).toBeGreaterThanOrEqual(0.95);
	}, 120_000);
});
