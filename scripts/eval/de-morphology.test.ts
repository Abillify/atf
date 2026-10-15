// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The German morphology variant set (golden-set/de-morphology.v1.json):
 * structural validity, and that every variant really differs from the corpus
 * wording — otherwise it would pass under FTS_LANGUAGE=simple and measure
 * nothing.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
	expandVariantSet,
	loadGoldenSet,
	type GoldenSet,
	type VariantSet,
} from "./golden-set.ts";

const DIR = resolve(import.meta.dir, "golden-set");
const VARIANTS = resolve(DIR, "de-morphology.v1.json");

/** Content words (≥ 5 letters, lower-cased) of a text. */
function contentWords(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/[a-zäöüß]{5,}/g) ?? []).filter(
			(w) => !["welche", "welcher", "welches", "werden", "wird"].includes(w),
		),
	);
}

describe("de-morphology variant set", () => {
	test("expands into a golden set answered by the base questions", async () => {
		const set = await loadGoldenSet(VARIANTS);
		const base = await loadGoldenSet(resolve(DIR, "golden-set.v1.json"));
		expect(set.questions.length).toBeGreaterThanOrEqual(30);
		expect(set.documents).toEqual(base.documents);
		const raw = JSON.parse(readFileSync(VARIANTS, "utf8")) as VariantSet;
		for (const [i, q] of set.questions.entries()) {
			const source = base.questions.find((b) => b.id === raw.variants[i]?.base);
			expect(q.expectedPages).toEqual(source?.expectedPages ?? []);
			expect(q.document).toBe(source?.document ?? "");
		}
	});

	test("covers every phenomenon and every document", () => {
		const raw = JSON.parse(readFileSync(VARIANTS, "utf8")) as VariantSet;
		const phenomena = new Set(raw.variants.flatMap((v) => v.phenomena));
		expect([...phenomena].sort()).toEqual(["compound", "derivation", "inflection"]);
	});

	test("each variant drops at least one content word of its base, so exact matching cannot answer it", async () => {
		const base = await loadGoldenSet(resolve(DIR, "golden-set.v1.json"));
		const corpus = readdirSync(resolve(DIR, "corpus"))
			.filter((f) => f.endsWith(".md"))
			.map((f) => readFileSync(resolve(DIR, "corpus", f), "utf8"))
			.join("\n")
			.toLowerCase();
		const raw = JSON.parse(readFileSync(VARIANTS, "utf8")) as VariantSet;
		for (const v of raw.variants) {
			const source = base.questions.find((q) => q.id === v.base);
			const baseWords = contentWords(source?.question ?? "");
			const variantWords = contentWords(v.question);
			const reworded = [...baseWords].filter((w) => !variantWords.has(w));
			expect({ id: v.id, reworded: reworded.length > 0 }).toEqual({ id: v.id, reworded: true });
			// The variant as a whole is not a verbatim corpus sentence.
			expect(corpus.includes(v.question.toLowerCase())).toBe(false);
		}
	});

	test("rejects an unknown base or an unchanged question", () => {
		const base: GoldenSet = {
			version: "1",
			documents: [{ id: "d", reference: "/d", kind: "docx", title: "D", pages: 1 }] as GoldenSet["documents"],
			questions: [{ id: "q", document: "d", question: "Wie?", expectedPages: [1], expectedFigures: [], expectedCells: [] }],
		};
		const variants = (question: string, b = "q"): VariantSet => ({
			version: "1",
			baseFixture: "x",
			variants: [{ id: "v", base: b, phenomena: ["inflection"], question }],
		});
		expect(() => expandVariantSet(variants("Wie?"), base)).toThrow(/re-phrasing/);
		expect(() => expandVariantSet(variants("Wozu?", "nope"), base)).toThrow(/unknown base/);
		expect(expandVariantSet(variants("Wozu?"), base).questions[0]?.expectedPages).toEqual([1]);
	});
});
