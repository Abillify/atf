// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure-logic tests for the full multi-level unit builder. These need
 * no database: they pin what the batch worker turns v2 records into —
 *
 *   - chunk units are 350–500 tokens (via a stubbed token counter) and never
 *     cross a section boundary (Req 11.2);
 *   - a table under budget → one `table` unit with a "Spalte: Wert" FTS text; a
 *     table over budget → row-groups that repeat the header, share a `tableId`
 *     and are linked prev/next (Req 11.3);
 *   - a figure unit carries caption + description + transcription + labels;
 *   - section/page/document units are built from the document.end summaries /
 *     outline with the right parent links;
 *   - parent/prev/next/figure_refs/block_ids are populated;
 *   - the `unit_id` is DETERMINISTIC so reprocessing upserts in place (Req 5.5).
 */

import { describe, expect, it } from "vitest";
import type {
  Block,
  DocumentEndRecord,
  PageRecord,
} from "@atf/extract-contract";
import {
  buildUnitsFromRecords,
  computeUnitId,
  heuristicTokenCounter,
  renderFigureText,
  renderTableColumnValue,
  renderTableRows,
  type BuildUnitsInput,
  type IndexUnit,
  type UnitTokenCounter,
} from "../src/batch-unit-builder.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A page with the given blocks; fills the required non-block fields. */
function page(pageNo: number, blocks: Block[]): PageRecord {
  return {
    type: "page",
    page: pageNo,
    size: { wPt: 595, hPt: 842 },
    class: "text",
    blocks,
    assets: [],
    warnings: [],
  };
}

/**
 * A token counter that returns a FIXED number of tokens per text. Used to drive
 * chunk sizing deterministically without a tokenizer: e.g. tokensPerText = 200
 * makes each ~char-chunk worth 200 tokens, so the packer needs two to reach the
 * 350 lower bound.
 */
function fixedCounter(tokensPerText: number): UnitTokenCounter {
  return {
    countBatch: (texts) => Promise.resolve(texts.map(() => tokensPerText)),
  };
}

function input(
  pages: PageRecord[],
  overrides: Partial<BuildUnitsInput> = {},
): BuildUnitsInput {
  return {
    revisionId: "rev-1",
    reference: "akte/doc.pdf",
    documentId: "akte/doc.pdf",
    pages,
    tokenCounter: heuristicTokenCounter,
    ...overrides,
  };
}

const byType = (units: IndexUnit[], type: IndexUnit["unitType"]): IndexUnit[] =>
  units.filter((u) => u.unitType === type);

// ─── chunk units ─────────────────────────────────────────────────────────────

