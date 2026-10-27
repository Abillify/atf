// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// apps/search/tests/search-v2.test.ts
//
// Handler tests for /v2/search: the v2 hit shape, param/filter
// validation, include_assets modes, asset coverage (hit + referenced figures),
// small-to-big expansion passthrough, and that the v1 /search handler is
// unchanged. All against a mock PostgresClient — no live DB.

import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { createSearchV2Handler } from "../src/handlers/search-v2.js";
import { createSearchHandler } from "../src/handlers/search.js";
import type { EmbeddingClient } from "../src/embedding-client.js";
import type {
	PostgresClient,
	PostgresResponse,
	SearchResult,
	FigureUnitInfo,
} from "../src/postgres-client.js";
import { UNIT_FILTER_V2, type UnitFilterV2 } from "../src/metadata.js";

const logger = pino({ level: "silent" });

/** Assert a `find` produced a value, without a non-null assertion. */
function found<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`expected to find ${what}`);
	return value;
}

function mockEmbedding(): EmbeddingClient {
	return {
		embed: vi
			.fn()
			.mockResolvedValue({ ok: true, result: { vector: [0.1, 0.2, 0.3] } }),
		embedBatch: vi
			.fn()
			.mockResolvedValue({ ok: true, result: { vectors: [[0.1]] } }),
	} as unknown as EmbeddingClient;
}

function mockPg(
	overrides: {
		search?: PostgresResponse<SearchResult[]>;
		figures?: PostgresResponse<FigureUnitInfo[]>;
		expandRows?: PostgresResponse<
			Array<{
				unit_id: string | null;
				content: string;
				page_start: number | null;
				page_end: number | null;
			}>
		>;
	} = {},
): PostgresClient {
	return {
		ensureCollection: vi.fn(),
		upsert: vi.fn(),
		batchUpsert: vi.fn(),
		search: vi
			.fn()
			.mockResolvedValue(overrides.search ?? { ok: true, result: [] }),
		expandUnit: vi
			.fn()
			.mockResolvedValue(overrides.expandRows ?? { ok: true, result: [] }),
		lookupFigureUnits: vi
			.fn()
			.mockResolvedValue(overrides.figures ?? { ok: true, result: [] }),
		delete: vi.fn(),
		getIngestStats: vi.fn(),
		getSearchStats: vi.fn(),
		listCollections: vi.fn(),
		deleteCollection: vi.fn(),
		ping: vi.fn(),
		close: vi.fn(),
		getStatsCounters: vi
			.fn()
			.mockReturnValue({ ingestTotal: 0, searchTotal: 0, flushErrors: 0 }),
		recordSearchStat: vi.fn(),
	} as unknown as PostgresClient;
}

function mockReq(body: unknown, headers: Record<string, string> = {}) {
	return {
		body,
		headers,
		locals: {},
		principal: {
			userId: undefined,
			userGroups: undefined,
			tenantId: "t1",
			source: "service",
		},
	} as unknown as import("express").Request;
}

function mockRes() {
	const res = {
		statusCode: 200,
		body: null as unknown,
		locals: {} as Record<string, unknown>,
	};
	const r = res as typeof res & {
		status: (c: number) => typeof r;
		json: (d: unknown) => typeof r;
	};
	r.status = (c) => {
		r.statusCode = c;
		return r;
	};
	r.json = (d) => {
		r.body = d;
		return r;
	};
	return r;
}

