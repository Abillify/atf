// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { pageRef } from "./golden-set.ts";
import {
	normalizeRetrieveEvidence,
	normalizeV2Hit,
	parseArgs,
	runRetrieveV2,
	toRankedHits,
} from "./retrieval.ts";
import { overallMrr, pageMetrics, type EvalCase } from "./metrics.ts";

/**
 * Tests for the `--v2` wiring: the normaliser that maps a
 * `POST /v2/search` hit (top-level `pages`, `assets`) back into the v1
 * reference-bearing shape the metrics consume. The normaliser is the only new
 * logic on the v2 path; the request/response plumbing around it is a thin fetch.
 */
describe("normalizeV2Hit", () => {
	test("maps top-level pages into evidence page_start/page_end", () => {
		const hit = normalizeV2Hit({
			reference: "doc#unit=1",
			base_ref: "doc",
			pages: { start: 12, end: 14 },
		});
		expect(hit.base_ref).toBe("doc");
		expect(hit.reference).toBe("doc#unit=1");
		expect(hit.evidence?.page_start).toBe(12);
		expect(hit.evidence?.page_end).toBe(14);
	});

	test("defaults page_end to page_start when only start is present", () => {
		const hit = normalizeV2Hit({
			reference: "doc#unit=2",
			base_ref: "doc",
			pages: { start: 7 },
		});
		expect(hit.evidence?.page_start).toBe(7);
		expect(hit.evidence?.page_end).toBe(7);
	});

	test("treats a relation:hit asset with a figure_id as a figure (modality image)", () => {
		const hit = normalizeV2Hit({
			reference: "doc#figure=F3",
			base_ref: "doc",
			pages: { start: 3, end: 3 },
			assets: [{ relation: "hit", figure_id: "F3", kind: "figure" }],
		});
		expect(hit.evidence?.modality).toBe("image");
		expect(hit.evidence?.figure_id).toBe("F3");
	});

	test("ignores referenced figures for figure detection (only the hit's own figure counts)", () => {
		const hit = normalizeV2Hit({
			reference: "doc#unit=5",
			base_ref: "doc",
			pages: { start: 9, end: 9 },
			assets: [{ relation: "referenced", figure_id: "F9", kind: "figure" }],
		});
		expect(hit.evidence?.modality).toBeUndefined();
		expect(hit.evidence?.figure_id).toBeUndefined();
	});

	test("falls back to evidence when pages/assets are absent (v2 passthrough)", () => {
		const hit = normalizeV2Hit({
			reference: "doc#figure=F1",
			base_ref: "doc",
			evidence: {
				page_start: 4,
				page_end: 4,
				modality: "image",
				figure_id: "F1",
			},
		});
		expect(hit.evidence?.page_start).toBe(4);
		expect(hit.evidence?.page_end).toBe(4);
		expect(hit.evidence?.modality).toBe("image");
		expect(hit.evidence?.figure_id).toBe("F1");
	});

	test("prefers top-level pages over evidence pages", () => {
		const hit = normalizeV2Hit({
			reference: "doc#unit=6",
			base_ref: "doc",
			pages: { start: 20, end: 21 },
			evidence: { page_start: 1, page_end: 1 },
		});
		expect(hit.evidence?.page_start).toBe(20);
		expect(hit.evidence?.page_end).toBe(21);
	});

	test("yields no page evidence when neither pages nor evidence carry a page", () => {
		const hit = normalizeV2Hit({
			reference: "doc",
			base_ref: "doc",
			pages: null,
		});
		expect(hit.evidence?.page_start).toBeUndefined();
		expect(hit.evidence?.page_end).toBeUndefined();
	});
});

/**
 * Tests for the `--retrieve` wiring: the normaliser that maps a
 * `POST /v2/retrieve` evidence element into the reference-bearing hit shape,
 * the request the driver sends, and the flag exclusions of `--retrieve`.
 */
