// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Retrieval eval harness for Document Intelligence v2 (task T0.1).
 *
 * Runs the versioned golden set against Search's `POST /search`, derives page-
 * and figure-level references from each hit's `base_ref` and `evidence`, and
 * reports Recall@5/10 (page and figure), MRR and Figure-Hit-Rate. A JSON and a
 * Markdown report are written; the JSON is the machine-comparable baseline that
 * later phases diff against.
 *
 * With `--v2` the same golden questions are run against Search's `POST
 * /v2/search` (task 3.7) instead, exercising the full Phase-3 retrieval pipeline
 * (identifier RRF, rerank-with-context, diversification, small-to-big
 * expansion). The v2 hit shape (top-level `pages`, `assets`) is normalised back
 * to the same reference-bearing shape the v1 path uses, so the metrics and the
 * report layout are identical and directly comparable — only the endpoint and
 * request body differ. Everything else (offline `--responses`/`--capture`,
 * `--extractions`, the report) is unchanged.
 *
 * Usage:
 *   bun run scripts/eval/retrieval.ts \
 *     --collection <name> \
 *     [--fixture scripts/eval/golden-set/golden-set.v1.json] \
 *     [--base-url http://127.0.0.1:3002] \
 *     [--token <bearer>] \
 *     [--k 5,10] \
 *     [--out reports/retrieval] \
 *     [--label baseline] \
 *     [--v2] \
 *     [--extractions <captured-extractions.json>]
 *
 * Extraction-quality metrics (task T2.10, requirement 18.3) — table-cell
 * accuracy, label-coverage and BPMN node/edge recall — are scored offline
 * against the golden set's ground-truth annotations. Supply the produced
 * extraction output per question id with `--extractions`; without it those
 * metrics report as pending (0, no produced output to score).
 *
 * Offline / deterministic mode (no live Search, e.g. for the committed baseline
 * skeleton and for CI without a backend):
 *   bun run scripts/eval/retrieval.ts --responses <captured-responses.json> ...
 * where the responses file maps question id → the `results` array of a search
 * response. `--capture <path>` writes such a file from a live run so a baseline
 * can be reproduced deterministically.
 *
 * Exit code is 0 on success; non-zero on fixture/backend errors or when
 * `--min-page-recall` / `--min-figure-recall` gates are set and not met.
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	aggregateExtractionMetrics,
	type BpmnEdge,
	type BpmnNode,
	type ExtractionCase,
	type ExtractionMetrics,
	type Grid,
} from "./extraction-metrics.ts";
import {
	documentRef,
	extractionCoverage,
	figureRef,
	type GoldenQuestion,
	type GoldenSet,
	loadGoldenSet,
	pageRef,
} from "./golden-set.ts";
import {
	type EvalCase,
	figureHitRate,
	figureMetrics,
	overallMrr,
	pageMetrics,
	type RankedHit,
} from "./metrics.ts";

// ─── Minimal shape of a Search hit we depend on ────────────────────────────────

interface SearchEvidence {
	page_start?: number;
	page_end?: number;
	modality?: "image";
	figure_id?: string;
}

interface SearchHit {
	base_ref?: string;
	reference: string;
	evidence?: SearchEvidence;
}

// ─── Minimal shape of a `/v2/search` hit we depend on (task 3.7) ──────────────

/** A v2 asset reference on a hit (`shapeHitV2`, Requirement 13.5). */
interface SearchAssetV2 {
	/** "hit" when the hit IS this figure; "referenced" when it merely points at it. */
	relation?: "hit" | "referenced";
	figure_id?: string;
	kind?: string;
}

/**
 * The subset of a `/v2/search` hit (`SearchHitV2`, design §7.2) the harness
 * reads. Page info is top-level (`pages`), not under `evidence`; a figure hit is
 * an `asset` with `relation:"hit"` and a `figure_id`. `evidence` is passed
 * through by the v2 shaper and kept only as a fallback.
 */
interface SearchHitV2 {
	base_ref?: string;
	reference: string;
	unit_type?: string;
	pages?: { start?: number; end?: number } | null;
	assets?: SearchAssetV2[];
	evidence?: SearchEvidence;
}

/**
 * Normalise a `/v2/search` hit into the v1 {@link SearchHit} shape so the same
 * reference-derivation and metrics run unchanged. PURE: no I/O.
 *
 * - Pages: prefer the top-level `pages.{start,end}`; fall back to `evidence`.
 * - Figure: the hit is a figure when it carries an asset with `relation:"hit"`
 *   and a `figure_id` (the v2 equivalent of v1's `evidence.modality === "image"`
 *   with a `figure_id`). Referenced figures are NOT the hit's own figure and are
 *   ignored for figure recall, matching the v1 semantics. Falls back to
 *   `evidence` when no such asset is present.
 */
export function normalizeV2Hit(hit: SearchHitV2): SearchHit {
	const start = hit.pages?.start ?? hit.evidence?.page_start;
	const end = hit.pages?.end ?? hit.evidence?.page_end ?? start;
	const hitFigure = (hit.assets ?? []).find(
		(a) => a.relation === "hit" && typeof a.figure_id === "string",
	);
	const figureId = hitFigure?.figure_id ?? hit.evidence?.figure_id;
	const modality: "image" | undefined =
		hitFigure !== undefined || hit.evidence?.modality === "image"
			? "image"
			: undefined;
	const evidence: SearchEvidence = {};
	if (start !== undefined) evidence.page_start = start;
	if (end !== undefined) evidence.page_end = end;
	if (modality !== undefined) evidence.modality = modality;
	if (figureId !== undefined) evidence.figure_id = figureId;
	return {
		base_ref: hit.base_ref,
		reference: hit.reference,
		evidence,
	};
}

// ─── CLI parsing ───────────────────────────────────────────────────────────────

interface Args {
	fixture: string;
	collection: string;
	baseUrl: string;
	token?: string;
	cutoffs: number[];
	out: string;
	label: string;
	/** Target `POST /v2/search` (task 3.7) instead of the v1 `POST /search`. */
	v2: boolean;
	responses?: string;
	capture?: string;
	extractions?: string;
	minPageRecall?: number;
	minFigureRecall?: number;
}

/**
 * The produced extraction output for one question, as captured from a live
 * Extract run and fed back with `--extractions` for an offline, deterministic
 * score. Every field is optional so a capture can carry only what a document
 * actually produced.
 */
interface ProducedExtraction {
	/** Produced table grid, from a `table`/`data` block transcription. */
	table?: string[][];
	/** Flattened figure transcription/label text. */
	text?: string;
	/** Produced BPMN/flowchart process transcription. */
	process?: { nodes?: BpmnNode[]; edges?: BpmnEdge[] };
}

const HERE = import.meta.dir;
const ROOT = resolve(HERE, "..", "..");
const DEFAULT_FIXTURE = resolve(HERE, "golden-set", "golden-set.v1.json");

function parseArgs(argv: string[]): Args {
	const get = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const has = (name: string): boolean => argv.includes(name);
	const cutoffsRaw = get("--k") ?? "5,10";
	const cutoffs = cutoffsRaw
		.split(",")
		.map((value) => Number.parseInt(value.trim(), 10))
		.filter((value) => Number.isInteger(value) && value > 0);
	if (cutoffs.length === 0) {
		throw new Error(
			"--k must be a comma-separated list of positive integers, e.g. 5,10",
		);
	}
	const num = (name: string): number | undefined => {
		const raw = get(name);
		if (raw === undefined) return undefined;
		const value = Number.parseFloat(raw);
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			throw new Error(`${name} must be a number between 0 and 1`);
		}
		return value;
	};
	return {
		fixture: get("--fixture") ?? DEFAULT_FIXTURE,
		collection: get("--collection") ?? "documents",
		baseUrl: (
			get("--base-url") ??
			process.env.SEARCH_BASE_URL ??
			"http://127.0.0.1:3002"
		).replace(/\/$/, ""),
		token: get("--token") ?? process.env.SEARCH_TOKEN,
		cutoffs: [...new Set(cutoffs)].sort((a, b) => a - b),
		out: get("--out") ?? "reports/retrieval",
		label: get("--label") ?? "run",
		v2: has("--v2"),
		responses: get("--responses"),
		capture: get("--capture"),
		extractions: get("--extractions"),
		minPageRecall: num("--min-page-recall"),
		minFigureRecall: num("--min-figure-recall"),
	};
}

// ─── Reference derivation from a hit ───────────────────────────────────────────

/** Page references a hit covers: one per page in `[page_start, page_end]`. */
function hitPageRefs(hit: SearchHit): string[] {
	const base = hit.base_ref ?? hit.reference;
	const start = hit.evidence?.page_start;
	const end = hit.evidence?.page_end ?? start;
	if (start === undefined || end === undefined) return [];
	const refs: string[] = [];
	for (let page = start; page <= end; page++) refs.push(pageRef(base, page));
	return refs;
}

/** Figure references a hit covers: its figure when the evidence is an image. */
function hitFigureRefs(hit: SearchHit): string[] {
	const base = hit.base_ref ?? hit.reference;
	const evidence = hit.evidence;
	if (evidence?.modality === "image" && evidence.figure_id) {
		return [figureRef(base, evidence.figure_id)];
	}
	return [];
}

function toRankedHits(hits: SearchHit[]): RankedHit[] {
	return hits.map((hit) => ({
		pageRefs: hitPageRefs(hit),
		figureRefs: hitFigureRefs(hit),
	}));
}

function expectedRefs(
	question: GoldenQuestion,
	docReference: string,
): {
	pages: string[];
	figures: string[];
} {
	const base = documentRef(docReference);
	return {
		pages: question.expectedPages.map((page) => pageRef(base, page)),
		figures: question.expectedFigures.map((figure) => figureRef(base, figure)),
	};
}

// ─── Search driver ─────────────────────────────────────────────────────────────

async function runSearch(
	args: Args,
	question: string,
	maxResults: number,
): Promise<SearchHit[]> {
	return args.v2
		? runSearchV2(args, question, maxResults)
		: runSearchV1(args, question, maxResults);
}

/** v1 `POST /search`: text/plain body, `X-Collection` / `X-Max-Results` headers. */
async function runSearchV1(
	args: Args,
	question: string,
	maxResults: number,
): Promise<SearchHit[]> {
	const headers: Record<string, string> = {
		"Content-Type": "text/plain",
		"X-Collection": args.collection,
		"X-Max-Results": String(maxResults),
	};
	if (args.token) headers.Authorization = `Bearer ${args.token}`;
	const response = await fetch(`${args.baseUrl}/search`, {
		method: "POST",
		headers,
		body: question,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Search ${response.status} for "${question}": ${detail.slice(0, 200)}`,
		);
	}
	const payload = (await response.json()) as { results?: SearchHit[] };
	return Array.isArray(payload.results) ? payload.results : [];
}

