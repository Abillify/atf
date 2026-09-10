// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash } from "node:crypto";

export type SummaryMode = "auto" | "generate" | "embedded" | "off";

export interface PageSpan {
  page: number;
  charStart: number;
  charEnd: number;
}

export interface FigureStructure {
  id: string;
  description: string;
  page?: number;
  bbox?: [number, number, number, number];
  assetId: string;
}

export interface DocumentStructureOptions {
  pageMarkers?: boolean;
  figureChunks?: boolean;
  normalizeTables?: boolean;
}

export interface NormalizedDocumentStructure {
  content: string;
  embeddedSummary?: string;
  pageSpans: PageSpan[];
  figures: FigureStructure[];
}

/** Stable, tenant-independent identifier shared by ingest, assets and search. */
export function buildDocumentAssetId(
  documentReference: string,
  figureId: string,
): string {
  return createHash("sha256")
    .update(`${documentReference.normalize("NFC")}\n${figureId.normalize("NFC")}`)
    .digest("hex");
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

/** Normalize HTML/Markdown-ish inline text without adding a DOM dependency. */
export function normalizeInlineText(value: string): string {
  return decodeEntities(
    value
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`#]+/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

interface HtmlToken {
  kind: "open" | "close" | "text";
  name?: string;
  attrs?: Record<string, string>;
  text?: string;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of raw.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (name) attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const pattern = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+|</g;
  for (const match of html.matchAll(pattern)) {
    const raw = match[0];
    if (raw.startsWith("<!--")) continue;
    if (!raw.startsWith("<")) {
      tokens.push({ kind: "text", text: raw });
      continue;
    }
    const close = /^<\s*\/\s*([\w:-]+)/.exec(raw);
    if (close) {
      tokens.push({ kind: "close", name: close[1]!.toLowerCase() });
      continue;
    }
    const open = /^<\s*([\w:-]+)([\s\S]*?)\/?\s*>$/.exec(raw);
    if (open) {
      tokens.push({ kind: "open", name: open[1]!.toLowerCase(), attrs: parseAttributes(open[2] ?? "") });
    }
  }
  return tokens;
}

/** Convert one HTML table into a rectangular Markdown table, expanding spans. */
export function htmlTableToMarkdown(html: string): string {
  const rows: Array<Array<{ text: string; rowspan: number; colspan: number }>> = [];
  let row: Array<{ text: string; rowspan: number; colspan: number }> | null = null;
  let cell: { text: string; rowspan: number; colspan: number } | null = null;
  for (const token of tokenizeHtml(html)) {
    if (token.kind === "open" && token.name === "tr") row = [];
    else if (token.kind === "open" && (token.name === "td" || token.name === "th")) {
      const rowspan = Math.max(1, Number.parseInt(token.attrs?.["rowspan"] ?? "1", 10) || 1);
      const colspan = Math.max(1, Number.parseInt(token.attrs?.["colspan"] ?? "1", 10) || 1);
      cell = { text: "", rowspan, colspan };
    } else if (token.kind === "text" && cell) cell.text += token.text ?? "";
    else if (token.kind === "open" && token.name === "br" && cell) cell.text += " ";
    else if (token.kind === "close" && (token.name === "td" || token.name === "th")) {
      if (row && cell) row.push({ ...cell, text: normalizeInlineText(cell.text) });
      cell = null;
    } else if (token.kind === "close" && token.name === "tr") {
      if (row && row.length > 0) rows.push(row);
      row = null;
    }
  }
  if (rows.length === 0) return normalizeInlineText(html);

  const matrix: string[][] = [];
  const occupied: boolean[][] = [];
  rows.forEach((sourceRow, rowIndex) => {
    matrix[rowIndex] ??= [];
    occupied[rowIndex] ??= [];
    let column = 0;
    for (const sourceCell of sourceRow) {
      while (occupied[rowIndex]![column]) column++;
      for (let y = 0; y < sourceCell.rowspan; y++) {
        matrix[rowIndex + y] ??= [];
        occupied[rowIndex + y] ??= [];
        for (let x = 0; x < sourceCell.colspan; x++) {
          matrix[rowIndex + y]![column + x] = sourceCell.text;
          occupied[rowIndex + y]![column + x] = true;
        }
      }
      column += sourceCell.colspan;
    }
  });
  const width = Math.max(...matrix.map((r) => r.length));
  const escaped = matrix.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|")));
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  return [line(escaped[0]!), line(Array.from({ length: width }, () => "---")), ...escaped.slice(1).map(line)].join("\n");
}

export function normalizeHtmlTables(content: string): string {
  return content.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (table) => htmlTableToMarkdown(table));
}

function parseFigureId(
  rawAttrs: string,
  attrs: Record<string, string>,
): string | undefined {
  const match = /(?:^|\s)(?:id|data-figure-id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s>]+))/i.exec(
    rawAttrs,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? attrs["id"] ?? attrs["data-figure-id"];
}

function parseBbox(
  rawAttrs: string,
  attrs: Record<string, string>,
): [number, number, number, number] | undefined {
  const match = /(?:^|\s)(?:bbox|data-bbox)\s*=\s*(?:\[([^\]]+)\]|"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
    rawAttrs,
  );
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? attrs["bbox"] ?? attrs["data-bbox"];
  if (!raw) return undefined;
  const values = raw.replace(/^\[|\]$/g, "").split(/[\s,;]+/).filter(Boolean).map(Number);
  return values.length === 4 && values.every(Number.isFinite)
    ? [values[0]!, values[1]!, values[2]!, values[3]!]
    : undefined;
}

function pageAt(content: string, position: number): number | undefined {
  const pattern = /^##\s+(?:Seite|Page)\s+(\d+)\s*$/gim;
  let page: number | undefined;
  for (const match of content.matchAll(pattern)) {
    if ((match.index ?? 0) > position) break;
    page = Number.parseInt(match[1]!, 10);
  }
  return page;
}

export function extractPageSpans(content: string): PageSpan[] {
  const markers = [...content.matchAll(/^##\s+(?:Seite|Page)\s+(\d+)\s*$/gim)];
  return markers.map((marker, index) => ({
    page: Number.parseInt(marker[1]!, 10),
    charStart: marker.index ?? 0,
    charEnd: markers[index + 1]?.index ?? content.length,
  }));
}

export function pagesForRange(
  spans: PageSpan[],
  charStart: number,
  charEnd: number,
): { pageStart?: number; pageEnd?: number } {
  const overlap = spans.filter((span) => span.charStart < charEnd && span.charEnd > charStart);
  if (overlap.length === 0) return {};
  return { pageStart: overlap[0]!.page, pageEnd: overlap.at(-1)!.page };
}

/** Deterministically extract embedded structure and return a cleaned indexing body. */
export function normalizeDocumentStructure(
  content: string,
  documentReference: string,
  options: DocumentStructureOptions = {},
): NormalizedDocumentStructure {
  const pageMarkers = options.pageMarkers ?? true;
  const figureChunks = options.figureChunks ?? true;
  const normalizeTables = options.normalizeTables ?? true;
  let embeddedSummary: string | undefined;
  let body = content.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/gi, (_all, inner: string) => {
    const normalized = normalizeInlineText(inner);
    if (normalized) embeddedSummary = embeddedSummary ? `${embeddedSummary}\n${normalized}` : normalized;
    return "";
  });

  const figures: FigureStructure[] = [];
  const figureIdOccurrences = new Map<string, number>();
  let ordinal = 0;
  body = body.replace(/<figure\b([^>]*)>([\s\S]*?)<\/figure\s*>/gi, (all, rawAttrs: string, inner: string, offset: number) => {
    ordinal++;
    if (!figureChunks) return "";
    const attrs = parseAttributes(rawAttrs);
    const placeholder = /!\[figure_([^\]]+)\]/i.exec(inner)?.[1];
    const rawId = parseFigureId(rawAttrs, attrs) ?? placeholder ?? String(ordinal);
    const baseId = rawId.replace(/^figure_/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-") || String(ordinal);
    const occurrence = (figureIdOccurrences.get(baseId) ?? 0) + 1;
    figureIdOccurrences.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
    const description =
      normalizeInlineText(inner.replace(/!\[figure_[^\]]+\](?:\([^)]*\))?/gi, " ")) ||
      `Figure ${id}`;
    figures.push({
      id,
      description,
      page: pageMarkers ? pageAt(body, offset) : undefined,
      bbox: parseBbox(rawAttrs, attrs),
      assetId: buildDocumentAssetId(documentReference, id),
    });
    return "";
  });
  body = body
    .replace(/<figures\b[^>]*>\s*(?:none|n\/a|keine)?\s*<\/figures\s*>/gi, "")
    .replace(/<\/?figures\b[^>]*>/gi, "")
    .replace(/!\[figure_[^\]]+\](?:\([^)]*\))?/gi, "");
  if (normalizeTables) body = normalizeHtmlTables(body);
  body = body.replace(/\n{3,}/g, "\n\n").trim();

  return {
    content: body,
    ...(embeddedSummary ? { embeddedSummary } : {}),
    pageSpans: pageMarkers ? extractPageSpans(body) : [],
    figures,
  };
}
