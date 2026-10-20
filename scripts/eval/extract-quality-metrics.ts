// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Pure, deterministic text/structure metrics for the extraction-quality
 * harness (`extract-quality.ts`, review item P1-E9).
 *
 * The retrieval harness (`metrics.ts`) asks whether the right page comes back;
 * `extraction-metrics.ts` scores table cells, figure labels and BPMN graphs
 * against a golden set. These three score the extraction itself, the way the
 * document-parsing literature does, so a change of model, DPI or prompt can be
 * judged by a number instead of by looking at a few pages:
 *
 *   CER         character error rate of the running text: Levenshtein distance
 *               over Unicode code points divided by the reference length. 0 is
 *               perfect; it can exceed 1 when the output is mostly insertions.
 *   Heading-F1  precision / recall / F1 over the headings, matched as a
 *               multiset on the normalised text (and, in the strict variant, on
 *               the level too).
 *   TEDS        tree-edit-distance based similarity of two tables (Zhong et
 *               al., "Image-based table recognition", ECCV 2020):
 *               1 - TED / max(|T_expected|, |T_produced|) on the tree
 *               table → tr → td, where a td carries its span attributes and its
 *               text. Inserting or deleting a node costs 1; renaming a td whose
 *               spans match costs the normalised Levenshtein distance of the
 *               two cell texts, any other mismatch costs 1. `structureOnly`
 *               ignores the cell text (TEDS-S).
 *
 * Everything here is a function of plain data: no I/O, no model, no clock.
 */

const round = (value: number): number => Math.round(value * 1e9) / 1e9;

