// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildCorpus } from "./golden-set/build-corpus.ts";
import {
	cellRef,
	extractionCoverage,
	figureRef,
	hasExtractionAnnotation,
	loadGoldenSet,
	pageRef,
	parseGoldenSet,
} from "./golden-set.ts";

const validSet = {
	version: "1.0.0",
	documents: [
		{ id: "d1", reference: "/a/b.docx", kind: "docx", title: "T", pages: 10 },
	],
	questions: [
		{
			id: "q1",
			document: "d1",
			question: "Where?",
			expectedPages: [3],
			expectedFigures: ["fig-1"],
			expectedCells: [{ page: 3, row: 2, col: 1 }],
		},
	],
};

describe("parseGoldenSet", () => {
	test("accepts a well-formed set", () => {
		const set = parseGoldenSet(validSet);
		expect(set.questions).toHaveLength(1);
		expect(set.questions.at(0)?.expectedPages).toEqual([3]);
	});

	test("rejects an unknown document kind", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				documents: [{ ...validSet.documents[0], kind: "csv" }],
			}),
		).toThrow(/kind/);
	});

	test("rejects a question referencing an unknown document", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [{ ...validSet.questions[0], document: "nope" }],
			}),
		).toThrow(/unknown document/);
	});

	test("rejects a question with no expected page, figure or cell", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [
					{
						id: "q",
						document: "d1",
						question: "?",
						expectedPages: [],
						expectedFigures: [],
						expectedCells: [],
					},
				],
			}),
		).toThrow(/no expected/);
	});

	test("rejects an expected page beyond the document length", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [{ ...validSet.questions[0], expectedPages: [99] }],
			}),
		).toThrow(/> document pages/);
	});

	test("rejects duplicate question ids", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [validSet.questions[0], validSet.questions[0]],
			}),
		).toThrow(/duplicate question id/);
	});
});

describe("reference derivation", () => {
	test("builds page, figure and cell references", () => {
		expect(pageRef("/a/b.docx", 3)).toBe("/a/b.docx#page=3");
		expect(figureRef("/a/b.docx", "fig-1")).toBe("/a/b.docx#figure=fig-1");
		expect(cellRef("/a/b.docx", { page: 3, row: 2, col: 1 })).toBe(
			"/a/b.docx#page=3;cell=2,1",
		);
	});

	test("normalises references to NFC so composed and decomposed forms match", () => {
		const composed = "/\u00fcber.docx"; // ü as one code point
		const decomposed = "/u\u0308ber.docx"; // u + combining diaeresis
		expect(pageRef(decomposed, 1)).toBe(pageRef(composed, 1));
	});
});

describe("shipped fixture", () => {
	test("loads, validates and has 100–150 questions across four kinds", async () => {
		const path = resolve(import.meta.dir, "golden-set", "golden-set.v1.json");
		const set = await loadGoldenSet(path);
		expect(set.questions.length).toBeGreaterThanOrEqual(100);
		expect(set.questions.length).toBeLessThanOrEqual(150);
		const kinds = new Set(set.documents.map((d) => d.kind));
		expect(kinds).toEqual(new Set(["docx", "bpmn", "ui_mask", "plan"]));
		// Every referenced document exists (validated in parse, asserted here too).
		const ids = new Set(set.documents.map((d) => d.id));
		for (const q of set.questions) expect(ids.has(q.document)).toBe(true);
	});

	test("carries ground-truth extraction annotations of all three kinds", async () => {
		const path = resolve(import.meta.dir, "golden-set", "golden-set.v1.json");
		const set = await loadGoldenSet(path);
		const coverage = extractionCoverage(set);
		expect(coverage.table).toBeGreaterThan(0);
		expect(coverage.label).toBeGreaterThan(0);
		expect(coverage.bpmn).toBeGreaterThan(0);
	});
});

describe("extraction annotations", () => {
	const annotated = {
		...validSet,
		questions: [
			{
				...validSet.questions[0],
				extraction: {
					expectedTable: [
						["ID", "Wert"],
						["A-1", "MUSS"],
					],
					expectedLabels: ["Speichern"],
					expectedNodes: [{ id: "n1", label: "Start" }],
					expectedEdges: [{ from: "n1", to: "n2" }],
				},
			},
		],
	};

	test("parses a full extraction annotation", () => {
		const set = parseGoldenSet(annotated);
		const q = set.questions.at(0);
		expect(q?.extraction?.expectedTable).toEqual([
			["ID", "Wert"],
			["A-1", "MUSS"],
		]);
		expect(q?.extraction?.expectedEdges).toEqual([{ from: "n1", to: "n2" }]);
		expect(hasExtractionAnnotation(q as never)).toBe(true);
	});

	test("rejects a table that is not a grid of string cells", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [
					{
						...validSet.questions[0],
						extraction: { expectedTable: [["ok"], [1]] },
					},
				],
			}),
		).toThrow(/must be a string/);
	});

	test("rejects a node with neither id nor label", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [
					{
						...validSet.questions[0],
						extraction: { expectedNodes: [{}] },
					},
				],
			}),
		).toThrow(/id or a label/);
	});

	test("rejects an edge without from/to", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [
					{
						...validSet.questions[0],
						extraction: { expectedEdges: [{ from: "n1" }] },
					},
				],
			}),
		).toThrow(/to/);
	});

	test("a question without an annotation reports none", () => {
		const set = parseGoldenSet(validSet);
		expect(hasExtractionAnnotation(set.questions[0] as never)).toBe(false);
	});
});

describe("abstain questions", () => {
	const abstainQuestion = {
		id: "qa",
		document: "d1",
		question: "Wo steht etwas Unbekanntes?",
		expectedPages: [],
		expectedFigures: [],
		expectedCells: [],
		abstain: true,
	};

	test("accepts an abstain question without an expected answer", () => {
		const set = parseGoldenSet({
			...validSet,
			questions: [...validSet.questions, abstainQuestion],
		});
		expect(set.questions.at(1)?.abstain).toBe(true);
		expect(set.questions.at(0)?.abstain).toBeUndefined();
	});

	test("rejects an abstain question that carries an expected answer", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [{ ...abstainQuestion, expectedPages: [2] }],
			}),
		).toThrow(/abstain but carries/);
	});

	test("rejects a non-boolean abstain flag", () => {
		expect(() =>
			parseGoldenSet({
				...validSet,
				questions: [{ ...abstainQuestion, abstain: "yes" }],
			}),
		).toThrow(/abstain must be a boolean/);
	});

	test("shipped fixture: 15–20 % abstain questions whose subject is absent from the corpus", async () => {
		const set = await loadGoldenSet(
			resolve(import.meta.dir, "golden-set", "golden-set.v1.json"),
		);
		const abstain = set.questions.filter((q) => q.abstain === true);
		const share = abstain.length / set.questions.length;
		expect(share).toBeGreaterThanOrEqual(0.15);
		expect(share).toBeLessThanOrEqual(0.2);
		// The corpus is built without abstain questions, so none of their wording
		// may appear in it: every question needs a content word (>= 8 letters)
		// that the generated corpus never uses.
		const corpus = JSON.stringify(buildCorpus(set)).toLowerCase();
		for (const q of abstain) {
			expect(corpus.includes(q.question.toLowerCase())).toBe(false);
			const words = q.question.toLowerCase().match(/[a-zäöüß-]{8,}/g) ?? [];
			const absent = words.filter((w) => !corpus.includes(w));
			expect({ id: q.id, absentWords: absent.length > 0 }).toEqual({
				id: q.id,
				absentWords: true,
			});
		}
	});
});
