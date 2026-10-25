// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/markdown-blocks.ts
 *
 * Deterministic Pass-1 Markdown → typed v2 blocks (block model, S3/S7).
 *
 * The Pass-1 vision model returns the page body as Markdown with embedded HTML
 * tables and `![figure_<id>]` placeholders. Emitting that verbatim as ONE
 * paragraph block starves every downstream consumer: the document pass cannot
 * build an outline without heading blocks, cannot merge cross-page tables
 * without table blocks (cells included), and Search cannot address a figure at
 * its position in the reading order. This module turns the body into the
 * contract's typed blocks:
 *
 *   - ATX (`#`…`######`) and setext (`===`/`---`) headings → `heading` with the
 *     level, an optional `numbering` (`^\d+(\.\d+)*`) and the remaining text;
 *   - paragraphs → `paragraph`; footnote definitions (`[^1]: …`) → `footnote`;
 *   - bullet / ordered lists → `list{items, ordered}` (nested items flattened);
 *   - fenced code → `code`;
 *   - `<table>` → `table{headerRows, rows}` with cells keeping `rowspan` /
 *     `colspan`, `continues` from `data-continues` and a `continuationOf` marker
 *     from `data-continuation` (the document pass replaces the marker with the
 *     predecessor's real `tableId`, or drops it when the tables do not merge);
 *   - GFM pipe tables → `table` with the first row as the header;
 *   - `![figure_<id>]` → a figure *position*: the caller places the figure
 *     block exactly there in the reading order.
 *
 * No dependency beyond the contract: a small tolerant HTML tokenizer handles the
 * table markup (model output is nearly always well-formed, but an unclosed cell
 * or a missing `<tr>` must not lose content). Pure and deterministic: the same
 * Markdown always yields the same blocks with the same ids (`p{page}-b{n}`,
 * `n` from 1 in reading order), which is what keeps a resume/reparse stable.
 */

import {
  blockSchema,
  type Block,
  type BlockSource,
  type Cell,
  type TableBlock,
} from "@atf/extract-contract/v2";

/**
 * Version of the Markdown → block mapping. Folded into the pipeline stand and
 * the `emitted` stage's input hash, so a change to the mapping is a visible
 * pipeline change rather than a silent difference between pages of one job.
 */
export const MARKDOWN_BLOCKS_VERSION = "1.0.0";

/**
 * The marker a continuation table carries in `continuationOf` until the
 * document pass resolves it to the predecessor's `tableId`.
 */
export const CONTINUATION_MARKER = "previous";

/** One item of the page's reading order: a typed block, or a figure position. */
export type MarkdownItem =
  | { kind: "block"; block: Block }
  | { kind: "figure"; figureId: string };

export interface ParsedMarkdownBlocks {
  /** Blocks and figure positions in reading order. */
  items: MarkdownItem[];
  /** Deviations worth surfacing (e.g. content that failed schema validation). */
  warnings: string[];
}

export interface MarkdownBlocksOptions {
  /** 1-based page number; drives block ids and the `page` field. */
  page: number;
  /** The origin recorded on every produced block. */
  source: BlockSource;
}

/** A block before the id/page/source are stamped on. */
type DraftBlock =
  | { type: "heading"; level: number; numbering?: string; text: string }
  | { type: "paragraph" | "footnote" | "code"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | {
      type: "table";
      headerRows: Cell[][];
      rows: Cell[][];
      continues: boolean;
      continuation: boolean;
      caption?: string;
    };

type Segment = { kind: "draft"; draft: DraftBlock } | { kind: "figure"; figureId: string };

/** `![figure_<id>]` with an optional `(url)` tail, as rewritten by the parser. */
const FIGURE_PLACEHOLDER = /!\[figure_([^\]]+)\](?:\([^)]*\))?/gi;

/** A numbering prefix at the start of a heading: `4`, `4.2`, `4.2.1.` */
const HEADING_NUMBERING = /^(\d{1,3}(?:\.\d{1,3})*)\.?(?:\s+|$)/;

/**
 * Parse a page's Pass-1 Markdown body into typed blocks and figure positions.
 * Never throws; content that cannot be represented as a valid typed block
 * degrades to a paragraph (and, failing that, is reported in `warnings`).
 */
