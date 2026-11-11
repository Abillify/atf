// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
	discoveryRequired,
	stagedExpansionSeeds,
} from "./coverage-assignment.js";
import { normalizedRef, normalizeWindows } from "./coverage-identity.js";
import type {
	CoverageAssignment,
	CoverageDiscoveredSeed,
	CoverageDocument,
	CoverageDocumentEvidence,
	CoverageDocumentStatus,
	CoverageHybridSearchConfig,
	CoverageLedger,
	CoverageQueueConfig,
	CoverageReport,
	CoverageReportApplication,
	CoverageSearchEvidence,
	CoverageSearchHit,
	CoverageTriageDecision,
	CoverageWindow,
} from "./coverage-types.js";

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

/**
 * Maps a model-facing reference back to the real one. Identity by default;
 * a worker with `config.refHandles` sees short handles in its tool results,
 * which coverage evidence must never record in place of the real reference.
 */
export type CoverageRefResolver = (value: string) => string;

const identityRef: CoverageRefResolver = (value) => value;

export function parseCoverageSearchToolResult(
	argsJson: string,
	result: unknown,
	resolveRef: CoverageRefResolver = identityRef,
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
					resolveRef(
						typeof hit.base_ref === "string"
							? hit.base_ref
							: typeof hit.reference === "string"
								? hit.reference
								: "",
					),
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
				// A hit grouped from several e-mails of one thread names only its
				// best-scoring message in base_ref; the other matched messages are in
				// group_members. Each is a document of its own in the ledger, so each
				// becomes a candidate (same rank and score as the grouped hit) and is
				// read in full rather than silently riding on the representative.
				const last = hits[hits.length - 1];
				if (last !== undefined && Array.isArray(hit.group_members)) {
					for (const member of hit.group_members) {
						if (typeof member !== "string") continue;
						const memberRef = normalizedRef(resolveRef(member));
						if (memberRef === "" || seen.has(memberRef)) continue;
						seen.add(memberRef);
						hits.push({ ...last, ref: memberRef });
					}
				}
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
		...ledger.discoverySearches.map((item) =>
			normalizedSearchQuery(item.query),
		),
		...ledger.globalDiscoveryQueries.map((query) =>
			normalizedSearchQuery(query),
		),
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
	options?: {
		/** Handle → real reference (refHandles workers); identity by default. */
		resolveRef?: CoverageRefResolver;
		/**
		 * Restores the real text of a masked `content` window so its length —
		 * and therefore the covered window end — matches the server's
		 * `totalChars` (masking shortens embedded references to handles).
		 */
		restoreText?: (text: string) => string;
	},
): CoverageDocumentEvidence | undefined {
	const resolveRef = options?.resolveRef ?? identityRef;
	const restoreText = options?.restoreText ?? ((text: string) => text);
	let args: Record<string, unknown>;
	try {
		const parsed = JSON.parse(argsJson) as unknown;
		if (parsed === null || typeof parsed !== "object") return undefined;
		args = parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
	if (typeof args.reference !== "string") return undefined;
	const requestedRef = normalizedRef(resolveRef(args.reference));
	if (!assignedRefs.has(requestedRef)) return undefined;
	const offset = args.offset === undefined ? 0 : args.offset;
	if (!Number.isInteger(offset) || (offset as number) < 0) return undefined;

	for (const candidate of jsonCandidates(result)) {
		if (candidate === null || typeof candidate !== "object") continue;
		const record = candidate as Record<string, unknown>;
		if (record.isError === true || typeof record.content !== "string") continue;
		const returnedRef =
			typeof record.reference === "string"
				? normalizedRef(resolveRef(record.reference))
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
		const end = Math.min(
			totalChars,
			start + restoreText(record.content).length,
		);
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
		// An LLM summary decision supersedes a deterministic rerank decision.
		const { triageSource: _previousTriageSource, ...rest } = document;
		const base: CoverageDocument =
			assignment.mode === "summary" ? rest : document;
		return {
			...base,
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
		// A reopened document goes back to LLM triage; a prior deterministic
		// rerank decision no longer applies (scoring runs only once after seed).
		const { triageSource: _revokedTriageSource, ...rest } = document;
		return {
			...rest,
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
		)
			return false;
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

/**
 * Exact count of documents that still owe work: every document whose status is
 * not terminal ("reviewed" / "excluded"), i.e. "open" (awaiting summary triage)
 * plus "summary-reviewed" (awaiting original review). Deterministic — derived
 * from the ledger alone, never from model text — so the debug-trace gauge
 * cannot drift with narration.
 */
export function coverageOpenCount(ledger: CoverageLedger): number {
	let open = 0;
	for (const document of ledger.documents) {
		if (document.status === "open" || document.status === "summary-reviewed") {
			open += 1;
		}
	}
	return open;
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
		`documents promoted by targeted search: ${promoted}` +
		summaryRerankSuffix(ledger)
	);
}

/** Appended only for deterministic modes, so llm-mode summaries stay unchanged. */
function summaryRerankSuffix(ledger: CoverageLedger): string {
	const rerank = ledger.summaryRerank;
	if (rerank === undefined || rerank.mode === "llm") return "";
	return rerank.status === "scored"
		? `; summary rerank: ${rerank.accepted} accepted, ${rerank.excluded} excluded`
		: `; summary rerank: fallback (${rerank.reason ?? "unknown"}), all summaries via LLM triage`;
}
