// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * batch-unit-builder.ts
 *
 * The full multi-level index-unit builder for the v2 batch worker.
 * It replaces the transitional builder of task 1.10 (chunk + figure only,
 * char-based chunking, tables folded into text).
 *
 * It turns the typed v2 records of a staged NDJSON batch (@atf/extract-contract
 * v2) into the multi-level set of index units search retrieves and expands over
 *
 *   - `chunk`    — 350–500 token, section-bounded runs of text blocks. Token
 * count is measured with the TEI token counter; a
 *                  chunk never spans two different section paths (Req 11.2).
 *   - `table`    — the whole table when it fits the chunk token budget, else
 *                  row-groups that REPEAT the header rows and share a `tableId`
 *                  (Req 11.3). The embed input is the rendered header+rows; the
 *                  stored `content` additionally carries a row-wise "Spalte:
 *                  Wert" rendering for the full-text search.
 *   - `figure`   — caption + description(summary) + transcription + labels.
 *   - `section`  — heading path + section summary (from the summary hierarchy).
 *   - `page`     — page summary + furniture (header/footer/label).
 *   - `document` — document summary + outline (levels 1–2).
 *
 * WHERE each unit type is built (consistent with how the emitter, task 2.7,
 * sends `document.end` as a trailing batch):
 *
 *   - `chunk` / `table` / `figure` are built from the `page` records of a batch
 *     — they are page-scoped and available as soon as a page batch is staged.
 *   - `section` / `page` / `document` are built from the `document.end` record's
 *     `summaries` + `outline`. Those are only known once the document pass has
 *     run, so they are emitted when the trailing `document.end` batch is
 *     processed. {@link buildUnitsFromRecords} routes both from one call so the
 *     worker does not have to special-case which record types a batch holds.
 *
 * The contextual header / per-chunk LLM sentence is task 3.3 — NOT applied here;
 * a chunk's embed input is its own text (section context is 3.3's job).
 *
 * Determinism (Requirement 5.5): every unit carries a deterministic `unit_id` —
 * a stable hash of (revision id, document id, unit_type, page/section
 * coordinates, block ids, ordinal) — so re-processing the same batch upserts in
 * place and never produces duplicate rows. {@link computeUnitId} is extended for
 * the new unit types but keeps existing chunk/figure ids stable where the
 * inputs are unchanged.
 */

import { createHash } from "node:crypto";
import type {
  Block,
  Cell,
  DocumentEndRecord,
  FigureBlock,
  OutlineNode,
  PageRecord,
  SummaryNode,
  TableBlock,
  Transcription,
} from "@atf/extract-contract";
import { chunkDocument } from "./chunker.js";

// ─── Unit shape ─────────────────────────────────────────────────────────────

/** The unit types the full multi-level builder emits. */
export type UnitType =
  | "chunk"
  | "table"
  | "figure"
  | "section"
  | "page"
  | "document";

/**
 * One index unit ready to embed and upsert. `unitId` is deterministic; `embedInput`
 * is what goes to the embedding model; `content` is what is stored/returned and
 * fed to full-text search.
 */
export interface IndexUnit {
  unitId: string;
  unitType: UnitType;
  /** Text sent to the embedding model. */
  embedInput: string;
  /** Text stored in the row's `content` column and indexed for FTS. */
  content: string;
  /** Section path from the block(s) / outline; empty when unknown. */
  sectionPath: string[];
  /** Section id this unit belongs to (chunk/table/figure) or names (section). */
  sectionId?: string;
  /**
   * Summary of the page(s) this unit covers, carried through from the source
   * `page` record's own `summary`. The contextual-header pass in the
   * batch worker uses it as the truncatable tail of a chunk/table/figure's
   * embedding header. Undefined when the page had no summary. It is NOT stored;
   * it only feeds the header build.
   */
  pageSummary?: string;
  pageStart: number;
  pageEnd: number;
  /** figure kind for figure units; undefined otherwise. */
  figureKind?: string;
  /** figure id for figure units. */
  figureId?: string;
  /** asset id for figure units, when the figure has a crop. */
  assetId?: string;
  /** table id for table units (shared across a table's row-groups). */
  tableId?: string;
  /** Figure ids referenced within this unit's span (text chunks). */
  figureRefs?: string[];
  /** Source v2 block ids this unit was built from (provenance + determinism). */
  blockIds: string[];
  /** Parent unit id: chunk/table/figure → section; section → parent section/document; page → document. */
  parentUnitId?: string;
  /** Previous sibling in reading order (adjacent chunk/section/page/row-group). */
  prevUnitId?: string;
  /** Next sibling in reading order. */
  nextUnitId?: string;
  /** 0-based ordinal within its scope, used to keep ids stable and order units. */
  ordinal: number;
  /**
   * The length of the part of `content` that is this unit's own document
   * text. For a `table` the rest is the section identifier line ("IDs: …")
   * and the row-wise "Spalte: Wert" text; for a `chunk` ending in a
   * paragraph that runs over the page break it is the carried continuation
   * from the next page (contract 2.3). Either is there for full-text search
   * and embedding and is not read back as document text.
   */
  displayLen?: number;
}

