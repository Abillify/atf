// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * response.ts
 *
 * Parsing a model's page response into summary, figures and body Markdown.
 *
 * This parser is tolerant by design, and the reason is worth stating: the input
 * is a language model's output, so it is *nearly* always well-formed. Rejecting a
 * page because the model omitted a closing tag throws away a page that is 99%
 * usable and costs a full re-inference. Every deviation therefore has a defined
 * recovery, and the recovery is recorded as a warning so a systematic prompt
 * problem is visible in aggregate rather than hidden by the fallbacks.
 *
 * Recoveries, in order of how often they fire in practice:
 *
 *  - a reasoning model leaks `<think>` blocks → stripped before anything else;
 *  - the response is wrapped in a ```markdown fence → unwrapped;
 *  - `<markdown>` is missing entirely → the whole response, minus the other two
 *    sections, is treated as the body;
 *  - `<figures>` contains the literal `None` (the older prompt asked for it) →
 *    read as no figures;
 *  - a figure carries no parsable bbox → kept, with its geometry dropped, so its
 *    description still becomes retrievable text even though no crop can be made.
 *
 * Figure ids are *renumbered* here rather than trusted. The model is asked for
 * `1, 2, 3` per page, which is not unique across a document, and the contract
 * requires document-unique ids. Mapping happens in one place so the `![figure_N]`
 * placeholders in the body are rewritten in lockstep with the entries — the two
 * drifting apart was a real defect in the earlier pipeline.
 */

import {
  FIGURE_PATTERN,
  FIGURES_BLOCK_PATTERN,
  SUMMARY_PATTERN,
  buildFigureId,
  buildFigurePlaceholder,
  globalize,
  normalizeBoundingBox,
  parseBoundingBoxAttribute,
  parseFigureIdAttribute,
  type BoundingBox,
} from "@atf/extract-contract";

/** A figure as the model reported it, after renumbering to the contract scheme. */
export interface ParsedVisionFigure {
  /** Contract id, `p<page>-f<ordinal>`. */
  id: string;
  /** The id the model used, kept so placeholder rewriting can find it. */
  modelId: string;
  description: string;
  /** Absent when the model gave no parsable box; the figure has no crop then. */
  bbox: BoundingBox | undefined;
}

export interface ParsedVisionPage {
  summary: string | undefined;
  figures: ParsedVisionFigure[];
  /** Body Markdown with placeholders rewritten to contract ids. */
  markdown: string;
  /** Deviations from the requested format, for logging and the page's warnings. */
  warnings: string[];
}

/** Reasoning traces various models emit despite being told not to. */
const THINK_BLOCK = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** An unterminated reasoning block, which happens when output is cut off. */
const UNCLOSED_THINK = /<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*$/i;
const MARKDOWN_SECTION = /<markdown\b[^>]*>([\s\S]*?)<\/markdown\s*>/i;
const UNCLOSED_MARKDOWN = /<markdown\b[^>]*>([\s\S]*)$/i;
const CODE_FENCE = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n\s*```\s*$/i;

