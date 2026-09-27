// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/search-v2.ts
 *
 * The `/v2/search` handler (task 3.7, design §7.1/§7.2, Requirements 13.3/13.5).
 *
 * This is a NEW endpoint that orchestrates the full v2 retrieval pipeline over
 * the SAME building blocks the v1 `/search` uses — it does NOT re-implement RRF,
 * rerank, diversify or expansion, and it does NOT change v1 behaviour
 * (Requirement 13.7). The v1 handler and its response are untouched.
 *
 * Pipeline (design §7.1):
 *   1. analyse the query — recognise identifiers; an explicit `identifier`
 *      filter is folded into the query text AND passed explicitly to the
 *      identifier list;
 *   2. candidates — `postgresClient.search(...)` with `identifierList: true`
 *      (dense + ts_de + identifier RRF, where the identifier list is the union
 *      of exact `vs_identifiers` hits and `ts_ident` lexical matches; hybrid
 *      only), honouring tenant/ACL/temporal + the v2 unit filters. The v1
 *      handlers never set the option, so their ranking is unchanged;
 *   3. rerank with context — `rerankResultsWithStatus` (task 3.5), inputs
 *      trimmed by the optional tokenizer (`fitRerankInputs`);
 *   4. diversify — `diversifyResults` (task 3.5), then `group_by`
 *      (`groupResultsV2`: none | document | section);
 *   5. small-to-big expansion — `attachExpansions` (task 3.6);
 *   6. attach assets + shape the v2 response — `shapeHitV2` (this task).
 *
 * Request shape: a JSON body (the `/v2/*` document routes are JSON; a JSON body
 * is cleanest here). `X-Collection` selects the collection exactly as `/search`.
 *
 *   {
 *     "query": "…",                       // required, non-empty
 *     "limit": 10,                         // optional, 1..100
 *     "granularity": "chunk",              // chunk|section|page|document
 *     "expand": "section",                 // none|neighbors|section|page
 *     "budget_chars": 4000,                // positive integer, clamped to 200000
 *     "include_assets": "thumbnails",      // none|refs|thumbnails
 *     "group_by": "section",               // none|document|section (default none)
 *     "identifier_search": true,           // identifier RRF list (default true)
 *     "rerank": true,                      // optional
 *     "filters": {
 *       "pages": [37, 38] | { "start": 37, "end": 38 },
 *       "unit_type": "figure",             // chunk|table|figure|section|page|document
 *       "figure_kind": "ui_mask",
 *       "section_prefix": ["4 Wareneingang", "4.2 Anmeldung"],
 *       "identifier": "WE-01/A"
 *     }
 *   }
 */

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import { accessScopeForRequest } from "../access-scope.js";
import type { EmbeddingClient } from "../embedding-client.js";
import type { RerankerClient } from "../reranker-client.js";
import type { SparseEmbeddingClient } from "../sparse-embedding-client.js";
import type { QueryEmbeddingCache } from "../query-cache.js";
import type {
	PostgresClient,
	SearchFilter,
	SearchResult,
	FigureUnitInfo,
} from "../postgres-client.js";
import { prepareFtsContent } from "../postgres-client.js";
import {
	FILTER_V2,
	UNIT_FILTER_V2,
	normalizeFilterV2,
	unitFilterV2HasPredicates,
	type Metadata,
	type UnitFilterV2,
} from "../metadata.js";
import { rerankResultsWithStatus } from "./search.js";
import {
	diversifyResults,
	fitRerankInputs,
	groupResultsV2,
	type GroupByMode,
} from "../rerank-context.js";
import { attachExpansions } from "./expand-results.js";
import {
	parseExpandMode,
	DEFAULT_EXPAND_BUDGET_CHARS,
	MAX_EXPAND_BUDGET_CHARS,
	type ExpandMode,
} from "../expansion.js";
import type { TokenCounter } from "../token-counter.js";
import { readHeader } from "../header-utils.js";
import { getPrincipal } from "../request-principal.js";
import {
	shapeHitV2,
	referencedFigureIds,
	type IncludeAssets,
	type Granularity,
	type SearchHitV2,
} from "../search-v2-response.js";

export interface SearchV2HandlerOptions {
	rerankerClient?: RerankerClient | null;
	candidateMultiplier?: number;
	hybridSearch?: boolean;
	sparseClient?: SparseEmbeddingClient | null;
	queryCache?: QueryEmbeddingCache | null;
	/**
	 * Optional tokenizer (token-counter.ts). When present, the rerank inputs are
	 * trimmed to RERANK_MAX_TOKENS measured tokens (Requirement 13.2) instead of
	 * relying on the chars/4 heuristic alone.
	 */
	tokenCounter?: TokenCounter | null;
}

