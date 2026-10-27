// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseDocxHeadings } from "../src/pipeline/native/docx-headings.js";
import {
	buildDocxHeadingHints,
	normalizeHeadingKey,
} from "../src/pipeline/native/index.js";

/**
 * Build a minimal DOCX (a ZIP with `word/styles.xml` and `word/document.xml`).
 * The styles declare heading levels two ways — an explicit `w:outlineLvl` and a
 * `Heading N` style name — so both derivation paths are exercised.
 */
function buildDocx(): Uint8Array {
	const styles = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Ueberschrift3">
    <w:name w:val="Heading 3"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`;

	const document = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Antragseingang</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Ein Absatz.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Anmeldung</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Ueberschrift3"/></w:pPr><w:r><w:t xml:space="preserve">Maske </w:t></w:r><w:r><w:t>WE01</w:t></w:r></w:p>
  </w:body>
</w:document>`;

	return zipSync({
		"[Content_Types].xml": strToU8("<Types/>"),
		"word/styles.xml": strToU8(styles),
		"word/document.xml": strToU8(document),
	});
}

describe("parseDocxHeadings", () => {
	it("derives heading levels from styles (outlineLvl and Heading N name)", () => {
		const { headings, styleLevels, warnings } = parseDocxHeadings(buildDocx());
		expect(warnings).toEqual([]);

		expect(headings).toEqual([
			{ text: "Antragseingang", level: 1 },
			{ text: "Anmeldung", level: 2 },
			{ text: "Maske WE01", level: 3 },
		]);

		// The style map carries the derived levels for a style-keyed consumer.
		expect(styleLevels.Heading1).toBe(1);
		expect(styleLevels.Heading2).toBe(2);
		expect(styleLevels.Ueberschrift3).toBe(3);
	});

	it("ignores non-heading paragraphs", () => {
		const { headings } = parseDocxHeadings(buildDocx());
		expect(headings.some((h) => /Absatz/.test(h.text))).toBe(false);
	});

	it("warns and returns empty when the bytes are not a ZIP", () => {
		const { headings, warnings } = parseDocxHeadings(
			new TextEncoder().encode("not a docx"),
		);
		expect(headings).toEqual([]);
		expect(warnings.length).toBeGreaterThan(0);
	});
});

describe("buildDocxHeadingHints", () => {
	it("keys authoritative levels by normalised heading text", () => {
		const hints = buildDocxHeadingHints(buildDocx());
		expect(hints.levelByText.get(normalizeHeadingKey("Antragseingang"))).toBe(1);
		expect(hints.levelByText.get(normalizeHeadingKey("  ANMELDUNG "))).toBe(2);
		expect(hints.levelByText.get(normalizeHeadingKey("Maske WE01"))).toBe(3);
	});
});
