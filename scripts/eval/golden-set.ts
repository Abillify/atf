// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Golden-set fixture model and loader for the retrieval eval harness.
 *
 * The fixture is a versioned JSON file (see `golden-set/*.json`). It describes a
 * small set of representative documents and 100–150 questions, each annotated
 * with the page, figure and/or table cell that a correct answer must come from.
 *
 * The fixture that ships in the repository is deliberately **synthetic**: it
 * carries no confidential content so it survives the public-tree guard
 * (`bun run verify:public`). A deployment points the harness at its own,
 * out-of-tree fixture through `--fixture` when it wants to measure against real
 * corpora.
 *
 * References follow the Search result contract:
 *   - a document is addressed by its `base_ref` (path-style, NFC),
 *   - a page by `<base_ref>#page=<n>`,
 *   - a figure by `<base_ref>#figure=<figureId>`,
 *   - a table cell by `<base_ref>#page=<n>;cell=<row>,<col>`.
 * The harness derives the same references from a search hit's `base_ref` and
 * `evidence` (`page_start`/`page_end`, `modality:"image"` + `figure_id`), so a
 * comparison is a plain set-membership test.
 *
 * Validation is intentionally dependency-free (no zod at the repo root) so the
 * harness runs with `bun run scripts/eval/retrieval.ts` without extra installs.
 */

export type GoldenDocumentKind =
	| "docx"
	| "bpmn"
	| "ui_mask"
	| "plan"
	| "pdf"
	| "xlsx"
	| "pptx";

const DOCUMENT_KINDS: readonly GoldenDocumentKind[] = [
	"docx",
	"bpmn",
	"ui_mask",
	"plan",
	"pdf",
	"xlsx",
	"pptx",
];

/** One document in the golden set. */
export interface GoldenDocument {
	/** Stable id used to reference the document from questions. */
	id: string;
	/** `base_ref` under which the document is (or will be) indexed. */
	reference: string;
	/** Original file type, for reporting and coverage checks. */
	kind: GoldenDocumentKind;
	/** Human-readable title. */
	title: string;
	/** Total page count, used to sanity-check expected pages. */
	pages: number;
	/** Optional note describing what the (synthetic) document contains. */
	note?: string;
}

/** A table-cell coordinate on a given page (1-based row/column). */
export interface TableCell {
	page: number;
	row: number;
	col: number;
}

/**
 * Ground-truth extraction annotations for a question (task T2.10). Where the
 * page/figure/cell references above locate *where* an answer lives (retrieval),
 * these carry the *content* a correct extraction must reproduce, so the
 * extraction-quality metrics (table-cell accuracy, label-coverage, BPMN
 * node/edge recall) can score the pipeline's output against a known truth.
 *
 * Every field is optional; a question annotates only the facet it exercises.
 */
export interface ExtractionAnnotation {
	/**
	 * Expected table content as a grid of rows of cell values, position-aware.
	 * Row/column order matches the produced table's reading order.
	 */
	expectedTable?: string[][];
	/** Expected labels a correct figure transcription must surface. */
	expectedLabels?: string[];
	/** Expected BPMN/flowchart nodes (by id and/or label). */
	expectedNodes?: { id?: string; label?: string }[];
	/** Expected BPMN/flowchart directed edges (from→to, node ids). */
	expectedEdges?: { from: string; to: string }[];
}

/** One evaluation question with its ground-truth answer location(s). */
export interface GoldenQuestion {
	id: string;
	/** Document this question is answered from. */
	document: string;
	/** Natural-language question sent to Search verbatim. */
	question: string;
	/** Expected page number(s) (1-based). */
	expectedPages: number[];
	/** Expected figure id(s) on the document, when the answer is a figure. */
	expectedFigures: string[];
	/** Expected table cell(s), when the answer is a specific cell. */
	expectedCells: TableCell[];
	/**
	 * Ground-truth extraction content for the extraction-quality metrics
	 * (task T2.10). Absent for questions that only exercise retrieval.
	 */
	extraction?: ExtractionAnnotation;
}

/** The full versioned fixture. */
export interface GoldenSet {
	/** Semantic version of the fixture; bump on every change. */
	version: string;
	/** Free-text description of provenance and intent. */
	description?: string;
	documents: GoldenDocument[];
	questions: GoldenQuestion[];
}

