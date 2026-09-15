// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { ToolResultEntry } from "../../types/monitoring.js";
import {
	parseVectorSearchSummaries,
	parseVectorSearchSummaryMeta,
} from "../reranker.js";

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

export class CoverageSeedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoverageSeedError";
	}
}

function normalizedRef(ref: string): string {
	return ref.trim().normalize("NFC");
}

export function seedCoverageLedger(
	toolResults: readonly ToolResultEntry[] | undefined,
	sourceTool: string,
): CoverageLedger {
	const matching = (toolResults ?? []).filter(
		(entry) => entry.tool_name === sourceTool,
	);
	if (matching.length === 0) {
		throw new CoverageSeedError(
			`Coverage source tool "${sourceTool}" has no tool results.`,
		);
	}

	let total: number | undefined;
	const documents: CoverageDocument[] = [];
	const seen = new Set<string>();
	for (const entry of matching) {
		const meta = parseVectorSearchSummaryMeta(entry.result);
		if (
			meta.total !== undefined &&
			Number.isInteger(meta.total) &&
			meta.total >= 0
		) {
			total = total === undefined ? meta.total : Math.max(total, meta.total);
		}
		for (const summary of parseVectorSearchSummaries(entry.result)) {
			const ref = normalizedRef(summary.reference);
			if (ref === "") {
				throw new CoverageSeedError(
					`Coverage source tool "${sourceTool}" returned a summary without a reference.`,
				);
			}
			if (seen.has(ref)) continue;
			seen.add(ref);
			documents.push({
				ref,
				title: summary.title.trim().normalize("NFC") || ref,
				summary: summary.summary.trim().normalize("NFC"),
				status: "open",
				windows: [],
				searches: [],
			});
		}
	}

	if (total === undefined) {
		throw new CoverageSeedError(
			`Coverage source tool "${sourceTool}" did not report a total.`,
		);
	}
	if (documents.length !== total) {
		throw new CoverageSeedError(
			`Coverage seed incomplete: ${documents.length} unique references for reported total ${total}.`,
		);
	}

	return {
		sourceTool,
		total,
		documents,
		assignmentsIssued: 0,
		discoveryRounds: 0,
		discoveryAttempts: 0,
		discoverySearches: [],
		globalDiscoveryQueries: [],
		phase: "triage",
		discoveryGeneration: 0,
		expansionRoundsCompleted: 0,
		candidateRefs: [],
		freezes: [],
		usedExpansionSeeds: [],
		activeExpansionSeeds: [],
		overflowRefs: [],
	};
}

const MIN_ASSIGNMENT_SUMMARY_CHARS = 256;
const ASSIGNMENT_DOCUMENT_OVERHEAD = 64;
const MAX_ASSIGNMENT_TITLE_CHARS = 512;

function fitAssignmentBudget(
	documents: readonly CoverageDocument[],
	assignmentCharBudget: number,
	includeWindowState: boolean,
): CoverageAssignmentDocument[] {
	const selected: CoverageAssignmentDocument[] = [];
	let used = 0;
	for (const document of documents) {
		const available = assignmentCharBudget - used;
		const windowStateChars = includeWindowState
			? renderWindowState(document).length
			: 0;
		const minimum =
			document.ref.length +
			ASSIGNMENT_DOCUMENT_OVERHEAD +
			windowStateChars +
			MIN_ASSIGNMENT_SUMMARY_CHARS;
		// Never emit a summary-triage assignment that omits the entire summary or
		// exceeds its declared budget. Returning no candidate keeps the ledger
		// non-terminal so the harness fails closed instead of forcing a blind
		// relevant/excluded decision.
		if (available < minimum) break;

		const maxTitleChars = Math.min(
			MAX_ASSIGNMENT_TITLE_CHARS,
			available -
				document.ref.length -
				ASSIGNMENT_DOCUMENT_OVERHEAD -
				windowStateChars -
				MIN_ASSIGNMENT_SUMMARY_CHARS,
		);
		const title =
			maxTitleChars === 0
				? ""
				: document.title.length <= maxTitleChars
					? document.title
					: `${document.title.slice(0, Math.max(0, maxTitleChars - 1))}…`;
		const fixed =
			document.ref.length +
			title.length +
			ASSIGNMENT_DOCUMENT_OVERHEAD +
			windowStateChars;
		const remaining = available - fixed;
		const summary = document.summary.slice(0, remaining);
		selected.push({
			ref: document.ref,
			title,
			summary,
			windows: document.windows.map((window) => ({ ...window })),
			...(document.totalChars !== undefined
				? { totalChars: document.totalChars }
				: {}),
			...(document.modified !== undefined
				? { modified: document.modified }
				: {}),
		});
		used += fixed + summary.length;
		if (used >= assignmentCharBudget) break;
	}
	return selected;
}

function requiredDiscoveryRoundCount(config: CoverageQueueConfig): number {
	if (config.searchDiscovery === undefined) return 0;
	return config.mode === "staged" ? 1 : config.searchDiscovery.rounds;
}

function discoveryRequired(
	ledger: CoverageLedger,
	config: CoverageQueueConfig,
): boolean {
	return ledger.discoveryRounds < requiredDiscoveryRoundCount(config);
}

function discoveryAssignable(
	ledger: CoverageLedger,
	config: CoverageQueueConfig,
): boolean {
	const discovery = config.searchDiscovery;
	return (
		discoveryRequired(ledger, config) &&
		discovery !== undefined &&
		ledger.discoveryAttempts < discovery.maxAttemptsPerRound
	);
}

function normalizedSeedValue(value: string): string {
	return value.trim().normalize("NFC").replace(/\s+/gu, " ");
}

function stagedExpansionSeeds(
	ledger: CoverageLedger,
	config: CoverageQueueConfig,
): string[] {
	const limit = config.searchDiscovery?.maxExpansionSeeds ?? 20;
	const used = new Set(
		ledger.usedExpansionSeeds.map((seed) => normalizedSeedValue(seed).toLocaleLowerCase()),
	);
	const selected: string[] = [];
	for (const document of ledger.documents) {
		for (const seed of document.discoveredSeeds ?? []) {
			const key = normalizedSeedValue(seed.value).toLocaleLowerCase();
			if (key === "" || used.has(key)) continue;
			used.add(key);
			selected.push(seed.value);
			if (selected.length >= limit) return selected;
		}
	}
	return selected;
}

export function nextCoverageAssignment(
	ledger: CoverageLedger,
	config: CoverageQueueConfig,
): CoverageAssignment | undefined {
	const nextId = `coverage-${ledger.assignmentsIssued + 1}`;
	const discoveryIsRequired = discoveryRequired(ledger, config);
	const pendingDiscovery = discoveryAssignable(ledger, config);

	if (config.mode === "staged") {
		// Stage 1: complete the recall-oriented summary scan before any search.
		const openCandidates = ledger.documents
			.filter((document) => document.status === "open")
			.slice(0, config.batchSize);
		if (openCandidates.length > 0) {
			const documents = fitAssignmentBudget(
				openCandidates,
				config.assignmentCharBudget,
				false,
			);
			return documents.length > 0
				? { id: nextId, mode: "summary", documents }
				: undefined;
		}

		// Stage 2: one initial discovery, followed by explicitly frozen originals.
		if (config.searchDiscovery !== undefined && ledger.discoveryRounds === 0) {
			return pendingDiscovery
				? {
						id: nextId,
						mode: "discovery",
						documents: [],
						discoveryGeneration: 0,
					}
				: undefined;
		}

		const originalCandidates = ledger.documents
			.filter(
				(document) =>
					document.status === "summary-reviewed" &&
					!isDocumentFullyCovered(document) &&
					(config.searchDiscovery === undefined ||
						ledger.candidateRefs.includes(document.ref)),
			)
			.slice(0, Math.min(config.batchSize, config.maxOriginalsPerBatch));
		if (originalCandidates.length > 0) {
			const documents = fitAssignmentBudget(
				originalCandidates,
				config.assignmentCharBudget,
				true,
			);
			return documents.length > 0
				? { id: nextId, mode: "original", documents }
				: undefined;
		}

		// Stage 3+: accepted gap-free originals may contribute bounded new seeds.
		const maxExpansionRounds = config.searchDiscovery?.maxExpansionRounds ?? 0;
		const seeds = stagedExpansionSeeds(ledger, config);
		if (
			ledger.expansionRoundsCompleted < maxExpansionRounds &&
			seeds.length > 0
		) {
			return ledger.discoveryAttempts <
				(config.searchDiscovery?.maxAttemptsPerRound ?? 0)
				? {
						id: nextId,
						mode: "discovery",
						documents: [],
						discoveryGeneration: ledger.expansionRoundsCompleted + 1,
						expansionSeeds: seeds,
					}
				: undefined;
		}
		return undefined;
	}

	// Legacy interleaved mode: first discovery, then promoted originals before
	// remaining triage, followed by any still-required discovery rounds.
	if (discoveryIsRequired && ledger.discoveryRounds === 0) {
		return pendingDiscovery
			? { id: nextId, mode: "discovery", documents: [] }
			: undefined;
	}

	const originalCandidates = ledger.documents
		.filter((document) => document.status === "summary-reviewed")
		.slice(0, Math.min(config.batchSize, config.maxOriginalsPerBatch));
	const openCandidates =
		originalCandidates.length > 0
			? []
			: ledger.documents
					.filter((document) => document.status === "open")
					.slice(0, config.batchSize);
	const mode: CoverageAssignmentMode =
		originalCandidates.length > 0 ? "original" : "summary";
	const candidates =
		originalCandidates.length > 0 ? originalCandidates : openCandidates;

	if (candidates.length > 0) {
		const documents = fitAssignmentBudget(
			candidates,
			config.assignmentCharBudget,
			mode === "original",
		);
		if (documents.length > 0) return { id: nextId, mode, documents };
	}
	if (pendingDiscovery) {
		return { id: nextId, mode: "discovery", documents: [] };
	}
	return undefined;
}

