// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v2/render.ts
 *
 * Markdown view v2.
 *
 * In v1, Markdown was the transport. In v2 it is only a *view*: the records are
 * the truth, and `renderMarkdown` derives a human/LLM-readable rendering from
 * them for `get_pages` / `get_section` and for display. Nothing consumes the
 * output structurally, so this file is free to format for reading rather than
 * for round-tripping.
 *
 * The one load-bearing rule (from D5, the defect where text lost its figures):
 * a figure renders *inline at its reading position*, not hoisted to the top of
 * the page. Blocks are emitted in the order they appear in the page record, and
 * a figure becomes a `<figure>` element carrying its kind/page/asset, caption,
 * summary and — the point of v2 — its transcription rendered as a table or list
 * so the visual content is readable as text.
 */

import { formatBoundingBoxTuple } from "./geometry.js";
import {
  isDocumentBegin,
  isPage,
  type Block,
  type Cell,
  type ExtractRecord,
  type FigureBlock,
  type PageRecord,
  type TableBlock,
  type Transcription,
} from "./records.js";

export interface RenderMarkdownOptions {
  /** Emit the `## Seite N · <section path>` heading per page. Default: true. */
  pageHeadings?: boolean;
  /** Page-heading label. Default: "Seite". */
  pageLabel?: string;
  /** Emit figure transcriptions (tables/lists). Default: true. */
  includeTranscriptions?: boolean;
  /** Restrict rendering to these page numbers, in the given order. */
  pages?: readonly number[];
}

function cellText(cell: Cell): string {
  return typeof cell === "string" ? cell : cell.text;
}

/** Escape a cell for a Markdown table (pipes and newlines break the grid). */
function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim();
}

/** Render rows as a Markdown pipe table with the given header rows flattened. */
function renderTable(headerRows: Cell[][], rows: Cell[][]): string {
  const width = Math.max(
    0,
    ...headerRows.map((r) => r.length),
    ...rows.map((r) => r.length),
  );
  if (width === 0) return "";

  const pad = (row: Cell[]): string[] => {
    const cells = row.map((c) => escapeCell(cellText(c)));
    while (cells.length < width) cells.push("");
    return cells;
  };

  const lines: string[] = [];
  const header = headerRows.length > 0 ? headerRows[headerRows.length - 1] : undefined;
  const headerCells = header !== undefined ? pad(header) : Array.from({ length: width }, () => "");
  lines.push(`| ${headerCells.join(" | ")} |`);
  lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  // Header rows above the last are emitted as body rows so nothing is lost.
  for (const row of headerRows.slice(0, -1)) {
    lines.push(`| ${pad(row).join(" | ")} |`);
  }
  for (const row of rows) {
    lines.push(`| ${pad(row).join(" | ")} |`);
  }
  return lines.join("\n");
}