export function parseMarkdownBlocks(markdown: string, options: MarkdownBlocksOptions): ParsedMarkdownBlocks {
  const { page, source } = options;
  const warnings: string[] = [];
  const segments = segment(markdown.replace(/\r\n?/g, "\n"));

  const items: MarkdownItem[] = [];
  let ordinal = 0;
  let tableOrdinal = 0;
  for (const seg of segments) {
    if (seg.kind === "figure") {
      items.push({ kind: "figure", figureId: seg.figureId });
      continue;
    }
    ordinal += 1;
    const id = `p${page}-b${ordinal}`;
    if (seg.draft.type === "table") tableOrdinal += 1;
    const block = stamp(seg.draft, { id, page, source, tableOrdinal });
    const valid = blockSchema.safeParse(block);
    if (valid.success) {
      items.push({ kind: "block", block: valid.data });
      continue;
    }
    // Degrade to a paragraph carrying the textual content, so nothing is lost.
    const fallback = blockSchema.safeParse({ id, page, source, type: "paragraph", text: draftText(seg.draft) });
    if (fallback.success && draftText(seg.draft).trim() !== "") {
      items.push({ kind: "block", block: fallback.data });
      warnings.push(`Block ${id} (${seg.draft.type}) was not contract-valid and was emitted as a paragraph.`);
    } else {
      ordinal -= 1;
      warnings.push(`A ${seg.draft.type} block on page ${page} could not be represented and was dropped.`);
    }
  }
  return { items, warnings };
}

/** Convenience: only the typed blocks, figure positions dropped. */
export function markdownToBlocks(markdown: string, options: MarkdownBlocksOptions): Block[] {
  return parseMarkdownBlocks(markdown, options).items.flatMap((item) =>
    item.kind === "block" ? [item.block] : [],
  );
}

// ── segmentation ──────────────────────────────────────────────────────────

/**
 * Split the body into drafts and figure positions, in reading order. Fenced
 * code is cut out first (its content is never interpreted), then HTML tables,
 * then figure placeholders; what remains is parsed line by line.
 */
function segment(markdown: string): Segment[] {
  const out: Segment[] = [];
  for (const chunk of splitFences(markdown)) {
    if (chunk.kind === "code") {
      if (chunk.text.trim() !== "") out.push({ kind: "draft", draft: { type: "code", text: chunk.text } });
      continue;
    }
    for (const part of splitHtmlTables(chunk.text)) {
      if (part.kind === "table") {
        const table = parseHtmlTable(part.html);
        if (table !== null) out.push({ kind: "draft", draft: table });
        else {
          const text = htmlToText(part.html);
          if (text !== "") out.push({ kind: "draft", draft: { type: "paragraph", text } });
        }
        continue;
      }
      for (const piece of splitFigures(part.text)) {
        if (piece.kind === "figure") out.push(piece);
        else for (const draft of parseLines(piece.text)) out.push({ kind: "draft", draft });
      }
    }
  }
  return out;
}

/** Fenced code blocks (``` or ~~~, at most 3 spaces indent) vs. the rest. */
function splitFences(text: string): Array<{ kind: "text" | "code"; text: string }> {
  const lines = text.split("\n");
  const out: Array<{ kind: "text" | "code"; text: string }> = [];
  let buffer: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = (kind: "text" | "code"): void => {
    if (buffer.length > 0 || kind === "code") out.push({ kind, text: buffer.join("\n") });
    buffer = [];
  };
  for (const line of lines) {
    if (fence === null) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open?.[1] !== undefined) {
        flush("text");
        fence = { char: open[1].charAt(0), length: open[1].length };
        continue;
      }
      buffer.push(line);
    } else {
      const close = new RegExp(`^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.length},}\\s*$`).exec(line);
      if (close !== null) {
        flush("code");
        fence = null;
        continue;
      }
      buffer.push(line);
    }
  }
  // An unterminated fence (truncated response) still yields its content as code.
  flush(fence !== null ? "code" : "text");
  return out;
}

