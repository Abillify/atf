// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

export interface CoverageReportMarkers {
	start: string;
	end: string;
}

export interface CoverageHybridSearchConfig {
	minDistinctQueries: number;
	requireHydeVariants: boolean;
	requireGroupedResults: boolean;
	/** Require every qualifying discovery pass to have a complete server-confirmed rerank. */
	requireReranking?: boolean;
	/** Evaluate HyDE variants from server-confirmed application, not request flags. */
	requireEffectiveHyde?: boolean;
}

/**
 * Search-driven discovery: the SECOND retrieval path next to summary triage.
 *
 * Summaries are lossy LLM-generated text, so a decisive detail can be invisible
 * in a summary and the document would then be excluded and never read in full.
 * Discovery assignments run targeted hybrid searches for the user question, and
 * their hits promote documents into original review regardless of what the
 * summary triage concluded.
 */
export interface CoverageSearchDiscoveryConfig {
	/** Successfully completed discovery rounds required per run (legacy mode). */
	rounds: number;
	/** Maximum failed/evidenceless assignments before one round fails closed. */
	maxAttemptsPerRound: number;
	/** Top-ranked hits per observed search pass eligible for promotion. */
	maxHitsPerPass: number;
	/** Additional promotion threshold, used only for complete server-confirmed reranks. */
	rerankScoreThreshold?: number;
	/** Additional staged discovery generations after accepted original reads. */
	maxExpansionRounds?: number;
	/** Maximum unused entity/term seeds rendered into one expansion assignment. */
	maxExpansionSeeds?: number;
	/** Maximum globally novel queries accepted from one expansion assignment. */
	maxQueriesPerExpansionRound?: number;
	/** Global staged candidate budget across the initial and expansion generations. */
	maxCandidates?: number;
}

export type CoverageQueueMode = "legacy" | "staged";

/**
 * Summary-triage strategy (staged mode only).
 * - `llm`: every summary goes through LLM triage (historic behavior). With a
 *   configured reranker, batches and the candidate freeze are score-ordered.
 * - `hybrid`: a cross-encoder scores every open summary first; the top ranks
 *   are accepted and the clearly irrelevant tail is excluded deterministically,
 *   only the gray zone goes to LLM triage.
 * - `rerank`: accept the top ranks, exclude the rest (except short/empty
 *   summaries, which stay with the LLM).
 * Any reranker failure falls back to full LLM triage (fail-closed).
 */
export type CoverageSummaryTriageMode = "llm" | "hybrid" | "rerank";

export interface CoverageSummaryTriageConfig {
	mode: CoverageSummaryTriageMode;
	/** Score-order Stage-1 batches and the freeze when a reranker is configured. */
	rerankOrder: boolean;
	/** Share (0..1) of scored documents accepted deterministically. */
	acceptTopK: number;
	/** Share (0..1) above which low-score documents may be excluded. */
	excludeBelowRank: number;
	/** Exclusion additionally requires a score below this value. */
	excludeMaxScore: number;
	/** `"user"` (latest human message) or templates; one rerank query each. */
	queries: string[];
	/**
	 * Runtime-only (not a flow schema field): set by the runtime parser when the
	 * configured block was invalid and replaced by mode llm with default
	 * thresholds; lists the offending fields for the
	 * `summary_triage_config_invalid` diagnostic.
	 */
	configError?: string;
}

export const DEFAULT_SUMMARY_TRIAGE_ACCEPT_TOP_K = 0.07;

export const DEFAULT_SUMMARY_TRIAGE_EXCLUDE_BELOW_RANK = 0.35;

export const DEFAULT_SUMMARY_TRIAGE_EXCLUDE_MAX_SCORE = 0.01;

export const DEFAULT_SUMMARY_TRIAGE_QUERIES: readonly string[] = ["user"];

export const MAX_SUMMARY_TRIAGE_QUERIES = 6;

/** Ledger record of the one-time summary rerank pass. */
export interface CoverageSummaryRerank {
	mode: CoverageSummaryTriageMode;
	status: "scored" | "fallback";
	reason?: string;
	documentCount: number;
	queryCount: number;
	accepted: number;
	excluded: number;
	gray: number;
	latencyMs: number;
}

/** Optional worker-node overrides for deterministic coverage assignments. */
export type CoverageTargets = Partial<Record<CoverageAssignmentMode, string>>;

export interface CoverageQueueConfig {
	enabled: boolean;
	/** Staged runs complete all triage before one global discovery and originals. */
	mode?: CoverageQueueMode;
	/**
	 * Worker node selected per assignment mode. Missing modes fall back to the
	 * first validated allowlist target for backward compatibility.
	 */
	targets?: CoverageTargets;
	sourceTool: string;
	batchSize: number;
	/**
	 * Coverage assignments worked on concurrently (1–8, default 1). Each lane
	 * is a separate delegation instance of the target node; results are merged
	 * in assignment order.
	 */
	lanes?: number;
	maxOriginalsPerBatch: number;
	assignmentCharBudget: number;
	documentWindowChars: number;
	hybridSearch?: CoverageHybridSearchConfig;
	searchDiscovery?: CoverageSearchDiscoveryConfig;
	markers: CoverageReportMarkers;
	/**
	 * When true, coverage reports are obtained via a schema-enforced JSON call
	 * ("structured-after-tools") instead of the marker-wrapped free-text
	 * contract. The worker still reasons/uses tools normally; the harness then
	 * makes one additional tool-less, schema-constrained extraction call whose
	 * object is validated with the same rules as the marker path. Eliminates the
	 * `missing_start_marker` failure class on models that drop the sentinels.
	 * Defaults to false (marker contract) for backward compatibility.
	 */
	structuredReport?: boolean;
	/** Optional reranker-backed summary triage (staged only; default llm). */
	summaryTriage?: CoverageSummaryTriageConfig;
}

