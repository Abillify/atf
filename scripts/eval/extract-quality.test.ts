// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Tests for the extraction-quality metrics (CER, Heading-F1, TEDS) and the
 * `extract-quality.ts` harness, including the shipped synthetic set whose
 * sample output carries deliberate defects: the pinned scores fail when the
 * scorer's behaviour drifts.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	cer,
	headingF1,
	levenshtein,
	matchTables,
	normaliseText,
	pooledCer,
	prf,
	teds,
	type Table,
} from "./extract-quality-metrics.js";
import {
	checkThresholds,
	parseExpected,
	parseManifest,
	parseProduced,
	renderMarkdown,
	run,
	scoreCase,
	summarise,
} from "./extract-quality.js";

const SET = "scripts/eval/quality-set/synthetic";
const table = (rows: string[][], headerRows: string[][] = []): Table => ({ headerRows, rows });

describe("CER", () => {
	test("levenshtein counts substitutions, insertions and deletions over code points", () => {
		expect(levenshtein("kitten", "sitting")).toBe(3);
		expect(levenshtein("", "abc")).toBe(3);
		expect(levenshtein("abc", "")).toBe(3);
		expect(levenshtein("Größe", "Grösse")).toBe(2);
		// One astral character is one unit, not two surrogates.
		expect(levenshtein("a😀b", "a😃b")).toBe(1);
	});

	test("normalises whitespace and Unicode form before comparing", () => {
		expect(normaliseText("  a \n\t b  ")).toBe("a b");
		expect(cer("Zeile eins\nZeile zwei", "Zeile   eins Zeile zwei").cer).toBe(0);
		// "ü" precomposed vs "u" + combining diaeresis is the same text.
		expect(cer("für", "fu\u0308r").cer).toBe(0);
	});

	test("is edits over reference length, and can exceed 1", () => {
		expect(cer("abcd", "abxd")).toEqual({ distance: 1, length: 4, cer: 0.25 });
		expect(cer("ab", "abcdefgh").cer).toBe(3);
		expect(cer("", "").cer).toBe(0);
		expect(cer("", "x").cer).toBe(1);
	});

	test("pools by total edits over total characters, not by averaging the cases", () => {
		const pooled = pooledCer([cer("abcd", "abxd"), cer("abcdefghij", "abcdefghij")]);
		expect(pooled).toEqual({ distance: 1, length: 14, cer: 0.071428571 });
	});

	test("refuses a text too long for one computation instead of hanging", () => {
		const long = "x".repeat(11_000);
		expect(() => cer(long, long)).toThrow(/page by page/);
	});
});

describe("Heading-F1", () => {
	const expected = [
		{ level: 1, text: "1 Einleitung" },
		{ level: 2, text: "1.1 Geltungsbereich" },
		{ level: 2, text: "1.2 Begriffe" },
	];

	test("is perfect for identical headings, ignoring case and spacing", () => {
		const got = [
			{ level: 1, text: "1  einleitung" },
			{ level: 2, text: "1.1 Geltungsbereich" },
			{ level: 2, text: "1.2 BEGRIFFE" },
		];
		expect(headingF1(expected, got, { matchLevel: true }).f1).toBe(1);
	});

	test("the strict variant punishes a wrong level, the loose one does not", () => {
		const got = [{ level: 1, text: "1 Einleitung" }, { level: 1, text: "1.1 Geltungsbereich" }, { level: 2, text: "1.2 Begriffe" }];
		expect(headingF1(expected, got, { matchLevel: false }).f1).toBe(1);
		const strict = headingF1(expected, got, { matchLevel: true });
		expect(strict).toMatchObject({ truePositives: 2, falsePositives: 1, falseNegatives: 1 });
		expect(strict.f1).toBe(0.666666667);
	});

	test("counts a missing heading as a miss and an invented one as a false positive", () => {
		const got = [{ level: 1, text: "1 Einleitung" }, { level: 3, text: "Nebenbei" }];
		expect(headingF1(expected, got, { matchLevel: false })).toMatchObject({
			truePositives: 1,
			falsePositives: 1,
			falseNegatives: 2,
		});
	});

	test("matches as a multiset: a repeated heading needs two matches", () => {
		const twice = [{ level: 2, text: "Zusammenfassung" }, { level: 2, text: "Zusammenfassung" }];
		expect(headingF1(twice, [twice[0] as (typeof twice)[number]], { matchLevel: true })).toMatchObject({
			truePositives: 1,
			falseNegatives: 1,
		});
	});

	test("nothing expected and nothing produced is a perfect score; nothing produced is zero", () => {
		expect(headingF1([], [], { matchLevel: true }).f1).toBe(1);
		expect(headingF1(expected, [], { matchLevel: true }).f1).toBe(0);
		expect(prf(0, 0, 0).f1).toBe(1);
	});
});

