// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * document-structure.ts
 *
 * Search's legacy adapter for the v1 marker grammar.
 *
 * The low-level recognition of that grammar — page markers, `<summary>` blocks,
 * `<figures>`/`<figure>` entries, figure ids, geometry and the asset-id
 * derivation — is NOT re-implemented here. It lives in the contract package
 * (`@atf/extract-contract/v1`) and is reached through {@link parseDocument} and
 * the shared marker constants, so Extract (the producer) and Search (this
 * consumer) share exactly one parser and cannot drift (Requirement 3.2).
 *
 * What this module still owns is the Search-specific *indexing* view built on
 * top of that recognition, and none of it changes the grammar:
 *
 *   - per-page summaries kept in a Map (defect D1, Requirement 2.1) rather than
 *     concatenated into one chain;
 *   - `## Seite N` markers and `---` separators stripped out of the embedding
 *     and full-text body, with the page spans remapped into the stripped body's
 *     coordinate space (Requirement 2.3);
 *   - `![figure_…]` placeholders substituted with a readable reference and their
 *     char spans recorded as `figure_refs` (Requirement 2.4);
 *   - the next heading after a figure, for the figure chunk's embedding input
 *     (Requirement 2.5);
 *   - HTML tables normalised to Markdown.
 *
 * The page markers are imported from the contract, so a change to the grammar
 * on the producer side is picked up here without a second edit.
 */

import {
	PAGE_MARKER_PATTERN as CONTRACT_PAGE_MARKER_PATTERN,
	globalize,
	parseDocument,
	type ParsedFigure,
} from "@atf/extract-contract/v1";

export type SummaryMode = "auto" | "generate" | "embedded" | "off";

export interface PageSpan {
	page: number;
	charStart: number;
	charEnd: number;
}

export interface FigureStructure {
	id: string;
	description: string;
	page?: number;
	bbox?: [number, number, number, number];
	assetId: string;
	/**
	 * The next Markdown heading that follows the figure's placeholder in the
	 * body. Fed into the figure chunk's embedding input alongside the caption
	 * and the page summary (Requirement 2.5) so a figure is retrievable by the
	 * section it introduces even when its own caption is terse.
	 */
	nextHeading?: string;
}

/**
 * A figure placeholder that was substituted into the body as a readable
 * reference (`[Abbildung <id>: …]`). Its char span is expressed in the final
 * (stripped) body's coordinate space so the ingest layer can attribute the
 * reference to every chunk whose range covers it (Requirement 2.4).
 */
export interface FigureReference {
	id: string;
	assetId: string;
	charStart: number;
	charEnd: number;
}

export interface DocumentStructureOptions {
	pageMarkers?: boolean;
	figureChunks?: boolean;
	normalizeTables?: boolean;
}

export interface NormalizedDocumentStructure {
	content: string;
	/**
	 * Document-level fallback summary, only set when a `<summary>` block could
	 * not be attributed to a page (no preceding page marker). Per-page summaries
	 * live in {@link pageSummaries} instead — the old behaviour of concatenating
	 * every page summary into one chain (defect D1) is gone.
	 */
	embeddedSummary?: string;
	/**
	 * Page number → that page's `<summary>` text. The embed-input builder pulls
	 * only the summaries of the pages a chunk actually covers, so the context a
	 * chunk carries no longer grows with the document.
	 */
	pageSummaries: Map<number, string>;
	pageSpans: PageSpan[];
	figures: FigureStructure[];
	/**
	 * Every figure placeholder that was substituted into the body, with its
	 * char span in the final body. A chunk carries a figure id in `figure_refs`
	 * when its char range covers the reference (Requirement 2.4).
	 */
	figureReferences: FigureReference[];
}

/** Cap applied to the page-context prefix in the embedding input (Requirement 2.1). */
export const PAGE_SUMMARY_CONTEXT_LIMIT = 400;

