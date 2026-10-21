// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * extract-quality.ts — scores what Extract produced against a golden set:
 * character error rate of the running text, heading F1 and
 * table TEDS. A change of vision model, render DPI or prompt is the biggest
 * cost and quality lever of the pipeline; this puts a number on it.
 *
 *   bun run eval:extract-quality                       # the shipped synthetic set, its sample output
 *   bun run eval:extract-quality -- --set internal/quality-set --produced reports/produced
 *
 * Inputs
 * ------
 * A *quality set* is a directory with a `manifest.json` and one
 * `<id>.expected.json` per case (format below). What Extract produced for a
 * case is a v2 record stream, `<produced>/<id>.ndjson` (one JSON record per
 * line; only the `page` records are read). To capture it from a finished job:
 *
 *   psql "$EXTRACT_DATABASE_URL" -At -c \
 *     "SELECT payload->'record' FROM extract.emit_outbox WHERE job_id = '<job>' ORDER BY page_from" \
 *     > reports/produced/<id>.ndjson
 *
 * (the outbox keeps the enriched page records until the retention sweeper
 * removes the finished job — see `JOB_RETENTION_DAYS`).
 *
 * Expected format (`<id>.expected.json`)
 * --------------------------------------
 *   {
 *     "id": "pflichtenheft",
 *     "pages": [
 *       { "page": 1,
 *         "text": "Running text of the page in reading order: headings, paragraphs, list items.",
 *         "headings": [ { "level": 1, "text": "1 Einleitung" } ],
 *         "tables":   [ { "headerRows": [["Nr", "Anforderung"]], "rows": [["1", "Schnittstelle"]] } ] } ]
 *   }
 *
 * A table cell is a string or `{ "text", "colspan", "rowspan", "header" }`, the
 * contract's own cell shape. The running text excludes table cells and figure
 * text (tables are scored by TEDS, figures by `extraction-metrics.ts`).
 * `text`, `headings` and `tables` are each optional: a case scores what it
 * annotates.
 *
 * Customer sets
 * -------------
 * Keep real documents and their annotations OUT of the public tree (the
 * synthetic set under `quality-set/synthetic` is the only one that ships;
 * `verify:public` guards the tree). Point `--set` at a directory of your own in
 * the same format. `manifest.kind` is "synthetic", "public" or "customer"; the
 * report states it so a customer report is never mistaken for the shipped one.
 *
 * Output & gates
 * --------------
 * `<out>.<label>.json` and `.md` (default `reports/extract-quality`). With
 * `--max-cer`, `--min-heading-f1` or `--min-teds` the exit code is 1 when a
 * pooled score misses its bound, so the run can gate a model or prompt change.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	type Cer,
	type Heading,
	type PrecisionRecall,
	type Table,
	type TableCell,
	cer,
	headingF1,
	matchTables,
	mean,
	pooledCer,
	pooledPrf,
} from "./extract-quality-metrics.js";

const DEFAULT_SET = "scripts/eval/quality-set/synthetic";

// ─── Quality set ─────────────────────────────────────────────────────────────

export type SetKind = "synthetic" | "public" | "customer";

export interface QualityManifest {
	version: string;
	kind: SetKind;
	description?: string;
	/** Directory (relative to the manifest) holding sample output for `--produced`'s default. */
	producedDir?: string;
	cases: Array<{ id: string; title?: string; expected: string }>;
}

export interface ExpectedPage {
	page: number;
	text?: string;
	headings?: Heading[];
	tables?: Table[];
}

