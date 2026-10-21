// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `group_by_document` must bound the merged context: only the best-scoring
 * `maxChunksPerDocument` chunks of a document survive, the merged result says
 * so via `truncated` / `omitted_chunks`, and the cap applies per document.
 */
import { describe, expect, it } from "vitest";
import { groupResultsByDocument } from "../src/handlers/search.js";
import type { SearchResult } from "../src/postgres-client.js";

const instant = new Date("2026-03-01T00:00:00.000Z");

function chunk(
	id: string,
	index: number,
	score: number,
	baseRef = "doc",
): SearchResult {
	return {
		id,
		score,
		content: `text ${index}`,
		metadata: {},
		reference: `${baseRef}#${index}`,
		base_ref: baseRef,
		chunk: { chunk_index: index, chunk_total: 20 } as never,
		created: instant,
		modified: instant,
		valid_from: null,
		effective_valid_from: instant,
	};
}

describe("groupResultsByDocument · chunk cap per document", () => {
	it("keeps the best-scoring chunks and reports the omission", () => {
		// 20 chunks of one document; scores 1..20 so the top 8 are indices 12..19.
		const results = Array.from({ length: 20 }, (_, i) =>
			chunk(`c${i}`, i, i + 1),
		);

		const docs = groupResultsByDocument(results, 8);

		expect(docs).toHaveLength(1);
		const doc = docs[0];
		expect(doc?.truncated).toBe(true);
		expect(doc?.omitted_chunks).toBe(12);
		// The eight best-scoring chunks (indices 12..19) survived, merged in
		// document (chunk_index) order, not score order.
		const expectedContent = Array.from(
			{ length: 8 },
			(_, i) => `text ${i + 12}`,
		).join("\n");
		expect(doc?.content).toBe(expectedContent);
		// The document score stays the best chunk score of the whole document.
		expect(doc?.score).toBe(20);
	});

	it("does not mark a document that fits under the cap", () => {
		const results = [chunk("c0", 0, 3), chunk("c1", 1, 2), chunk("c2", 2, 1)];

		const docs = groupResultsByDocument(results, 8);

		expect(docs).toHaveLength(1);
		const doc = docs[0];
		expect(doc?.truncated).toBeUndefined();
		expect(doc?.omitted_chunks).toBeUndefined();
		expect(doc?.content).toBe("text 0\ntext 1\ntext 2");
	});

	it("applies the cap to every document on its own", () => {
		const big = Array.from({ length: 20 }, (_, i) =>
			chunk(`a${i}`, i, i + 1, "doc-a"),
		);
		const small = [
			chunk("b0", 0, 5, "doc-b"),
			chunk("b1", 1, 4, "doc-b"),
			chunk("b2", 2, 3, "doc-b"),
		];

		const docs = groupResultsByDocument([...big, ...small], 8);

		expect(docs).toHaveLength(2);
		const docA = docs.find((d) => d.base_ref === "doc-a");
		const docB = docs.find((d) => d.base_ref === "doc-b");
		expect(docA?.truncated).toBe(true);
		expect(docA?.omitted_chunks).toBe(12);
		expect(docA?.content).toBe(
			Array.from({ length: 8 }, (_, i) => `text ${i + 12}`).join("\n"),
		);
		// The small document is untouched even though the big one was cut.
		expect(docB?.truncated).toBeUndefined();
		expect(docB?.omitted_chunks).toBeUndefined();
		expect(docB?.content).toBe("text 0\ntext 1\ntext 2");
	});

	it("defaults the cap to 8 chunks", () => {
		const results = Array.from({ length: 20 }, (_, i) =>
			chunk(`c${i}`, i, i + 1),
		);

		const docs = groupResultsByDocument(results);

		expect(docs).toHaveLength(1);
		expect(docs[0]?.truncated).toBe(true);
		expect(docs[0]?.omitted_chunks).toBe(12);
	});
});