/** Top-level `<table>…</table>` spans (nesting-aware; unclosed runs to the end). */
function splitHtmlTables(text: string): Array<{ kind: "text"; text: string } | { kind: "table"; html: string }> {
  const out: Array<{ kind: "text"; text: string } | { kind: "table"; html: string }> = [];
  const tag = /<(\/?)table\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  let cursor = 0;
  for (const match of text.matchAll(tag)) {
    const index = match.index ?? 0;
    if (match[1] !== "/") {
      if (depth === 0) {
        if (index > cursor) out.push({ kind: "text", text: text.slice(cursor, index) });
        start = index;
      }
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) {
        const end = index + match[0].length;
        out.push({ kind: "table", html: text.slice(start, end) });
        cursor = end;
        start = -1;
      }
    }
  }
  if (depth > 0 && start >= 0) {
    out.push({ kind: "table", html: text.slice(start) });
  } else if (cursor < text.length) {
    out.push({ kind: "text", text: text.slice(cursor) });
  }
  return out;
}

/** Split text around figure placeholders, keeping their positions. */
function splitFigures(text: string): Array<{ kind: "text"; text: string } | { kind: "figure"; figureId: string }> {
  const out: Array<{ kind: "text"; text: string } | { kind: "figure"; figureId: string }> = [];
  let cursor = 0;
  for (const match of text.matchAll(FIGURE_PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > cursor) out.push({ kind: "text", text: text.slice(cursor, index) });
    const id = (match[1] ?? "").trim();
    if (id !== "") out.push({ kind: "figure", figureId: id });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}

// ── line-level Markdown ───────────────────────────────────────────────────

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2 = /^ {0,3}-+[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+•]|\d{1,3}[.)])[ \t]+(.*)$/;
const FOOTNOTE_DEF = /^ {0,3}\[\^[^\]]+\]:[ \t]*(.*)$/;
const BLOCKQUOTE = /^ {0,3}>[ \t]?(.*)$/;
const PIPE_DELIMITER = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

/** Parse Markdown lines (no fences, tables or placeholders left) into drafts. */
function parseLines(text: string): DraftBlock[] {
  const lines = text.split("\n");
  const drafts: DraftBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let footnote: string[] | null = null;

  const flushParagraph = (): void => {
    const joined = paragraph.join("\n").trim();
    if (joined !== "") drafts.push({ type: "paragraph", text: joined });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list !== null) {
      const items = list.items.map((i) => i.trim()).filter((i) => i !== "");
      if (items.length > 0) drafts.push({ type: "list", ordered: list.ordered, items });
    }
    list = null;
  };
  const flushFootnote = (): void => {
    if (footnote !== null) {
      const joined = footnote.join("\n").trim();
      if (joined !== "") drafts.push({ type: "footnote", text: joined });
    }
    footnote = null;
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushFootnote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      // A blank line ends a paragraph/footnote; a list survives it only when
      // the next non-blank line continues the same list.
      flushParagraph();
      flushFootnote();
      if (list !== null) {
        const next = nextNonBlank(lines, i + 1);
        const nextItem = next !== null ? LIST_ITEM.exec(next) : null;
        const indented = next !== null && /^[ \t]{2,}\S/.test(next);
        const current: { ordered: boolean } = list;
        const sameKind = nextItem !== null && isOrderedMarker(nextItem[2] ?? "") === current.ordered;
        if (!(sameKind || indented)) flushList();
      }
      continue;
    }

    // Setext headings: an underline below a single pending paragraph line.
    if (paragraph.length === 1 && list === null && (SETEXT_H1.test(line) || SETEXT_H2.test(line))) {
      const title = (paragraph[0] ?? "").trim();
      paragraph = [];
      drafts.push(headingDraft(SETEXT_H1.test(line) ? 1 : 2, title));
      continue;
    }

    const atx = ATX_HEADING.exec(line);
    if (atx !== null) {
      flushAll();
      const content = (atx[2] ?? "").trim();
      if (content !== "") drafts.push(headingDraft(atx[1]?.length ?? 1, content));
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      flushAll();
      continue;
    }

    // GFM pipe table: a header line followed by a delimiter line.
    const nextLine = lines[i + 1];
    if (line.includes("|") && nextLine !== undefined && PIPE_DELIMITER.test(nextLine) && nextLine.includes("-")) {
      flushAll();
      const header = splitPipeRow(line);
      const rows: Cell[][] = [];
      let j = i + 2;
      while (j < lines.length && (lines[j] ?? "").includes("|") && (lines[j] ?? "").trim() !== "") {
        rows.push(splitPipeRow(lines[j] ?? ""));
        j++;
      }
      drafts.push({ type: "table", headerRows: [header], rows, continues: false, continuation: false });
      i = j - 1;
      continue;
    }

    const footnoteDef = FOOTNOTE_DEF.exec(line);
    if (footnoteDef !== null) {
      flushAll();
      footnote = [line.trim()];
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flushParagraph();
      flushFootnote();
      const ordered = isOrderedMarker(item[2] ?? "");
      const indent = (item[1] ?? "").replace(/\t/g, "    ").length;
      // A top-level marker of the other kind starts a new list; a nested item
      // (indented) of either kind is flattened into the current list.
      if (list !== null && indent < 2 && (list as { ordered: boolean }).ordered !== ordered) flushList();
      if (list === null) list = { ordered, items: [] };
      (list as { items: string[] }).items.push(item[3] ?? "");
      continue;
    }

    if (list !== null) {
      // Continuation (indented or lazy) of the last item.
      const current: { items: string[] } = list;
      const last = current.items.length - 1;
      current.items[last] = `${current.items[last] ?? ""} ${line.trim()}`;
      continue;
    }

    if (footnote !== null) {
      (footnote as string[]).push(line.trim());
      continue;
    }

    const quote = BLOCKQUOTE.exec(line);
    paragraph.push(quote !== null ? (quote[1] ?? "") : line);
  }
  flushAll();
  return drafts;
}