/**
 * Records every issued assignment exactly once, providing monotone unique IDs.
 * Discovery attempts are separate from successful rounds: an empty or failed
 * worker consumes a bounded attempt but can never satisfy the terminal gate.
 */
export function markCoverageAssignmentIssued(
	ledger: CoverageLedger,
	assignment: CoverageAssignment,
): CoverageLedger {
	const expansionSeeds = assignment.expansionSeeds ?? [];
	return {
		...ledger,
		assignmentsIssued: ledger.assignmentsIssued + 1,
		discoveryAttempts:
			assignment.mode === "discovery"
				? ledger.discoveryAttempts + 1
				: ledger.discoveryAttempts,
		...(assignment.mode === "discovery" && assignment.discoveryGeneration !== undefined
			? {
					phase:
						assignment.discoveryGeneration === 0
							? ("initial-discovery" as const)
							: ("expansion-discovery" as const),
					discoveryGeneration: assignment.discoveryGeneration,
					activeExpansionSeeds: expansionSeeds,
				}
			: {}),
	};
}

/**
 * Marks one discovery round successful and persists only its globally new
 * runtime-observed search provenance.
 */
export function markCoverageDiscoveryCompleted(
	ledger: CoverageLedger,
	evidence: readonly CoverageSearchEvidence[],
): CoverageLedger {
	const novel = novelCoverageSearchEvidence(ledger, evidence);
	if (novel.length === 0) return ledger;
	const expansionCompleted = ledger.phase === "expansion-discovery";
	return {
		...ledger,
		discoveryRounds: ledger.discoveryRounds + 1,
		discoveryAttempts: 0,
		discoverySearches: [...ledger.discoverySearches, ...novel],
		usedExpansionSeeds: expansionCompleted
			? Array.from(
					new Set([...ledger.usedExpansionSeeds, ...ledger.activeExpansionSeeds]),
				)
			: ledger.usedExpansionSeeds,
		expansionRoundsCompleted: expansionCompleted
			? ledger.expansionRoundsCompleted + 1
			: ledger.expansionRoundsCompleted,
	};
}

/**
 * Freezes one staged candidate generation after successful discovery. The
 * global budget includes candidates from every generation. Overflow remains a
 * deterministic completeness gap and is never silently treated as reviewed.
 */
export function freezeCoverageCandidates(
	ledger: CoverageLedger,
	maxCandidates?: number,
): { ledger: CoverageLedger; frozenRefs: string[]; overflowRefs: string[] } {
	const already = new Set(ledger.candidateRefs);
	const eligible = ledger.documents.filter(
		(document) =>
			document.status === "summary-reviewed" &&
			!isDocumentFullyCovered(document),
	);
	const budget = maxCandidates ?? Number.POSITIVE_INFINITY;
	const remaining = Math.max(0, budget - ledger.candidateRefs.length);
	const novel = eligible.filter((document) => !already.has(document.ref));
	const accepted = novel.slice(0, remaining).map((document) => document.ref);
	const overflowRefs = novel.slice(remaining).map((document) => document.ref);
	const acceptedSet = new Set(accepted);
	const overflowSet = new Set(overflowRefs);
	const candidateRefs = [...ledger.candidateRefs, ...accepted];
	const documents = ledger.documents.map((document) => {
		if (acceptedSet.has(document.ref)) return document;
		if (!overflowSet.has(document.ref)) return document;
		return {
			...document,
			status: "excluded" as const,
			reason: "Staged candidate budget overflow; original review not assigned",
		};
	});
	const generation = ledger.discoveryGeneration;
	return {
		ledger: {
			...ledger,
			documents,
			candidateRefs,
			freezes: [
				...ledger.freezes,
				{
					generation,
					refs: accepted,
					seedValues: ledger.activeExpansionSeeds,
				},
			],
			activeExpansionSeeds: [],
			overflowRefs: Array.from(new Set([...ledger.overflowRefs, ...overflowRefs])),
			phase: "originals",
		},
		frozenRefs: accepted,
		overflowRefs,
	};
}

/**
 * Promotes searched-up documents into original review (retrieval path B).
 *
 * A hit lifts an untriaged document and REOPENS one that was excluded on the
 * strength of its summary alone. A document already read in full — `reviewed`,
 * or excluded with observed windows — is never touched, which is what keeps
 * promotion from cycling.
 */
export function promoteCoverageSearchHits(
	ledger: CoverageLedger,
	evidence: readonly CoverageSearchEvidence[],
	maxHitsPerPass: number,
	rerankScoreThreshold?: number,
): { ledger: CoverageLedger; promotedRefs: string[]; selectedRefs: string[] } {
	if (evidence.length === 0 || maxHitsPerPass <= 0) {
		return { ledger, promotedRefs: [], selectedRefs: [] };
	}
	const selectedByRef = new Map<string, string[]>();
	for (const pass of evidence) {
		const hits: CoverageSearchHit[] =
			pass.hits ??
			pass.resultRefs.map((ref, index) => ({
				ref,
				rank: index + 1,
			}));
		for (const hit of hits) {
			const selectedByRank = hit.rank <= maxHitsPerPass;
			const selectedByScore =
				rerankScoreThreshold !== undefined &&
				pass.rerankApplied === true &&
				pass.rerankComplete === true &&
				pass.scoreKind === "rerank" &&
				typeof hit.score === "number" &&
				hit.score >= rerankScoreThreshold;
			if (!selectedByRank && !selectedByScore) continue;
			const reasons = selectedByRef.get(hit.ref) ?? [];
			reasons.push(
				selectedByScore
					? `Rerank score ${hit.score?.toFixed(3)} for query "${pass.query}"`
					: `Top-${maxHitsPerPass} hit (rank ${hit.rank}) for query "${pass.query}"`,
			);
			selectedByRef.set(hit.ref, reasons);
		}
	}
	if (selectedByRef.size === 0)
		return { ledger, promotedRefs: [], selectedRefs: [] };

	const selectedRefs: string[] = [];
	const promotedRefs: string[] = [];
	const documents = ledger.documents.map((document) => {
		const candidateReasons = selectedByRef.get(document.ref);
		if (candidateReasons === undefined) return document;
		selectedRefs.push(document.ref);
		const readInFull =
			document.totalChars !== undefined || document.windows.length > 0;
		if (document.status === "reviewed" || readInFull) return document;
		const searches = evidence.filter((pass) =>
			pass.resultRefs.includes(document.ref),
		);
		if (document.status !== "summary-reviewed") promotedRefs.push(document.ref);
		return {
			...document,
			status: "summary-reviewed" as const,
			reason:
				document.status === "excluded"
					? `Reopened for original review by global discovery (previously: ${document.reason ?? "no reason given"})`
					: (document.reason ??
						"Queued for original review by global discovery"),
			candidateReasons: Array.from(
				new Set([...(document.candidateReasons ?? []), ...candidateReasons]),
			),
			searches: Array.from(
				new Map(
					[...document.searches, ...searches].map((search) => [
						`${search.hyde}:${search.groupByDocument}:${search.query}`,
						search,
					]),
				).values(),
			),
			promotedBySearch: true,
		};
	});
	return {
		ledger: { ...ledger, documents },
		promotedRefs,
		selectedRefs,
	};
}

