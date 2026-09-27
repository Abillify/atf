// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { renderMarkdown, renderPage } from "../../src/index.js";
import { beginRecord, endRecord, figureBlock, pageRecord, stream } from "./fixtures.js";

describe("renderMarkdown", () => {
  test("renders only page records, in stream order", () => {
    const md = renderMarkdown(stream());
    expect(md).toContain("## Seite 1");
    expect(md).toContain("## Seite 2");
    expect(md.indexOf("## Seite 1")).toBeLessThan(md.indexOf("## Seite 2"));
    // document.begin/end carry no reading content beyond the title.
    expect(md).toContain("# Betriebsanleitung");
    expect(md).not.toContain("document.begin");
    expect(md).not.toContain("document.end");
  });

  test("renders a figure inline at its reading position, not hoisted", () => {
    const md = renderPage(
      pageRecord(1, {
        blocks: [
          { type: "paragraph", id: "b1", page: 1, text: "Fließtext vor der Maske." },
          figureBlock(1, 1),
        ],
      }),
    );
    // The paragraph precedes the figure — the D5 fix.
    expect(md.indexOf("Fließtext vor der Maske.")).toBeLessThan(md.indexOf("<figure"));
    expect(md).toContain('<figure id="p1-f1" kind="ui_mask" page="1"');
  });

  test("renders a fields transcription as a table with actions", () => {
    const md = renderPage(pageRecord(1, { blocks: [figureBlock(1, 1)] }));
    expect(md).toContain("| Bereich | Feld | Typ | Pflicht | Vorbelegung |");
    expect(md).toContain("| Kopf | Lieferant | Auswahl | ja |");
    expect(md).toContain("Aktionen: Speichern, Teilfreigabe, Abbrechen");
  });

  test("renders the page section path in the heading", () => {
    const md = renderPage(pageRecord(1));
    expect(md).toContain("## Seite 1 · 4 Wareneingang › 4.2 Anmeldung");
  });

  test("renders a process transcription as mermaid plus steps", () => {
    const md = renderPage(
      pageRecord(1, {
        blocks: [
          figureBlock(1, 1, {
            kind: "bpmn",
            transcription: {
              format: "process",
              mermaid: "graph TD; A-->B",
              nodes: [],
              edges: [],
              steps: ["Start", "Prüfen", "Ende"],
            },
          }),
        ],
      }),
    );
    expect(md).toContain("```mermaid");
    expect(md).toContain("graph TD; A-->B");
    expect(md).toContain("1. Start");
    expect(md).toContain("3. Ende");
  });

  test("renders a table block with header and a caption", () => {
    const md = renderPage(
      pageRecord(1, {
        blocks: [
          {
            type: "table",
            id: "t1",
            page: 1,
            tableId: "T1",
            caption: "Tabelle 1",
            headerRows: [["Merkmal", "Einheit"]],
            rows: [["Länge", "mm"]],
          },
        ],
      }),
    );
    expect(md).toContain("**Tabelle 1**");
    expect(md).toContain("| Merkmal | Einheit |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| Länge | mm |");
  });

  test("escapes pipes in table cells", () => {
    const md = renderPage(
      pageRecord(1, {
        blocks: [
          {
            type: "table",
            id: "t1",
            page: 1,
            tableId: "T1",
            headerRows: [["A"]],
            rows: [["a|b"]],
          },
        ],
      }),
    );
    expect(md).toContain("a\\|b");
  });

  test("restricts to requested pages, in the given order", () => {
    const records = [beginRecord(), pageRecord(1), pageRecord(2), endRecord()];
    const md = renderMarkdown(records, { pages: [2, 1], pageHeadings: true });
    expect(md.indexOf("## Seite 2")).toBeLessThan(md.indexOf("## Seite 1"));
  });

  test("can omit transcriptions", () => {
    const md = renderPage(pageRecord(1, { blocks: [figureBlock(1, 1)] }), {
      includeTranscriptions: false,
    });
    expect(md).toContain("<figure");
    expect(md).not.toContain("| Bereich | Feld |");
  });
});
