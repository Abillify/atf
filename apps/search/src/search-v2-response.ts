// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * search-v2-response.ts
 *
 * The v2 response shaper (task 3.7, design §7.2, Requirements 13.3/13.5). PURE:
 * no DB, no I/O. Given an already-ranked/diversified/expanded {@link
 * SearchResult} (the output of the retrieval pipeline) plus the resolved figure
 * metadata for the figures it references, it produces the v2 hit shape:
 *
 *   { score, unit_id?, unit_type?, reference, base_ref, title?, section_path,
 *     pages: { start, end } | null, content,
 *     expanded?: { mode, content, truncated, unit_count, budget_chars },
 *     assets: AssetRef[],
 *     navigation: { prev?, next?, section_id?, prev_unit_id?, next_unit_id?,
 *                   parent_unit_id? },
 *     evidence?: { chunk_id?, block_ids?, char_start?, … },
 *     revision_state?, pages_available?, group? }
 *
 * Deviations from the §7.2 example, kept deliberately:
 *  - `pages` is `{ start, end }` rather than `[start, end]`: the retrieval
 *    evaluation harness (scripts/eval/retrieval.ts) and the runtime already read
 *    `pages.start` / `pages.end`, and the object form is unambiguous for a
 *    single-page hit.
 *  - `navigation` carries the design's `prev` / `next` / `section_id` AND the
 *    explicit `prev_unit_id` / `next_unit_id` / `parent_unit_id` aliases
 *    (additive, so existing consumers keep working).
 *  - `evidence.block_ids` is filled from the unit's mirrored `block_ids` when
 *    the search row's chunk evidence does not carry them.
 *
 * Assets (Requirement 13.5) cover BOTH the HIT figure (when the hit is itself a
 * figure unit) AND every figure the hit REFERENCES (its `figure_refs`). Each
 * asset carries `kind`, `figure_kind`, `caption`, `page`, `bbox` and the two
 * ACL-checked `/v2/assets/{id}` URLs (`thumb_url`, `url`). `include_assets`
 * selects the depth:
 *   - `none`       → no `assets` field at all;
 *   - `refs`       → the ids/refs only (no URLs), for a caller that resolves
 *                    assets itself;
 *   - `thumbnails` → the full asset object with `thumb_url` + `url`.
 *
 * Keeping this pure makes the whole v2 shape (assets, navigation, pages,
 * section_path, expanded passthrough, include_assets modes) exhaustively
 * unit-testable with fixtures; the handler only orchestrates.
 */

import type { SearchResult } from "./postgres-client.js";
import type { FigureUnitInfo } from "./postgres-client.js";
import type { ExpandedSearchResult } from "./handlers/expand-results.js";
import type { ResultGroupInfo } from "./rerank-context.js";

/** `include_assets` depth (design §7.2, Requirement 13.3). */
export type IncludeAssets = "none" | "refs" | "thumbnails";

/** `granularity` — which unit level a hit is preferred at (design §7.2). */
export type Granularity = "chunk" | "section" | "page" | "document";

/** A v2 asset reference on a hit (Requirement 13.5). */
export interface AssetRef {
	asset_id: string;
	/** Whether this asset belongs to the hit itself or a figure it references. */
	relation: "hit" | "referenced";
	figure_id?: string;
	kind?: string;
	figure_kind?: string;
	caption?: string;
	page?: number;
	bbox?: [number, number, number, number];
	/** ACL-checked thumbnail URL; present only for include_assets=thumbnails. */
	thumb_url?: string;
	/** ACL-checked full-image URL; present only for include_assets=thumbnails. */
	url?: string;
}

/** Navigation links from the relationship graph (task 3.2, design §7.2). */
export interface Navigation {
	/** Previous unit in reading order (design §7.2 name). */
	prev?: string;
	/** Next unit in reading order (design §7.2 name). */
	next?: string;
	prev_unit_id?: string;
	next_unit_id?: string;
	parent_unit_id?: string;
	section_id?: string;
}

