// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/expand-results.ts
 *
 * Small-to-big expansion wiring (task 3.6, Requirement 13.4), shared by the REST
 * `/search` handler and the MCP `search` tool.
 *
 * This is the glue between the pipeline and the two halves of the feature:
 *  - {@link PostgresClient.expandUnit} fetches the visibility/ACL/revision-safe
 *    expansion set for one hit in reading order;
 *  - {@link assembleExpansion} bounds that set by `budget_chars`, dedupes the hit
 *    and reports `truncated`.
 *
 * It runs AFTER diversification and BEFORE asset attach (Requirement 13.1 order),
 * so callers invoke it on the already-diversified, already-limited result list.
 *
 * A hit's expansion coordinates come from the coordinates the batch worker mirrored
 * into result `metadata` (`section_id`, `prev_unit_id`, `next_unit_id`,
 * `page_start`, `page_end`) plus the always-present `base_ref`. When a hit lacks
 * the coordinates a mode needs (e.g. a legacy v1 row with no unit graph), its
 * expansion is simply empty and no `expanded` field is attached — the flat result
 * is unchanged. Expansion is strictly additive: with no `expand` param the caller
 * never invokes this, so v1 `/search` is byte-for-byte unchanged.
 */

import type { Logger } from "pino";
import type {
	PostgresClient,
	SearchResult,
	ExpandUnitCoords,
} from "../postgres-client.js";
import {
	assembleExpansion,
	clampBudgetChars,
	type ExpandMode,
	type ExpandedContext,
} from "../expansion.js";
import type { AccessScope } from "../access-scope.js";

/** A search result augmented with its assembled small-to-big expansion. */
export interface ExpandedSearchResult extends SearchResult {
	expanded?: ExpandedContext;
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Read a hit's expansion coordinates off its metadata + base_ref. Returns the
 * coordinates even when partial; {@link PostgresClient.expandUnit} decides per
 * mode whether the coordinates it needs are present.
 */
export function coordsForResult(result: SearchResult): ExpandUnitCoords {
	const meta = (result.metadata ?? {}) as Record<string, unknown>;
	return {
		unitId: asString(meta.unit_id),
		baseRef: result.base_ref,
		prevUnitId: asString(meta.prev_unit_id),
		nextUnitId: asString(meta.next_unit_id),
		sectionId: asString(meta.section_id),
		pageStart:
			asNumber(meta.page_start) ?? asNumber(result.evidence?.page_start),
		pageEnd: asNumber(meta.page_end) ?? asNumber(result.evidence?.page_end),
	};
}

/**
 * Attach a small-to-big `expanded` field to each result, in place on a shallow
 * copy of the list (inputs are never mutated). Runs one bounded expansion query
 * per result. A failed or empty expansion leaves the result untouched, so a
 * partial backend failure degrades to the flat result rather than failing the
 * whole search.
 */
export async function attachExpansions(params: {
	postgresClient: PostgresClient;
	collection: string;
	scope: AccessScope;
	mode: ExpandMode;
	budgetChars: number;
	includeAllVersions: boolean;
	validAt?: string;
	results: SearchResult[];
	logger: Logger;
}): Promise<ExpandedSearchResult[]> {
	const {
		postgresClient,
		collection,
		scope,
		mode,
		includeAllVersions,
		validAt,
		results,
		logger,
	} = params;
	// Clamp once for every caller (REST, v2, MCP) so no surface can request an
	// unbounded expansion (MAX_EXPAND_BUDGET_CHARS).
	const budgetChars = clampBudgetChars(params.budgetChars);

	return Promise.all(
		results.map(async (result): Promise<ExpandedSearchResult> => {
			const coords = coordsForResult(result);
			const res = await postgresClient.expandUnit(
				collection,
				scope,
				mode,
				coords,
				{
					includeAllVersions,
					validAt,
				},
			);
			if (!res.ok) {
				logger.warn(
					{ error: res.error, reference: result.reference, mode },
					"Expansion failed for hit; returning flat result",
				);
				return result;
			}
			if (res.result.length === 0) return result;
			const expanded = assembleExpansion({
				mode,
				units: res.result,
				budgetChars,
				hitUnitId: coords.unitId,
				hitContent: result.content,
			});
			// Nothing survived dedupe/budget (e.g. the only unit was the hit itself):
			// leave the result flat rather than attaching an empty expansion.
			if (expanded.unit_count === 0 && expanded.content === "") return result;
			return { ...result, expanded };
		}),
	);
}