export interface ExpectedCase {
	id: string;
	pages: ExpectedPage[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function fail(where: string, what: string): never {
	throw new Error(`${where}: ${what}`);
}

function parseCell(value: unknown, where: string): TableCell {
	if (typeof value === "string") return value;
	if (!isRecord(value) || typeof value.text !== "string") fail(where, "a cell is a string or { text, colspan?, rowspan?, header? }");
	const span = (name: "colspan" | "rowspan"): number | undefined => {
		const raw = value[name];
		if (raw === undefined) return undefined;
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) fail(where, `${name} must be a positive integer`);
		return raw;
	};
	const colspan = span("colspan");
	const rowspan = span("rowspan");
	return {
		text: value.text,
		...(colspan !== undefined ? { colspan } : {}),
		...(rowspan !== undefined ? { rowspan } : {}),
		...(typeof value.header === "boolean" ? { header: value.header } : {}),
	};
}

function parseRows(value: unknown, where: string): TableCell[][] {
	if (!Array.isArray(value)) fail(where, "rows must be an array of rows");
	return value.map((row, r) => {
		if (!Array.isArray(row)) fail(`${where}[${r}]`, "a row is an array of cells");
		return row.map((cell, c) => parseCell(cell, `${where}[${r}][${c}]`));
	});
}

function parseTable(value: unknown, where: string): Table {
	if (!isRecord(value)) fail(where, "a table is { headerRows?, rows }");
	return {
		...(value.headerRows !== undefined ? { headerRows: parseRows(value.headerRows, `${where}.headerRows`) } : {}),
		rows: parseRows(value.rows ?? [], `${where}.rows`),
	};
}

/** Validate one `<id>.expected.json`. */
export function parseExpected(value: unknown, id: string): ExpectedCase {
	const where = `${id}.expected.json`;
	if (!isRecord(value) || !Array.isArray(value.pages) || value.pages.length === 0) {
		fail(where, "expected an object with a non-empty `pages` array");
	}
	if (value.id !== undefined && value.id !== id) fail(where, `id "${String(value.id)}" does not match the manifest id "${id}"`);
	const seen = new Set<number>();
	const pages = value.pages.map((raw, index): ExpectedPage => {
		const at = `${where} pages[${index}]`;
		if (!isRecord(raw) || typeof raw.page !== "number" || !Number.isInteger(raw.page) || raw.page < 1) {
			fail(at, "`page` must be a positive integer");
		}
		if (seen.has(raw.page)) fail(at, `page ${raw.page} appears twice`);
		seen.add(raw.page);
		if (raw.text !== undefined && typeof raw.text !== "string") fail(at, "`text` must be a string");
		const headings = raw.headings === undefined ? undefined : parseHeadings(raw.headings, `${at}.headings`);
		const tables =
			raw.tables === undefined
				? undefined
				: Array.isArray(raw.tables)
					? raw.tables.map((table, t) => parseTable(table, `${at}.tables[${t}]`))
					: fail(at, "`tables` must be an array");
		return {
			page: raw.page,
			...(typeof raw.text === "string" ? { text: raw.text } : {}),
			...(headings !== undefined ? { headings } : {}),
			...(tables !== undefined ? { tables } : {}),
		};
	});
	return { id, pages };
}

function parseHeadings(value: unknown, where: string): Heading[] {
	if (!Array.isArray(value)) fail(where, "must be an array");
	return value.map((heading, index) => {
		if (
			!isRecord(heading) ||
			typeof heading.text !== "string" ||
			typeof heading.level !== "number" ||
			!Number.isInteger(heading.level) ||
			heading.level < 1
		) {
			fail(`${where}[${index}]`, "a heading is { level: positive integer, text: string }");
		}
		return { level: heading.level, text: heading.text };
	});
}

export function parseManifest(value: unknown): QualityManifest {
	if (!isRecord(value) || typeof value.version !== "string") fail("manifest.json", "`version` is required");
	if (value.kind !== "synthetic" && value.kind !== "public" && value.kind !== "customer") {
		fail("manifest.json", '`kind` must be "synthetic", "public" or "customer"');
	}
	if (!Array.isArray(value.cases) || value.cases.length === 0) fail("manifest.json", "`cases` must be a non-empty array");
	const ids = new Set<string>();
	const cases = value.cases.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.id)) {
			fail(`manifest.json cases[${index}]`, "`id` must be a file-name-safe string");
		}
		if (ids.has(entry.id)) fail("manifest.json", `duplicate case id "${entry.id}"`);
		ids.add(entry.id);
		return {
			id: entry.id,
			expected: typeof entry.expected === "string" ? entry.expected : `${entry.id}.expected.json`,
			...(typeof entry.title === "string" ? { title: entry.title } : {}),
		};
	});
	return {
		version: value.version,
		kind: value.kind,
		cases,
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(typeof value.producedDir === "string" ? { producedDir: value.producedDir } : {}),
	};
}

