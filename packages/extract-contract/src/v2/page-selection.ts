// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * page-selection.ts
 *
 * The `pages` field of `POST /v2/jobs` (contract 2.4): a contiguous window of
 * the source, in SOURCE page numbers.
 *
 *   "5"      page 5 only
 *   "3-10"   pages 3 to 10
 *   "5-"     page 5 to the last page
 *   "-8"     page 1 to 8
 *
 * A window, not a set: lists such as "1-10,15" are rejected rather than
 * approximated, so the stream a consumer receives is always one gap-free run
 * `[firstPage, lastPage]` and Search can decide completeness from two numbers.
 * Page numbers in the stream stay the source's own (a window of "5-7" yields
 * records for pages 5, 6 and 7, never 1, 2, 3).
 */
import { z } from "zod";

/** A parsed selection; an absent bound is open. */
export interface PageSelection {
  /** First page, 1-based. Absent = from the start. */
  from?: number;
  /** Last page, 1-based and `>= from`. Absent = to the end. */
  to?: number;
}

/** Upper bound for either number: far above any real document, below 2^31. */
const MAX_PAGE_NUMBER = 1_000_000;

const PAGE_SELECTION_RE = /^(\d{1,7})?(-)?(\d{1,7})?$/;

/**
 * Parse a page selection. Returns `null` for anything that is not one of the
 * four documented shapes (empty, lists, zero, reversed bounds, signs, text).
 * Surrounding whitespace is ignored.
 */
export function parsePageSelection(value: string): PageSelection | null {
  // Blanks around the dash are tolerated ("3 - 10"); blanks inside a number are not.
  const text = value.trim().replace(/\s*-\s*/g, "-");
  if (text === "" || text === "-") return null;
  const match = PAGE_SELECTION_RE.exec(text);
  if (match === null) return null;
  const [, left, dash, right] = match;
  if (dash === undefined) {
    // "5": the regex puts a lone number into the left group.
    if (left === undefined || right !== undefined) return null;
    const page = Number.parseInt(left, 10);
    return page >= 1 && page <= MAX_PAGE_NUMBER ? { from: page, to: page } : null;
  }
  const from = left === undefined ? undefined : Number.parseInt(left, 10);
  const to = right === undefined ? undefined : Number.parseInt(right, 10);
  if (from !== undefined && (from < 1 || from > MAX_PAGE_NUMBER)) return null;
  if (to !== undefined && (to < 1 || to > MAX_PAGE_NUMBER)) return null;
  if (from !== undefined && to !== undefined && to < from) return null;
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

/** Message shared by the schema and the handlers. */
export const PAGE_SELECTION_HINT =
  'pages must be one contiguous window: "N", "A-B", "A-" or "-B" (1-based; lists such as "1-10,15" are not supported)';

/** `pages` as sent on the wire: a string that parses as a {@link PageSelection}. */
export const pageSelectionSchema = z
  .string()
  .max(32)
  .refine((value) => parsePageSelection(value) !== null, { message: PAGE_SELECTION_HINT });

/**
 * The selection stored on a job's config: `{from?, to?}`. A job created before
 * contract 2.4 may carry the raw string the request had (which the runner never
 * applied) or an object; both are read, anything else means "all pages".
 */
export function selectionFromConfig(value: unknown): PageSelection {
  if (typeof value === "string") return parsePageSelection(value) ?? {};
  if (value !== null && typeof value === "object") {
    const { from, to } = value as { from?: unknown; to?: unknown };
    const selection: PageSelection = {};
    if (typeof from === "number" && Number.isInteger(from) && from >= 1) selection.from = from;
    if (typeof to === "number" && Number.isInteger(to) && to >= 1) {
      if (selection.from === undefined || to >= selection.from) selection.to = to;
    }
    return selection;
  }
  return {};
}

/** The resolved window of a source with `sourcePageCount` pages. */
export interface PageWindow {
  /** First page to process (source numbering). */
  first: number;
  /** Last page to process (source numbering); `first - 1` when the window is empty. */
  last: number;
  /** `last - first + 1`, 0 when empty. */
  count: number;
}

/**
 * Clamp a selection to a source. `from` beyond the source yields an empty
 * window (`count === 0`) — the caller decides whether that is an error; a `to`
 * beyond the source is clamped, as the runner has always done.
 */
export function resolvePageWindow(selection: PageSelection, sourcePageCount: number): PageWindow {
  const first = selection.from ?? 1;
  const last = Math.min(sourcePageCount, selection.to ?? sourcePageCount);
  const count = Math.max(0, last - first + 1);
  return { first, last: count === 0 ? first - 1 : last, count };
}
