// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * parse.ts
 *
 * Canonical Markdown → structured document.
 *
 * The producer normally hands consumers the structured form directly, so this
 * parser exists for the cases where only the Markdown survived:
 *
 *  - re-ingesting a document already stored in Search, after a chunking or
 *    embedding change, without paying for extraction again;
 *  - reading documents produced by the pipelines that predate this contract,
 *    which is why the attribute parsers tolerate unquoted and comma-separated
 *    forms;
 *  - round-trip tests, which are the only mechanical proof that the serializer
 *    and the grammar agree.
 *
 * The parser is deliberately lossy in one direction and lossless in the other:
 * `parseDocument(serializeDocument(d))` reproduces every field that lives in
 * the Markdown, and reports everything it could not place in `warnings` instead
 * of throwing. A document that fails to parse cleanly is still worth indexing;
 * refusing it would trade a partial result for none.
 */

import {
  FIGURES_BLOCK_PATTERN,
  FIGURE_PATTERN,
  FIGURE_PLACEHOLDER_PATTERN,
  PAGE_MARKER_PATTERN,
  SUMMARY_PATTERN,
  globalize,
  normalizeBoundingBox,
  parseBoundingBoxAttribute,
  parseFigureIdAttribute,
  parsePageAttribute,
  type BoundingBox,
  type PageLabel,
} from "./markers.js";
import { buildDocumentAssetId } from "../asset-id.js";

/** A figure recovered from Markdown. */
export interface ParsedFigure {
  id: string;
  page: number;
  description: string;
  /** Absent when the source document carried no parsable bbox. */
  bbox: BoundingBox | undefined;
  assetId: string;
}

/** A page recovered from Markdown. */
export interface ParsedPage {
  page: number;
  markdown: string;
  summary: string | undefined;
  figures: ParsedFigure[];
  /** Figure ids referenced by `![figure_…]` placeholders in the body. */
  placeholders: string[];
}

/** A document recovered from Markdown. */
export interface ParsedDocument {
  reference: string;
  /** Label the source document used, inferred from its first page marker. */
  pageLabel: PageLabel;
  pages: ParsedPage[];
  figures: ParsedFigure[];
  /**
   * Content before the first page marker. Always empty for a document produced
   * by this contract; non-empty means the input was truncated or hand-edited.
   */
  preamble: string;
  warnings: string[];
}

