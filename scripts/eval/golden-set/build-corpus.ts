// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Deterministic corpus builder for the retrieval eval.
 *
 * The golden set (`golden-set.v1.json`) annotates *where* an answer lives
 * (page / figure / cell) but ships no binaries. This builder synthesises an
 * ingestible corpus from the annotations alone:
 *
 *   - every question text is embedded verbatim on its expected page, so page
 *     recall measures real retrieval of the annotated location;
 *   - every expected figure is emitted EXACTLY ONCE per document (Search keys
 *     v1 figure units by `<reference>/figures/<id>`, which must stay unique)
 *     with a description carrying every question text and label that expects
 *     it, plus BPMN node/edge labels where annotated;
 *   - every expected table is rendered as a Markdown table on its expected page.
 *
 * Output (fully deterministic — no timestamps, no randomness):
 *   - `corpus/<doc-id>.md`   v1 Markdown (page markers, summaries, figures)
 *   - `corpus/manifest.json` structured pages for the v2 revision driver
 *
 * The module is importable: {@link buildCorpus} returns the structured
 * documents so `scripts/eval/ingest-corpus.ts` can emit both the v1 Markdown
 * and the v2 NDJSON from the same source of truth.
 *
 * Usage:
 *   bun run scripts/eval/golden-set/build-corpus.ts [--fixture <json>] [--out <dir>]
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type GoldenDocument,
	type GoldenDocumentKind,
	type GoldenQuestion,
	type GoldenSet,
	loadGoldenSet,
} from "../golden-set.ts";

// ─── Corpus model ──────────────────────────────────────────────────────────────

/** One figure unit of the corpus, emitted exactly once per document. */
export interface CorpusFigure {
	id: string;
	/** Page the figure markup is emitted on (first expected page). */
	page: number;
	/** v2 figure kind (`bpmn`, `ui_mask`, `technical_drawing`, …). */
	kind: string;
	/** Description carrying all question texts / labels expecting this figure. */
	description: string;
	/** Union of the expected labels across all questions expecting it. */
	labels: string[];
}

export type CorpusBlock =
	| { type: "paragraph"; text: string }
	| { type: "table"; rows: string[][] }
	| { type: "figures"; figures: CorpusFigure[] };

export interface CorpusPage {
	page: number;
	summary: string;
	blocks: CorpusBlock[];
}

export interface CorpusDocument {
	id: string;
	reference: string;
	title: string;
	kind: GoldenDocumentKind;
	pages: number;
	/** Corpus-relative Markdown file name (v1 ingest input). */
	file: string;
	summary: string;
	content: CorpusPage[];
	figureIds: string[];
}

export interface CorpusManifest {
	version: string;
	generated_by: string;
	documents: CorpusDocument[];
}

// ─── Deterministic filler ──────────────────────────────────────────────────────

/**
 * Topically neutral filler phrases. They give every page realistic prose
 * without competing with the question texts for retrieval similarity.
 */
const FILLER_TOPICS = [
	"die allgemeine Organisation der Ablage",
	"die Zuständigkeiten im Tagesgeschäft",
	"die geltende Dokumentationspflicht",
	"die regelmäßige Überprüfung der Vorgaben",
	"die Reihenfolge der Arbeitsschritte",
	"die Aufbewahrung der Belege",
	"die Abstimmung zwischen den Abteilungen",
	"die Vertretungsregelung im Urlaubsfall",
	"die Nummerierung der Vorgänge",
	"die Pflege der Stammdaten",
	"die Einhaltung der Fristen",
	"die Rückmeldung an die Leitung",
	"die Prüfung der Vollständigkeit",
	"die Freigabe durch die Fachabteilung",
	"die Änderungshistorie des Dokuments",
	"die Begriffe und Definitionen im Anhang",
	"die Hinweise zur Bedienung der Oberfläche",
	"die Schulung der Mitarbeitenden",
	"die Qualitätssicherung der Eingaben",
	"die Eskalation bei Abweichungen",
	"die Archivierung abgeschlossener Vorgänge",
	"die Statistik der Monatswerte",
	"die Regeln für die Vergabe von Kennungen",
	"die Kontrolle der Zugriffsrechte",
] as const;

function fillerFor(docIndex: number, page: number): string {
	const a = FILLER_TOPICS[(docIndex * 7 + page * 3) % FILLER_TOPICS.length];
	const b =
		FILLER_TOPICS[(docIndex * 11 + page * 5 + 4) % FILLER_TOPICS.length];
	return `Dieser Abschnitt behandelt ${a} sowie ${b} und verweist auf die jeweils geltenden Regelungen des Dokuments.`;
}