function markerCount(text: string, marker: string): number {
	let count = 0;
	let offset = 0;
	while (true) {
		const index = text.indexOf(marker, offset);
		if (index < 0) return count;
		count += 1;
		offset = index + marker.length;
	}
}

export function coverageFindingText(
	text: string,
	markers: CoverageReportMarkers,
): string {
	const start = text.indexOf(markers.start);
	return (start < 0 ? text : text.slice(0, start)).trim();
}

const MAX_DISCOVERED_ITEMS = 100;
const MAX_DISCOVERED_ITEM_CHARS = 256;

function parseDiscoveredValues(value: unknown): string[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_DISCOVERED_ITEMS) return undefined;
	const seen = new Set<string>();
	const values: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return undefined;
		const normalized = normalizedSeedValue(item);
		if (normalized === "" || normalized.length > MAX_DISCOVERED_ITEM_CHARS) {
			return undefined;
		}
		const key = normalized.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		values.push(normalized);
	}
	return values;
}

/**
 * Validates an already-parsed coverage-report OBJECT against an assignment.
 *
 * This is the format-agnostic core shared by both delivery contracts:
 *   - {@link parseCoverageReport} extracts the object from between the markers
 *     (the streaming worker contract), then calls this.
 *   - {@link parseCoverageReportObject} takes a schema-enforced JSON object
 *     directly (the structured-output worker contract) and calls this.
 *
 * The rules (key set, per-item shape, mode-dependent decision set, ref
 * membership, no duplicates, discovery fields only for `original`) live here so
 * the two contracts can never drift apart. Returns the normalized report or
 * `undefined` when any rule is violated.
 */
function validateCoverageReportObject(
	raw: unknown,
	assignment: CoverageAssignment,
): CoverageReport | undefined {
	if (raw === null || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	const recordKeys = Object.keys(record).sort();
	if (
		recordKeys.length !== 2 ||
		recordKeys[0] !== "assignmentId" ||
		recordKeys[1] !== "documents" ||
		record.assignmentId !== assignment.id ||
		!Array.isArray(record.documents)
	) {
		return undefined;
	}

	const expectedRefs = assignment.documents.map((document) => document.ref);
	if (
		record.documents.length === 0 ||
		record.documents.length > expectedRefs.length
	) {
		return undefined;
	}
	const seen = new Set<string>();
	const documents: CoverageReportItem[] = [];
	for (const value of record.documents) {
		if (value === null || typeof value !== "object") return undefined;
		const item = value as Record<string, unknown>;
		const itemKeys = Object.keys(item).sort();
		const allowedKeys = new Set([
			"decision",
			"discoveredEntities",
			"discoveredTerms",
			"reason",
			"ref",
		]);
		if (
			itemKeys.some((key) => !allowedKeys.has(key)) ||
			!itemKeys.includes("decision") ||
			!itemKeys.includes("reason") ||
			!itemKeys.includes("ref") ||
			typeof item.ref !== "string" ||
			typeof item.decision !== "string" ||
			typeof item.reason !== "string" ||
			item.reason.trim() === ""
		) {
			return undefined;
		}
		const discoveredEntities = parseDiscoveredValues(item.discoveredEntities);
		const discoveredTerms = parseDiscoveredValues(item.discoveredTerms);
		if (
			discoveredEntities === undefined ||
			discoveredTerms === undefined ||
			(assignment.mode !== "original" &&
				(item.discoveredEntities !== undefined || item.discoveredTerms !== undefined))
		) {
			return undefined;
		}
		const ref = normalizedRef(item.ref);
		const decision = item.decision as CoverageReportDecision;
		const validDecision =
			assignment.mode === "summary"
				? decision === "relevant" ||
					decision === "possibly_relevant" ||
					decision === "excluded"
				: decision === "reviewed" || decision === "excluded";
		if (!validDecision || !expectedRefs.includes(ref) || seen.has(ref)) {
			return undefined;
		}
		seen.add(ref);
		documents.push({
			ref,
			decision,
			reason: item.reason.trim().normalize("NFC"),
			...(discoveredEntities.length > 0 ? { discoveredEntities } : {}),
			...(discoveredTerms.length > 0 ? { discoveredTerms } : {}),
		});
	}
	return { assignmentId: assignment.id, documents };
}

export function parseCoverageReport(
	text: string,
	assignment: CoverageAssignment,
	markers: CoverageReportMarkers,
): { report: CoverageReport; findingText: string } | undefined {
	if (
		markerCount(text, markers.start) !== 1 ||
		markerCount(text, markers.end) !== 1
	) {
		return undefined;
	}
	const start = text.indexOf(markers.start);
	const end = text.indexOf(markers.end, start + markers.start.length);
	if (
		start < 0 ||
		end < start ||
		text.slice(end + markers.end.length).trim() !== ""
	) {
		return undefined;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text.slice(start + markers.start.length, end).trim());
	} catch {
		return undefined;
	}
	const report = validateCoverageReportObject(raw, assignment);
	if (report === undefined) return undefined;
	return { report, findingText: text.slice(0, start).trim() };
}

/**
 * Parses a coverage report delivered as a schema-enforced JSON OBJECT (the
 * structured-output worker contract), with NO surrounding markers. `text` is the
 * worker's whole assistant content, expected to be exactly one JSON object.
 *
 * A structured-output worker cannot prepend a free-text finding, so there is no
 * `findingText` to recover here (findings for these workers are carried via the
 * report itself, not a text preamble).
 */
export function parseCoverageReportObject(
	text: string,
	assignment: CoverageAssignment,
): { report: CoverageReport; findingText: string } | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	const report = validateCoverageReportObject(raw, assignment);
	if (report === undefined) return undefined;
	return { report, findingText: "" };
}

/**
 * Builds the JSON Schema a structured-output coverage worker must satisfy for a
 * given assignment. The schema is mode-dependent, mirroring the acceptance rules
 * in {@link validateCoverageReportObject}:
 *   - `assignmentId` is pinned to the exact assignment id (const),
 *   - the `decision` enum is `relevant|possibly_relevant|excluded` for summary
 *     assignments and `reviewed|excluded` otherwise,
 *   - `discoveredEntities`/`discoveredTerms` are offered only for `original`
 *     assignments (they are rejected by the validator for other modes).
 *
 * `additionalProperties: false` and the `required` lists keep the object shape
 * exactly what the validator accepts, so a schema-conforming object passes the
 * gate deterministically.
 */
export function buildCoverageReportSchema(
	assignment: CoverageAssignment,
): Record<string, unknown> {
	const decisionEnum =
		assignment.mode === "summary"
			? ["relevant", "possibly_relevant", "excluded"]
			: ["reviewed", "excluded"];
	const itemProperties: Record<string, unknown> = {
		ref: { type: "string", enum: assignment.documents.map((d) => d.ref) },
		decision: { type: "string", enum: decisionEnum },
		reason: { type: "string", minLength: 1 },
	};
	const itemRequired = ["ref", "decision", "reason"];
	if (assignment.mode === "original") {
		itemProperties.discoveredEntities = {
			type: "array",
			items: { type: "string" },
		};
		itemProperties.discoveredTerms = {
			type: "array",
			items: { type: "string" },
		};
	}
	return {
		type: "object",
		additionalProperties: false,
		required: ["assignmentId", "documents"],
		properties: {
			assignmentId: { type: "string", const: assignment.id },
			documents: {
				type: "array",
				minItems: 1,
				maxItems: assignment.documents.length,
				items: {
					type: "object",
					additionalProperties: false,
					required: itemRequired,
					properties: itemProperties,
				},
			},
		},
	};
}

/**
 * Classifies WHY {@link parseCoverageReportObject} rejected a structured-output
 * worker's JSON. Returns the same stable, content-free rule codes as
 * {@link describeCoverageReportDefect}, minus the marker-specific codes.
 */
export function describeCoverageReportObjectDefect(
	text: string,
	assignment: CoverageAssignment,
): string {
	const trimmed = text.trim();
	if (trimmed === "") return "empty_output";
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch {
		return "invalid_json";
	}
	return describeCoverageReportObjectPayload(raw, assignment);
}

/**
 * Classifies WHY {@link parseCoverageReport} rejected a worker's final message.
 *
 * The returned value is a stable, non-content-bearing rule code. Worker output,
 * assignment references, configured markers, JSON keys, and parser errors must
 * never be copied into diagnostics: all are externally controlled and may
 * contain document data, credentials, or private endpoints.
 */
