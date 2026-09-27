// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * docpass.test.ts
 *
 * The streaming document pass (design §5 S7, §9a.2; task 2.6, requirements 9.1,
 * 9.2, 9.3, 9.4, 4.7). Driven with synthetic page records + analyses — exactly
 * what S2/S3 produce — so no poppler, image or model is needed. The pass is a
 * pure state machine, so the tests assert its outputs directly.
 *
 * Covers:
 *  - outline stack assigns a correct sectionPath across pages (level pop/push),
 *    from numbering and from line-height for unnumbered headings
 *  - cross-page table merge joins a `continues` table to a matching next-page
 *    continuation under one tableId, and does NOT merge on a column-count or
 *    header mismatch
 *  - caption→figure linking and cross-reference resolution ("siehe Kapitel 4.2",
 *    "Abbildung 12", "Tabelle 3", "Maske WE01") produce correct refs
 *  - identifier extraction finds each regex class with correct occurrences
 *  - docpass_state round-trips: process pages 1..k, resume from the persisted
 *    state, continue k+1..n, and assert an identical result to a non-interrupted
 *    run (requirement 4.7)
 */

import { describe, expect, it } from "vitest";
import type {
  Block,
  Cell,
  FigureBlock,
  HeadingBlock,
  PageRecord,
  TableBlock,
} from "@atf/extract-contract/v2";
import type { AnalyzedLine, PageAnalysis } from "../src/pipeline/bbox-layout.js";
import {
  createDocumentPass,
  emptyDocpassState,
  parseDocpassState,
} from "../src/jobs/docpass/document-pass.js";
import {
  extractIdentifiers,
  createIdentifierIndex,
} from "../src/jobs/docpass/identifiers.js";
import { createOutlineStack, finalizeOutlineNodes } from "../src/jobs/docpass/outline.js";
import {
  tablesMerge,
  headerSignature,
  tableColumnCount,
} from "../src/jobs/docpass/table-merge.js";
import { extractRefs, emptyRefRegistry } from "../src/jobs/docpass/refs.js";

// ── record builders ─────────────────────────────────────────────────────

let blockSeq = 0;
function blockId(page: number): string {
  blockSeq += 1;
  return `p${page}-b${blockSeq}`;
}

function heading(page: number, text: string, level: number, numbering?: string): HeadingBlock {
  return {
    id: blockId(page),
    page,
    type: "heading",
    level,
    text,
    ...(numbering !== undefined ? { numbering } : {}),
  };
}

function paragraph(page: number, text: string): Block {
  return { id: blockId(page), page, type: "paragraph", text };
}

function table(
  page: number,
  headerRows: Cell[][],
  rows: Cell[][],
  opts: { tableId?: string; continues?: boolean; continuationOf?: string; caption?: string } = {},
): TableBlock {
  return {
    id: blockId(page),
    page,
    type: "table",
    tableId: opts.tableId ?? `raw-${page}`,
    headerRows,
    rows,
    ...(opts.continues !== undefined ? { continues: opts.continues } : {}),
    ...(opts.continuationOf !== undefined ? { continuationOf: opts.continuationOf } : {}),
    ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
  };
}

