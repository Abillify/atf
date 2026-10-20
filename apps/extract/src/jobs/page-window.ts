// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * page-window.ts
 *
 * The `pages` window of a job (contract 2.4). The request's selection
 * (`"5-"`, `"3-10"`, …) is stored normalised as `config.pages = {from?, to?}`;
 * once the source is prepared the runner resolves it against the real page
 * count and — only when the window does not start at page 1 — persists the
 * outcome as `config.pageWindow = {first, last}`, so the emitter (which runs
 * from a fresh read of the job) knows where the stream starts without having
 * to re-open the source.
 *
 * Page numbers stay the SOURCE's own throughout: a window of "5-7" stages,
 * emits and indexes pages 5, 6 and 7, and `job.page_count` is the number of
 * pages processed (3), not the last page number.
 */
import {
  resolvePageWindow,
  selectionFromConfig,
  type PageWindow,
} from "@atf/extract-contract/v2";
import type { JobRow } from "../persistence/types.js";

/** Config key under which the resolved window is persisted. */
export const PAGE_WINDOW_KEY = "pageWindow";

/** Resolve a job's `pages` selection against a source with `sourcePageCount` pages. */
export function pageWindowOf(job: JobRow, sourcePageCount: number): PageWindow {
  const selection = selectionFromConfig((job.config as { pages?: unknown }).pages);
  return resolvePageWindow(selection, sourcePageCount);
}

/** True when the job asked for a window (`from` and/or `to`). */
export function hasPageSelection(job: JobRow): boolean {
  const selection = selectionFromConfig((job.config as { pages?: unknown }).pages);
  return selection.from !== undefined || selection.to !== undefined;
}

/** The first page of the job's stream; 1 unless a window was persisted. */
export function firstPageOf(config: Record<string, unknown>): number {
  const stored = config[PAGE_WINDOW_KEY];
  if (stored !== null && typeof stored === "object") {
    const first = (stored as { first?: unknown }).first;
    if (typeof first === "number" && Number.isInteger(first) && first >= 1) return first;
  }
  return 1;
}

/**
 * The page range the emitter streams: it starts at {@link firstPageOf} and
 * covers `job.page_count` pages. Absent a recorded count the caller falls back
 * to what was staged.
 */
export function lastPageOf(config: Record<string, unknown>, pageCount: number | null): number | null {
  return pageCount === null ? null : firstPageOf(config) + pageCount - 1;
}