describe("buildUnitsFromRecords — chunk units", () => {
  it("turns text blocks into a chunk unit with page + block provenance", async () => {
    const units = await buildUnitsFromRecords(
      input([
        page(1, [
          { type: "heading", id: "b1", page: 1, level: 1, text: "Einleitung", sectionPath: ["1 Einleitung"] },
          { type: "paragraph", id: "b2", page: 1, text: "Dies ist ein Absatz mit Inhalt.", sectionPath: ["1 Einleitung"] },
        ]),
      ]),
    );
    const chunks = byType(units, "chunk");
    expect(chunks).toHaveLength(1);
    const [chunk] = chunks;
    expect(chunk?.content).toContain("Einleitung");
    expect(chunk?.content).toContain("Absatz mit Inhalt");
    expect(chunk?.pageStart).toBe(1);
    expect(chunk?.blockIds).toEqual(["b1", "b2"]);
    expect(chunk?.sectionPath).toEqual(["1 Einleitung"]);
    expect(chunk?.sectionId).toBe("1 Einleitung");
  });

  it("sizes chunks to 350–500 tokens using the token counter", async () => {
    // A long paragraph. With the fixed counter each char-chunk is 200 tokens,
    // so two are packed per unit (400 tokens, within [350,500]); a lone tail
    // candidate under the min is flushed as the last chunk.
    const long = Array.from({ length: 400 }, (_, i) => `Satz ${i} mit Fülltext.`).join(" ");
    const units = await buildUnitsFromRecords(
      input([page(1, [{ type: "paragraph", id: "b1", page: 1, text: long, sectionPath: ["1"] }])], {
        tokenCounter: fixedCounter(200),
        minChunkTokens: 350,
        maxChunkTokens: 500,
      }),
    );
    const chunks = byType(units, "chunk");
    expect(chunks.length).toBeGreaterThan(1);
    // Every full-sized chunk packs exactly two 200-token candidates → 400 tokens.
    // The packer never exceeds the 500 max.
    for (const c of chunks) {
      // A packed chunk contains 1 or 2 candidates; 3 would be 600 > max.
      const candidateCount = c.content.split("\n\n").length;
      expect(candidateCount).toBeLessThanOrEqual(2);
    }
  });

  it("never lets a chunk cross a section boundary (Req 11.2)", async () => {
    const units = await buildUnitsFromRecords(
      input([
        page(1, [
          { type: "paragraph", id: "b1", page: 1, text: "Abschnitt eins Inhalt.", sectionPath: ["1 A"] },
          { type: "paragraph", id: "b2", page: 1, text: "Abschnitt zwei Inhalt.", sectionPath: ["2 B"] },
        ]),
      ]),
    );
    const chunks = byType(units, "chunk");
    // Two sections → at least two chunks, each single-section.
    expect(chunks.length).toBe(2);
    const first = chunks.find((c) => c.sectionPath[0] === "1 A");
    const second = chunks.find((c) => c.sectionPath[0] === "2 B");
    expect(first?.content).toContain("eins");
    expect(first?.content).not.toContain("zwei");
    expect(second?.content).toContain("zwei");
    expect(second?.content).not.toContain("eins");
  });

  it("keeps a block bigger than the budget as its own oversize chunk", async () => {
    const units = await buildUnitsFromRecords(
      input([page(1, [{ type: "paragraph", id: "b1", page: 1, text: "Kurz.", sectionPath: ["1"] }])], {
        // One candidate, already over budget → emitted standalone, not split.
        tokenCounter: fixedCounter(800),
        maxChunkTokens: 500,
      }),
    );
    const chunks = byType(units, "chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain("Kurz.");
  });

  it("links adjacent chunks in a section prev/next", async () => {
    // Long enough to split into several char-candidates (targetChars ≈ 1700),
    // so the token packer produces multiple ordered chunk units.
    const long = Array.from({ length: 600 }, (_, i) => `Satz Nummer ${i} mit etwas Fülltext.`).join(" ");
    const units = await buildUnitsFromRecords(
      input([page(1, [{ type: "paragraph", id: "b1", page: 1, text: long, sectionPath: ["1"] }])], {
        tokenCounter: fixedCounter(400),
        minChunkTokens: 350,
        maxChunkTokens: 500,
      }),
    );
    const chunks = byType(units, "chunk").sort((a, b) => a.ordinal - b.ordinal);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.prevUnitId).toBeUndefined();
    expect(chunks[0]?.nextUnitId).toBe(chunks[1]?.unitId);
    expect(chunks[1]?.prevUnitId).toBe(chunks[0]?.unitId);
    expect(chunks[chunks.length - 1]?.nextUnitId).toBeUndefined();
  });

  it("attaches figure_refs to a text chunk that references a figure", async () => {
    const units = await buildUnitsFromRecords(
      input([
        page(1, [
          {
            type: "paragraph",
            id: "b1",
            page: 1,
            text: "Siehe Abbildung 1.",
            sectionPath: ["1"],
            refs: [{ kind: "figure", text: "Abbildung 1", target: "p1-f1" }],
          },
        ]),
      ]),
    );
    const [chunk] = byType(units, "chunk");
    expect(chunk?.figureRefs).toEqual(["p1-f1"]);
  });
});