export function describeCoverageReportDefect(
	text: string,
	assignment: CoverageAssignment,
	markers: CoverageReportMarkers,
): string {
	const startCount = markerCount(text, markers.start);
	const endCount = markerCount(text, markers.end);
	if (startCount === 0) return "missing_start_marker";
	if (endCount === 0) return "missing_end_marker";
	if (startCount !== 1 || endCount !== 1) return "invalid_marker_count";
	const start = text.indexOf(markers.start);
	const end = text.indexOf(markers.end, start + markers.start.length);
	if (end < start) return "invalid_marker_order";
	if (text.slice(end + markers.end.length).trim() !== "") {
		return "trailing_content";
	}
	const payload = text.slice(start + markers.start.length, end).trim();
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return "invalid_json";
	}
	return describeCoverageReportObjectPayload(raw, assignment);
}

/**
 * Shared payload classifier for an already-parsed report OBJECT. Returns the
 * same stable rule codes for both the marker path
 * ({@link describeCoverageReportDefect}) and the structured-output path
 * ({@link describeCoverageReportObjectDefect}). Content-free by contract.
 */
function describeCoverageReportObjectPayload(
	raw: unknown,
	assignment: CoverageAssignment,
): string {
	if (raw === null || typeof raw !== "object") return "invalid_report_type";
	const record = raw as Record<string, unknown>;
	const recordKeys = Object.keys(record).sort();
	if (
		recordKeys.length !== 2 ||
		recordKeys[0] !== "assignmentId" ||
		recordKeys[1] !== "documents"
	) {
		return "invalid_report_keys";
	}
	if (record.assignmentId !== assignment.id) return "assignment_id_mismatch";
	if (!Array.isArray(record.documents)) return "invalid_documents_type";
	const expectedRefs = assignment.documents.map((document) => document.ref);
	if (record.documents.length === 0) return "empty_documents";
	if (record.documents.length > expectedRefs.length) return "too_many_documents";
	const seen = new Set<string>();
	for (const [index, value] of record.documents.entries()) {
		if (value === null || typeof value !== "object") {
			return `invalid_document_type_at_${index}`;
		}
		const item = value as Record<string, unknown>;
		const itemKeys = Object.keys(item).sort();
		const allowedKeys = new Set([
			"decision",
			"discoveredEntities",
			"discoveredTerms",
			"reason",
			"ref",
		]);
		if (itemKeys.some((key) => !allowedKeys.has(key))) {
			return `unknown_document_keys_at_${index}`;
		}
		for (const key of ["ref", "decision", "reason"] as const) {
			if (typeof item[key] !== "string") {
				return `invalid_${key}_type_at_${index}`;
			}
		}
		if ((item.reason as string).trim() === "") {
			return `empty_reason_at_${index}`;
		}
		if (
			assignment.mode !== "original" &&
			(item.discoveredEntities !== undefined || item.discoveredTerms !== undefined)
		) {
			return `discovery_fields_not_allowed_at_${index}`;
		}
		if (
			parseDiscoveredValues(item.discoveredEntities) === undefined ||
			parseDiscoveredValues(item.discoveredTerms) === undefined
		) {
			return `invalid_discovery_fields_at_${index}`;
		}
		const ref = normalizedRef(item.ref as string);
		const decision = item.decision as CoverageReportDecision;
		const validDecision =
			assignment.mode === "summary"
				? decision === "relevant" ||
					decision === "possibly_relevant" ||
					decision === "excluded"
				: decision === "reviewed" || decision === "excluded";
		if (!validDecision) return `invalid_decision_at_${index}`;
		if (!expectedRefs.includes(ref)) return `unassigned_ref_at_${index}`;
		if (seen.has(ref)) return `duplicate_ref_at_${index}`;
		seen.add(ref);
	}
	return "accepted_on_recheck";
}

function normalizeWindows(
	windows: readonly CoverageWindow[],
): CoverageWindow[] {
	const sorted = windows
		.filter(
			(window) =>
				Number.isInteger(window.offset) &&
				Number.isInteger(window.end) &&
				window.offset >= 0 &&
				window.end >= window.offset,
		)
		.sort((a, b) => a.offset - b.offset || a.end - b.end);
	const merged: CoverageWindow[] = [];
	for (const window of sorted) {
		const previous = merged.at(-1);
		if (previous !== undefined && window.offset <= previous.end) {
			previous.end = Math.max(previous.end, window.end);
		} else {
			merged.push({ ...window });
		}
	}
	return merged;
}

export function isDocumentFullyCovered(document: {
	totalChars?: number;
	windows: readonly CoverageWindow[];
}): boolean {
	if (document.totalChars === undefined) return false;
	if (document.totalChars === 0) return true;
	const windows = normalizeWindows(document.windows);
	return (
		windows.length > 0 &&
		windows[0]?.offset === 0 &&
		windows[0].end >= document.totalChars
	);
}

function jsonCandidates(value: unknown, depth = 0): unknown[] {
	if (depth > 4) return [];
	if (typeof value === "string") {
		try {
			return jsonCandidates(JSON.parse(value) as unknown, depth + 1);
		} catch {
			return [];
		}
	}
	if (value === null || typeof value !== "object") return [];
	if (Array.isArray(value)) {
		const candidates: unknown[] = [value];
		for (const item of value) {
			candidates.push(...jsonCandidates(item, depth + 1));
		}
		return candidates;
	}
	const record = value as Record<string, unknown>;
	const candidates: unknown[] = [value];
	for (const key of ["result", "output", "data", "text"]) {
		if (record[key] !== undefined) {
			candidates.push(...jsonCandidates(record[key], depth + 1));
		}
	}
	if (Array.isArray(record.content)) {
		candidates.push(...jsonCandidates(record.content, depth + 1));
	}
	return candidates;
}

export type CoverageSearchParseResult =
	| { status: "parsed"; evidence: CoverageSearchEvidence }
	| { status: "tool-error" }
	| { status: "invalid-effective-args" }
	| { status: "unparseable-success" };

export function parseCoverageSearchToolResult(
	argsJson: string,
	result: unknown,
): CoverageSearchParseResult {
	let args: Record<string, unknown>;
	try {
		const parsed = JSON.parse(argsJson) as unknown;
		if (parsed === null || typeof parsed !== "object") {
			return { status: "invalid-effective-args" };
		}
		args = parsed as Record<string, unknown>;
	} catch {
		return { status: "invalid-effective-args" };
	}
	if (
		typeof args.query !== "string" ||
		args.query.trim() === "" ||
		args.hybrid !== true
	) {
		return { status: "invalid-effective-args" };
	}

	let toolError = false;
	for (const candidate of jsonCandidates(result)) {
		if (candidate === null || typeof candidate !== "object") continue;
		const record = candidate as Record<string, unknown>;
		if (record.isError === true) {
			toolError = true;
			continue;
		}
		if (!Array.isArray(record.results)) continue;
		const rerank =
			record.rerank !== null && typeof record.rerank === "object"
				? (record.rerank as Record<string, unknown>)
				: undefined;
		const hydeStatus =
			record.hyde !== null && typeof record.hyde === "object"
				? (record.hyde as Record<string, unknown>)
				: undefined;
		const seen = new Set<string>();
		const hits: CoverageSearchHit[] = [];
		const appendHits = (values: unknown[], compact: boolean): void => {
			for (const [index, value] of values.entries()) {
				if (value === null || typeof value !== "object") continue;
				const hit = value as Record<string, unknown>;
				const ref = normalizedRef(
					typeof hit.base_ref === "string"
						? hit.base_ref
						: typeof hit.reference === "string"
							? hit.reference
							: "",
				);
				if (ref === "" || seen.has(ref)) continue;
				seen.add(ref);
				const reportedRank = compact ? hit.rank : index + 1;
				hits.push({
					ref,
					rank:
						typeof reportedRank === "number" &&
						Number.isInteger(reportedRank) &&
						reportedRank > 0
							? reportedRank
							: index + 1,
					...(typeof hit.score === "number" && Number.isFinite(hit.score)
						? { score: hit.score }
						: {}),
				});
			}
		};
		appendHits(record.results, false);
		if (Array.isArray(record.rerank_score_hits)) {
			appendHits(record.rerank_score_hits, true);
		}
		const filterKeys =
			args.filter !== null && typeof args.filter === "object"
				? Object.keys(args.filter as Record<string, unknown>).sort()
				: [];
		return {
			status: "parsed",
			evidence: {
			query: args.query.trim().normalize("NFC"),
			hybrid: true,
			hyde: args.hyde === true,
			...(typeof hydeStatus?.applied === "boolean"
				? { hydeApplied: hydeStatus.applied }
				: {}),
			groupByDocument: args.group_by_document === true,
			resultRefs: hits.map((hit) => hit.ref),
			hits,
			rerankRequested:
				typeof rerank?.requested === "boolean"
					? rerank.requested
					: args.rerank === true,
			rerankApplied: rerank?.applied === true,
			rerankComplete: rerank?.complete === true,
			scoreKind: record.score_kind === "rerank" ? "rerank" : "retrieval",
			...(typeof args.collection === "string" && args.collection.trim() !== ""
				? { collection: args.collection.trim() }
				: {}),
			...(typeof args.limit === "number" &&
			Number.isInteger(args.limit) &&
			args.limit > 0
				? { limit: args.limit }
				: {}),
			...(typeof args.path_prefix === "string" &&
			args.path_prefix.trim() !== ""
				? { pathPrefix: args.path_prefix.trim() }
				: {}),
			...(Array.isArray(args.tags)
				? {
						tags: args.tags.filter(
							(tag): tag is string =>
								typeof tag === "string" && tag.trim() !== "",
						),
					}
				: {}),
			...(filterKeys.length > 0 ? { filterKeys } : {}),
			returnedHitCount:
				typeof record.count === "number" &&
				Number.isInteger(record.count) &&
				record.count >= 0
					? record.count
					: record.results.length,
			...(typeof rerank?.inputCount === "number" &&
			Number.isInteger(rerank.inputCount) &&
			rerank.inputCount >= 0
				? { rerankInputCount: rerank.inputCount }
				: {}),
			...(typeof rerank?.scoredCount === "number" &&
			Number.isInteger(rerank.scoredCount) &&
			rerank.scoredCount >= 0
				? { rerankScoredCount: rerank.scoredCount }
				: {}),
			candidateDocumentCount: hits.length,
			},
		};
	}
	return { status: toolError ? "tool-error" : "unparseable-success" };
}