export type CoverageDocumentStatus =
	| "open"
	| "summary-reviewed"
	| "reviewed"
	| "excluded";

export interface CoverageWindow {
	offset: number;
	end: number;
}

export type CoverageTriageDecision =
	| "relevant"
	| "possibly_relevant"
	| "irrelevant";

export interface CoverageDiscoveredSeed {
	value: string;
	kind: "entity" | "term";
	assignmentId: string;
	generation: number;
}

export interface CoverageDocument {
	ref: string;
	title: string;
	summary: string;
	status: CoverageDocumentStatus;
	triageDecision?: CoverageTriageDecision;
	candidateReasons?: string[];
	reason?: string;
	totalChars?: number;
	modified?: string;
	windows: CoverageWindow[];
	searches: CoverageSearchEvidence[];
	/** Runtime-accepted seeds extracted only after gap-free original reading. */
	discoveredSeeds?: CoverageDiscoveredSeed[];
	/** Set when a targeted search hit put this document into original review. */
	promotedBySearch?: boolean;
	/** Summary cross-encoder score (max over rerank queries). */
	rerankScore?: number;
	/** 1-based rank by {@link rerankScore} among all scored documents. */
	rerankRank?: number;
	/** Set while the current triage decision was made deterministically by the reranker. */
	triageSource?: "rerank";
	/**
	 * Id of the assignment currently working this document on a coverage
	 * lane. Set when the assignment is issued (lanes > 1) and cleared once
	 * its outcome is folded in, so a second lane cannot be handed the same
	 * document. Deliberately not a status: the document keeps its real
	 * review state, so a lane that dies mid-flight leaves the ledger
	 * non-terminal and the run fail-closed.
	 */
	inFlightAssignmentId?: string;
}

export type CoverageLedgerPhase =
	| "triage"
	| "initial-discovery"
	| "originals"
	| "expansion-discovery"
	| "complete";

export interface CoverageCandidateFreeze {
	generation: number;
	refs: string[];
	seedValues: string[];
}

export interface CoverageLedger {
	sourceTool: string;
	total: number;
	documents: CoverageDocument[];
	assignmentsIssued: number;
	/** Successfully completed discovery rounds backed by observed searches. */
	discoveryRounds: number;
	/** Attempts spent on the currently incomplete discovery round. */
	discoveryAttempts: number;
	/** Successful, query-distinct discovery passes across all completed rounds. */
	discoverySearches: CoverageSearchEvidence[];
	/** Every observed discovery query, including capped or incomplete attempts. */
	globalDiscoveryQueries: string[];
	/** Explicit staged state; legacy scheduling ignores these additive fields. */
	phase: CoverageLedgerPhase;
	discoveryGeneration: number;
	expansionRoundsCompleted: number;
	candidateRefs: string[];
	freezes: CoverageCandidateFreeze[];
	usedExpansionSeeds: string[];
	activeExpansionSeeds: string[];
	overflowRefs: string[];
	/** Outcome of the summary rerank pass; absent when none ran. */
	summaryRerank?: CoverageSummaryRerank;
}

export type CoverageAssignmentMode = "summary" | "original" | "discovery";

export interface CoverageAssignmentDocument {
	ref: string;
	title: string;
	summary: string;
	totalChars?: number;
	modified?: string;
	windows: CoverageWindow[];
}

export interface CoverageAssignment {
	id: string;
	mode: CoverageAssignmentMode;
	documents: CoverageAssignmentDocument[];
	/** Present for staged discovery; generation 0 is the initial discovery. */
	discoveryGeneration?: number;
	/** Bounded, previously unused NFC-normalized seeds for an expansion round. */
	expansionSeeds?: string[];
}

export type CoverageReportDecision =
	| "relevant"
	| "possibly_relevant"
	| "reviewed"
	| "excluded";

export interface CoverageReportItem {
	ref: string;
	decision: CoverageReportDecision;
	reason: string;
	discoveredEntities?: string[];
	discoveredTerms?: string[];
}

export interface CoverageReport {
	assignmentId: string;
	documents: CoverageReportItem[];
}

export interface CoverageSearchHit {
	ref: string;
	rank: number;
	score?: number;
}

export interface CoverageSearchEvidence {
	query: string;
	hybrid: true;
	/** Requested HyDE variant; retained for legacy request-semantics. */
	hyde: boolean;
	/** Server-confirmed application when the search response exposes it. */
	hydeApplied?: boolean;
	groupByDocument: boolean;
	resultRefs: string[];
	hits?: CoverageSearchHit[];
	rerankRequested?: boolean;
	rerankApplied?: boolean;
	rerankComplete?: boolean;
	scoreKind?: "rerank" | "retrieval";
	/** Safe operational telemetry derived from effective args and result metadata. */
	collection?: string;
	limit?: number;
	pathPrefix?: string;
	tags?: string[];
	filterKeys?: string[];
	returnedHitCount?: number;
	rerankInputCount?: number;
	rerankScoredCount?: number;
	candidateDocumentCount?: number;
}

export interface CoverageDocumentEvidence {
	ref: string;
	totalChars: number;
	modified: string;
	windows: CoverageWindow[];
}

export interface CoverageReportApplication {
	ledger: CoverageLedger;
	changed: number;
	rejectedRefs: string[];
	rejectedSearchRefs: string[];
	rejectedUnexpectedSearchRefs: string[];
}
