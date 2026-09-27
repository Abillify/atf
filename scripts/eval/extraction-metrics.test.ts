// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
	aggregateExtractionMetrics,
	bpmnRecall,
	type ExtractionCase,
	labelCoverage,
	normaliseCell,
	tableCellAccuracy,
} from "./extraction-metrics.ts";

describe("normaliseCell", () => {
	test("collapses whitespace, trims and lower-cases", () => {
		expect(normaliseCell("  A  B\tC \n")).toBe("a b c");
	});
});

describe("tableCellAccuracy", () => {
	test("full accuracy when every cell matches after normalisation", () => {
		const expected = [
			["ID", "Wert"],
			["A-001", "MUSS"],
		];
		const produced = [
			["id", " Wert "],
			["a-001", "muss"],
		];
		const r = tableCellAccuracy(expected, produced);
		expect(r.accuracy).toBe(1);
		expect(r.expected).toBe(4);
		expect(r.matched).toBe(4);
	});

	test("position-aware: a shifted value is a miss", () => {
		const expected = [["A", "B"]];
		const produced = [["B", "A"]];
		expect(tableCellAccuracy(expected, produced).accuracy).toBe(0);
	});

	test("missing produced rows and short rows score as misses", () => {
		const expected = [
			["A", "B"],
			["C", "D"],
		];
		const produced = [["A"]]; // second row absent, first row short
		const r = tableCellAccuracy(expected, produced);
		expect(r.expected).toBe(4);
		expect(r.matched).toBe(1); // only A at (0,0)
		expect(r.accuracy).toBe(0.25);
	});

	test("extra produced cells beyond the expected grid are ignored", () => {
		const expected = [["A"]];
		const produced = [["A", "X"], ["Y"]];
		expect(tableCellAccuracy(expected, produced).accuracy).toBe(1);
	});

	test("an empty expected grid is fully accurate", () => {
		expect(tableCellAccuracy([], [["anything"]]).accuracy).toBe(1);
	});

	test("an intentionally blank expected cell matches a blank produced cell", () => {
		const r = tableCellAccuracy([["A", ""]], [["A", "  "]]);
		expect(r.accuracy).toBe(1);
	});
});

describe("labelCoverage", () => {
	test("counts the fraction of expected labels present in the text", () => {
		const r = labelCoverage(
			["Speichern", "Abbrechen", "Feld 1"],
			"Der Dialog zeigt Speichern und Feld 1.",
		);
		expect(r.expected).toBe(3);
		expect(r.covered).toBe(2);
		expect(r.coverage).toBeCloseTo(2 / 3, 12);
		expect(r.missing).toEqual(["abbrechen"]);
	});

	test("matching is case- and whitespace-insensitive", () => {
		expect(labelCoverage(["Feld  1"], "das feld 1 ist da").coverage).toBe(1);
	});

	test("an empty expected-label set is fully covered", () => {
		const r = labelCoverage([], "");
		expect(r.coverage).toBe(1);
		expect(r.expected).toBe(0);
	});

	test("blank labels are ignored, not counted as misses", () => {
		const r = labelCoverage(["", "  ", "X"], "contains x");
		expect(r.expected).toBe(1);
		expect(r.coverage).toBe(1);
	});
});

describe("bpmnRecall", () => {
	const expectedNodes = [
		{ id: "start", label: "Start" },
		{ id: "task", label: "Prüfung" },
		{ id: "end", label: "Ende" },
	];
	const expectedEdges = [
		{ from: "start", to: "task" },
		{ from: "task", to: "end" },
	];

	test("full recall when every node and edge is reproduced", () => {
		const r = bpmnRecall(expectedNodes, expectedEdges, {
			nodes: expectedNodes,
			edges: expectedEdges,
		});
		expect(r.nodeRecall).toBe(1);
		expect(r.edgeRecall).toBe(1);
	});

	test("a node is recovered by id OR by label", () => {
		const r = bpmnRecall(expectedNodes, [], {
			// start matched by id, task matched by label only, end missing.
			nodes: [{ id: "start" }, { label: "Prüfung" }],
			edges: [],
		});
		expect(r.recoveredNodes).toBe(2);
		expect(r.nodeRecall).toBeCloseTo(2 / 3, 12);
	});

	test("edge recall is direction-sensitive", () => {
		const r = bpmnRecall([], expectedEdges, {
			nodes: [],
			edges: [
				{ from: "task", to: "start" }, // reversed — not a match
				{ from: "task", to: "end" }, // matches
			],
		});
		expect(r.recoveredEdges).toBe(1);
		expect(r.edgeRecall).toBe(0.5);
	});

	test("empty expected sets recall fully", () => {
		const r = bpmnRecall([], [], { nodes: [], edges: [] });
		expect(r.nodeRecall).toBe(1);
		expect(r.edgeRecall).toBe(1);
	});
});

describe("aggregateExtractionMetrics", () => {
	test("micro-averages cell accuracy across tables of different sizes", () => {
		const cases: ExtractionCase[] = [
			{
				id: "big",
				expectedTable: [
					["a", "b", "c"],
					["d", "e", "f"],
				],
				producedTable: [
					["a", "b", "c"],
					["d", "e", "f"],
				], // 6/6
			},
			{
				id: "small",
				expectedTable: [["x", "y"]],
				producedTable: [["x", "WRONG"]], // 1/2
			},
		];
		const m = aggregateExtractionMetrics(cases);
		// Micro: (6 + 1) / (6 + 2) = 7/8
		expect(m.tableCell.expectedCells).toBe(8);
		expect(m.tableCell.matchedCells).toBe(7);
		expect(m.tableCell.accuracy).toBe(0.875);
		expect(m.pending).toBe(false);
	});

	test("aggregates label coverage and BPMN recall across cases", () => {
		const cases: ExtractionCase[] = [
			{
				id: "fig",
				expectedLabels: ["A", "B"],
				producedText: "only A here",
			},
			{
				id: "proc",
				expectedNodes: [{ id: "n1" }, { id: "n2" }],
				expectedEdges: [{ from: "n1", to: "n2" }],
				producedProcess: { nodes: [{ id: "n1" }], edges: [] },
			},
		];
		const m = aggregateExtractionMetrics(cases);
		expect(m.label.coverage).toBe(0.5);
		expect(m.bpmn.nodeRecall).toBe(0.5);
		expect(m.bpmn.edgeRecall).toBe(0);
		expect(m.pending).toBe(false);
	});

	test("annotations without produced output report as pending", () => {
		const cases: ExtractionCase[] = [
			{ id: "t", expectedTable: [["a"]] }, // no producedTable
			{ id: "f", expectedLabels: ["A"] }, // no producedText
		];
		const m = aggregateExtractionMetrics(cases);
		expect(m.pending).toBe(true);
		expect(m.tableCell.accuracy).toBe(0);
		expect(m.label.coverage).toBe(0);
		// Counts of expected items are still reported for the coverage view.
		expect(m.tableCell.expectedCells).toBe(1);
		expect(m.label.expectedLabels).toBe(1);
	});

	test("no annotated cases yields zero metrics and not pending", () => {
		const m = aggregateExtractionMetrics([]);
		expect(m.pending).toBe(false);
		expect(m.tableCell.accuracy).toBe(0);
		expect(m.label.coverage).toBe(0);
		expect(m.bpmn.nodeRecall).toBe(0);
	});
});