describe("TEDS", () => {
	const base = table([["a", "b"], ["c", "d"]]);

	test("is 1 for identical tables and ignores whitespace in cells", () => {
		expect(teds(base, base)).toBe(1);
		expect(teds(base, table([[" a", "b "], ["c", "d"]]))).toBe(1);
	});

	test("charges a wrong cell by its normalised edit distance over the tree size", () => {
		// 7 nodes (table, 2 tr, 4 td); one td "ab" vs "ax" costs 0.5.
		const left = table([["ab", "b"], ["c", "d"]]);
		const right = table([["ax", "b"], ["c", "d"]]);
		expect(teds(left, right)).toBe(0.928571429);
	});

	test("a missing row costs the row and its cells", () => {
		// 7 nodes against 4: deleting one tr and its two td costs 3.
		expect(teds(base, table([["a", "b"]]))).toBe(0.571428571);
	});

	test("a header split off the body counts as the same rows", () => {
		expect(teds(table([["x", "y"]], [["h1", "h2"]]), table([["h1", "h2"], ["x", "y"]]))).toBe(1);
	});

	test("structure-only ignores the text but still sees spans", () => {
		const wrongText = table([["q", "w"], ["e", "r"]]);
		expect(teds(base, wrongText, { structureOnly: true })).toBe(1);
		expect(teds(base, wrongText)).toBeLessThan(1);
		const merged: Table = { rows: [[{ text: "a", colspan: 2 }], ["c", "d"]] };
		expect(teds(base, merged, { structureOnly: true })).toBeLessThan(1);
	});

	test("is symmetric", () => {
		const other = table([["a", "x", "y"], ["c"]]);
		expect(teds(base, other)).toBe(teds(other, base));
	});

	test("an empty table against a real one is far from similar", () => {
		expect(teds(base, table([]))).toBe(0.142857143);
	});
});

describe("matchTables", () => {
	const first = table([["1", "2"]]);
	const second = table([["x", "y", "z"], ["u", "v", "w"]]);

	test("pairs each annotated table with its best produced table whatever the order", () => {
		const match = matchTables([first, second], [second, first]);
		expect(match.teds).toEqual([1, 1]);
		expect(match.extra).toBe(0);
	});

	test("an annotated table nothing matches scores 0, a produced extra is counted, not punished", () => {
		const none = matchTables([first], []);
		expect(none).toEqual({ teds: [0], tedsStructure: [0], extra: 0 });
		const extra = matchTables([first], [first, second]);
		expect(extra.teds).toEqual([1]);
		expect(extra.extra).toBe(1);
	});
});

describe("parseProduced", () => {
	test("reads running text, headings and tables from page records, skipping noise", () => {
		const lines = [
			JSON.stringify({ type: "document.begin", reference: "x" }),
			"not json",
			JSON.stringify({
				type: "page",
				page: 1,
				blocks: [
					{ type: "heading", level: 1, numbering: "2", text: "Betrieb" },
					{ type: "paragraph", text: "Text eins." },
					{ type: "list", items: ["a", "b"] },
					{ type: "table", headerRows: [["H"]], rows: [[{ text: "x", colspan: 2 }]] },
					{ type: "figure", description: "ignored" },
					{ type: "mystery" },
				],
			}),
			JSON.stringify({ type: "document.end", pageCount: 1 }),
		].join("\n");
		const pages = parseProduced(lines);
		expect([...pages.keys()]).toEqual([1]);
		const page = pages.get(1);
		expect(page?.text).toBe("2 Betrieb\nText eins.\na\nb");
		expect(page?.headings).toEqual([{ level: 1, text: "Betrieb" }]);
		expect(page?.tables).toEqual([{ headerRows: [["H"]], rows: [[{ text: "x", colspan: 2 }]] }]);
	});

	test("does not repeat a number the heading text already carries", () => {
		const record = JSON.stringify({
			type: "page",
			page: 1,
			blocks: [{ type: "heading", level: 2, numbering: "1.1", text: "1.1 Geltungsbereich" }],
		});
		expect(parseProduced(record).get(1)?.text).toBe("1.1 Geltungsbereich");
	});
});