const GRANULARITIES: readonly Granularity[] = [
	"chunk",
	"section",
	"page",
	"document",
];
const INCLUDE_ASSETS: readonly IncludeAssets[] = ["none", "refs", "thumbnails"];
const UNIT_TYPES = ["chunk", "table", "figure", "section", "page", "document"];
const GROUP_BY: readonly GroupByMode[] = ["none", "document", "section"];

/** A validation failure carrying the HTTP 400 message. */
export class BadRequest extends Error {}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new BadRequest(`${field} must be a non-empty string`);
	}
	return value;
}

function parseGranularity(value: unknown): Granularity | undefined {
	if (value === undefined || value === null) return undefined;
	if (
		typeof value !== "string" ||
		!GRANULARITIES.includes(value as Granularity)
	) {
		throw new BadRequest(
			"granularity must be one of: chunk, section, page, document",
		);
	}
	return value as Granularity;
}

function parseIncludeAssets(value: unknown): IncludeAssets {
	if (value === undefined || value === null) return "refs";
	if (
		typeof value !== "string" ||
		!INCLUDE_ASSETS.includes(value as IncludeAssets)
	) {
		throw new BadRequest(
			"include_assets must be one of: none, refs, thumbnails",
		);
	}
	return value as IncludeAssets;
}

function parseLimit(value: unknown): number {
	if (value === undefined || value === null) return 10;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new BadRequest("limit must be a positive integer");
	}
	return Math.min(value, 100);
}

/**
 * Parse `budget_chars`: a positive integer, CLAMPED to MAX_EXPAND_BUDGET_CHARS
 * (an over-ask is bounded, not rejected — the response's `expanded.budget_chars`
 * reports the effective value).
 */
export function parseBudget(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_EXPAND_BUDGET_CHARS;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new BadRequest("budget_chars must be a positive integer");
	}
	return Math.min(value, MAX_EXPAND_BUDGET_CHARS);
}

/** Parse `group_by` (Requirement 13.6): none (default) | document | section. */
export function parseGroupBy(value: unknown): GroupByMode {
	if (value === undefined || value === null) return "none";
	if (typeof value !== "string" || !GROUP_BY.includes(value as GroupByMode)) {
		throw new BadRequest("group_by must be one of: none, document, section");
	}
	return value as GroupByMode;
}

/**
 * Parse the `filters` object into a {@link UnitFilterV2} + the resolved
 * `identifier`. Throws {@link BadRequest} on an invalid value. `pages` accepts
 * either `[start, end]` / `[page]` or `{ start, end }`.
 */
export function parseFilters(raw: unknown): {
	unit: UnitFilterV2;
	identifier?: string;
} {
	if (raw === undefined || raw === null) return { unit: {} };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new BadRequest("filters must be an object");
	}
	const f = raw as Record<string, unknown>;
	const unit: UnitFilterV2 = {};

	if (f.unit_type !== undefined && f.unit_type !== null) {
		if (typeof f.unit_type !== "string" || !UNIT_TYPES.includes(f.unit_type)) {
			throw new BadRequest(
				"filters.unit_type must be one of: chunk, table, figure, section, page, document",
			);
		}
		unit.unitType = f.unit_type;
	}

	if (f.figure_kind !== undefined && f.figure_kind !== null) {
		if (typeof f.figure_kind !== "string" || f.figure_kind.trim() === "") {
			throw new BadRequest("filters.figure_kind must be a non-empty string");
		}
		unit.figureKind = f.figure_kind;
	}

	if (f.section_prefix !== undefined && f.section_prefix !== null) {
		const sp = f.section_prefix;
		if (
			!Array.isArray(sp) ||
			sp.length === 0 ||
			sp.some((s) => typeof s !== "string" || s === "")
		) {
			throw new BadRequest(
				"filters.section_prefix must be a non-empty array of strings",
			);
		}
		unit.sectionPrefix = sp as string[];
	}

	if (f.pages !== undefined && f.pages !== null) {
		const { start, end } = parsePages(f.pages);
		unit.pageStart = start;
		unit.pageEnd = end;
	}

	let identifier: string | undefined;
	if (f.identifier !== undefined && f.identifier !== null) {
		if (typeof f.identifier !== "string" || f.identifier.trim() === "") {
			throw new BadRequest("filters.identifier must be a non-empty string");
		}
		identifier = f.identifier.trim();
	}

	return { unit, identifier };
}

