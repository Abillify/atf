// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/docpass/document-pass.ts
 *
 * The streaming document pass (design §5 S7, §9a.2; task 2.6, requirements 9.1,
 * 9.2, 9.3, 9.4, 4.7).
 *
 * ## What it is
 *
 * S7 is the *deterministic* part of the document pass: as pages stream past in
 * strict order it builds the outline and stamps every block with a
 * `sectionPath` (9.1), stitches cross-page tables into one logical table (9.2),
 * resolves captions and cross-references into `refs` (9.3), indexes identifiers
 * with their occurrences (9.4), and recognises recurring header/footer furniture
 * (task 2.2, wired in here). The summary hierarchy (9.5) is a *separate* task
 * (2.7) over the text-LLM, and the finalize/re-embed pass (9.6) is later still;
 * neither is done here.
 *
 * ## Why it is its own strictly-ordered phase
 *
 * Everything above depends on the pages *before* the current one: page N's
 * `sectionPath` is the heading stack built from pages 1..N-1, a table on page N
 * merges only if page N-1 left one open, furniture is a rolling window. The
 * per-page vision/crops/figure2 stages are order-independent and the runner
 * drives them concurrently — but S7 cannot live in that concurrent window. So
 * the pass is a pure state machine here: {@link createDocumentPass} carries the
 * running state, {@link DocumentPass.applyPage} folds ONE page's record into it
 * and returns the enriched record, and {@link DocumentPass.snapshot} yields the
 * serialisable state to persist after that page. The runner (job-runner.ts)
 * walks pages 1..N in ascending order, calling `applyPage` on each and
 * persisting the snapshot to `docpass_state`; a resume rehydrates from the last
 * persisted page and continues. Because the state is the *only* thing carried
 * and it is fully serialised after each page, an interrupted-then-resumed run
 * produces byte-identical output to an uninterrupted one (requirement 4.7).
 *
 * ## Determinism
 *
 * No model, no I/O — the pass is a pure function of the page records and the
 * carried state. That is what makes the resume exact.
 */

import {
  applyTextContinuation,
  emptyTextContinuationState,
  parseTextContinuationState,
  type TextContinuationState,
} from "./text-continuation.js";
import type {
  Block,
  Furniture,
  IdentifierEntry,
  OutlineNode,
  PageRecord,
  Ref,
  SummaryNode,
  TableBlock,
} from "@atf/extract-contract/v2";
import type { PageAnalysis } from "../../pipeline/bbox-layout.js";
import {
  createFurnitureDetector,
  emptyFurnitureState,
  parseFurnitureState,
  type FurnitureDetector,
  type FurnitureState,
  type RollingWindowConfig,
} from "../furniture-detector.js";
import {
  createIdentifierIndex,
  emptyIdentifierState,
  parseIdentifierState,
  type IdentifierClass,
  type IdentifierIndex,
  type IdentifierIndexState,
} from "./identifiers.js";
import {
  createOutlineStack,
  emptyOutlineState,
  finalizeOutlineNodes,
  parseOutlineState,
  type ClosedOutlineNode,
  type FinalizedOutline,
  type OutlineStack,
  type OutlineState,
} from "./outline.js";
import {
  createSectionContentAccumulator,
  emptySectionContentState,
  parseSectionContentState,
  type SectionContentAccumulator,
  type SectionContentState,
} from "./section-content.js";
import {
  createTableMerger,
  emptyTableMergeState,
  parseTableMergeState,
  type TableMergeState,
  type TableMerger,
} from "./table-merge.js";
import {
  captionOrdinal,
  emptyRefRegistry,
  extractRefs,
  type RefRegistry,
} from "./refs.js";

/**
 * The full, JSON-serialisable running state persisted after each page on
 * `docpass_state` (design §9a.2, requirement 4.7). Every sub-state is itself
 * serialisable and versioned, so a resume rehydrates the exact same pass.
 */