// ─── Produced output ─────────────────────────────────────────────────────────

export interface ProducedPage {
	text: string;
	headings: Heading[];
	tables: Table[];
}

function cellText(cell: unknown): string {
	if (typeof cell === "string") return cell;
	return isRecord(cell) && typeof cell.text === "string" ? cell.text : "";
}

/**
 * Read the `page` records of a v2 record stream into running text, headings and
 * tables per page. Records of other types, malformed lines and blocks of
 * unknown types are skipped rather than failing the run: the scorer measures
 * what is there.
 */
export function parseProduced(ndjson: string): Map<number, ProducedPage> {
	const pages = new Map<number, ProducedPage>();
	for (const line of ndjson.split("\n")) {
		if (line.trim() === "") continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(record) || record.type !== "page" || typeof record.page !== "number" || !Array.isArray(record.blocks)) continue;
		const page: ProducedPage = pages.get(record.page) ?? { text: "", headings: [], tables: [] };
		const lines: string[] = page.text === "" ? [] : [page.text];
		for (const block of record.blocks) {
			if (!isRecord(block)) continue;
			if (block.type === "heading" && typeof block.text === "string") {
				const level = typeof block.level === "number" ? block.level : 1;
				page.headings.push({ level, text: block.text });
				const numbering = typeof block.numbering === "string" && block.numbering !== "" ? `${block.numbering} ` : "";
				lines.push(numbering === "" || block.text.startsWith(numbering.trim()) ? block.text : `${numbering}${block.text}`);
			} else if ((block.type === "paragraph" || block.type === "footnote" || block.type === "code") && typeof block.text === "string") {
				lines.push(block.text);
			} else if (block.type === "list" && Array.isArray(block.items)) {
				for (const item of block.items) if (typeof item === "string") lines.push(item);
			} else if (block.type === "table") {
				const rows = (value: unknown): TableCell[][] =>
					Array.isArray(value)
						? value.map((row) =>
								Array.isArray(row)
									? row.map((cell): TableCell => {
											if (typeof cell === "string") return cell;
											if (isRecord(cell) && typeof cell.text === "string") {
												return {
													text: cell.text,
													...(typeof cell.colspan === "number" ? { colspan: cell.colspan } : {}),
													...(typeof cell.rowspan === "number" ? { rowspan: cell.rowspan } : {}),
												};
											}
											return cellText(cell);
										})
									: [],
							)
						: [];
				page.tables.push({ headerRows: rows(block.headerRows), rows: rows(block.rows) });
			}
		}
		page.text = lines.join("\n");
		pages.set(record.page, page);
	}
	return pages;
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

export interface CaseResult {
	id: string;
	pages: number;
	/** Annotated pages with no produced page record at all. */
	missingPages: number[];
	cer: Cer | null;
	headings: { text: PrecisionRecall; withLevel: PrecisionRecall } | null;
	tables: { expected: number; teds: number[]; tedsStructure: number[]; extra: number } | null;
}

export function scoreCase(expected: ExpectedCase, produced: ReadonlyMap<number, ProducedPage>): CaseResult {
	const missingPages: number[] = [];
	const cers: Cer[] = [];
	const headingText: PrecisionRecall[] = [];
	const headingLevel: PrecisionRecall[] = [];
	let tableCount = 0;
	const tedsValues: number[] = [];
	const tedsStructure: number[] = [];
	let extraTables = 0;
	let hasHeadings = false;
	let hasTables = false;
	for (const page of expected.pages) {
		const got = produced.get(page.page);
		if (got === undefined) missingPages.push(page.page);
		const empty: ProducedPage = { text: "", headings: [], tables: [] };
		const actual = got ?? empty;
		if (page.text !== undefined) cers.push(cer(page.text, actual.text));
		if (page.headings !== undefined) {
			hasHeadings = true;
			headingText.push(headingF1(page.headings, actual.headings, { matchLevel: false }));
			headingLevel.push(headingF1(page.headings, actual.headings, { matchLevel: true }));
		}
		if (page.tables !== undefined) {
			hasTables = true;
			const match = matchTables(page.tables, actual.tables);
			tableCount += page.tables.length;
			tedsValues.push(...match.teds);
			tedsStructure.push(...match.tedsStructure);
			extraTables += match.extra;
		}
	}
	return {
		id: expected.id,
		pages: expected.pages.length,
		missingPages,
		cer: cers.length > 0 ? pooledCer(cers) : null,
		headings: hasHeadings ? { text: pooledPrf(headingText), withLevel: pooledPrf(headingLevel) } : null,
		tables: hasTables ? { expected: tableCount, teds: tedsValues, tedsStructure, extra: extraTables } : null,
	};
}