/**
 * v2 `POST /v2/search` (task 3.7): JSON body, `X-Collection` header. Exercises
 * the full Phase-3 pipeline (identifier RRF, rerank-with-context, diversify,
 * expansion). The v2 hits are normalised back to the v1 {@link SearchHit} shape
 * so the metrics are identical and directly comparable.
 */
async function runSearchV2(
	args: Args,
	question: string,
	maxResults: number,
): Promise<SearchHit[]> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Collection": args.collection,
	};
	if (args.token) headers.Authorization = `Bearer ${args.token}`;
	const response = await fetch(`${args.baseUrl}/v2/search`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			query: question,
			limit: maxResults,
			include_assets: "refs",
		}),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Search v2 ${response.status} for "${question}": ${detail.slice(0, 200)}`,
		);
	}
	const payload = (await response.json()) as { results?: SearchHitV2[] };
	const hits = Array.isArray(payload.results) ? payload.results : [];
	return hits.map(normalizeV2Hit);
}

// ─── Report shaping ────────────────────────────────────────────────────────────

interface Report {
	label: string;
	generated_at: string;
	fixture: {
		version: string;
		path: string;
		documents: number;
		questions: number;
	};
	parameters: {
		collection: string;
		base_url: string;
		cutoffs: number[];
		mode: "live" | "offline";
		/** Which endpoint the run targeted: v1 `/search` or v2 `/v2/search` (task 3.7). */
		endpoint: "v1" | "v2";
	};
	/** True when no hits were observed at all — a skeleton awaiting a live run. */
	pending: boolean;
	metrics: {
		page: Record<string, ReturnType<typeof pageMetrics>>;
		figure: Record<string, ReturnType<typeof figureMetrics>>;
		mrr: Record<string, number>;
		figure_hit_rate: Record<string, ReturnType<typeof figureHitRate>>;
	};
	/**
	 * Extraction-quality metrics (task T2.10, requirement 18.3). Scored offline
	 * against the golden set's ground-truth annotations when a `--extractions`
	 * capture is supplied; otherwise `extraction.pending` is true and the metrics
	 * are 0 (no produced output to score).
	 */
	extraction: ExtractionMetrics;
	coverage: {
		by_kind: Record<string, number>;
		page_questions: number;
		figure_questions: number;
		cell_questions: number;
		table_annotations: number;
		label_annotations: number;
		bpmn_annotations: number;
	};
}

/**
 * Turn the golden set's ground-truth extraction annotations plus an optional map
 * of produced extractions into scorable cases. A question with no annotation is
 * skipped; a question with an annotation but no produced output still produces a
 * case (so the aggregate reports "pending"), carrying only the expected side.
 */
function buildExtractionCases(
	set: GoldenSet,
	produced: Record<string, ProducedExtraction> | undefined,
): ExtractionCase[] {
	const cases: ExtractionCase[] = [];
	for (const question of set.questions) {
		const annotation = question.extraction;
		if (annotation === undefined) continue;
		const out = produced?.[question.id];
		const kase: ExtractionCase = { id: question.id };
		if (annotation.expectedTable !== undefined) {
			kase.expectedTable = annotation.expectedTable as Grid;
			if (out?.table !== undefined) kase.producedTable = out.table as Grid;
		}
		if (annotation.expectedLabels !== undefined) {
			kase.expectedLabels = annotation.expectedLabels;
			if (out?.text !== undefined) kase.producedText = out.text;
		}
		if (
			annotation.expectedNodes !== undefined ||
			annotation.expectedEdges !== undefined
		) {
			kase.expectedNodes = annotation.expectedNodes ?? [];
			kase.expectedEdges = annotation.expectedEdges ?? [];
			if (out?.process !== undefined) {
				kase.producedProcess = {
					nodes: out.process.nodes ?? [],
					edges: out.process.edges ?? [],
				};
			}
		}
		cases.push(kase);
	}
	return cases;
}

function buildReport(
	args: Args,
	set: GoldenSet,
	cases: EvalCase[],
	extractionCases: ExtractionCase[],
	mode: "live" | "offline",
): Report {
	const page: Record<string, ReturnType<typeof pageMetrics>> = {};
	const figure: Record<string, ReturnType<typeof figureMetrics>> = {};
	const mrr: Record<string, number> = {};
	const hitRate: Record<string, ReturnType<typeof figureHitRate>> = {};
	for (const k of args.cutoffs) {
		page[String(k)] = pageMetrics(cases, k);
		figure[String(k)] = figureMetrics(cases, k);
		mrr[String(k)] = overallMrr(cases, k);
		hitRate[String(k)] = figureHitRate(cases, k);
	}
	const byKind: Record<string, number> = {};
	const docKind = new Map(set.documents.map((d) => [d.id, d.kind]));
	for (const q of set.questions) {
		const kind = docKind.get(q.document) ?? "unknown";
		byKind[kind] = (byKind[kind] ?? 0) + 1;
	}
	const totalHits = cases.reduce((sum, c) => sum + c.hits.length, 0);
	const extraction = aggregateExtractionMetrics(extractionCases);
	const annotationCoverage = extractionCoverage(set);
	return {
		label: args.label,
		pending: totalHits === 0,
		generated_at: new Date().toISOString(),
		fixture: {
			version: set.version,
			path: args.fixture,
			documents: set.documents.length,
			questions: set.questions.length,
		},
		parameters: {
			collection: args.collection,
			base_url: args.baseUrl,
			cutoffs: args.cutoffs,
			mode,
			endpoint: args.v2 ? "v2" : "v1",
		},
		metrics: { page, figure, mrr, figure_hit_rate: hitRate },
		extraction,
		coverage: {
			by_kind: byKind,
			page_questions: set.questions.filter((q) => q.expectedPages.length > 0)
				.length,
			figure_questions: set.questions.filter(
				(q) => q.expectedFigures.length > 0,
			).length,
			cell_questions: set.questions.filter((q) => q.expectedCells.length > 0)
				.length,
			table_annotations: annotationCoverage.table,
			label_annotations: annotationCoverage.label,
			bpmn_annotations: annotationCoverage.bpmn,
		},
	};
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdown(report: Report): string {
	const cutoffs = report.parameters.cutoffs;
	const lines: string[] = [];
	lines.push(`# Retrieval evaluation — ${report.label}`);
	lines.push("");
	lines.push(`Generated: ${report.generated_at}`);
	lines.push("");
	lines.push(
		`Fixture \`${report.fixture.version}\` — ${report.fixture.documents} documents, ` +
			`${report.fixture.questions} questions (mode: ${report.parameters.mode}, ` +
			`endpoint: ${report.parameters.endpoint}, ` +
			`collection: \`${report.parameters.collection}\`).`,
	);
	lines.push("");
	if (report.pending) {
		lines.push(
			"> **Pending baseline.** No search hits were observed, so every metric is 0. " +
				"Regenerate against a live Search instance that has the golden documents " +
				"indexed (see `scripts/eval/README.md`) to record the real Ist-Stand.",
		);
		lines.push("");
	}
	lines.push("## Retrieval metrics");
	lines.push("");
	const header = ["Metric", ...cutoffs.map((k) => `@${k}`)];
	lines.push(`| ${header.join(" | ")} |`);
	lines.push(`| ${header.map(() => "---").join(" | ")} |`);
	const pageRow = cutoffs.map((k) =>
		pct(report.metrics.page[String(k)]?.recallAtK ?? 0),
	);
	const figureRow = cutoffs.map((k) =>
		pct(report.metrics.figure[String(k)]?.recallAtK ?? 0),
	);
	const mrrRow = cutoffs.map((k) =>
		(report.metrics.mrr[String(k)] ?? 0).toFixed(4),
	);
	const hitRow = cutoffs.map((k) =>
		pct(report.metrics.figure_hit_rate[String(k)]?.rate ?? 0),
	);
	lines.push(`| Page Recall | ${pageRow.join(" | ")} |`);
	lines.push(`| Figure Recall | ${figureRow.join(" | ")} |`);
	lines.push(`| MRR | ${mrrRow.join(" | ")} |`);
	lines.push(`| Figure-Hit-Rate | ${hitRow.join(" | ")} |`);
	lines.push("");
	lines.push("## Extraction-quality metrics");
	lines.push("");
	const ex = report.extraction;
	if (ex.pending) {
		lines.push(
			"> **Pending extraction metrics.** No produced extraction output was supplied " +
				"(`--extractions`), so table-cell accuracy, label-coverage and BPMN node/edge " +
				"recall are 0. These require a live Extract run over the golden documents; feed " +
				"the captured output back offline to score them (see `scripts/eval/README.md`).",
		);
		lines.push("");
	}
	lines.push("| Metric | Value | Detail |");
	lines.push("| --- | --- | --- |");
	lines.push(
		`| Table-cell accuracy | ${pct(ex.tableCell.accuracy)} | ${ex.tableCell.matchedCells}/${ex.tableCell.expectedCells} cells, ${ex.tableCell.cases} tables |`,
	);
	lines.push(
		`| Label-coverage | ${pct(ex.label.coverage)} | ${ex.label.coveredLabels}/${ex.label.expectedLabels} labels, ${ex.label.cases} figures |`,
	);
	lines.push(
		`| BPMN node recall | ${pct(ex.bpmn.nodeRecall)} | ${ex.bpmn.recoveredNodes}/${ex.bpmn.expectedNodes} nodes, ${ex.bpmn.cases} diagrams |`,
	);
	lines.push(
		`| BPMN edge recall | ${pct(ex.bpmn.edgeRecall)} | ${ex.bpmn.recoveredEdges}/${ex.bpmn.expectedEdges} edges, ${ex.bpmn.cases} diagrams |`,
	);
	lines.push("");
	lines.push("## Coverage");
	lines.push("");
	lines.push("| Category | Count |");
	lines.push("| --- | --- |");
	for (const [kind, count] of Object.entries(report.coverage.by_kind).sort()) {
		lines.push(`| questions (${kind}) | ${count} |`);
	}
	lines.push(`| page questions | ${report.coverage.page_questions} |`);
	lines.push(`| figure questions | ${report.coverage.figure_questions} |`);
	lines.push(`| table-cell questions | ${report.coverage.cell_questions} |`);
	lines.push(`| table annotations | ${report.coverage.table_annotations} |`);
	lines.push(`| label annotations | ${report.coverage.label_annotations} |`);
	lines.push(`| BPMN annotations | ${report.coverage.bpmn_annotations} |`);
	lines.push("");
	return `${lines.join("\n")}\n`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	const set = await loadGoldenSet(args.fixture);
	const docByRef = new Map(set.documents.map((d) => [d.id, d.reference]));
	const maxCutoff = Math.max(...args.cutoffs);

	let responsesByQuestion: Record<string, SearchHit[]> | undefined;
	if (args.responses) {
		const file = Bun.file(args.responses);
		if (!(await file.exists()))
			throw new Error(`Responses file not found: ${args.responses}`);
		responsesByQuestion = (await file.json()) as Record<string, SearchHit[]>;
	}
	const mode: "live" | "offline" = responsesByQuestion ? "offline" : "live";

	let producedExtractions: Record<string, ProducedExtraction> | undefined;
	if (args.extractions) {
		const file = Bun.file(args.extractions);
		if (!(await file.exists()))
			throw new Error(`Extractions file not found: ${args.extractions}`);
		producedExtractions = (await file.json()) as Record<
			string,
			ProducedExtraction
		>;
	}

	const cases: EvalCase[] = [];
	const captured: Record<string, SearchHit[]> = {};
	for (const question of set.questions) {
		const reference = docByRef.get(question.document);
		if (reference === undefined) {
			// Unreachable after fixture validation; guarded to avoid a non-null assertion.
			throw new Error(`question "${question.id}" references unknown document`);
		}
		let hits: SearchHit[];
		if (responsesByQuestion) {
			hits = responsesByQuestion[question.id] ?? [];
		} else {
			hits = await runSearch(args, question.question, maxCutoff);
			if (args.capture) captured[question.id] = hits;
		}
		const expected = expectedRefs(question, reference);
		cases.push({
			id: question.id,
			expectedPageRefs: expected.pages,
			expectedFigureRefs: expected.figures,
			hits: toRankedHits(hits),
		});
	}

	if (args.capture && mode === "live") {
		await mkdir(dirname(resolve(ROOT, args.capture)), { recursive: true });
		await Bun.write(
			resolve(ROOT, args.capture),
			`${JSON.stringify(captured, null, 2)}\n`,
		);
	}

	const extractionCases = buildExtractionCases(set, producedExtractions);
	const report = buildReport(args, set, cases, extractionCases, mode);
	const outBase = resolve(ROOT, `${args.out}.${args.label}`);
	await mkdir(dirname(outBase), { recursive: true });
	await Bun.write(`${outBase}.json`, `${JSON.stringify(report, null, 2)}\n`);
	await Bun.write(`${outBase}.md`, renderMarkdown(report));

	console.log(renderMarkdown(report));
	console.log(`Wrote ${outBase}.json and ${outBase}.md`);

	let failed = false;
	if (args.minPageRecall !== undefined) {
		const value = report.metrics.page[String(maxCutoff)]?.recallAtK ?? 0;
		if (value < args.minPageRecall) {
			console.error(
				`Page Recall@${maxCutoff} ${pct(value)} < gate ${pct(args.minPageRecall)}`,
			);
			failed = true;
		}
	}
	if (args.minFigureRecall !== undefined) {
		const value = report.metrics.figure[String(maxCutoff)]?.recallAtK ?? 0;
		if (value < args.minFigureRecall) {
			console.error(
				`Figure Recall@${maxCutoff} ${pct(value)} < gate ${pct(args.minFigureRecall)}`,
			);
			failed = true;
		}
	}
	if (failed) process.exit(1);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
