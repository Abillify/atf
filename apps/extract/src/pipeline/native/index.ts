// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/index.ts
 *
 * Native parsers that turn a source into contract records WITHOUT a model call
 * and, where possible, without rendering (design §10, requirements 10.1–10.3).
 *
 * Three native paths land here:
 *
 *  - **BPMN** (`bpmn`): the `.bpmn` XML is parsed into a `process` transcription
 *    and emitted as a single-page record carrying one `bpmn` figure block plus
 *    the original XML kept as a `native:` asset. No render, no vision.
 *  - **XLSX** (`spreadsheet`): each worksheet becomes a `table` block on its own
 *    page. When the workbook has an embedded chart or image the pipeline still
 *    renders (the render captures what the grid cannot); otherwise the native
 *    tables are all there is.
 *  - **DOCX** (`word`): the styles give authoritative heading levels that the
 *    document pass uses to correct the height-based guess; the render path is
 *    unchanged.
 *
 * The BPMN and XLSX page-record builders here mint contract-valid v2 records —
 * the same {@link PageRecord} shape the vision pipeline produces — so the
 * emitter, the document pass and Search consume them identically.
 */

import {
	buildAssetId,
	figureLocalId,
	nativeLocalId,
	pageLocalId,
	sha256Hex,
} from "@atf/extract-contract";
import type {
	AssetRef,
	Block,
	Cell,
	EmailHeaders,
	PageRecord,
	TableBlock,
} from "@atf/extract-contract/v2";
import { parseBpmn } from "./bpmn.js";
import { type EmailAttachment, type EmailMailbox, parseEmail, stripQuotedReply } from "./eml.js";
import {
	type DocxHeading,
	type ParsedDocxHeadings,
	parseDocxHeadings,
} from "./docx-headings.js";
import type { ParsedVsdx, VsdxPage } from "./vsdx.js";
import type { ParsedXlsx, XlsxCell } from "./xlsx.js";

export type { ParsedBpmn } from "./bpmn.js";
export { parseBpmn } from "./bpmn.js";
export type { DocxHeading, ParsedDocxHeadings } from "./docx-headings.js";
export { parseDocxHeadings } from "./docx-headings.js";
export type { ParsedVsdx, VsdxEdge, VsdxNode, VsdxPage } from "./vsdx.js";
export { parseVsdx } from "./vsdx.js";
export type { ParsedXlsx, XlsxCell, XlsxSheet } from "./xlsx.js";
export { readXlsx } from "./xlsx.js";

/** A native page record plus the `native:` asset bodies it references. */
export interface NativeRecords {
	records: PageRecord[];
	/** Assets whose bytes are the original source part, keyed by asset id. */
	nativeAssets: Array<{
		assetId: string;
		localId: string;
		buffer: Uint8Array;
		mimeType: string;
	}>;
	warnings: string[];
}

/**
 * Build the single-page record for a BPMN source (requirement 10.1).
 *
 * The page carries one `figure` block of kind `bpmn` whose transcription is the
 * deterministically parsed process graph; there is no page image, and the
 * original `.bpmn` XML is stored as a `native:` asset (design §4.3). No model
 * is ever called.
 */