function tidy(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    // NUL bytes reach here from a damaged text layer echoed back by the model,
    // and PostgreSQL rejects them outright at the far end of the pipeline.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing NUL is the point
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove reasoning traces and an outer code fence. */
function stripNonContent(raw: string, warnings: string[]): string {
  let text = raw.replace(THINK_BLOCK, "");
  if (UNCLOSED_THINK.test(text)) {
    text = text.replace(UNCLOSED_THINK, "");
    warnings.push("The model emitted an unterminated reasoning block; it was discarded.");
  }
  const fenced = CODE_FENCE.exec(text);
  if (fenced?.[1] !== undefined) {
    text = fenced[1];
    warnings.push("The response was wrapped in a code fence; it was unwrapped.");
  }
  return text;
}

/** Extract every `<summary>`, joined when the model emitted more than one. */
function extractSummary(text: string): { summary: string | undefined; rest: string } {
  const parts: string[] = [];
  const rest = text.replace(globalize(SUMMARY_PATTERN), (_all, inner: string) => {
    const value = inner.replace(/\s+/g, " ").trim();
    if (value !== "") parts.push(value);
    return "";
  });
  return { summary: parts.length > 0 ? parts.join(" ") : undefined, rest };
}

interface RawFigure {
  modelId: string;
  description: string;
  bbox: BoundingBox | undefined;
}

/** Extract figure entries from the `<figures>` block, and stray ones outside it. */
function extractFigures(
  text: string,
  warnings: string[],
): { figures: RawFigure[]; rest: string } {
  const figures: RawFigure[] = [];
  let ordinal = 0;

  const collect = (rawAttrs: string, inner: string): void => {
    ordinal++;
    const modelId = (parseFigureIdAttribute(rawAttrs) ?? String(ordinal)).trim();
    const rawBbox = parseBoundingBoxAttribute(rawAttrs);
    const description = inner
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    figures.push({
      modelId: modelId === "" ? String(ordinal) : modelId,
      description,
      bbox: rawBbox === undefined ? undefined : normalizeBoundingBox(rawBbox),
    });
  };

  let rest = text.replace(globalize(FIGURES_BLOCK_PATTERN), (_all, inner: string) => {
    const body = inner.trim();
    // The pre-contract prompt asked for the literal "None" on figure-free pages.
    if (body === "" || /^(?:none|n\/a|keine|-)$/i.test(body)) return "";
    let matched = false;
    body.replace(globalize(FIGURE_PATTERN), (_tag, rawAttrs: string, description: string) => {
      matched = true;
      collect(rawAttrs, description);
      return "";
    });
    if (!matched) {
      warnings.push("The <figures> block contained no parsable <figure> entries.");
    }
    return "";
  });

  // A model that forgets the wrapper still usually emits well-formed entries.
  const strayBefore = figures.length;
  rest = rest.replace(globalize(FIGURE_PATTERN), (_tag, rawAttrs: string, description: string) => {
    collect(rawAttrs, description);
    return "";
  });
  if (figures.length > strayBefore) {
    warnings.push("Figure entries were emitted outside a <figures> block; they were recovered.");
  }

  rest = rest.replace(/<\/?figures\b[^>]*>/gi, "");
  return { figures, rest };
}

/** Isolate the `<markdown>` body, falling back to whatever is left. */
function extractMarkdown(text: string, warnings: string[]): string {
  const section = MARKDOWN_SECTION.exec(text);
  if (section?.[1] !== undefined) return section[1];

  const unclosed = UNCLOSED_MARKDOWN.exec(text);
  if (unclosed?.[1] !== undefined) {
    warnings.push("The <markdown> section was not closed; the remainder was used as the body.");
    return unclosed[1];
  }

  warnings.push("The response had no <markdown> section; the whole response was used as the body.");
  return text;
}

/**
 * Rewrite `![figure_N]` placeholders from model ids to contract ids.
 *
 * Longest ids first: rewriting `1` before `12` inside `![figure_12]` would
 * corrupt it. Placeholders referring to a figure the model never declared are
 * removed, because a placeholder with no entry renders as broken-image markup and
 * points at an asset that will never exist.
 */
function rewritePlaceholders(
  markdown: string,
  figures: ParsedVisionFigure[],
  warnings: string[],
): string {
  const byModelId = new Map(figures.map((figure) => [figure.modelId, figure.id]));
  const ordered = [...byModelId.keys()].sort((a, b) => b.length - a.length);

  let result = markdown;
  for (const modelId of ordered) {
    const contractId = byModelId.get(modelId);
    if (contractId === undefined) continue;
    const pattern = new RegExp(
      `!\\[figure_${modelId.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\](?:\\([^)]*\\))?`,
      "gi",
    );
    result = result.replace(pattern, buildFigurePlaceholder(contractId));
  }

  const leftover = [...result.matchAll(/!\[figure_([^\]]+)\](?:\([^)]*\))?/gi)];
  const unknown = leftover.filter((match) => {
    const id = match[1]?.trim() ?? "";
    return !figures.some((figure) => figure.id === id);
  });
  if (unknown.length > 0) {
    warnings.push(
      `The body referenced ${unknown.length} figure placeholder(s) with no <figure> entry; they were removed.`,
    );
    result = result.replace(/!\[figure_([^\]]+)\](?:\([^)]*\))?/gi, (all, id: string) =>
      figures.some((figure) => figure.id === id.trim()) ? all : "",
    );
  }

  return result;
}

/**
 * Parse a model response for one page.
 *
 * `page` is required because figure ids are page-scoped; the same response
 * parsed as a different page produces different ids, which is correct.
 */
export function parseVisionPage(raw: string, page: number): ParsedVisionPage {
  const warnings: string[] = [];
  const text = stripNonContent(raw, warnings);

  const { summary, rest: withoutSummary } = extractSummary(text);
  const { figures: rawFigures, rest: withoutFigures } = extractFigures(withoutSummary, warnings);

  const figures: ParsedVisionFigure[] = rawFigures.map((figure, index) => ({
    id: buildFigureId(page, index + 1),
    modelId: figure.modelId,
    description: figure.description === "" ? `Abbildung ${index + 1} auf Seite ${page}` : figure.description,
    bbox: figure.bbox,
  }));

  for (const figure of figures) {
    if (figure.bbox === undefined) {
      warnings.push(`Figure ${figure.id} has no usable bbox; no crop will be produced.`);
    }
  }

  const body = extractMarkdown(withoutFigures, warnings);
  const markdown = tidy(rewritePlaceholders(body, figures, warnings));

  if (markdown === "" && figures.length === 0) {
    warnings.push("The model returned neither text nor figures for this page.");
  }

  return { summary, figures, markdown, warnings };
}
