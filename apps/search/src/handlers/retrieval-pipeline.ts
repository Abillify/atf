// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/retrieval-pipeline.ts
 *
 * The shared retrieval core behind `/v2/search` and the MCP `search` tool
 * (Phase 7 consolidation). Before this module the two orchestrations
 * copy-pasted the embed → sparse → candidates → rerank → group → threshold →
 * slice → expansion → asset-attach sequence and drifted silently (different
 * rerank fitting, different threshold position, different over-fetch, …).
 *
 * The core keeps ONE implementation of every stage. The differences that are
 * DELIBERATE per endpoint become explicit configuration instead of divergent
 * code:
 *
 *  - `rerank.tokenCounter` / `rerank.minResults`: `/v2/search` fits the rerank
 *    inputs to the real token budget (and maps scores back to untrimmed
 *    originals) and only reranks when more than one candidate came back; the
 *    MCP tool reranks any non-empty list without fitting.
 *  - `minScore.position`: `/v2/search` applies the relevance threshold AFTER
 *    the limit slice ("the limit is not consumed by dropped hits"); the MCP
 *    tool applies it BEFORE (so the page is filled from the qualified
 *    candidates and `rerank_score_hits` can name every qualified document).
 *
 * The stage ORDER is the union order: document groups → legacy document
 * collapse → diversify → v2 group merge → threshold → slice. Running the
 * document-group lookup before diversify is equivalent to the reverse — the
 * lookup only annotates hits (never reorders or rescores them) and diversify
 * never reads `document_group`, while `groupResultsV2` (which does) still runs
 * after the lookup in both endpoints.
 *
 * The v1 `/search` handler is intentionally NOT on this core (Requirement 13.7
 * keeps its header-driven behaviour byte-for-byte); it already shares the stage
 * primitives (`rerankResultsWithStatus`, `diversifyResults`, `attachExpansions`,
 * …) directly.
 */

import type { Logger } from "pino";
import type { AccessScope } from "../access-scope.js";
import type { EmbeddingClient } from "../embedding-client.js";
import type { ExpandMode } from "../expansion.js";
import { referencedFigureIds } from "../search-v2-response.js";
import type {
	FigureUnitInfo,
	PostgresClient,
	SearchCursor,
	SearchFilter,
	SearchOptions,
	SearchResult,
} from "../postgres-client.js";
import type { QueryEmbeddingCache } from "../query-cache.js";
import {
	applyMinScore,
	diversifyResults,
	fitRerankInputs,
	groupResultsV2,
	type GroupByMode,
	type MinScoreOutcome,
	type ScoreKind,
	type ScoreThreshold,
} from "../rerank-context.js";
import type { RerankerClient } from "../reranker-client.js";
import type {
	SparseEmbeddingClient,
	SparseVector,
} from "../sparse-embedding-client.js";
import type { TokenCounter } from "../token-counter.js";
import {
	attachDocumentGroups,
	attachExpansions,
	type ExpandedSearchResult,
} from "./expand-results.js";
import {
	groupResultsByDocument,
	rerankResultsWithStatus,
	type RerankOutcome,
} from "./search.js";

/** The clients every pipeline stage may need. */
export interface RetrievalClients {
	embeddingClient: EmbeddingClient;
	postgresClient: PostgresClient;
	queryCache?: QueryEmbeddingCache | null;
	sparseClient?: SparseEmbeddingClient | null;
	rerankerClient?: RerankerClient | null;
}

/** The query embedding could not be produced (backend failure). */
export class EmbeddingFailedError extends Error {}

/** The candidate query failed; `code` is the backend error code. */
export class CandidateSearchError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
	}
}

/**
 * Embed `text`, reusing the configured query cache. `scopeKey` (the caller's
 * tenant id) binds the cache entry to the tenant so hits are never shared
 * across tenants. Throws {@link EmbeddingFailedError} with the backend
 * message; the call-site decides the HTTP/tool error shape and its own log
 * line.
 */
export async function embedQuery(
	clients: RetrievalClients,
	text: string,
	scopeKey?: string,
): Promise<number[]> {
	const { embeddingClient, queryCache } = clients;
	if (queryCache) {
		try {
			return await queryCache.getOrEmbed(
				text,
				async () => {
					const r = await embeddingClient.embed(text);
					if (!r.ok) throw new Error(r.error.message);
					return r.result.vector;
				},
				scopeKey,
			);
		} catch (err) {
			throw new EmbeddingFailedError(
				err instanceof Error ? err.message : String(err),
			);
		}
	}
	const r = await embeddingClient.embed(text);
	if (!r.ok) throw new EmbeddingFailedError(r.error.message);
	return r.result.vector;
}