/**
 * Counts tokens for a text the way the embedding model's tokenizer does. This
 * is the surface of the task-3.1 token counter the builder depends on; passing
 * only `countBatch` keeps the builder trivially testable with a stub.
 */
export interface UnitTokenCounter {
  countBatch(texts: string[], signal?: AbortSignal): Promise<number[]>;
}

export interface BuildUnitsInput {
  /** Revision this batch belongs to; the primary determinism anchor (Req 5.5). */
  revisionId: string;
  /** Document reference (Search's X-Reference). */
  reference: string;
  /** Stable document identity; falls back to the reference. */
  documentId: string;
  /** The decoded `page` records of the batch, in page order. */
  pages: PageRecord[];
  /** The `document.end` record when this batch carries it (trailing batch). */
  documentEnd?: DocumentEndRecord | undefined;
  /** Token counter used to size chunks and split tables. */
  tokenCounter: UnitTokenCounter;
  /** Minimum tokens per text chunk before a boundary is preferred. Default 350. */
  minChunkTokens?: number;
  /** Maximum tokens per text chunk / table row-group (Req 11.2/11.3). Default 500. */
  maxChunkTokens?: number;
}

// ─── Deterministic unit id ──────────────────────────────────────────────────

/**
 * A stable identifier for a unit. It hashes the revision-or-document anchor, the
 * unit type, the page/section coordinates and the source block ids — the exact
 * inputs the task calls out — so the SAME batch reprocessed yields the SAME id
 * and the upsert on (tenant_id, unit_id) replaces in place (Requirement 5.5).
 *
 * The revision id anchors the id to this ingest so two revisions of one document
 * get distinct units (visibility/atomic-switch is task 1.13); the block ids and
 * ordinal make sibling units on a page/section distinct and order-stable. New
 * unit types (table/section/page/document) share the same canonical form, so a
 * `chunk` and a `table` on the same coordinates still get distinct ids via the
 * `unitType` component.
 */
