// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
	isDocumentFullyCovered,
	novelCoverageSearchEvidence,
} from "./coverage-evidence.js";
import { documentIdentityKey, normalizeWindows } from "./coverage-identity.js";
import type {
	CoverageAssignment,
	CoverageAssignmentDocument,
	CoverageAssignmentMode,
	CoverageDocument,
	CoverageLedger,
	CoverageQueueConfig,
	CoverageSearchEvidence,
	CoverageSearchHit,
} from "./coverage-types.js";

/**
 * Stable order by summary rerank rank (ascending); unranked documents keep
 * their relative ledger order after all ranked ones. Without any rank the
 * input order is returned unchanged.
 */
function byRerankRank<T extends CoverageDocument>(
	documents: readonly T[],
): T[] {
	if (!documents.some((document) => document.rerankRank !== undefined)) {
		return [...documents];
	}
	return documents
		.map((document, index) => ({ document, index }))
		.sort((a, b) => {
			const ra = a.document.rerankRank ?? Number.POSITIVE_INFINITY;
			const rb = b.document.rerankRank ?? Number.POSITIVE_INFINITY;
			return ra === rb ? a.index - b.index : ra - rb;
		})
		.map(({ document }) => document);
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

export function requiredDiscoveryRoundCount(
	config: CoverageQueueConfig,
): number {
	if (config.searchDiscovery === undefined) return 0;
	return config.mode === "staged" ? 1 : config.searchDiscovery.rounds;
}

export function discoveryRequired(
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

export function normalizedSeedValue(value: string): string {
	return value.trim().normalize("NFC").replace(/\s+/gu, " ");
}

export function stagedExpansionSeeds(
	ledger: CoverageLedger,
	config: CoverageQueueConfig,
): string[] {
	const limit = config.searchDiscovery?.maxExpansionSeeds ?? 20;
	const used = new Set(
		ledger.usedExpansionSeeds.map((seed) =>
			normalizedSeedValue(seed).toLocaleLowerCase(),
		),
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
		// With summary rerank scores, the most promising summaries are triaged
		// first; without them this is exactly the ledger order.
		const openCandidates = byRerankRank(
			ledger.documents.filter(
				(document) =>
					document.status === "open" &&
					document.inFlightAssignmentId === undefined,
			),
		).slice(0, config.batchSize);
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
					document.inFlightAssignmentId === undefined &&
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
		.filter(
			(document) =>
				document.status === "summary-reviewed" &&
				document.inFlightAssignmentId === undefined,
		)
		.slice(0, Math.min(config.batchSize, config.maxOriginalsPerBatch));
	const openCandidates =
		originalCandidates.length > 0
			? []
			: ledger.documents
					.filter(
						(document) =>
							document.status === "open" &&
							document.inFlightAssignmentId === undefined,
					)
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
		...(assignment.mode === "discovery" &&
		assignment.discoveryGeneration !== undefined
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
 * Marks the documents of one issued assignment as in-flight, so a second lane
 * issued in the same pass cannot be handed the same documents. Discovery
 * assignments carry no documents and leave the ledger untouched.
 */
export function reserveCoverageDocuments(
	ledger: CoverageLedger,
	assignment: CoverageAssignment,
): CoverageLedger {
	if (assignment.documents.length === 0) return ledger;
	const refs = new Set(assignment.documents.map((document) => document.ref));
	return {
		...ledger,
		documents: ledger.documents.map((document) =>
			refs.has(document.ref)
				? { ...document, inFlightAssignmentId: assignment.id }
				: document,
		),
	};
}

/**
 * Clears the in-flight marker left by {@link reserveCoverageDocuments} once
 * the assignment's outcome was folded in (or its task failed before any
 * delegation). Documents of other lanes keep their marker.
 */
export function releaseCoverageDocuments(
	ledger: CoverageLedger,
	assignmentId: string,
): CoverageLedger {
	if (!ledger.documents.some((d) => d.inFlightAssignmentId === assignmentId))
		return ledger;
	return {
		...ledger,
		documents: ledger.documents.map((document) => {
			if (document.inFlightAssignmentId !== assignmentId) return document;
			const { inFlightAssignmentId: _released, ...rest } = document;
			return rest;
		}),
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
					new Set([
						...ledger.usedExpansionSeeds,
						...ledger.activeExpansionSeeds,
					]),
				)
			: ledger.usedExpansionSeeds,
		expansionRoundsCompleted: expansionCompleted
			? ledger.expansionRoundsCompleted + 1
			: ledger.expansionRoundsCompleted,
	};
}

/**
 * Freeze order when summary rerank scores exist: discovery-promoted documents
 * first (path B proves relevance from the original text), then by summary
 * rerank score descending, unscored last; ties keep ledger order. Overflow
 * therefore hits the least relevant candidates. Without any score the ledger
 * order is returned unchanged.
 */
function freezeOrder(
	documents: readonly CoverageDocument[],
): CoverageDocument[] {
	if (!documents.some((document) => document.rerankScore !== undefined)) {
		return [...documents];
	}
	return documents
		.map((document, index) => ({ document, index }))
		.sort((a, b) => {
			const pa = a.document.promotedBySearch === true ? 0 : 1;
			const pb = b.document.promotedBySearch === true ? 0 : 1;
			if (pa !== pb) return pa - pb;
			const sa = a.document.rerankScore;
			const sb = b.document.rerankScore;
			if (sa !== undefined && sb !== undefined && sa !== sb) return sb - sa;
			if (sa === undefined && sb !== undefined) return 1;
			if (sa !== undefined && sb === undefined) return -1;
			return a.index - b.index;
		})
		.map(({ document }) => document);
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
	const novel = freezeOrder(
		eligible.filter((document) => !already.has(document.ref)),
	);
	const accepted = novel.slice(0, remaining).map((document) => document.ref);
	const overflowRefs = novel.slice(remaining).map((document) => document.ref);
	const acceptedSet = new Set(accepted);
	const overflowSet = new Set(overflowRefs);
	const candidateRefs = [...ledger.candidateRefs, ...accepted];
	const documents = ledger.documents.map((document) => {
		if (acceptedSet.has(document.ref)) return document;
		if (!overflowSet.has(document.ref)) return document;
		// The exclusion comes from the candidate budget, not from the reranker:
		// drop a prior `triageSource` so the manifest shows no rerank origin.
		const { triageSource: _overflowTriageSource, ...rest } = document;
		return {
			...rest,
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
			overflowRefs: Array.from(
				new Set([...ledger.overflowRefs, ...overflowRefs]),
			),
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
 *
 * Selection: when `rerankScoreThreshold` is set AND the pass carries a
 * server-confirmed complete rerank (`rerankApplied`/`rerankComplete`/
 * `scoreKind === "rerank"`), ONLY hits with `score >= threshold` are selected —
 * the rank rule is then NOT a bypass. The Top-`maxHitsPerPass` rank rule is the
 * fallback for passes without a usable rerank (or when no threshold is
 * configured). Previously the rank rule promoted Top-N hits regardless of the
 * rerank score, which let low-scoring hits into original review past the
 * threshold.
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
			// A configured threshold gates promotion through the server-confirmed
			// rerank; the rank rule is only the fallback when no rerank backs the
			// pass (otherwise Top-N would bypass the threshold entirely).
			const rerankGated =
				rerankScoreThreshold !== undefined &&
				pass.rerankApplied === true &&
				pass.rerankComplete === true &&
				pass.scoreKind === "rerank";
			const selectedByScore =
				rerankGated &&
				typeof hit.score === "number" &&
				hit.score >= rerankScoreThreshold;
			const selectedByRank = !rerankGated && hit.rank <= maxHitsPerPass;
			if (!selectedByRank && !selectedByScore) continue;
			// Key by canonical document identity so a deep chunk/section hit ref
			// matches the document-level ledger reference from summary triage.
			const hitKey = documentIdentityKey(hit.ref);
			const reasons = selectedByRef.get(hitKey) ?? [];
			reasons.push(
				selectedByScore
					? `Rerank score ${hit.score?.toFixed(3)} for query "${pass.query}"`
					: `Top-${maxHitsPerPass} hit (rank ${hit.rank}) for query "${pass.query}"`,
			);
			selectedByRef.set(hitKey, reasons);
		}
	}
	if (selectedByRef.size === 0)
		return { ledger, promotedRefs: [], selectedRefs: [] };

	const selectedRefs: string[] = [];
	const promotedRefs: string[] = [];
	const documents = ledger.documents.map((document) => {
		const documentKey = documentIdentityKey(document.ref);
		const candidateReasons = selectedByRef.get(documentKey);
		if (candidateReasons === undefined) return document;
		selectedRefs.push(document.ref);
		const readInFull =
			document.totalChars !== undefined || document.windows.length > 0;
		if (document.status === "reviewed" || readInFull) return document;
		const searches = evidence.filter((pass) =>
			pass.resultRefs.some(
				(resultRef) => documentIdentityKey(resultRef) === documentKey,
			),
		);
		if (document.status !== "summary-reviewed") promotedRefs.push(document.ref);
		// Reopening an excluded document overrides its (possibly deterministic
		// rerank) exclusion: the admission now comes from discovery, so the
		// stale `triageSource` must not survive into the verifier manifest. An
		// already admitted document keeps its admission provenance.
		const { triageSource: _reopenedTriageSource, ...reopened } = document;
		const base: CoverageDocument =
			document.status === "excluded" ? reopened : document;
		return {
			...base,
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

export function renderWindowState(
	document: CoverageAssignmentDocument,
): string {
	if (document.totalChars === undefined) return "no verified windows yet";
	const windows = normalizeWindows(document.windows)
		.map((window) => `[${window.offset},${window.end})`)
		.join(", ");
	return `totalChars=${document.totalChars}; modified=${document.modified ?? "unknown"}; verified windows=${windows || "none"}`;
}