/**
 * The optional sparse branch of a hybrid search: embed `text` sparsely when a
 * sparse client is configured and hybrid is on. A failure degrades to
 * `failed` (the dense list still ranks); the call-site decides whether to log.
 */
export async function embedSparseVector(
	clients: RetrievalClients,
	enabled: boolean,
	text: string,
): Promise<{ vector?: SparseVector; failed?: unknown }> {
	const { sparseClient } = clients;
	if (sparseClient === null || sparseClient === undefined || !enabled) {
		return {};
	}
	const r = await sparseClient.embedSparse(text);
	return r.ok ? { vector: r.result } : { failed: r.error };
}

/** One candidate query against the vector store (all v1-compatible knobs). */
export interface CandidateParams {
	/** Original query text for the FTS/ts_rank branch (not the embed text). */
	query: string;
	vector: number[];
	limit: number;
	collection: string;
	scope: AccessScope;
	filter?: SearchFilter;
	hybrid: boolean;
	includeAllVersions: boolean;
	offset: number;
	candidateMultiplier: number;
	sparseVec?: SparseVector;
	tags?: string[];
	cursor?: SearchCursor;
	ftsOnly: boolean;
	baseRef?: string;
	pathPrefix?: string;
	validAt?: string;
	options?: SearchOptions;
}

/**
 * Run the candidate search. Throws {@link CandidateSearchError} carrying the
 * backend code so the call-site maps it to its own status/tool error
 * (`/v2/search`: 400/404/502; MCP: `isError` text).
 */
export async function fetchCandidates(
	clients: RetrievalClients,
	p: CandidateParams,
): Promise<SearchResult[]> {
	const result = await clients.postgresClient.search(
		p.query,
		p.vector,
		p.limit,
		p.collection,
		p.scope,
		p.filter,
		p.hybrid,
		p.includeAllVersions,
		p.offset,
		p.candidateMultiplier,
		p.sparseVec,
		p.tags,
		p.cursor,
		p.ftsOnly,
		p.baseRef,
		p.pathPrefix,
		undefined,
		undefined,
		undefined,
		p.validAt,
		p.options,
	);
	if (!result.ok)
		throw new CandidateSearchError(result.error.message, result.error.code);
	return result.result;
}

export interface RerankStageOptions {
	/** Rerank requested AND a reranker configured. */
	active: boolean;
	/** When set, inputs are token-fitted and scores mapped back to originals. */
	tokenCounter?: TokenCounter | null;
	/** Skip reranking when fewer candidates came back (v2: 2). */
	minResults?: number;
}

export interface RerankStageResult {
	results: SearchResult[];
	/** `null` when reranking did not run (inactive or below `minResults`). */
	outcome: RerankOutcome | null;
}

/**
 * Cross-encoder rerank of the candidate list. With a `tokenCounter` the inputs
 * are trimmed to the real token budget first and the reranked (trimmed) copies
 * are mapped back to the untrimmed originals by id.
 */