export function computeUnitId(parts: {
  revisionId: string;
  documentId: string;
  unitType: UnitType;
  pageStart: number;
  pageEnd: number;
  sectionPath: string[];
  blockIds: string[];
  ordinal: number;
}): string {
  const canonical = [
    parts.revisionId,
    parts.documentId,
    parts.unitType,
    `${parts.pageStart}-${parts.pageEnd}`,
    parts.sectionPath.join("/"),
    parts.blockIds.join(","),
    String(parts.ordinal),
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

// ─── Block → text rendering ─────────────────────────────────────────────────

/** Is this a text-ish block folded into a `chunk` unit? (Tables/figures are their own units.) */
function isTextBlock(block: Block): boolean {
  return (
    block.type === "heading" ||
    block.type === "paragraph" ||
    block.type === "footnote" ||
    block.type === "code" ||
    block.type === "list"
  );
}

/** The flat text of a table cell. */
function cellText(cell: Cell): string {
  return typeof cell === "string" ? cell : cell.text;
}

/** Render one text block to plain text for chunking. */
function renderTextBlock(block: Block): string {
  switch (block.type) {
    case "heading": {
      const prefix = "#".repeat(Math.min(block.level, 6));
      const numbering = block.numbering ? `${block.numbering} ` : "";
      return `${prefix} ${numbering}${block.text}`.trim();
    }
    case "paragraph":
    case "footnote":
    case "code":
      return block.text;
    case "list":
      return block.items.map((item) => `- ${item}`).join("\n");
    default:
      return "";
  }
}

/** The next page's leading fragment a block that runs over the page break carries (contract 2.3). */
function carriedContinuation(block: Block | undefined): string | undefined {
  if (block === undefined || (block.type !== "paragraph" && block.type !== "list")) return undefined;
  if (block.continues !== true) return undefined;
  const text = block.continuationText?.trim();
  return text !== undefined && text !== "" ? text : undefined;
}

/**
 * Join a chunk and the continuation fragment. The chunk stays a verbatim
 * prefix (its length is the unit's `displayLen`): a word hyphenated at the
 * break ("Liefe-" + "rant") is joined directly, anything else with a space.
 */
function joinContinuation(piece: string, fragment: string): string {
  return /[A-Za-zÄÖÜäöüß]-$/.test(piece) && /^[a-zäöüß]/.test(fragment) ? `${piece}${fragment}` : `${piece} ${fragment}`;
}

/** The figure ids referenced by a block's resolved cross-references. */
function figureRefsOf(block: Block): string[] {
  if (!block.refs) return [];
  const ids: string[] = [];
  for (const ref of block.refs) {
    if (ref.kind !== "figure") continue;
    // Prefer the resolved target id; fall back to the reference text so a
    // dangling reference still records something traceable.
    const id = ref.target ?? ref.text;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Render a figure's transcription to searchable text. */
function renderTranscription(transcription: Transcription): string {
  switch (transcription.format) {
    case "process": {
      const steps = transcription.steps.join("\n");
      const nodes = transcription.nodes.map((n) => n.label).join(", ");
      return [steps, nodes].filter(Boolean).join("\n");
    }
    case "fields": {
      const fields = transcription.areas
        .flatMap((area) => area.fields.map((f) => `${area.name}: ${f.label}`))
        .join("\n");
      const actions = transcription.actions.join(", ");
      return [fields, actions].filter(Boolean).join("\n");
    }
    case "drawing": {
      const title = Object.entries(transcription.titleBlock)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      const notes = (transcription.notes ?? []).join("\n");
      return [title, notes].filter(Boolean).join("\n");
    }
    case "data": {
      return transcription.table
        .map((row) => row.map((c) => cellText(c)).join(" | "))
        .join("\n");
    }
    case "markdown":
      return transcription.text;
    default:
      return "";
  }
}

/** The stored/embedded text of a figure unit: caption + description + transcription + labels. */
export function renderFigureText(figure: FigureBlock): string {
  const parts: string[] = [];
  if (figure.caption) parts.push(figure.caption);
  parts.push(figure.description);
  if (figure.transcription) {
    const transcript = renderTranscription(figure.transcription);
    if (transcript) parts.push(transcript);
  }
  if (figure.labels && figure.labels.length > 0) {
    parts.push(figure.labels.join(", "));
  }
  return parts.filter((p) => p.trim() !== "").join("\n\n");
}

// ─── Table rendering (Requirement 11.3) ──────────────────────────────────────

/** The header labels of a table: the flattened cells of its last header row. */
function tableHeaderLabels(table: TableBlock): string[] {
  const headerRow =
    table.headerRows.length > 0
      ? table.headerRows[table.headerRows.length - 1]
      : undefined;
  return headerRow ? headerRow.map((c) => cellText(c)) : [];
}

/** Render header rows + body rows as pipe rows (the embed input of a table unit). */
export function renderTableRows(headerRows: Cell[][], rows: Cell[][]): string {
  const line = (row: Cell[]): string => row.map((c) => cellText(c)).join(" | ");
  return [...headerRows, ...rows].map(line).join("\n");
}

/**
 * A row-wise "Spalte: Wert" (column: value) rendering of a table's body rows
 * for the full-text search (Requirement 11.3). Each body row becomes one line
 * of "Header1: cell1; Header2: cell2; …" so an FTS query like "Status: offen"
 * matches even though the value sits in a grid cell. Columns without a header
 * label fall back to a 1-based positional label.
 */
export function renderTableColumnValue(
  headerLabels: string[],
  rows: Cell[][],
): string {
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          const label = headerLabels[i]?.trim() || `Spalte ${i + 1}`;
          return `${label}: ${cellText(cell)}`;
        })
        .join("; "),
    )
    .join("\n");
}

// ─── Section context ──────────────────────────────────────────────────────────

/** A stable-ish section id from a section path (used to link a chunk to its section). */
function sectionIdFromPath(sectionPath: string[]): string | undefined {
  return sectionPath.length > 0 ? sectionPath.join("/") : undefined;
}

// ─── Section grouping for chunk units ────────────────────────────────────────

interface TextGroup {
  sectionPath: string[];
  blocks: Block[];
}

/**
 * Group a page's text blocks into contiguous runs that share the SAME section
 * path, in reading order. A chunk must never span two section paths (Req 11.2),
 * so each group is chunked independently.
 */
function groupTextBlocksBySection(blocks: Block[]): TextGroup[] {
  const groups: TextGroup[] = [];
  for (const block of blocks) {
    if (!isTextBlock(block)) continue;
    const sectionPath = block.sectionPath ?? [];
    const last = groups[groups.length - 1];
    if (last && samePath(last.sectionPath, sectionPath)) {
      last.blocks.push(block);
    } else {
      groups.push({ sectionPath, blocks: [block] });
    }
  }
  return groups;
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ─── Section identity for table units ──────────────────────────────────────

/**
 * Identifier-shaped code: two or more uppercase groups joined by dashes,
 * e.g. "QAP-DOK-03" or "ISO-9001". These are the codes a reader quotes when
 * asking for a section ("Welche ID hat die Station? → QAP-DOK-03");
 * they sit in the section's heading/ID paragraph, not in the section's tables.
 */
const SECTION_IDENTIFIER_RE = /\b[A-Z]{2,}(?:-[A-Z0-9]{2,})+\b/g;

/** Cap how many identifier codes one section identity line carries. */
const MAX_SECTION_IDENTIFIERS = 8;

/**
 * The identifier codes of a section as found on ONE page: every
 * identifier-shaped token in the page's text blocks that share the section
 * path. A `table` unit's own rows are often near-identical across sibling
 * sections (the same form table repeated per variant); without the section's
 * ID codes the reranker cannot tell them apart and the section's `chunk`
 * unit — which carries the "ID: …" line — gets crowded out of the top-k
 * (Bench regression: QAP-DOK-03 fell to rank 15 behind three identical
 * "Eingabe-Möglichkeit" table fragments). Prepending the codes keeps each
 * table unit searchable and rankable under its own section identity.
 *
 * Same-page only on purpose: the builder stays independent of batch
 * boundaries, and the section heading/ID paragraph sits on the page its
 * tables start on in practice. Returns undefined when the page carries no
 * codes for the section, leaving the table units unchanged.
 */
function sectionIdentifierLine(
  blocks: Block[],
  sectionPath: string[],
): string | undefined {
  const ids: string[] = [];
  for (const block of blocks) {
    if (!isTextBlock(block)) continue;
    if (!samePath(block.sectionPath ?? [], sectionPath)) continue;
    for (const match of renderTextBlock(block).matchAll(SECTION_IDENTIFIER_RE)) {
      const code = match[0];
      if (code.length <= 40 && !ids.includes(code)) ids.push(code);
      if (ids.length >= MAX_SECTION_IDENTIFIERS) break;
    }
    if (ids.length >= MAX_SECTION_IDENTIFIERS) break;
  }
  return ids.length > 0 ? `IDs: ${ids.join(", ")}` : undefined;
}

// ─── Token-aware chunk assembly ──────────────────────────────────────────────

/**
 * Split one section-bounded text into 350–500 token chunks.
 *
 * Strategy: char-chunk the text (reusing the boundary-aware {@link chunkDocument}
 * so splits land on heading/paragraph/sentence/word boundaries), then MEASURE
 * each candidate with the token counter and re-pack:
 *   - candidates are greedily concatenated until adding the next would exceed
 *     `maxTokens`; a group of ≥ `minTokens` (or the last group) is flushed;
 *   - a single candidate already over `maxTokens` is emitted as its own oversize
 *     chunk (a block bigger than the budget stays whole rather than being cut
 *     mid-sentence — Req 11.2's "abschnittstreu" over hard token slicing).
 *
 * Char sizing for the initial split is derived from the token budget (~4 chars/
 * token) so the candidates are already close to target and the counter is only
 * asked once per candidate.
 */
async function chunkSectionText(
  text: string,
  minTokens: number,
  maxTokens: number,
  tokenCounter: UnitTokenCounter,
): Promise<string[]> {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  // ~4 chars per token; aim candidate size at the middle of the band so a
  // candidate is unlikely to already exceed max on its own.
  const targetChars = Math.max(80, Math.round(((minTokens + maxTokens) / 2) * 4));
  const overlapChars = 0; // units are packed by tokens; char overlap would double-count text.
  const candidates = chunkDocument(trimmed, targetChars, overlapChars)
    .map((c) => c.content.trim())
    .filter((c) => c !== "");
  if (candidates.length === 0) return [];

  const counts = await tokenCounter.countBatch(candidates);

  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    chunks.push(buffer.join("\n\n"));
    buffer = [];
    bufferTokens = 0;
  };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] as string;
    const tokens = counts[i] ?? Math.ceil(candidate.length / 4);

    // A single candidate over budget: flush what we have, emit it standalone.
    if (tokens >= maxTokens) {
      flush();
      chunks.push(candidate);
      continue;
    }

    // Adding this candidate would push the buffer over budget → flush first.
    if (bufferTokens > 0 && bufferTokens + tokens > maxTokens) {
      flush();
    }

    buffer.push(candidate);
    bufferTokens += tokens;

    // Reached the lower bound → flush a well-sized chunk.
    if (bufferTokens >= minTokens) {
      flush();
    }
  }
  flush();
  return chunks;
}

