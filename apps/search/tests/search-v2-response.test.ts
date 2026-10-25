// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// apps/search/tests/search-v2-response.test.ts
//
// Pure tests for the v2 response shaper: the hit shape, asset
// coverage/modes, navigation, pages, and section_path extraction. No DB.

import { describe, it, expect } from "vitest";
import {
	shapeHitV2,
	buildAssets,
	navigationOf,
	pagesOf,
	sectionPathArray,
	referencedFigureIds,
	assetUrl,
} from "../src/search-v2-response.js";
import type { SearchResult, FigureUnitInfo } from "../src/postgres-client.js";
import type { ExpandedSearchResult } from "../src/handlers/expand-results.js";

function fig(): SearchResult {
	return {
		id: "1",
		score: 0.9,
		content: "Maske WE01\nweitere Beschreibung",
		metadata: {
			unit_id: "u1",
			unit_type: "figure",
			section_path: ["4", "4.2"],
			page_start: 37,
			page_end: 37,
			figure_id: "f1",
			figure_kind: "ui_mask",
			asset_id: "a1",
			prev_unit_id: "p",
			next_unit_id: "n",
			parent_unit_id: "par",
			section_id: "s1",
		},
		evidence: {
			reference: "d#u1",
			root_document_id: "d",
			page_start: 37,
			page_end: 37,
			section_path: ["4", "4.2"],
			figure_id: "f1",
			asset_id: "a1",
			bbox: [0, 0, 1, 1],
		},
		reference: "d#u1",
		base_ref: "d",
		title: "Maske WE01",
		created: new Date(),
		modified: new Date(),
	} as unknown as SearchResult;
}

function chunkWithRefs(): SearchResult {
	return {
		id: "2",
		score: 0.7,
		content: "Text [Abbildung f1].",
		metadata: {
			unit_id: "u2",
			unit_type: "chunk",
			section_path: ["4", "4.2"],
			page_start: 37,
			page_end: 38,
			next_unit_id: "u3",
			section_id: "s1",
		},
		evidence: {
			reference: "d#u2",
			root_document_id: "d",
			page_start: 37,
			page_end: 38,
			section_path: ["4", "4.2"],
			figure_refs: [{ figure_id: "f1", asset_id: "a1" }],
			asset_ids: ["a1"],
		},
		reference: "d#u2",
		base_ref: "d",
		created: new Date(),
		modified: new Date(),
	} as unknown as SearchResult;
}

describe("assetUrl", () => {
	it("builds the /v2/assets URL with collection + variant", () => {
		expect(assetUrl("a 1", "docs", "thumb")).toBe(
			"/v2/assets/a%201?collection=docs&variant=thumb",
		);
	});
});

describe("sectionPathArray / pagesOf / navigationOf", () => {
	it("extracts section_path as a string array", () => {
		expect(sectionPathArray(fig())).toEqual(["4", "4.2"]);
	});
	it("extracts a page range, defaulting end to start", () => {
		expect(pagesOf(fig())).toEqual({ start: 37, end: 37 });
		expect(pagesOf(chunkWithRefs())).toEqual({ start: 37, end: 38 });
	});
	it("returns null pages when unknown", () => {
		const r = {
			...fig(),
			evidence: undefined,
			metadata: {},
		} as unknown as SearchResult;
		expect(pagesOf(r)).toBeNull();
	});
	it("extracts only the present navigation links", () => {
		expect(navigationOf(chunkWithRefs())).toEqual({
			next: "u3",
			next_unit_id: "u3",
			section_id: "s1",
		});
	});
});

