// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/table-bbox.ts
 *
 * Deterministic table-region location from the S2 text geometry.
 *
 * ## Why this exists
 *
 * A `table` block carries its cells (`headerRows`/`rows`) but no geometry: the
 * Pass-1 model flags table continuations, never a bbox, and neither the
 * Markdown mapping nor the document pass assigns one. Consumers that want to
 * SHOW a table — the operator console's figure gallery, a search UI offering a
 * page-region preview — therefore have nothing to crop. Figures get their box
 * from the model and refined by S4; a table's box can be recovered without any
 * model at all, because its cells ARE text-layer words: the S2 analysis
 * (`pdftotext -bbox-layout`, see {@link ./bbox-layout.ts}) already knows where
 * every word sits.
 *
 * ## The algorithm ({@link locateTableBBox})
 *
 *   1. Flatten the table to one normalised text per row (header rows first,
 *      cells joined single-spaced, spans reduced to their text).
 *   2. Walk the S2 lines top-to-bottom and match each row, in order, to the
 *      first line at or after the previous match whose normalised text
 *      CONTAINS the row text. Monotonic matching keeps a repeated row text
 *      (a header echoed elsewhere) from pulling the box around.
 *   3. Accept only a confident match: at least `max(2, 60 %)` of the rows (a
 *      one-row table needs its single row), and the matched line window spans
 *      at most `3 ×` the row count — a table whose rows wrap takes a few extra
 *      lines, but scattered matches across half the page are rejected rather
 *      than guessed.
 *   4. The bbox is the union of every S2 line between the first and last
 *      match, inclusive, so wrapped rows and multi-line cells stay inside.
 *
 * Deliberately conservative in both directions: a miss simply leaves the block
 * without a bbox (exactly the pre-existing behaviour — the console then shows
 * the cell grid), while a wrong box would render an unrelated page region as
 * "the table". Pure and deterministic: the same analysis always yields the same
 * box, so a resume or reparse rebuilds the identical record.
 */

import type { BBox, Cell, TableBlock } from "@atf/extract-contract/v2";
import type { PageAnalysis } from "./bbox-layout.js";

/** Fraction of the table's rows that must match a line for a confident box. */
const MIN_MATCH_RATIO = 0.6;

/** How many S2 lines per table row the matched window may span (row wrapping). */
const MAX_WINDOW_ROWS = 3;

/** Collapse whitespace and case so S2 word-joins and Markdown cells compare. */
function norm(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A table row as one normalised text: cells (spans reduced) single-spaced. */
function rowText(row: readonly Cell[]): string {
  return norm(row.map((c) => (typeof c === "string" ? c : c.text)).join(" "));
}

/** The union of two normalised boxes. */
function unionBBox(a: BBox, b: BBox): BBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/**
 * Locate a table block's region in the page's S2 geometry. Returns the union
 * bbox of the S2 lines the table's rows matched on, or `undefined` when there
 * is no geometry, no confident row match, or the matched window is implausibly
 * wide. Never throws.
 */
export function locateTableBBox(
  table: Pick<TableBlock, "headerRows" | "rows">,
  analysis: PageAnalysis | null | undefined,
): BBox | undefined {
  if (analysis == null || analysis.lines.length === 0) return undefined;
  const rowTexts = [...table.headerRows, ...table.rows]
    .map(rowText)
    .filter((t) => t !== "");
  if (rowTexts.length === 0) return undefined;

  const lineTexts = analysis.lines.map((l) => norm(l.text));

  // Monotonic greedy scan: each row matches the first line at or after the
  // previous match that contains it. A row that matches nothing is skipped —
  // the ratio check below decides whether enough of the table was found.
  const matched: number[] = [];
  let from = 0;
  for (const row of rowTexts) {
    for (let i = from; i < lineTexts.length; i++) {
      if (lineTexts[i]?.includes(row) === true) {
        matched.push(i);
        from = i + 1;
        break;
      }
    }
  }
  const minMatched =
    rowTexts.length === 1 ? 1 : Math.max(2, Math.ceil(rowTexts.length * MIN_MATCH_RATIO));
  if (matched.length < minMatched) return undefined;

  const first = matched[0] as number;
  const last = matched[matched.length - 1] as number;
  if (last - first + 1 > rowTexts.length * MAX_WINDOW_ROWS) return undefined;

  let box: BBox | undefined;
  for (let i = first; i <= last; i++) {
    const line = analysis.lines[i];
    if (line === undefined) continue;
    box = box === undefined ? [...line.bbox] : unionBBox(box, line.bbox);
  }
  if (box === undefined || box[2] <= box[0] || box[3] <= box[1]) return undefined;
  return box;
}