// ─── table units (Req 11.3) ────────────────────────────────────────────────────

describe("buildUnitsFromRecords — table units", () => {
  const smallTable: Block = {
    type: "table",
    id: "t-block-1",
    page: 2,
    tableId: "tbl-1",
    sectionPath: ["2 Tabelle"],
    headerRows: [["Name", "Status"]],
    rows: [
      ["Anmeldung", "offen"],
      ["Freigabe", "erledigt"],
    ],
    caption: "Prozessschritte",
  };

  it("emits one table unit under budget with a Spalte: Wert FTS text", async () => {
    const units = await buildUnitsFromRecords(
      input([page(2, [smallTable])], { tokenCounter: fixedCounter(50), maxChunkTokens: 500 }),
    );
    const tables = byType(units, "table");
    expect(tables).toHaveLength(1);
    const [t] = tables;
    expect(t?.tableId).toBe("tbl-1");
    expect(t?.embedInput).toContain("Name | Status");
    // "Spalte: Wert" per-row rendering is present in the stored/FTS content.
    expect(t?.content).toContain("Name: Anmeldung; Status: offen");
    expect(t?.content).toContain("Name: Freigabe; Status: erledigt");
    expect(t?.blockIds).toEqual(["t-block-1"]);
  });

  it("splits a table over budget into row-groups that repeat the header and share table_id", async () => {
    const bigTable: Block = {
      type: "table",
      id: "t-block-2",
      page: 3,
      tableId: "tbl-2",
      sectionPath: ["3"],
      headerRows: [["Spalte A", "Spalte B"]],
      rows: [
        ["a1", "b1"],
        ["a2", "b2"],
        ["a3", "b3"],
        ["a4", "b4"],
      ],
    };
    // Each rendered group (header + 1 row) is 300 tokens; adding a 2nd row makes
    // 300 again per our stub — so make the stub report over budget once a group
    // has more than one row by counting rows via text length instead.
    const rowAwareCounter: UnitTokenCounter = {
      countBatch: (texts) =>
        Promise.resolve(
          // ~1 token per 2 chars keeps a header+1row under 500 but header+2rows over.
          texts.map((t) => t.length * 30),
        ),
    };
    const units = await buildUnitsFromRecords(
      input([page(3, [bigTable])], { tokenCounter: rowAwareCounter, maxChunkTokens: 500 }),
    );
    const tables = byType(units, "table");
    expect(tables.length).toBeGreaterThan(1);
    // All share the same tableId.
    expect(new Set(tables.map((t) => t.tableId))).toEqual(new Set(["tbl-2"]));
    // Every row-group repeats the header.
    for (const t of tables) {
      expect(t.embedInput).toContain("Spalte A | Spalte B");
    }
    // Row-groups are linked prev/next in order.
    const sorted = tables.sort((a, b) => a.ordinal - b.ordinal);
    expect(sorted[0]?.prevUnitId).toBeUndefined();
    expect(sorted[0]?.nextUnitId).toBe(sorted[1]?.unitId);
    expect(sorted[sorted.length - 1]?.nextUnitId).toBeUndefined();
  });

  it("binds the section's identifier codes into every table unit (QAP fix)", async () => {
    // The regression shape: a section whose heading + "ID:" paragraph carry the
    // identifier while its table rows are generic text repeated verbatim in
    // sibling sections. Without the ID line the table units of 9.8/9.13/9.18
    // are indistinguishable and crowd the section's chunk out of the top-k.
    const units = await buildUnitsFromRecords(
      input([
        page(368, [
          {
            type: "heading",
            id: "h1",
            page: 368,
            level: 2,
            numbering: "9.13",
            text: "Station auswählen",
            sectionPath: [
              "9 Prozess Fehlerbehebung, Sonderfall Bearbeitung",
              "9.13 Station auswählen",
            ],
          },
          {
            type: "paragraph",
            id: "p1",
            page: 368,
            text: "ID: QAP-DOK-03; Stand: 01.01.2025",
            sectionPath: [
              "9 Prozess Fehlerbehebung, Sonderfall Bearbeitung",
              "9.13 Station auswählen",
            ],
          },
          {
            type: "table",
            id: "tb1",
            page: 368,
            tableId: "tbl-913",
            sectionPath: [
              "9 Prozess Fehlerbehebung, Sonderfall Bearbeitung",
              "9.13 Station auswählen",
            ],
            headerRows: [["Eingabe-Möglichkeit", "Hinweis"]],
            rows: [["immer", "Pflichtfeld"]],
          },
        ]),
      ]),
    );
    const tables = byType(units, "table");
    expect(tables).toHaveLength(1);
    const [t] = tables;
    // The identifier is embedded (embedInput) and full-text searchable
    // (content) — the reranker sees it, the vector sees it, FTS finds it.
    expect(t?.embedInput).toContain("IDs: QAP-DOK-03");
    expect(t?.content).toContain("QAP-DOK-03");
    // …but it is context, not the table's own document text: a document read
    // (which keeps the first displayLen chars) returns only the grid.
    const grid = "Eingabe-Möglichkeit | Hinweis\nimmer | Pflichtfeld";
    expect(t?.displayLen).toBe(grid.length);
    expect(t?.content.startsWith(grid)).toBe(true);
    expect(t?.content.slice(0, t?.displayLen)).toBe(grid);
  });

  it("leaves table units unchanged when the section carries no identifier codes", async () => {
    const units = await buildUnitsFromRecords(
      input([page(2, [smallTable])], {
        tokenCounter: fixedCounter(50),
        maxChunkTokens: 500,
      }),
    );
    const [t] = byType(units, "table");
    expect(t?.embedInput).not.toContain("IDs:");
    // Without an identity prefix, displayLen covers the whole embed input.
    expect(t?.displayLen).toBe(t?.embedInput.length);
  });
});

