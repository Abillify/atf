// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * serialize.ts
 *
 * Structured document → canonical Markdown.
 *
 * Block order within a page is fixed and load-bearing rather than cosmetic:
 *
 *     ## Seite N        page marker
 *     <summary>         page summary
 *     <figures>         figure entries
 *     …body…            content
 *
 * Search derives a figure's page number from the nearest *preceding* page
 * marker (`pageAt` in `apps/search/src/document-structure.ts`). Emitting the
 * figures block before the body guarantees that lookup lands on the right page
 * even when the body itself is empty — which happens on pages that are a single
 * full-page diagram, exactly the case where the figure matters most.
 */

import {
  DEFAULT_PAGE_LABEL,
  FIGURE_PLACEHOLDER_PATTERN,
  PAGE_SEPARATOR,
  buildFiguresBlock,
  buildPageMarker,
  buildSummaryTag,
  globalize,
  type PageLabel,
} from "./markers.js";
import type { ExtractedDocument, ExtractedPage } from "./document.js";

export interface SerializeOptions {
  /** Page-marker label. Defaults to the document's own, then to `Seite`. */
  pageLabel?: PageLabel;
  /** Emit `<summary>` blocks. Default: true. */
  includeSummary?: boolean;
  /** Emit `<figures>` blocks. Default: true. */
  includeFigures?: boolean;
  /**
   * Keep `![figure_…]` placeholders in the body. Default: true.
   *
   * They carry the reading-order position of each figure. Search strips them
   * before indexing, so keeping them costs nothing there, but a consumer
   * rendering the Markdown directly needs them to place the image.
   */
  includePlaceholders?: boolean;
}

/** Collapse runs of three or more newlines and trim. */
function tidy(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Serialize one page, including its page marker. */
export function serializePage(
  page: ExtractedPage,
  options: SerializeOptions = {},
): string {
  const {
    pageLabel = DEFAULT_PAGE_LABEL,
    includeSummary = true,
    includeFigures = true,
    includePlaceholders = true,
  } = options;

  const blocks: string[] = [buildPageMarker(page.page, pageLabel)];

  if (includeSummary && page.summary !== undefined) {
    const summary = buildSummaryTag(page.summary);
    if (summary !== "") blocks.push(summary);
  }

  if (includeFigures && page.figures.length > 0) {
    const figures = buildFiguresBlock(page.figures);
    if (figures !== "") blocks.push(figures);
  }

  let body = tidy(page.markdown);
  if (!includePlaceholders) {
    body = tidy(body.replace(globalize(FIGURE_PLACEHOLDER_PATTERN), ""));
  }
  if (body !== "") blocks.push(body);

  return blocks.join("\n\n");
}

/**
 * Serialize a whole document.
 *
 * Pages are sorted by number and joined with {@link PAGE_SEPARATOR}. No
 * trailing separator: a dangling `---` at the end of a document becomes an
 * empty trailing section for any consumer that splits on it.
 */
export function serializeDocument(
  document: Pick<ExtractedDocument, "pages" | "pageLabel">,
  options: SerializeOptions = {},
): string {
  const pageLabel = options.pageLabel ?? document.pageLabel ?? DEFAULT_PAGE_LABEL;
  return [...document.pages]
    .sort((a, b) => a.page - b.page)
    .map((page) => serializePage(page, { ...options, pageLabel }))
    .join(PAGE_SEPARATOR);
}
