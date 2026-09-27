// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * markdown-blocks.test.ts
 *
 * The deterministic Pass-1 Markdown → typed v2 block parser (design §4, §5 S3;
 * requirements 8.1, 9.1, 9.2): headings with numbering, lists, HTML tables
 * with rowspan/colspan and continuation flags, figure positions in the reading
 * order, code, and contract validity of every produced block.
 */

import { describe, expect, it } from "vitest";
import { blockSchema, type Block, type TableBlock } from "@atf/extract-contract/v2";
import {
  CONTINUATION_MARKER,
  markdownToBlocks,
  parseMarkdownBlocks,
  tableHeaderText,
} from "../src/pipeline/markdown-blocks.js";

const opts = { page: 3, source: "vision" as const };

function blocks(md: string): Block[] {
  return markdownToBlocks(md, opts);
}

describe("markdown-blocks · headings", () => {
  it("maps ATX headings to heading blocks with level and numbering", () => {
    const out = blocks("# 4 Wareneingang\n\n## 4.2. Anmeldung\n\n### Ohne Nummer ###");
    expect(out).toEqual([
      { id: "p3-b1", page: 3, source: "vision", type: "heading", level: 1, numbering: "4", text: "Wareneingang" },
      { id: "p3-b2", page: 3, source: "vision", type: "heading", level: 2, numbering: "4.2", text: "Anmeldung" },
      { id: "p3-b3", page: 3, source: "vision", type: "heading", level: 3, text: "Ohne Nummer" },
    ]);
  });

  it("keeps a year-like leading number as text, and recognises setext headings", () => {
    const out = blocks("2024 Rückblick\n===\n\nText danach");
    expect(out[0]).toMatchObject({ type: "heading", level: 1, text: "2024 Rückblick" });
    expect((out[0] as { numbering?: string }).numbering).toBeUndefined();
    expect(out[1]).toMatchObject({ type: "paragraph", text: "Text danach" });
  });

  it("does not treat a number-only heading as numbering", () => {
    const out = blocks("## 12");
    expect(out[0]).toMatchObject({ type: "heading", text: "12" });
  });
});

describe("markdown-blocks · paragraphs, lists, code", () => {
  it("splits paragraphs on blank lines and keeps soft line breaks", () => {
    const out = blocks("Zeile eins\nZeile zwei\n\nZweiter Absatz");
    expect(out.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect((out[0] as { text: string }).text).toBe("Zeile eins\nZeile zwei");
  });

  it("maps bullet and ordered lists, flattening nested items", () => {
    const out = blocks("- Eins\n- Zwei\n  - Zwei a\n  fortgesetzt\n\n1. Erstens\n2) Zweitens");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "list", items: ["Eins", "Zwei", "Zwei a fortgesetzt"] });
    expect((out[0] as { ordered?: boolean }).ordered).toBeUndefined();
    expect(out[1]).toMatchObject({ type: "list", ordered: true, items: ["Erstens", "Zweitens"] });
  });

  it("keeps a list across a blank line when the next item continues it", () => {
    const out = blocks("- a\n\n- b\n\nAbsatz");
    expect(out[0]).toMatchObject({ type: "list", items: ["a", "b"] });
    expect(out[1]).toMatchObject({ type: "paragraph", text: "Absatz" });
  });

  it("maps fenced code verbatim and does not interpret its content", () => {
    const out = blocks("```ts\n# not a heading\n<table><tr><td>x</td></tr></table>\n```\nnach");
    expect(out[0]).toMatchObject({
      type: "code",
      text: "# not a heading\n<table><tr><td>x</td></tr></table>",
    });
    expect(out[1]).toMatchObject({ type: "paragraph", text: "nach" });
  });

  it("maps a footnote definition to a footnote block", () => {
    const out = blocks("Text[^1]\n\n[^1]: Die Fußnote.");
    expect(out[1]).toMatchObject({ type: "footnote", text: "[^1]: Die Fußnote." });
  });
});