// ─── Builders ──────────────────────────────────────────────────────────────────

function figureKind(kind: GoldenDocumentKind): string {
	if (kind === "bpmn") return "bpmn";
	if (kind === "plan") return "technical_drawing";
	return "ui_mask";
}

interface FigureAccumulator {
	pages: number[];
	questions: string[];
	labels: string[];
	nodes: string[];
	edges: string[];
}

function questionBlocks(
	q: GoldenQuestion,
	doc: GoldenDocument,
): CorpusBlock[] {
	if (q.extraction?.expectedTable !== undefined) {
		return [
			{
				type: "paragraph",
				text: `${q.question} Die Antwort steht in der folgenden Tabelle.`,
			},
			{ type: "table", rows: q.extraction.expectedTable },
		];
	}
	if (q.expectedFigures.length > 0) {
		return [
			{
				type: "paragraph",
				text: `${q.question} Die zugehörige Abbildung (${q.expectedFigures.join(", ")}) ist in diesem Abschnitt von „${doc.title}" verzeichnet.`,
			},
		];
	}
	return [
		{
			type: "paragraph",
			text: `${q.question} Dieser Abschnitt von „${doc.title}" beantwortet die Frage und beschreibt die maßgeblichen Vorgaben im Zusammenhang mit ${q.expectedPages.length > 0 ? `Seite ${q.expectedPages[0]}` : "dem Dokument"}.`,
		},
	];
}

function figureDescription(
	doc: GoldenDocument,
	id: string,
	acc: FigureAccumulator,
): string {
	const questions = [...new Set(acc.questions)];
	const labels = [...new Set(acc.labels)];
	const nodes = [...new Set(acc.nodes)];
	const edges = [...new Set(acc.edges)];
	const parts = [
		`${doc.title}: Abbildung ${id}.`,
		questions.join(" "),
	];
	if (labels.length > 0) parts.push(`Beschriftungen: ${labels.join(", ")}.`);
	if (nodes.length > 0) parts.push(`Knoten: ${nodes.join(", ")}.`);
	if (edges.length > 0) parts.push(`Kanten: ${edges.join(", ")}.`);
	return parts.filter((p) => p !== "").join(" ");
}

/** Build the structured corpus for every document of the golden set. PURE. */
export function buildCorpus(set: GoldenSet): CorpusDocument[] {
	return set.documents.map((doc, docIndex) => {
		const questions = set.questions.filter(
			(q) => q.document === doc.id && q.abstain !== true,
		);

		// Aggregate figures across ALL questions of the document so each id is
		// emitted exactly once (v1 figure units are keyed by reference).
		const figureAcc = new Map<string, FigureAccumulator>();
		for (const q of questions) {
			for (const figureId of q.expectedFigures) {
				const acc = figureAcc.get(figureId) ?? {
					pages: [],
					questions: [],
					labels: [],
					nodes: [],
					edges: [],
				};
				if (q.expectedPages.length > 0) acc.pages.push(q.expectedPages[0]);
				acc.questions.push(q.question);
				acc.labels.push(...(q.extraction?.expectedLabels ?? []));
				for (const node of q.extraction?.expectedNodes ?? []) {
					acc.nodes.push(
						node.label !== undefined && node.id !== undefined
							? `${node.label} (${node.id})`
							: (node.label ?? node.id ?? ""),
					);
				}
				for (const edge of q.extraction?.expectedEdges ?? []) {
					acc.edges.push(`${edge.from} -> ${edge.to}`);
				}
				figureAcc.set(figureId, acc);
			}
		}
		const figures: CorpusFigure[] = [...figureAcc.entries()].map(
			([id, acc]) => ({
				id,
				page: Math.min(...(acc.pages.length > 0 ? acc.pages : [1])),
				kind: figureKind(doc.kind),
				description: figureDescription(doc, id, acc),
				labels: [...new Set(acc.labels)],
			}),
		);
		const figuresByPage = new Map<number, CorpusFigure[]>();
		for (const figure of figures) {
			const list = figuresByPage.get(figure.page) ?? [];
			list.push(figure);
			figuresByPage.set(figure.page, list);
		}

		// Group question blocks by expected page (first expected page).
		const blocksByPage = new Map<number, CorpusBlock[]>();
		for (const q of questions) {
			const page = q.expectedPages[0] ?? 1;
			const list = blocksByPage.get(page) ?? [];
			list.push(...questionBlocks(q, doc));
			blocksByPage.set(page, list);
		}

		const content: CorpusPage[] = [];
		for (let page = 1; page <= doc.pages; page++) {
			const blocks = blocksByPage.get(page) ?? [];
			const pageFigures = figuresByPage.get(page) ?? [];
			const topics = blocks
				.filter((b) => b.type === "paragraph")
				.map((b) => (b as { text: string }).text);
			const summarySource =
				topics.length > 0
					? topics.join(" ").slice(0, 240)
					: fillerFor(docIndex, page).slice(0, 240);
			content.push({
				page,
				summary: `Seite ${page} von ${doc.title}. ${summarySource}`,
				blocks: [
					...blocks,
					{ type: "paragraph", text: fillerFor(docIndex, page) },
					...(pageFigures.length > 0
						? ([{ type: "figures", figures: pageFigures }] as CorpusBlock[])
						: []),
				],
			});
		}

		return {
			id: doc.id,
			reference: doc.reference,
			title: doc.title,
			kind: doc.kind,
			pages: doc.pages,
			file: `${doc.id}.md`,
			summary: `${doc.title}. ${doc.note ?? ""}`.trim(),
			content,
			figureIds: figures.map((f) => f.id),
		};
	});
}