// ─── figure units ──────────────────────────────────────────────────────────────

describe("buildUnitsFromRecords — figure units", () => {
  it("carries caption + description + transcription + labels and its own figure ref", async () => {
    const units = await buildUnitsFromRecords(
      input([
        page(3, [
          {
            type: "figure",
            id: "b1",
            page: 3,
            figureId: "p3-f1",
            kind: "bpmn",
            caption: "Anmeldeprozess",
            description: "Der Prozess der Warenanmeldung in zwei Schritten.",
            assetId: "a".repeat(64),
            labels: ["Start", "Ende"],
            sectionPath: ["3 Prozess"],
            transcription: {
              format: "process",
              mermaid: "graph TD; A-->B",
              nodes: [
                { id: "A", type: "task", label: "Anmeldung" },
                { id: "B", type: "task", label: "Freigabe" },
              ],
              edges: [{ from: "A", to: "B" }],
              steps: ["Anmeldung", "Freigabe"],
            },
          },
        ]),
      ]),
    );
    const figures = byType(units, "figure");
    expect(figures).toHaveLength(1);
    const [fig] = figures;
    if (!fig) throw new Error("expected a figure unit");
    expect(fig.figureId).toBe("p3-f1");
    expect(fig.figureKind).toBe("bpmn");
    expect(fig.assetId).toBe("a".repeat(64));
    expect(fig.content).toContain("Anmeldeprozess");
    expect(fig.content).toContain("Warenanmeldung");
    expect(fig.content).toContain("Freigabe");
    expect(fig.content).toContain("Start");
    expect(fig.figureRefs).toEqual(["p3-f1"]);
    // Parent link points at the section unit for its section path.
    expect(fig.parentUnitId).toBeDefined();
  });
});

// ─── section / page / document units (from document.end) ──────────────────────

