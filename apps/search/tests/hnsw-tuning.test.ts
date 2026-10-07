// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * HNSW query tuning (task 6.4, Requirements 4.1/4.2).
 *
 * Dense and binary searches must set, inside their transaction:
 *  - `SET LOCAL hnsw.iterative_scan = <configured mode>` (default
 *    `relaxed_order`, `off` disables) — but only when the installed pgvector
 *    is ≥ 0.8 (Req 4.2); older versions get `off` plus a warning.
 *  - `SET LOCAL hnsw.max_scan_tuples = <n>` (default 20 000).
 *  - `SET LOCAL hnsw.ef_search = max(efSearch, candidateLimit)` so the ANN
 *    pool is never smaller than the candidate pool the SQL requests.
 *
 * FTS-only searches touch no HNSW index and must emit no hnsw.* statements.
 *
 * The pg Pool is mocked; every statement the client sends is captured so the
 * assertions are about the exact SET LOCAL sequence per search mode.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AccessScope } from "../src/access-scope.js";
import { pgvectorVersionAtLeast } from "../src/postgres-client.js";

const query = vi.fn();
const release = vi.fn();
const end = vi.fn();

vi.mock("pg", () => ({
	Pool: class {
		on() {}
		query(...args: unknown[]) {
			return (query as (...a: unknown[]) => unknown)(...args);
		}
		async connect() {
			return { query, release };
		}
		async end() {
			end();
		}
	},
}));

const { createPostgresClient } = await import("../src/postgres-client.js");

const serviceScope: AccessScope = {
	principal: {
		userId: undefined,
		userGroups: undefined,
		tenantId: "tenant-a",
		source: "service",
	},
	userId: undefined,
	userGroups: [],
	tenantId: "tenant-a",
	service: true,
};

interface FakePgOptions {
	/** Value returned for the pgvector extversion lookup; undefined = no row. */
	extversion?: string;
	/** quantization of the collection meta row. */
	quantization?: "none" | "binary";
	vectorSize?: number | null;
}

/**
 * Capture every statement the client sends. The collection meta row and the
 * pgvector version row are answered from `options`; everything else (BEGIN,
 * SET LOCAL, the search SQL, COMMIT) returns empty rows.
 */
function installFakePg(options: FakePgOptions = {}) {
	query.mockImplementation(async (sql: string) => {
		if (sql.includes("FROM vs_collection_config")) {
			return {
				rows: [
					{
						fts_language: "simple",
						sparse_enabled: false,
						sparse_vocab_size: null,
						quantization: options.quantization ?? "none",
						vector_size: options.vectorSize ?? 3,
						allowed_users: [],
						allowed_groups: [],
						embedding_model: null,
						embedding_model_revision: null,
						index_build_version: null,
						index_algorithm: null,
						index_parameters: null,
					},
				],
			};
		}
		if (sql.includes("FROM pg_extension WHERE extname = 'vector'")) {
			return { rows: options.extversion ? [{ extversion: options.extversion }] : [] };
		}
		return { rows: [], rowCount: 0 };
	});
}

function statements(prefix: string): string[] {
	return query.mock.calls
		.map(([sql]) => String(sql).replace(/\s+/g, " ").trim())
		.filter((sql) => sql.startsWith(prefix));
}

function client(overrides: Record<string, unknown> = {}) {
	return createPostgresClient({
		connectionString: "postgres://unused",
		logger: pino({ level: "silent" }),
		statementTimeoutMs: 0,
		statsFlushIntervalMs: 3_600_000,
		...overrides,
	});
}

beforeEach(() => {
	query.mockReset();
	release.mockReset();
	end.mockReset();
});

describe("pgvectorVersionAtLeast", () => {
	it.each([
		["0.8.0", true],
		["0.8.6", true],
		["0.7.4", false],
		["0.7", false],
		["1.0.0", true],
		["0.6.2", false],
		["0.8.0-rc1", true],
		["garbage", false],
		["", false],
	] as const)("maps %s to %s against 0.8", (version, expected) => {
		expect(pgvectorVersionAtLeast(version, 0, 8)).toBe(expected);
	});
});

