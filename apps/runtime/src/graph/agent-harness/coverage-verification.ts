// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
	renderWindowState,
	requiredDiscoveryRoundCount,
	stagedExpansionSeeds,
} from "./coverage-assignment.js";
import {
	coverageSummary,
	isCoverageTerminal,
	isDocumentFullyCovered,
} from "./coverage-evidence.js";
import { normalizeWindows } from "./coverage-identity.js";
import type {
	CoverageAssignment,
	CoverageDocument,
	CoverageLedger,
	CoverageQueueConfig,
	CoverageWindow,
} from "./coverage-types.js";

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
			// Omitted when absent so manifests without summary rerank stay unchanged.
			...(document.triageSource !== undefined
				? { triageSource: document.triageSource }
				: {}),
			...(document.rerankRank !== undefined
				? { rerankRank: document.rerankRank }
				: {}),
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
		...(document.triageSource !== undefined
			? { triageSource: document.triageSource }
			: {}),
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
					: ledger.globalDiscoveryQueries
							.map((query) => `- ${query}`)
							.join("\n");
			}
			return ledger.discoverySearches.length === 0
				? "none"
				: ledger.discoverySearches
						.map((item) => `- ${item.query} (hyde=${item.hyde})`)
						.join("\n");
		})();
		const generation =
			assignment.discoveryGeneration ?? ledger.discoveryGeneration;
		const expansion = generation > 0;
		const phase =
			config.mode === "staged"
				? expansion
					? `CONTROLLED EXPANSION DISCOVERY GENERATION ${generation}`
					: "GLOBAL SEARCH DISCOVERY PHASE"
				: `SEARCH DISCOVERY ROUND ${ledger.discoveryRounds + 1}`;
		const expansionInstruction = expansion
			? `\n\nEXPANSION SEEDS (authoritative, NFC-normalized, unused):\n${(assignment.expansionSeeds ?? []).map((seed) => `- ${seed}`).join("\n")}\nUse these seeds to formulate at most ${config.searchDiscovery?.maxQueriesPerExpansionRound ?? "the configured number of"} globally new queries. Do not repeat or paraphrase a query already listed above.`
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