function nextNonBlank(lines: readonly string[], from: number): string | null {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() !== "") return line;
  }
  return null;
}

function isOrderedMarker(marker: string): boolean {
  return /^\d/.test(marker);
}

/** A heading draft with the numbering split off the text. */
function headingDraft(level: number, content: string): DraftBlock {
  const text = stripClosingEmphasis(content);
  const match = HEADING_NUMBERING.exec(text);
  if (match?.[1] !== undefined) {
    const rest = text.slice(match[0].length).trim();
    if (rest !== "") return { type: "heading", level: clampLevel(level), numbering: match[1], text: rest };
  }
  return { type: "heading", level: clampLevel(level), text };
}

/** `**Title**` → `Title`; a heading wrapped entirely in emphasis. */
function stripClosingEmphasis(text: string): string {
  const match = /^(\*\*|__)(.+)\1$/.exec(text.trim());
  return (match?.[2] ?? text).trim();
}

function clampLevel(level: number): number {
  return Math.min(9, Math.max(1, Math.trunc(level)));
}

/** Split a GFM pipe-table row into cells (`\|` is a literal pipe). */
function splitPipeRow(line: string): Cell[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i);
    if (ch === "\\" && body.charAt(i + 1) === "|") {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

// ── HTML tables ───────────────────────────────────────────────────────────

interface HtmlToken {
  kind: "open" | "close" | "text";
  name?: string;
  attrs?: Record<string, string | true>;
  text?: string;
}

/** A tolerant HTML tokenizer: tags (with attributes) and decoded text runs. */
function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const pattern = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</g;
  for (const match of html.matchAll(pattern)) {
    const raw = match[0];
    if (raw.startsWith("<!--")) continue;
    const tag = /^<(\/)?\s*([a-zA-Z][\w-]*)([\s\S]*?)\/?\s*>$/.exec(raw);
    if (tag !== null && raw.length > 1) {
      const name = (tag[2] ?? "").toLowerCase();
      if (tag[1] === "/") tokens.push({ kind: "close", name });
      else tokens.push({ kind: "open", name, attrs: parseAttributes(tag[3] ?? "") });
      continue;
    }
    tokens.push({ kind: "text", text: decodeEntities(raw) });
  }
  return tokens;
}

function parseAttributes(raw: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  const pattern = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of raw.matchAll(pattern)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name === "") continue;
    const value = match[2] ?? match[3] ?? match[4];
    attrs[name] = value === undefined ? true : decodeEntities(value);
  }
  return attrs;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  euro: "€",
  deg: "°",
  times: "×",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return NAMED_ENTITIES[entity] ?? all;
  });
}