export function buildBpmnRecords(
	reference: string,
	buffer: Uint8Array,
): NativeRecords {
	const { transcription, warnings } = parseBpmn(
		new TextDecoder().decode(buffer),
	);
	const figureId = "p1-f1";
	const figureAssetId = buildAssetId(reference, figureLocalId(figureId));
	const nativeId = nativeLocalId("diagram.bpmn");
	const nativeAssetId = buildAssetId(reference, nativeId);

	const summary =
		transcription.nodes.length > 0
			? `BPMN-Prozess mit ${transcription.nodes.length} Knoten und ${transcription.edges.length} Verbindungen` +
				(transcription.lanes !== undefined
					? ` über ${transcription.lanes.length} Lanes`
					: "") +
				"."
			: "BPMN-Datei ohne erkennbare Prozessknoten.";

	const blocks: Block[] = [
		{
			id: `p1-fb1`,
			page: 1,
			type: "figure",
			figureId,
			kind: "bpmn",
			description: summary,
			source: "native",
			transcription,
			// The figure IS the whole page; a full-page bbox keeps the asset ref valid.
			bbox: [0, 0, 1, 1],
			assetId: figureAssetId,
		},
	];

	const assets: AssetRef[] = [
		{
			assetId: figureAssetId,
			kind: "figure",
			localId: figureLocalId(figureId),
			page: 1,
			bbox: [0, 0, 1, 1],
		},
		{
			assetId: nativeAssetId,
			kind: "native",
			localId: nativeId,
			page: 1,
			mimeType: "application/bpmn+xml",
			checksum: sha256Hex(buffer),
		},
	];

	const record: PageRecord = {
		type: "page",
		page: 1,
		size: { wPt: 1, hPt: 1 },
		class: "drawing",
		summary,
		blocks,
		assets,
		warnings,
		fidelity: {},
	};

	return {
		records: [record],
		nativeAssets: [
			{
				assetId: nativeAssetId,
				localId: nativeId,
				buffer,
				mimeType: "application/bpmn+xml",
			},
		],
		warnings,
	};
}

/**
 * Build native page records for a Visio drawing (requirement 10.4).
 *
 * Each Visio page becomes one page record carrying a single `figure` block:
 * a `flowchart` figure with a `process` transcription when the page has
 * connectors (the shapes form a flow), or a `diagram` figure with a shape-text
 * `markdown` transcription when it does not — the "process bzw. diagram" split
 * the requirement asks for. The original `.vsdx` is kept once as a `native:`
 * asset on the first page.
 *
 * Unlike {@link buildBpmnRecords}, a Visio drawing still benefits from the
 * picture, so each page also references a `page` asset: the design keeps the
 * LibreOffice → PDF render for the image *in addition to* this native structure
 * (design §10.4, "zusätzlich LibreOffice → PDF für das Bild"). This builder
 * produces the structured half; the caller wires the render alongside it.
 */
export function buildVsdxRecords(
	reference: string,
	parsed: ParsedVsdx,
	buffer: Uint8Array,
): NativeRecords {
	const nativeId = nativeLocalId("diagram.vsdx");
	const nativeAssetId = buildAssetId(reference, nativeId);
	const vsdxMime = "application/vnd.ms-visio.drawing";

	const records: PageRecord[] = [];
	let page = 0;
	for (const vsdxPage of parsed.pages) {
		page += 1;
		const figureId = `p${page}-f1`;
		const figureAssetId = buildAssetId(reference, figureLocalId(figureId));
		const summary = summarizeVsdxPage(vsdxPage);

		const figure: Block = {
			id: `p${page}-fb1`,
			page,
			type: "figure",
			figureId,
			kind: vsdxPage.figureKind,
			description: summary,
			source: "native",
			transcription: vsdxPage.transcription,
			bbox: [0, 0, 1, 1],
			assetId: figureAssetId,
		};

		const assets: AssetRef[] = [
			// The LibreOffice-rendered page image (design §10.4) attaches here.
			{
				assetId: buildAssetId(reference, pageLocalId(page)),
				kind: "page",
				localId: pageLocalId(page),
				page,
			},
			{
				assetId: figureAssetId,
				kind: "figure",
				localId: figureLocalId(figureId),
				page,
				bbox: [0, 0, 1, 1],
			},
		];
		// Keep the original .vsdx once, on the first page.
		if (page === 1) {
			assets.push({
				assetId: nativeAssetId,
				kind: "native",
				localId: nativeId,
				page: 1,
				mimeType: vsdxMime,
				checksum: sha256Hex(buffer),
			});
		}

		records.push({
			type: "page",
			page,
			size: { wPt: 1, hPt: 1 },
			class: "drawing",
			summary,
			blocks: [figure],
			assets,
			warnings: page === 1 ? parsed.warnings : [],
			fidelity: {},
		});
	}

	return {
		records,
		nativeAssets: [
			{
				assetId: nativeAssetId,
				localId: nativeId,
				buffer,
				mimeType: vsdxMime,
			},
		],
		warnings: parsed.warnings,
	};
}