export interface DocpassState {
  version: 1;
  outline: OutlineState;
  tables: TableMergeState;
  identifiers: IdentifierIndexState;
  furniture: FurnitureState;
  refs: RefRegistry;
  /**
   * The per-section content accumulator for the summary hierarchy (task 2.7,
   * requirement 9.5). Holds each open section's page summaries and block text
   * until the section closes and its summary is produced.
   */
  sectionContent: SectionContentState;
  /**
   * The produced summary hierarchy so far (page/section/chapter/document). A
   * summary is appended as its section closes (or at the end for chapter and
   * document), so a resume reads the summaries already produced from here rather
   * than re-calling the text-LLM. Ends up on `document.end.summaries`.
   */
  summaries: SummaryNode[];
  /**
   * A paragraph/list of the last folded page that continues on the next one
   * (contract 2.3, text-continuation.ts), so the next page's first block can
   * name it as `continuationOf`.
   */
  textContinuation: TextContinuationState;
  /** The last page folded in, so the runner knows where to resume. */
  lastPage: number;
}

/** An empty starting state (the pass before page 1). */
export function emptyDocpassState(): DocpassState {
  return {
    version: 1,
    outline: emptyOutlineState(),
    tables: emptyTableMergeState(),
    identifiers: emptyIdentifierState(),
    furniture: emptyFurnitureState(),
    refs: emptyRefRegistry(),
    sectionContent: emptySectionContentState(),
    summaries: [],
    textContinuation: emptyTextContinuationState(),
    lastPage: 0,
  };
}

/** Coerce an unknown persisted value back to a valid {@link DocpassState}. */
export function parseDocpassState(value: unknown): DocpassState {
  if (typeof value !== "object" || value === null) return emptyDocpassState();
  const v = value as Partial<DocpassState>;
  return {
    version: 1,
    outline: parseOutlineState(v.outline),
    tables: parseTableMergeState(v.tables),
    identifiers: parseIdentifierState(v.identifiers),
    furniture: parseFurnitureState(v.furniture),
    refs: parseRefRegistry(v.refs),
    sectionContent: parseSectionContentState(v.sectionContent),
    summaries: parseSummaries(v.summaries),
    textContinuation: parseTextContinuationState(v.textContinuation),
    lastPage: typeof v.lastPage === "number" ? v.lastPage : 0,
  };
}

/** Coerce persisted summary nodes back to a valid {@link SummaryNode} list. */
function parseSummaries(value: unknown): SummaryNode[] {
  if (!Array.isArray(value)) return [];
  const scopes = new Set(["page", "section", "chapter", "document"]);
  return value.filter(
    (s): s is SummaryNode =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as SummaryNode).id === "string" &&
      typeof (s as SummaryNode).summary === "string" &&
      scopes.has((s as SummaryNode).scope),
  );
}

/** Coerce a persisted ref registry back to a valid {@link RefRegistry}. */
function parseRefRegistry(value: unknown): RefRegistry {
  if (typeof value !== "object" || value === null) return emptyRefRegistry();
  const v = value as Partial<RefRegistry>;
  return {
    figures: Array.isArray(v.figures)
      ? v.figures.filter((f) => typeof f === "object" && f !== null && typeof (f as { ordinal?: unknown }).ordinal === "number")
      : [],
    tables: Array.isArray(v.tables)
      ? v.tables.filter((t) => typeof t === "object" && t !== null && typeof (t as { ordinal?: unknown }).ordinal === "number")
      : [],
    sections: Array.isArray(v.sections)
      ? v.sections.filter((s) => typeof s === "object" && s !== null && typeof (s as { numbering?: unknown }).numbering === "string")
      : [],
  };
}

/** Optional tuning for the pass. */
export interface DocumentPassConfig {
  /** Override / extend the identifier regex classes (design §5 S7). */
  identifierClasses?: readonly IdentifierClass[];
  /** Override the furniture rolling-window tunables. */
  furnitureWindow?: RollingWindowConfig;
  /**
   * Authoritative heading levels keyed by normalised heading text (DOCX styles,
   * requirement 10.3). A heading in this map takes its level from here, ahead of
   * numbering and line height.
   */
  headingLevelHints?: ReadonlyMap<string, number>;
}

/** What `applyPage` returns: the enriched record, furniture and closed sections. */
export interface AppliedPage {
  record: PageRecord;
  /** The furniture recognised on this page (also placed on the record). */
  furniture: Furniture | null;
  /**
   * The sections that CLOSED on this page (task 2.7, requirement 9.5). A
   * section closes when a sibling/ancestor heading opens; each closed section is
   * the "section ended" event the summary generator turns into an
   * abschnitts-summary. Deepest-first, mirroring the outline pop order. Empty on
   * a page that opened no closing heading.
   */
  closedSections: ClosedOutlineNode[];
}

