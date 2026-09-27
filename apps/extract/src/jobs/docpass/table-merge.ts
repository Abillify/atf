// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/docpass/table-merge.ts
 *
 * Cross-page table merging for the streaming document pass (design §5 S7 step 2,
 * requirement 9.2).
 *
 * ## The problem
 *
 * A long table runs off the bottom of a page and resumes at the top of the
 * next, usually repeating its header. To v1 those are two unrelated tables, so a
 * value on page 38 loses the column headings that only appeared on page 37. The
 * document pass stitches them back into one *logical* table: the continuation
 * carries the same `tableId` and points back with `continuationOf`, so Search's
 * `get_table` can return the whole thing across the page break.
 *
 * ## When two tables merge
 *
 * The Pass-1 model flags the boundary (task 2.3): the tail table on page N is
 * marked `continues`, and a head table on page N+1 may be marked `continuationOf`.
 * But a flag alone is not enough — a page can legitimately start with an
 * unrelated table. So the merge requires a structural match (requirement 9.2):
 *
 *  - **same column count**, and
 *  - **same header, or the continuation has no header** (the classic "header
 *    repeated" vs "header omitted on the continuation" cases both merge; a
 *    *different* header does not).
 *
 * Only the immediately-following page's *first* table is a merge candidate for a
 * `continues` table — a continuation always begins the next page. If that first
 * table does not match, the open table is closed unmerged and the page's table
 * is a fresh one.
 *
 * ## State and resume
 *
 * The only thing carried across a page boundary is the single open table (its
 * id, column count and header) — a small, JSON-serialisable value on
 * `docpass_state`, so a resume knows whether the page it restarts on is a
 * continuation (design §9a.2). Deterministic — no model, no I/O.
 */

import type { Cell, TableBlock } from "@atf/extract-contract/v2";

/** The minimal shape of the open table carried to the next page. */
export interface OpenTable {
  tableId: string;
  /** Column count = the widest header/data row's cell count. */
  columnCount: number;
  /** The normalised header signature, or null when the table had no header. */
  headerSignature: string | null;
  /** The page the open table's tail sat on. */
  page: number;
}

/** The persisted, JSON-serialisable table-merge state (design §9a.2). */
export interface TableMergeState {
  version: 1;
  /** The table left open (`continues`) by the previous page, or null. */
  open: OpenTable | null;
  /** Monotonic counter for minting fresh table ids. */
  seq: number;
}

/** An empty starting state. */
export function emptyTableMergeState(): TableMergeState {
  return { version: 1, open: null, seq: 0 };
}

/** Coerce an unknown persisted value back to a valid {@link TableMergeState}. */
export function parseTableMergeState(value: unknown): TableMergeState {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1
  ) {
    const v = value as Partial<TableMergeState>;
    const open =
      v.open !== null && typeof v.open === "object" && v.open !== undefined
        ? {
            tableId: String((v.open as OpenTable).tableId ?? ""),
            columnCount: Number((v.open as OpenTable).columnCount ?? 0),
            headerSignature:
              typeof (v.open as OpenTable).headerSignature === "string"
                ? (v.open as OpenTable).headerSignature
                : null,
            page: Number((v.open as OpenTable).page ?? 1),
          }
        : null;
    return { version: 1, open, seq: typeof v.seq === "number" ? v.seq : 0 };
  }
  return emptyTableMergeState();
}

/** The text of a cell, whether it is a bare string or a span object. */
function cellText(cell: Cell): string {
  return typeof cell === "string" ? cell : cell.text;
}

/** The number of columns a row spans (respecting colspans). */
function rowWidth(row: readonly Cell[]): number {
  let width = 0;
  for (const cell of row) {
    width += typeof cell === "string" ? 1 : (cell.colspan ?? 1);
  }
  return width;
}

/** The column count of a table: the widest of its header and data rows. */
export function tableColumnCount(table: Pick<TableBlock, "headerRows" | "rows">): number {
  let max = 0;
  for (const row of [...table.headerRows, ...table.rows]) {
    max = Math.max(max, rowWidth(row));
  }
  return max;
}

/**
 * A normalised signature of a table's header rows, or `null` when the table has
 * none. Lower-cased, whitespace-collapsed cell texts joined so a repeated
 * header matches regardless of incidental spacing, and a genuinely different
 * header does not.
 */