/** A short German summary of one Visio page's structured content. */
function summarizeVsdxPage(page: VsdxPage): string {
	if (page.transcription.format === "process") {
		const { nodes, edges } = page.transcription;
		return (
			`Visio-Flussdiagramm „${page.name}“ mit ${nodes.length} Shapes und ` +
			`${edges.length} Konnektoren.`
		);
	}
	const shapeCount = page.transcription.text
		.split("\n")
		.filter((line) => line.trim() !== "").length;
	return `Visio-Diagramm „${page.name}“ mit ${shapeCount} Shape-Texten.`;
}

/** Convert a native XLSX cell to the contract's {@link Cell} (string or object). */
function toContractCell(cell: XlsxCell): Cell {
	if (cell.colspan === undefined && cell.rowspan === undefined)
		return cell.text;
	return {
		text: cell.text,
		...(cell.colspan !== undefined ? { colspan: cell.colspan } : {}),
		...(cell.rowspan !== undefined ? { rowspan: cell.rowspan } : {}),
	};
}

/**
 * Build native table records for an XLSX workbook (requirement 10.2). Returns
 * one page per worksheet, each carrying a single `table` block, together with
 * the render decision. When {@link ParsedXlsx.needsRender} is true the caller
 * renders the workbook instead (the tables here are then not used); when false
 * these records are the whole document — no rendering, no model call.
 */
export function buildXlsxRecords(
	reference: string,
	parsed: ParsedXlsx,
): {
	records: PageRecord[];
	needsRender: boolean;
	renderReasons: string[];
	warnings: string[];
} {
	const records: PageRecord[] = [];
	let page = 0;
	for (const sheet of parsed.sheets) {
		page += 1;
		const rows = sheet.rows.map((row) => row.map(toContractCell));
		// Treat the first row as the header when the sheet has more than one row.
		const headerRows: Cell[][] =
			rows.length > 1 && rows[0] !== undefined ? [rows[0]] : [];
		const bodyRows = rows.length > 1 ? rows.slice(1) : rows;
		const tableId = `t${page}`;
		const table: TableBlock = {
			id: `p${page}-tb1`,
			page,
			type: "table",
			source: "native",
			tableId,
			headerRows,
			rows: bodyRows,
			caption: sheet.name,
		};
		records.push({
			type: "page",
			page,
			size: { wPt: 1, hPt: 1 },
			class: "text",
			summary: `Arbeitsblatt „${sheet.name}“ mit ${sheet.rows.length} Zeilen.`,
			blocks: [table],
			assets: [
				{
					assetId: buildAssetId(reference, pageLocalId(page)),
					kind: "page",
					localId: pageLocalId(page),
					page,
				},
			],
			warnings: [],
			fidelity: {},
		});
	}
	return {
		records,
		needsRender: parsed.needsRender,
		renderReasons: parsed.renderReasons,
		warnings: parsed.warnings,
	};
}

/**
 * A heading-level hint keyed by normalised heading text, for the document pass
 * to override its font-size guess with the DOCX's authoritative levels
 * (requirement 10.3).
 */
export interface DocxHeadingHints {
	/** Normalised heading text → level (1..9). */
	levelByText: Map<string, number>;
	headings: DocxHeading[];
	warnings: string[];
}