describe("normalizeRetrieveEvidence", () => {
	test("maps reference, base_ref and pages into the SearchHit shape", () => {
		const hit = normalizeRetrieveEvidence({
			reference: "doc#unit=3",
			base_ref: "doc",
			page_start: 4,
			page_end: 6,
			score: 0.5,
		});
		expect(hit.base_ref).toBe("doc");
		expect(hit.reference).toBe("doc#unit=3");
		expect(hit.evidence?.page_start).toBe(4);
		expect(hit.evidence?.page_end).toBe(6);
		expect(hit.score).toBe(0.5);
	});

	test("carries no figure evidence (the endpoint returns none)", () => {
		const hit = normalizeRetrieveEvidence({
			reference: "doc#unit=1",
			base_ref: "doc",
			page_start: 2,
		});
		expect(hit.evidence?.modality).toBeUndefined();
		expect(hit.evidence?.figure_id).toBeUndefined();
		expect(hit.evidence?.page_end).toBeUndefined();
	});
});

describe("runRetrieveV2", () => {
	test("posts the question with the budget to /v2/retrieve and maps evidence in order", async () => {
		const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(input),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				headers: init?.headers as Record<string, string>,
			});
			return Response.json({
				evidence: [
					{ id: "c1", reference: "alpha#unit=1", base_ref: "alpha", page_start: 3, page_end: 3, score: 0.9 },
					{ id: "c2", reference: "beta#unit=2", base_ref: "beta", page_start: 8, page_end: 9, score: 0.4 },
				],
			});
		}) as typeof fetch;
		try {
			const args = parseArgs([
				"--retrieve",
				"--collection",
				"golden",
				"--base-url",
				"http://127.0.0.1:3002",
				"--budget-tokens",
				"2048",
				"--max-subqueries",
				"3",
			]);
			const hits = await runRetrieveV2(args, "Was regelt Paragraph 7?");
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe("http://127.0.0.1:3002/v2/retrieve");
			expect(calls[0]?.body).toEqual({
				question: "Was regelt Paragraph 7?",
				budget_tokens: 2048,
				max_subqueries: 3,
			});
			expect(calls[0]?.headers["X-Collection"]).toBe("golden");
			// Rank is the position in `evidence`: page refs derive per hit.
			const ranked = toRankedHits(hits);
			expect(ranked[0]?.pageRefs).toEqual([pageRef("alpha", 3)]);
			expect(ranked[1]?.pageRefs).toEqual([pageRef("beta", 8), pageRef("beta", 9)]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("scores the mapped evidence with the existing page metrics and MRR", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			Response.json({
				evidence: [
					{ id: "c1", reference: "alpha#unit=9", base_ref: "alpha", page_start: 12, score: 0.8 },
					{ id: "c2", reference: "alpha#unit=2", base_ref: "alpha", page_start: 1, score: 0.2 },
				],
			})) as unknown as typeof fetch;
		try {
			const args = parseArgs(["--retrieve", "--collection", "golden"]);
			const hits = await runRetrieveV2(args, "Wo steht die Regelung?");
			const cases: EvalCase[] = [
				{
					id: "q-1",
					expectedPageRefs: [pageRef("alpha", 12)],
					expectedFigureRefs: [],
					hits: toRankedHits(hits),
				},
				{
					id: "q-2",
					expectedPageRefs: [pageRef("alpha", 1)],
					expectedFigureRefs: [],
					hits: toRankedHits(hits),
				},
			];
			// q-1 hits at rank 1, q-2 at rank 2 → recall 1.0 at k=2, MRR (1 + 1/2) / 2.
			expect(pageMetrics(cases, 2).recallAtK).toBe(1);
			expect(overallMrr(cases, 2)).toBeCloseTo(0.75);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("parseArgs --retrieve", () => {
	test("defaults the budget flags and records the retrieve mode", () => {
		const args = parseArgs(["--retrieve"]);
		expect(args.retrieve).toBe(true);
		expect(args.budgetTokens).toBe(4000);
		expect(args.maxSubqueries).toBe(4);
	});

	test("rejects the combinations that the retrieve pipeline does not expose", () => {
		expect(() => parseArgs(["--retrieve", "--hyde"])).toThrow(
			"--retrieve cannot be combined with --hyde",
		);
		expect(() => parseArgs(["--retrieve", "--v2"])).toThrow(
			"--retrieve cannot be combined with --v2",
		);
		expect(() => parseArgs(["--retrieve", "--rerank"])).toThrow(
			"--retrieve cannot be combined with --rerank",
		);
		expect(() => parseArgs(["--retrieve", "--search-mode", "dense"])).toThrow(
			"--retrieve cannot be combined with --search-mode",
		);
	});
});