class GoldenSetError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new GoldenSetError(`${path} must be a non-empty string`);
	}
	return value;
}

function requirePositiveInt(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new GoldenSetError(`${path} must be a positive integer`);
	}
	return value;
}

function optionalIntArray(value: unknown, path: string): number[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new GoldenSetError(`${path} must be an array`);
	return value.map((entry, index) =>
		requirePositiveInt(entry, `${path}[${index}]`),
	);
}

function optionalStringArray(value: unknown, path: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new GoldenSetError(`${path} must be an array`);
	return value.map((entry, index) => requireString(entry, `${path}[${index}]`));
}

function parseGrid(value: unknown, path: string): string[][] {
	if (!Array.isArray(value))
		throw new GoldenSetError(`${path} must be an array of rows`);
	return value.map((row, rowIndex) => {
		if (!Array.isArray(row))
			throw new GoldenSetError(
				`${path}[${rowIndex}] must be an array of cells`,
			);
		return row.map((cell, colIndex) => {
			if (typeof cell !== "string")
				throw new GoldenSetError(
					`${path}[${rowIndex}][${colIndex}] must be a string`,
				);
			return cell;
		});
	});
}

function parseNode(
	value: unknown,
	path: string,
): { id?: string; label?: string } {
	if (!isRecord(value)) throw new GoldenSetError(`${path} must be an object`);
	const node: { id?: string; label?: string } = {};
	if (value.id !== undefined) node.id = requireString(value.id, `${path}.id`);
	if (value.label !== undefined)
		node.label = requireString(value.label, `${path}.label`);
	if (node.id === undefined && node.label === undefined) {
		throw new GoldenSetError(`${path} must have an id or a label`);
	}
	return node;
}

function parseEdge(value: unknown, path: string): { from: string; to: string } {
	if (!isRecord(value)) throw new GoldenSetError(`${path} must be an object`);
	return {
		from: requireString(value.from, `${path}.from`),
		to: requireString(value.to, `${path}.to`),
	};
}

function parseExtraction(value: unknown, path: string): ExtractionAnnotation {
	if (!isRecord(value)) throw new GoldenSetError(`${path} must be an object`);
	const annotation: ExtractionAnnotation = {};
	if (value.expectedTable !== undefined) {
		annotation.expectedTable = parseGrid(
			value.expectedTable,
			`${path}.expectedTable`,
		);
	}
	if (value.expectedLabels !== undefined) {
		annotation.expectedLabels = optionalStringArray(
			value.expectedLabels,
			`${path}.expectedLabels`,
		);
	}
	if (value.expectedNodes !== undefined) {
		if (!Array.isArray(value.expectedNodes))
			throw new GoldenSetError(`${path}.expectedNodes must be an array`);
		annotation.expectedNodes = value.expectedNodes.map((node, index) =>
			parseNode(node, `${path}.expectedNodes[${index}]`),
		);
	}
	if (value.expectedEdges !== undefined) {
		if (!Array.isArray(value.expectedEdges))
			throw new GoldenSetError(`${path}.expectedEdges must be an array`);
		annotation.expectedEdges = value.expectedEdges.map((edge, index) =>
			parseEdge(edge, `${path}.expectedEdges[${index}]`),
		);
	}
	return annotation;
}

function parseCell(value: unknown, path: string): TableCell {
	if (!isRecord(value)) throw new GoldenSetError(`${path} must be an object`);
	return {
		page: requirePositiveInt(value.page, `${path}.page`),
		row: requirePositiveInt(value.row, `${path}.row`),
		col: requirePositiveInt(value.col, `${path}.col`),
	};
}

function parseDocument(value: unknown, path: string): GoldenDocument {
	if (!isRecord(value)) throw new GoldenSetError(`${path} must be an object`);
	const kind = requireString(value.kind, `${path}.kind`) as GoldenDocumentKind;
	if (!DOCUMENT_KINDS.includes(kind)) {
		throw new GoldenSetError(
			`${path}.kind "${kind}" is not one of ${DOCUMENT_KINDS.join(", ")}`,
		);
	}
	const doc: GoldenDocument = {
		id: requireString(value.id, `${path}.id`),
		reference: requireString(value.reference, `${path}.reference`),
		kind,
		title: requireString(value.title, `${path}.title`),
		pages: requirePositiveInt(value.pages, `${path}.pages`),
	};
	if (value.note !== undefined)
		doc.note = requireString(value.note, `${path}.note`);
	return doc;
}