/**
 * Build the page-context prefix for a chunk: the summaries of the pages it
 * covers, joined and capped at {@link PAGE_SUMMARY_CONTEXT_LIMIT} characters.
 *
 * Only the pages in `[pageStart, pageEnd]` contribute, so the context stays
 * proportional to the chunk regardless of the document's total page count
 * (defect D1, Requirement 2.1/2.2). Returns undefined when no summary applies.
 */
export function buildPageContextPrefix(
	pageSummaries: Map<number, string>,
	pageStart: number | undefined,
	pageEnd: number | undefined,
	limit: number = PAGE_SUMMARY_CONTEXT_LIMIT,
): string | undefined {
	if (pageStart === undefined || pageSummaries.size === 0) return undefined;
	const end = pageEnd ?? pageStart;
	const seen = new Set<string>();
	const parts: string[] = [];
	for (let page = pageStart; page <= end; page++) {
		const summary = pageSummaries.get(page);
		if (summary && !seen.has(summary)) {
			seen.add(summary);
			parts.push(summary);
		}
	}
	if (parts.length === 0) return undefined;
	const joined = parts.join(" ");
	const capped =
		joined.length > limit ? joined.slice(0, limit).trimEnd() : joined;
	return capped === "" ? undefined : capped;
}

function decodeEntities(value: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
	};
	return value.replace(
		/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
		(match, entity: string) => {
			if (entity[0] === "#") {
				const hex = entity[1]?.toLowerCase() === "x";
				const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
				return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: match;
			}
			return named[entity.toLowerCase()] ?? match;
		},
	);
}

