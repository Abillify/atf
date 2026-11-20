// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * table-bbox.test.ts — the deterministic table-region locator against a
 * synthetic S2 analysis: confident matches produce the union box of the
 * matched line window; ambiguous, sparse, or missing geometry produces none.
 */

import { describe, expect, it } from "vitest";
import type { BBox, Cell } from "@atf/extract-contract/v2";
import type { AnalyzedLine, PageAnalysis } from "../src/pipeline/bbox-layout.js";
import { locateTableBBox } from "../src/pipeline/table-bbox.js";

function line(text: string, x1: number, y: number, x2: number): AnalyzedLine {
  const bbox: BBox = [x1, y, x2, y + 0.02];
  return {
    words: text.split(" ").map((t, i) => ({
      text: t,
      bbox: [x1 + i * 0.05, y, x1 + i * 0.05 + 0.04, y + 0.02] as BBox,
    })),
    bbox,
    text,
    height: 0.02,
  };
}

function analysis(lines: AnalyzedLine[]): PageAnalysis {
  return {
    page: 1,
    size: { widthPt: 595, heightPt: 842 },
    blocks: lines.map((l) => ({ lines: [l], bbox: l.bbox, text: l.text })),
    lines,
    words: lines.flatMap((l) => l.words),
    headingCandidates: [],
  };
}

const table = (headerRows: Cell[][], rows: Cell[][]) => ({ headerRows, rows });

/** The box is a union of floats, so its edges are compared with a tolerance. */
function expectBox(actual: BBox | undefined, expected: BBox): void {
  expect(actual).toBeDefined();
  const box = actual as BBox;
  for (let i = 0; i < 4; i++) {
    expect(box[i]).toBeCloseTo(expected[i] as number, 10);
  }
}

describe("locateTableBBox", () => {
  it("returns the union box of the matched line window", () => {
    const a = analysis([
      line("1 Einleitung", 0.1, 0.1, 0.5),
      line("Betrag Datum", 0.1, 0.3, 0.6),
      line("10,00 01.02.", 0.1, 0.33, 0.55),
      line("20,00 02.02.", 0.1, 0.36, 0.55),
      line("Abschluss der Tabelle", 0.1, 0.6, 0.7),
    ]);
    const bbox = locateTableBBox(
      table([["Betrag", "Datum"]], [["10,00", "01.02."], ["20,00", "02.02."]]),
      a,
    );
    expectBox(bbox, [0.1, 0.3, 0.6, 0.38]);
  });

  it("includes wrapped lines between the first and last match", () => {
    const a = analysis([
      line("Betrag Datum", 0.1, 0.3, 0.6),
      line("10,00 01.02. mit", 0.1, 0.33, 0.7),
      line("langem Hinweis", 0.1, 0.35, 0.5),
      line("20,00 02.02.", 0.1, 0.37, 0.55),
    ]);
    const bbox = locateTableBBox(
      table([["Betrag", "Datum"]], [["10,00 01.02. mit langem Hinweis"], ["20,00", "02.02."]]),
      a,
    );
    expectBox(bbox, [0.1, 0.3, 0.7, 0.39]);
  });

  it("tolerates whitespace and case differences between cells and lines", () => {
    const a = analysis([
      line("Betrag   DATUM", 0.1, 0.3, 0.6),
      line("10,00 01.02.", 0.1, 0.33, 0.55),
    ]);
    expectBox(
      locateTableBBox(table([["betrag", "datum"]], [["10,00", "01.02."]]), a),
      [0.1, 0.3, 0.6, 0.35],
    );
  });

  it("anchors on the first row match and extends to the last, never backwards", () => {
    const a = analysis([
      line("total menge", 0.1, 0.1, 0.4),
      line("zwischentext", 0.1, 0.2, 0.5),
      line("total menge", 0.1, 0.3, 0.4),
      line("zeile eins", 0.1, 0.33, 0.4),
      line("zeile zwei", 0.1, 0.36, 0.4),
    ]);
    const bbox = locateTableBBox(
      table([["Total", "Menge"]], [["zeile eins"], ["zeile zwei"]]),
      a,
    );
    // Greedy from the first row: the window spans the first header occurrence
    // to the last data row (still inside the width limit), and never reaches
    // back above the first match.
    expectBox(bbox, [0.1, 0.1, 0.5, 0.38]);
  });

  it("rejects a table whose rows match only sparsely", () => {
    const a = analysis([
      line("Betrag Datum", 0.1, 0.3, 0.6),
      line("völlig anderer text", 0.1, 0.4, 0.7),
      line("noch mehr text", 0.1, 0.5, 0.7),
      line("10,00 01.02.", 0.1, 0.8, 0.5),
    ]);
    expect(
      locateTableBBox(
        table(
          [["Betrag", "Datum"]],
          [["10,00", "01.02."], ["20,00", "02.02."], ["30,00", "03.02."]],
        ),
        a,
      ),
    ).toBeUndefined();
  });

  it("rejects a matched window far wider than the row count", () => {
    const lines = [line("a b", 0.1, 0.1, 0.3)];
    for (let i = 0; i < 10; i++) lines.push(line(`filler ${i}`, 0.1, 0.15 + i * 0.02, 0.4));
    lines.push(line("c d", 0.1, 0.9, 0.3));
    const bbox = locateTableBBox(table([], [["a", "b"], ["c", "d"]]), analysis(lines));
    expect(bbox).toBeUndefined();
  });

  it("requires the single row of a one-row table to match", () => {
    const a = analysis([line("einzige zeile", 0.2, 0.4, 0.8)]);
    expectBox(locateTableBBox(table([], [["einzige zeile"]]), a), [0.2, 0.4, 0.8, 0.42]);
    expect(locateTableBBox(table([], [["andere zeile"]]), a)).toBeUndefined();
  });

  it("returns undefined without geometry", () => {
    const t = table([["A"]], [["1"]]);
    expect(locateTableBBox(t, null)).toBeUndefined();
    expect(locateTableBBox(t, undefined)).toBeUndefined();
    expect(locateTableBBox(t, analysis([]))).toBeUndefined();
  });

  it("returns undefined for a table with no textual rows", () => {
    expect(locateTableBBox(table([[""]], [[" "]]), analysis([line("x", 0.1, 0.1, 0.2)]))).toBeUndefined();
  });

  it("reduces spanned cells to their text for matching", () => {
    const a = analysis([
      line("kopf wert", 0.1, 0.3, 0.5),
      line("span zelle", 0.1, 0.33, 0.5),
    ]);
    const bbox = locateTableBBox(
      table([[{ text: "kopf", colspan: 2 }, "wert"]], [[{ text: "span zelle", rowspan: 2 }]]),
      a,
    );
    expectBox(bbox, [0.1, 0.3, 0.5, 0.35]);
  });
});