/** The streaming document pass surface. */
export interface DocumentPass {
  /**
   * Fold ONE page's record into the running state and return the enriched
   * record: every block gets a `sectionPath` and any `refs`, tables get their
   * merged `tableId`/`continuationOf`, identifiers are indexed, and the page's
   * furniture is recognised and placed on `record.furniture`. Pages MUST be fed
   * in strict ascending order. `analysis` is this page's S2 geometry, used for
   * heading line-heights and furniture bands; it may be null when unavailable.
   * `next` is page N+1's BASE record (read-only), for the paragraph that runs
   * over the page break; null/omitted on the last page or when unavailable.
   */
  applyPage(record: PageRecord, analysis?: PageAnalysis | null, next?: PageRecord | null): AppliedPage;
  /** The serialisable running state to persist after the applied page. */
  snapshot(): DocpassState;
  /**
   * The summary-generation input for a closed section (task 2.7): the Pass-1
   * summaries of the section's pages plus its own block text, bounded
   * (RAPTOR-light). Empty string when the section has no accumulated content.
   */
  sectionInput(sectionId: string, pageStart: number, pageEnd: number): string;
  /** Release a section's accumulated content once its summary is produced. */
  releaseSection(sectionId: string): void;
  /** The Pass-1 summary of a page, for chapter/document rollups. */
  pageSummary(page: number): string | undefined;
  /** Append a produced summary node to the running state (task 2.7). */
  addSummary(node: SummaryNode): void;
  /** True when a summary for this scope+id was already produced (resume guard). */
  hasSummary(scope: SummaryNode["scope"], id: string): boolean;
  /** The produced summary hierarchy so far, for `document.end.summaries`. */
  summaries(): SummaryNode[];
  /** The finished outline for `document.end` (closes all open headings). */
  outline(lastPage: number): OutlineNode[];
  /**
   * The finalize pass (task 5.4, requirement 9.6): the finished outline with
   * provisional heading levels corrected once the whole document's height
   * distribution is known, plus the list of sections whose `sectionPath`
   * changed so Search re-embeds exactly those. Deterministic and model-free —
   * an OPTIONAL metadata correction the emitter runs at document end when
   * `FINALIZE_PASS` is enabled.
   */
  finalizeOutline(lastPage: number): FinalizedOutline;
  /**
   * The sections still open at document end (task 2.7): the outline nodes with
   * their final page ranges. The summary generator produces a section summary
   * for each of these too, since they never got a close event.
   */
  openSectionsAtEnd(lastPage: number): ClosedOutlineNode[];
  /** The finished identifier index for `document.end`. */
  identifiers(): IdentifierEntry[];
  /** The document-level refs collected across all pages, for `document.end`. */
  documentRefs(): Ref[];
  /** The heading chain in force after the last applied page (prev-page context). */
  headingChain(): string[];
}

/**
 * Create a streaming document pass, optionally rehydrated from persisted state
 * so a resume continues the exact same pass (design §9a.2). Deterministic.
 */