/** Normalize HTML/Markdown-ish inline text without adding a DOM dependency. */
export function normalizeInlineText(value: string): string {
	return decodeEntities(
		value
			.replace(/<br\s*\/?\s*>/gi, " ")
			.replace(/<[^>]*>/g, " ")
			.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/[*_~`#]+/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The first sentence of a figure description, used to build a readable
 * placeholder reference (`[Abbildung <id>: <first sentence>]`). Falls back to
 * the whole (already length-bounded) text when no sentence terminator is found;
 * capped so a long caption cannot bloat the body.
 */
export function firstSentence(value: string, limit = 160): string {
	const text = value.trim();
	if (text === "") return "";
	const match = /^[\s\S]*?[.!?](?=\s|$)/.exec(text);
	const sentence = (match?.[0] ?? text).trim();
	return sentence.length > limit
		? `${sentence.slice(0, limit).trimEnd()}…`
		: sentence;
}

interface HtmlToken {
	kind: "open" | "close" | "text";
	name?: string;
	attrs?: Record<string, string>;
	text?: string;
}

function parseAttributes(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	for (const match of raw.matchAll(pattern)) {
		const name = match[1]?.toLowerCase();
		if (name) attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
	}
	return attrs;
}

function tokenizeHtml(html: string): HtmlToken[] {
	const tokens: HtmlToken[] = [];
	const pattern = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</g;
	for (const match of html.matchAll(pattern)) {
		const raw = match[0];
		if (raw.startsWith("<!--")) continue;
		if (!raw.startsWith("<")) {
			tokens.push({ kind: "text", text: raw });
			continue;
		}
		const close = /^<\s*\/\s*([\w:-]+)/.exec(raw);
		const closeName = close?.[1];
		if (closeName !== undefined) {
			tokens.push({ kind: "close", name: closeName.toLowerCase() });
			continue;
		}
		const open = /^<\s*([\w:-]+)([\s\S]*?)\/?\s*>$/.exec(raw);
		const openName = open?.[1];
		if (openName !== undefined) {
			tokens.push({
				kind: "open",
				name: openName.toLowerCase(),
				attrs: parseAttributes(open?.[2] ?? ""),
			});
		}
	}
	return tokens;
}

/** Convert one HTML table into a rectangular Markdown table, expanding spans. */
export function htmlTableToMarkdown(html: string): string {
	const rows: Array<Array<{ text: string; rowspan: number; colspan: number }>> =
		[];
	let row: Array<{ text: string; rowspan: number; colspan: number }> | null =
		null;
	let cell: { text: string; rowspan: number; colspan: number } | null = null;
	for (const token of tokenizeHtml(html)) {
		if (token.kind === "open" && token.name === "tr") row = [];
		else if (
			token.kind === "open" &&
			(token.name === "td" || token.name === "th")
		) {
			const rowspan = Math.max(
				1,
				Number.parseInt(token.attrs?.["rowspan"] ?? "1", 10) || 1,
			);
			const colspan = Math.max(
				1,
				Number.parseInt(token.attrs?.["colspan"] ?? "1", 10) || 1,
			);
			cell = { text: "", rowspan, colspan };
		} else if (token.kind === "text" && cell) cell.text += token.text ?? "";
		else if (token.kind === "open" && token.name === "br" && cell)
			cell.text += " ";
		else if (
			token.kind === "close" &&
			(token.name === "td" || token.name === "th")
		) {
			if (row && cell)
				row.push({ ...cell, text: normalizeInlineText(cell.text) });
			cell = null;
		} else if (token.kind === "close" && token.name === "tr") {
			if (row && row.length > 0) rows.push(row);
			row = null;
		}
	}
	if (rows.length === 0) return normalizeInlineText(html);

	const matrix: string[][] = [];
	const occupied: boolean[][] = [];
	rows.forEach((sourceRow, rowIndex) => {
		matrix[rowIndex] ??= [];
		let occupiedRow = occupied[rowIndex];
		if (occupiedRow === undefined) {
			occupiedRow = [];
			occupied[rowIndex] = occupiedRow;
		}
		let column = 0;
		for (const sourceCell of sourceRow) {
			while (occupiedRow[column]) column++;
			for (let y = 0; y < sourceCell.rowspan; y++) {
				const targetRowIndex = rowIndex + y;
				let matrixRow = matrix[targetRowIndex];
				if (matrixRow === undefined) {
					matrixRow = [];
					matrix[targetRowIndex] = matrixRow;
				}
				let targetOccupiedRow = occupied[targetRowIndex];
				if (targetOccupiedRow === undefined) {
					targetOccupiedRow = [];
					occupied[targetRowIndex] = targetOccupiedRow;
				}
				for (let x = 0; x < sourceCell.colspan; x++) {
					matrixRow[column + x] = sourceCell.text;
					targetOccupiedRow[column + x] = true;
				}
			}
			column += sourceCell.colspan;
		}
	});
	const width = Math.max(...matrix.map((r) => r.length));
	const escaped = matrix.map((r) =>
		Array.from({ length: width }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|")),
	);
	const line = (r: string[]) => `| ${r.join(" | ")} |`;
	const header = escaped[0];
	if (header === undefined) return normalizeInlineText(html);
	return [
		line(header),
		line(Array.from({ length: width }, () => "---")),
		...escaped.slice(1).map(line),
	].join("\n");
}

export function normalizeHtmlTables(content: string): string {
	return content.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (table) =>
		htmlTableToMarkdown(table),
	);
}

/** Matches a page marker line (`## Seite N` / `## Page N`) on its own line. */
export const PAGE_MARKER_PATTERN = globalize(CONTRACT_PAGE_MARKER_PATTERN);

/**
 * The text of the first Markdown heading that starts after `position`, skipping
 * page markers (`## Seite N`). Used to give a figure chunk the heading it sits
 * under so it is retrievable by that section (Requirement 2.5).
 */
function nextHeadingAfter(content: string, position: number): string | undefined {
	const pattern = /^#{1,6}\s+(.+?)\s*$/gim;
	for (const match of content.matchAll(pattern)) {
		if ((match.index ?? 0) < position) continue;
		const heading = match[1]?.trim();
		if (heading === undefined || heading === "") continue;
		if (/^(?:Seite|Page)\s+\d+$/i.test(heading)) continue;
		return normalizeInlineText(heading);
	}
	return undefined;
}

export function extractPageSpans(content: string): PageSpan[] {
	const markers = [...content.matchAll(globalize(CONTRACT_PAGE_MARKER_PATTERN))];
	return markers.map((marker, index) => ({
		page: Number.parseInt(marker[1] ?? "", 10),
		charStart: marker.index ?? 0,
		charEnd: markers[index + 1]?.index ?? content.length,
	}));
}
/**
 * Remove page markers (`## Seite N`) and page separators from a body while
 * keeping the page ranges intact (Requirement 2.3).
 *
 * The markers carry the page numbers, so the spans MUST be built from the
 * marked-up body first (via {@link extractPageSpans}). Stripping shifts every
 * following character to the left, which would desync the span offsets that
 * {@link pagesForRange} relies on. Instead of re-locating pages by searching
 * for text anchors (fragile for lines such as `|---|` or setext underlines),
 * every removal is recorded as a range of the original body and each span
 * boundary is translated through that exact offset mapping.
 *
 * Removed per page:
 * - the leading `## Seite N` marker line plus the blank lines after it;
 * - for every page except the last, the single trailing page separator
 *   (the contract's `PAGE_SEPARATOR`, `\n\n---\n\n`) right before the next
 *   marker, tolerating extra blank lines / trailing spaces around it.
 *
 * Any other `---` line inside a page (horizontal rule, setext heading
 * underline, table delimiter row) is left untouched. Afterwards runs of three
 * or more newlines are collapsed to one blank line and the body is trimmed,
 * again through the offset mapping.
 */
export function stripPageMarkers(
	content: string,
	spans: PageSpan[],
): { content: string; spans: PageSpan[] } {
	// No page markers: there is nothing to strip, but keep the same whitespace
	// normalisation the marker path applies so the body is identical either way.
	if (spans.length === 0)
		return { content: content.replace(/\n{3,}/g, "\n\n").trim(), spans };

	// Stage 1: marker lines and page separators, as ranges of `content`.
	const removals: Array<[number, number]> = [];
	const markerPattern = new RegExp(
		`^${CONTRACT_PAGE_MARKER_PATTERN.source.replace(/^\^/, "").replace(/\$$/, "")}`,
		"i",
	);
	for (const [i, span] of spans.entries()) {
		const block = content.slice(span.charStart, span.charEnd);
		const marker = markerPattern.exec(block);
		if (marker) {
			// Marker line plus the whitespace up to (and including) the last
			// newline before the page's first content line.
			const afterMarker = block.slice(marker[0].length);
			const leading = /^[ \t]*(?:\n[ \t]*)*\n/.exec(afterMarker);
			const markerEnd =
				marker[0].length + (leading ? leading[0].length : afterMarker.length);
			removals.push([span.charStart, span.charStart + Math.min(markerEnd, block.length)]);
		}
		if (i < spans.length - 1) {
			// Exactly one trailing separator: a `---` line preceded by a blank
			// line (so a setext underline, which directly follows its text line,
			// never matches) and followed only by whitespace up to the next marker.
			// The blank line before the `---` is kept so the two pages' texts stay
			// separated by a paragraph break instead of being glued together.
			const separator = /\n[ \t]*\n([ \t]*-{3,}[ \t]*(?:\n[ \t]*)*)$/.exec(block);
			// Overlap with the marker removal (an empty page) is merged later.
			const contentStart = marker ? (removals.at(-1)?.[1] ?? span.charStart) : span.charStart;
			if (separator) {
				const line = separator[1] ?? "";
				removals.push([span.charEnd - line.length, span.charEnd]);
			} else if (
				marker &&
				/^[ \t]*-{3,}[ \t]*(?:\n[ \t]*)*$/.test(content.slice(contentStart, span.charEnd))
			) {
				// Empty page: only the separator is left after the marker.
				removals.push([contentStart, span.charEnd]);
			}
		}
	}
	const stage1 = applyRemovals(content, removals);

	// Stage 2: collapse blank runs and trim, as ranges of the stage-1 body.
	const collapse: Array<[number, number]> = [];
	const leadingWs = /^\s*/.exec(stage1.text)?.[0].length ?? 0;
	if (leadingWs > 0) collapse.push([0, leadingWs]);
	for (const run of stage1.text.matchAll(/\n{3,}/g)) {
		const at = run.index ?? 0;
		if (at + run[0].length <= leadingWs) continue;
		collapse.push([Math.max(at + 2, leadingWs), at + run[0].length]);
	}
	const trailingWs = /\s*$/.exec(stage1.text)?.[0].length ?? 0;
	if (trailingWs > 0 && leadingWs < stage1.text.length) {
		collapse.push([stage1.text.length - trailingWs, stage1.text.length]);
	}
	const stage2 = applyRemovals(stage1.text, collapse);

	const mapOffset = (offset: number) => stage2.map(stage1.map(offset));
	return {
		content: stage2.text,
		spans: spans.map((span) => ({
			page: span.page,
			charStart: mapOffset(span.charStart),
			charEnd: mapOffset(span.charEnd),
		})),
	};
}

/**
 * Remove a set of (possibly overlapping, unsorted) half-open ranges from a
 * string and return the result plus a monotone offset mapping from the input
 * coordinate space into the output one. An offset inside a removed range maps
 * to the output position where that range used to be.
 */
function applyRemovals(
	text: string,
	ranges: Array<[number, number]>,
): { text: string; map: (offset: number) => number } {
	const merged: Array<[number, number]> = [];
	for (const [start, end] of [...ranges]
		.filter(([s, e]) => e > s)
		.sort((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	let out = "";
	let cursor = 0;
	// removedBefore[k] = total removed length of merged[0..k-1].
	const removedBefore: number[] = [];
	let removed = 0;
	for (const [start, end] of merged) {
		out += text.slice(cursor, start);
		removedBefore.push(removed);
		removed += end - start;
		cursor = end;
	}
	out += text.slice(cursor);
	const map = (offset: number): number => {
		// Binary search the last range starting at or before `offset`.
		let lo = 0;
		let hi = merged.length - 1;
		let hit = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const range = merged[mid];
			if (range !== undefined && range[0] <= offset) {
				hit = mid;
				lo = mid + 1;
			} else hi = mid - 1;
		}
		if (hit === -1) return Math.min(offset, out.length);
		const range = merged[hit];
		const before = removedBefore[hit] ?? 0;
		if (range === undefined) return Math.min(offset, out.length);
		if (offset < range[1]) return range[0] - before;
		return Math.min(offset - before - (range[1] - range[0]), out.length);
	};
	return { text: out, map };
}


export function pagesForRange(
	spans: PageSpan[],
	charStart: number,
	charEnd: number,
): { pageStart?: number; pageEnd?: number } {
	const overlap = spans.filter(
		(span) => span.charStart < charEnd && span.charEnd > charStart,
	);
	if (overlap.length === 0) return {};
	const first = overlap[0];
	const last = overlap.at(-1);
	if (first === undefined || last === undefined) return {};
	return { pageStart: first.page, pageEnd: last.page };
}

/**
 * Turn a figure recovered by the contract parser into the Search indexing
 * shape. The id, page, geometry and asset id are the parser's — Search only
 * adds `nextHeading`, which is an indexing concern, not part of the grammar.
 */
function toFigureStructure(
	figure: ParsedFigure,
	body: string,
	pageMarkers: boolean,
): FigureStructure {
	// Locate the figure's placeholder in the body to find the heading it sits
	// under. When the placeholder is absent (a figure declared but never
	// referenced in the flow) fall back to the start of the page.
	const placeholder = `![figure_${figure.id}]`;
	const at = body.indexOf(placeholder);
	const nextHeading =
		at === -1 ? nextHeadingAfter(body, 0) : nextHeadingAfter(body, at);
	return {
		id: figure.id,
		description: figure.description,
		...(pageMarkers && figure.page !== undefined ? { page: figure.page } : {}),
		...(figure.bbox !== undefined
			? { bbox: [figure.bbox[0], figure.bbox[1], figure.bbox[2], figure.bbox[3]] }
			: {}),
		assetId: figure.assetId,
		...(nextHeading !== undefined ? { nextHeading } : {}),
	};
}

/**
 * Deterministically extract embedded structure and return a cleaned indexing
 * body.
 *
 * The v1 grammar (page markers, `<summary>`, `<figure>`, asset ids) is
 * recognised by the shared contract parser {@link parseDocument}; this function
 * builds Search's indexing view on top of it (per-page summaries, marker
 * stripping with offset mapping, figure placeholder substitution, table
 * normalisation) without re-implementing the grammar.
 */
export function normalizeDocumentStructure(
	content: string,
	documentReference: string,
	options: DocumentStructureOptions = {},
): NormalizedDocumentStructure {
	const pageMarkers = options.pageMarkers ?? true;
	const figureChunks = options.figureChunks ?? true;
	const normalizeTables = options.normalizeTables ?? true;

	// One pass of the shared grammar parser gives the authoritative page
	// summaries, figures (ids, pages, geometry, asset ids) and the placeholder
	// references, so this adapter never re-derives any of them.
	const parsed = parseDocument(content, documentReference);

	// Per-page summaries (defect D1). The parser attributes each <summary> to
	// its page; a summary before the first page marker lands in the preamble and
	// is kept as a document-level fallback so the "embedded summary present"
	// signal survives.
	const pageSummaries = new Map<number, string>();
	if (pageMarkers) {
		for (const page of parsed.pages) {
			if (page.summary !== undefined && page.summary.trim() !== "") {
				pageSummaries.set(page.page, page.summary.replace(/\s+/g, " ").trim());
			}
		}
	}
	let embeddedSummary: string | undefined;
	if (!pageMarkers) {
		// With page markers disabled every summary is document-level context.
		const all = parsed.pages
			.map((page) => page.summary)
			.filter((s): s is string => s !== undefined && s.trim() !== "")
			.map((s) => s.replace(/\s+/g, " ").trim());
		if (all.length > 0) embeddedSummary = all.join("\n");
	} else {
		const preambleSummary = extractPreambleSummary(content, parsed.preamble);
		if (preambleSummary !== undefined) embeddedSummary = preambleSummary;
	}

	// Figures, straight from the parser. `nextHeading` is the only Search-side
	// addition; it needs the body with markers still in place so headings after
	// a figure resolve correctly.
	const figures: FigureStructure[] = figureChunks
		? parsed.figures.map((figure) =>
				toFigureStructure(figure, content, pageMarkers),
			)
		: [];
	const figuresById = new Map<string, FigureStructure>();
	for (const figure of figures) figuresById.set(figure.id, figure);

	// Strip the recognised structure (summary + figure blocks) out of the body,
	// leaving the page markers and placeholders in place for the offset-aware
	// steps below.
	let body = stripSummaryBlocks(content);
	body = stripFigureBlocks(body);

	// Replace each `![figure_<id>]` placeholder with a readable reference
	// `[Abbildung <id>: <first sentence>]` instead of deleting it
	// (Requirement 2.4). When no matching <figure> was declared, fall back to
	// the raw placeholder id so the reference is never empty.
	const referencedFigures: FigureStructure[] = [];
	body = body.replace(
		globalize(/!\[figure_([^\]]+)\](?:\([^)]*\))?/i),
		(_all, rawId: string) => {
			if (!figureChunks) return "";
			const normalizedId = rawId
				.replace(/^figure_/i, "")
				.replace(/[^a-zA-Z0-9._-]+/g, "-");
			const figure = figuresById.get(normalizedId) ?? figuresById.get(rawId);
			const id = figure?.id ?? (normalizedId || rawId);
			const sentence = figure ? firstSentence(figure.description) : "";
			if (figure) referencedFigures.push(figure);
			return sentence ? `[Abbildung ${id}: ${sentence}]` : `[Abbildung ${id}]`;
		},
	);
	if (normalizeTables) body = normalizeHtmlTables(body);

	// Build the page spans from the marker-bearing body FIRST, then strip the
	// `## Seite N` markers and the `---` page separators out of both the
	// embedding input and the full-text body while keeping the page ranges
	// intact (Requirement 2.3). stripPageMarkers remaps every span's char
	// offsets into the stripped body's coordinate space so pagesForRange still
	// maps a chunk's char range to the right page (defect D6).
	if (pageMarkers) {
		const spans = extractPageSpans(body);
		const stripped = stripPageMarkers(body, spans);
		return {
			content: stripped.content,
			...(embeddedSummary ? { embeddedSummary } : {}),
			pageSummaries,
			pageSpans: stripped.spans,
			figures,
			figureReferences: locateFigureReferences(
				stripped.content,
				referencedFigures,
			),
		};
	}

	body = body.replace(/\n{3,}/g, "\n\n").trim();
	return {
		content: body,
		...(embeddedSummary ? { embeddedSummary } : {}),
		pageSummaries,
		pageSpans: [],
		figures,
		figureReferences: locateFigureReferences(body, referencedFigures),
	};
}

/**
 * Remove every `<summary>…</summary>` block from a body. The summaries have
 * already been recovered per page by the contract parser; here they are only
 * being taken out of the indexing text.
 */
function stripSummaryBlocks(content: string): string {
	return content.replace(
		/<summary\b[^>]*>[\s\S]*?<\/summary\s*>/gi,
		"",
	);
}

/**
 * Remove `<figures>` wrappers, bare `<figure>` entries and the "None"
 * placeholder from a body. Figure metadata has already been recovered by the
 * contract parser; this only clears the markup out of the indexing text.
 */
function stripFigureBlocks(content: string): string {
	return content
		.replace(/<figure\b[^>]*>[\s\S]*?<\/figure\s*>/gi, "")
		.replace(/<figures\b[^>]*>\s*(?:none|n\/a|keine)?\s*<\/figures\s*>/gi, "")
		.replace(/<\/?figures\b[^>]*>/gi, "");
}

/**
 * A `<summary>` that appears before the first page marker (the parser's
 * `preamble`) has no page to attach to. Recover its text as a document-level
 * fallback so `X-Summary-Mode: auto/embedded` still sees an embedded summary.
 */
function extractPreambleSummary(
	content: string,
	preamble: string,
): string | undefined {
	// Restrict the search to the text before the first page marker (the parser's
	// preamble). A summary that sits under a page marker belongs to that page and
	// must not leak into the document-level fallback.
	const firstMarker = globalize(CONTRACT_PAGE_MARKER_PATTERN).exec(content);
	const head =
		firstMarker === null ? content : content.slice(0, firstMarker.index ?? 0);
	// `preamble` is the parser's tidied view of the same head; use whichever
	// actually carries the summary markup (tidy can drop nothing relevant here).
	return summaryTextFrom(head) ?? (preamble !== "" ? summaryTextFrom(preamble) : undefined);
}

function summaryTextFrom(segment: string): string | undefined {
	const parts: string[] = [];
	for (const match of segment.matchAll(
		globalize(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i),
	)) {
		const text = normalizeInlineText(match[1] ?? "");
		if (text !== "") parts.push(text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Locate the readable figure references (`[Abbildung <id>: …]`) in the final
 * body and return their char spans in that body's coordinate space. References
 * are matched to figures in document order so repeated ids stay attributed to
 * the right occurrence; a reference whose marker cannot be found (e.g. a table
 * normalisation rewrote the line) is skipped rather than reported at a wrong
 * offset.
 */
function locateFigureReferences(
	content: string,
	referencedFigures: FigureStructure[],
): FigureReference[] {
	const references: FigureReference[] = [];
	let cursor = 0;
	for (const figure of referencedFigures) {
		const marker = `[Abbildung ${figure.id}`;
		const start = content.indexOf(marker, cursor);
		if (start === -1) continue;
		const close = content.indexOf("]", start);
		const charEnd = close === -1 ? start + marker.length : close + 1;
		references.push({
			id: figure.id,
			assetId: figure.assetId,
			charStart: start,
			charEnd,
		});
		cursor = charEnd;
	}
	return references;
}