/** Parse a `pages` filter into an inclusive `{ start, end }` page range. */
function parsePages(value: unknown): { start: number; end: number } {
	const isPage = (n: unknown): n is number =>
		typeof n === "number" && Number.isInteger(n) && n >= 1;
	if (Array.isArray(value)) {
		if (value.length === 1 && isPage(value[0]))
			return { start: value[0], end: value[0] };
		if (
			value.length === 2 &&
			isPage(value[0]) &&
			isPage(value[1]) &&
			value[1] >= value[0]
		) {
			return { start: value[0], end: value[1] };
		}
		throw new BadRequest(
			"filters.pages must be [page] or [start, end] with 1 <= start <= end",
		);
	}
	if (typeof value === "object" && value !== null) {
		const o = value as Record<string, unknown>;
		if (
			isPage(o.start) &&
			isPage(o.end) &&
			(o.end as number) >= (o.start as number)
		) {
			return { start: o.start as number, end: o.end as number };
		}
	}
	throw new BadRequest(
		"filters.pages must be [page], [start, end], or { start, end } with 1 <= start <= end",
	);
}

/** Merge the middleware metadata + optional JSON `filter`/`filter_v2` + the v2 unit filter. */
function buildFilter(
	metadata: Metadata,
	body: Record<string, unknown>,
	unit: UnitFilterV2,
): SearchFilter | undefined {
	let filter: SearchFilter | undefined;
	const metaEntries = Object.entries(metadata).filter(
		([, v]) => v !== undefined && v !== null,
	);
	if (metaEntries.length > 0) filter = Object.fromEntries(metaEntries);

	if (body.filter !== undefined && body.filter !== null) {
		if (typeof body.filter !== "object" || Array.isArray(body.filter)) {
			throw new BadRequest("filter must be an object");
		}
		filter = { ...(filter ?? {}), ...(body.filter as SearchFilter) };
	}

	if (body.filter_v2 !== undefined && body.filter_v2 !== null) {
		const filterV2 = normalizeFilterV2(body.filter_v2);
		filter = { ...(filter ?? {}) };
		(filter as SearchFilter & { [FILTER_V2]?: typeof filterV2 })[FILTER_V2] =
			filterV2;
	}

	if (unitFilterV2HasPredicates(unit)) {
		filter = { ...(filter ?? {}) };
		(filter as SearchFilter & { [UNIT_FILTER_V2]?: UnitFilterV2 })[
			UNIT_FILTER_V2
		] = unit;
	}

	return filter;
}

