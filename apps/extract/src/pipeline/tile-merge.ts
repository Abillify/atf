// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/tile-merge.ts
 *
 * Merge the per-tile transcriptions of a tiled large-format page into one page
 * transcription — the pure half of stage **S6 "tiled"** (design §5 S6, task
 * 5.1, requirement 8.5).
 *
 * ## Why this exists
 *
 * S6 splits a plan into an N×M grid of overlapping tiles (`tiling.ts`) and
 * transcribes each tile on its own. A symbol, a dimension or a legend row that
 * straddles a seam therefore appears in two adjacent tiles — once whole, twice
 * partial — because of the 10 % overlap band. This module reassembles the tiles
 * into a single {@link Transcription} and removes that doubled content, so the
 * emitted figure reads like one plan, not a mosaic of repeated fragments.
 *
 * ## Determinism and purity
 *
 * The merge is a pure function of the tiles' transcriptions in grid order: no
 * IO, no model call, no clock. That is what lets it live inside the tiled stage
 * as a deterministic post-step and be unit-tested with synthetic transcriptions.
 *
 * ## The merge, by format
 *
 * A large drawing's tiles are `drawing` transcriptions (the tiling stage runs
 * the technical-drawing prompt on each tile). The drawing merge unions the
 * title block (first non-empty value per key wins), concatenates the parts list
 * (deduping identical rows), and unions the legend / dimensions / views / notes
 * as ordered, deduplicated string lists. Tiles whose transcription parsed to a
 * different format (a rare mixed page) fall back to a `markdown` transcription
 * that concatenates each tile's flattened text, still deduplicated line by line
 * so the overlap band does not double the output.
 */

import type { Cell, Transcription } from "@atf/extract-contract/v2";

/** One tile's contribution to the merge: its transcription (in grid order). */
export interface TileContribution {
  /** Grid tile id, e.g. `r0c1`, for stable ordering and logging. */
  tileId: string;
  /** The tile's parsed transcription, or `undefined` when the tile had none. */
  transcription: Transcription | undefined;
}

/**
 * Merge per-tile transcriptions into one page transcription (design §5 S6). The
 * tiles are taken in the order given (the tiling grid emits row-major order).
 *
 * Returns a single {@link Transcription}:
 *  - a `drawing` when at least one tile produced a `drawing` (the common case
 *    for a plan), unioning every tile's drawing fields and deduping the overlap;
 *  - otherwise a `markdown` transcription concatenating the tiles' flattened
 *    text, deduplicated line by line.
 *
 * With no usable tiles it returns an empty `drawing` transcription, so a caller
 * always gets a valid transcription to attach to the page's figure.
 */
export function mergeTileTranscriptions(tiles: readonly TileContribution[]): Transcription {
  const present = tiles
    .map((t) => t.transcription)
    .filter((t): t is Transcription => t !== undefined);

  // No usable tiles: an empty drawing (a tiled page is a plan by intent), so the
  // caller always attaches a valid, format-stable transcription.
  if (present.length === 0) return { format: "drawing", titleBlock: {} };

  const drawings = present.filter((t): t is Extract<Transcription, { format: "drawing" }> =>
    t.format === "drawing",
  );

  if (drawings.length > 0) {
    return mergeDrawings(drawings, present);
  }

  // Present but no drawing tiles: concatenate the flattened text, deduped by line.
  const text = dedupeLines(present.flatMap((t) => flatten(t))).join("\n");
  return { format: "markdown", text };
}

/**
 * Merge every `drawing` tile (plus any non-drawing tiles' text, folded into
 * `notes`) into one drawing transcription, deduplicating the overlap band.
 */
function mergeDrawings(
  drawings: readonly Extract<Transcription, { format: "drawing" }>[],
  all: readonly Transcription[],
): Transcription {
  const titleBlock: Record<string, string> = {};
  for (const d of drawings) {
    for (const [key, value] of Object.entries(d.titleBlock)) {
      // First non-empty value for a key wins; a later tile does not overwrite.
      if (titleBlock[key] === undefined || titleBlock[key] === "") {
        if (value !== undefined && value !== "") titleBlock[key] = value;
      }
    }
  }

  const partsList = dedupeRows(drawings.flatMap((d) => d.partsList ?? []));
  const legend = dedupeLines(drawings.flatMap((d) => d.legend ?? []));
  const dimensions = dedupeLines(drawings.flatMap((d) => d.dimensions ?? []));
  const views = dedupeLines(drawings.flatMap((d) => d.views ?? []));

  // Notes carry each drawing tile's own notes plus the flattened text of any
  // non-drawing tile, so nothing a tile transcribed is silently dropped.
  const drawingNotes = drawings.flatMap((d) => d.notes ?? []);
  const nonDrawingText = all
    .filter((t) => t.format !== "drawing")
    .flatMap((t) => flatten(t));
  const notes = dedupeLines([...drawingNotes, ...nonDrawingText]);

  return {
    format: "drawing",
    titleBlock,
    ...(partsList.length > 0 ? { partsList } : {}),
    ...(legend.length > 0 ? { legend } : {}),
    ...(dimensions.length > 0 ? { dimensions } : {}),
    ...(views.length > 0 ? { views } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** Whitespace-normalise a string for comparison (not for output). */
function normalise(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Deduplicate a list of strings, preserving the first occurrence's original
 * text and order. Whitespace and case are ignored for the equality test so an
 * overlap-band repeat with cosmetic differences still collapses.
 */
function dedupeLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = normalise(line);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(line.trim());
  }
  return out;
}

/**
 * Deduplicate table rows by their normalised joined cells, preserving the first
 * occurrence and order. A parts-list row repeated across the overlap band
 * (identical cell text) collapses to one.
 */
function dedupeRows(rows: readonly Cell[][]): Cell[][] {
  const seen = new Set<string>();
  const out: Cell[][] = [];
  for (const row of rows) {
    const cells = row.map((c) => normalise(cellText(c)));
    // Skip a wholly empty row (every cell blank) and any exact repeat.
    if (cells.every((c) => c === "")) continue;
    const key = cells.join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** A cell may be a plain string or `{ text }`-shaped; read its text either way. */
function cellText(cell: Cell): string {
  if (typeof cell === "string") return cell;
  if (cell !== null && typeof cell === "object" && "text" in cell) {
    const text = (cell as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

/** Flatten every text-bearing field of a transcription into lines. */
function flatten(transcription: Transcription): string[] {
  switch (transcription.format) {
    case "process":
      return [
        ...transcription.nodes.map((n) => n.label),
        ...transcription.steps,
        ...(transcription.lanes ?? []),
      ];
    case "fields":
      return [
        ...transcription.areas.flatMap((a) => [a.name, ...a.fields.map((f) => f.label)]),
        ...transcription.actions,
        ...(transcription.messages ?? []),
      ];
    case "drawing":
      return [
        ...Object.values(transcription.titleBlock),
        ...(transcription.partsList ?? []).flatMap((r) => r.map(cellText)),
        ...(transcription.legend ?? []),
        ...(transcription.dimensions ?? []),
        ...(transcription.views ?? []),
        ...(transcription.notes ?? []),
      ];
    case "data":
      return transcription.table.flatMap((r) => r.map(cellText));
    case "markdown":
      return transcription.text.split(/\r?\n/);
  }
}
