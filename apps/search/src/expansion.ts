// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * expansion.ts
 *
 * Small-to-big expansion (task 3.6, Requirement 13.4, design §7.1 step 5).
 *
 * A search hit is a small, precise unit (a chunk, a table row-group, a figure).
 * For grounding, the consumer often wants more surrounding context than the hit
 * itself: the neighbouring chunks, the whole section, or the whole page. This is
 * the "small-to-big" step of the retrieval pipeline, run AFTER diversification
 * and BEFORE asset attach (Requirement 13.1 order).
 *
 * This module is the PURE assembler half of the feature. Given the hit's own
 * content and the expansion units the database returned (already in reading
 * order and already visibility/ACL/revision-filtered by {@link
 * PostgresClient.expandUnit}), it concatenates the units up to `budget_chars`,
 * dedupes the hit itself so it is never repeated inside its own expansion, and
 * reports whether any unit was dropped for lack of budget (`truncated`).
 *
 * Keeping the budget/dedupe logic pure (no DB, no I/O) makes it exhaustively
 * unit-testable with fixture units; the DB method is tested separately against a
 * live PostgreSQL.
 */

/**
 * The expansion modes exposed by `expand` (design §7.2, Req 13.4). `document`
 * returns the hit's whole document in reading order — for an e-mail, the whole
 * thread chronologically.
 */
export type ExpandMode = "neighbors" | "section" | "page" | "document";

/** Default character budget when `expand` is set but `budget_chars` is omitted. */
export const DEFAULT_EXPAND_BUDGET_CHARS = 4000;

/**
 * Default budget for `expand=document`: a whole e-mail thread or a short
 * document fits, a manual does not (and reports `truncated`).
 */
export const DEFAULT_DOCUMENT_EXPAND_BUDGET_CHARS = 50_000;

/** The default `budget_chars` for a mode when the caller omits it. */
export function defaultBudgetCharsFor(mode: ExpandMode | undefined): number {
	return mode === "document" ? DEFAULT_DOCUMENT_EXPAND_BUDGET_CHARS : DEFAULT_EXPAND_BUDGET_CHARS;
}

/**
 * Hard ceiling on `budget_chars` (REST `/search`, `/v2/search`, MCP `search`).
 * A caller-supplied budget above this is clamped DOWN (not rejected), so an
 * over-ask still returns a usable, bounded expansion instead of streaming a
 * whole multi-thousand-page document into one response.
 */
export const MAX_EXPAND_BUDGET_CHARS = 200_000;

/**
 * Clamp a budget to `[0, MAX_EXPAND_BUDGET_CHARS]`, flooring fractional values.
 * Non-finite / non-positive values become 0 ("no room").
 */
export function clampBudgetChars(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.min(Math.floor(value), MAX_EXPAND_BUDGET_CHARS);
}

/**
 * A candidate unit for expansion, as returned by the DB in reading order.
 * `unit_id` lets the assembler dedupe the hit precisely; `content` is the text
 * that gets concatenated. Everything else the caller may carry is irrelevant to
 * assembly and intentionally not part of this shape.
 */
export interface ExpansionUnit {
	unit_id: string | null;
	content: string;
}

/** The assembled expansion attached to a search result under `expanded`. */
export interface ExpandedContext {
	/** Which mode produced this expansion. */
	mode: ExpandMode;
	/** The concatenated content of the expansion units, within budget. */
	content: string;
	/** Number of units actually included (after dedupe + budget). */
	unit_count: number;
	/** Character budget that bounded the assembly. */
	budget_chars: number;
	/**
	 * TRUE iff at least one in-order unit was dropped because the budget was
	 * exhausted (or a unit was truncated to fit). FALSE when everything fit.
	 */
	truncated: boolean;
}

/** Separator placed between concatenated units so they don't run together. */
const UNIT_SEPARATOR = "\n\n";

export interface AssembleExpansionOptions {
	mode: ExpandMode;
	/** Units in reading order (prev→…→next / section / page order). */
	units: ExpansionUnit[];
	/** The maximum number of characters the assembled content may contain. */
	budgetChars: number;
	/**
	 * The hit's own `unit_id`, when known. The unit matching this id is excluded
	 * from the expansion so the hit is never duplicated inside its own context.
	 */
	hitUnitId?: string | null;
	/**
	 * The hit's own content. Used as a fallback dedupe when the hit's `unit_id` is
	 * unknown (legacy rows): a unit whose content equals the hit's is skipped.
	 */
	hitContent?: string;
}