export function createSearchV2Handler(
	embeddingClient: EmbeddingClient,
	postgresClient: PostgresClient,
	logger: Logger,
	options: SearchV2HandlerOptions = {},
): RequestHandler {
	const rerankerClient = options.rerankerClient ?? null;
	const candidateMultiplier = options.candidateMultiplier ?? 4;
	const hybridDefault = options.hybridSearch ?? true;
	const sparseClient = options.sparseClient ?? null;
	const queryCache = options.queryCache ?? null;

	return async (req, res, next) => {
		const log: Logger = (req as { log?: Logger }).log ?? logger;
		try {
			const body = (req.body ?? {}) as Record<string, unknown>;
			if (typeof body !== "object" || Array.isArray(body)) {
				res.status(400).json({ error: "Request body must be a JSON object" });
				return;
			}

			let query: string;
			let limit: number;
			let granularity: Granularity | undefined;
			let expandMode: ExpandMode | null | undefined;
			let budgetChars: number;
			let includeAssets: IncludeAssets;
			let unitFilter: UnitFilterV2;
			let identifier: string | undefined;
			let groupBy: GroupByMode;
			try {
				query = requireString(body.query, "query");
				limit = parseLimit(body.limit);
				granularity = parseGranularity(body.granularity);
				budgetChars = parseBudget(body.budget_chars);
				includeAssets = parseIncludeAssets(body.include_assets);
				groupBy = parseGroupBy(body.group_by);
				if (
					body.identifier_search !== undefined &&
					typeof body.identifier_search !== "boolean"
				) {
					throw new BadRequest("identifier_search must be a boolean");
				}
				expandMode = parseExpandMode(
					typeof body.expand === "string" ? body.expand : undefined,
				);
				if (expandMode === null) {
					throw new BadRequest(
						"expand must be one of: none, neighbors, section, page",
					);
				}
				const parsed = parseFilters(body.filters);
				unitFilter = parsed.unit;
				identifier = parsed.identifier;
			} catch (err) {
				if (err instanceof BadRequest) {
					res.status(400).json({ error: err.message });
					return;
				}
				// normalizeFilterV2 throws MetadataValidationError → 400 too.
				res.status(400).json({ error: (err as Error).message });
				return;
			}

			// granularity restricts the returned unit level. When set, it is applied
			// as a unit_type filter (chunk|section|page|document are unit types); an
			// explicit filters.unit_type takes precedence if both are given.
			if (granularity && unitFilter.unitType === undefined) {
				unitFilter.unitType = granularity;
			}

			const collection = readHeader(req, "x-collection") || "documents";
			const rerankRequested = body.rerank === true;
			// The identifier RRF list (Req 12.3) is ON for v2 by default; the v1
			// /search handler never enables it (Req 13.7). `identifier_search:
			// false` opts out. Only the hybrid path fuses it (dense-only has no
			// list fusion).
			const identifierList = body.identifier_search !== false;
			const hybridRequested =
				typeof body.hybrid === "boolean" ? body.hybrid : hybridDefault;

			const metadata: Metadata =
				(res.locals as { metadata?: Metadata }).metadata ?? {};
			let filter: SearchFilter | undefined;
			try {
				filter = buildFilter(metadata, body, unitFilter);
			} catch (err) {
				res.status(400).json({ error: (err as Error).message });
				return;
			}

			// 1. Query analysis: fold an explicit identifier into the query text (so
			//    the dense embedding and FTS see it) AND pass it explicitly to the
			//    identifier list, so it resolves even when it does not match a
			//    recognizer class (e.g. lower-case "we-01/a").
			const searchQuery = identifier ? `${query} ${identifier}` : query;
			const embedText = prepareFtsContent(searchQuery);

			// 2. Embed the query (reusing the shared cache when configured).
			let vector: number[] = [];
			try {
				if (queryCache) {
					vector = await queryCache.getOrEmbed(embedText, async () => {
						const r = await embeddingClient.embed(embedText);
						if (!r.ok) throw new Error(r.error.message);
						return r.result.vector;
					});
				} else {
					const r = await embeddingClient.embed(embedText);
					if (!r.ok) {
						res
							.status(502)
							.json({ error: `Embedding failed: ${r.error.message}` });
						return;
					}
					vector = r.result.vector;
				}
			} catch (err) {
				log.warn({ err }, "v2 embedding failed");
				res
					.status(502)
					.json({ error: `Embedding failed: ${(err as Error).message}` });
				return;
			}

			// Sparse branch (optional, mirrors v1).
			let sparseVec = undefined;
			if (sparseClient !== null && hybridRequested) {
				const sparseRes = await sparseClient.embedSparse(embedText);
				if (sparseRes.ok) sparseVec = sparseRes.result;
				else
					log.warn(
						{ error: sparseRes.error },
						"v2 sparse embedding failed; skipping",
					);
			}

			const scope = accessScopeForRequest(req);
			const { userId, userGroups } = getPrincipal(req);
			log.info(
				{
					query,
					limit,
					collection,
					hybrid: hybridRequested,
					granularity,
					expand: expandMode,
					includeAssets,
					groupBy,
					identifierList,
					userId,
					userGroups,
				},
				"Incoming v2 search query",
			);

			// Over-fetch when reranking / diversifying so the final window can be
			// filled after collapse (same heuristic as v1).
			const rerankActive = rerankRequested && rerankerClient !== null;
			const fetchLimit = Math.min(
				limit * Math.max(1, candidateMultiplier),
				500,
			);

			// 2. Candidates — dense + ts_de + identifier RRF, tenant/ACL/temporal +
			//    the v2 unit filters. Reuses the exact same search path as v1.
			const searchResult = await postgresClient.search(
				searchQuery,
				vector,
				fetchLimit,
				collection,
				scope,
				filter,
				hybridRequested,
				false, // includeAllVersions
				0, // offset
				candidateMultiplier,
				sparseVec,
				undefined, // tags
				undefined, // cursor
				false, // ftsOnly
				undefined, // baseRef
				undefined, // pathPrefix
				undefined, // timeoutMs
				undefined, // signal
				undefined, // onPlan
				undefined, // validAt
				{
					identifierList,
					...(identifier ? { identifiers: [identifier] } : {}),
				},
			);
			if (!searchResult.ok) {
				const status =
					searchResult.error.code === "INVALID_COLLECTION_NAME" ? 400 : 502;
				log.warn({ error: searchResult.error }, "v2 search failed");
				res.status(status).json({ error: searchResult.error.message });
				return;
			}

			let results: SearchResult[] = searchResult.result;

			// 3. Rerank with context (task 3.5) — reuses rerankResultsWithStatus.
			//    With a tokenizer the inputs are trimmed to the real 1024-token
			//    budget first; the reranked (possibly trimmed) copies are mapped
			//    back to the untrimmed originals by id.
			if (rerankActive && rerankerClient !== null && results.length > 1) {
				const fitted = await fitRerankInputs(results, options.tokenCounter);
				const outcome = await rerankResultsWithStatus(
					rerankerClient,
					query,
					fitted,
					log,
				);
				results = restoreOriginalContent(outcome.results, results);
			}

			// 4. Diversify (task 3.5): collapse same table/figure + cap per section.
			//    With group_by the per-section cap is lifted: the group merges all
			//    of a section's (or document's) hits instead of dropping them.
			results = diversifyResults(
				results,
				groupBy === "none" ? {} : { perSectionCap: 0 },
			);
			// 4b. group_by (Req 13.6): merge per document / section, best score,
			//     content in document order.
			results = groupResultsV2(results, groupBy);
			results = results.slice(0, limit);

			// 5. Small-to-big expansion (task 3.6) — reuses attachExpansions.
			let expanded =
				results as import("./expand-results.js").ExpandedSearchResult[];
			if (expandMode !== undefined) {
				expanded = await attachExpansions({
					postgresClient,
					collection,
					scope,
					mode: expandMode,
					budgetChars,
					includeAllVersions: false,
					results,
					logger: log,
				});
			}

			// 6. Attach assets (Requirement 13.5): resolve the REFERENCED figures once
			//    (batched by base_ref) so each hit's assets carry figure_kind/caption/
			//    page/bbox, then shape the v2 response. Skipped entirely for
			//    include_assets=none (no figure lookup, no assets field).
			const figureInfo = new Map<string, FigureUnitInfo>();
			if (includeAssets !== "none") {
				await resolveReferencedFigures(
					postgresClient,
					collection,
					scope,
					expanded,
					figureInfo,
					log,
				);
			}

			const hits: SearchHitV2[] = expanded.map((r) =>
				shapeHitV2(r, { collection, includeAssets, figureInfo }),
			);

			if (scope.tenantId) {
				postgresClient.recordSearchStat({
					tenantId: scope.tenantId,
					collection,
					query,
					durationMs: 0,
					resultsCount: hits.length,
					hybridSearch: hybridRequested,
					reranked: rerankActive,
				});
			}

			res.status(200).json({ results: hits });
		} catch (err) {
			next(err);
		}
	};
}

