// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cross-source deduplication in the staged coverage queue.
 *
 * The ledger is seeded from `get_summaries`, whose `reference` is a
 * document-level path. Discovery `search` hits, however, can carry a deep
 * chunk/section `reference` when the server omits `base_ref`. A raw-string
 * compare (trim+NFC only) then fails to recognize that a deep search hit and
 * the document-level triage entry are the SAME physical document, so the hit's
 * promotion is silently lost — and the same document can be read twice under
 * two differently formatted references.
 *
 * These tests pin the canonical identity contract: `documentIdentityKey`
 * collapses a deep reference to its parent document file, and seeding +
 * promotion both use it so triage and search converge on one ledger entry.
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

// Synthetic references. The shape mirrors what a vector store returns — a
// document-level path from get_summaries and a deeper chunk/section path from
// search — including spaces, commas, and a numbered section, but with no real
// customer, project, or file identity.
const DOC_A =
	"/2025_Requirements Spec_Module A, B, C/2025_Requirements Spec_Module A, B, C.pdf";
const DEEP_HIT_A = `${DOC_A}/12. Requirements — Section/3. Sample Field Name`;

describe("documentIdentityKey", () => {
	test("collapses a deep chunk/section reference to its parent document file", () => {
		expect(documentIdentityKey(DEEP_HIT_A)).toBe(documentIdentityKey(DOC_A));
	});

	test("is case- and trailing-slash-insensitive", () => {
		expect(documentIdentityKey("/A/B/")).toBe(documentIdentityKey("/a/b"));
	});

	test("NFC-normalizes so precomposed and decomposed forms match", () => {
		// "é" precomposed (U+00E9) vs decomposed (e + U+0301).
		expect(documentIdentityKey("/Dossier-\u00e9.pdf")).toBe(
			documentIdentityKey("/Dossier-e\u0301.pdf"),
		);
	});

	test("leaves an extension-less reference untruncated (only slash/case)", () => {
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

	const seed = () =>
		seedCoverageLedger(
			[
				{
					tool_call_id: "seed",
					tool_name: config.sourceTool,
					result: {
						summaries: [
							{ reference: DOC_A, title: "Requirements Spec", summary: "S" },
						],
						count: 1,
						total: 1,
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
			pass("sample field lookup", [DEEP_HIT_A]),
		]);

	test("seeds one ledger entry keyed by document identity", () => {
		const ledger = seed();
		expect(ledger.documents).toHaveLength(1);
		expect(ledger.documents[0]?.ref).toBe(DOC_A);
	});

	test("a deep search hit promotes the document-level triage entry", () => {
		const ledger = completeDiscovery();
		const promoted = promoteCoverageSearchHits(
			ledger,
			[pass("sample field lookup", [DEEP_HIT_A])],
			config.searchDiscovery.maxHitsPerPass,
		);
		// The document-level ref is promoted even though the hit ref was deeper.
		expect(promoted.promotedRefs).toEqual([DOC_A]);
		expect(
			promoted.ledger.documents.find((d) => d.ref === DOC_A)?.status,
		).toBe("summary-reviewed");
	});

	test("the promoted document is assigned for original review exactly once", () => {
		let ledger = completeDiscovery();
		ledger = promoteCoverageSearchHits(
			ledger,
			[pass("sample field lookup", [DEEP_HIT_A])],
			config.searchDiscovery.maxHitsPerPass,
		).ledger;
		// Real staged order: promote -> freeze candidates -> original assignment.
		ledger = freezeCoverageCandidates(
			ledger,
			config.searchDiscovery.maxCandidates,
		).ledger;
		const first = nextCoverageAssignment(ledger, config);
		expect(first?.mode).toBe("original");
		expect(first?.documents.map((d) => d.ref)).toEqual([DOC_A]);
	});
});