function figureHit(): SearchResult {
	return {
		id: "10",
		score: 0.9,
		content: "Abbildung 12: Maske WE01\nEingabefelder …",
		metadata: {
			unit_id: "u-fig-1",
			unit_type: "figure",
			section_path: ["4 Antragseingang", "4.2 Anmeldung"],
			page_start: 37,
			page_end: 37,
			figure_id: "fig-12",
			figure_kind: "ui_mask",
			asset_id: "asset-fig-12",
			prev_unit_id: "u-prev",
			next_unit_id: "u-next",
			parent_unit_id: "u-sec",
			section_id: "sec-4-2",
		},
		evidence: {
			reference: "doc-1#u-fig-1",
			root_document_id: "doc-1",
			page_start: 37,
			page_end: 37,
			section_path: ["4 Antragseingang", "4.2 Anmeldung"],
			figure_id: "fig-12",
			asset_id: "asset-fig-12",
			bbox: [0.1, 0.2, 0.3, 0.4],
		},
		reference: "doc-1#u-fig-1",
		base_ref: "doc-1",
		title: "Maske WE01",
		created: new Date(),
		modified: new Date(),
	} as unknown as SearchResult;
}

function chunkHitWithRefs(): SearchResult {
	return {
		id: "11",
		score: 0.8,
		content: "Der Antragseingang beginnt mit der Anmeldung [Abbildung fig-12].",
		metadata: {
			unit_id: "u-chunk-1",
			unit_type: "chunk",
			section_path: ["4 Antragseingang", "4.2 Anmeldung"],
			page_start: 37,
			page_end: 38,
			prev_unit_id: "u-c0",
			next_unit_id: "u-c2",
			section_id: "sec-4-2",
		},
		evidence: {
			reference: "doc-1#u-chunk-1",
			root_document_id: "doc-1",
			page_start: 37,
			page_end: 38,
			section_path: ["4 Antragseingang", "4.2 Anmeldung"],
			figure_refs: [{ figure_id: "fig-12", asset_id: "asset-fig-12" }],
			asset_ids: ["asset-fig-12"],
		},
		reference: "doc-1#u-chunk-1",
		base_ref: "doc-1",
		title: "4.2 Anmeldung",
		created: new Date(),
		modified: new Date(),
	} as unknown as SearchResult;
}

