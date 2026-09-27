// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
	type EvalCase,
	figureHitRate,
	figureMetrics,
	overallMrr,
	pageMetrics,
} from "./metrics.ts";

/** Build a case where every ranked hit exposes one page ref and one figure ref. */
function makeCase(
	id: string,
	expectedPageRefs: string[],
	expectedFigureRefs: string[],
	ranked: { page?: string; figure?: string }[],
): EvalCase {
	return {
		id,
		expectedPageRefs,
		expectedFigureRefs,
		hits: ranked.map((r) => ({
			pageRefs: r.page ? [r.page] : [],
			figureRefs: r.figure ? [r.figure] : [],
		})),
	};
}

describe("page metrics", () => {
	test("full recall and rank-1 MRR when the expected page is first", () => {
		const cases = [
			makeCase("q1", ["P1"], [], [{ page: "P1" }, { page: "P2" }]),
		];
		const m = pageMetrics(cases, 5);
		expect(m.recallAtK).toBe(1);
		expect(m.mrr).toBe(1);
		expect(m.evaluatedQueries).toBe(1);
		expect(m.skippedQueries).toBe(0);
	});

	test("reciprocal rank reflects the first relevant position", () => {
		const cases = [
			makeCase("q1", ["P1"], [], [{ page: "PX" }, { page: "P1" }]),
		];
		expect(pageMetrics(cases, 5).mrr).toBe(0.5);
	});

	test("recall is fractional over multiple expected pages", () => {
		const cases = [
			makeCase("q1", ["P1", "P2"], [], [{ page: "P1" }, { page: "PX" }]),
		];
		expect(pageMetrics(cases, 5).recallAtK).toBe(0.5);
	});

	test("cutoff excludes hits beyond k", () => {
		const cases = [
			makeCase(
				"q1",
				["P1"],
				[],
				[{ page: "A" }, { page: "B" }, { page: "C" }, { page: "P1" }],
			),
		];
		expect(pageMetrics(cases, 3).recallAtK).toBe(0);
		expect(pageMetrics(cases, 4).recallAtK).toBe(1);
	});

	test("duplicate references count once", () => {
		const cases = [
			makeCase("q1", ["P1"], [], [{ page: "P1" }, { page: "P1" }]),
		];
		expect(pageMetrics(cases, 5).recallAtK).toBe(1);
	});

	test("cases without expected pages are skipped, not scored as misses", () => {
		const cases = [makeCase("q1", [], ["F1"], [{ figure: "F1" }])];
		const m = pageMetrics(cases, 5);
		expect(m.evaluatedQueries).toBe(0);
		expect(m.skippedQueries).toBe(1);
		expect(m.recallAtK).toBe(0);
	});
});

describe("figure metrics and figure-hit-rate", () => {
	const cases: EvalCase[] = [
		makeCase("f1", ["P1"], ["F1"], [{ page: "P1", figure: "F1" }]),
		makeCase("f2", ["P2"], ["F2"], [{ page: "P2" }, { figure: "FX" }]),
		makeCase("p1", ["P3"], [], [{ page: "P3" }]),
	];

	test("figure recall only counts figure questions", () => {
		const m = figureMetrics(cases, 5);
		expect(m.evaluatedQueries).toBe(2); // f1, f2
		expect(m.recallAtK).toBe(0.5); // f1 hit, f2 miss
	});

	test("figure-hit-rate is the fraction of figure questions with a figure hit", () => {
		const rate = figureHitRate(cases, 5);
		expect(rate.figureQuestions).toBe(2);
		expect(rate.hits).toBe(1);
		expect(rate.rate).toBe(0.5);
	});

	test("figure-hit-rate honours the cutoff", () => {
		const late = [
			makeCase(
				"q",
				["P"],
				["F1"],
				[{ figure: "X" }, { figure: "Y" }, { figure: "F1" }],
			),
		];
		expect(figureHitRate(late, 2).rate).toBe(0);
		expect(figureHitRate(late, 3).rate).toBe(1);
	});
});

describe("overall MRR", () => {
	test("takes the first correct hit across page and figure references", () => {
		// Figure is relevant and appears at rank 1; page is relevant at rank 2.
		const cases = [
			makeCase("q1", ["P1"], ["F1"], [{ figure: "F1" }, { page: "P1" }]),
		];
		expect(overallMrr(cases, 5)).toBe(1);
	});

	test("returns 0 when nothing relevant is retrieved", () => {
		const cases = [
			makeCase("q1", ["P1"], ["F1"], [{ page: "PX" }, { figure: "FX" }]),
		];
		expect(overallMrr(cases, 5)).toBe(0);
	});
});

describe("empty input", () => {
	test("produces zeroes without dividing by zero", () => {
		expect(pageMetrics([], 5)).toEqual({
			recallAtK: 0,
			mrr: 0,
			ndcgAtK: 0,
			evaluatedQueries: 0,
			skippedQueries: 0,
		});
		expect(figureHitRate([], 5)).toEqual({
			rate: 0,
			figureQuestions: 0,
			hits: 0,
		});
	});
});