describe("markdown-blocks · HTML tables", () => {
  const html = `<table data-continues="true">
<thead><tr><th rowspan="2">Art.-Nr.</th><th colspan="2">Menge</th></tr>
<tr><th>Soll</th><th>Ist</th></tr></thead>
<tbody>
<tr><td>BA2b</td><td>10</td><td>9&nbsp;Stk</td></tr>
<tr><td colspan="3">Summe &amp; Rest<br>zweite Zeile</td></tr>
</tbody></table>`;

  it("keeps header rows and cells with rowspan/colspan", () => {
    const [table] = blocks(html) as TableBlock[];
    expect(table?.type).toBe("table");
    expect(table?.headerRows).toEqual([
      [{ text: "Art.-Nr.", rowspan: 2 }, { text: "Menge", colspan: 2 }],
      ["Soll", "Ist"],
    ]);
    expect(table?.rows).toEqual([
      ["BA2b", "10", "9 Stk"],
      [{ text: "Summe & Rest zweite Zeile", colspan: 3 }],
    ]);
    expect(table?.continues).toBe(true);
    expect(table?.continuationOf).toBeUndefined();
    expect(table?.tableId).toBe("p3-t1");
    expect(tableHeaderText(table as TableBlock)).toBe("Art.-Nr. | Menge");
  });

  it("reads data-continuation as a continuation marker and all-th first rows as header", () => {
    const [table] = blocks(
      "<table data-continuation><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    ) as TableBlock[];
    expect(table?.continuationOf).toBe(CONTINUATION_MARKER);
    expect(table?.continues).toBeUndefined();
    expect(table?.headerRows).toEqual([["A", "B"]]);
    expect(table?.rows).toEqual([["1", "2"]]);
  });

  it("tolerates missing <tr>/closing tags and an unclosed table", () => {
    const [table] = blocks("<table><td>a<td>b</table>") as TableBlock[];
    expect(table?.rows).toEqual([["a", "b"]]);
    const [truncated] = blocks("<table><tr><td>x</td><td>y") as TableBlock[];
    expect(truncated?.rows).toEqual([["x", "y"]]);
  });

  it("keeps text around an inline table in reading order", () => {
    const out = blocks("Vorher <table><tr><td>x</td></tr></table> nachher");
    expect(out.map((b) => b.type)).toEqual(["paragraph", "table", "paragraph"]);
  });

  it("maps a GFM pipe table with the first row as header", () => {
    const [table] = blocks("| A | B \\| C |\n|---|:--:|\n| 1 | 2 |\n| 3 | 4 |") as TableBlock[];
    expect(table?.headerRows).toEqual([["A", "B | C"]]);
    expect(table?.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("markdown-blocks · figure positions and ids", () => {
  it("reports figure placeholders at their position in the reading order", () => {
    const { items } = parseMarkdownBlocks(
      "# 1 Titel\n\nText vor der Abbildung ![figure_p3-f1] Text danach\n\n![figure_p3-f2]\n\nSchluss",
      opts,
    );
    expect(items.map((i) => (i.kind === "figure" ? `fig:${i.figureId}` : i.block.type))).toEqual([
      "heading",
      "paragraph",
      "fig:p3-f1",
      "paragraph",
      "fig:p3-f2",
      "paragraph",
    ]);
  });

  it("numbers blocks p{page}-b{n} deterministically and every block is contract-valid", () => {
    const md = "# 2 A\n\n- x\n\n<table><tr><td>1</td></tr></table>\n\n```\ncode\n```\n\nEnde";
    const first = blocks(md);
    const second = blocks(md);
    expect(first).toEqual(second);
    expect(first.map((b) => b.id)).toEqual(["p3-b1", "p3-b2", "p3-b3", "p3-b4", "p3-b5"]);
    for (const block of first) expect(blockSchema.safeParse(block).success).toBe(true);
  });

  it("returns no blocks for an empty body", () => {
    expect(blocks("   \n\n")).toEqual([]);
  });
});