describe("buildUnitsFromRecords — summary units from document.end", () => {
  const documentEnd: DocumentEndRecord = {
    type: "document.end",
    reference: "akte/doc.pdf",
    pageCount: 3,
    outline: [
      { sectionId: "s1", level: 1, numbering: "1", title: "Einleitung", pageStart: 1, pageEnd: 1 },
      { sectionId: "s2", level: 1, numbering: "2", title: "Prozess", pageStart: 2, pageEnd: 3 },
    ],
    identifiers: [],
    summaries: [
      { scope: "document", id: "akte/doc.pdf", summary: "Gesamtzusammenfassung des Dokuments." },
      { scope: "section", id: "s1", summary: "Zusammenfassung der Einleitung.", pageStart: 1, pageEnd: 1 },
      { scope: "section", id: "s2", summary: "Zusammenfassung des Prozesses.", pageStart: 2, pageEnd: 3 },
      { scope: "page", id: "p1", summary: "Seite 1 handelt von der Einleitung.", pageStart: 1, pageEnd: 1 },
      { scope: "page", id: "p2", summary: "Seite 2 zeigt den Prozess.", pageStart: 2, pageEnd: 2 },
    ],
    refs: [],
    warnings: [],
  };

  it("builds one document, two section and two page units with the summaries + outline", async () => {
    const units = await buildUnitsFromRecords(input([], { documentEnd }));
    expect(byType(units, "document")).toHaveLength(1);
    expect(byType(units, "section")).toHaveLength(2);
    expect(byType(units, "page")).toHaveLength(2);

    const [doc] = byType(units, "document");
    expect(doc?.content).toContain("Gesamtzusammenfassung");
    // Outline levels 1–2 form the document unit's structural context.
    expect(doc?.content).toContain("Einleitung");
    expect(doc?.content).toContain("Prozess");
    expect(doc?.pageEnd).toBe(3);
  });

  it("spans the document unit over the window a pages-selection job streamed", async () => {
    const windowed: DocumentEndRecord = { ...documentEnd, pageCount: 9, firstPage: 7 };
    const units = await buildUnitsFromRecords(input([], { documentEnd: windowed }));
    const [doc] = byType(units, "document");
    expect(doc?.pageStart).toBe(7);
    expect(doc?.pageEnd).toBe(9);
    // Without firstPage the document unit starts at page 1, as before.
    const whole = await buildUnitsFromRecords(input([], { documentEnd }));
    expect(byType(whole, "document")[0]?.pageStart).toBe(1);
  });
  it("links sections and pages to the document as parent", async () => {
    const units = await buildUnitsFromRecords(input([], { documentEnd }));
    const [doc] = byType(units, "document");
    for (const s of byType(units, "section")) {
      expect(s.parentUnitId).toBe(doc?.unitId);
    }
    for (const p of byType(units, "page")) {
      expect(p.parentUnitId).toBe(doc?.unitId);
    }
  });

  it("links sections prev/next in outline order and pages by number", async () => {
    const units = await buildUnitsFromRecords(input([], { documentEnd }));
    const sections = byType(units, "section");
    expect(sections[0]?.nextUnitId).toBe(sections[1]?.unitId);
    expect(sections[1]?.prevUnitId).toBe(sections[0]?.unitId);
    const pages = byType(units, "page");
    expect(pages[0]?.nextUnitId).toBe(pages[1]?.unitId);
  });

  it("makes a chunk's parent link resolve to its section unit id", async () => {
    // A chunk on section "1 Einleitung" plus the section unit built from the
    // outline node "1 Einleitung" must share the parent/unit id.
    const withPages = await buildUnitsFromRecords(
      input(
        [page(1, [{ type: "paragraph", id: "b1", page: 1, text: "Inhalt der Einleitung.", sectionPath: ["1 Einleitung"] }])],
        { documentEnd },
      ),
    );
    const [chunk] = byType(withPages, "chunk");
    const section = byType(withPages, "section").find(
      (s) => s.sectionPath[0] === "1 Einleitung",
    );
    expect(chunk?.parentUnitId).toBeDefined();
    expect(chunk?.parentUnitId).toBe(section?.unitId);
  });
});