describe("annotation validation", () => {
	test("rejects the mistakes a hand-written set is likely to contain", () => {
		expect(() => parseExpected({ pages: [] }, "a")).toThrow(/non-empty/);
		expect(() => parseExpected({ id: "b", pages: [{ page: 1 }] }, "a")).toThrow(/does not match/);
		expect(() => parseExpected({ pages: [{ page: 0 }] }, "a")).toThrow(/positive integer/);
		expect(() => parseExpected({ pages: [{ page: 1 }, { page: 1 }] }, "a")).toThrow(/twice/);
		expect(() => parseExpected({ pages: [{ page: 1, headings: [{ text: "x" }] }] }, "a")).toThrow(/heading/);
		expect(() => parseExpected({ pages: [{ page: 1, tables: [{ rows: [["x", 3]] }] }] }, "a")).toThrow(/cell/);
		expect(() => parseExpected({ pages: [{ page: 1, tables: [{ rows: [[{ text: "x", colspan: 0 }]] }] }] }, "a")).toThrow(/colspan/);
	});

	test("rejects an unsafe case id and an unknown kind", () => {
		const cases = [{ id: "../x" }];
		expect(() => parseManifest({ version: "1", kind: "synthetic", cases })).toThrow(/file-name-safe/);
		expect(() => parseManifest({ version: "1", kind: "secret", cases: [{ id: "x" }] })).toThrow(/kind/);
		expect(() => parseManifest({ version: "1", kind: "customer", cases: [{ id: "x" }, { id: "x" }] })).toThrow(/duplicate/);
	});
});

describe("scoreCase / summarise", () => {
	test("a page the extraction never produced scores as empty and is listed", () => {
		const expected = parseExpected(
			{ pages: [{ page: 1, text: "Eins", headings: [{ level: 1, text: "Eins" }] }, { page: 2, text: "Zwei" }] },
			"c",
		);
		const result = scoreCase(expected, parseProduced(JSON.stringify({ type: "page", page: 1, blocks: [{ type: "heading", level: 1, text: "Eins" }] })));
		expect(result.missingPages).toEqual([2]);
		expect(result.cer).toEqual({ distance: 4, length: 8, cer: 0.5 });
		expect(result.headings?.text.f1).toBe(1);
		expect(result.tables).toBeNull();
	});

	test("a metric a case does not annotate is not scored", () => {
		const result = scoreCase(parseExpected({ pages: [{ page: 1, text: "x" }] }, "c"), new Map());
		expect(result.headings).toBeNull();
		expect(result.tables).toBeNull();
		const summary = summarise([result]);
		expect(summary.headingF1).toBeNull();
		expect(summary.teds).toBeNull();
	});
});

describe("thresholds", () => {
	const summary = summarise([
		scoreCase(
			parseExpected({ pages: [{ page: 1, text: "abcd", headings: [{ level: 1, text: "a" }] }] }, "c"),
			parseProduced(JSON.stringify({ type: "page", page: 1, blocks: [{ type: "paragraph", text: "abxd" }] })),
		),
	]);

	test("report every bound that is missed and none that is met", () => {
		expect(checkThresholds(summary, { maxCer: 0.3, minHeadingF1: 0 })).toEqual([]);
		const failures = checkThresholds(summary, { maxCer: 0.1, minHeadingF1: 0.5 });
		expect(failures).toHaveLength(2);
		expect(failures[0]).toContain("CER 25.0 %");
	});

	test("do not gate a metric nothing annotated", () => {
		expect(checkThresholds(summary, { minTeds: 0.9 })).toEqual([]);
	});
});