export interface Summary {
	cases: number;
	pages: number;
	missingPages: number;
	/** Pooled character error rate (total edits / total reference characters). */
	cer: Cer | null;
	/** Pooled heading precision/recall/F1, text only and with the level. */
	headingF1: PrecisionRecall | null;
	headingF1WithLevel: PrecisionRecall | null;
	/** Mean TEDS over every annotated table. */
	teds: number | null;
	tedsStructure: number | null;
	tables: number;
	extraTables: number;
}

export function summarise(results: readonly CaseResult[]): Summary {
	const cers = results.flatMap((r) => (r.cer === null ? [] : [r.cer]));
	const heads = results.flatMap((r) => (r.headings === null ? [] : [r.headings]));
	const tables = results.flatMap((r) => (r.tables === null ? [] : [r.tables]));
	return {
		cases: results.length,
		pages: results.reduce((sum, r) => sum + r.pages, 0),
		missingPages: results.reduce((sum, r) => sum + r.missingPages.length, 0),
		cer: cers.length > 0 ? pooledCer(cers) : null,
		headingF1: heads.length > 0 ? pooledPrf(heads.map((h) => h.text)) : null,
		headingF1WithLevel: heads.length > 0 ? pooledPrf(heads.map((h) => h.withLevel)) : null,
		teds: mean(tables.flatMap((t) => t.teds)),
		tedsStructure: mean(tables.flatMap((t) => t.tedsStructure)),
		tables: tables.reduce((sum, t) => sum + t.expected, 0),
		extraTables: tables.reduce((sum, t) => sum + t.extra, 0),
	};
}

export interface Thresholds {
	maxCer?: number | undefined;
	minHeadingF1?: number | undefined;
	minTeds?: number | undefined;
}

/** The bounds a summary misses; empty when it passes (a metric without annotations is not gated). */
export function checkThresholds(summary: Summary, thresholds: Thresholds): string[] {
	const failures: string[] = [];
	if (thresholds.maxCer !== undefined && summary.cer !== null && summary.cer.cer > thresholds.maxCer) {
		failures.push(`CER ${pct(summary.cer.cer)} is above the maximum ${pct(thresholds.maxCer)}`);
	}
	if (thresholds.minHeadingF1 !== undefined && summary.headingF1 !== null && summary.headingF1.f1 < thresholds.minHeadingF1) {
		failures.push(`Heading-F1 ${pct(summary.headingF1.f1)} is below the minimum ${pct(thresholds.minHeadingF1)}`);
	}
	if (thresholds.minTeds !== undefined && summary.teds !== null && summary.teds < thresholds.minTeds) {
		failures.push(`TEDS ${pct(summary.teds)} is below the minimum ${pct(thresholds.minTeds)}`);
	}
	return failures;
}

// ─── Report ──────────────────────────────────────────────────────────────────