export function headerSignature(headerRows: readonly (readonly Cell[])[]): string | null {
  if (headerRows.length === 0) return null;
  const cells = headerRows.flatMap((row) =>
    row.map((c) => cellText(c).toLowerCase().replace(/\s+/g, " ").trim()),
  );
  // An all-empty header (a blank header row) is treated as "no header" so a
  // continuation with no header still matches it.
  if (cells.every((c) => c === "")) return null;
  // Join with a token that cannot appear in a normalised cell (\u001f, the ASCII
  // unit separator) so distinct headers never collide, without a control char
  // in a regex.
  return cells.join("\u001f");
}

/**
 * Decide whether a page's first table (`candidate`) is a continuation of the
 * previous page's open table (`open`). Requires the same column count and a
 * matching-or-absent header (requirement 9.2).
 */
export function tablesMerge(
  open: OpenTable,
  candidate: Pick<TableBlock, "headerRows" | "rows">,
): boolean {
  if (tableColumnCount(candidate) !== open.columnCount) return false;
  const candidateHeader = headerSignature(candidate.headerRows);
  // Header repeated (equal) or omitted on the continuation (null) both merge; a
  // different header does not.
  if (candidateHeader === null) return true;
  return candidateHeader === open.headerSignature;
}

/** The table builder's per-page surface. */
export interface TableMerger {
  /**
   * Assign ids to a page's tables in reading order, merging the first one into
   * the previous page's open table when it qualifies, and returning the id
   * mutations to apply to each table block. `pageContinues`/`pageContinuationOf`
   * are the model's per-table flags (parallel to `tables`, by index).
   *
   * Returns, per input table, the `tableId`, the `continuationOf` (set only on a
   * merged continuation), and whether it stays `continues` (open at page end).
   */
  observePage(
    tables: Array<Pick<TableBlock, "headerRows" | "rows">>,
    flags: Array<{ continues: boolean; continuationOf: boolean }>,
    page: number,
  ): Array<{ tableId: string; continuationOf?: string; continues: boolean }>;
  /** The current serialisable state, to persist on `docpass_state`. */
  snapshot(): TableMergeState;
}

/**
 * Create a table merger, optionally rehydrated from persisted state so a resume
 * knows whether its first page is a continuation (design §9a.2). Deterministic.
 */
export function createTableMerger(initial: TableMergeState = emptyTableMergeState()): TableMerger {
  const state = parseTableMergeState(initial);
  let open: OpenTable | null = state.open;
  let seq = state.seq;

  function mintId(page: number): string {
    seq += 1;
    return `t${page}-${seq}`;
  }

  function observePage(
    tables: Array<Pick<TableBlock, "headerRows" | "rows">>,
    flags: Array<{ continues: boolean; continuationOf: boolean }>,
    page: number,
  ): Array<{ tableId: string; continuationOf?: string; continues: boolean }> {
    const out: Array<{ tableId: string; continuationOf?: string; continues: boolean }> = [];

    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      if (table === undefined) continue;
      const flag = flags[i] ?? { continues: false, continuationOf: false };
      const isFirst = i === 0;

      let tableId: string;
      let continuationOf: string | undefined;

      // Only the FIRST table on a page can continue the previous page's open
      // table, and only when the structures match.
      if (isFirst && open !== null && tablesMerge(open, table)) {
        tableId = open.tableId;
        continuationOf = open.tableId;
        open = null; // consumed
      } else {
        tableId = mintId(page);
        // A non-first table (or a non-matching first) never continues; if the
        // previous page's table was still open and unmatched, it is now closed
        // unmerged (drop the reference).
        if (isFirst) open = null;
      }

      // Does THIS table stay open past this page?
      if (flag.continues) {
        open = {
          tableId,
          columnCount: tableColumnCount(table),
          headerSignature: headerSignature(table.headerRows),
          page,
        };
        out.push({ tableId, ...(continuationOf !== undefined ? { continuationOf } : {}), continues: true });
      } else {
        // If this was the open table's continuation and it does NOT itself
        // continue, the logical table is complete.
        out.push({ tableId, ...(continuationOf !== undefined ? { continuationOf } : {}), continues: false });
      }
    }

    // A page with no tables leaves any open table open (a continuation could
    // still be on a later page in some layouts) — but strictly, a page break
    // with intervening non-table content ends the table. The design's rule is
    // "the next page begins with a matching table"; an intervening page with
    // other content closes it. So: if this page had tables but none continued,
    // `open` is already cleared above; if the page had NO tables at all, close
    // any still-open table now.
    if (tables.length === 0) open = null;

    return out;
  }

  function snapshot(): TableMergeState {
    return { version: 1, open: open === null ? null : { ...open }, seq };
  }

  return { observePage, snapshot };
}