/** NFC, runs of whitespace collapsed to one space, trimmed. */
export function normaliseText(value: string): string {
	return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

// ─── CER ─────────────────────────────────────────────────────────────────────

/** Levenshtein distance between two strings, over Unicode code points. */
export function levenshtein(a: string, b: string): number {
	const left = Array.from(a);
	const right = Array.from(b);
	if (left.length === 0) return right.length;
	if (right.length === 0) return left.length;
	let previous = new Uint32Array(right.length + 1);
	let current = new Uint32Array(right.length + 1);
	for (let j = 0; j <= right.length; j++) previous[j] = j;
	for (let i = 1; i <= left.length; i++) {
		current[0] = i;
		const leftChar = left[i - 1];
		for (let j = 1; j <= right.length; j++) {
			const substitution = (previous[j - 1] ?? 0) + (leftChar === right[j - 1] ? 0 : 1);
			const deletion = (previous[j] ?? 0) + 1;
			const insertion = (current[j - 1] ?? 0) + 1;
			current[j] = Math.min(substitution, deletion, insertion);
		}
		[previous, current] = [current, previous];
	}
	return previous[right.length] ?? 0;
}

/** The product of the two lengths above which {@link cer} refuses (split the case into pages). */
export const MAX_CER_CELLS = 100_000_000;

export interface Cer {
	/** Edit distance between the normalised texts. */
	distance: number;
	/** Length of the normalised reference, in code points. */
	length: number;
	/** `distance / length`; 0 for an empty reference with an empty output. */
	cer: number;
}

/** Character error rate of `produced` against `expected`, both normalised first. */
export function cer(expected: string, produced: string): Cer {
	const reference = normaliseText(expected);
	const hypothesis = normaliseText(produced);
	const length = Array.from(reference).length;
	if (length * Array.from(hypothesis).length > MAX_CER_CELLS) {
		throw new Error("text too long for a single CER computation; score it page by page");
	}
	const distance = levenshtein(reference, hypothesis);
	return { distance, length, cer: length === 0 ? (distance === 0 ? 0 : 1) : round(distance / length) };
}

/** Pool several CERs: total distance over total reference length. */
export function pooledCer(items: readonly Cer[]): Cer {
	const distance = items.reduce((sum, item) => sum + item.distance, 0);
	const length = items.reduce((sum, item) => sum + item.length, 0);
	return { distance, length, cer: length === 0 ? (distance === 0 ? 0 : 1) : round(distance / length) };
}

// ─── Heading-F1 ──────────────────────────────────────────────────────────────

export interface Heading {
	level: number;
	text: string;
}

export interface PrecisionRecall {
	truePositives: number;
	falsePositives: number;
	falseNegatives: number;
	precision: number;
	recall: number;
	f1: number;
}

/** Precision/recall/F1 from counts; nothing expected and nothing produced is a perfect 1. */
export function prf(truePositives: number, falsePositives: number, falseNegatives: number): PrecisionRecall {
	const produced = truePositives + falsePositives;
	const expected = truePositives + falseNegatives;
	if (produced === 0 && expected === 0) {
		return { truePositives, falsePositives, falseNegatives, precision: 1, recall: 1, f1: 1 };
	}
	const precision = produced === 0 ? 0 : truePositives / produced;
	const recall = expected === 0 ? 0 : truePositives / expected;
	const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
	return {
		truePositives,
		falsePositives,
		falseNegatives,
		precision: round(precision),
		recall: round(recall),
		f1: round(f1),
	};
}

/**
 * Heading precision/recall/F1. Headings are matched as a multiset: the same
 * heading twice in the reference needs two matching headings in the output.
 * `matchLevel` additionally requires the level to agree (the strict variant:
 * a "1.2" produced as an H1 is wrong).
 */
export function headingF1(
	expected: readonly Heading[],
	produced: readonly Heading[],
	options: { matchLevel: boolean },
): PrecisionRecall {
	const key = (heading: Heading): string =>
		`${options.matchLevel ? `${heading.level}\u0000` : ""}${normaliseText(heading.text).toLowerCase()}`;
	const available = new Map<string, number>();
	for (const heading of produced) available.set(key(heading), (available.get(key(heading)) ?? 0) + 1);
	let truePositives = 0;
	for (const heading of expected) {
		const k = key(heading);
		const left = available.get(k) ?? 0;
		if (left > 0) {
			truePositives++;
			available.set(k, left - 1);
		}
	}
	return prf(truePositives, produced.length - truePositives, expected.length - truePositives);
}

/** Pool precision/recall counts across cases (micro average). */
export function pooledPrf(items: readonly PrecisionRecall[]): PrecisionRecall {
	return prf(
		items.reduce((sum, item) => sum + item.truePositives, 0),
		items.reduce((sum, item) => sum + item.falsePositives, 0),
		items.reduce((sum, item) => sum + item.falseNegatives, 0),
	);
}

// ─── TEDS ────────────────────────────────────────────────────────────────────

/** A table cell: plain text, or text with spans/header flag (the contract's `Cell`). */
export type TableCell = string | { text: string; colspan?: number; rowspan?: number; header?: boolean };

/** A table as header rows followed by body rows. */
export interface Table {
	headerRows?: readonly (readonly TableCell[])[];
	rows: readonly (readonly TableCell[])[];
}

interface TreeNode {
	label: "table" | "tr" | "td";
	/** `colspan/rowspan` for a td. */
	attrs: string;
	text: string;
	children: TreeNode[];
}

function cellTree(cell: TableCell): TreeNode {
	const spec = typeof cell === "string" ? { text: cell } : cell;
	return {
		label: "td",
		attrs: `${spec.colspan ?? 1}x${spec.rowspan ?? 1}`,
		text: normaliseText(spec.text),
		children: [],
	};
}

function tableTree(table: Table): TreeNode {
	const rows = [...(table.headerRows ?? []), ...table.rows];
	return {
		label: "table",
		attrs: "",
		text: "",
		children: rows.map((row) => ({ label: "tr", attrs: "", text: "", children: row.map(cellTree) })),
	};
}

function treeSize(node: TreeNode): number {
	return 1 + node.children.reduce((sum, child) => sum + treeSize(child), 0);
}

interface Flat {
	nodes: TreeNode[];
	leftmost: number[];
	keyroots: number[];
}

/** Post-order flattening with 1-based indices, as the Zhang–Shasha algorithm wants. */
function flatten(root: TreeNode): Flat {
	const nodes: TreeNode[] = [root];
	const leftmost: number[] = [0];
	const visit = (node: TreeNode): number => {
		let first = -1;
		for (const child of node.children) {
			const childFirst = visit(child);
			if (first === -1) first = childFirst;
		}
		nodes.push(node);
		const index = nodes.length - 1;
		if (first === -1) first = index;
		leftmost[index] = first;
		return first;
	};
	visit(root);
	const seen = new Set<number>();
	const keyroots: number[] = [];
	for (let i = nodes.length - 1; i >= 1; i--) {
		const l = leftmost[i] ?? 0;
		if (!seen.has(l)) {
			seen.add(l);
			keyroots.push(i);
		}
	}
	return { nodes, leftmost, keyroots: keyroots.sort((x, y) => x - y) };
}

/** Normalised Levenshtein distance in [0, 1]. */
function normalisedDistance(a: string, b: string): number {
	if (a === b) return 0;
	const longest = Math.max(Array.from(a).length, Array.from(b).length);
	return longest === 0 ? 0 : levenshtein(a, b) / longest;
}

/** Tree edit distance (Zhang & Shasha, 1989) with unit insert/delete cost. */
function treeEditDistance(
	a: TreeNode,
	b: TreeNode,
	rename: (x: TreeNode, y: TreeNode) => number,
): number {
	const A = flatten(a);
	const B = flatten(b);
	const sizeA = A.nodes.length - 1;
	const sizeB = B.nodes.length - 1;
	const td: number[][] = Array.from({ length: sizeA + 1 }, () => new Array<number>(sizeB + 1).fill(0));
	for (const i of A.keyroots) {
		for (const j of B.keyroots) {
			const li = A.leftmost[i] ?? 0;
			const lj = B.leftmost[j] ?? 0;
			const m = i - li + 2;
			const n = j - lj + 2;
			const fd: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(0));
			for (let di = 1; di < m; di++) (fd[di] as number[])[0] = ((fd[di - 1] as number[])[0] ?? 0) + 1;
			for (let dj = 1; dj < n; dj++) (fd[0] as number[])[dj] = ((fd[0] as number[])[dj - 1] ?? 0) + 1;
			for (let di = 1; di < m; di++) {
				for (let dj = 1; dj < n; dj++) {
					const i1 = li + di - 1;
					const j1 = lj + dj - 1;
					const row = fd[di] as number[];
					const up = (fd[di - 1] as number[])[dj] ?? 0;
					const left = row[dj - 1] ?? 0;
					if ((A.leftmost[i1] ?? 0) === li && (B.leftmost[j1] ?? 0) === lj) {
						const diagonal = (fd[di - 1] as number[])[dj - 1] ?? 0;
						const value = Math.min(
							up + 1,
							left + 1,
							diagonal + rename(A.nodes[i1] as TreeNode, B.nodes[j1] as TreeNode),
						);
						row[dj] = value;
						(td[i1] as number[])[j1] = value;
					} else {
						const p = (A.leftmost[i1] ?? 0) - li;
						const q = (B.leftmost[j1] ?? 0) - lj;
						const diagonal = (fd[p] as number[])[q] ?? 0;
						row[dj] = Math.min(up + 1, left + 1, diagonal + ((td[i1] as number[])[j1] ?? 0));
					}
				}
			}
		}
	}
	return (td[sizeA] as number[])[sizeB] ?? 0;
}