/**
 * Assemble the expanded context for a hit from its ordered expansion units.
 *
 * Rules (Requirement 13.4):
 *  - units are consumed in the given reading order;
 *  - the hit itself (matched by `hitUnitId`, or by identical `hitContent` when
 *    the id is unknown) is skipped so it is not repeated;
 *  - units are appended while they fit within `budgetChars` (accounting for the
 *    separator between units);
 *  - when a unit would overflow the budget, the assembly STOPS and
 *    `truncated` is set — remaining units are not partially spliced in, which
 *    keeps unit boundaries intact and the result deterministic;
 *  - a single first unit larger than the whole budget is hard-truncated to the
 *    budget and `truncated` is set (so an oversized section/page still yields
 *    *some* context rather than empty content);
 *  - `truncated` is FALSE only when every non-hit unit was included in full.
 *
 * Inputs are never mutated.
 */
export function assembleExpansion(
	opts: AssembleExpansionOptions,
): ExpandedContext {
	const { mode, units, hitUnitId, hitContent } = opts;
	// A non-positive/NaN budget is treated as "no room": nothing is assembled and
	// truncated reflects whether there was anything we had to drop.
	// The budget is also clamped to MAX_EXPAND_BUDGET_CHARS as a last line of
	// defence, whatever the caller already validated.
	const budgetChars = clampBudgetChars(opts.budgetChars);

	// Drop the hit itself from its own expansion (id first, content as fallback).
	const candidates = units.filter((u) => {
		if (hitUnitId != null && u.unit_id != null) return u.unit_id !== hitUnitId;
		if (hitContent !== undefined) return u.content !== hitContent;
		return true;
	});

	const pieces: string[] = [];
	let usedChars = 0;
	let truncated = false;

	for (const unit of candidates) {
		const content = unit.content ?? "";
		if (content.length === 0) continue;
		const sepCost = pieces.length > 0 ? UNIT_SEPARATOR.length : 0;
		const projected = usedChars + sepCost + content.length;
		if (projected <= budgetChars) {
			pieces.push(content);
			usedChars = projected;
			continue;
		}
		// This unit does not fit in full.
		if (pieces.length === 0 && budgetChars > 0) {
			// Nothing accumulated yet and the very first unit is larger than the whole
			// budget: hard-truncate it so an oversized section/page still yields some
			// context. Otherwise `expand` on a huge section would return nothing.
			pieces.push(content.slice(0, budgetChars));
			usedChars = budgetChars;
		}
		// Either way, we could not include everything from here on.
		truncated = true;
		break;
	}

	return {
		mode,
		content: pieces.join(UNIT_SEPARATOR),
		unit_count: pieces.length,
		budget_chars: budgetChars,
		truncated,
	};
}

/**
 * Parse/validate an `expand` value into an {@link ExpandMode}.
 *
 * Returns the mode for a recognised value, `undefined` when absent/empty (caller
 * uses its default = no expansion), or `null` for an unrecognised value so the
 * HTTP caller can answer 400 and the MCP caller can ignore it.
 */
export function parseExpandMode(
	value: string | undefined,
): ExpandMode | null | undefined {
	if (value === undefined) return undefined;
	const v = value.trim().toLowerCase();
	if (v === "") return undefined;
	if (v === "none" || v === "off") return undefined;
	if (v === "neighbors" || v === "section" || v === "page" || v === "document") return v;
	return null;
}

/**
 * Parse/validate a `budget_chars` value.
 *
 * Returns a positive integer when valid (clamped to
 * {@link MAX_EXPAND_BUDGET_CHARS}), `undefined` when absent/empty (caller uses
 * {@link DEFAULT_EXPAND_BUDGET_CHARS}), or `null` for a malformed value so the
 * HTTP caller can answer 400.
 */
export function parseBudgetChars(
	value: string | undefined,
): number | null | undefined {
	if (value === undefined) return undefined;
	const v = value.trim();
	if (v === "") return undefined;
	if (!/^\d+$/.test(v)) return null;
	const n = Number.parseInt(v, 10);
	if (!Number.isInteger(n) || n <= 0) return null;
	return Math.min(n, MAX_EXPAND_BUDGET_CHARS);
}