// ─── Markdown rendering (v1 grammar) ───────────────────────────────────────────

/** Matches the contract's `buildSummaryTag` output. */
function summaryTag(text: string): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed === "" ? "" : `<summary>${trimmed}</summary>`;
}

/** Matches the contract's `buildFigureTag` output (fixed attribute order). */
function figureTag(figure: CorpusFigure): string {
	const description = figure.description
		.replace(/[<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return (
		`<figure id="${figure.id}"` +
		` bbox="[0.1000, 0.2000, 0.6000, 0.7000]"` +
		` page="${figure.page}">${description}</figure>`
	);
}

function renderTable(rows: string[][]): string {
	if (rows.length === 0) return "";
	const escapeCell = (cell: string) => cell.replace(/\|/g, "\\|");
	const head = `| ${rows[0].map(escapeCell).join(" | ")} |`;
	const separator = `| ${rows[0].map(() => "---").join(" | ")} |`;
	const body = rows
		.slice(1)
		.map((row) => `| ${row.map(escapeCell).join(" | ")} |`);
	return [head, separator, ...body].join("\n");
}

/** Render one document as v1 Markdown (page markers + separators). */
export function renderMarkdown(doc: CorpusDocument): string {
	const pageTexts = doc.content.map((page) => {
		const parts: string[] = [`## Seite ${page.page}`];
		const summary = summaryTag(page.summary);
		if (summary !== "") parts.push(summary);
		for (const block of page.blocks) {
			if (block.type === "paragraph") parts.push(block.text);
			else if (block.type === "table") parts.push(renderTable(block.rows));
			else {
				const tags = block.figures.map(figureTag);
				parts.push(`<figures>\n${tags.join("\n")}\n</figures>`);
				for (const figure of block.figures) {
					parts.push(`![figure_${figure.id}]`);
				}
			}
		}
		return parts.join("\n\n");
	});
	const preamble = [`# ${doc.title}`, summaryTag(doc.summary)]
		.filter((p) => p !== "")
		.join("\n\n");
	return `${preamble}\n\n---\n\n${pageTexts.join("\n\n---\n\n")}\n`;
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

// `import.meta.url` rather than Bun's `import.meta.dir`: the pure builders are
// also imported by Node-run test suites (apps/search, vitest).
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = resolve(HERE, "golden-set.v1.json");
const DEFAULT_OUT = resolve(HERE, "corpus");

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const get = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const fixturePath = get("--fixture") ?? DEFAULT_FIXTURE;
	const outDir = get("--out") ?? DEFAULT_OUT;

	const set = await loadGoldenSet(fixturePath);
	const documents = buildCorpus(set);
	await mkdir(outDir, { recursive: true });

	for (const doc of documents) {
		const path = resolve(outDir, doc.file);
		await Bun.write(path, renderMarkdown(doc));
		console.log(
			`wrote ${path} (${doc.pages} pages, ${doc.figureIds.length} figures)`,
		);
	}

	const manifest: CorpusManifest = {
		version: set.version,
		generated_by: "scripts/eval/golden-set/build-corpus.ts",
		documents,
	};
	const manifestPath = resolve(outDir, "manifest.json");
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(
		`wrote ${manifestPath} (${documents.length} documents, ` +
			`${set.questions.length} questions)`,
	);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