/**
 * TEDS of `produced` against `expected`, in [0, 1] (1 = identical).
 * `structureOnly` compares the row/column/span structure and ignores the text.
 */
export function teds(expected: Table, produced: Table, options: { structureOnly?: boolean } = {}): number {
	const a = tableTree(expected);
	const b = tableTree(produced);
	const rename = (x: TreeNode, y: TreeNode): number => {
		if (x.label !== y.label) return 1;
		if (x.label !== "td") return 0;
		if (x.attrs !== y.attrs) return 1;
		return options.structureOnly === true ? 0 : normalisedDistance(x.text, y.text);
	};
	const distance = treeEditDistance(a, b, rename);
	return round(Math.max(0, 1 - distance / Math.max(treeSize(a), treeSize(b))));
}

export interface TableMatch {
	/** TEDS of each expected table, in order; 0 for an expected table nothing matched. */
	teds: number[];
	/** TEDS-S (structure only), same order. */
	tedsStructure: number[];
	/** Produced tables no expected table was matched to. */
	extra: number;
}

/**
 * Pair the expected tables of a page with the produced ones: repeatedly take
 * the best-scoring unused pair (greedy on TEDS). An expected table with no
 * counterpart scores 0; a produced table nothing claims is counted as `extra`
 * and does not lower the scores (it is a false positive, reported on its own).
 */
export function matchTables(expected: readonly Table[], produced: readonly Table[]): TableMatch {
	const scores = expected.map((e) => produced.map((p) => teds(e, p)));
	const usedExpected = new Set<number>();
	const usedProduced = new Set<number>();
	const pairs: Array<[number, number, number]> = [];
	for (let i = 0; i < expected.length; i++) {
		for (let j = 0; j < produced.length; j++) pairs.push([i, j, scores[i]?.[j] ?? 0]);
	}
	pairs.sort((x, y) => y[2] - x[2] || x[0] - y[0] || x[1] - y[1]);
	const matched = new Map<number, number>();
	for (const [i, j] of pairs) {
		if (usedExpected.has(i) || usedProduced.has(j)) continue;
		usedExpected.add(i);
		usedProduced.add(j);
		matched.set(i, j);
	}
	return {
		teds: expected.map((_, i) => {
			const j = matched.get(i);
			return j === undefined ? 0 : (scores[i]?.[j] ?? 0);
		}),
		tedsStructure: expected.map((e, i) => {
			const j = matched.get(i);
			const p = j === undefined ? undefined : produced[j];
			return p === undefined ? 0 : teds(e, p, { structureOnly: true });
		}),
		extra: produced.length - usedProduced.size,
	};
}

/** Arithmetic mean; `null` for no items. */
export function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