export function coverageSearchEvidenceFromToolResult(
	argsJson: string,
	result: unknown,
): CoverageSearchEvidence | undefined {
	const parsed = parseCoverageSearchToolResult(argsJson, result);
	return parsed.status === "parsed" ? parsed.evidence : undefined;
}

export function normalizedSearchQuery(query: string): string {
	return query
		.normalize("NFC")
		.trim()
		.toLocaleLowerCase()
		.replace(/\s+/gu, " ");
}

/**
 * Returns only query perspectives not already used by a completed discovery
 * round. Repeated spellings within the current assignment are collapsed too,
 * so replaying successful calls can never manufacture a new round.
 */
export function novelCoverageSearchEvidence(
	ledger: CoverageLedger,
	evidence: readonly CoverageSearchEvidence[],
): CoverageSearchEvidence[] {
	const seen = new Set([
		...ledger.discoverySearches.map((item) => normalizedSearchQuery(item.query)),
		...ledger.globalDiscoveryQueries.map((query) => normalizedSearchQuery(query)),
	]);
	const novel: CoverageSearchEvidence[] = [];
	for (const item of evidence) {
		const query = normalizedSearchQuery(item.query);
		if (query === "" || seen.has(query)) continue;
		seen.add(query);
		novel.push(item);
	}
	return novel;
}

export function markCoverageQueriesObserved(
	ledger: CoverageLedger,
	evidence: readonly CoverageSearchEvidence[],
): CoverageLedger {
	const queries = evidence
		.map((item) => normalizedSearchQuery(item.query))
		.filter((query) => query !== "");
	return {
		...ledger,
		globalDiscoveryQueries: Array.from(
			new Set([...ledger.globalDiscoveryQueries, ...queries]),
		),
	};
}

export function qualifyingCoverageSearchEvidence(
	evidence: readonly CoverageSearchEvidence[],
	requirements: CoverageHybridSearchConfig | undefined,
): CoverageSearchEvidence[] {
	if (requirements === undefined) return [...evidence];
	return evidence.filter(
		(item) =>
			item.hybrid &&
			(!requirements.requireGroupedResults || item.groupByDocument) &&
			(!requirements.requireReranking ||
				(item.rerankApplied === true &&
					item.rerankComplete === true &&
					item.scoreKind === "rerank")),
	);
}

export function hasRequiredHybridSearchEvidence(
	evidence: readonly CoverageSearchEvidence[],
	requirements: CoverageHybridSearchConfig | undefined,
): boolean {
	if (requirements === undefined) return true;
	const eligible = qualifyingCoverageSearchEvidence(evidence, requirements);
	const queries = new Set(
		eligible.map((item) => normalizedSearchQuery(item.query)),
	);
	if (queries.size < requirements.minDistinctQueries) return false;
	if (
		requirements.requireReranking === true &&
		eligible.some(
			(item) =>
				item.rerankApplied !== true ||
				item.rerankComplete !== true ||
				item.scoreKind !== "rerank",
		)
	) {
		return false;
	}
	const hydeVariant = (item: CoverageSearchEvidence): boolean =>
		requirements.requireEffectiveHyde === true
			? (item.hydeApplied ?? false)
			: item.hyde;
	return (
		!requirements.requireHydeVariants ||
		(eligible.some((item) => hydeVariant(item)) &&
			eligible.some((item) => !hydeVariant(item)))
	);
}

export function coverageEvidenceFromToolResult(
	assignedRefs: ReadonlySet<string>,
	argsJson: string,
	result: unknown,
): CoverageDocumentEvidence | undefined {
	let args: Record<string, unknown>;
	try {
		const parsed = JSON.parse(argsJson) as unknown;
		if (parsed === null || typeof parsed !== "object") return undefined;
		args = parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (typeof args.reference !== "string") return undefined;
	const requestedRef = normalizedRef(args.reference);
	if (!assignedRefs.has(requestedRef)) return undefined;
	const offset = args.offset === undefined ? 0 : args.offset;
	if (!Number.isInteger(offset) || (offset as number) < 0) return undefined;

	for (const candidate of jsonCandidates(result)) {
		if (candidate === null || typeof candidate !== "object") continue;
		const record = candidate as Record<string, unknown>;
		if (record.isError === true || typeof record.content !== "string") continue;
		const returnedRef =
			typeof record.reference === "string"
				? normalizedRef(record.reference)
				: requestedRef;
		if (returnedRef !== requestedRef || !assignedRefs.has(returnedRef))
			continue;
		if (
			typeof record.totalChars !== "number" ||
			!Number.isInteger(record.totalChars) ||
			record.totalChars < 0
		) {
			continue;
		}
		const totalChars = record.totalChars;
		const start = offset as number;
		const end = Math.min(totalChars, start + record.content.length);
		if (start > totalChars || (totalChars > 0 && end <= start)) continue;
		const modified =
			typeof record.modified === "string" &&
			record.modified.trim() !== "" &&
			Number.isFinite(Date.parse(record.modified))
				? new Date(record.modified).toISOString()
				: record.modified instanceof Date &&
						Number.isFinite(record.modified.getTime())
					? record.modified.toISOString()
					: undefined;
		if (modified === undefined) continue;
		return {
			ref: returnedRef,
			totalChars,
			windows: [{ offset: start, end }],
			modified,
		};
	}
	return undefined;
}

function compareDocumentVersions(left: string, right: string): number {
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
		return leftTime - rightTime;
	}
	return left.localeCompare(right);
}

export function mergeCoverageEvidence(
	ledger: CoverageLedger,
	evidence: readonly CoverageDocumentEvidence[],
): CoverageLedger {
	if (evidence.length === 0) return ledger;
	const byRef = new Map<string, CoverageDocumentEvidence[]>();
	for (const item of evidence) {
		const entries = byRef.get(item.ref) ?? [];
		entries.push(item);
		byRef.set(item.ref, entries);
	}
	const documents = ledger.documents.map((document) => {
		const entries = byRef.get(document.ref);
		if (entries === undefined) return document;
		let totalChars = document.totalChars;
		let modified = document.modified;
		let windows = document.windows;
		for (const item of entries) {
			if (
				modified !== undefined &&
				modified !== item.modified &&
				compareDocumentVersions(item.modified, modified) < 0
			) {
				continue;
			}
			const snapshotChanged =
				totalChars !== undefined &&
				(totalChars !== item.totalChars || modified !== item.modified);
			if (snapshotChanged) windows = [];
			totalChars = item.totalChars;
			modified = item.modified;
			windows = normalizeWindows([...windows, ...item.windows]);
		}
		return {
			...document,
			totalChars,
			windows,
			...(modified !== undefined ? { modified } : {}),
		};
	});
	return { ...ledger, documents };
}