function tidy(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Drop the `---` page separator left at the tail of a sliced page block. */
function stripTrailingSeparator(block: string): string {
  return block.replace(/(?:\r?\n)\s*-{3,}[ \t]*(?:\r?\n)?\s*$/, "");
}

interface PageSlice {
  page: number;
  label: PageLabel;
  body: string;
}

/** Split raw Markdown into page slices at the page markers. */
function slicePages(markdown: string): {
  preamble: string;
  slices: PageSlice[];
  warnings: string[];
} {
  const pattern = globalize(PAGE_MARKER_PATTERN);
  const warnings: string[] = [];
  const matches: Array<{ index: number; length: number; page: number; label: PageLabel }> = [];

  for (const match of markdown.matchAll(pattern)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const pageRaw = match[1];
    if (pageRaw === undefined) continue;
    const label: PageLabel = /page/i.test(raw) ? "Page" : "Seite";
    matches.push({ index, length: raw.length, page: Number.parseInt(pageRaw, 10), label });
  }

  if (matches.length === 0) {
    return { preamble: tidy(markdown), slices: [], warnings };
  }

  const first = matches[0];
  const preamble = first === undefined ? "" : tidy(markdown.slice(0, first.index));
  if (preamble !== "") {
    warnings.push("Content before the first page marker was discarded from page assignment.");
  }

  const slices: PageSlice[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (current === undefined) continue;
    const next = matches[i + 1];
    const start = current.index + current.length;
    const end = next?.index ?? markdown.length;
    slices.push({
      page: current.page,
      label: current.label,
      body: stripTrailingSeparator(markdown.slice(start, end)),
    });
  }

  return { preamble, slices, warnings };
}

/** Pull every `<summary>` out of a block, returning the remainder. */
function extractSummary(block: string): { summary: string | undefined; rest: string } {
  const parts: string[] = [];
  const rest = block.replace(globalize(SUMMARY_PATTERN), (_all, inner: string) => {
    const text = inner.replace(/\s+/g, " ").trim();
    if (text !== "") parts.push(text);
    return "";
  });
  return { summary: parts.length > 0 ? parts.join("\n") : undefined, rest };
}

/** Pull every `<figure>` out of a block, returning the remainder. */
function extractFigures(
  block: string,
  page: number,
  reference: string,
  warnings: string[],
): { figures: ParsedFigure[]; rest: string } {
  const figures: ParsedFigure[] = [];
  const seen = new Set<string>();
  let ordinal = 0;

  const collect = (rawAttrs: string, inner: string): void => {
    ordinal++;
    const attrPage = parsePageAttribute(rawAttrs) ?? page;
    const rawId = parseFigureIdAttribute(rawAttrs);
    // Legacy documents numbered figures per page starting at 0, so a bare id is
    // not unique across the document. Re-derive a document-unique id from the
    // page instead of trusting it, and keep the legacy id only when it already
    // carries the page.
    const normalizedId = (rawId ?? "")
      .replace(/^figure_/i, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-");
    const id =
      normalizedId !== "" && /^p\d+-f\d+$/.test(normalizedId)
        ? normalizedId
        : `p${attrPage}-f${ordinal}`;
    if (seen.has(id)) {
      warnings.push(`Duplicate figure id "${id}" on page ${attrPage} was skipped.`);
      return;
    }
    seen.add(id);
    const rawBbox = parseBoundingBoxAttribute(rawAttrs);
    if (rawBbox === undefined) {
      warnings.push(`Figure "${id}" on page ${attrPage} has no parsable bbox.`);
    }
    const description = inner
      .replace(globalize(FIGURE_PLACEHOLDER_PATTERN), " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    figures.push({
      id,
      page: attrPage,
      description: description === "" ? `Figure ${id}` : description,
      bbox: rawBbox === undefined ? undefined : normalizeBoundingBox(rawBbox),
      assetId: buildDocumentAssetId(reference, id),
    });
  };

  // Figures live inside a <figures> wrapper, but a model occasionally emits a
  // bare <figure>. Handle the wrapper first so its removal cannot swallow a
  // stray entry, then sweep the remainder.
  let rest = block.replace(globalize(FIGURES_BLOCK_PATTERN), (_all, inner: string) => {
    inner.replace(globalize(FIGURE_PATTERN), (_tag, rawAttrs: string, text: string) => {
      collect(rawAttrs, text);
      return "";
    });
    return "";
  });

  rest = rest.replace(globalize(FIGURE_PATTERN), (_tag, rawAttrs: string, text: string) => {
    collect(rawAttrs, text);
    return "";
  });

  // Remove residual wrapper tags and the "None" placeholder the legacy prompt
  // produced for figure-free pages.
  rest = rest
    .replace(/<figures\b[^>]*>\s*(?:none|n\/a|keine)?\s*<\/figures\s*>/gi, "")
    .replace(/<\/?figures\b[^>]*>/gi, "");

  return { figures, rest };
}

/** Figure ids referenced by `![figure_…]` placeholders. */
function extractPlaceholders(block: string): string[] {
  const ids: string[] = [];
  for (const match of block.matchAll(globalize(FIGURE_PLACEHOLDER_PATTERN))) {
    const raw = match[1];
    if (raw !== undefined) ids.push(raw.trim());
  }
  return ids;
}

/**
 * Parse a single page block that already had its page marker removed.
 *
 * Exported for producers that stream page by page and want to validate each
 * page as it is produced rather than at the end.
 */
export function parsePageBlock(
  block: string,
  page: number,
  reference: string,
): ParsedPage & { warnings: string[] } {
  const warnings: string[] = [];
  const { summary, rest: withoutSummary } = extractSummary(block);
  const { figures, rest } = extractFigures(withoutSummary, page, reference, warnings);
  return {
    page,
    markdown: tidy(rest),
    summary,
    figures,
    placeholders: extractPlaceholders(block),
    warnings,
  };
}

/**
 * Parse a canonical Markdown document.
 *
 * `reference` is required because asset ids are derived from it; the same
 * Markdown parsed under a different reference legitimately yields different
 * asset ids.
 */
export function parseDocument(markdown: string, reference: string): ParsedDocument {
  const { preamble, slices, warnings } = slicePages(markdown);
  const pages: ParsedPage[] = [];
  const seenPages = new Set<number>();

  for (const slice of slices) {
    const parsed = parsePageBlock(slice.body, slice.page, reference);
    warnings.push(...parsed.warnings);
    if (seenPages.has(slice.page)) {
      warnings.push(`Page ${slice.page} appears more than once.`);
    }
    seenPages.add(slice.page);
    const { warnings: _pageWarnings, ...page } = parsed;
    pages.push(page);
  }

  pages.sort((a, b) => a.page - b.page);

  const label = slices[0]?.label ?? "Seite";
  const figures = pages.flatMap((page) => page.figures);

  for (const page of pages) {
    const ids = new Set(page.figures.map((figure) => figure.id));
    for (const placeholder of page.placeholders) {
      const normalized = placeholder.replace(/^figure_/i, "");
      if (!ids.has(normalized) && !ids.has(placeholder)) {
        warnings.push(
          `Page ${page.page} references figure "${placeholder}" that has no <figure> entry.`,
        );
      }
    }
  }

  return { reference, pageLabel: label, pages, figures, preamble, warnings };
}