/** True when an attribute is set to a truthy value (a bare attribute counts). */
function attrTrue(attrs: Record<string, string | true> | undefined, names: readonly string[]): boolean {
  if (attrs === undefined) return false;
  for (const name of names) {
    const value = attrs[name];
    if (value === undefined) continue;
    if (value === true) return true;
    const v = value.trim().toLowerCase();
    if (v === "" || v === "false" || v === "0" || v === "no") continue;
    return true;
  }
  return false;
}

function spanOf(attrs: Record<string, string | true> | undefined, name: string): number {
  const value = attrs?.[name];
  if (typeof value !== "string") return 1;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 1000) : 1;
}

/** Block-level tags inside a cell that separate words. */
const CELL_BREAK_TAGS = new Set(["br", "p", "div", "li", "ul", "ol", "hr"]);

interface RawCell {
  text: string;
  rowspan: number;
  colspan: number;
  th: boolean;
}

/**
 * Parse one `<table>` into a table draft. Rows inside `<thead>` are header
 * rows; without a `<thead>`, the leading rows whose cells are all `<th>` are.
 * Cells keep their `rowspan`/`colspan` (the contract's object cell form); a
 * plain cell is a bare string. A nested table's text is folded into the
 * enclosing cell. Returns null when the markup has no cells at all.
 */
function parseHtmlTable(html: string): DraftBlock | null {
  const tokens = tokenizeHtml(html);
  let tableAttrs: Record<string, string | true> | undefined;
  const rows: Array<{ cells: RawCell[]; head: boolean }> = [];
  let row: { cells: RawCell[]; head: boolean } | null = null;
  let cell: RawCell | null = null;
  let section: string | null = null;
  let depth = 0;
  let captionParts: string[] | null = null;
  const caption: string[] = [];

  const closeCell = (): void => {
    if (cell !== null && row !== null) {
      row.cells.push({ ...cell, text: normalizeInline(cell.text) });
    }
    cell = null;
  };
  const closeRow = (): void => {
    closeCell();
    if (row !== null && row.cells.length > 0) rows.push(row);
    row = null;
  };

  for (const token of tokens) {
    if (token.kind === "open" && token.name === "table") {
      depth += 1;
      if (depth === 1) tableAttrs = token.attrs;
      else if (cell !== null) (cell as RawCell).text += " ";
      continue;
    }
    if (token.kind === "close" && token.name === "table") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 1) {
      // Inside a nested table: keep its words in the enclosing cell.
      if (cell !== null) {
        const current: RawCell = cell;
        if (token.kind === "text") current.text += token.text ?? "";
        else current.text += " ";
      }
      continue;
    }
    if (token.kind === "open") {
      switch (token.name) {
        case "thead":
        case "tbody":
        case "tfoot":
          closeRow();
          section = token.name;
          break;
        case "tr":
          closeRow();
          row = { cells: [], head: section === "thead" };
          break;
        case "td":
        case "th":
          closeCell();
          if (row === null) row = { cells: [], head: section === "thead" };
          cell = {
            text: "",
            rowspan: spanOf(token.attrs, "rowspan"),
            colspan: spanOf(token.attrs, "colspan"),
            th: token.name === "th",
          };
          break;
        case "caption":
          captionParts = [];
          break;
        default:
          if (cell !== null && CELL_BREAK_TAGS.has(token.name ?? "")) (cell as RawCell).text += " ";
      }
      continue;
    }
    if (token.kind === "close") {
      switch (token.name) {
        case "td":
        case "th":
          closeCell();
          break;
        case "tr":
          closeRow();
          break;
        case "thead":
        case "tbody":
        case "tfoot":
          closeRow();
          section = null;
          break;
        case "caption":
          if (captionParts !== null) caption.push(normalizeInline(captionParts.join("")));
          captionParts = null;
          break;
        default:
          if (cell !== null && CELL_BREAK_TAGS.has(token.name ?? "")) (cell as RawCell).text += " ";
      }
      continue;
    }
    // text
    if (captionParts !== null) captionParts.push(token.text ?? "");
    else if (cell !== null) (cell as RawCell).text += token.text ?? "";
  }
  closeRow();
  if (rows.length === 0) return null;

  // Header rows: <thead> rows; else the leading all-<th> rows.
  let headerCount = 0;
  if (rows.some((r) => r.head)) {
    while (headerCount < rows.length && rows[headerCount]?.head === true) headerCount++;
  } else {
    while (headerCount < rows.length - 1 && rows[headerCount]?.cells.every((c) => c.th) === true) headerCount++;
  }
  const toCells = (r: { cells: RawCell[] }, inHeader: boolean): Cell[] =>
    r.cells.map((c) => {
      const needsObject = c.rowspan > 1 || c.colspan > 1 || (!inHeader && c.th);
      if (!needsObject) return c.text;
      return {
        text: c.text,
        ...(c.colspan > 1 ? { colspan: c.colspan } : {}),
        ...(c.rowspan > 1 ? { rowspan: c.rowspan } : {}),
        ...(!inHeader && c.th ? { header: true } : {}),
      };
    });
  const headerRows = rows.slice(0, headerCount).map((r) => toCells(r, true));
  const bodyRows = rows.slice(headerCount).map((r) => toCells(r, false));
  const captionText = caption.filter((c) => c !== "").join(" ");
  return {
    type: "table",
    headerRows,
    rows: bodyRows,
    continues: attrTrue(tableAttrs, ["data-continues", "continues"]),
    continuation: attrTrue(tableAttrs, ["data-continuation", "data-continuation-of", "continuationof"]),
    ...(captionText !== "" ? { caption: captionText } : {}),
  };
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Strip tags from an HTML fragment, keeping its words. */
function htmlToText(html: string): string {
  return normalizeInline(
    tokenizeHtml(html)
      .map((t) => (t.kind === "text" ? (t.text ?? "") : " "))
      .join(""),
  );
}