/** The v2 search hit (design §7.2). */
export interface SearchHitV2 {
	score: number;
	unit_id?: string;
	unit_type?: string;
	reference: string;
	base_ref: string;
	title?: string;
	section_path: string[];
	pages: { start: number; end: number } | null;
	content: string;
	expanded?: ExpandedSearchResult["expanded"];
	assets?: AssetRef[];
	navigation: Navigation;
	evidence?: SearchResult["evidence"] & { block_ids?: string[] };
	/** `partial` when the hit comes from a still-growing progressive revision (Req 6.4). */
	revision_state?: "partial";
	/** Committed page ranges of a partial revision, e.g. "1–2750" (Req 6.4). */
	pages_available?: string;
	/** Present when `group_by` merged several hits into this one (Req 13.6). */
	group?: ResultGroupInfo;
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function metaOf(result: SearchResult): Record<string, unknown> {
	return (result.metadata ?? {}) as Record<string, unknown>;
}

/** Build the `/v2/assets/{id}?variant=` URL served by task 1.11's asset GET. */
export function assetUrl(
	assetId: string,
	collection: string,
	variant: "thumb" | "preview" | "full",
): string {
	return `/v2/assets/${encodeURIComponent(assetId)}?collection=${encodeURIComponent(collection)}&variant=${variant}`;
}

function bboxOf(v: unknown): [number, number, number, number] | undefined {
	return Array.isArray(v) &&
		v.length === 4 &&
		v.every((n) => typeof n === "number")
		? (v as [number, number, number, number])
		: undefined;
}

/**
 * The section path of a hit as a string array (never a joined string here — the
 * v2 shape returns the array). Prefers `evidence.section_path`, falls back to
 * `metadata.section_path`, else empty.
 */
export function sectionPathArray(result: SearchResult): string[] {
	const fromEvidence = result.evidence?.section_path;
	if (Array.isArray(fromEvidence)) return fromEvidence.map((p) => String(p));
	const fromMeta = metaOf(result).section_path;
	if (Array.isArray(fromMeta)) return fromMeta.map((p) => String(p));
	return [];
}

/** The page range of a hit, from evidence/metadata, or null when unknown. */
export function pagesOf(
	result: SearchResult,
): { start: number; end: number } | null {
	const meta = metaOf(result);
	const start =
		asNumber(result.evidence?.page_start) ?? asNumber(meta.page_start);
	const end =
		asNumber(result.evidence?.page_end) ?? asNumber(meta.page_end) ?? start;
	if (start === undefined || end === undefined) return null;
	return { start, end };
}

/** Navigation links pulled off the hit's mirrored unit-graph metadata. */
export function navigationOf(result: SearchResult): Navigation {
	const meta = metaOf(result);
	const nav: Navigation = {};
	const prev = asString(meta.prev_unit_id);
	const next = asString(meta.next_unit_id);
	const parent = asString(meta.parent_unit_id);
	const section = asString(meta.section_id);
	if (prev) {
		nav.prev = prev;
		nav.prev_unit_id = prev;
	}
	if (next) {
		nav.next = next;
		nav.next_unit_id = next;
	}
	if (parent) nav.parent_unit_id = parent;
	if (section) nav.section_id = section;
	return nav;
}

/**
 * Build the asset list for one hit (Requirement 13.5): the HIT figure (when the
 * hit is a figure unit) plus every REFERENCED figure (from `figure_refs`),
 * enriched with the resolved figure metadata. `figureInfo` maps figure_id →
 * resolved metadata (from PostgresClient.lookupFigureUnits); a referenced figure
 * with no resolved metadata still yields an asset carrying the ids it has.
 *
 * `mode`:
 *  - `refs`       → ids/refs, no URLs;
 *  - `thumbnails` → full object with thumb_url + url;
 *  - (`none` is handled by the caller: it omits assets entirely.)
 */
export function buildAssets(
	result: SearchResult,
	figureInfo: Map<string, FigureUnitInfo>,
	collection: string,
	mode: "refs" | "thumbnails",
): AssetRef[] {
	const meta = metaOf(result);
	const assets: AssetRef[] = [];
	const seen = new Set<string>();

	const push = (a: AssetRef): void => {
		// Dedupe by asset id (a hit figure that is also in its own figure_refs must
		// not appear twice). Keep the first (hit relation wins over referenced).
		if (seen.has(a.asset_id)) return;
		seen.add(a.asset_id);
		assets.push(a);
	};

	const withUrls = (a: AssetRef): AssetRef => {
		if (mode !== "thumbnails") return a;
		return {
			...a,
			thumb_url: assetUrl(a.asset_id, collection, "thumb"),
			url: assetUrl(a.asset_id, collection, "full"),
		};
	};

	// 1. The HIT figure: the hit is itself a figure unit (modality image / a
	//    figure unit_type carrying an asset id).
	const hitAssetId = asString(meta.asset_id);
	if (hitAssetId) {
		const hitFigureId = asString(meta.figure_id);
		const hitFigureKind = asString(meta.figure_kind);
		const hitCaption = figureCaptionFromHit(result);
		const hitPages = pagesOf(result);
		const hitBbox = bboxOf(result.evidence?.bbox);
		push(
			withUrls({
				asset_id: hitAssetId,
				relation: "hit",
				...(hitFigureId ? { figure_id: hitFigureId } : {}),
				kind: "figure",
				...(hitFigureKind ? { figure_kind: hitFigureKind } : {}),
				...(hitCaption ? { caption: hitCaption } : {}),
				...(hitPages ? { page: hitPages.start } : {}),
				...(hitBbox ? { bbox: hitBbox } : {}),
			}),
		);
	}

	// 2. REFERENCED figures: the figures this unit's text points at (figure_refs,
	//    task 3.2). Enrich each with the resolved figure metadata when available.
	const refs = result.evidence?.figure_refs ?? [];
	for (const ref of refs) {
		if (!ref?.asset_id) continue;
		const info = ref.figure_id ? figureInfo.get(ref.figure_id) : undefined;
		push(
			withUrls({
				asset_id: ref.asset_id,
				relation: "referenced",
				...(ref.figure_id ? { figure_id: ref.figure_id } : {}),
				kind: "figure",
				...(info?.figure_kind ? { figure_kind: info.figure_kind } : {}),
				...(info?.caption ? { caption: info.caption } : {}),
				...(info?.page != null ? { page: info.page } : {}),
				...(info?.bbox ? { bbox: info.bbox } : {}),
			}),
		);
	}

	return assets;
}

/** The caption of a HIT figure: its title, else the first line of its content. */
function figureCaptionFromHit(result: SearchResult): string | undefined {
	const title = result.title?.trim();
	if (title) return title.length > 300 ? title.slice(0, 300) : title;
	const firstLine = (result.content ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (firstLine === "") return undefined;
	return firstLine.length > 300 ? firstLine.slice(0, 300) : firstLine;
}

/** All the distinct referenced figure ids across a set of results (for a batched lookup). */
export function referencedFigureIds(results: SearchResult[]): string[] {
	const ids = new Set<string>();
	for (const r of results) {
		for (const ref of r.evidence?.figure_refs ?? []) {
			if (ref?.figure_id) ids.add(ref.figure_id);
		}
	}
	return [...ids];
}

export interface ShapeHitOptions {
	collection: string;
	includeAssets: IncludeAssets;
	/** figure_id → resolved figure metadata for referenced figures. */
	figureInfo: Map<string, FigureUnitInfo>;
}

/**
 * The hit's evidence with `block_ids` filled from the unit's mirrored metadata
 * when the chunk evidence lacks them (design §7.2 `evidence.block_ids`).
 */
export function evidenceOf(
	result: SearchResult,
): SearchHitV2["evidence"] | undefined {
	const evidence = result.evidence as SearchHitV2["evidence"] | undefined;
	const meta = metaOf(result);
  const metaBlocks = meta.block_ids;
  const blockIds = Array.isArray(metaBlocks)
    ? metaBlocks.filter((b): b is string => typeof b === "string" && b !== "")
    : [];
  // v2 units (batch worker) keep figure coordinates in `metadata` instead of
  // the legacy `chunk` column the v1 evidence is derived from; mirror them
  // into the evidence so citations and figure-level scoring work for both
  // ingest paths. Existing evidence fields always win.
  const figureId = asString(meta.figure_id);
  const assetId = asString(meta.asset_id);
  type Evidence = NonNullable<SearchHitV2["evidence"]>;
  const withFigure = (ev: Evidence): Evidence => {
    const out: Evidence = { ...ev };
    if (out.modality === undefined && meta.modality === "image")
      out.modality = "image";
    if (out.figure_id === undefined && figureId !== undefined)
      out.figure_id = figureId;
    if (out.asset_id === undefined && assetId !== undefined)
      out.asset_id = assetId;
    return out;
  };
	if (!evidence) {
		if (blockIds.length === 0 && figureId === undefined) return undefined;
    return withFigure({ block_ids: blockIds } as unknown as Evidence);
	}
	const base =
    evidence.block_ids && evidence.block_ids.length > 0
      ? evidence
      : blockIds.length > 0
        ? { ...evidence, block_ids: blockIds }
        : evidence;
  return withFigure(base);
}

/** Shape a single pipeline result into the v2 hit (design §7.2). */
export function shapeHitV2(
	result: ExpandedSearchResult & { group?: ResultGroupInfo },
	opts: ShapeHitOptions,
): SearchHitV2 {
	const meta = metaOf(result);
	const unitId = asString(meta.unit_id);
	const unitType = asString(meta.unit_type);
	const hit: SearchHitV2 = {
		score: result.score,
		...(unitId ? { unit_id: unitId } : {}),
		...(unitType ? { unit_type: unitType } : {}),
		reference: result.reference,
		base_ref: result.base_ref,
		...(result.title ? { title: result.title } : {}),
		section_path: sectionPathArray(result),
		pages: pagesOf(result),
		content: result.content,
		...(result.expanded ? { expanded: result.expanded } : {}),
		navigation: navigationOf(result),
	};
	const evidence = evidenceOf(result);
	if (evidence) hit.evidence = evidence;
	if (result.revision_state === "partial") {
		hit.revision_state = "partial";
		if (result.pages_available) hit.pages_available = result.pages_available;
	}
	if (result.group) hit.group = result.group;
	if (opts.includeAssets !== "none") {
		hit.assets = buildAssets(
			result,
			opts.figureInfo,
			opts.collection,
			opts.includeAssets,
		);
	}
	return hit;
}