describe("buildAssets", () => {
	it("refs mode: ids only, no URLs", () => {
		const assets = buildAssets(chunkWithRefs(), new Map(), "docs", "refs");
		expect(assets).toHaveLength(1);
		expect(assets[0]).toMatchObject({ asset_id: "a1", relation: "referenced" });
		expect(assets[0].url).toBeUndefined();
		expect(assets[0].thumb_url).toBeUndefined();
	});

	it("thumbnails mode: hit figure carries kind/figure_kind/caption/page/bbox + URLs", () => {
		const assets = buildAssets(fig(), new Map(), "docs", "thumbnails");
		expect(assets).toHaveLength(1);
		expect(assets[0]).toMatchObject({
			asset_id: "a1",
			relation: "hit",
			kind: "figure",
			figure_kind: "ui_mask",
			caption: "Maske WE01",
			page: 37,
			bbox: [0, 0, 1, 1],
		});
		expect(assets[0].thumb_url).toContain("variant=thumb");
		expect(assets[0].url).toContain("variant=full");
	});

	it("dedupes an asset that is both the hit figure and in figure_refs", () => {
		const r = fig();
		(r.evidence as { figure_refs?: unknown }).figure_refs = [
			{ figure_id: "f1", asset_id: "a1" },
		];
		const assets = buildAssets(r, new Map(), "docs", "refs");
		expect(assets).toHaveLength(1);
		expect(assets[0].relation).toBe("hit");
	});

	it("enriches a referenced figure from the resolved figureInfo", () => {
		const info = new Map<string, FigureUnitInfo>([
			[
				"f1",
				{
					figure_id: "f1",
					asset_id: "a1",
					figure_kind: "bpmn",
					caption: "Prozess",
					page: 40,
					bbox: [1, 1, 2, 2],
				},
			],
		]);
		const assets = buildAssets(chunkWithRefs(), info, "docs", "thumbnails");
		expect(assets[0]).toMatchObject({
			figure_kind: "bpmn",
			caption: "Prozess",
			page: 40,
			bbox: [1, 1, 2, 2],
		});
	});
});

describe("referencedFigureIds", () => {
	it("collects distinct referenced figure ids", () => {
		expect(referencedFigureIds([chunkWithRefs(), fig()])).toEqual(["f1"]);
	});
});

describe("shapeHitV2", () => {
	it("produces the full v2 hit shape with expanded passthrough", () => {
		const r: ExpandedSearchResult = {
			...chunkWithRefs(),
			expanded: {
				mode: "section",
				content: "…",
				unit_count: 2,
				budget_chars: 4000,
				truncated: false,
			},
		};
		const hit = shapeHitV2(r, {
			collection: "docs",
			includeAssets: "refs",
			figureInfo: new Map(),
		});
		expect(hit).toMatchObject({
			score: 0.7,
			unit_id: "u2",
			unit_type: "chunk",
			reference: "d#u2",
			base_ref: "d",
			section_path: ["4", "4.2"],
			pages: { start: 37, end: 38 },
		});
		expect(hit.expanded).toMatchObject({ mode: "section", truncated: false });
		expect(hit.assets).toHaveLength(1);
		expect(hit.navigation).toMatchObject({
			next_unit_id: "u3",
			section_id: "s1",
		});
		expect(hit.evidence).toBeTruthy();
	});

	it("omits assets entirely for include_assets=none", () => {
		const hit = shapeHitV2(chunkWithRefs(), {
			collection: "docs",
			includeAssets: "none",
			figureInfo: new Map(),
		});
		expect(hit.assets).toBeUndefined();
	});
});