// ─── determinism (Req 5.5) ─────────────────────────────────────────────────────

describe("buildUnitsFromRecords — determinism", () => {
  const pages = [
    page(1, [
      { type: "paragraph", id: "b1", page: 1, text: "Stabiler Absatz.", sectionPath: ["1"] },
      { type: "figure", id: "b2", page: 1, figureId: "p1-f1", kind: "photo", description: "Ein Foto.", sectionPath: ["1"] },
      {
        type: "table",
        id: "b3",
        page: 1,
        tableId: "tbl",
        sectionPath: ["1"],
        headerRows: [["K"]],
        rows: [["v"]],
      },
    ]),
  ];

  it("reprocessing the same batch yields the same unit ids (upsert in place)", async () => {
    const first = await buildUnitsFromRecords(input(pages, { tokenCounter: fixedCounter(50) }));
    const second = await buildUnitsFromRecords(input(pages, { tokenCounter: fixedCounter(50) }));
    expect(first.map((u) => u.unitId)).toEqual(second.map((u) => u.unitId));
    expect(new Set(first.map((u) => u.unitId)).size).toBe(first.length);
  });

  it("changes unit ids when the revision changes (units are per-ingest)", async () => {
    const revA = await buildUnitsFromRecords(input(pages, { revisionId: "rev-A", tokenCounter: fixedCounter(50) }));
    const revB = await buildUnitsFromRecords(input(pages, { revisionId: "rev-B", tokenCounter: fixedCounter(50) }));
    expect(revA[0]?.unitId).not.toBe(revB[0]?.unitId);
  });

  it("drops empty pages and whitespace-only blocks", async () => {
    const units = await buildUnitsFromRecords(
      input([
        page(1, [{ type: "paragraph", id: "b1", page: 1, text: "   ", sectionPath: ["1"] }]),
        page(2, []),
      ]),
    );
    expect(units).toHaveLength(0);
  });
});

// ─── computeUnitId ─────────────────────────────────────────────────────────────

describe("computeUnitId", () => {
  it("is a stable lowercase hex sha256", () => {
    const id = computeUnitId({
      revisionId: "r",
      documentId: "d",
      unitType: "chunk",
      pageStart: 1,
      pageEnd: 1,
      sectionPath: ["1", "1.2"],
      blockIds: ["b1", "b2"],
      ordinal: 0,
    });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes unit types on the same coordinates", () => {
    const base = {
      revisionId: "r",
      documentId: "d",
      pageStart: 1,
      pageEnd: 1,
      sectionPath: [] as string[],
      blockIds: ["b1"],
      ordinal: 0,
    };
    expect(computeUnitId({ ...base, unitType: "chunk" })).not.toBe(
      computeUnitId({ ...base, unitType: "table" }),
    );
  });
});

// ─── render helpers ────────────────────────────────────────────────────────────

describe("renderFigureText", () => {
  it("joins caption, description, transcription and labels", () => {
    const text = renderFigureText({
      type: "figure",
      id: "b1",
      page: 1,
      figureId: "f1",
      kind: "ui_mask",
      caption: "Maske",
      description: "Eine Eingabemaske.",
      labels: ["Feld A", "Feld B"],
      transcription: {
        format: "fields",
        areas: [{ name: "Kopf", fields: [{ label: "Name", type: "text" }] }],
        actions: ["Speichern"],
      },
    });
    expect(text).toContain("Maske");
    expect(text).toContain("Eingabemaske");
    expect(text).toContain("Name");
    expect(text).toContain("Speichern");
    expect(text).toContain("Feld A");
  });
});