export function applyCoverageReport(
	ledger: CoverageLedger,
	assignment: CoverageAssignment,
	report: CoverageReport,
	searchEvidence: readonly CoverageSearchEvidence[] = [],
	searchRequirements: CoverageHybridSearchConfig | undefined = undefined,
	rejectUnexpectedOriginalSearch = false,
): CoverageReportApplication {
	if (report.assignmentId !== assignment.id) {
		return {
			ledger,
			changed: 0,
			rejectedRefs: [],
			rejectedSearchRefs: [],
			rejectedUnexpectedSearchRefs: [],
		};
	}
	const decisions = new Map(report.documents.map((item) => [item.ref, item]));
	let changed = 0;
	const rejectedRefs: string[] = [];
	const rejectedSearchRefs: string[] = [];
	const rejectedUnexpectedSearchRefs: string[] = [];
	const searchRequirementsMet = hasRequiredHybridSearchEvidence(
		searchEvidence,
		searchRequirements,
	);
	const assignmentRefs = new Set(
		assignment.documents.map((document) => document.ref),
	);
	const documents = ledger.documents.map((document) => {
		if (!assignmentRefs.has(document.ref)) return document;
		const item = decisions.get(document.ref);
		if (item === undefined) return document;
		if (
			assignment.mode === "original" &&
			rejectUnexpectedOriginalSearch &&
			searchEvidence.length > 0
		) {
			rejectedUnexpectedSearchRefs.push(document.ref);
			return document;
		}
		if (assignment.mode === "original" && !searchRequirementsMet) {
			rejectedSearchRefs.push(document.ref);
			return document;
		}
		if (assignment.mode === "original" && !isDocumentFullyCovered(document)) {
			rejectedRefs.push(document.ref);
			return document;
		}
		const status: CoverageDocumentStatus =
			item.decision === "relevant" || item.decision === "possibly_relevant"
				? "summary-reviewed"
				: item.decision === "reviewed"
					? "reviewed"
					: "excluded";
		if (status !== document.status || item.reason !== document.reason) {
			changed += 1;
		}
		const triageDecision: CoverageTriageDecision | undefined =
			assignment.mode !== "summary"
				? document.triageDecision
				: item.decision === "relevant"
					? "relevant"
					: item.decision === "possibly_relevant"
						? "possibly_relevant"
						: "irrelevant";
		const discoveredSeeds: CoverageDiscoveredSeed[] =
			assignment.mode === "original"
				? [
						...(item.discoveredEntities ?? []).map((value) => ({
							value,
							kind: "entity" as const,
							assignmentId: assignment.id,
							generation: ledger.discoveryGeneration,
						})),
						...(item.discoveredTerms ?? []).map((value) => ({
							value,
							kind: "term" as const,
							assignmentId: assignment.id,
							generation: ledger.discoveryGeneration,
						})),
					]
				: [];
		return {
			...document,
			status,
			reason: item.reason,
			...(triageDecision !== undefined ? { triageDecision } : {}),
			...(discoveredSeeds.length > 0
				? {
						discoveredSeeds: Array.from(
							new Map(
								[...(document.discoveredSeeds ?? []), ...discoveredSeeds].map(
									(seed) => [
										`${seed.kind}:${seed.value.toLocaleLowerCase()}`,
										seed,
									],
								),
							).values(),
						),
					}
				: {}),
			...(assignment.mode === "summary" && status === "summary-reviewed"
				? {
						candidateReasons: Array.from(
							new Set([
								...(document.candidateReasons ?? []),
								`Summary-Triage: ${triageDecision}`,
							]),
						),
					}
				: {}),
			searches:
				assignment.mode === "original"
					? Array.from(
							new Map(
								[...document.searches, ...searchEvidence].map((search) => [
									`${search.hyde}:${search.groupByDocument}:${search.query}`,
									search,
								]),
							).values(),
						)
					: document.searches,
		};
	});
	return {
		ledger: { ...ledger, documents },
		changed,
		rejectedRefs,
		rejectedSearchRefs,
		rejectedUnexpectedSearchRefs,
	};
}

