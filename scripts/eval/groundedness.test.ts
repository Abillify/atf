// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	parseGroundednessSet,
	renderReport,
	scoreAnswers,
	scoreReference,
} from "./groundedness.ts";

const FIXTURE = resolve(import.meta.dir, "groundedness", "answer-set.v1.json");
const set = parseGroundednessSet(JSON.parse(readFileSync(FIXTURE, "utf8")));

describe("groundedness mini set", () => {
	test("ships German items with one grounded and one unsupported candidate each", () => {
		expect(set.items.length).toBeGreaterThanOrEqual(10);
		for (const item of set.items) {
			expect(item.language).toBe("de");
			expect(item.candidates.map((c) => c.label).sort()).toEqual([
				"grounded",
				"ungrounded",
			]);
		}
	});

	test("the runtime checker separates the curated candidates", () => {
		const report = scoreReference(set);
		const wrong = report.scores.filter((s) => !s.correct).map((s) => s.id);
		expect(wrong).toEqual([]);
		expect(report.accuracy).toBe(1);
		expect(report.unsupportedDetectionRate).toBe(1);
		expect(report.falseFlagRate).toBe(0);
		expect(report.meanGroundedScore).toBeGreaterThan(report.meanUngroundedScore);
	});

	test("scores supplied model answers and reports missing ones (live-model structure, mocked)", () => {
		const first = set.items[0];
		const second = set.items[1];
		if (first === undefined || second === undefined) throw new Error("fixture");
		const grounded = first.candidates.find((c) => c.label === "grounded");
		const answers = {
			[first.id]: grounded?.answer ?? "",
			[second.id]: "   ",
		};
		const report = scoreAnswers(set, answers);
		expect(report.answered).toBe(1);
		expect(report.missing).toContain(second.id);
		expect(report.passRate).toBe(1);
		expect(renderReport(set, report)).toContain("requires live model");
	});

	test("the reference report states it calibrates the checker, not a model", () => {
		expect(renderReport(set, scoreReference(set))).toContain(
			"not a measurement of any LLM",
		);
	});

	test("rejects malformed sets", () => {
		expect(() => parseGroundednessSet({ version: "1", items: [] })).toThrow(
			/non-empty/,
		);
		expect(() =>
			parseGroundednessSet({
				version: "1",
				items: [
					{
						id: "a",
						language: "de",
						question: "?",
						context: ["c"],
						candidates: [{ id: "x", label: "maybe", answer: "a" }],
					},
				],
			}),
		).toThrow(/label/);
	});
});