function parseQuestion(value: unknown, path: string): GoldenQuestion {
	if (!isRecord(value)) throw new GoldenSetError(`${path} must be an object`);
	const cells = value.expectedCells;
	const question: GoldenQuestion = {
		id: requireString(value.id, `${path}.id`),
		document: requireString(value.document, `${path}.document`),
		question: requireString(value.question, `${path}.question`),
		expectedPages: optionalIntArray(
			value.expectedPages,
			`${path}.expectedPages`,
		),
		expectedFigures: optionalStringArray(
			value.expectedFigures,
			`${path}.expectedFigures`,
		),
		expectedCells:
			cells === undefined
				? []
				: Array.isArray(cells)
					? cells.map((cell, index) =>
							parseCell(cell, `${path}.expectedCells[${index}]`),
						)
					: (() => {
							throw new GoldenSetError(
								`${path}.expectedCells must be an array`,
							);
						})(),
	};
	if (value.extraction !== undefined) {
		question.extraction = parseExtraction(
			value.extraction,
			`${path}.extraction`,
		);
	}
	return question;
}

/** Parse and validate a golden set from an unknown JSON value. */
export function parseGoldenSet(value: unknown): GoldenSet {
	if (!isRecord(value))
		throw new GoldenSetError("golden set must be a JSON object");
	const version = requireString(value.version, "version");
	const rawDocuments = value.documents;
	const rawQuestions = value.questions;
	if (!Array.isArray(rawDocuments) || rawDocuments.length === 0) {
		throw new GoldenSetError("documents must be a non-empty array");
	}
	if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
		throw new GoldenSetError("questions must be a non-empty array");
	}

	const documents = rawDocuments.map((doc, index) =>
		parseDocument(doc, `documents[${index}]`),
	);
	const questions = rawQuestions.map((q, index) =>
		parseQuestion(q, `questions[${index}]`),
	);

	const docById = new Map<string, GoldenDocument>();
	for (const doc of documents) {
		if (docById.has(doc.id))
			throw new GoldenSetError(`duplicate document id "${doc.id}"`);
		docById.set(doc.id, doc);
	}
	const seenQuestionIds = new Set<string>();
	for (const q of questions) {
		if (seenQuestionIds.has(q.id))
			throw new GoldenSetError(`duplicate question id "${q.id}"`);
		seenQuestionIds.add(q.id);
		const doc = docById.get(q.document);
		if (!doc) {
			throw new GoldenSetError(
				`question "${q.id}" references unknown document "${q.document}"`,
			);
		}
		if (
			q.expectedPages.length === 0 &&
			q.expectedFigures.length === 0 &&
			q.expectedCells.length === 0
		) {
			throw new GoldenSetError(
				`question "${q.id}" has no expected page, figure or cell`,
			);
		}
		for (const page of q.expectedPages) {
			if (page > doc.pages) {
				throw new GoldenSetError(
					`question "${q.id}" expects page ${page} > document pages ${doc.pages}`,
				);
			}
		}
		for (const cell of q.expectedCells) {
			if (cell.page > doc.pages) {
				throw new GoldenSetError(
					`question "${q.id}" cell page ${cell.page} > document pages ${doc.pages}`,
				);
			}
		}
	}

	const set: GoldenSet = { version, documents, questions };
	if (value.description !== undefined) {
		set.description = requireString(value.description, "description");
	}
	return set;
}

/** Load and validate a golden set from a JSON file path. */
export async function loadGoldenSet(path: string): Promise<GoldenSet> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`Golden set not found: ${path}`);
	}
	let raw: unknown;
	try {
		raw = await file.json();
	} catch (error) {
		throw new Error(
			`Golden set ${path} is not valid JSON: ${(error as Error).message}`,
		);
	}
	if (isVariantSet(raw)) {
		const basePath = `${path.slice(0, path.lastIndexOf("/") + 1)}${raw.baseFixture}`;
		return expandVariantSet(raw, await loadGoldenSet(basePath));
	}
	return parseGoldenSet(raw);
}

// ─── German morphology variants ─────────────────────────────────────────────────

/** Morphological phenomenon a variant exercises. */
export type MorphologyPhenomenon = "inflection" | "compound" | "derivation";