// ─── Sibling linking ──────────────────────────────────────────────────────────

/**
 * Wire prev/next links across an ordered list of units in place, so reading-order
 * neighbours can be walked (small-to-big expansion, task 4.x). Each unit's
 * `prevUnitId`/`nextUnitId` point at its immediate siblings within the list.
 */
function linkSiblings(units: IndexUnit[]): void {
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (!unit) continue;
    const prev = units[i - 1];
    const next = units[i + 1];
    if (prev) unit.prevUnitId = prev.unitId;
    if (next) unit.nextUnitId = next.unitId;
  }
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build the full multi-level index units for a batch's records.
 *
 * Page records yield `chunk`/`table`/`figure` units; a `document.end` record
 * yields `section`/`page`/`document` units from its summaries + outline. Empty
 * units are dropped. Output order is stable and deterministic given the same
 * input, which — with {@link computeUnitId} — makes reprocessing idempotent.
 */
export async function buildUnitsFromRecords(
  input: BuildUnitsInput,
): Promise<IndexUnit[]> {
  const contentUnits = await buildContentUnits(input);
  const summaryUnits = input.documentEnd
    ? buildSummaryUnits(input, input.documentEnd)
    : [];
  return [...contentUnits, ...summaryUnits];
}

/** Build chunk / table / figure units from the batch's page records. */
async function buildContentUnits(input: BuildUnitsInput): Promise<IndexUnit[]> {
  const { revisionId, documentId, pages, tokenCounter } = input;
  const minTokens = input.minChunkTokens ?? 350;
  const maxTokens = input.maxChunkTokens ?? 500;
  const units: IndexUnit[] = [];

  for (const page of pages) {
    // Track per-section chunk ordinals so a section spanning several groups on a
    // page keeps a monotonically increasing, order-stable chunk ordinal.
    const chunkOrdinalBySection = new Map<string, number>();
    // Per-section identifier codes ("IDs: …") for this page's table units,
    // cached per section path (see sectionIdentifierLine).
    const identityBySection = new Map<string, string | undefined>();

    for (const block of page.blocks) {
      // ── table units (Requirement 11.3) ────────────────────────────────────
      if (block.type === "table") {
        const tableSectionKey = (block.sectionPath ?? []).join("/");
        if (!identityBySection.has(tableSectionKey)) {
          identityBySection.set(
            tableSectionKey,
            sectionIdentifierLine(page.blocks, block.sectionPath ?? []),
          );
        }
        units.push(
          ...(await buildTableUnits(
            block,
            page,
            revisionId,
            documentId,
            maxTokens,
            tokenCounter,
            identityBySection.get(tableSectionKey),
          )),
        );
        continue;
      }

      // ── figure units ──────────────────────────────────────────────────────
      if (block.type === "figure") {
        const unit = buildFigureUnit(
          block,
          revisionId,
          documentId,
          page.summary,
        );
        if (unit) units.push(unit);
        continue;
      }
    }

    // ── chunk units (section-bounded, token-sized) ──────────────────────────
    const groups = groupTextBlocksBySection(page.blocks);
    for (const group of groups) {
      const rendered = group.blocks
        .map(renderTextBlock)
        .filter((t) => t.trim() !== "");
      if (rendered.length === 0) continue;
      const text = rendered.join("\n\n");
      const blockIds = group.blocks.map((b) => b.id);
      const figureRefs = dedupe(group.blocks.flatMap(figureRefsOf));
      const sectionKey = group.sectionPath.join("/");
      const sectionId = sectionIdFromPath(group.sectionPath);

      const pieces = await chunkSectionText(
        text,
        minTokens,
        maxTokens,
        tokenCounter,
      );
      // A paragraph running over the page break (contract 2.3): the group's
      // last chunk also carries the leading fragment of its continuation, so
      // the sentence is searchable and embedded whole. The fragment is not
      // this page's text: `displayLen` keeps it out of document reads.
      const lastBlock = group.blocks[group.blocks.length - 1];
      const carried = carriedContinuation(lastBlock);
      const lastPieceIndex = pieces
        .map((p) => p.trim() !== "")
        .lastIndexOf(true);
      for (const [pieceIndex, rawPiece] of pieces.entries()) {
        if (rawPiece.trim() === "") continue;
        const withCarry =
          pieceIndex === lastPieceIndex && carried !== undefined;
        const piece = withCarry
          ? joinContinuation(rawPiece, carried)
          : rawPiece;
        const ordinal = chunkOrdinalBySection.get(sectionKey) ?? 0;
        chunkOrdinalBySection.set(sectionKey, ordinal + 1);
        const unitId = computeUnitId({
          revisionId,
          documentId,
          unitType: "chunk",
          pageStart: page.page,
          pageEnd: page.page,
          sectionPath: group.sectionPath,
          blockIds,
          ordinal,
        });
        units.push({
          unitId,
          unitType: "chunk",
          embedInput: piece,
          content: piece,
          sectionPath: group.sectionPath,
          ...(sectionId ? { sectionId } : {}),
          ...(page.summary ? { pageSummary: page.summary } : {}),
          pageStart: page.page,
          pageEnd: page.page,
          ...(figureRefs.length > 0 ? { figureRefs } : {}),
          blockIds,
          ordinal,
          ...(withCarry ? { displayLen: rawPiece.length } : {}),
        });
      }
    }
  }

  linkContentSiblings(units, revisionId, documentId);
  return units;
}