/**
 * Resolve the referenced figures for a set of hits, grouped by document, into
 * `figureInfo` (figure_id → metadata). One lookup per distinct base_ref keeps
 * the ACL/visibility gates per document while avoiding an N+1 per figure.
 */
export async function resolveReferencedFigures(
	postgresClient: PostgresClient,
	collection: string,
	scope: ReturnType<typeof accessScopeForRequest>,
	results: SearchResult[],
	out: Map<string, FigureUnitInfo>,
	log: Logger,
): Promise<void> {
	const byBaseRef = new Map<string, SearchResult[]>();
	for (const r of results) {
		const list = byBaseRef.get(r.base_ref) ?? [];
		list.push(r);
		byBaseRef.set(r.base_ref, list);
	}
	await Promise.all(
		[...byBaseRef.entries()].map(async ([baseRef, group]) => {
			const ids = referencedFigureIds(group);
			if (ids.length === 0) return;
			const res = await postgresClient.lookupFigureUnits(
				collection,
				scope,
				baseRef,
				ids,
			);
			if (!res.ok) {
				log.warn(
					{ error: res.error, baseRef },
					"v2 figure lookup failed; assets degrade to refs",
				);
				return;
			}
			for (const info of res.result) out.set(info.figure_id, info);
		}),
	);
}

/**
 * Map reranked results (which may carry token-trimmed content from
 * {@link fitRerankInputs}) back to the untrimmed originals, keeping the rerank
 * score/order. Matched by `id`; a result with no original is kept as-is.
 */
export function restoreOriginalContent(
	reranked: SearchResult[],
	originals: SearchResult[],
): SearchResult[] {
	const byId = new Map(originals.map((r) => [r.id, r]));
	return reranked.map((r) => {
		const original = byId.get(r.id);
		return original && original.content !== r.content
			? { ...r, content: original.content }
			: r;
	});
}