describe("SET LOCAL hnsw tuning (Req 4.1)", () => {
	it("dense search sets iterative_scan, max_scan_tuples and ef_search ≥ candidateLimit", async () => {
		installFakePg({ extversion: "0.8.6" });
		const postgres = client({ efSearch: 10 });
		// Plain dense: candidate window is limit + offset = 200 → ef_search 200.
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			200,
			"docs",
			serviceScope,
			undefined,
			false, // hybridSearch off → dense path
		);
		expect(result.ok).toBe(true);
		expect(statements("SET LOCAL hnsw.iterative_scan")).toEqual([
			"SET LOCAL hnsw.iterative_scan = relaxed_order",
		]);
		expect(statements("SET LOCAL hnsw.max_scan_tuples")).toEqual([
			"SET LOCAL hnsw.max_scan_tuples = 20000",
		]);
		expect(statements("SET LOCAL hnsw.ef_search")).toEqual([
			"SET LOCAL hnsw.ef_search = 200",
		]);
		await postgres.close();
	});

	it("hybrid search raises ef_search to the candidate pool size", async () => {
		installFakePg({ extversion: "0.8.6" });
		const postgres = client({ efSearch: 10 });
		// Hybrid pool: (limit + offset) * max(4, multiplier) = 50 * 4 = 200.
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			50,
			"docs",
			serviceScope,
			undefined,
			true,
			false,
			0,
			4,
		);
		expect(result.ok).toBe(true);
		expect(statements("SET LOCAL hnsw.ef_search")).toEqual([
			"SET LOCAL hnsw.ef_search = 200",
		]);
		await postgres.close();
	});

	it("binary dense search uses the binary hard cap for the pool", async () => {
		installFakePg({ extversion: "0.8.6", quantization: "binary", vectorSize: 3 });
		const postgres = client({ efSearch: 10 });
		// Binary pool: 1000 * 8 = 8000 → capped at 4000.
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			1000,
			"docs",
			serviceScope,
			undefined,
			false, // dense path with binary quantization → two-stage
		);
		expect(result.ok).toBe(true);
		expect(statements("SET LOCAL hnsw.ef_search")).toEqual([
			"SET LOCAL hnsw.ef_search = 4000",
		]);
		await postgres.close();
	});

	it("keeps the configured ef_search when it exceeds the pool", async () => {
		installFakePg({ extversion: "0.8.6" });
		const postgres = client({ efSearch: 500 });
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			10,
			"docs",
			serviceScope,
			undefined,
			false,
		);
		expect(result.ok).toBe(true);
		expect(statements("SET LOCAL hnsw.ef_search")).toEqual([
			"SET LOCAL hnsw.ef_search = 500",
		]);
		await postgres.close();
	});

	it("honours a configured strict_order mode and max_scan_tuples", async () => {
		installFakePg({ extversion: "0.8.6" });
		const postgres = client({
			hnswIterativeScan: "strict_order",
			hnswMaxScanTuples: 50_000,
		});
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			10,
			"docs",
			serviceScope,
			undefined,
			false,
		);
		expect(result.ok).toBe(true);
		expect(statements("SET LOCAL hnsw.iterative_scan")).toEqual([
			"SET LOCAL hnsw.iterative_scan = strict_order",
		]);
		expect(statements("SET LOCAL hnsw.max_scan_tuples")).toEqual([
			"SET LOCAL hnsw.max_scan_tuples = 50000",
		]);
		await postgres.close();
	});

	it("off mode emits no iterative_scan or max_scan_tuples statements", async () => {
		installFakePg({ extversion: "0.8.6" });
		const postgres = client({ hnswIterativeScan: "off" });
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			10,
			"docs",
			serviceScope,
			undefined,
			false,
		);
		expect(result.ok).toBe(true);
		expect(statements("SET LOCAL hnsw.iterative_scan")).toEqual([]);
		expect(statements("SET LOCAL hnsw.max_scan_tuples")).toEqual([]);
		// ef_search is version-independent and still applied.
		expect(statements("SET LOCAL hnsw.ef_search")).toEqual([
			"SET LOCAL hnsw.ef_search = 100",
		]);
		await postgres.close();
	});

	it("ftsOnly search emits no hnsw.* statements at all", async () => {
		installFakePg({ extversion: "0.8.6" });
		const postgres = client();
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			10,
			"docs",
			serviceScope,
			undefined,
			true,
			false,
			0,
			4,
			undefined,
			undefined,
			undefined,
			true, // ftsOnly
		);
		expect(result.ok).toBe(true);
		expect(statements("SET LOCAL hnsw.")).toEqual([]);
		await postgres.close();
	});
});

describe("pgvector version gate (Req 4.2)", () => {
	it("disables iterative scans and warns for pgvector < 0.8", async () => {
		installFakePg({ extversion: "0.7.4" });
		const warn = vi.fn();
		const logger = pino({ level: "silent" });
		logger.warn = warn;
		const postgres = client({ logger });
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			10,
			"docs",
			serviceScope,
			undefined,
			false,
		);
		expect(result.ok).toBe(true);
		// No iterative-scan GUCs on an old pgvector — setting them would abort.
		expect(statements("SET LOCAL hnsw.iterative_scan")).toEqual([]);
		expect(statements("SET LOCAL hnsw.max_scan_tuples")).toEqual([]);
		expect(statements("SET LOCAL hnsw.ef_search")).toEqual([
			"SET LOCAL hnsw.ef_search = 100",
		]);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ version: "0.7.4" }),
			expect.stringContaining("pgvector < 0.8"),
		);
		await postgres.close();
	});

	it("ensurePgvectorVersion reports the verdict and caches it", async () => {
		installFakePg({ extversion: "0.8.6" });
		const postgres = client();
		await expect(postgres.ensurePgvectorVersion()).resolves.toBe(true);
		await expect(postgres.ensurePgvectorVersion()).resolves.toBe(true);
		// Cached: exactly one version query for two calls.
		expect(
			query.mock.calls.filter(([sql]) =>
				String(sql).includes("FROM pg_extension WHERE extname = 'vector'"),
			),
		).toHaveLength(1);
		await postgres.close();
	});

	it("ensurePgvectorVersion returns null (deferred) when the extension is missing", async () => {
		installFakePg(); // no extversion row
		const postgres = client();
		await expect(postgres.ensurePgvectorVersion()).resolves.toBeNull();
		await postgres.close();
	});

	it("a missing extension row falls back to iterative scans per search", async () => {
		// Fresh database: extension created lazily with the first collection.
		// The check stays uncached; searches assume support and re-check later.
		installFakePg();
		const postgres = client();
		const result = await postgres.search(
			"test",
			[0.1, 0.2, 0.3],
			10,
			"docs",
			serviceScope,
			undefined,
			false,
		);
		expect(result.ok).toBe(true);
		expect(statements("SET LOCAL hnsw.iterative_scan")).toEqual([
			"SET LOCAL hnsw.iterative_scan = relaxed_order",
		]);
		await postgres.close();
	});
});