/** Render a transcription as readable Markdown per its format. */
function renderTranscription(transcription: Transcription): string {
  switch (transcription.format) {
    case "process": {
      const parts: string[] = [];
      if (transcription.mermaid.trim() !== "") {
        parts.push(`\`\`\`mermaid\n${transcription.mermaid.trim()}\n\`\`\``);
      }
      if (transcription.steps.length > 0) {
        parts.push(transcription.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
      }
      return parts.join("\n\n");
    }
    case "fields": {
      const rows: Cell[][] = [];
      for (const area of transcription.areas) {
        for (const field of area.fields) {
          rows.push([
            area.name,
            field.label,
            field.type,
            field.required === true ? "ja" : field.required === false ? "nein" : "",
            field.default ?? "",
          ]);
        }
      }
      const table = renderTable(
        [["Bereich", "Feld", "Typ", "Pflicht", "Vorbelegung"]],
        rows,
      );
      const parts = [table];
      if (transcription.actions.length > 0) {
        parts.push(`Aktionen: ${transcription.actions.join(", ")}`);
      }
      if (transcription.messages !== undefined && transcription.messages.length > 0) {
        parts.push(`Meldungen: ${transcription.messages.join(", ")}`);
      }
      return parts.filter((p) => p !== "").join("\n");
    }
    case "drawing": {
      const parts: string[] = [];
      const titleRows = Object.entries(transcription.titleBlock).map(
        ([k, v]) => [k, v] as Cell[],
      );
      if (titleRows.length > 0) {
        parts.push(renderTable([["Feld", "Wert"]], titleRows));
      }
      if (transcription.partsList !== undefined && transcription.partsList.length > 0) {
        parts.push(renderTable([], transcription.partsList));
      }
      for (const [label, list] of [
        ["Legende", transcription.legend],
        ["Bemaßungen", transcription.dimensions],
        ["Ansichten", transcription.views],
        ["Hinweise", transcription.notes],
      ] as const) {
        if (list !== undefined && list.length > 0) {
          parts.push(`${label}: ${list.join("; ")}`);
        }
      }
      return parts.join("\n\n");
    }
    case "data": {
      const parts = [renderTable([], transcription.table)];
      if (transcription.axes !== undefined && transcription.axes.length > 0) {
        parts.push(`Achsen: ${transcription.axes.join(", ")}`);
      }
      return parts.filter((p) => p !== "").join("\n");
    }
    case "markdown":
      return transcription.text.trim();
  }
}

function renderFigure(block: FigureBlock, includeTranscriptions: boolean): string {
  const attrs = [
    `id="${block.figureId}"`,
    `kind="${block.kind}"`,
    `page="${block.page}"`,
  ];
  if (block.assetId !== undefined) attrs.push(`asset="${block.assetId}"`);
  if (block.bbox !== undefined) attrs.push(`bbox="${formatBoundingBoxTuple(block.bbox)}"`);

  const lines: string[] = [`<figure ${attrs.join(" ")}>`];
  if (block.caption !== undefined && block.caption.trim() !== "") {
    lines.push(`**${block.caption.trim()}**`);
  }
  if (block.description.trim() !== "") {
    lines.push(`Zusammenfassung: ${block.description.trim()}`);
  }
  if (includeTranscriptions && block.transcription !== undefined) {
    const transcription = renderTranscription(block.transcription);
    if (transcription.trim() !== "") lines.push(transcription);
  }
  lines.push("</figure>");
  return lines.join("\n");
}

function renderTableBlock(block: TableBlock): string {
  const parts: string[] = [];
  if (block.caption !== undefined && block.caption.trim() !== "") {
    parts.push(`**${block.caption.trim()}**`);
  }
  const table = renderTable(block.headerRows, block.rows);
  if (table !== "") parts.push(table);
  return parts.join("\n\n");
}

function renderBlock(block: Block, options: Required<RenderMarkdownOptions>): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(Math.min(6, block.level))} ${
        block.numbering !== undefined ? `${block.numbering} ` : ""
      }${block.text}`;
    case "paragraph":
      return block.text;
    case "footnote":
      return `> ${block.text}`;
    case "code":
      return `\`\`\`\n${block.text}\n\`\`\``;
    case "list":
      return block.items
        .map((item, i) => (block.ordered === true ? `${i + 1}. ${item}` : `- ${item}`))
        .join("\n");
    case "table":
      return renderTableBlock(block);
    case "figure":
      return renderFigure(block, options.includeTranscriptions);
  }
}

function pageHeading(page: PageRecord, options: Required<RenderMarkdownOptions>): string {
  const path = page.blocks.find((b) => b.sectionPath !== undefined)?.sectionPath;
  const suffix = path !== undefined && path.length > 0 ? ` · ${path.join(" › ")}` : "";
  return `## ${options.pageLabel} ${page.page}${suffix}`;
}

/** Render a single page record to Markdown v2. */
export function renderPage(page: PageRecord, options: RenderMarkdownOptions = {}): string {
  const resolved: Required<RenderMarkdownOptions> = {
    pageHeadings: options.pageHeadings ?? true,
    pageLabel: options.pageLabel ?? "Seite",
    includeTranscriptions: options.includeTranscriptions ?? true,
    pages: options.pages ?? [],
  };
  const blocks: string[] = [];
  if (resolved.pageHeadings) blocks.push(pageHeading(page, resolved));
  for (const block of page.blocks) {
    const rendered = renderBlock(block, resolved);
    if (rendered.trim() !== "") blocks.push(rendered);
  }
  return blocks.join("\n\n");
}

/**
 * Render a v2 record stream to Markdown v2.
 *
 * Only `page` records produce output; `document.begin` and `document.end`
 * carry metadata that has no place in the reading view. Pages are rendered in
 * stream order, or in the order given by `options.pages` when set.
 */
export function renderMarkdown(
  records: readonly ExtractRecord[],
  options: RenderMarkdownOptions = {},
): string {
  const pages = records.filter(isPage);
  const wanted = options.pages;

  let ordered: PageRecord[];
  if (wanted !== undefined && wanted.length > 0) {
    const byNumber = new Map(pages.map((p) => [p.page, p]));
    ordered = wanted
      .map((n) => byNumber.get(n))
      .filter((p): p is PageRecord => p !== undefined);
  } else {
    ordered = pages;
  }

  const title = records.find(isDocumentBegin)?.title;
  const rendered = ordered.map((page) => renderPage(page, options));
  if (title !== undefined && title.trim() !== "" && options.pageHeadings !== false) {
    return [`# ${title.trim()}`, ...rendered].join("\n\n");
  }
  return rendered.join("\n\n");
}