function figure(page: number, figureId: string, caption?: string, labels?: string[]): FigureBlock {
  return {
    id: blockId(page),
    page,
    type: "figure",
    figureId,
    kind: "ui_mask",
    description: "A figure.",
    ...(caption !== undefined ? { caption } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
}

function pageRecord(page: number, blocks: Block[]): PageRecord {
  return {
    type: "page",
    page,
    size: { wPt: 595, hPt: 842 },
    class: "text",
    blocks,
    assets: [],
    warnings: [],
  };
}

/** A synthetic line for a heading, so line-height ordering can be exercised. */
function line(text: string, centreY: number, height: number): AnalyzedLine {
  return {
    words: [],
    bbox: [0.1, centreY - height / 2, 0.9, centreY + height / 2],
    text,
    height,
  };
}

function analysis(page: number, lines: AnalyzedLine[]): PageAnalysis {
  return {
    page,
    size: { widthPt: 595, heightPt: 842 },
    blocks: [],
    lines,
    words: [],
    headingCandidates: [],
  };
}

// ── outline / sectionPath ──────────────────────────────────────────────────

describe("outline stack — sectionPath", () => {
  it("assigns sectionPath from numbering across pages with level pop/push", () => {
    const pass = createDocumentPass();
    const p1 = pass.applyPage(
      pageRecord(1, [
        heading(1, "Wareneingang", 1, "4"),
        paragraph(1, "Intro to chapter 4."),
        heading(1, "Anmeldung", 2, "4.2"),
        paragraph(1, "Body of 4.2."),
      ]),
    ).record;

    // The chapter heading itself carries just its own path…
    expect((p1.blocks[0] as Block).sectionPath).toEqual(["4 Wareneingang"]);
    // …its intro paragraph too…
    expect((p1.blocks[1] as Block).sectionPath).toEqual(["4 Wareneingang"]);
    // …and the 4.2 body nests under 4 › 4.2.
    expect((p1.blocks[3] as Block).sectionPath).toEqual(["4 Wareneingang", "4.2 Anmeldung"]);

    // Page 2 opens 4.2.1, then a sibling chapter 5 pops everything back to L1.
    const p2 = pass.applyPage(
      pageRecord(2, [
        heading(2, "Maske WE01", 3, "4.2.1"),
        paragraph(2, "Deep body."),
        heading(2, "Wareneingang buchen", 1, "5"),
        paragraph(2, "Chapter 5 body."),
      ]),
    ).record;

    expect((p2.blocks[1] as Block).sectionPath).toEqual([
      "4 Wareneingang",
      "4.2 Anmeldung",
      "4.2.1 Maske WE01",
    ]);
    // Chapter 5 popped 4.2.1, 4.2 and 4.
    expect((p2.blocks[3] as Block).sectionPath).toEqual(["5 Wareneingang buchen"]);

    // The finished outline has all five headings with page ranges.
    const outline = pass.outline(2);
    expect(outline.map((n) => n.numbering)).toEqual(["4", "4.2", "4.2.1", "5"]);
    const chapter4 = outline.find((n) => n.numbering === "4");
    expect(chapter4?.pageStart).toBe(1);
    expect(chapter4?.pageEnd).toBe(2);
  });

  it("orders unnumbered headings by line height (largest = level 1)", () => {
    const stack = createOutlineStack();
    // A big title, then a smaller sub-heading, then another big title.
    stack.observeHeading({ text: "Teil A" }, 1, 0.05);
    stack.observeHeading({ text: "Kapitel A.1" }, 1, 0.03);
    expect(stack.currentPath()).toEqual(["Teil A", "Kapitel A.1"]);
    // A second big (0.05) heading pops the small one AND the first big one.
    stack.observeHeading({ text: "Teil B" }, 2, 0.05);
    expect(stack.currentPath()).toEqual(["Teil B"]);
  });

  it("reads heading line-heights from the page analysis", () => {
    const pass = createDocumentPass();
    const rec = pageRecord(1, [
      heading(1, "Großes Kapitel", 1),
      heading(1, "Kleiner Abschnitt", 2),
      paragraph(1, "body"),
    ]);
    const ana = analysis(1, [
      line("Großes Kapitel", 0.1, 0.05),
      line("Kleiner Abschnitt", 0.3, 0.025),
      line("body", 0.5, 0.02),
    ]);
    const applied = pass.applyPage(rec, ana);
    expect((applied.record.blocks[2] as Block).sectionPath).toEqual([
      "Großes Kapitel",
      "Kleiner Abschnitt",
    ]);
  });
});

// ── finalize pass (task 5.4, requirement 9.6) ───────────────────────────────

describe("finalize pass — outline metadata correction", () => {
  /** A heading arriving with its title on a line of the given height. */
  function headingPage(page: number, text: string, h: number, numbering?: string) {
    return {
      rec: pageRecord(page, [heading(page, text, 1, numbering), paragraph(page, `body of ${text}`)]),
      ana: analysis(page, [line(text, 0.1, h), line(`body of ${text}`, 0.3, 0.02)]),
    };
  }

  it("re-ranks a provisionally mis-levelled unnumbered heading once the full height distribution is known", () => {
    // The streaming pass sees the SMALL height (0.03, "Einleitung") first, so it
    // maps it to level 1 from the partial ranking. A LARGER heading (0.06,
    // "Teil A") turns up later — now 0.06 is level 1 and 0.03 should be level 2.
    // The streaming outline is therefore skewed; the finalize pass corrects it.
    const pass = createDocumentPass();
    const intro = headingPage(1, "Einleitung", 0.03);
    const teilA = headingPage(2, "Teil A", 0.06);
    pass.applyPage(intro.rec, intro.ana);
    pass.applyPage(teilA.rec, teilA.ana);

    // The streaming (provisional) outline: both headings ended up level 1, so
    // "Einleitung" is a sibling of "Teil A" — the skew.
    const streaming = pass.outline(2);
    expect(streaming.map((n) => `${n.title}@${n.level}`)).toEqual([
      "Einleitung@1",
      "Teil A@1",
    ]);

    // The finalize pass re-ranks: 0.06 → level 1, 0.03 → level 2.
    const { outline, changes } = pass.finalizeOutline(2);
    const byTitle = new Map(outline.map((n) => [n.title, n.level]));
    expect(byTitle.get("Teil A")).toBe(1);
    expect(byTitle.get("Einleitung")).toBe(2);

    // "Einleitung" appears BEFORE "Teil A" in the document, so even at its
    // corrected level 2 it has no shallower ancestor before it: its section
    // PATH is still just `["Einleitung"]`, unchanged. Requirement 9.6 keys the
    // re-embed on a PATH change, not a level change — a unit whose path did not
    // move must not be re-embedded even though the level was corrected. So the
    // finalize pass reports NO change here.
    expect(changes).toEqual([]);
  });

  it("reports a real section-path change when a corrected level re-parents a following heading (pure core)", () => {
    // A hand-built outline in document order where the STREAMING levels skewed
    // the nesting. "B" was provisionally level 1 (a sibling of "A"), so "C" —
    // provisionally level 2 — nested under B. Once heights are fully ranked, B is
    // really level 2 (a CHILD of A), which moves C from `[B, C]` to `[A, B, C]`.
    // The pure core re-derives the paths and reports exactly C's change.
    const streaming = [
      { sectionId: "sA", level: 1, title: "A", pageStart: 1, lineHeight: 0.06, levelSource: "height" as const },
      { sectionId: "sB", level: 1, title: "B", pageStart: 1, lineHeight: 0.04, levelSource: "height" as const },
      { sectionId: "sC", level: 2, title: "C", pageStart: 1, lineHeight: 0.02, levelSource: "height" as const },
    ];
    const { outline, changes } = finalizeOutlineNodes(streaming);

    // Corrected levels: 0.06→1 (A), 0.04→2 (B), 0.02→3 (C).
    expect(outline.map((n) => `${n.title}@${n.level}`)).toEqual(["A@1", "B@2", "C@3"]);

    // B moved under A: `[B]` → `[A, B]`. C moved under A›B: `[B, C]` → `[A, B, C]`.
    const byId = new Map(changes.map((c) => [c.sectionId, c]));
    expect(byId.get("sB")).toEqual({ sectionId: "sB", before: ["B"], after: ["A", "B"] });
    expect(byId.get("sC")).toEqual({ sectionId: "sC", before: ["B", "C"], after: ["A", "B", "C"] });
    // A did not move.
    expect(byId.has("sA")).toBe(false);
  });

  it("never moves an authoritative numbered heading and reports no change for it", () => {
    // Numbered headings are the author's own hierarchy: 1, 1.1, 2. The finalize
    // pass must leave their levels exactly as the numbering dictates.
    const pass = createDocumentPass();
    const h1 = headingPage(1, "Erstes", 0.02, "1");
    const h11 = headingPage(1, "Unter", 0.02, "1.1");
    const h2 = headingPage(2, "Zweites", 0.02, "2");
    pass.applyPage(h1.rec, h1.ana);
    pass.applyPage(h11.rec, h11.ana);
    pass.applyPage(h2.rec, h2.ana);

    const before = pass.outline(2);
    const { outline, changes } = pass.finalizeOutline(2);
    expect(outline.map((n) => n.level)).toEqual(before.map((n) => n.level));
    expect(changes).toEqual([]);
  });

  it("is a no-op on an outline with no height-sourced headings", () => {
    const pass = createDocumentPass();
    const h = headingPage(1, "Nur Nummern", 0.02, "1");
    pass.applyPage(h.rec, h.ana);
    const { outline, changes } = pass.finalizeOutline(1);
    expect(changes).toEqual([]);
    expect(outline).toHaveLength(1);
    expect(outline[0]?.level).toBe(1);
  });

  it("is deterministic — the pure core is stable across repeated runs (requirement 4.7)", () => {
    const pass = createDocumentPass();
    const intro = headingPage(1, "Einleitung", 0.03);
    const teilA = headingPage(2, "Teil A", 0.06);
    pass.applyPage(intro.rec, intro.ana);
    pass.applyPage(teilA.rec, teilA.ana);
    const nodes = pass.outline(2);
    const a = finalizeOutlineNodes(nodes);
    const b = finalizeOutlineNodes(nodes);
    expect(a).toEqual(b);
  });
});

// ── table merge ─────────────────────────────────────────────────────────

describe("table merge", () => {
  const header: Cell[][] = [["Lieferant", "Menge", "Datum"]];

  it("joins a continues table to a matching next-page continuation under one tableId", () => {
    const pass = createDocumentPass();
    const p1 = pass.applyPage(
      pageRecord(1, [table(1, header, [["A", "1", "x"]], { continues: true })]),
    ).record;
    const t1 = p1.blocks[0] as TableBlock;
    expect(t1.continues).toBe(true);

    // Page 2 begins with the SAME header + column count → merge.
    const p2 = pass.applyPage(
      pageRecord(2, [table(2, header, [["B", "2", "y"]])]),
    ).record;
    const t2 = p2.blocks[0] as TableBlock;
    expect(t2.tableId).toBe(t1.tableId);
    expect(t2.continuationOf).toBe(t1.tableId);
    expect(t2.continues).toBe(false);
  });

  it("merges when the continuation omits the repeated header", () => {
    const pass = createDocumentPass();
    const p1 = pass.applyPage(
      pageRecord(1, [table(1, header, [["A", "1", "x"]], { continues: true })]),
    ).record;
    // Continuation with NO header but the same 3-column width.
    const p2 = pass.applyPage(
      pageRecord(2, [table(2, [], [["B", "2", "y"]])]),
    ).record;
    expect((p2.blocks[0] as TableBlock).continuationOf).toBe((p1.blocks[0] as TableBlock).tableId);
  });

  it("does NOT merge on a column-count mismatch", () => {
    const pass = createDocumentPass();
    const p1 = pass.applyPage(
      pageRecord(1, [table(1, header, [["A", "1", "x"]], { continues: true })]),
    ).record;
    // A 2-column table starting page 2 is unrelated.
    const p2 = pass.applyPage(
      pageRecord(2, [table(2, [["Pos", "Wert"]], [["B", "2"]])]),
    ).record;
    const t2 = p2.blocks[0] as TableBlock;
    expect(t2.continuationOf).toBeUndefined();
    expect(t2.tableId).not.toBe((p1.blocks[0] as TableBlock).tableId);
  });

  it("does NOT merge on a different header", () => {
    const pass = createDocumentPass();
    pass.applyPage(pageRecord(1, [table(1, header, [["A", "1", "x"]], { continues: true })]));
    const p2 = pass.applyPage(
      pageRecord(2, [table(2, [["Ganz", "andere", "Spalten"]], [["B", "2", "y"]])]),
    ).record;
    expect((p2.blocks[0] as TableBlock).continuationOf).toBeUndefined();
  });

  it("headerSignature / tableColumnCount / tablesMerge behave", () => {
    expect(headerSignature([])).toBeNull();
    expect(headerSignature([["A", "B"]])).toBe(headerSignature([["a", "b"]]));
    expect(tableColumnCount({ headerRows: [["A", "B", "C"]], rows: [["1", "2"]] })).toBe(3);
    const open = { tableId: "t1", columnCount: 3, headerSignature: headerSignature([["A", "B", "C"]]), page: 1 };
    expect(tablesMerge(open, { headerRows: [["A", "B", "C"]], rows: [["1", "2", "3"]] })).toBe(true);
    expect(tablesMerge(open, { headerRows: [["X"]], rows: [["1"]] })).toBe(false);
  });
});

// ── refs + captions ───────────────────────────────────────────────────────

describe("refs and captions", () => {
  it("resolves Abbildung/Tabelle/Kapitel/Maske references to targets", () => {
    const pass = createDocumentPass();
    // Page 1 declares the referenced things: figure ordinal 12, section 4.2, a
    // table with caption "Tabelle 3".
    pass.applyPage(
      pageRecord(1, [
        heading(1, "Anmeldung", 2, "4.2"),
        figure(1, "p1-f1", "Abbildung 12: Maske WE01 – Wareneingang"),
        table(1, [["Pos", "Wert"]], [["a", "b"]], { caption: "Tabelle 3: Werte" }),
      ]),
    );
    // Page 2 references them all.
    const p2 = pass.applyPage(
      pageRecord(2, [
        paragraph(
          2,
          "Wie in Abbildung 12 gezeigt und in Tabelle 3 aufgeführt, siehe Kapitel 4.2 sowie Maske WE01.",
        ),
      ]),
    ).record;

    const refs = (p2.blocks[0] as Block).refs ?? [];
    const byKind = Object.fromEntries(refs.map((r) => [r.kind, r]));
    expect(byKind.figure?.target).toBe("p1-f1");
    expect(byKind.table?.target).toBeDefined();
    expect(byKind.section?.target).toBeDefined();
    expect(byKind.identifier?.text).toContain("WE01");
    // The document-level ref list carries them too.
    expect(pass.documentRefs().length).toBeGreaterThanOrEqual(4);
  });

  it("extractRefs is a pure function of text and registry", () => {
    const refs = extractRefs("Details in Abbildung 5 und Kapitel 2.1.", emptyRefRegistry());
    expect(refs.map((r) => r.kind)).toEqual(["figure", "section"]);
    // Unresolved (empty registry) → no target.
    expect(refs[0]?.target).toBeUndefined();
  });
});

// ── identifiers ───────────────────────────────────────────────────────────

describe("identifier extraction", () => {
  it("finds each regex class", () => {
    const cases: Array<[string, string]> = [
      ["Die Norm DIN EN 1090-2 gilt.", "standard"],
      ["Anforderung REQ-014 ist erfüllt.", "requirement"],
      ["Der Task Task_0abc123 startet.", "bpmn_task"],
      ["Öffne Maske WE01 im System.", "mask_code"],
      ["Zeichnung ZG-100 beachten.", "drawing_number"],
      ["Art.-Nr. 4711 bestellen.", "article_number"],
    ];
    for (const [text, kind] of cases) {
      const found = extractIdentifiers(text, 1, "b1");
      expect(found.some((f) => f.kind === kind), `${kind} in "${text}"`).toBe(true);
    }
  });

  it("records occurrences with page and blockId and dedupes repeats", () => {
    const index = createIdentifierIndex();
    index.observe("Maske WE01 hier.", 1, "b1");
    index.observe("Maske WE01 dort.", 2, "b2");
    // Repeat on the same (page, block) must not double-count.
    index.observe("Nochmal WE01.", 2, "b2");
    const entry = index.entries().find((e) => e.value === "WE01");
    expect(entry?.kind).toBe("mask_code");
    expect(entry?.occurrences).toEqual([
      { page: 1, blockId: "b1" },
      { page: 2, blockId: "b2" },
    ]);
  });

  it("a more specific class claims its span (standard beats bare code)", () => {
    const found = extractIdentifiers("DIN EN 1090-2", 1, undefined);
    // Only the standard, not also a mask/drawing code inside it.
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe("standard");
  });

  it("the document pass indexes identifiers from figure labels", () => {
    const pass = createDocumentPass();
    pass.applyPage(pageRecord(1, [figure(1, "p1-f1", "Abbildung 1", ["WE01", "REQ-014"])]));
    const kinds = pass.identifiers().map((e) => e.kind).sort();
    expect(kinds).toContain("mask_code");
    expect(kinds).toContain("requirement");
  });
});

// ── furniture wiring ────────────────────────────────────────────────────────

describe("furniture wiring", () => {
  it("places a recurring header on the page record", () => {
    const pass = createDocumentPass();
    let last: PageRecord | null = null;
    for (let p = 1; p <= 3; p++) {
      const rec = pageRecord(p, [paragraph(p, `body ${p}`)]);
      const ana = analysis(p, [
        line("Pflichtenheft WMS", 0.04, 0.02),
        line(`body ${p}`, 0.5, 0.02),
      ]);
      last = pass.applyPage(rec, ana).record;
    }
    expect(last?.furniture?.header).toBe("Pflichtenheft WMS");
  });
});

// ── docpass_state resume ────────────────────────────────────────────────────

describe("docpass_state persistence and resume (requirement 4.7)", () => {
  /** A five-page document exercising outline, tables, refs and identifiers. */
  function document(): PageRecord[] {
    blockSeq = 0;
    const header: Cell[][] = [["Lieferant", "Menge", "Datum"]];
    return [
      pageRecord(1, [
        heading(1, "Wareneingang", 1, "4"),
        figure(1, "p1-f1", "Abbildung 12: Maske WE01"),
        paragraph(1, "Norm DIN EN 1090-2."),
      ]),
      pageRecord(2, [
        heading(2, "Anmeldung", 2, "4.2"),
        table(2, header, [["A", "1", "x"]], { continues: true }),
      ]),
      pageRecord(3, [table(3, header, [["B", "2", "y"]])]),
      pageRecord(4, [
        heading(4, "Buchung", 1, "5"),
        paragraph(4, "Siehe Kapitel 4.2 und Abbildung 12. Art.-Nr. 4711."),
      ]),
      pageRecord(5, [paragraph(5, "Maske WE01 erneut. REQ-014.")]),
    ];
  }

  /** Run the whole document uninterrupted; return the enriched records + state. */
  function uninterrupted(): { records: PageRecord[]; state: unknown } {
    const pass = createDocumentPass();
    const out: PageRecord[] = [];
    let state: unknown = emptyDocpassState();
    for (const rec of document()) {
      out.push(structuredClone(pass.applyPage(rec).record));
      state = structuredClone(pass.snapshot());
    }
    return { records: out, state };
  }

  it("produces identical output whether or not the run is interrupted", () => {
    const clean = uninterrupted();

    // Interrupted run: process pages 1..2, "crash", resume from the persisted
    // state of page 2, continue 3..5.
    const docs = document();
    const first = createDocumentPass();
    const interrupted: PageRecord[] = [];
    let persisted: unknown = emptyDocpassState();
    for (const rec of docs.slice(0, 2)) {
      interrupted.push(structuredClone(first.applyPage(rec).record));
      persisted = structuredClone(first.snapshot());
    }

    // Resume: rehydrate from the persisted page-2 state.
    const resumed = createDocumentPass(parseDocpassState(persisted));
    for (const rec of docs.slice(2)) {
      interrupted.push(structuredClone(resumed.applyPage(rec).record));
    }

    // Byte-identical records (the observable output the emitter sends).
    expect(JSON.stringify(interrupted)).toBe(JSON.stringify(clean.records));

    // And the finished outline / identifiers / refs match too.
    const cleanPass = createDocumentPass();
    for (const rec of document()) cleanPass.applyPage(rec);

    const resumedOutline = resumed.outline(5);
    expect(JSON.stringify(resumedOutline)).toBe(JSON.stringify(cleanPass.outline(5)));
    expect(JSON.stringify(resumed.identifiers())).toBe(JSON.stringify(cleanPass.identifiers()));
  });

  it("cross-page table merge survives an interruption at the boundary", () => {
    // Crash exactly between the `continues` table (page 2) and its continuation
    // (page 3): the open table must be restored from docpass_state so page 3
    // still merges.
    const docs = document();
    const first = createDocumentPass();
    let persisted: unknown = emptyDocpassState();
    for (const rec of docs.slice(0, 2)) {
      first.applyPage(rec);
      persisted = structuredClone(first.snapshot());
    }
    const resumed = createDocumentPass(parseDocpassState(persisted));
    const page3 = docs[2];
    if (page3 === undefined) throw new Error("expected page 3");
    const p3 = resumed.applyPage(page3).record;
    const t3 = p3.blocks[0] as TableBlock;
    // It merged with the page-2 table despite the crash at the boundary.
    expect(t3.continuationOf).toBeDefined();
  });
});