/** Normalise a heading's text for a hint-map key (case/space-insensitive). */
export function normalizeHeadingKey(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Extract DOCX heading-level hints from a `.docx` buffer (requirement 10.3).
 * The render path is unchanged; these hints AUGMENT the outline built during
 * the document pass.
 */
export function buildDocxHeadingHints(buffer: Uint8Array): DocxHeadingHints {
	const parsed: ParsedDocxHeadings = parseDocxHeadings(buffer);
	const levelByText = new Map<string, number>();
	for (const heading of parsed.headings) {
		levelByText.set(normalizeHeadingKey(heading.text), heading.level);
	}
	return { levelByText, headings: parsed.headings, warnings: parsed.warnings };
}

// ─── E-mail (EML) ─────────────────────────────────────────────────────────

export type { EmailAttachment, EmailMailbox, ParsedEmail } from "./eml.js";
export { htmlToText, parseEmail, stripQuotedReply } from "./eml.js";

/** The native records of one e-mail plus what the job needs beyond them. */
export interface EmailRecords extends NativeRecords {
	/** Threading headers for `document.begin.email`. */
	email: EmailHeaders;
	/** The subject, as the document title. */
	title: string;
	/** Attachments to ingest as documents of their own. */
	attachments: EmailAttachment[];
	/** Subject and own text: the input for the fingerprint and version detection. */
	text: string;
}

const FORWARD_SUBJECT = /^\s*(?:fw|fwd|wg|tr|vs|rv|enc|doorst)\s*:/i;

function formatMailbox(m: EmailMailbox): string {
	return m.name !== undefined ? `${m.name} <${m.address}>` : m.address;
}

/**
 * Build the single-page record of an e-mail. The page reads like the message
 * does: the subject as heading, a header paragraph (from, to, cc, date), the
 * message's own text — quoted history and signature removed, see
 * `stripQuotedReply` — and the attachment names. No render, no model call.
 *
 * A message without a Message-ID gets a stable synthetic one derived from its
 * bytes, so re-ingesting the same file threads and deduplicates the same way.
 */
export function buildEmailRecords(buffer: Uint8Array): EmailRecords {
	const parsed = parseEmail(buffer);
	const warnings = [...parsed.warnings];
	const subject = parsed.subject ?? "";
	const title = subject !== "" ? subject : "(ohne Betreff)";
	const own = stripQuotedReply(parsed.text, { isForward: FORWARD_SUBJECT.test(subject) });

	const blocks: Block[] = [];
	let n = 0;
	const id = (): string => `p1-b${++n}`;
	blocks.push({ id: id(), page: 1, type: "heading", level: 1, text: title, source: "native" });

	const headerLines = [
		parsed.from !== undefined ? `From: ${formatMailbox(parsed.from)}` : undefined,
		parsed.to.length > 0 ? `To: ${parsed.to.map(formatMailbox).join(", ")}` : undefined,
		parsed.cc.length > 0 ? `Cc: ${parsed.cc.map(formatMailbox).join(", ")}` : undefined,
		parsed.date !== undefined ? `Date: ${parsed.date.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC")}` : undefined,
	].filter((l): l is string => l !== undefined);
	if (headerLines.length > 0) {
		blocks.push({ id: id(), page: 1, type: "paragraph", text: headerLines.join("\n"), source: "native" });
	}

	for (const paragraph of own.text.split(/\n\s*\n/)) {
		const text = paragraph.trim();
		if (text !== "") blocks.push({ id: id(), page: 1, type: "paragraph", text, source: "native" });
	}

	const attachmentNames = parsed.attachments.map((a) => a.filename);
	if (attachmentNames.length > 0) {
		blocks.push({ id: id(), page: 1, type: "heading", level: 2, text: "Attachments", source: "native" });
		blocks.push({ id: id(), page: 1, type: "list", items: attachmentNames, source: "native" });
	}

	const record: PageRecord = {
		type: "page",
		page: 1,
		size: { wPt: 595, hPt: 842 },
		class: "text",
		blocks,
		assets: [],
		warnings,
	};

	const messageId = parsed.messageId ?? `sha256-${sha256Hex(buffer)}@atf-extract.invalid`;
	const email: EmailHeaders = {
		messageId,
		inReplyTo: parsed.inReplyTo,
		references: parsed.references,
		...(parsed.threadIndexRoot !== undefined ? { threadIndexRoot: parsed.threadIndexRoot } : {}),
		...(subject !== "" ? { subject } : {}),
		...(parsed.from !== undefined ? { from: parsed.from } : {}),
		to: parsed.to,
		cc: parsed.cc,
		...(parsed.date !== undefined ? { date: parsed.date } : {}),
		attachments: attachmentNames,
	};

	return {
		records: [record],
		nativeAssets: [],
		warnings,
		email,
		title,
		attachments: parsed.attachments,
		text: `${title}\n\n${own.text}`,
	};
}
