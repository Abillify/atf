// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * BM25 extension detection (task 6.9, Requirement 4.7).
 *
 * FTS_RANKER=bm25 may only take effect when a BM25 extension is actually
 * installed (ParadeDB `pg_search` preferred, VectorChord-bm25 second). The
 * client detects the extension once per process, caches the verdict, and
 * falls back to `ts_rank_cd` with a single warning when bm25 was requested
 * but no extension exists. The default config (ts_rank_cd) must never run
 * the detection query at all.
 *
 * The pg Pool is mocked; the search SQL is the real builder output, so the
 * assertions pin which lexical score expression reaches PostgreSQL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AccessScope } from "../src/access-scope.js";

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
	/** Installed BM25 extension names answered for the detection query. */
	bm25Extensions?: string[];
}

function installFakePg(options: FakePgOptions = {}) {
	query.mockImplementation(async (sql: string) => {
		if (sql.includes("FROM vs_collection_config")) {
			return {
				rows: [
					{
						fts_language: "simple",
						sparse_enabled: false,
						sparse_vocab_size: null,
						quantization: "none",
						vector_size: 3,
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
		if (sql.includes("FROM pg_extension WHERE extname IN")) {
			return {
				rows: (options.bm25Extensions ?? []).map((extname) => ({ extname })),
			};
		}
		return { rows: [], rowCount: 0 };
	});
}

function searchStatements(): string[] {
	return query.mock.calls
		.map(([sql]) => String(sql).replace(/\s+/g, " ").trim())
		.filter((sql) => sql.includes('FROM "vc_docs"'));
}

function detectionQueries(): string[] {
	return query.mock.calls
		.map(([sql]) => String(sql))
		.filter((sql) => sql.includes("FROM pg_extension WHERE extname IN"));
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

/** Run an FTS-only search and return the emitted search SQL (flattened). */
async function runFtsSearch(
	postgres: ReturnType<typeof client>,
): Promise<string> {
	const result = await postgres.search(
		"mietvertrag",
		[0.1, 0.2, 0.3],
		10,
		"docs",
		serviceScope,
		undefined,
		false,
		false,
		0,
		4,
		undefined,
		undefined,
		undefined,
		true, // ftsOnly
	);
	expect(result.ok).toBe(true);
	const sqls = searchStatements();
	expect(sqls.length).toBeGreaterThanOrEqual(1);
	return sqls[0] ?? "";
}

beforeEach(() => {
	query.mockReset();
	release.mockReset();
	end.mockReset();
});

describe("BM25 extension detection (Req 4.7, task 6.9)", () => {
	it("never runs the detection query at the ts_rank_cd default", async () => {
		installFakePg();
		const postgres = client();
		const sql = await runFtsSearch(postgres);
		expect(detectionQueries()).toHaveLength(0);
		expect(sql).toContain(
			"ts_rank_cd(ts_search, websearch_to_tsquery('simple', $1), 32)",
		);
		await postgres.close();
	});

	it("uses paradedb.score when pg_search is installed", async () => {
		installFakePg({ bm25Extensions: ["pg_search"] });
		const postgres = client({ ftsRanker: "bm25" });
		const sql = await runFtsSearch(postgres);
		expect(sql).toContain("paradedb.score(id) AS text_score");
		expect(sql).toContain("content ||| $1");
		expect(sql).not.toContain("ts_rank");
		await postgres.close();
	});

	it("prefers pg_search over vchord_bm25 when both are installed", async () => {
		installFakePg({ bm25Extensions: ["vchord_bm25", "pg_search"] });
		const postgres = client({ ftsRanker: "bm25" });
		const sql = await runFtsSearch(postgres);
		expect(sql).toContain("paradedb.score(id) AS text_score");
		await postgres.close();
	});

	it("uses bm25_score for vchord_bm25", async () => {
		installFakePg({ bm25Extensions: ["vchord_bm25"] });
		const postgres = client({ ftsRanker: "bm25" });
		const sql = await runFtsSearch(postgres);
		expect(sql).toContain("bm25_score(id) AS text_score");
		await postgres.close();
	});

	it("falls back to ts_rank_cd and warns once when no extension exists", async () => {
		installFakePg(); // no BM25 extension installed
		const warn = vi.fn();
		const logger = pino({ level: "silent" });
		logger.warn = warn;
		const postgres = client({ ftsRanker: "bm25", logger });
		const first = await runFtsSearch(postgres);
		const second = await runFtsSearch(postgres);
		for (const sql of [first, second]) {
			expect(sql).toContain(
				"ts_rank_cd(ts_search, websearch_to_tsquery('simple', $1), 32)",
			);
			expect(sql).not.toContain("paradedb");
		}
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("falling back to ts_rank_cd"),
		);
		// Warn once per process, not once per query.
		expect(
			warn.mock.calls.filter((args) =>
				String(args[0]).includes("falling back to ts_rank_cd"),
			),
		).toHaveLength(1);
		await postgres.close();
	});

	it("caches the detection verdict across searches", async () => {
		installFakePg({ bm25Extensions: ["pg_search"] });
		const postgres = client({ ftsRanker: "bm25" });
		await runFtsSearch(postgres);
		await runFtsSearch(postgres);
		expect(detectionQueries()).toHaveLength(1);
		await postgres.close();
	});

	it("applies bm25 on the hybrid path too", async () => {
		installFakePg({ bm25Extensions: ["pg_search"] });
		const postgres = client({ ftsRanker: "bm25" });
		const result = await postgres.search(
			"mietvertrag",
			[0.1, 0.2, 0.3],
			10,
			"docs",
			serviceScope,
			undefined,
			true, // hybridSearch
		);
		expect(result.ok).toBe(true);
		const sql = searchStatements()[0] ?? "";
		expect(sql).toContain("paradedb.score(id) AS tscore");
		expect(sql).toContain("content ||| $2");
		await postgres.close();
	});
});
