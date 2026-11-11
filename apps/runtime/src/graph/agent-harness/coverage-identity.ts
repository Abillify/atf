// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { ToolResultEntry } from "../../types/monitoring.js";
import {
	parseVectorSearchSummaries,
	parseVectorSearchSummaryMeta,
} from "../reranker.js";
import type {
	CoverageDocument,
	CoverageLedger,
	CoverageWindow,
} from "./coverage-types.js";

export class CoverageSeedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoverageSeedError";
	}
}

export function normalizedRef(ref: string): string {
	return ref.trim().normalize("NFC");
}

/**
 * Canonical DOCUMENT-UNIT identity for cross-source deduplication.
 *
 * The coverage ledger is seeded from `get_summaries`, whose `reference` is a
 * document-UNIT path (`/…/Datei.pdf/79. SPEZIFIKATION …`): one entry per
 * logical unit (title page, content section, …), never per physical file.
 * `get_document` resolves exactly these unit references (directly or via a
 * search hit's `base_ref`) and merges the unit's chunks into one readable
 * document. Discovery `search` hits carry a `base_ref` when the server
 * provides one, otherwise a chunk-level `reference`
 * (`/…/Datei.pdf/79. …_chunk_8`).
 *
 * Identity is therefore the UNIT: NFC + trim, a stripped trailing slash, a
 * stripped trailing `_chunk_<n>` segment, case-folded. A chunk hit collapses
 * onto its unit's ledger entry, while sibling units of the same physical file
 * (e.g. the `/0` title page vs. a `/79. …` content section) stay DISTINCT —
 * collapsing at the file-extension segment instead would map every search hit
 * onto the title-page entry, so the researcher would be assigned a ~500-char
 * title page instead of the content unit that actually matched.
 *
 * Used ONLY for cross-source hit matching; the displayed `ref` handed to
 * `get_document` stays the full, original ledger reference.
 */
const CHUNK_REF_SEGMENT = /_chunk_\d+$/i;

export function documentIdentityKey(ref: string): string {
	let key = normalizedRef(ref);
	if (key === "") return "";
	// Drop a single trailing slash so `/a/b/` and `/a/b` collapse.
	if (key.endsWith("/") && key.length > 1) key = key.slice(0, -1);
	// Collapse a chunk-level hit reference onto its parent document unit, so a
	// search hit maps to the same ledger entry as the unit-level triage
	// reference. Only the trailing chunk marker is removed — sibling units of
	// one physical file must never collapse into each other.
	key = key.replace(CHUNK_REF_SEGMENT, "");
	return key.toLocaleLowerCase();
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
	// Tracks raw-string-distinct references separately from canonical-identity
	// dedup, so we can tell "fewer entries because pages are missing" (a real
	// completeness failure) apart from "fewer entries because two reference
	// forms are the same physical document" (expected, not a failure).
	const rawSeen = new Set<string>();
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
			rawSeen.add(ref);
			// Dedupe by canonical document identity, not raw string, so the same
			// physical document surfaced under two reference forms across
			// paginated summary pages seeds exactly one ledger entry. The first
			// full reference wins as the displayed `ref`.
			const identity = documentIdentityKey(ref);
			if (seen.has(identity)) continue;
			seen.add(identity);
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
	// A raw-distinct count above the reported total means duplicate pages or a
	// bad envelope; more entries than the source claims is never acceptable.
	if (rawSeen.size > total) {
		throw new CoverageSeedError(
			`Coverage seed inconsistent: ${rawSeen.size} distinct references exceed reported total ${total}.`,
		);
	}
	// Fewer raw-distinct references than the reported total means summary pages
	// are genuinely missing — still a fail-closed completeness violation.
	if (rawSeen.size < total) {
		throw new CoverageSeedError(
			`Coverage seed incomplete: ${rawSeen.size} unique references for reported total ${total}.`,
		);
	}
	// All pages present. Canonical dedup may legitimately collapse two reference
	// forms of one physical document, so the ledger total is the deduplicated
	// document count, not the raw summary-row count.
	const effectiveTotal = documents.length;

	return {
		sourceTool,
		total: effectiveTotal,
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

export function normalizeWindows(
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