function critiqueNamesRef(critique: string, ref: string): boolean {
	let index = critique.indexOf(ref);
	while (index >= 0) {
		const before = index === 0 ? "" : (critique[index - 1] ?? "");
		const afterIndex = index + ref.length;
		const after =
			afterIndex >= critique.length ? "" : (critique[afterIndex] ?? "");
		const boundary = /[\s`'"()[\]{},;:]/u;
		if (
			(before === "" || boundary.test(before)) &&
			(after === "" || boundary.test(after))
		) {
			return true;
		}
		index = critique.indexOf(ref, index + 1);
	}
	return false;
}

export function reopenCoverageFromCritique(
	ledger: CoverageLedger,
	critique: string,
	config?: CoverageQueueConfig,
): {
	ledger: CoverageLedger;
	reopenedRefs: string[];
	discoveryReopened: boolean;
} {
	const normalizedCritique = critique.normalize("NFC");
	const discoveryReopened =
		config?.mode !== "staged" &&
		ledger.discoveryRounds > 0 &&
		normalizedCritique.toLocaleUpperCase().includes("GLOBAL DISCOVERY:");
	const reopenedRefs: string[] = [];
	const documents = ledger.documents.map((document) => {
		if (!critiqueNamesRef(normalizedCritique, document.ref)) return document;
		// Runtime-observed gap-free originals are immutable coverage evidence.
		// A verifier may reject the synthesis, but it cannot force duplicate reads.
		if (isDocumentFullyCovered(document)) return document;
		reopenedRefs.push(document.ref);
		return {
			...document,
			status:
				document.windows.length > 0
					? ("summary-reviewed" as const)
					: ("open" as const),
			reason: undefined,
		};
	});
	// A verifier rejection starts a bounded repair cycle. Reset the per-round
	// attempt budget. A structured GLOBAL DISCOVERY rejection also makes exactly
	// one successful round owed again; prior search provenance stays intact so
	// the replacement round must contribute genuinely new queries.
	return {
		ledger: {
			...ledger,
			documents,
			discoveryAttempts: 0,
			discoveryRounds: discoveryReopened
				? ledger.discoveryRounds - 1
				: ledger.discoveryRounds,
		},
		reopenedRefs,
		discoveryReopened,
	};
}

export function isCoverageTerminal(
	ledger: CoverageLedger,
	config?: CoverageQueueConfig,
): boolean {
	const documentsSettled = ledger.documents.every(
		(document) =>
			document.status === "reviewed" || document.status === "excluded",
	);
	if (!documentsSettled) return false;
	if (config?.mode === "staged") {
		if (
			ledger.overflowRefs.length > 0 ||
			(config.searchDiscovery !== undefined && ledger.discoveryRounds < 1)
		) return false;
		const maxExpansionRounds = config.searchDiscovery?.maxExpansionRounds ?? 0;
		return (
			ledger.expansionRoundsCompleted >= maxExpansionRounds ||
			stagedExpansionSeeds(ledger, config).length === 0
		);
	}
	// A settled dossier is NOT the end while a configured discovery round is
	// still owed: otherwise a triage that excluded everything would terminate
	// without a single targeted search ever having run.
	return config === undefined || !discoveryRequired(ledger, config);
}

export function settleCoveragePhase(
	ledger: CoverageLedger,
	config: CoverageQueueConfig,
): CoverageLedger {
	return config.mode === "staged" && isCoverageTerminal(ledger, config)
		? { ...ledger, phase: "complete" }
		: ledger;
}

export function coverageSummary(ledger: CoverageLedger): string {
	const counts: Record<CoverageDocumentStatus, number> = {
		open: 0,
		"summary-reviewed": 0,
		reviewed: 0,
		excluded: 0,
	};
	for (const document of ledger.documents) counts[document.status] += 1;
	const promoted = ledger.documents.filter(
		(document) => document.promotedBySearch === true,
	).length;
	return (
		`COVERAGE: ${counts.reviewed} reviewed, ${counts.excluded} excluded, ` +
		`${counts["summary-reviewed"]} awaiting original review, ${counts.open} awaiting summary triage ` +
		`(total ${ledger.total}); successful discovery rounds: ${ledger.discoveryRounds}; ` +
		`distinct discovery queries: ${ledger.discoverySearches.length}; ` +
		`current discovery attempts: ${ledger.discoveryAttempts}; ` +
		`documents promoted by targeted search: ${promoted}`
	);
}

export interface CoverageCompletionStatusOptions {
	partial: boolean;
	verified?: boolean;
	stopReason?: string;
	maxGapItems?: number;
}

function missingCoverageRanges(document: CoverageDocument): CoverageWindow[] {
	if (document.totalChars === undefined || document.totalChars <= 0) return [];
	const windows = normalizeWindows(document.windows);
	const gaps: CoverageWindow[] = [];
	let cursor = 0;
	for (const window of windows) {
		if (window.offset > cursor)
			gaps.push({ offset: cursor, end: window.offset });
		cursor = Math.max(cursor, window.end);
	}
	if (cursor < document.totalChars) {
		gaps.push({ offset: cursor, end: document.totalChars });
	}
	return gaps;
}

/**
 * Renders a bounded, sanitized completion contract for downstream synthesis.
 * It contains only ledger-derived gaps and run status — never raw tool payloads,
 * verifier prose, summaries or document contents.
 */
export function coverageCompletionStatus(
	ledger: CoverageLedger,
	config: CoverageQueueConfig | undefined,
	options: CoverageCompletionStatusOptions,
): string {
	const requiredDiscoveryRounds =
		config === undefined ? 0 : requiredDiscoveryRoundCount(config);
	const maxGapItems = Math.max(1, options.maxGapItems ?? 20);
	const documentGaps: Array<Record<string, unknown>> = [];
	for (const document of ledger.documents) {
		if (document.status === "open") {
			documentGaps.push({
				kind: "summary-triage-open",
				ref: document.ref,
			});
		} else if (document.status === "summary-reviewed") {
			documentGaps.push({
				kind: "original-review-open",
				ref: document.ref,
			});
		}
		const missingRanges = missingCoverageRanges(document);
		if (document.windows.length > 0 && missingRanges.length > 0) {
			documentGaps.push({
				kind: "original-windows-open",
				ref: document.ref,
				missingRanges: missingRanges.slice(0, 8),
				omittedRangeCount: Math.max(0, missingRanges.length - 8),
			});
		}
	}
	// Global gaps are few, operationally decisive and must never disappear
	// behind a large document queue. maxGapItems bounds document detail; all
	// applicable global invariants are always retained alongside it.
	const globalGaps: Array<Record<string, unknown>> = [];
	if (ledger.discoveryRounds < requiredDiscoveryRounds) {
		globalGaps.push({
			kind: "discovery-rounds-open",
			completed: ledger.discoveryRounds,
			required: requiredDiscoveryRounds,
		});
	}
	if (config?.mode === "staged" && ledger.overflowRefs.length > 0) {
		globalGaps.push({
			kind: "candidate-budget-overflow",
			overflowCount: ledger.overflowRefs.length,
			refs: ledger.overflowRefs.slice(0, maxGapItems),
		});
	}
	if (
		config?.mode === "staged" &&
		ledger.expansionRoundsCompleted <
			(config.searchDiscovery?.maxExpansionRounds ?? 0) &&
		stagedExpansionSeeds(ledger, config).length > 0
	) {
		globalGaps.push({
			kind: "expansion-rounds-open",
			completed: ledger.expansionRoundsCompleted,
			maximum: config.searchDiscovery?.maxExpansionRounds ?? 0,
			availableSeedCount: stagedExpansionSeeds(ledger, config).length,
		});
	}
	if (options.partial) {
		globalGaps.push({
			kind: "run-stopped-partial",
			stopReason: options.stopReason ?? "unknown",
		});
	}
	if (options.verified === false) {
		globalGaps.push({ kind: "verification-not-confirmed" });
	}
	const retainedDocumentGaps = documentGaps.slice(0, maxGapItems);
	const gaps = [...globalGaps, ...retainedDocumentGaps];
	return [
		"COVERAGE COMPLETION STATUS (sanitized runtime metadata; not an evidence source):",
		JSON.stringify({
			coverageComplete: isCoverageTerminal(ledger, config),
			runComplete: !options.partial,
			verified: options.verified ?? null,
			stopReason: options.stopReason ?? null,
			totalDocuments: ledger.total,
			discoveryRounds: ledger.discoveryRounds,
			requiredDiscoveryRounds,
			phase: ledger.phase,
			discoveryGeneration: ledger.discoveryGeneration,
			expansionRoundsCompleted: ledger.expansionRoundsCompleted,
			candidateCount: ledger.candidateRefs.length,
			freezeCount: ledger.freezes.length,
			overflowCount: ledger.overflowRefs.length,
			gaps,
			omittedGapCount: Math.max(
				0,
				documentGaps.length - retainedDocumentGaps.length,
			),
		}),
	].join("\n");
}

const MAX_VERIFICATION_REASON_CHARS = 256;
const MAX_VERIFICATION_CANDIDATE_REASONS = 2;
const MAX_VERIFICATION_CANDIDATE_REASON_CHARS = 96;
const MAX_VERIFICATION_WINDOWS = 8;
const MAX_VERIFICATION_SEARCHES = 3;
const MAX_VERIFICATION_QUERY_CHARS = 160;

function capVerificationText(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function capVerificationReason(reason: string | undefined): string | null {
	return reason === undefined
		? null
		: capVerificationText(reason, MAX_VERIFICATION_REASON_CHARS);
}

function verificationSearches(document: CoverageDocument) {
	return {
		count: document.searches.length,
		items: document.searches
			.slice(0, MAX_VERIFICATION_SEARCHES)
			.map((search) => ({
				query: capVerificationText(search.query, MAX_VERIFICATION_QUERY_CHARS),
				hydeRequested: search.hyde,
				hydeApplied: search.hydeApplied ?? null,
				groupByDocument: search.groupByDocument,
				rerankRequested: search.rerankRequested ?? false,
				rerankApplied: search.rerankApplied ?? false,
				rerankComplete: search.rerankComplete ?? false,
				scoreKind: search.scoreKind ?? "retrieval",
				resultRefCount: search.resultRefs.length,
			})),
	};
}

/**
 * Renders the deterministic ledger in a verifier-only shape bounded by an
 * optional character budget. Every document reference and status is retained;
 * verbose diagnostic fields are deterministically compacted before the
 * verifier request is assembled.
 */
export function coverageVerificationManifest(
	ledger: CoverageLedger,
	config?: CoverageQueueConfig,
	maxChars = Number.POSITIVE_INFINITY,
): string {
	const prefix = [
		"SANITIZED COVERAGE LEDGER (runtime-verified tool provenance):",
		coverageSummary(ledger),
	];
	const discoverySearches = ledger.discoverySearches.map((search) => ({
		query: capVerificationText(search.query, MAX_VERIFICATION_QUERY_CHARS),
		hyde: search.hyde,
		hydeApplied: search.hydeApplied ?? null,
		groupByDocument: search.groupByDocument,
		rerankRequested: search.rerankRequested ?? false,
		rerankApplied: search.rerankApplied ?? false,
		rerankComplete: search.rerankComplete ?? false,
		scoreKind: search.scoreKind ?? "retrieval",
		resultRefs: search.resultRefs,
		resultRefCount: search.resultRefs.length,
	}));
	const common = {
		total: ledger.total,
		discoveryRounds: ledger.discoveryRounds,
		requiredDiscoveryRounds:
			config === undefined ? 0 : requiredDiscoveryRoundCount(config),
		discoveryAttempts: ledger.discoveryAttempts,
		discoverySearches,
		phase: ledger.phase,
		discoveryGeneration: ledger.discoveryGeneration,
		expansionRoundsCompleted: ledger.expansionRoundsCompleted,
		maxExpansionRounds: config?.searchDiscovery?.maxExpansionRounds ?? 0,
		candidateRefs: ledger.candidateRefs,
		freezes: ledger.freezes,
		usedExpansionSeeds: ledger.usedExpansionSeeds,
		overflowRefs: ledger.overflowRefs,
		hybridSearchRequirements: config?.hybridSearch ?? null,
	};
	const detailedDocuments = ledger.documents.map((document) => {
		const windows = normalizeWindows(document.windows);
		return {
			ref: document.ref,
			status: document.status,
			triageDecision: document.triageDecision ?? null,
			candidateReasonCount: document.candidateReasons?.length ?? 0,
			candidateReasons: (document.candidateReasons ?? [])
				.slice(0, MAX_VERIFICATION_CANDIDATE_REASONS)
				.map((reason) =>
					capVerificationText(reason, MAX_VERIFICATION_CANDIDATE_REASON_CHARS),
				),
			basis:
				document.totalChars === undefined && windows.length === 0
					? "summary"
					: "original",
			reason: capVerificationReason(document.reason),
			totalChars: document.totalChars ?? null,
			modified: document.modified ?? null,
			windowCount: windows.length,
			windows: windows.slice(0, MAX_VERIFICATION_WINDOWS),
			fullyCovered: isDocumentFullyCovered(document),
			hybridSearches: verificationSearches(document),
			promotedBySearch: document.promotedBySearch === true,
			...(document.discoveredSeeds !== undefined &&
			document.discoveredSeeds.length > 0
				? { discoveredSeeds: document.discoveredSeeds }
				: {}),
		};
	});
	const compactDocuments = detailedDocuments.map((document) => ({
		ref: document.ref,
		status: document.status,
		triageDecision: document.triageDecision,
		basis: document.basis,
		fullyCovered: document.fullyCovered,
		reason: document.reason,
		totalChars: document.totalChars,
		modified: document.modified,
		windowCount: document.windowCount,
		candidateReasonCount: document.candidateReasonCount,
		hybridSearchCount: document.hybridSearches.count,
		promotedBySearch: document.promotedBySearch,
	}));
	const minimalDocuments = ledger.documents.map((document) => ({
		ref: document.ref,
		status: document.status,
	}));
	const render = (payload: Record<string, unknown>): string =>
		[...prefix, JSON.stringify(payload)].join("\n");
	const detailed = render({ ...common, documents: detailedDocuments });
	if (detailed.length <= maxChars) return detailed;
	const compact = render({ ...common, documents: compactDocuments });
	if (compact.length <= maxChars) return compact;
	return render({
		total: ledger.total,
		discoveryRounds: ledger.discoveryRounds,
		requiredDiscoveryRounds: common.requiredDiscoveryRounds,
		discoveryAttempts: ledger.discoveryAttempts,
		phase: ledger.phase,
		discoveryGeneration: ledger.discoveryGeneration,
		expansionRoundsCompleted: ledger.expansionRoundsCompleted,
		freezes: ledger.freezes,
		usedExpansionSeeds: ledger.usedExpansionSeeds,
		overflowRefs: ledger.overflowRefs,
		documents: minimalDocuments,
	});
}

function renderWindowState(document: CoverageAssignmentDocument): string {
	if (document.totalChars === undefined) return "no verified windows yet";
	const windows = normalizeWindows(document.windows)
		.map((window) => `[${window.offset},${window.end})`)
		.join(", ");
	return `totalChars=${document.totalChars}; modified=${document.modified ?? "unknown"}; verified windows=${windows || "none"}`;
}

export function renderCoverageAssignment(
	assignment: CoverageAssignment,
	config: CoverageQueueConfig,
	ledger: CoverageLedger,
): string {
	if (assignment.mode === "discovery") {
		const hits = config.searchDiscovery?.maxHitsPerPass ?? 0;
		const threshold = config.searchDiscovery?.rerankScoreThreshold;
		const previousQueries = (() => {
			if (config.mode === "staged") {
				return ledger.globalDiscoveryQueries.length === 0
					? "none"
					: ledger.globalDiscoveryQueries.map((query) => `- ${query}`).join("\n");
			}
			return ledger.discoverySearches.length === 0
				? "none"
				: ledger.discoverySearches
						.map((item) => `- ${item.query} (hyde=${item.hyde})`)
						.join("\n");
		})();
		const generation = assignment.discoveryGeneration ?? ledger.discoveryGeneration;
		const expansion = generation > 0;
		const phase =
			config.mode === "staged"
				? expansion
					? `CONTROLLED EXPANSION DISCOVERY GENERATION ${generation}`
					: "GLOBAL SEARCH DISCOVERY PHASE"
				: `SEARCH DISCOVERY ROUND ${ledger.discoveryRounds + 1}`;
		const expansionInstruction = expansion
			? `\n\nEXPANSION SEEDS (authoritative, NFC-normalized, unused):\n${(
					assignment.expansionSeeds ?? []
				).map((seed) => `- ${seed}`).join("\n")}\nUse these seeds to formulate at most ${config.searchDiscovery?.maxQueriesPerExpansionRound ?? "the configured number of"} globally new queries. Do not repeat or paraphrase a query already listed above.`
			: "";
		return (
			`PRIVATE COVERAGE ASSIGNMENT ${assignment.id}\n${coverageSummary(ledger)}\n` +
			`${phase}: This assignment reviews NO summaries and decides NO documents. ` +
			"Build the independent search candidate set for this generation now.\n\n" +
			`QUERIES ALREADY USED: ${previousQueries}${expansionInstruction}\n\n` +
			"Every query must introduce a genuinely NEW wording and perspective. " +
			"Run several complementary vectorsearch/search passes with semantically different queries. " +
			"Every pass MUST set hybrid=true, group_by_document=true and rerank=true:\n" +
			"1. exact anchor pass (names, dates, amounts, file numbers, characteristic wording) with hyde=false\n" +
			"2. conceptual pass without HyDE (synonyms, legal substance, prerequisites) with hyde=false\n" +
			"3. conceptual expansion pass with hyde=true\n" +
			"4. where relevant: date/version and counter-hypothesis passes\n\n" +
			`The runtime selects the top ${hits} document hits of every pass` +
			(threshold === undefined
				? ". "
				: ` plus every hit with a complete server-confirmed rerank score >= ${threshold}. `) +
			"Fallback retrieval scores never satisfy the score threshold. Candidates are deduplicated by canonical base_ref. " +
			"Report the decisive queries and candidate refs in plain text. " +
			`Emit NO ${config.markers.start} block in this assignment.`
		);
	}
	const action =
		assignment.mode === "summary"
			? "SUMMARY TRIAGE: Decide relevant, possibly_relevant, or excluded from every supplied summary. Use possibly_relevant whenever the summary is missing, weak, ambiguous, or may hide a decisive detail. Relevant and possibly_relevant documents become candidates, but originals are read only after the global discovery phase. Do not claim to have reviewed originals. No tool call is required."
			: `ORIGINAL ANALYSIS: Read each assigned original completely with vectorsearch/get_document windows of at most ${config.documentWindowChars} characters. Do not run searches in staged mode. Only successful calls for the exact assigned ref count. The runtime accepts reviewed/excluded only when [0,totalChars) is covered without gaps. In the finding text provide a compact per-document analysis separating: relevance, documented facts, exact dates/amounts/wording, answer contributions, contradictions, and uncertainties, with stable citations. After gap-free reading, each report item may additionally contain bounded string arrays discoveredEntities and discoveredTerms. They are NFC-normalized, deduplicated, and retained with document/assignment/generation provenance for controlled expansion.`;
	const documents = assignment.documents
		.map(
			(document, index) =>
				`${index + 1}. REF: ${document.ref}\nTITLE: ${document.title}\nSUMMARY: ${document.summary || "(none)"}` +
				(assignment.mode === "original"
					? `\nRUNTIME WINDOW STATE: ${renderWindowState(document)}`
					: ""),
		)
		.join("\n\n");
	const allowedDecisions =
		assignment.mode === "summary"
			? '"relevant", "possibly_relevant", or "excluded"'
			: '"reviewed" or "excluded"';
	const exampleDecision =
		assignment.mode === "summary" ? "relevant" : "reviewed";
	return (
		`PRIVATE COVERAGE ASSIGNMENT ${assignment.id}\n${coverageSummary(ledger)}\n${action}\n\n` +
		`AUTHORITATIVE DOCUMENTS IN THIS ASSIGNMENT (${assignment.documents.length} total):\n` +
		`Only the refs listed below belong to this assignment. Do not infer the assignment from any global coverage status or prior list.\n\n${documents}\n\n` +
		`End your response with exactly one report block and no text after it. Report every assigned ref exactly once whenever possible; allowed decisions are ${allowedDecisions}. If output limits prevent a complete report, return a non-empty valid subset—the runtime will keep every omitted ref open and reassign only the remainder. Never invent, duplicate, or report an unassigned ref. Every reported item requires a non-empty, concrete reason:\n${config.markers.start}\n` +
		`{"assignmentId":"${assignment.id}","documents":[{"ref":"exact assigned ref","decision":"${exampleDecision}","reason":"concise concrete reason"}]}\n` +
		`${config.markers.end}`
	);
}