/**
 * Build the row-group `table` units for one table block (Requirement 11.3).
 *
 * A table that fits the token budget → one `table` unit. A table over budget →
 * several `table` units, each a row-group that repeats the header rows, shares
 * the same `tableId` and is linked prev/next. Every row-group's `content` holds
 * the header+rows AND the row-wise "Spalte: Wert" text so both the grid and the
 * column/value form are full-text searchable.
 *
 * `sectionIdentity` (when present) is the section's identifier line ("IDs: …",
 * see {@link sectionIdentifierLine}); it is prepended to every row-group's
 * embed input so near-identical tables across sibling sections stay
 * distinguishable for embedding and reranking. It is context, not the table's
 * own text, so `displayLen` (the document-read portion) excludes it.
 */
async function buildTableUnits(
  table: TableBlock,
  page: PageRecord,
  revisionId: string,
  documentId: string,
  maxTokens: number,
  tokenCounter: UnitTokenCounter,
  sectionIdentity?: string,
): Promise<IndexUnit[]> {
  if (table.rows.length === 0 && table.headerRows.length === 0) return [];

  const sectionPath = table.sectionPath ?? [];
  const sectionId = sectionIdFromPath(sectionPath);
  const headerLabels = tableHeaderLabels(table);
  const caption = table.caption ? `${table.caption}\n` : "";
  // The identity rides along with every row-group and counts against the
  // token budget like the caption does.
  const identity = sectionIdentity ? `${sectionIdentity}\n` : "";

  // Decide how many rows fit per group by measuring the whole table first.
  const wholeRendered = `${identity}${caption}${renderTableRows(table.headerRows, table.rows)}`;
  const [wholeTokens] = await tokenCounter.countBatch([wholeRendered]);
  const fitsWhole =
    (wholeTokens ?? Math.ceil(wholeRendered.length / 4)) <= maxTokens;

  const rowGroups: Cell[][][] = fitsWhole
    ? [table.rows]
    : await splitRowsToBudget(
        table,
        `${identity}${caption}`,
        headerLabels,
        maxTokens,
        tokenCounter,
      );

  const units: IndexUnit[] = [];
  rowGroups.forEach((groupRows, ordinal) => {
    const rowsText = renderTableRows(table.headerRows, groupRows);
    const columnValue = renderTableColumnValue(headerLabels, groupRows);
    // The table's own document text (caption + grid) — what a document read
    // returns. The section identity is search/embed context only: it goes
    // AFTER the grid (so a document read, which keeps the first `displayLen`
    // characters, never sees it) but BEFORE the row-wise lines (so the rerank
    // truncation at 1024 tokens, which trims the tail of `content`, keeps it).
    const ownText = `${caption}${rowsText}`.trim();
    const embedInput = `${identity}${ownText}`.trim();
    // FTS content = rendered grid + identity + "Spalte: Wert" per-row lines.
    const content = [ownText, sectionIdentity, columnValue]
      .filter((p) => p !== undefined && p.trim() !== "")
      .join("\n\n");
    if (content.trim() === "") return;
    const unitId = computeUnitId({
      revisionId,
      documentId,
      unitType: "table",
      pageStart: page.page,
      pageEnd: page.page,
      sectionPath,
      blockIds: [table.id],
      ordinal,
    });
    units.push({
      unitId,
      unitType: "table",
      embedInput,
      content,
      sectionPath,
      ...(sectionId ? { sectionId } : {}),
      ...(page.summary ? { pageSummary: page.summary } : {}),
      pageStart: page.page,
      pageEnd: page.page,
      tableId: table.tableId,
      blockIds: [table.id],
      ordinal,
      displayLen: ownText.length,
    });
  });

  // Row-groups of one table are reading-order siblings.
  linkSiblings(units);
  return units;
}