export function createDocumentPass(
  initial: DocpassState = emptyDocpassState(),
  config: DocumentPassConfig = {},
): DocumentPass {
  const state = parseDocpassState(initial);
  const outlineStack: OutlineStack = createOutlineStack(
    state.outline,
    config.headingLevelHints ?? new Map(),
  );
  const tableMerger: TableMerger = createTableMerger(state.tables);
  const identifierIndex: IdentifierIndex = createIdentifierIndex(
    state.identifiers,
    config.identifierClasses,
  );
  const furniture: FurnitureDetector = createFurnitureDetector(
    state.furniture,
    config.furnitureWindow,
  );
  const sectionContent: SectionContentAccumulator = createSectionContentAccumulator(
    state.sectionContent,
  );
  const summaryList: SummaryNode[] = state.summaries.map((s) => ({ ...s }));
  const refRegistry: RefRegistry = state.refs;
  let lastPage = state.lastPage;
  let textContinuation: TextContinuationState = state.textContinuation;
  // Accumulated document-level refs (a flat list mirroring the per-block refs)
  // so `document.end` carries the whole lightweight document graph.
  const docRefs: Ref[] = [];

  /** The line height of a heading block, from this page's S2 analysis. */
  function headingHeight(block: Block, analysis: PageAnalysis | null | undefined): number | undefined {
    if (analysis == null || block.type !== "heading") return undefined;
    const text = block.text.replace(/\s+/g, " ").trim();
    // Match the heading text to a line on the page to read its font-size proxy.
    const line = analysis.lines.find((l) => l.text.replace(/\s+/g, " ").trim() === text);
    return line?.height;
  }

  function applyPage(record: PageRecord, analysis?: PageAnalysis | null, next?: PageRecord | null): AppliedPage {
    // ── Furniture (task 2.2) ──────────────────────────────────────────────
    // Feed the page's geometry to the rolling-window detector; the recognised
    // header/footer/pageLabel is placed on the record. When no analysis is
    // available the detector sees no bands and yields null.
    const detected = analysis != null ? furniture.observe(analysis) : null;

    // ── Tables: merge across the page boundary (9.2) ─────────────────────
    // Collect the table blocks in reading order with their continuation flags,
    // decide ids/merges, then apply the mutations back onto the blocks.
    const tableBlocks: TableBlock[] = record.blocks.filter(
      (b): b is TableBlock => b.type === "table",
    );
    const tableDecisions = tableMerger.observePage(
      tableBlocks.map((t) => ({ headerRows: t.headerRows, rows: t.rows, caption: t.caption })),
      tableBlocks.map((t) => ({ continues: t.continues === true, continuationOf: t.continuationOf !== undefined })),
      record.page,
    );
    tableBlocks.forEach((table, i) => {
      const decision = tableDecisions[i];
      if (decision === undefined) return;
      table.tableId = decision.tableId;
      // A merged continuation points at its predecessor's real tableId; an
      // unmerged one drops the provisional Pass-1 marker so no block ever
      // references a table id that does not exist.
      if (decision.continuationOf !== undefined) table.continuationOf = decision.continuationOf;
      else delete table.continuationOf;
      table.continues = decision.continues;
      // A continuation that omits the header gets it back, so its rows are
      // indexed and read with their column names (and the caption, marked).
      if (decision.inheritedHeaderRows !== undefined && table.headerRows.length === 0) {
        table.headerRows = decision.inheritedHeaderRows.map((row) => [...row]);
      }
      if (decision.inheritedCaption !== undefined && (table.caption === undefined || table.caption.trim() === "")) {
        table.caption = `${decision.inheritedCaption} (Fortsetzung)`;
      }
      // Register the table's author ordinal (from a "Tabelle n" caption) so a
      // later "Tabelle n" cross-reference resolves.
      const ord = tableCaptionOrdinal(table.caption);
      if (ord !== null && !refRegistry.tables.some((e) => e.tableId === decision.tableId)) {
        refRegistry.tables.push({ ordinal: ord, tableId: decision.tableId, page: record.page });
      }
    });

    // Record this page's Pass-1 summary for the summary hierarchy (task 2.7):
    // it is the RAPTOR-light bottom layer that section/chapter/document
    // summaries roll up from.
    if (record.summary !== undefined) sectionContent.observePageSummary(record.page, record.summary);

    // ── Outline + sectionPath (9.1), refs (9.3), identifiers (9.4) ────────
    // Walk the blocks in order. A heading advances the outline stack; every
    // block is then stamped with the current path. Figure captions register
    // their ordinal; block text is scanned for refs and identifiers.
    const closedSections: ClosedOutlineNode[] = [];
    for (const block of record.blocks) {
      if (block.type === "heading") {
        const { sectionId, closed } = outlineStack.observeHeading(
          { text: block.text, ...(block.numbering !== undefined ? { numbering: block.numbering } : {}) },
          record.page,
          headingHeight(block, analysis),
        );
        // Each popped heading is a closed section (task 2.7): the "section
        // ended" event the summary generator triggers on. Collect them in order.
        closedSections.push(...closed);
        // Register the heading numbering so "Kapitel x.y" resolves.
        if (block.numbering !== undefined) {
          const numbering = block.numbering.replace(/\.$/, "");
          if (!refRegistry.sections.some((s) => s.numbering === numbering)) {
            refRegistry.sections.push({ numbering, sectionId });
          }
        }
      }

      // Stamp the current section path (after the heading above updated it, so a
      // heading block carries its own path).
      const path = outlineStack.currentPath();
      if (path.length > 0) block.sectionPath = path;

      // Register a figure caption ordinal for "Abbildung n" resolution.
      if (block.type === "figure") {
        const ord = captionOrdinal(block.caption);
        if (ord !== null && !refRegistry.figures.some((f) => f.figureId === block.figureId)) {
          refRegistry.figures.push({ ordinal: ord, figureId: block.figureId, page: record.page });
        }
      }

      // Refs and identifiers from the block's textual content.
      const text = blockText(block);
      if (text !== "") {
        const refs = extractRefs(text, refRegistry);
        if (refs.length > 0) {
          block.refs = refs;
          docRefs.push(...refs);
        }
        identifierIndex.observe(text, record.page, block.id);
        // Accumulate the block's text under the deepest open section, so the
        // section's summary input is ready when it closes (task 2.7). A block
        // with no open section (a preamble before any heading) is not tagged.
        const sectionIds = outlineStack.currentSectionIds();
        const deepest = sectionIds[sectionIds.length - 1];
        if (deepest !== undefined) sectionContent.observeBlock(deepest, text);
      }
      // A figure's labels are identifier-bearing too (field labels, codes).
      if (block.type === "figure" && block.labels !== undefined) {
        for (const label of block.labels) identifierIndex.observe(label, record.page, block.id);
      }
    }

    if (detected !== null) record.furniture = detected;
    // A paragraph running over the page break (after furniture, so running
    // headers/footers are not taken for its continuation).
    textContinuation = applyTextContinuation(record, next, textContinuation);
    lastPage = Math.max(lastPage, record.page);
    return { record, furniture: detected, closedSections };
  }

  function snapshot(): DocpassState {
    return {
      version: 1,
      outline: outlineStack.snapshot(),
      tables: tableMerger.snapshot(),
      identifiers: identifierIndex.snapshot(),
      furniture: furniture.snapshot(),
      refs: {
        figures: refRegistry.figures.map((f) => ({ ...f })),
        tables: refRegistry.tables.map((t) => ({ ...t })),
        sections: refRegistry.sections.map((s) => ({ ...s })),
      },
      sectionContent: sectionContent.snapshot(),
      summaries: summaryList.map((s) => ({ ...s })),
      textContinuation: { ...textContinuation },
      lastPage,
    };
  }

  /**
   * The sections still open at document end: the outline's remaining open
   * stack, closed here against `lastPage` so each gets a final page range. The
   * summary generator produces a section summary for these too, since a section
   * that runs to the end of the document never fires a mid-document close event.
   */
  function openSectionsAtEnd(last: number): ClosedOutlineNode[] {
    const openIds = new Set(outlineStack.currentSectionIds());
    return outlineStack
      .finish(last)
      .filter((node) => openIds.has(node.sectionId));
  }

  return {
    applyPage,
    snapshot,
    sectionInput: (id, pageStart, pageEnd) => sectionContent.sectionInput(id, pageStart, pageEnd),
    releaseSection: (id) => sectionContent.release(id),
    pageSummary: (page) => sectionContent.pageSummary(page),
    addSummary: (node) => {
      if (!summaryList.some((s) => s.scope === node.scope && s.id === node.id)) {
        summaryList.push({ ...node });
      }
    },
    hasSummary: (scope, id) => summaryList.some((s) => s.scope === scope && s.id === id),
    summaries: () => summaryList.map((s) => ({ ...s })),
    outline: (last) => outlineStack.finish(last),
    finalizeOutline: (last) => finalizeOutlineNodes(outlineStack.finish(last)),
    openSectionsAtEnd,
    identifiers: () => identifierIndex.entries(),
    documentRefs: () => docRefs.map((r) => ({ ...r })),
    headingChain: () => outlineStack.headingChain(),
  };
}

/** The concatenated textual content of a block, for ref/identifier scanning. */
function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
      return block.text;
    case "paragraph":
    case "footnote":
    case "code":
      return block.text;
    case "list":
      return block.items.join("\n");
    case "figure":
      return [block.caption, block.description, block.regionText].filter(Boolean).join("\n");
    case "table":
      return [block.caption, ...block.rows.flat().map((c) => (typeof c === "string" ? c : c.text))]
        .filter(Boolean)
        .join(" ");
    default:
      return "";
  }
}

/** The author ordinal of a "Tabelle n: …" caption, or null. */
function tableCaptionOrdinal(caption: string | undefined): number | null {
  if (caption === undefined) return null;
  const m = /^(?:Tabelle|Tab\.?)\s+(\d+)/i.exec(caption.trim());
  return m?.[1] !== undefined ? Number(m[1]) : null;
}
