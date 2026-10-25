// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/docx-headings.ts
 *
 * Authoritative heading levels straight from a DOCX's styles.
 *
 * ## Why read the styles at all
 *
 * A DOCX still routes through LibreOffice → PDF for pagination and rendering —
 * a Word document has no pages until it is laid out (see `office.ts`). But the
 * *outline* the streaming document pass builds from a rasterised page has to
 * guess a heading's level from font size, whereas the DOCX already carries the
 * author's own answer: paragraphs reference a style, and the style declares an
 * outline level (`w:outlineLvl`) or is named `Heading N`. Reading that gives the
 * outline an authoritative heading-level for each heading's text, so this
 * AUGMENTS the render path rather than replacing it — the render still produces
 * the pages; the style read tells the outline which level each heading really is.
 *
 * ## What it returns
 *
 * A list of `{ text, level }` in document order — the heading paragraphs, with
 * levels 1..9 derived from the styles. The document pass keys these by
 * normalised heading text to override the height-based level guess. Deterministic,
 * no model, no rendering.
 */

import { strFromU8, unzipSync } from "fflate";
import { ExtractError } from "../../errors.js";
import { safeXmlParser } from "../safe-xml.js";
import { assertZipWithinLimits, type ZipLimits } from "./zip-guard.js";

/** A heading paragraph with its authoritative level from the DOCX styles. */
export interface DocxHeading {
	/** The heading paragraph's visible text, whitespace-normalised. */
	text: string;
	/** 1-based outline level derived from the referenced style (clamped 1..9). */
	level: number;
}

/** The parsed style/heading result plus any tolerant-recovery warnings. */
export interface ParsedDocxHeadings {
	/** Heading paragraphs in document order. */
	headings: DocxHeading[];
	/** styleId → level, for a consumer that keys on the style rather than text. */
	styleLevels: Record<string, number>;
	warnings: string[];
}

const parser = safeXmlParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  // Do NOT trim: a run's text may carry a significant leading/trailing space
  // (`<w:t xml:space="preserve">Maske </w:t>`) that separates two runs of one
  // heading. `paragraphText` normalises whitespace on the concatenated result.
  trimValues: false,
  removeNSPrefix: true,
});

function asArray(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function attr(node: unknown, name: string): string | undefined {
	if (typeof node !== "object" || node === null) return undefined;
	const value = (node as Record<string, unknown>)[`@_${name}`];
	return typeof value === "string" ? value : undefined;
}

/**
 * The `w:val` of a child element, e.g. `<w:outlineLvl w:val="1"/>` →
 * `"1"`. fast-xml-parser represents a childless element as an object carrying
 * only its attributes.
 */
function childVal(
	parent: Record<string, unknown>,
	child: string,
): string | undefined {
	const node = parent[child];
	if (Array.isArray(node)) return attr(node[0], "val");
	return attr(node, "val");
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level)) return 1;
	return Math.min(9, Math.max(1, Math.round(level)));
}

/**
 * Derive a heading level from a style name/id when there is no explicit
 * `outlineLvl`. `Heading 2`, `heading2`, `berschrift 2` (Überschrift, prefix
 * stripped by NS handling) and `Title` all map to a level; anything else is not
 * a heading style.
 */
function levelFromStyleName(name: string): number | undefined {
	const lower = name.toLowerCase();
	if (/^title$|titel/.test(lower)) return 1;
	const match =
		/(?:heading|überschrift|uberschrift|berschrift|titre|encabezado)\s*[- ]?(\d+)/.exec(
			lower,
		);
	if (match?.[1] !== undefined) return clampLevel(Number(match[1]));
	return undefined;
}

/**
 * Build the styleId → level map from `word/styles.xml`. A paragraph style is a
 * heading when it declares `w:outlineLvl` (0-based, so +1) or its name/id names
 * a heading. Both the styleId and the (normalised) style name are keyed so a
 * document.xml paragraph referencing either resolves.
 */