describe("renderTableRows / renderTableColumnValue", () => {
  it("renders header + rows as pipe rows", () => {
    const text = renderTableRows([["A", "B"]], [["1", "2"]]);
    expect(text).toBe("A | B\n1 | 2");
  });

  it("renders body rows as Spalte: Wert with header labels", () => {
    const text = renderTableColumnValue(["A", "B"], [["1", "2"], ["3", "4"]]);
    expect(text).toBe("A: 1; B: 2\nA: 3; B: 4");
  });

  it("falls back to a positional label when a column has no header", () => {
    const text = renderTableColumnValue(["A"], [["1", "2"]]);
    expect(text).toBe("A: 1; Spalte 2: 2");
  });
});

describe("unit metadata · Extract provenance (Req 18.2)", () => {
  const unit = {
    unitType: "chunk",
    pageStart: 1,
    pageEnd: 1,
    sectionPath: [],
    blockIds: [],
  } as never;

  it("adds extract_contract / extract_pipeline_version / extract_prompt_hash", async () => {
    const { buildMetadata } = await import("../src/batch-worker.js");
    const meta = buildMetadata(unit, {
      contract: "atf-extract/2.0.0",
      pipelineVersion: "pv-2",
      promptHash: "ph-2",
    });
    expect(meta).toMatchObject({
      unit_type: "chunk",
      extract_contract: "atf-extract/2.0.0",
      extract_pipeline_version: "pv-2",
      extract_prompt_hash: "ph-2",
    });
  });

  it("omits provenance keys that are unknown", async () => {
    const { buildMetadata } = await import("../src/batch-worker.js");
    expect(buildMetadata(unit)).not.toHaveProperty("extract_contract");
    const partial = buildMetadata(unit, { contract: "atf-extract/2.0.0" });
    expect(partial.extract_contract).toBe("atf-extract/2.0.0");
    expect(partial).not.toHaveProperty("extract_pipeline_version");
    expect(partial).not.toHaveProperty("extract_prompt_hash");
  });
});

// ─── paragraph over a page break (contract 2.3) ─────────────────────────────

describe("buildUnitsFromRecords · paragraph over a page break", () => {
  it("the last chunk carries the continuation for search, displayLen keeps it out of reads", async () => {
    const units = await buildUnitsFromRecords(
      input([
        page(1, [
          {
            id: "p1-b1",
            page: 1,
            type: "paragraph",
            text: "Die Anforderung WE-07 verlangt, dass der Lieferant",
            continues: true,
            continuationText: "bei jeder Buchung erfasst wird.",
          },
        ]),
        page(2, [
          { id: "p2-b1", page: 2, type: "paragraph", text: "bei jeder Buchung erfasst wird. Mehr.", continuationOf: "p1-b1" },
        ]),
      ]),
    );
    const [first, second] = byType(units, "chunk");
    if (first === undefined || second === undefined) throw new Error("expected two chunks");
    expect(first.content).toBe("Die Anforderung WE-07 verlangt, dass der Lieferant bei jeder Buchung erfasst wird.");
    expect(first.embedInput).toBe(first.content);
    expect(first.content.slice(0, first.displayLen)).toBe("Die Anforderung WE-07 verlangt, dass der Lieferant");
    expect(first.pageStart).toBe(1);
    expect(first.pageEnd).toBe(1);
    expect(second.displayLen).toBeUndefined();
    // Chunks of one section link across the pages of the batch.
    expect(first.nextUnitId).toBe(second.unitId);
    expect(second.prevUnitId).toBe(first.unitId);
  });

  it("joins a word hyphenated at the break without a space", async () => {
    const units = await buildUnitsFromRecords(
      input([
        page(3, [{ id: "p3-b1", page: 3, type: "paragraph", text: "Pflichtfeld Liefe-", continues: true, continuationText: "rantennummer." }]),
      ]),
    );
    expect(byType(units, "chunk")[0]?.content).toBe("Pflichtfeld Liefe-rantennummer.");
  });
});