describe("shapeHitV2 · design §7.2 field coverage", () => {
	it("carries every §7.2 field: unit/score/reference/title/section_path/pages/content/expanded/assets/navigation/evidence", () => {
		const r: ExpandedSearchResult = {
			...fig(),
			metadata: { ...fig().metadata, block_ids: ["p37-b4", "p37-b5"] },
			evidence: { ...fig().evidence, chunk_id: "c-1", char_start: 0 },
			expanded: {
				mode: "section",
				content: "ctx",
				unit_count: 1,
				budget_chars: 4000,
				truncated: true,
			},
		} as unknown as ExpandedSearchResult;
		const hit = shapeHitV2(r, {
			collection: "docs",
			includeAssets: "thumbnails",
			figureInfo: new Map(),
		});
		expect(hit).toMatchObject({
			unit_id: "u1",
			unit_type: "figure",
			score: 0.9,
			reference: "d#u1",
			title: "Maske WE01",
			section_path: ["4", "4.2"],
			pages: { start: 37, end: 37 },
			content: "Maske WE01\nweitere Beschreibung",
			expanded: { mode: "section", content: "ctx", truncated: true },
			navigation: { prev: "p", next: "n", section_id: "s1" },
			evidence: { chunk_id: "c-1", block_ids: ["p37-b4", "p37-b5"], char_start: 0 },
		});
		const asset = hit.assets?.[0];
		expect(asset).toMatchObject({
			asset_id: "a1",
			kind: "figure",
			figure_kind: "ui_mask",
			caption: "Maske WE01",
			page: 37,
			bbox: [0, 0, 1, 1],
		});
		expect(asset?.thumb_url).toContain("variant=thumb");
		expect(asset?.url).toContain("variant=full");
	});

	it("keeps evidence.block_ids from the chunk evidence when present", () => {
		const r = {
			...fig(),
			metadata: { ...fig().metadata, block_ids: ["meta-b"] },
			evidence: { ...fig().evidence, block_ids: ["ev-b"] },
		} as unknown as SearchResult;
		const hit = shapeHitV2(r, { collection: "docs", includeAssets: "none", figureInfo: new Map() });
		expect(hit.evidence?.block_ids).toEqual(["ev-b"]);
	});

	it("mirrors figure_id/asset_id/modality from metadata for v2 units without chunk evidence", () => {
    // v2 batch-worker rows keep figure coordinates in metadata only (no
    // legacy `chunk` column), so the pipeline evidence lacks them.
    const r = {
      ...fig(),
      metadata: { ...fig().metadata, modality: "image" },
      evidence: { reference: "d#u1", root_document_id: "d" },
    } as unknown as SearchResult;
    const hit = shapeHitV2(r, {
      collection: "docs",
      includeAssets: "none",
      figureInfo: new Map(),
    });
    expect(hit.evidence?.figure_id).toBe("f1");
    expect(hit.evidence?.asset_id).toBe("a1");
    expect(hit.evidence?.modality).toBe("image");
  });

  it("prefers existing evidence figure fields over metadata", () => {
    const r = {
      ...fig(),
      metadata: { ...fig().metadata, figure_id: "meta-fig" },
    } as unknown as SearchResult;
    const hit = shapeHitV2(r, {
      collection: "docs",
      includeAssets: "none",
      figureInfo: new Map(),
    });
    expect(hit.evidence?.figure_id).toBe("f1");
  });

	it("surfaces revision_state / pages_available for a partial revision", () => {
		const r = {
			...chunkWithRefs(),
			revision_state: "partial",
			pages_available: "1–2750",
		} as unknown as SearchResult;
		const hit = shapeHitV2(r, { collection: "docs", includeAssets: "none", figureInfo: new Map() });
		expect(hit.revision_state).toBe("partial");
		expect(hit.pages_available).toBe("1–2750");
		const plain = shapeHitV2(chunkWithRefs(), { collection: "docs", includeAssets: "none", figureInfo: new Map() });
		expect(plain.revision_state).toBeUndefined();
		expect(plain.pages_available).toBeUndefined();
	});

	it("passes group provenance through", () => {
		const r = {
			...chunkWithRefs(),
			group: { by: "section", key: "s1", count: 2, unit_ids: ["u2", "u3"] },
		} as unknown as SearchResult;
		const hit = shapeHitV2(r, { collection: "docs", includeAssets: "none", figureInfo: new Map() });
		expect(hit.group).toEqual({ by: "section", key: "s1", count: 2, unit_ids: ["u2", "u3"] });
	});
});
