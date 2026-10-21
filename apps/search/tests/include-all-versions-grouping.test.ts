// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * With `include_all_versions` the revisions of one document must stay apart:
 * versioned rows share `base_ref` but carry the version in their `reference`
 * (`doc_v2`), so document grouping and diversification extend their keys by
 * the revision identity instead of merging the versions into one group.
 */
import { describe, expect, it } from "vitest";
import { groupResultsByDocument } from "../src/handlers/search.js";
import {
  diversifyResults,
  groupResultsV2,
  revisionIdentity,
} from "../src/rerank-context.js";
import type { SearchResult } from "../src/postgres-client.js";

const instant = new Date("2026-03-01T00:00:00.000Z");

/**
 * One hit of a versioned document: `base_ref` is shared by every revision,
 * the `reference` carries the version (`doc_v1_chunk_0`) like the versioning
 * upsert writes it.
 */
function hit(
	id: string,
	version: string,
	chunkIndex: number,
	score: number,
	extraMeta: Record<string, unknown> = {},
): SearchResult {
	return {
		id,
		score,
		content: `v${version} chunk ${chunkIndex}`,
		metadata: extraMeta,
		reference: `doc_v${version}_chunk_${chunkIndex}`,
		base_ref: "doc",
		chunk: { chunk_index: chunkIndex, chunk_total: 4 } as never,
		created: instant,
		modified: instant,
		valid_from: null,
		effective_valid_from: instant,
	};
}

describe("revisionIdentity", () => {
	it("strips the chunk suffix so all chunks of one revision share it", () => {
		expect(revisionIdentity(hit("a", "1", 0, 1))).toBe("doc_v1");
		expect(revisionIdentity(hit("b", "2", 3, 1))).toBe("doc_v2");
	});

	it("leaves references without a chunk suffix untouched", () => {
		const r = hit("c", "1", 0, 1);
		expect(revisionIdentity({ ...r, reference: "doc_v1" })).toBe("doc_v1");
	});
});

describe("groupResultsByDocument · include_all_versions", () => {
	const results = [
		hit("a", "2", 0, 9),
		hit("b", "2", 1, 8),
		hit("c", "1", 0, 7),
		hit("d", "1", 1, 6),
	];

	it("merges all revisions into one group by default", () => {
		const docs = groupResultsByDocument(results);
		expect(docs).toHaveLength(1);
		expect(docs[0]?.content).toContain("v1 chunk 0");
		expect(docs[0]?.content).toContain("v2 chunk 0");
	});

	it("keeps the revisions of one document in separate groups when set", () => {
		const docs = groupResultsByDocument(results, 8, true);
		expect(docs).toHaveLength(2);
		const byRef = new Map(docs.map((d) => [d.reference, d]));
		expect(byRef.get("doc_v2_chunk_0")?.content).toBe(
			"v2 chunk 0\nv2 chunk 1",
		);
		expect(byRef.get("doc_v1_chunk_0")?.content).toBe(
			"v1 chunk 0\nv1 chunk 1",
		);
		// Each group scores with its own best chunk, not the global best.
		expect(byRef.get("doc_v2_chunk_0")?.score).toBe(9);
		expect(byRef.get("doc_v1_chunk_0")?.score).toBe(7);
	});

	it("still applies the chunk cap per revision", () => {
		const many = Array.from({ length: 10 }, (_, i) =>
			hit(`x${i}`, "1", i, i + 1),
		).concat(Array.from({ length: 2 }, (_, i) => hit(`y${i}`, "2", i, 100)));
		const docs = groupResultsByDocument(many, 4, true);
		expect(docs).toHaveLength(2);
		const v1 = docs.find((d) => revisionIdentity(d) === "doc_v1");
		expect(v1?.truncated).toBe(true);
		expect(v1?.omitted_chunks).toBe(6);
		const v2 = docs.find((d) => revisionIdentity(d) === "doc_v2");
		expect(v2?.truncated).toBeUndefined();
	});
});

describe("diversifyResults · include_all_versions", () => {
	it("collapses same table_id across revisions by default", () => {
		const results = [
			hit("a", "2", 0, 9, { table_id: "t1" }),
			hit("b", "1", 0, 8, { table_id: "t1" }),
		];
		expect(diversifyResults(results)).toHaveLength(1);
	});

	it("keeps one representative per revision when set", () => {
		const results = [
			hit("a", "2", 0, 9, { table_id: "t1" }),
			hit("b", "1", 0, 8, { table_id: "t1" }),
		];
		const out = diversifyResults(results, { includeAllVersions: true });
		expect(out).toHaveLength(2);
	});

	it("caps hits per section within each revision when set", () => {
		const section = { section_path: ["1", "Einleitung"] };
		const results = [
			hit("a", "2", 0, 9, section),
			hit("b", "2", 1, 8, section),
			hit("c", "1", 0, 7, section),
			hit("d", "1", 1, 6, section),
		];
		const capped = diversifyResults(results, {
			perSectionCap: 1,
			includeAllVersions: true,
		});
		// One hit per section per revision — the cap no longer spans versions.
		expect(capped).toHaveLength(2);
		expect(capped.map((r) => revisionIdentity(r))).toEqual([
			"doc_v2",
			"doc_v1",
		]);
		const withoutFlag = diversifyResults(results, { perSectionCap: 1 });
		expect(withoutFlag).toHaveLength(1);
	});
});

describe("groupResultsV2 · include_all_versions", () => {
	it("groups revisions of one document together by default", () => {
		const grouped = groupResultsV2(
			[hit("a", "2", 0, 9), hit("b", "1", 0, 8)],
			"document",
		);
		expect(grouped).toHaveLength(1);
		expect(grouped[0]?.group.count).toBe(2);
	});

	it("splits the revisions into separate groups when set", () => {
		const grouped = groupResultsV2(
			[hit("a", "2", 0, 9), hit("b", "1", 0, 8)],
			"document",
			true,
		);
		expect(grouped).toHaveLength(2);
		expect(grouped.every((g) => g.group.count === 1)).toBe(true);
	});
});