function parseStyleLevels(stylesXml: string): {
	byId: Map<string, number>;
	byName: Map<string, number>;
} {
	const byId = new Map<string, number>();
	const byName = new Map<string, number>();
	let doc: Record<string, unknown>;
	try {
		doc = parser.parse(stylesXml) as Record<string, unknown>;
	} catch {
		return { byId, byName };
	}
	const styles = doc.styles;
	if (typeof styles !== "object" || styles === null) return { byId, byName };
	for (const raw of asArray((styles as Record<string, unknown>).style)) {
		if (typeof raw !== "object" || raw === null) continue;
		const style = raw as Record<string, unknown>;
		if (
			attr(style, "type") !== undefined &&
			attr(style, "type") !== "paragraph"
		)
			continue;
		const styleId = attr(style, "styleId");
		// Explicit outline level wins: `w:outlineLvl` is 0-based in the pPr.
		const pPr = style.pPr;
		let level: number | undefined;
		if (typeof pPr === "object" && pPr !== null) {
			const outline = childVal(pPr as Record<string, unknown>, "outlineLvl");
			if (outline !== undefined && outline !== "")
				level = clampLevel(Number(outline) + 1);
		}
		const nameVal = childVal(style, "name");
		if (level === undefined && nameVal !== undefined)
			level = levelFromStyleName(nameVal);
		if (level === undefined && styleId !== undefined)
			level = levelFromStyleName(styleId);
		if (level === undefined) continue;
		if (styleId !== undefined) byId.set(styleId, level);
		if (nameVal !== undefined) byName.set(nameVal.toLowerCase(), level);
	}
	return { byId, byName };
}

/** Concatenate the visible text of a `w:p` paragraph from its `w:t` runs. */
function paragraphText(paragraph: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const run of asArray(paragraph.r)) {
		if (typeof run !== "object" || run === null) continue;
		for (const t of asArray((run as Record<string, unknown>).t)) {
			if (typeof t === "string" || typeof t === "number") parts.push(String(t));
			else if (typeof t === "object" && t !== null) {
				const text = (t as Record<string, unknown>)["#text"];
				if (typeof text === "string" || typeof text === "number")
					parts.push(String(text));
			}
		}
	}
	return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * Walk `word/document.xml` in order, emitting a {@link DocxHeading} for every
 * paragraph whose `pStyle` resolves to a heading level in the style map.
 */
function parseDocumentHeadings(
	documentXml: string,
	levels: { byId: Map<string, number>; byName: Map<string, number> },
): DocxHeading[] {
	const headings: DocxHeading[] = [];
	let doc: Record<string, unknown>;
	try {
		doc = parser.parse(documentXml) as Record<string, unknown>;
	} catch {
		return headings;
	}
	const documentNode = doc.document;
	if (typeof documentNode !== "object" || documentNode === null)
		return headings;
	const body = (documentNode as Record<string, unknown>).body;
	if (typeof body !== "object" || body === null) return headings;

	for (const raw of asArray((body as Record<string, unknown>).p)) {
		if (typeof raw !== "object" || raw === null) continue;
		const paragraph = raw as Record<string, unknown>;
		const pPr = paragraph.pPr;
		if (typeof pPr !== "object" || pPr === null) continue;
		const styleId = childVal(pPr as Record<string, unknown>, "pStyle");
		if (styleId === undefined) continue;
		const level =
			levels.byId.get(styleId) ?? levels.byName.get(styleId.toLowerCase());
		if (level === undefined) continue;
		const text = paragraphText(paragraph);
		if (text === "") continue;
		headings.push({ text, level });
	}
	return headings;
}

/**
 * Read heading levels from a DOCX's `word/styles.xml` and `word/document.xml`
 * Never throws — a DOCX that is not a ZIP, or is missing
 * either part, yields an empty result with a warning, so the outline simply
 * falls back to its font-size heuristic — except for a ZIP-guard violation
 * (`DOCUMENT_TOO_COMPLEX`), which rejects instead.
 */
export function parseDocxHeadings(
  buffer: Uint8Array,
  limits?: ZipLimits,
): ParsedDocxHeadings {
  const warnings: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    // Checked before any inflation; a limit violation
    // throws ExtractError and is re-thrown below, never downgraded.
    assertZipWithinLimits(buffer, limits);
    // Only the two parts we need; skip the rest to keep memory bounded.
    entries = unzipSync(buffer, {
      filter: (file) =>
        file.name === "word/styles.xml" || file.name === "word/document.xml",
    });
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    warnings.push(
      `Das DOCX konnte nicht entpackt werden: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { headings: [], styleLevels: {}, warnings };
  }

  const stylesBytes = entries["word/styles.xml"];
  const documentBytes = entries["word/document.xml"];
  if (documentBytes === undefined) {
    warnings.push(
      "word/document.xml fehlt im DOCX; keine Überschriftenebenen.",
    );
    return { headings: [], styleLevels: {}, warnings };
  }

  const levels =
    stylesBytes !== undefined
      ? parseStyleLevels(strFromU8(stylesBytes))
      : { byId: new Map<string, number>(), byName: new Map<string, number>() };
  if (stylesBytes === undefined) {
    warnings.push("word/styles.xml fehlt im DOCX; Ebenen nur aus Stilnamen.");
  }

  const headings = parseDocumentHeadings(strFromU8(documentBytes), levels);
  const styleLevels: Record<string, number> = {};
  for (const [id, level] of levels.byId) styleLevels[id] = level;

  return { headings, styleLevels, warnings };
}