describe("/v2/search handler", () => {
	it("never logs the raw query or the acting identity", async () => {
		const lines: string[] = [];
		const capture = pino(
			{ level: "trace" },
			{ write: (line: string) => void lines.push(line) },
		);
		const handler = createSearchV2Handler(mockEmbedding(), mockPg(), capture, {
			rerankerClient: null,
		});
		const req = mockReq({ query: "Kündigung Max Mustermann" });
		(req as unknown as { principal: unknown }).principal = {
			userId: "max@example.test",
			userGroups: ["hr-confidential"],
			tenantId: "t1",
			source: "jwt",
		};
		await handler(req as never, mockRes() as never, vi.fn());

		const logged = lines.join("\n");
		expect(logged).toContain("Incoming v2 search query");
		expect(logged).not.toContain("Mustermann");
		expect(logged).not.toContain("max@example.test");
		expect(logged).not.toContain("hr-confidential");
	});

	it("returns the v2 hit shape (section_path, pages, unit_type, assets, navigation, evidence)", async () => {
		const pg = mockPg({ search: { ok: true, result: [chunkHitWithRefs()] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger, {
			rerankerClient: null,
		});
		const res = mockRes();
		await handler(
			mockReq({ query: "anmeldung" }) as never,
			res as never,
			vi.fn(),
		);

		expect(res.statusCode).toBe(200);
		const body = res.body as { results: Array<Record<string, unknown>> };
		expect(body.results).toHaveLength(1);
		const hit = body.results[0];
		expect(hit.unit_type).toBe("chunk");
		expect(hit.section_path).toEqual(["4 Antragseingang", "4.2 Anmeldung"]);
		expect(hit.pages).toEqual({ start: 37, end: 38 });
		expect(hit.navigation).toMatchObject({
			prev_unit_id: "u-c0",
			next_unit_id: "u-c2",
			section_id: "sec-4-2",
		});
		expect(hit.evidence).toBeTruthy();
		expect(Array.isArray(hit.assets)).toBe(true);
	});

	it("rejects an invalid granularity / expand / unit_type with 400", async () => {
		const handler = createSearchV2Handler(mockEmbedding(), mockPg(), logger);

		for (const body of [
			{ query: "x", granularity: "paragraph" },
			{ query: "x", expand: "everything" },
			{ query: "x", filters: { unit_type: "sentence" } },
			{ query: "x", include_assets: "all" },
			{ query: "x", budget_chars: -5 },
			{ query: "x", filters: { pages: [5, 2] } },
			{ query: "" },
		]) {
			const res = mockRes();
			await handler(mockReq(body) as never, res as never, vi.fn());
			expect(res.statusCode, JSON.stringify(body)).toBe(400);
			expect(res.body).toHaveProperty("error");
		}
	});

	it("maps unit_type / figure_kind / pages / section_prefix onto the search filter", async () => {
		const pg = mockPg({ search: { ok: true, result: [] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({
				query: "x",
				filters: {
					unit_type: "figure",
					figure_kind: "ui_mask",
					pages: { start: 37, end: 38 },
					section_prefix: ["4 Antragseingang"],
				},
			}) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(200);
		const call = (pg.search as ReturnType<typeof vi.fn>).mock.calls[0];
		const filter = call[5] as Record<string | symbol, unknown>;
		const unit = filter[UNIT_FILTER_V2] as UnitFilterV2;
		expect(unit).toMatchObject({
			unitType: "figure",
			figureKind: "ui_mask",
			pageStart: 37,
			pageEnd: 38,
			sectionPrefix: ["4 Antragseingang"],
		});
	});

	it("granularity applies as a unit_type filter when no explicit unit_type", async () => {
		const pg = mockPg({ search: { ok: true, result: [] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "x", granularity: "section" }) as never,
			res as never,
			vi.fn(),
		);
		const call = (pg.search as ReturnType<typeof vi.fn>).mock.calls[0];
		const filter = call[5] as Record<string | symbol, unknown>;
		expect((filter[UNIT_FILTER_V2] as UnitFilterV2).unitType).toBe("section");
	});

	it("folds an explicit identifier into the query text (for the 3.4 identifier RRF)", async () => {
		const pg = mockPg({ search: { ok: true, result: [] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "maske", filters: { identifier: "WE-01/A" } }) as never,
			res as never,
			vi.fn(),
		);
		const call = (pg.search as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(String(call[0])).toContain("WE-01/A");
	});

	it("include_assets=none omits the assets field and skips the figure lookup", async () => {
		const pg = mockPg({ search: { ok: true, result: [chunkHitWithRefs()] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "x", include_assets: "none" }) as never,
			res as never,
			vi.fn(),
		);
		const hit = (res.body as { results: Array<Record<string, unknown>> })
			.results[0];
		expect(hit.assets).toBeUndefined();
		expect(pg.lookupFigureUnits).not.toHaveBeenCalled();
	});

	it("honours X-Valid-At (temporal scope, as on /search) and passes it to the candidate query", async () => {
		const pg = mockPg({ search: { ok: true, result: [chunkHitWithRefs()] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq(
				{ query: "x" },
				{ "x-valid-at": "2026-03-01T00:00:00+01:00" },
			) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode ?? 200).toBe(200);
		const call = (pg.search as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
		// Positional argument 19 of PostgresClient.search is `validAt`.
		expect(call[19]).toBe("2026-02-28T23:00:00.000Z");
	});
	it("search without X-Valid-At leaves the temporal scope open", async () => {
		const pg = mockPg({ search: { ok: true, result: [chunkHitWithRefs()] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		await handler(
			mockReq({ query: "x" }) as never,
			mockRes() as never,
			vi.fn(),
		);
		const call = (pg.search as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
		expect(call[19]).toBeUndefined();
	});
	it("rejects an X-Valid-At without a timezone with 400", async () => {
		const pg = mockPg({ search: { ok: true, result: [] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "x" }, { "x-valid-at": "2026-03-01T00:00:00" }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(400);
		expect(String((res.body as { error: string }).error)).toContain("X-Valid-At");
		expect(pg.search).not.toHaveBeenCalled();
	});
	it("include_assets=refs returns asset ids/refs without URLs", async () => {
		const pg = mockPg({ search: { ok: true, result: [chunkHitWithRefs()] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "x", include_assets: "refs" }) as never,
			res as never,
			vi.fn(),
		);
		const hit = (res.body as { results: Array<Record<string, unknown>> })
			.results[0];
		const assets = hit.assets as Array<Record<string, unknown>>;
		expect(assets).toHaveLength(1);
		expect(assets[0].asset_id).toBe("asset-fig-12");
		expect(assets[0].relation).toBe("referenced");
		expect(assets[0].thumb_url).toBeUndefined();
		expect(assets[0].url).toBeUndefined();
	});

	it("include_assets=thumbnails carries kind/figure_kind/caption/page/bbox + thumb_url/url and covers hit + referenced figures", async () => {
		// A figure HIT that also references another figure. The referenced figure's
		// metadata is resolved via lookupFigureUnits.
		const hit = figureHit();
		(hit.evidence as { figure_refs?: unknown }).figure_refs = [
			{ figure_id: "fig-99", asset_id: "asset-fig-99" },
		];
		const pg = mockPg({
			search: { ok: true, result: [hit] },
			figures: {
				ok: true,
				result: [
					{
						figure_id: "fig-99",
						asset_id: "asset-fig-99",
						figure_kind: "bpmn",
						caption: "Abbildung 99: Prozess",
						page: 40,
						bbox: [0.5, 0.5, 0.6, 0.6],
					},
				],
			},
		});
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq(
				{ query: "x", include_assets: "thumbnails" },
				{ "x-collection": "docs" },
			) as never,
			res as never,
			vi.fn(),
		);
		const result = (res.body as { results: Array<Record<string, unknown>> })
			.results[0];
		const assets = result.assets as Array<Record<string, unknown>>;
		// Hit figure + referenced figure.
		expect(assets).toHaveLength(2);
		const hitAsset = found(
			assets.find((a) => a.relation === "hit"),
			"hit asset",
		);
		expect(hitAsset).toMatchObject({
			asset_id: "asset-fig-12",
			kind: "figure",
			figure_kind: "ui_mask",
			caption: "Maske WE01",
			page: 37,
			bbox: [0.1, 0.2, 0.3, 0.4],
		});
		expect(String(hitAsset.thumb_url)).toContain("/v2/assets/asset-fig-12");
		expect(String(hitAsset.thumb_url)).toContain("variant=thumb");
		expect(String(hitAsset.url)).toContain("variant=full");
		expect(String(hitAsset.url)).toContain("collection=docs");

		const refAsset = found(
			assets.find((a) => a.relation === "referenced"),
			"referenced asset",
		);
		expect(refAsset).toMatchObject({
			asset_id: "asset-fig-99",
			figure_kind: "bpmn",
			caption: "Abbildung 99: Prozess",
			page: 40,
			bbox: [0.5, 0.5, 0.6, 0.6],
		});
	});

	it("expand populates expanded.{text/content, truncated}", async () => {
		const pg = mockPg({
			search: { ok: true, result: [chunkHitWithRefs()] },
			expandRows: {
				ok: true,
				result: [
					{
						unit_id: "u-c0",
						content: "Vorheriger Absatz.",
						page_start: 37,
						page_end: 37,
					},
					{
						unit_id: "u-chunk-1",
						content: "Der Antragseingang…",
						page_start: 37,
						page_end: 38,
					},
					{
						unit_id: "u-c2",
						content: "Nächster Absatz.",
						page_start: 38,
						page_end: 38,
					},
				],
			},
		});
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "x", expand: "neighbors", budget_chars: 5000 }) as never,
			res as never,
			vi.fn(),
		);
		const hit = (res.body as { results: Array<Record<string, unknown>> })
			.results[0];
		const expanded = hit.expanded as {
			content: string;
			truncated: boolean;
			mode: string;
		};
		expect(expanded).toBeTruthy();
		expect(expanded.mode).toBe("neighbors");
		expect(expanded.content).toContain("Vorheriger Absatz.");
		expect(expanded.content).toContain("Nächster Absatz.");
		expect(expanded.truncated).toBe(false);
	});

	it("returns 404, not a provenance error, for a collection that does not exist", async () => {
		const pg = mockPg({
			search: {
				ok: false,
				error: { code: "COLLECTION_NOT_FOUND", message: 'Collection "nope" not found' },
			} as never,
		});
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(mockReq({ query: "x" }) as never, res as never, vi.fn());
		expect(res.statusCode).toBe(404);
	});

	it("returns 502 when embedding fails", async () => {
		const embed = {
			embed: vi
				.fn()
				.mockResolvedValue({ ok: false, error: { message: "down" } }),
			embedBatch: vi.fn(),
		} as unknown as EmbeddingClient;
		const handler = createSearchV2Handler(embed, mockPg(), logger);
		const res = mockRes();
		await handler(mockReq({ query: "x" }) as never, res as never, vi.fn());
		expect(res.statusCode).toBe(502);
	});
});

// ─── v1 /search regression: the v2 work must not change v1 (Requirement 13.7) ──

describe("/search v1 is unchanged by the v2 work", () => {
	function v1Pg(result: SearchResult[]): PostgresClient {
		return {
			ensureCollection: vi.fn(),
			upsert: vi.fn(),
			batchUpsert: vi.fn(),
			search: vi.fn().mockResolvedValue({ ok: true, result }),
			expandUnit: vi.fn().mockResolvedValue({ ok: true, result: [] }),
			lookupFigureUnits: vi.fn().mockResolvedValue({ ok: true, result: [] }),
			delete: vi.fn(),
			getIngestStats: vi.fn(),
			getSearchStats: vi.fn(),
			listCollections: vi.fn(),
			deleteCollection: vi.fn(),
			ping: vi.fn(),
			close: vi.fn(),
			getStatsCounters: vi
				.fn()
				.mockReturnValue({ ingestTotal: 0, searchTotal: 0, flushErrors: 0 }),
			recordSearchStat: vi.fn(),
		} as unknown as PostgresClient;
	}

	function v1Req(body: string, headers: Record<string, string> = {}) {
		return {
			body,
			headers,
			locals: {},
			principal: {
				userId: undefined,
				userGroups: undefined,
				tenantId: "t1",
				source: "service",
			},
		} as unknown as import("express").Request;
	}

	it("returns { results } as a flat SearchResult array with no v2 fields", async () => {
		const results: SearchResult[] = [
			{
				id: "1",
				score: 0.95,
				content: "# Doc\nContent",
				metadata: { unit_type: "chunk", section_path: ["A"], asset_id: "z" },
				evidence: { reference: "doc-1", root_document_id: "doc-1" },
				reference: "doc-1",
				base_ref: "doc-1",
				created: new Date(),
				modified: new Date(),
			} as unknown as SearchResult,
		];
		const handler = createSearchHandler(
			mockEmbedding(),
			v1Pg(results),
			logger,
			{
				rerankerClient: null,
			},
		);
		const res = mockRes();
		await handler(v1Req("query") as never, res as never, vi.fn());
		expect(res.statusCode).toBe(200);
		const body = res.body as { results: Array<Record<string, unknown>> };
		// v1 returns the raw SearchResult objects verbatim — no v2 `assets`,
		// `navigation`, `pages`, or `section_path` reshaping, and no expansion when
		// X-Expand is absent.
		const hit = body.results[0];
		expect(hit).toMatchObject({
			id: "1",
			reference: "doc-1",
			content: "# Doc\nContent",
		});
		expect(hit.assets).toBeUndefined();
		expect(hit.navigation).toBeUndefined();
		expect(hit.pages).toBeUndefined();
		expect(hit.expanded).toBeUndefined();
	});

	it("never enables the identifier RRF list (Req 13.7: v1 ranking unchanged)", async () => {
		const pg = v1Pg([]);
		const handler = createSearchHandler(mockEmbedding(), pg, logger, {
			rerankerClient: null,
		});
		const res = mockRes();
		await handler(v1Req("Maske WE-01/A") as never, res as never, vi.fn());
		const call = (pg.search as ReturnType<typeof vi.fn>).mock.calls[0];
		const opts = call[20] as { identifierList?: boolean } | undefined;
		expect(opts?.identifierList).not.toBe(true);
	});
});

// ─── follow-up fixes: identifier list, group_by, budget clamp, tokenizer ──────

describe("/v2/search · identifier list, group_by, budget clamp, tokenizer", () => {
	const searchOpts = (pg: PostgresClient) =>
		(pg.search as ReturnType<typeof vi.fn>).mock.calls[0][20] as
			| { identifierList?: boolean; identifiers?: string[] }
			| undefined;

	it("enables the identifier list and passes the explicit identifier through", async () => {
		const pg = mockPg();
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		await handler(
			mockReq({ query: "maske", filters: { identifier: "we-01/a" } }) as never,
			mockRes() as never,
			vi.fn(),
		);
		expect(searchOpts(pg)).toEqual({ identifierList: true, identifiers: ["we-01/a"] });
	});

	it("identifier_search=false opts out; a non-boolean is a 400", async () => {
		const pg = mockPg();
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		await handler(
			mockReq({ query: "WE01", identifier_search: false }) as never,
			mockRes() as never,
			vi.fn(),
		);
		expect(searchOpts(pg)?.identifierList).toBe(false);
		const res = mockRes();
		await handler(
			mockReq({ query: "x", identifier_search: "yes" }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(400);
	});

	it("clamps budget_chars to MAX_EXPAND_BUDGET_CHARS", async () => {
		const pg = mockPg({
			search: { ok: true, result: [chunkHitWithRefs()] },
			expandRows: {
				ok: true,
				result: [{ unit_id: "u-c0", content: "Nachbar.", page_start: 37, page_end: 37 }],
			},
		});
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "x", expand: "neighbors", budget_chars: 1_000_000_000 }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(200);
		const hit = (res.body as { results: Array<Record<string, unknown>> }).results[0];
		expect((hit.expanded as { budget_chars: number }).budget_chars).toBe(200_000);
	});

	it("group_by=section merges a section's hits (best score, document order)", async () => {
		const a = chunkHitWithRefs(); // u-chunk-1, p37, score 0.8, sec-4-2
		const b = {
			...chunkHitWithRefs(),
			id: "12",
			score: 0.6,
			content: "Frühere Stelle.",
			metadata: { ...chunkHitWithRefs().metadata, unit_id: "u-chunk-0", page_start: 36, page_end: 36 },
		} as unknown as SearchResult;
		const pg = mockPg({ search: { ok: true, result: [a, b] } });
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "x", group_by: "section", include_assets: "none" }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(200);
		const results = (res.body as { results: Array<Record<string, unknown>> }).results;
		expect(results).toHaveLength(1);
		expect(results[0].score).toBe(0.8);
		expect(String(results[0].content).indexOf("Frühere Stelle.")).toBe(0);
		expect(results[0].group).toMatchObject({
			by: "section",
			key: "sec-4-2",
			count: 2,
			unit_ids: ["u-chunk-0", "u-chunk-1"],
		});
	});

	it("rejects an invalid group_by with 400", async () => {
		const handler = createSearchV2Handler(mockEmbedding(), mockPg(), logger);
		const res = mockRes();
		await handler(mockReq({ query: "x", group_by: "page" }) as never, res as never, vi.fn());
		expect(res.statusCode).toBe(400);
	});

	it("trims rerank inputs with the tokenizer but returns the untrimmed content", async () => {
		const long = {
			...chunkHitWithRefs(),
			id: "long",
			content: "w".repeat(20_000),
		} as unknown as SearchResult;
		const short = { ...figureHit(), id: "short" } as unknown as SearchResult;
		const pg = mockPg({ search: { ok: true, result: [long, short] } });
		const rerank = vi.fn(async (_q: string, docs: string[]) => ({
			ok: true as const,
			result: docs.map((_d, index) => ({ index, score: index === 0 ? 0.99 : 0.5 })),
		}));
		const tokenCounter = {
			cacheSize: 0,
			count: async (t: string) => Math.ceil(t.length / 2),
			countBatch: async (ts: string[]) => ts.map((t) => Math.ceil(t.length / 2)),
		};
		const handler = createSearchV2Handler(mockEmbedding(), pg, logger, {
			rerankerClient: { rerank } as never,
			tokenCounter,
		});
		const res = mockRes();
		await handler(
			mockReq({ query: "x", rerank: true, include_assets: "none" }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(200);
		const docs = rerank.mock.calls[0][1] as string[];
		// 1024 tokens at 2 chars/token → at most 2048 chars reach the reranker.
		expect(docs[0].length).toBeLessThanOrEqual(2048);
		const results = (res.body as { results: Array<Record<string, unknown>> }).results;
		const longHit = found(results.find((r) => String(r.content).startsWith("w")), "long hit");
		expect(String(longHit.content).length).toBe(20_000);
		expect(longHit.score).toBe(0.99);
	});
});

describe("/v2/search · optional HyDE expansion", () => {
	const hydeOk = (result: string) => ({
		expand: vi.fn(async () => ({ ok: true as const, result })),
	});

	it("embeds the expansion while the lexical branch keeps the original query", async () => {
		const embedding = mockEmbedding();
		const pg = mockPg();
		const hydeClient = hydeOk("Die Buchung laeuet ueber das Modul Antragseingang.");
		const handler = createSearchV2Handler(embedding, pg, logger, {
			hydeClient: hydeClient as never,
		});
		const res = mockRes();
		await handler(
			mockReq({ query: "antragseingang buchung", hyde: true }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(200);
		expect(hydeClient.expand).toHaveBeenCalledWith(
			"antragseingang buchung",
			"t1",
		);
		expect(embedding.embed).toHaveBeenCalledWith(
			"Die Buchung laeuet ueber das Modul Antragseingang.",
		);
		// The PostgreSQL lexical branch still receives the original query.
		expect((pg.search as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
			"antragseingang buchung",
		);
		expect(res.body).toMatchObject({ hyde_applied: true });
	});

	it("reports hyde_applied false when no HyDE client is configured", async () => {
		const handler = createSearchV2Handler(mockEmbedding(), mockPg(), logger, {
			hydeClient: null,
		});
		const res = mockRes();
		await handler(
			mockReq({ query: "antragseingang buchung", hyde: true }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({ hyde_applied: false });
	});

	it("rejects a non-boolean hyde flag", async () => {
		const handler = createSearchV2Handler(mockEmbedding(), mockPg(), logger);
		const res = mockRes();
		await handler(
			mockReq({ query: "x", hyde: "yes" }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatchObject({ error: "hyde must be a boolean" });
	});

	it("stays out of the response and the embedding path when not requested", async () => {
		const embedding = mockEmbedding();
		const hydeClient = hydeOk("unused");
		const handler = createSearchV2Handler(embedding, mockPg(), logger, {
			hydeClient: hydeClient as never,
		});
		const res = mockRes();
		await handler(
			mockReq({ query: "antragseingang buchung" }) as never,
			res as never,
			vi.fn(),
		);
		expect(res.statusCode).toBe(200);
		expect(hydeClient.expand).not.toHaveBeenCalled();
		expect(embedding.embed).toHaveBeenCalledWith("antragseingang buchung");
		expect(res.body).not.toHaveProperty("hyde_applied");
	});
});