export async function rerankStage(
	clients: RetrievalClients,
	query: string,
	results: SearchResult[],
	logger: Logger,
	opts: RerankStageOptions,
): Promise<RerankStageResult> {
	const { rerankerClient } = clients;
	if (!opts.active || rerankerClient === null || rerankerClient === undefined) {
		return { results, outcome: null };
	}
	if (opts.minResults !== undefined && results.length < opts.minResults) {
		return { results, outcome: null };
	}
	const fitted = opts.tokenCounter
		? await fitRerankInputs(results, opts.tokenCounter)
		: results;
	const outcome = await rerankResultsWithStatus(
		rerankerClient,
		query,
		fitted,
		logger,
	);
	return {
		results: opts.tokenCounter
			? restoreOriginalContent(outcome.results, results)
			: outcome.results,
		outcome,
	};
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

/** How the diversify stage runs on the candidate list. */
export type DiversifyMode = "none" | "default" | "uncapped";

/**
 * The relevance threshold stage; `null` disables it entirely. The threshold's
 * own scale is fixed by the caller; the scale the FINAL scores are on is
 * derived from the rerank outcome (`rerank` when it applied, else the
 * retrieval mode) — the same rule on both endpoints.
 */
export interface MinScoreStage {
	threshold: ScoreThreshold | null | undefined;
	/**
	 * `"after-slice"` (v2): slice to `limit` first, then filter — the limit is
	 * not consumed by dropped hits. `"before-slice"` (MCP): filter the whole
	 * candidate list, then slice — the page is filled from the qualified set.
	 */
	position: "before-slice" | "after-slice";
}

export interface RankingOptions {
	limit: number;
	/** Legacy MCP `group_by_document` collapse. */
	legacyGroupByDocument: boolean;
	/**
	 * SEARCH_GROUP_MAX_CHUNKS_PER_DOCUMENT: best-scoring chunks kept per
	 * document by the legacy collapse; a cut document reports `truncated`.
	 */
	groupMaxChunksPerDocument?: number;
	diversify: DiversifyMode;
	/** v2 `group_by` merge (`"none"` is a passthrough). */
	groupBy: GroupByMode;
	minScore: MinScoreStage | null;
	/** Scale of the final scores (rerank applied, else retrieval mode). */
	scoreKind: ScoreKind;
}

export interface RankingResult {
	/** The final page: threshold + limit applied in the endpoint's order. */
	results: SearchResult[];
	/** Post-threshold, pre-limit candidates (provenance source). */
	qualified: SearchResult[];
	minScore: MinScoreOutcome<SearchResult>;
	countBeforeMinScore: number;
	countAfterMinScore: number;
}

/**
 * Grouping, diversification, relevance threshold and page slice — the shared
 * tail of both orchestrations (stage order documented at the top of the file).
 * Pure: the document-group lookup happens in {@link runRetrievalPipeline}
 * before this runs.
 */
export function rankResults(
	results: SearchResult[],
	opts: RankingOptions,
): RankingResult {
	let ranked = results;
	if (opts.legacyGroupByDocument) {
		ranked = groupResultsByDocument(
			ranked,
			opts.groupMaxChunksPerDocument ?? 8,
		);
	}
	if (opts.diversify === "default") ranked = diversifyResults(ranked);
	else if (opts.diversify === "uncapped")
		ranked = diversifyResults(ranked, { perSectionCap: 0 });
	ranked = groupResultsV2(ranked, opts.groupBy);

	if (opts.minScore === null) {
		const page = ranked.slice(0, opts.limit);
		return {
			results: page,
			qualified: page,
			minScore: { results: page },
			countBeforeMinScore: page.length,
			countAfterMinScore: page.length,
		};
	}
	if (opts.minScore.position === "after-slice") {
		const page = ranked.slice(0, opts.limit);
		const outcome = applyMinScore(
			page,
			opts.minScore.threshold,
			opts.scoreKind,
		);
		return {
			results: outcome.results,
			qualified: outcome.results,
			minScore: outcome,
			countBeforeMinScore: page.length,
			countAfterMinScore: outcome.results.length,
		};
	}
	const outcome = applyMinScore(
		ranked,
		opts.minScore.threshold,
		opts.scoreKind,
	);
	return {
		results: outcome.results.slice(0, opts.limit),
		qualified: outcome.results,
		minScore: outcome,
		countBeforeMinScore: ranked.length,
		countAfterMinScore: outcome.results.length,
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
	scope: AccessScope,
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

export interface RetrievalPipelineConfig {
	/** Original query text for the FTS/ts_rank branch. */
	query: string;
	/** Text to embed (HyDE-expanded / identifier-folded / prepared). */
	embedText: string;
	/** Text handed to the reranker (defaults to `query`). */
	rerankQuery?: string;
	collection: string;
	scope: AccessScope;
	filter?: SearchFilter;
	/** Final page size. */
	limit: number;
	/** Candidate over-fetch (the endpoint's own heuristic). */
	fetchLimit: number;
	hybrid: boolean;
	includeAllVersions: boolean;
	offset: number;
	candidateMultiplier: number;
	tags?: string[];
	cursor?: SearchCursor;
	ftsOnly: boolean;
	baseRef?: string;
	pathPrefix?: string;
	validAt?: string;
	searchOptions?: SearchOptions;
	/** Log a failed sparse embedding (v2 yes, MCP no). */
	logSparseFailure: boolean;
	rerank: RerankStageOptions;
	/** Resolve e-mail-thread / attachment-parent groups for every hit. */
	documentGroups: boolean;
	legacyGroupByDocument: boolean;
	/**
	 * SEARCH_GROUP_MAX_CHUNKS_PER_DOCUMENT: best-scoring chunks kept per
	 * document by the legacy collapse (default 8).
	 */
	groupMaxChunksPerDocument?: number;
	diversify: DiversifyMode;
	groupBy: GroupByMode;
	/** Server/per-request threshold; `null` disables the stage. */
	minScore: MinScoreStage | null;
	/** Small-to-big expansion; omitted = no `expanded` field. */
	expand?: { mode: ExpandMode; budgetChars: number; validAt?: string };
	/** Resolve referenced figure metadata for the final hits. */
	resolveFigures: boolean;
}

export interface RetrievalPipelineResult {
	/** The final page, expansion attached when `expand` was set. */
	results: ExpandedSearchResult[];
	/** Post-threshold, pre-limit candidates (MCP `rerank_score_hits`). */
	qualified: SearchResult[];
	/** How many candidates the store returned (MCP rerank `input_count`). */
	candidateCount: number;
	rerank: RerankOutcome | null;
	minScore: MinScoreOutcome<SearchResult>;
	countBeforeMinScore: number;
	countAfterMinScore: number;
	/** Scale of the final scores (drives `score_scale` / threshold skipping). */
	scoreKind: ScoreKind;
	/** figure_id → metadata, populated when `resolveFigures` was set. */
	figureInfo: Map<string, FigureUnitInfo>;
}

/**
 * Run the full shared retrieval sequence. Embedding and candidate failures
 * throw ({@link EmbeddingFailedError} / {@link CandidateSearchError}) so the
 * call-site maps them to its own HTTP status or MCP `isError` text and emits
 * its own log line; everything downstream is identical for both endpoints.
 */
export async function runRetrievalPipeline(
	clients: RetrievalClients,
	logger: Logger,
	cfg: RetrievalPipelineConfig,
): Promise<RetrievalPipelineResult> {
	// The dense and the sparse query embedding are independent backends: run
	// them side by side. A sparse failure degrades (the dense list still ranks);
	// a dense failure throws, and the settled sparse promise is simply dropped.
	const [vector, { vector: sparseVec, failed: sparseFailed }] =
		await Promise.all([
			embedQuery(clients, cfg.embedText, cfg.scope.tenantId),
			embedSparseVector(clients, cfg.hybrid, cfg.embedText),
		]);
	if (sparseFailed !== undefined && cfg.logSparseFailure) {
		logger.warn({ error: sparseFailed }, "sparse embedding failed; skipping");
	}

	const candidates = await fetchCandidates(clients, {
		query: cfg.query,
		vector,
		limit: cfg.fetchLimit,
		collection: cfg.collection,
		scope: cfg.scope,
		filter: cfg.filter,
		hybrid: cfg.hybrid,
		includeAllVersions: cfg.includeAllVersions,
		offset: cfg.offset,
		candidateMultiplier: cfg.candidateMultiplier,
		sparseVec,
		tags: cfg.tags,
		cursor: cfg.cursor,
		ftsOnly: cfg.ftsOnly,
		baseRef: cfg.baseRef,
		pathPrefix: cfg.pathPrefix,
		validAt: cfg.validAt,
		options: cfg.searchOptions,
	});

	const { results: reranked, outcome: rerank } = await rerankStage(
		clients,
		cfg.rerankQuery ?? cfg.query,
		candidates,
		logger,
		cfg.rerank,
	);

	let working = reranked;
	if (cfg.documentGroups) {
		working = await attachDocumentGroups({
			postgresClient: clients.postgresClient,
			collection: cfg.collection,
			scope: cfg.scope,
			results: working,
			logger,
		});
	}

	// The final scores are reranker scores only when reranking actually
	// applied; otherwise they carry the retrieval scale. A threshold set for a
	// different scale is skipped (scale_mismatch) by applyMinScore.
	const scoreKind: ScoreKind = rerank?.applied
		? "rerank"
		: cfg.ftsOnly
			? "fts"
			: cfg.hybrid
				? "rrf"
				: "cosine";

	const ranking = rankResults(working, {
		limit: cfg.limit,
		legacyGroupByDocument: cfg.legacyGroupByDocument,
		groupMaxChunksPerDocument: cfg.groupMaxChunksPerDocument,
		diversify: cfg.diversify,
		groupBy: cfg.groupBy,
		minScore: cfg.minScore,
		scoreKind,
	});

	let results: ExpandedSearchResult[] = ranking.results;
	if (cfg.expand !== undefined) {
		results = await attachExpansions({
			postgresClient: clients.postgresClient,
			collection: cfg.collection,
			scope: cfg.scope,
			mode: cfg.expand.mode,
			budgetChars: cfg.expand.budgetChars,
			includeAllVersions: cfg.includeAllVersions,
			validAt: cfg.expand.validAt,
			results,
			logger,
		});
	}

	const figureInfo = new Map<string, FigureUnitInfo>();
	if (cfg.resolveFigures) {
		await resolveReferencedFigures(
			clients.postgresClient,
			cfg.collection,
			cfg.scope,
			results,
			figureInfo,
			logger,
		);
	}

	return {
		results,
		qualified: ranking.qualified,
		candidateCount: candidates.length,
		rerank,
		minScore: ranking.minScore,
		countBeforeMinScore: ranking.countBeforeMinScore,
		countAfterMinScore: ranking.countAfterMinScore,
		scoreKind,
		figureInfo,
	};
}