/**
 * Pack a table's body rows into row-groups that each stay within `maxTokens`
 * once the header is repeated. A single row wider than the budget becomes its
 * own group (never dropped). Each group is measured with the header prepended,
 * mirroring how the row-group unit is rendered.
 */
async function splitRowsToBudget(
  table: TableBlock,
  caption: string,
  _headerLabels: string[],
  maxTokens: number,
  tokenCounter: UnitTokenCounter,
): Promise<Cell[][][]> {
  const groups: Cell[][][] = [];
  let current: Cell[][] = [];

  const groupTokens = async (rows: Cell[][]): Promise<number> => {
    const rendered = `${caption}${renderTableRows(table.headerRows, rows)}`;
    const [tokens] = await tokenCounter.countBatch([rendered]);
    return tokens ?? Math.ceil(rendered.length / 4);
  };

  for (const row of table.rows) {
    const candidate = [...current, row];
    const tokens = await groupTokens(candidate);
    if (tokens <= maxTokens || current.length === 0) {
      // Fits, or this is the first row of a group (even if it alone exceeds).
      current = candidate;
      if (current.length === 1 && tokens > maxTokens) {
        // Oversize single row: emit it alone and start fresh.
        groups.push(current);
        current = [];
      }
    } else {
      groups.push(current);
      current = [row];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0 ? groups : [[]];
}

/** Build one `figure` unit from a figure block (caption/description/transcription/labels). */
function buildFigureUnit(
  figure: FigureBlock,
  revisionId: string,
  documentId: string,
  pageSummary?: string,
): IndexUnit | null {
  const text = renderFigureText(figure);
  if (text.trim() === "") return null;
  const sectionPath = figure.sectionPath ?? [];
  const sectionId = sectionIdFromPath(sectionPath);
  const unitId = computeUnitId({
    revisionId,
    documentId,
    unitType: "figure",
    pageStart: figure.page,
    pageEnd: figure.page,
    sectionPath,
    blockIds: [figure.id],
    ordinal: 0,
  });
  return {
    unitId,
    unitType: "figure",
    embedInput: text,
    content: text,
    sectionPath,
    ...(sectionId ? { sectionId } : {}),
    ...(pageSummary ? { pageSummary } : {}),
    pageStart: figure.page,
    pageEnd: figure.page,
    figureKind: figure.kind,
    figureId: figure.figureId,
    ...(figure.assetId ? { assetId: figure.assetId } : {}),
    // A figure references itself, so a text hit that resolved to this figure id
    // and this unit agree on the id.
    figureRefs: [figure.figureId],
    blockIds: [figure.id],
    ordinal: 0,
  };
}

/**
 * Link parent/prev/next across the content units of a batch.
 *
 * - `parent_unit_id`: a chunk/table/figure points at its `section` unit. The
 *   section units are built from `document.end` (a later batch), so the parent
 *   id is computed from the SAME deterministic recipe the section unit uses
 *   (unitType "section", the section path as both coordinate and block id).
 *   That keeps the link stable across batches without needing the section unit
 *   in hand.
 * - prev/next: chunks within one section on a page are reading-order siblings.
 */
function linkContentSiblings(
  units: IndexUnit[],
  revisionId: string,
  documentId: string,
): void {
  // parent = the section unit for the unit's section path.
  for (const unit of units) {
    if (unit.sectionPath.length === 0) continue;
    unit.parentUnitId = sectionUnitId(revisionId, documentId, unit.sectionPath);
  }

  // prev/next among the chunks of one section, in reading order across the
  // pages of the batch — so get_context walks from the end of page N into
  // page N+1 (a paragraph over the page break). Units are built page by page,
  // so the stable sort on (page, ordinal) keeps that order. Batch boundaries
  // (every EMIT_BATCH_PAGES pages) stay unlinked: the next batch's ids are not
  // known here.
  const chunkGroups = new Map<string, IndexUnit[]>();
  for (const unit of units) {
    if (unit.unitType !== "chunk") continue;
    const key = unit.sectionPath.join("/");
    const list = chunkGroups.get(key) ?? [];
    list.push(unit);
    chunkGroups.set(key, list);
  }
  for (const list of chunkGroups.values()) {
    list.sort((a, b) => a.pageStart - b.pageStart || a.ordinal - b.ordinal);
    linkSiblings(list);
  }
}

/**
 * The deterministic unit id of the `section` unit for a section path, computed
 * without the section unit in hand. Mirrors {@link buildSectionUnit}'s id recipe
 * so a chunk/table/figure and its later-built section agree.
 */
function sectionUnitId(
  revisionId: string,
  documentId: string,
  sectionPath: string[],
): string {
  // The section unit is anchored on its section path (as coordinate + block id)
  // and a page range that is unknown at content-build time. To keep the link
  // stable we anchor the PARENT link on section path only, using a fixed
  // sentinel page range; buildSectionUnit uses the same recipe.
  return computeUnitId({
    revisionId,
    documentId,
    unitType: "section",
    pageStart: SECTION_ID_PAGE_SENTINEL,
    pageEnd: SECTION_ID_PAGE_SENTINEL,
    sectionPath,
    blockIds: [sectionPath.join("/")],
    ordinal: 0,
  });
}

/**
 * A section unit's id is anchored on its section path, not its page range, so a
 * chunk built in an earlier page batch can compute its parent section id before
 * the section unit exists. This sentinel stands in for the page-range component.
 */
const SECTION_ID_PAGE_SENTINEL = 0;

// ─── Summary units (section / page / document) from document.end ─────────────

/**
 * Build `section` / `page` / `document` units from a `document.end` record's
 * summary hierarchy and outline. These carry the summaries the
 * doc pass produced; their embed input is the summary text.
 *
 * Parent links:
 *   - a `section` → its parent section (by outline level) or the `document`;
 *   - a `page` → the `document`.
 * prev/next: adjacent sections in outline order, adjacent pages by number.
 */
function buildSummaryUnits(
  input: BuildUnitsInput,
  doc: DocumentEndRecord,
): IndexUnit[] {
  const units: IndexUnit[] = [];

  // ── document unit ─────────────────────────────────────────────────────────
  const documentUnit = buildDocumentUnit(input, doc);
  if (documentUnit) units.push(documentUnit);

  // ── section units ───────────────────────────────────────────────────────
  const sectionSummaries = doc.summaries.filter(
    (s) => s.scope === "section" || s.scope === "chapter",
  );
  const outlineByPathTitle = indexOutline(doc.outline);
  const sectionUnits: IndexUnit[] = [];
  sectionSummaries.forEach((summary) => {
    const unit = buildSectionUnit(
      input,
      summary,
      outlineByPathTitle,
      documentUnit?.unitId,
    );
    if (unit) sectionUnits.push(unit);
  });
  linkSiblings(sectionUnits);
  units.push(...sectionUnits);

  // ── page units ────────────────────────────────────────────────────────────
  const pageSummaries = doc.summaries
    .filter((s) => s.scope === "page")
    .sort((a, b) => (a.pageStart ?? 0) - (b.pageStart ?? 0));
  const pageUnits: IndexUnit[] = [];
  pageSummaries.forEach((summary) => {
    const unit = buildPageUnit(input, summary, documentUnit?.unitId);
    if (unit) pageUnits.push(unit);
  });
  linkSiblings(pageUnits);
  units.push(...pageUnits);

  return units;
}

/** Index outline nodes by title for section-unit page-range/section-id lookup. */
function indexOutline(outline: OutlineNode[]): Map<string, OutlineNode> {
  const map = new Map<string, OutlineNode>();
  for (const node of outline) {
    map.set(node.title, node);
    map.set(node.sectionId, node);
  }
  return map;
}

function buildDocumentUnit(
  input: BuildUnitsInput,
  doc: DocumentEndRecord,
): IndexUnit | null {
  const { revisionId, documentId } = input;
  const summary = doc.summaries.find((s) => s.scope === "document")?.summary ?? "";
  // Outline levels 1–2 form the document unit's structural context.
  const outlineText = doc.outline
    .filter((n) => n.level <= 2)
    .map((n) => `${n.numbering ? `${n.numbering} ` : ""}${n.title}`.trim())
    .join("\n");
  const text = [summary, outlineText].filter((p) => p.trim() !== "").join("\n\n");
  if (text.trim() === "") return null;

  // The document spans the stream: page 1 unless the job processed a `pages`
  // window (contract 2.4), whose first page document.end repeats.
  const pageStart = doc.firstPage ?? 1;
  const pageEnd = doc.pageCount > 0 ? Math.max(doc.pageCount, pageStart) : pageStart;
  const unitId = computeUnitId({
    revisionId,
    documentId,
    unitType: "document",
    pageStart,
    pageEnd,
    sectionPath: [],
    blockIds: [documentId],
    ordinal: 0,
  });
  return {
    unitId,
    unitType: "document",
    embedInput: text,
    content: text,
    sectionPath: [],
    pageStart,
    pageEnd,
    blockIds: [documentId],
    ordinal: 0,
  };
}

function buildSectionUnit(
  input: BuildUnitsInput,
  summary: SummaryNode,
  outline: Map<string, OutlineNode>,
  documentUnitId: string | undefined,
): IndexUnit | null {
  const { revisionId, documentId } = input;
  const node = outline.get(summary.id);
  // The section path: use the outline numbering/title chain when present,
  // else the summary id.
  const sectionPath = node
    ? [node.numbering ? `${node.numbering} ${node.title}` : node.title]
    : [summary.id];
  const sectionId = sectionIdFromPath(sectionPath) ?? summary.id;
  const heading = node
    ? `${node.numbering ? `${node.numbering} ` : ""}${node.title}`.trim()
    : summary.id;
  const text = [heading, summary.summary].filter((p) => p.trim() !== "").join("\n\n");
  if (text.trim() === "") return null;

  const pageStart = summary.pageStart ?? node?.pageStart ?? 1;
  const pageEnd = summary.pageEnd ?? node?.pageEnd ?? pageStart;

  // The section unit id MUST match sectionUnitId() so a chunk's parent link
  // resolves: anchor on section path (as coordinate + block id) with the fixed
  // page sentinel, NOT the real page range.
  const unitId = computeUnitId({
    revisionId,
    documentId,
    unitType: "section",
    pageStart: SECTION_ID_PAGE_SENTINEL,
    pageEnd: SECTION_ID_PAGE_SENTINEL,
    sectionPath,
    blockIds: [sectionPath.join("/")],
    ordinal: 0,
  });
  return {
    unitId,
    unitType: "section",
    embedInput: text,
    content: text,
    sectionPath,
    sectionId,
    pageStart,
    pageEnd,
    ...(documentUnitId ? { parentUnitId: documentUnitId } : {}),
    blockIds: [sectionPath.join("/")],
    ordinal: 0,
  };
}

function buildPageUnit(
  input: BuildUnitsInput,
  summary: SummaryNode,
  documentUnitId: string | undefined,
): IndexUnit | null {
  const { revisionId, documentId } = input;
  const text = summary.summary;
  if (!text || text.trim() === "") return null;
  const pageStart = summary.pageStart ?? 1;
  const pageEnd = summary.pageEnd ?? pageStart;
  const unitId = computeUnitId({
    revisionId,
    documentId,
    unitType: "page",
    pageStart,
    pageEnd,
    sectionPath: [],
    blockIds: [`page:${pageStart}`],
    ordinal: 0,
  });
  return {
    unitId,
    unitType: "page",
    embedInput: text,
    content: text,
    sectionPath: [],
    pageStart,
    pageEnd,
    ...(documentUnitId ? { parentUnitId: documentUnitId } : {}),
    blockIds: [`page:${pageStart}`],
    ordinal: 0,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * A {@link UnitTokenCounter} that never calls out: it estimates ~4 characters
 * per token (the same heuristic the TEI token counter falls back to). Used as
 * the builder's default when no TEI-backed counter is configured, so ingest
 * still sizes chunks sensibly without a tokenizer round-trip.
 */
export const heuristicTokenCounter: UnitTokenCounter = {
  countBatch(texts: string[]): Promise<number[]> {
    return Promise.resolve(
      texts.map((t) => (t.length === 0 ? 0 : Math.ceil(t.length / 4))),
    );
  },
};
