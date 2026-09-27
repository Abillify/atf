// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { normalizeV2Hit } from "./retrieval.ts";

/**
 * Tests for the `--v2` wiring (task 3.10): the normaliser that maps a
 * `POST /v2/search` hit (top-level `pages`, `assets`) back into the v1
 * reference-bearing shape the metrics consume. The normaliser is the only new
 * logic on the v2 path; the request/response plumbing around it is a thin fetch.
 */
describe("normalizeV2Hit", () => {
	test("maps top-level pages into evidence page_start/page_end", () => {
		const hit = normalizeV2Hit({
			reference: "doc#unit=1",
			base_ref: "doc",
			pages: { start: 12, end: 14 },
		});
		expect(hit.base_ref).toBe("doc");
		expect(hit.reference).toBe("doc#unit=1");
		expect(hit.evidence?.page_start).toBe(12);
		expect(hit.evidence?.page_end).toBe(14);
	});

	test("defaults page_end to page_start when only start is present", () => {
		const hit = normalizeV2Hit({
			reference: "doc#unit=2",
			base_ref: "doc",
			pages: { start: 7 },
		});
		expect(hit.evidence?.page_start).toBe(7);
		expect(hit.evidence?.page_end).toBe(7);
	});

	test("treats a relation:hit asset with a figure_id as a figure (modality image)", () => {
		const hit = normalizeV2Hit({
			reference: "doc#figure=F3",
			base_ref: "doc",
			pages: { start: 3, end: 3 },
			assets: [{ relation: "hit", figure_id: "F3", kind: "figure" }],
		});
		expect(hit.evidence?.modality).toBe("image");
		expect(hit.evidence?.figure_id).toBe("F3");
	});

	test("ignores referenced figures for figure detection (only the hit's own figure counts)", () => {
		const hit = normalizeV2Hit({
			reference: "doc#unit=5",
			base_ref: "doc",
			pages: { start: 9, end: 9 },
			assets: [{ relation: "referenced", figure_id: "F9", kind: "figure" }],
		});
		expect(hit.evidence?.modality).toBeUndefined();
		expect(hit.evidence?.figure_id).toBeUndefined();
	});

	test("falls back to evidence when pages/assets are absent (v2 passthrough)", () => {
		const hit = normalizeV2Hit({
			reference: "doc#figure=F1",
			base_ref: "doc",
			evidence: {
				page_start: 4,
				page_end: 4,
				modality: "image",
				figure_id: "F1",
			},
		});
		expect(hit.evidence?.page_start).toBe(4);
		expect(hit.evidence?.page_end).toBe(4);
		expect(hit.evidence?.modality).toBe("image");
		expect(hit.evidence?.figure_id).toBe("F1");
	});

	test("prefers top-level pages over evidence pages", () => {
		const hit = normalizeV2Hit({
			reference: "doc#unit=6",
			base_ref: "doc",
			pages: { start: 20, end: 21 },
			evidence: { page_start: 1, page_end: 1 },
		});
		expect(hit.evidence?.page_start).toBe(20);
		expect(hit.evidence?.page_end).toBe(21);
	});

	test("yields no page evidence when neither pages nor evidence carry a page", () => {
		const hit = normalizeV2Hit({
			reference: "doc",
			base_ref: "doc",
			pages: null,
		});
		expect(hit.evidence?.page_start).toBeUndefined();
		expect(hit.evidence?.page_end).toBeUndefined();
	});
});