describe("the shipped synthetic set", () => {
	test("is marked synthetic, every case has an annotation file and a sample output", async () => {
		const { report } = await run({ set: SET, out: "", label: "t", thresholds: {} });
		expect(report.set.kind).toBe("synthetic");
		expect(report.cases.map((c) => c.id)).toEqual(["anforderungen", "schnittstellen", "betriebshandbuch"]);
		expect(report.produced).toBe("produced-sample");
	});

	test("scores the sample output with the pinned defects", async () => {
		const { report } = await run({ set: SET, out: "", label: "t", thresholds: {} });
		const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
		// One OCR slip ("Lagerverwaltunq") in 472 characters of running text.
		expect(byId.anforderungen?.cer).toEqual({ distance: 1, length: 472, cer: 0.002118644 });
		// "1.1" produced as H1 and "2.2" merged into a paragraph: found by text, one wrong level, one missing.
		expect(byId.anforderungen?.headings?.text).toMatchObject({ truePositives: 4, falsePositives: 0, falseNegatives: 1 });
		expect(byId.anforderungen?.headings?.withLevel).toMatchObject({ truePositives: 3, falsePositives: 1, falseNegatives: 2 });
		// The merged header cell split in two and one misspelt cell: structure and text both off.
		const tables = byId.schnittstellen?.tables;
		expect(tables?.teds[0]).toBeLessThan(tables?.tedsStructure[0] ?? 0);
		expect(tables?.tedsStructure[0]).toBeLessThan(1);
		// Page 2 of the handbook was never produced.
		expect(byId.betriebshandbuch?.missingPages).toEqual([2]);
		expect(byId.betriebshandbuch?.tables?.teds).toEqual([0]);
	});

	test("the Markdown names the set and every case", async () => {
		const { report } = await run({ set: SET, out: "", label: "demo", thresholds: {} });
		const markdown = renderMarkdown(report);
		expect(markdown).toContain("# Extraction quality — demo");
		expect(markdown).toContain("synthetic v1.0.0");
		for (const id of ["anforderungen", "schnittstellen", "betriebshandbuch"]) expect(markdown).toContain(`| ${id} |`);
	});
});

describe("running against a set of your own", () => {
	async function makeSet(withProduced: boolean): Promise<{ dir: string; produced: string }> {
		const dir = await mkdtemp(join(tmpdir(), "atf-quality-"));
		await writeFile(
			join(dir, "manifest.json"),
			JSON.stringify({ version: "0.1.0", kind: "customer", cases: [{ id: "doc1" }] }),
		);
		await writeFile(join(dir, "doc1.expected.json"), JSON.stringify({ pages: [{ page: 1, text: "Hallo Welt" }] }));
		const produced = join(dir, "produced");
		if (withProduced) {
			await mkdir(produced);
			await writeFile(
				join(produced, "doc1.ndjson"),
				`${JSON.stringify({ type: "page", page: 1, blocks: [{ type: "paragraph", text: "Hallo Welt" }] })}\n`,
			);
		}
		return { dir, produced };
	}

	test("scores a customer set from --produced and gates on a bound", async () => {
		const { dir, produced } = await makeSet(true);
		try {
			const ok = await run({ set: dir, produced, out: "", label: "t", thresholds: { maxCer: 0.01 } });
			expect(ok.report.set.kind).toBe("customer");
			expect(ok.report.summary.cer?.cer).toBe(0);
			expect(ok.failures).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("without produced output the report says pending and a bound cannot pass silently", async () => {
		const { dir } = await makeSet(false);
		try {
			const pending = await run({ set: dir, out: "", label: "t", thresholds: {} });
			expect(pending.report.produced).toBeNull();
			expect(renderMarkdown(pending.report)).toContain("pending");
			const gated = await run({ set: dir, out: "", label: "t", thresholds: { maxCer: 0.1 } });
			expect(gated.failures[0]).toContain("no produced output");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a produced directory that does not exist is an error, not an empty result", async () => {
		const { dir } = await makeSet(false);
		try {
			await expect(run({ set: dir, produced: join(dir, "nope"), out: "", label: "t", thresholds: {} })).rejects.toThrow(/not found/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