const formatPercent = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(1)} %`);
const pct = formatPercent;

export interface Report {
	label: string;
	set: { version: string; kind: SetKind; description?: string };
	produced: string | null;
	summary: Summary;
	cases: CaseResult[];
}

export function renderMarkdown(report: Report): string {
	const { summary } = report;
	// Without produced output every score would read as "everything missing";
	// say "pending" instead of a number that looks like a measurement.
	const pending = report.produced === null;
	const pct = (value: number | null): string => (pending ? "pending" : formatPercent(value));
	const lines = [
		`# Extraction quality — ${report.label}`,
		"",
		`Set: ${report.set.kind} v${report.set.version}${report.set.description !== undefined ? ` — ${report.set.description}` : ""}`,
		`Produced output: ${report.produced ?? "none (pending: only the annotation counts are shown)"}`,
		"",
		"| Metric | Value | Definition |",
		"| --- | ---: | --- |",
		`| CER | ${pct(summary.cer?.cer ?? null)} | edit distance of the running text / reference characters (lower is better) |`,
		`| Heading-F1 | ${pct(summary.headingF1?.f1 ?? null)} | headings matched on their text |`,
		`| Heading-F1 (with level) | ${pct(summary.headingF1WithLevel?.f1 ?? null)} | headings matched on text and level |`,
		`| TEDS | ${pct(summary.teds)} | tree-edit-distance similarity of ${summary.tables} annotated table(s) |`,
		`| TEDS (structure) | ${pct(summary.tedsStructure)} | the same ignoring cell text |`,
		"",
		`${summary.cases} case(s), ${summary.pages} annotated page(s), ${summary.missingPages} without a produced page, ${summary.extraTables} produced table(s) matched to no annotation.`,
		"",
		"| Case | Pages | CER | Heading-F1 | TEDS | Missing pages |",
		"| --- | ---: | ---: | ---: | ---: | --- |",
		...report.cases.map(
			(c) =>
				`| ${c.id} | ${c.pages} | ${pct(c.cer?.cer ?? null)} | ${pct(c.headings?.text.f1 ?? null)} | ${pct(
					c.tables === null ? null : mean(c.tables.teds),
				)} | ${c.missingPages.length === 0 ? "—" : c.missingPages.join(", ")} |`,
		),
		"",
	];
	return lines.join("\n");
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface Args {
	set: string;
	produced?: string;
	out: string;
	label: string;
	thresholds: Thresholds;
}

function parseArgs(argv: string[]): Args {
	const get = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const bound = (name: string): number | undefined => {
		const raw = get(name);
		if (raw === undefined) return undefined;
		const value = Number.parseFloat(raw);
		if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
		return value;
	};
	const produced = get("--produced");
	return {
		set: get("--set") ?? DEFAULT_SET,
		out: get("--out") ?? "reports/extract-quality",
		label: get("--label") ?? "run",
		...(produced !== undefined ? { produced } : {}),
		thresholds: { maxCer: bound("--max-cer"), minHeadingF1: bound("--min-heading-f1"), minTeds: bound("--min-teds") },
	};
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function run(args: Args): Promise<{ report: Report; failures: string[] }> {
	const setDir = resolve(args.set);
	const manifest = parseManifest(await readJson(join(setDir, "manifest.json")));
	const producedDir =
		args.produced !== undefined
			? resolve(args.produced)
			: manifest.producedDir !== undefined
				? resolve(setDir, manifest.producedDir)
				: null;
	if (producedDir !== null) {
		const found = await stat(producedDir).catch(() => null);
		if (found === null || !found.isDirectory()) throw new Error(`produced directory not found: ${producedDir}`);
	}
	const results: CaseResult[] = [];
	for (const entry of manifest.cases) {
		const expected = parseExpected(await readJson(join(setDir, entry.expected)), entry.id);
		let produced: Map<number, ProducedPage>;
		if (producedDir === null) {
			produced = new Map();
		} else {
			try {
				produced = parseProduced(await readFile(join(producedDir, `${entry.id}.ndjson`), "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				produced = new Map();
			}
		}
		results.push(scoreCase(expected, produced));
	}
	const summary = summarise(results);
	const report: Report = {
		label: args.label,
		set: { version: manifest.version, kind: manifest.kind, ...(manifest.description !== undefined ? { description: manifest.description } : {}) },
		produced: producedDir === null ? null : args.produced ?? manifest.producedDir ?? null,
		summary,
		cases: results,
	};
	const gated =
		args.thresholds.maxCer !== undefined ||
		args.thresholds.minHeadingF1 !== undefined ||
		args.thresholds.minTeds !== undefined;
	const failures =
		producedDir === null
			? gated
				? ["a bound was given but there is no produced output to score (--produced <dir>)"]
				: []
			: checkThresholds(summary, args.thresholds);
	return { report, failures };
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	const { report, failures } = await run(args);
	const markdown = renderMarkdown(report);
	process.stdout.write(`${markdown}\n`);
	const base = `${args.out}.${args.label}`;
	await mkdir(dirname(base), { recursive: true });
	await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	await writeFile(`${base}.md`, markdown, "utf8");
	for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
	if (failures.length > 0) process.exit(1);
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
