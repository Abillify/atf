// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * tile-merge.test.ts
 *
 * Merging the per-tile transcriptions of a tiled large-format page — the pure
 * half of S6 (design §5 S6, task 5.1, requirement 8.5).
 *
 * The merge is a pure function of the tiles' transcriptions, so these tests
 * drive it with synthetic transcriptions and assert the overlap-band dedup.
 *
 * Covers:
 *  - drawing tiles union their fields and dedupe overlap-doubled content
 *  - title-block keys take the first non-empty value
 *  - a parts-list row repeated across the seam collapses to one
 *  - non-drawing tiles fall back to a deduplicated markdown transcription
 *  - no usable tiles yields an empty drawing transcription
 */

import { describe, expect, it } from "vitest";
import type { Transcription } from "@atf/extract-contract/v2";
import { mergeTileTranscriptions } from "../src/pipeline/tile-merge.js";

function drawing(fields: Partial<Extract<Transcription, { format: "drawing" }>>): Transcription {
  return { format: "drawing", titleBlock: {}, ...fields };
}

describe("mergeTileTranscriptions: drawing tiles", () => {
  it("unions fields and dedupes the overlap band", () => {
    const merged = mergeTileTranscriptions([
      {
        tileId: "r0c0",
        transcription: drawing({
          titleBlock: { drawingNo: "PL-100", rev: "" },
          legend: ["A = Achse", "B = Bohrung"],
          dimensions: ["1200 mm"],
          notes: ["Alle Maße in mm"],
        }),
      },
      {
        tileId: "r0c1",
        transcription: drawing({
          // Overlap band repeats "B = Bohrung" and the mm note; a new legend row.
          titleBlock: { drawingNo: "PL-100", rev: "C" },
          legend: ["B = Bohrung", "C = Schnitt"],
          dimensions: ["800 mm"],
          notes: ["Alle Maße in mm"],
        }),
      },
    ]);

    expect(merged.format).toBe("drawing");
    if (merged.format !== "drawing") return;
    // First non-empty title-block value per key wins (rev filled by the 2nd tile).
    expect(merged.titleBlock).toEqual({ drawingNo: "PL-100", rev: "C" });
    // Legend deduped, order preserved, no doubled "B = Bohrung".
    expect(merged.legend).toEqual(["A = Achse", "B = Bohrung", "C = Schnitt"]);
    expect(merged.dimensions).toEqual(["1200 mm", "800 mm"]);
    // The mm note appeared in both tiles → once after dedup.
    expect(merged.notes).toEqual(["Alle Maße in mm"]);
  });

  it("collapses a parts-list row repeated across the seam", () => {
    const row = ["1", "Schraube M8", "4"];
    const merged = mergeTileTranscriptions([
      { tileId: "r0c0", transcription: drawing({ partsList: [row, ["2", "Mutter M8", "4"]] }) },
      { tileId: "r0c1", transcription: drawing({ partsList: [row] }) }, // seam repeat
    ]);
    if (merged.format !== "drawing") throw new Error("expected drawing");
    expect(merged.partsList).toEqual([
      ["1", "Schraube M8", "4"],
      ["2", "Mutter M8", "4"],
    ]);
  });

  it("ignores whitespace and case when deduping overlap lines", () => {
    const merged = mergeTileTranscriptions([
      { tileId: "r0c0", transcription: drawing({ notes: ["Hinweis 1"] }) },
      { tileId: "r0c1", transcription: drawing({ notes: ["  hinweis   1 "] }) },
    ]);
    if (merged.format !== "drawing") throw new Error("expected drawing");
    expect(merged.notes).toEqual(["Hinweis 1"]);
  });
});

describe("mergeTileTranscriptions: fallbacks", () => {
  it("folds non-drawing tile text into a drawing's notes when a drawing is present", () => {
    const merged = mergeTileTranscriptions([
      { tileId: "r0c0", transcription: drawing({ notes: ["Plan"] }) },
      { tileId: "r0c1", transcription: { format: "markdown", text: "freie Notiz" } },
    ]);
    if (merged.format !== "drawing") throw new Error("expected drawing");
    expect(merged.notes).toEqual(["Plan", "freie Notiz"]);
  });

  it("returns a deduplicated markdown transcription when no tile is a drawing", () => {
    const merged = mergeTileTranscriptions([
      { tileId: "r0c0", transcription: { format: "markdown", text: "Zeile A\nZeile B" } },
      { tileId: "r0c1", transcription: { format: "markdown", text: "Zeile B\nZeile C" } },
    ]);
    expect(merged.format).toBe("markdown");
    if (merged.format !== "markdown") return;
    expect(merged.text).toBe("Zeile A\nZeile B\nZeile C");
  });

  it("returns an empty drawing when there are no usable tiles", () => {
    const merged = mergeTileTranscriptions([
      { tileId: "r0c0", transcription: undefined },
      { tileId: "r0c1", transcription: undefined },
    ]);
    expect(merged).toEqual({ format: "drawing", titleBlock: {} });
  });
});