export interface MorphologyVariant {
	id: string;
	/** Id of the base question in the base fixture whose answer applies. */
	base: string;
	phenomena: MorphologyPhenomenon[];
	question: string;
}

/**
 * A variant fixture (`de-morphology.v1.json`): questions re-asked with other
 * word forms, answered by their base question. Expanded by
 * {@link expandVariantSet} into an ordinary {@link GoldenSet}.
 */
export interface VariantSet {
	version: string;
	description?: string;
	/** Base fixture file name, resolved next to the variant file. */
	baseFixture: string;
	variants: MorphologyVariant[];
}

const PHENOMENA = new Set<MorphologyPhenomenon>(["inflection", "compound", "derivation"]);

export function isVariantSet(value: unknown): value is VariantSet {
	return isRecord(value) && Array.isArray(value.variants) && typeof value.baseFixture === "string";
}

/** Expands variants into a golden set using the base set's answers and documents. */
export function expandVariantSet(variants: VariantSet, base: GoldenSet): GoldenSet {
	const byId = new Map(base.questions.map((q) => [q.id, q]));
	const seen = new Set<string>();
	const questions = variants.variants.map((v, index) => {
		const where = `variants[${index}]`;
		if (typeof v.id !== "string" || v.id === "" || seen.has(v.id)) {
			throw new GoldenSetError(`${where}: missing or duplicate id`);
		}
		seen.add(v.id);
		const source = byId.get(v.base);
		if (source === undefined) {
			throw new GoldenSetError(`${where}: unknown base question "${v.base}"`);
		}
		if (!Array.isArray(v.phenomena) || v.phenomena.length === 0 || !v.phenomena.every((p) => PHENOMENA.has(p))) {
			throw new GoldenSetError(`${where}: phenomena must be a non-empty subset of inflection, compound, derivation`);
		}
		if (typeof v.question !== "string" || v.question.trim() === "" || v.question === source.question) {
			throw new GoldenSetError(`${where}: question must be a re-phrasing of "${v.base}", not empty or identical`);
		}
		return {
			id: v.id,
			document: source.document,
			question: v.question,
			expectedPages: source.expectedPages,
			expectedFigures: source.expectedFigures,
			expectedCells: source.expectedCells,
		};
	});
	return {
		version: `${base.version}+de-morphology.${variants.version}`,
		...(variants.description !== undefined ? { description: variants.description } : {}),
		documents: base.documents,
		questions,
	};
}

// ─── Reference derivation ──────────────────────────────────────────────────────

/** The document-level reference (a hit's `base_ref`), NFC-normalised. */
export function documentRef(reference: string): string {
	return reference.normalize("NFC");
}

/** A page reference: `<base_ref>#page=<n>`. */
export function pageRef(reference: string, page: number): string {
	return `${documentRef(reference)}#page=${page}`;
}

/** A figure reference: `<base_ref>#figure=<figureId>`. */
export function figureRef(reference: string, figureId: string): string {
	return `${documentRef(reference)}#figure=${figureId}`;
}

/** A table-cell reference: `<base_ref>#page=<n>;cell=<row>,<col>`. */
export function cellRef(reference: string, cell: TableCell): string {
	return `${pageRef(reference, cell.page)};cell=${cell.row},${cell.col}`;
}

// ─── Extraction annotations ────────────────────────────────────────────────────

/** True when a question carries any ground-truth extraction annotation. */
export function hasExtractionAnnotation(question: GoldenQuestion): boolean {
	const e = question.extraction;
	if (e === undefined) return false;
	return (
		e.expectedTable !== undefined ||
		e.expectedLabels !== undefined ||
		e.expectedNodes !== undefined ||
		e.expectedEdges !== undefined
	);
}

/** Count the questions in a set that carry each kind of extraction annotation. */
export function extractionCoverage(set: GoldenSet): {
	table: number;
	label: number;
	bpmn: number;
} {
	let table = 0;
	let label = 0;
	let bpmn = 0;
	for (const q of set.questions) {
		const e = q.extraction;
		if (e === undefined) continue;
		if (e.expectedTable !== undefined) table++;
		if (e.expectedLabels !== undefined) label++;
		if (e.expectedNodes !== undefined || e.expectedEdges !== undefined) bpmn++;
	}
	return { table, label, bpmn };
}
