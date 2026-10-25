// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure, deterministic extraction-quality metrics for the golden-set harness
 * (task T2.10).
 *
 * Where `metrics.ts` scores *retrieval* — did the right page/figure come back —
 * these score *extraction*: given the ground-truth content of a table, a figure
 * or a BPMN diagram, how much of it did the pipeline reproduce. All three are
 * pure functions over plain data, so they unit-test with no server, model or DB:
 * the caller supplies the expected content (from the golden set's new extraction
 * annotations) and the produced content (from a `table`/`data` block, a figure
 * transcription's labels, or a `process` transcription).
 *
 * Definitions mirror the runtime where an equivalent exists but measure against
 * the golden ground truth rather than the pipeline's own output:
 *
 *   - Table-cell accuracy — position-aware, whitespace-normalised fraction of
 *     expected cells whose value matches the produced cell at the same
 *     (row, col). A produced grid missing a cell counts that cell as wrong.
 *   - Label-coverage — the eval flavour of the runtime `labelCoverage`
 *     (`apps/extract/src/vision/response.ts`): the fraction of the *expected*
 *     labels that appear in the produced text/labels. The runtime one measures
 *     its own transcription against the labels it extracted from the region; the
 *     eval one measures against labels a human annotated as ground truth.
 *   - BPMN node/edge recall — the fraction of expected nodes (by id or label)
 *     and of expected edges (from→to, direction-sensitive) the produced process
 *     recovered.
 *
 * Normalisation is shared and intentionally simple: collapse internal
 * whitespace, trim, lower-case. It is enough to stop a trailing space or a
 * capitalised header from being scored as a mismatch without masking a genuine
 * difference in content.
 */

const round = (value: number): number => Math.round(value * 1e12) / 1e12;

/** Collapse internal whitespace, trim and lower-case for tolerant comparison. */
export function normaliseCell(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

// ─── Table-cell accuracy ───────────────────────────────────────────────────────

/** A table as a grid of rows, each an array of cell strings. */
export type Grid = readonly (readonly string[])[];

export interface TableCellAccuracy {
	/** Correct cells / expected cells, in [0, 1]. 1 when nothing is expected. */
	accuracy: number;
	/** Number of expected (ground-truth) cells. */
	expected: number;
	/** Number of expected cells matched at the same position. */
	matched: number;
}

/**
 * Position-aware table-cell accuracy. Every ground-truth cell contributes one
 * comparison against the produced cell at the same (row, col); a produced grid
 * that is shorter — a missing row or a short row — scores those cells as misses
 * rather than throwing. Cells are compared after {@link normaliseCell}.
 *
 * An empty expected grid is fully accurate (1): there is nothing to get wrong.
 * This is deliberate so a figure with no table annotation never drags the score
 * down.
 */
export function tableCellAccuracy(
	expected: Grid,
	produced: Grid,
): TableCellAccuracy {
	let expectedCount = 0;
	let matched = 0;
	for (let r = 0; r < expected.length; r++) {
		const expectedRow = expected[r] ?? [];
		const producedRow = produced[r] ?? [];
		for (let c = 0; c < expectedRow.length; c++) {
			expectedCount++;
			const want = normaliseCell(expectedRow[c] ?? "");
			const got = normaliseCell(producedRow[c] ?? "");
			// A blank expected cell matches only a blank produced cell; both empty
			// is a match (an intentionally empty cell correctly reproduced).
			if (want === got) matched++;
		}
	}
	return {
		accuracy: expectedCount === 0 ? 1 : round(matched / expectedCount),
		expected: expectedCount,
		matched,
	};
}

// ─── Label-coverage (extraction flavour) ───────────────────────────────────────

export interface LabelCoverage {
	/** Covered labels / expected labels, in [0, 1]. 1 when nothing is expected. */
	coverage: number;
	/** Number of expected (ground-truth) labels. */
	expected: number;
	/** Number of expected labels found in the produced text. */
	covered: number;
	/** The expected labels that were not found, for reporting. */
	missing: string[];
}

/**
 * Fraction of the expected labels present in the produced text. `producedText`
 * is any flattened transcription/label text; each expected label is matched as a
 * whitespace-normalised, case-insensitive substring — the same containment test
 * the runtime uses, but over the golden ground truth.
 *
 * An empty expected-label set is fully covered (1): nothing to miss.
 */
export function labelCoverage(
	expectedLabels: readonly string[],
	producedText: string,
): LabelCoverage {
	const wanted = expectedLabels
		.map((label) => normaliseCell(label))
		.filter((label) => label !== "");
	if (wanted.length === 0) {
		return { coverage: 1, expected: 0, covered: 0, missing: [] };
	}
	const haystack = normaliseCell(producedText);
	const missing: string[] = [];
	let covered = 0;
	for (const label of wanted) {
		if (haystack.includes(label)) covered++;
		else missing.push(label);
	}
	return {
		coverage: round(covered / wanted.length),
		expected: wanted.length,
		covered,
		missing,
	};
}

// ─── BPMN node / edge recall ───────────────────────────────────────────────────

/** A BPMN/flowchart node identified by id and/or label. */
export interface BpmnNode {
	id?: string;
	label?: string;
}

/** A directed BPMN/flowchart edge from one node to another. */
export interface BpmnEdge {
	from: string;
	to: string;
}

export interface BpmnRecall {
	nodeRecall: number;
	edgeRecall: number;
	expectedNodes: number;
	recoveredNodes: number;
	expectedEdges: number;
	recoveredEdges: number;
}

/**
 * Node and edge recall for a BPMN/flowchart transcription.
 *
 * A node is "recovered" when the produced process contains a node whose
 * normalised id or label matches the expected node's id or label — a diagram may
 * be recognised by either, so matching on either is the fair test. An edge is
 * recovered when the produced process contains an edge whose normalised
 * (from, to) pair matches, direction included: A→B and B→A are different edges.
 *
 * Edges reference nodes by id, so the expected edges must use the expected
 * nodes' ids. Empty expected sets recall fully (1) — there is nothing to miss.
 */
export function bpmnRecall(
	expectedNodes: readonly BpmnNode[],
	expectedEdges: readonly BpmnEdge[],
	produced: { nodes: readonly BpmnNode[]; edges: readonly BpmnEdge[] },
): BpmnRecall {
	// Build the produced identity sets once.
	const producedNodeKeys = new Set<string>();
	for (const node of produced.nodes) {
		const id = normaliseCell(node.id ?? "");
		const label = normaliseCell(node.label ?? "");
		if (id !== "") producedNodeKeys.add(`id:${id}`);
		if (label !== "") producedNodeKeys.add(`label:${label}`);
	}
	const producedEdgeKeys = new Set<string>();
	for (const edge of produced.edges) {
		producedEdgeKeys.add(
			`${normaliseCell(edge.from)}\u0000${normaliseCell(edge.to)}`,
		);
	}

	let recoveredNodes = 0;
	for (const node of expectedNodes) {
		const id = normaliseCell(node.id ?? "");
		const label = normaliseCell(node.label ?? "");
		const found =
			(id !== "" && producedNodeKeys.has(`id:${id}`)) ||
			(label !== "" && producedNodeKeys.has(`label:${label}`));
		if (found) recoveredNodes++;
	}

	let recoveredEdges = 0;
	for (const edge of expectedEdges) {
		const key = `${normaliseCell(edge.from)}\u0000${normaliseCell(edge.to)}`;
		if (producedEdgeKeys.has(key)) recoveredEdges++;
	}

	return {
		nodeRecall:
			expectedNodes.length === 0
				? 1
				: round(recoveredNodes / expectedNodes.length),
		edgeRecall:
			expectedEdges.length === 0
				? 1
				: round(recoveredEdges / expectedEdges.length),
		expectedNodes: expectedNodes.length,
		recoveredNodes,
		expectedEdges: expectedEdges.length,
		recoveredEdges,
	};
}

// ─── Aggregate over many annotated cases ───────────────────────────────────────

/** One annotated extraction case: expected ground truth plus produced output. */
export interface ExtractionCase {
	id: string;
	/** Expected table grid, when the case annotates a table. */
	expectedTable?: Grid;
	/** Produced table grid, from a `table`/`data` block transcription. */
	producedTable?: Grid;
	/** Expected figure labels, when the case annotates a figure. */
	expectedLabels?: readonly string[];
	/** Produced flattened transcription/label text for the figure. */
	producedText?: string;
	/** Expected BPMN nodes, when the case annotates a process diagram. */
	expectedNodes?: readonly BpmnNode[];
	/** Expected BPMN edges. */
	expectedEdges?: readonly BpmnEdge[];
	/** Produced process transcription. */
	producedProcess?: { nodes: readonly BpmnNode[]; edges: readonly BpmnEdge[] };
}

export interface ExtractionMetrics {
	tableCell: {
		/** Micro-averaged: total matched cells / total expected cells. */
		accuracy: number;
		cases: number;
		expectedCells: number;
		matchedCells: number;
	};
	label: {
		coverage: number;
		cases: number;
		expectedLabels: number;
		coveredLabels: number;
	};
	bpmn: {
		nodeRecall: number;
		edgeRecall: number;
		cases: number;
		expectedNodes: number;
		recoveredNodes: number;
		expectedEdges: number;
		recoveredEdges: number;
	};
	/** True when no case carried a produced output — an offline skeleton. */
	pending: boolean;
}

/**
 * Aggregate the three extraction metrics over a set of annotated cases.
 *
 * Averaging is **micro** (pool the counts, then divide) so a table with many
 * cells weighs proportionally more than a two-cell table — the right default for
 * an accuracy that is fundamentally per-cell. Only cases that carry both an
 * expected annotation and a produced output contribute; a case with an
 * annotation but no produced output (the offline skeleton) is counted as pending
 * and contributes zero produced cells, so the harness reports "pending" rather
 * than a misleading 0 %.
 */
export function aggregateExtractionMetrics(
	cases: readonly ExtractionCase[],
): ExtractionMetrics {
	let tableCases = 0;
	let expectedCells = 0;
	let matchedCells = 0;
	let hasProducedTable = false;

	let labelCases = 0;
	let expectedLabels = 0;
	let coveredLabels = 0;
	let hasProducedText = false;

	let bpmnCases = 0;
	let expectedNodes = 0;
	let recoveredNodes = 0;
	let expectedEdges = 0;
	let recoveredEdges = 0;
	let hasProducedProcess = false;

	for (const c of cases) {
		if (c.expectedTable !== undefined) {
			tableCases++;
			const produced = c.producedTable ?? [];
			if (c.producedTable !== undefined) hasProducedTable = true;
			const acc = tableCellAccuracy(c.expectedTable, produced);
			expectedCells += acc.expected;
			matchedCells += acc.matched;
		}
		if (c.expectedLabels !== undefined) {
			labelCases++;
			const text = c.producedText ?? "";
			if (c.producedText !== undefined) hasProducedText = true;
			const cov = labelCoverage(c.expectedLabels, text);
			expectedLabels += cov.expected;
			coveredLabels += cov.covered;
		}
		if (c.expectedNodes !== undefined || c.expectedEdges !== undefined) {
			bpmnCases++;
			const produced = c.producedProcess ?? { nodes: [], edges: [] };
			if (c.producedProcess !== undefined) hasProducedProcess = true;
			const rec = bpmnRecall(
				c.expectedNodes ?? [],
				c.expectedEdges ?? [],
				produced,
			);
			expectedNodes += rec.expectedNodes;
			recoveredNodes += rec.recoveredNodes;
			expectedEdges += rec.expectedEdges;
			recoveredEdges += rec.recoveredEdges;
		}
	}

	const pending =
		(tableCases > 0 && !hasProducedTable) ||
		(labelCases > 0 && !hasProducedText) ||
		(bpmnCases > 0 && !hasProducedProcess);

	return {
		tableCell: {
			accuracy: expectedCells === 0 ? 0 : round(matchedCells / expectedCells),
			cases: tableCases,
			expectedCells,
			matchedCells,
		},
		label: {
			coverage:
				expectedLabels === 0 ? 0 : round(coveredLabels / expectedLabels),
			cases: labelCases,
			expectedLabels,
			coveredLabels,
		},
		bpmn: {
			nodeRecall:
				expectedNodes === 0 ? 0 : round(recoveredNodes / expectedNodes),
			edgeRecall:
				expectedEdges === 0 ? 0 : round(recoveredEdges / expectedEdges),
			cases: bpmnCases,
			expectedNodes,
			recoveredNodes,
			expectedEdges,
			recoveredEdges,
		},
		pending,
	};
}
