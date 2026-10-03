// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cross-source deduplication in the staged coverage queue.
 *
 * The ledger is seeded from `get_summaries`, whose `reference` is a
 * document-UNIT path (`/…/Datei.pdf/79. PFLICHTENHEFT …`): one entry per
 * logical unit, never per physical file. `get_document` resolves these unit
 * references and merges the unit's chunks. Discovery `search` hits carry a
 * `base_ref` (the unit) when the server provides one, otherwise a chunk-level
 * `reference` (`/…/Datei.pdf/79. …_chunk_8`).
 *
 * These tests pin the canonical identity contract: `documentIdentityKey`
 * collapses a chunk hit onto its unit while keeping sibling units of the same
 * physical file distinct, and seeding + promotion both use it so triage and
 * search converge on one ledger entry — the content unit, not the title page.
 */

import { describe, expect, test } from "bun:test";
import {
	documentIdentityKey,
	freezeCoverageCandidates,
	markCoverageDiscoveryCompleted,
	nextCoverageAssignment,
	promoteCoverageSearchHits,
	seedCoverageLedger,
} from "../agent-harness/coverage.js";

// Synthetic references. The shape mirrors what the production vector store
// returns — unit-level paths from get_summaries and chunk-level paths from
// search — including spaces and a numbered section, but with no real
// customer, project, or file identity.
const FILE = "/2025_Requirements Spec/2025_Requirements Spec.pdf";
const UNIT_A = `${FILE}/12. Requirements — Section`;
const CHUNK_HIT_A = `${UNIT_A}_chunk_3`;
const TITLE_PAGE = `${FILE}/0`;

describe("documentIdentityKey", () => {
	test("collapses a chunk-level hit reference onto its document unit", () => {
		expect(documentIdentityKey(CHUNK_HIT_A)).toBe(documentIdentityKey(UNIT_A));
	});

	test("keeps sibling units of one physical file distinct", () => {
		// The title page must never absorb a content-section unit: collapsing
		// at the file extension would map every hit onto the ~500-char `/0`
		// entry and the researcher would read title pages instead of content.
		expect(documentIdentityKey(TITLE_PAGE)).not.toBe(
			documentIdentityKey(UNIT_A),
		);
		expect(documentIdentityKey(FILE)).not.toBe(documentIdentityKey(UNIT_A));
	});

	test("is case- and trailing-slash-insensitive", () => {
		expect(documentIdentityKey("/A/B/")).toBe(documentIdentityKey("/a/b"));
	});

	test("NFC-normalizes so precomposed and decomposed forms match", () => {
		// "é" precomposed (U+00E9) vs decomposed (e + U+0301).
		expect(documentIdentityKey("/Dossier-\u00e9.pdf/79. Abschnitt")).toBe(
			documentIdentityKey("/Dossier-e\u0301.pdf/79. Abschnitt"),
		);
	});

	test("leaves a reference without a chunk marker untouched (only slash/case)", () => {
		expect(documentIdentityKey("/A")).toBe("/a");
		expect(documentIdentityKey("/folder/Item")).toBe("/folder/item");
	});

	test("returns empty for an empty reference", () => {
		expect(documentIdentityKey("   ")).toBe("");
	});
});

describe("cross-source coverage dedup", () => {
	const config = {
		sourceTool: "vectorsearch/get_summaries",
		batchSize: 25,
		maxOriginalsPerBatch: 1,
		assignmentCharBudget: 100000,
		documentWindowChars: 18000,
		enabled: true as const,
		mode: "staged" as const,
		markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
		hybridSearch: {
			minDistinctQueries: 1,
			requireHydeVariants: false,
			requireGroupedResults: false,
		},
		searchDiscovery: {
			rounds: 1,
			maxAttemptsPerRound: 2,
			maxHitsPerPass: 5,
			maxCandidates: 200,
		},
	} as const;

	// Seed the production shape: a title-page unit and a content unit of the
	// same physical file, both as unit-level get_summaries references.
	const seed = () =>
		seedCoverageLedger(
			[
				{
					tool_call_id: "seed",
					tool_name: config.sourceTool,
					result: {
						summaries: [
							{ reference: TITLE_PAGE, title: "Titelseite", summary: "T" },
							{ reference: UNIT_A, title: "Requirements", summary: "S" },
						],
						count: 2,
						total: 2,
					},
					execution_time_seconds: 0,
				},
			],
			config.sourceTool,
		);

	const pass = (query: string, refs: string[]) => ({
		query,
		hybrid: true as const,
		hyde: false,
		groupByDocument: true,
		resultRefs: refs,
	});

	// Record one completed discovery round on the seeded (still-untriaged)
	// ledger. Promotion inspects document status and full-read state, not the
	// staged phase, so this isolates the cross-source hit-matching behavior.
	const completeDiscovery = (ledger = seed()) =>
		markCoverageDiscoveryCompleted(ledger, [
			pass("sample field lookup", [CHUNK_HIT_A]),
		]);

	test("seeds one ledger entry per unit, not per physical file", () => {
		const ledger = seed();
		expect(ledger.documents).toHaveLength(2);
		expect(ledger.documents.map((d) => d.ref)).toEqual([TITLE_PAGE, UNIT_A]);
	});

	test("a chunk-level search hit promotes its unit entry, not the title page", () => {
		const ledger = completeDiscovery();
		const promoted = promoteCoverageSearchHits(
			ledger,
			[pass("sample field lookup", [CHUNK_HIT_A])],
			config.searchDiscovery.maxHitsPerPass,
		);
		// The content unit is promoted even though the hit ref was a chunk ref;
		// the title-page unit of the same physical file stays untouched.
		expect(promoted.promotedRefs).toEqual([UNIT_A]);
		expect(
			promoted.ledger.documents.find((d) => d.ref === UNIT_A)?.status,
		).toBe("summary-reviewed");
		expect(
			promoted.ledger.documents.find((d) => d.ref === TITLE_PAGE)?.status,
		).toBe("open");
	});

	test("the promoted unit is assigned for original review exactly once", () => {
		let ledger = completeDiscovery();
		// Triage has settled the title page (excluded on summary evidence), as
		// it would in a real staged run, so only the promoted unit is pending.
		ledger = {
			...ledger,
			documents: ledger.documents.map((document) =>
				document.ref === TITLE_PAGE
					? {
							...document,
							status: "excluded" as const,
							reason: "Titelseite ohne Inhalt",
						}
					: document,
			),
		};
		ledger = promoteCoverageSearchHits(
			ledger,
			[pass("sample field lookup", [CHUNK_HIT_A])],
			config.searchDiscovery.maxHitsPerPass,
		).ledger;
		// Real staged order: promote -> freeze candidates -> original assignment.
		ledger = freezeCoverageCandidates(
			ledger,
			config.searchDiscovery.maxCandidates,
		).ledger;
		const first = nextCoverageAssignment(ledger, config);
		expect(first?.mode).toBe("original");
		expect(first?.documents.map((d) => d.ref)).toEqual([UNIT_A]);
	});
});