// ── stamping ──────────────────────────────────────────────────────────────

function stamp(
  draft: DraftBlock,
  ctx: { id: string; page: number; source: BlockSource; tableOrdinal: number },
): Block {
  const base = { id: ctx.id, page: ctx.page, source: ctx.source };
  switch (draft.type) {
    case "heading":
      return {
        ...base,
        type: "heading",
        level: draft.level,
        ...(draft.numbering !== undefined ? { numbering: draft.numbering } : {}),
        text: draft.text,
      };
    case "list":
      return { ...base, type: "list", ...(draft.ordered ? { ordered: true } : {}), items: draft.items };
    case "table": {
      const table: TableBlock = {
        ...base,
        type: "table",
        // Provisional, page-scoped id; the document pass assigns the logical
        // (possibly cross-page merged) table id.
        tableId: `p${ctx.page}-t${ctx.tableOrdinal}`,
        headerRows: draft.headerRows,
        rows: draft.rows,
        ...(draft.continues ? { continues: true } : {}),
        ...(draft.continuation ? { continuationOf: CONTINUATION_MARKER } : {}),
        ...(draft.caption !== undefined ? { caption: draft.caption } : {}),
      };
      return table;
    }
    default:
      return { ...base, type: draft.type, text: draft.text };
  }
}

function draftText(draft: DraftBlock): string {
  switch (draft.type) {
    case "list":
      return draft.items.join("\n");
    case "table":
      return [...draft.headerRows, ...draft.rows]
        .map((r) => r.map((c) => (typeof c === "string" ? c : c.text)).join(" | "))
        .join("\n");
    default:
      return draft.text;
  }
}

/** The display text of a heading block: `4.2 Anmeldung` when numbered. */
export function headingDisplayText(block: { numbering?: string | undefined; text: string }): string {
  return block.numbering !== undefined ? `${block.numbering} ${block.text}`.trim() : block.text;
}

/** The first header row of a table as `a | b | c`, or undefined without one. */
export function tableHeaderText(table: Pick<TableBlock, "headerRows">): string | undefined {
  const first = table.headerRows[0];
  if (first === undefined || first.length === 0) return undefined;
  const cells = first.map((c) => (typeof c === "string" ? c : c.text).trim());
  if (cells.every((c) => c === "")) return undefined;
  return cells.join(" | ");
}
