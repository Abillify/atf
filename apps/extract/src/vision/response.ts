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
} from "@atf/extract-contract/v1";
import {
  figureKindSchema,
  processTranscriptionSchema,
  fieldsTranscriptionSchema,
  drawingTranscriptionSchema,
  dataTranscriptionSchema,
  markdownTranscriptionSchema,
  type FigureKind,
  type Transcription,
} from "@atf/extract-contract/v2";

/** The set of valid `FigureKind` values, for tolerant attribute validation. */
const FIGURE_KINDS: ReadonlySet<string> = new Set(figureKindSchema.options);

/** The `kind` a figure gets when the model omitted it or gave an unknown value. */
const DEFAULT_FIGURE_KIND: FigureKind = "other";

/** A figure as the model reported it, after renumbering to the contract scheme. */
export interface ParsedVisionFigure {
  /** Contract id, `p<page>-f<ordinal>`. */
  id: string;
  /** The id the model used, kept so placeholder rewriting can find it. */
  modelId: string;
  /** 2–3 sentence summary of the figure (design §5 S3, requirement 8.1). */
  description: string;
  /**
   * The figure's kind (design §5 S3). Drives which structured transcription
   * Pass 2 produces. Defaults to `"other"` when the model omitted it or gave a
   * value outside the contract enum.
   */
  kind: FigureKind;
  /** The figure's caption, verbatim, when the model supplied one. */
  caption: string | undefined;
  /** Absent when the model gave no parsable box; the figure has no crop then. */
  bbox: BoundingBox | undefined;
}

/**
 * A table the model marked as spanning a page boundary (design §5 S3,
 * requirement 9.2). The parser does not restructure the table — it stays as HTML
 * in {@link ParsedVisionPage.markdown} — it only surfaces the continuation flags
 * so the document pass (task 2.6) knows which tables to merge.
 */
export interface ParsedVisionTable {
  /** Zero-based index of the `<table>` in the page body, in reading order. */
  index: number;
  /** True when the table runs off the bottom of this page (`data-continues`). */
  continues: boolean;
  /**
   * True when this table is the continuation of the previous page's table
   * (`data-continuation`). Named to mirror the contract's `continuationOf`,
   * which the document pass fills with the actual predecessor `tableId`.
   */
  continuationOf: boolean;
}

export interface ParsedVisionPage {
  summary: string | undefined;
  figures: ParsedVisionFigure[];
  /**
   * Tables the model flagged as crossing a page boundary. Empty when no table
   * carried a continuation attribute.
   */
  tables: ParsedVisionTable[];
  /** Body Markdown with placeholders rewritten to contract ids. */
  markdown: string;
  /** Deviations from the requested format, for logging and the page's warnings. */
  warnings: string[];
}

/**
 * Extract a `kind` attribute from a raw attribute string, tolerating the same
 * quoting variants as the contract's id/bbox parsers. Returns a validated
 * {@link FigureKind}, or `undefined` when absent or unrecognised (the caller
 * then falls back to {@link DEFAULT_FIGURE_KIND} and records a warning).
 */
function parseKindAttribute(rawAttrs: string): FigureKind | undefined {
  const match = /(?:^|\s)(?:kind|data-kind)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s>]+))/i.exec(
    rawAttrs,
  );
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  return FIGURE_KINDS.has(raw) ? (raw as FigureKind) : undefined;
}

/** Extract a `caption` attribute from a raw attribute string, or `undefined`. */
function parseCaptionAttribute(rawAttrs: string): string | undefined {
  const match = /(?:^|\s)(?:caption|data-caption)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(
    rawAttrs,
  );
  const raw = (match?.[1] ?? match?.[2])?.replace(/\s+/g, " ").trim();
  return raw === undefined || raw === "" ? undefined : raw;
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
  kind: FigureKind | undefined;
  caption: string | undefined;
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
    const kind = parseKindAttribute(rawAttrs);
    const caption = parseCaptionAttribute(rawAttrs);
    const description = inner
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    figures.push({
      modelId: modelId === "" ? String(ordinal) : modelId,
      description,
      kind,
      caption,
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

/** Opening `<table …>` tags in body order, with their raw attribute string. */
const TABLE_OPEN_TAG = /<table\b([^>]*)>/gi;

/** True when an attribute string sets a boolean-ish attribute to a truthy value. */
function attrIsTrue(rawAttrs: string, names: readonly string[]): boolean {
  for (const name of names) {
    // Match `name`, `name="true"`, `name='1'`, `name=true`, etc. A bare
    // attribute (`data-continues` with no value) is treated as true — HTML's
    // own convention for boolean attributes.
    const pattern = new RegExp(
      `(?:^|\\s)${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?`,
      "i",
    );
    const match = pattern.exec(rawAttrs);
    if (match === null) continue;
    const value = (match[1] ?? match[2] ?? match[3])?.trim().toLowerCase();
    if (value === undefined) return true; // bare attribute
    if (value === "" || value === "false" || value === "0" || value === "no") continue;
    return true;
  }
  return false;
}

/**
 * Scan the body for `<table>` elements the model flagged as spanning a page
 * boundary (design §5 S3, requirement 9.2). Reads only the opening tags — the
 * table content is left untouched in the body — and reports one entry per table
 * that carries a continuation attribute. Tables with neither flag are omitted,
 * so an ordinary single-page table produces nothing.
 */
function detectTables(markdown: string): ParsedVisionTable[] {
  const tables: ParsedVisionTable[] = [];
  let index = 0;
  for (const match of markdown.matchAll(TABLE_OPEN_TAG)) {
    const attrs = match[1] ?? "";
    const continues = attrIsTrue(attrs, ["data-continues", "continues"]);
    const continuationOf = attrIsTrue(attrs, ["data-continuation", "data-continuation-of", "continuationof"]);
    if (continues || continuationOf) {
      tables.push({ index, continues, continuationOf });
    }
    index++;
  }
  return tables;
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
    kind: figure.kind ?? DEFAULT_FIGURE_KIND,
    caption: figure.caption,
    bbox: figure.bbox,
  }));

  for (const [index, raw] of rawFigures.entries()) {
    const figure = figures[index];
    if (figure === undefined) continue;
    if (figure.bbox === undefined) {
      warnings.push(`Figure ${figure.id} has no usable bbox; no crop will be produced.`);
    }
    if (raw.kind === undefined) {
      // A missing or unrecognised kind is recoverable — the figure defaults to
      // "other" and simply gets no type-specific Pass 2 — but it is worth
      // surfacing so a systematic prompt regression shows up in aggregate.
      warnings.push(`Figure ${figure.id} had no recognised kind; defaulted to "other".`);
    }
  }

  const body = extractMarkdown(withoutFigures, warnings);
  const markdown = tidy(rewritePlaceholders(body, figures, warnings));
  const tables = detectTables(markdown);

  if (markdown === "" && figures.length === 0) {
    warnings.push("The model returned neither text nor figures for this page.");
  }

  return { summary, figures, tables, markdown, warnings };
}

// ── Pass 2 (S5): per-format transcription parsers ──────────────────────────

/**
 * response.ts — Pass 2 parsers
 *
 * Pass 2 asks the model for a single JSON object matching one member of the
 * contract's `Transcription` union (see `prompts.ts`). These parsers turn that
 * raw response into a *validated* {@link Transcription}, and — like the page
 * parser above — they are tolerant by design: the input is a language model's
 * output, so it is nearly always well-formed, and rejecting the whole figure
 * because one field is the wrong type throws away a transcription that is 95 %
 * usable and costs a full re-inference.
 *
 * The recovery strategy is uniform:
 *
 *  - strip `<think>` blocks and an outer ```json fence, then locate the first
 *    balanced `{…}` so leading prose ("Here is the JSON:") does not defeat the
 *    parse;
 *  - coerce each field toward its schema shape (a missing array → `[]`, a
 *    non-string label → its string form, a malformed row dropped) rather than
 *    throwing, appending a warning for each coercion so a systematic prompt
 *    problem shows up in aggregate;
 *  - validate the coerced object against the contract zod schema as the final
 *    gate, so what leaves here is always a contract-valid transcription;
 *  - when the response cannot be salvaged into the target format at all, fall
 *    back to a `markdown` transcription carrying the raw text, so the figure
 *    still contributes retrievable content instead of nothing.
 */

/** A parsed transcription plus any tolerant-recovery warnings. */
export interface ParsedTranscription {
  transcription: Transcription;
  warnings: string[];
}

/** Strip reasoning traces and a ```json/``` fence, then trim. */
function stripToJson(raw: string): string {
  let text = raw.replace(THINK_BLOCK, "");
  if (UNCLOSED_THINK.test(text)) text = text.replace(UNCLOSED_THINK, "");
  const fence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/i.exec(text.trim());
  if (fence?.[1] !== undefined) text = fence[1];
  return text.trim();
}

/**
 * Extract the first balanced JSON object from a string, tolerating leading and
 * trailing prose. Returns `undefined` when there is no `{…}` at all. Respects
 * string literals so a `}` inside a quoted value does not end the object early.
 */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Parse the raw response to a plain object, or `undefined` when unsalvageable. */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const json = extractJsonObject(stripToJson(raw));
  if (json === undefined) return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Coerce any value to a trimmed string; objects/arrays render as JSON. */
function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Coerce a value to a string array, dropping empties. */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString).map((s) => s.trim()).filter((s) => s !== "");
}

/** Coerce a boolean-ish value, or `undefined` when absent/ambiguous. */
function asOptBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "ja", "yes", "1", "required", "pflicht"].includes(v)) return true;
    if (["false", "nein", "no", "0", "optional"].includes(v)) return false;
  }
  return undefined;
}

/** Coerce a value to an optional non-empty trimmed string. */
function asOptString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = asString(value).trim();
  return s === "" ? undefined : s;
}

/** Coerce a 2-D table: an array of rows, each an array of string cells. */
function asTable(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  const rows: string[][] = [];
  for (const row of value) {
    if (Array.isArray(row)) rows.push(row.map(asString));
    else if (row !== null && row !== undefined) rows.push([asString(row)]);
  }
  return rows;
}

/** A markdown fallback carrying the raw response, when a format cannot be met. */
function markdownFallback(raw: string, warnings: string[], reason: string): ParsedTranscription {
  warnings.push(reason);
  const text = stripToJson(raw);
  return {
    transcription: markdownTranscriptionSchema.parse({
      format: "markdown",
      text: text === "" ? raw.trim() : text,
    }),
    warnings,
  };
}

/** Parse a `process` transcription (bpmn / flowchart). */
export function parseProcess(raw: string): ParsedTranscription {
  const warnings: string[] = [];
  const obj = parseJsonObject(raw);
  if (obj === undefined) {
    return markdownFallback(raw, warnings, "Pass 2 (process): no JSON object found; kept as text.");
  }

  const nodes: unknown = obj["nodes"];
  const coercedNodes = Array.isArray(nodes)
    ? nodes.flatMap((n, i) => {
        if (typeof n !== "object" || n === null) {
          warnings.push(`Pass 2 (process): node ${i} was not an object; dropped.`);
          return [];
        }
        const node = n as Record<string, unknown>;
        return [
          {
            id: asString(node["id"]).trim() || `n${i + 1}`,
            type: asString(node["type"]).trim() || "task",
            label: asString(node["label"]).trim(),
            ...(asOptString(node["lane"]) !== undefined ? { lane: asOptString(node["lane"]) } : {}),
          },
        ];
      })
    : [];

  const edges: unknown = obj["edges"];
  const coercedEdges = Array.isArray(edges)
    ? edges.flatMap((e, i) => {
        if (typeof e !== "object" || e === null) {
          warnings.push(`Pass 2 (process): edge ${i} was not an object; dropped.`);
          return [];
        }
        const edge = e as Record<string, unknown>;
        const from = asString(edge["from"]).trim();
        const to = asString(edge["to"]).trim();
        if (from === "" || to === "") {
          warnings.push(`Pass 2 (process): edge ${i} had no from/to; dropped.`);
          return [];
        }
        return [
          {
            from,
            to,
            ...(asOptString(edge["condition"]) !== undefined
              ? { condition: asOptString(edge["condition"]) }
              : {}),
          },
        ];
      })
    : [];

  const lanes = asStringArray(obj["lanes"]);
  const candidate = {
    format: "process" as const,
    mermaid: asString(obj["mermaid"]).trim(),
    nodes: coercedNodes,
    edges: coercedEdges,
    ...(lanes.length > 0 ? { lanes } : {}),
    steps: asStringArray(obj["steps"]),
  };

  const result = processTranscriptionSchema.safeParse(candidate);
  if (!result.success) {
    return markdownFallback(raw, warnings, "Pass 2 (process): validation failed; kept as text.");
  }
  return { transcription: result.data, warnings };
}

/** Parse a `fields` transcription (ui_mask). */
export function parseFields(raw: string): ParsedTranscription {
  const warnings: string[] = [];
  const obj = parseJsonObject(raw);
  if (obj === undefined) {
    return markdownFallback(raw, warnings, "Pass 2 (fields): no JSON object found; kept as text.");
  }

  const areasRaw: unknown = obj["areas"];
  const areas = Array.isArray(areasRaw)
    ? areasRaw.flatMap((a, i) => {
        if (typeof a !== "object" || a === null) {
          warnings.push(`Pass 2 (fields): area ${i} was not an object; dropped.`);
          return [];
        }
        const area = a as Record<string, unknown>;
        const fieldsRaw: unknown = area["fields"];
        const fields = Array.isArray(fieldsRaw)
          ? fieldsRaw.flatMap((f, j) => {
              if (typeof f !== "object" || f === null) {
                warnings.push(`Pass 2 (fields): field ${i}.${j} was not an object; dropped.`);
                return [];
              }
              const field = f as Record<string, unknown>;
              const required = asOptBool(field["required"]);
              return [
                {
                  label: asString(field["label"]).trim(),
                  type: asString(field["type"]).trim() || "text",
                  ...(required !== undefined ? { required } : {}),
                  ...(asOptString(field["default"]) !== undefined
                    ? { default: asOptString(field["default"]) }
                    : {}),
                  ...(asOptString(field["hint"]) !== undefined
                    ? { hint: asOptString(field["hint"]) }
                    : {}),
                },
              ];
            })
          : [];
        return [{ name: asString(area["name"]).trim(), fields }];
      })
    : [];

  const messages = asStringArray(obj["messages"]);
  const candidate = {
    format: "fields" as const,
    areas,
    actions: asStringArray(obj["actions"]),
    ...(messages.length > 0 ? { messages } : {}),
  };

  const result = fieldsTranscriptionSchema.safeParse(candidate);
  if (!result.success) {
    return markdownFallback(raw, warnings, "Pass 2 (fields): validation failed; kept as text.");
  }
  return { transcription: result.data, warnings };
}

/** Parse a `drawing` transcription (technical_drawing). */
export function parseDrawing(raw: string): ParsedTranscription {
  const warnings: string[] = [];
  const obj = parseJsonObject(raw);
  if (obj === undefined) {
    return markdownFallback(raw, warnings, "Pass 2 (drawing): no JSON object found; kept as text.");
  }

  const titleBlockRaw: unknown = obj["titleBlock"];
  const titleBlock: Record<string, string> = {};
  if (typeof titleBlockRaw === "object" && titleBlockRaw !== null && !Array.isArray(titleBlockRaw)) {
    for (const [k, v] of Object.entries(titleBlockRaw as Record<string, unknown>)) {
      titleBlock[k] = asString(v);
    }
  } else if (titleBlockRaw !== undefined) {
    warnings.push("Pass 2 (drawing): titleBlock was not an object; treated as empty.");
  }

  const partsList = asTable(obj["partsList"]);
  const legend = asStringArray(obj["legend"]);
  const dimensions = asStringArray(obj["dimensions"]);
  const views = asStringArray(obj["views"]);
  const notes = asStringArray(obj["notes"]);

  const candidate = {
    format: "drawing" as const,
    titleBlock,
    ...(partsList.length > 0 ? { partsList } : {}),
    ...(legend.length > 0 ? { legend } : {}),
    ...(dimensions.length > 0 ? { dimensions } : {}),
    ...(views.length > 0 ? { views } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };

  const result = drawingTranscriptionSchema.safeParse(candidate);
  if (!result.success) {
    return markdownFallback(raw, warnings, "Pass 2 (drawing): validation failed; kept as text.");
  }
  return { transcription: result.data, warnings };
}

/** Parse a `data` transcription (chart). */
export function parseData(raw: string): ParsedTranscription {
  const warnings: string[] = [];
  const obj = parseJsonObject(raw);
  if (obj === undefined) {
    return markdownFallback(raw, warnings, "Pass 2 (data): no JSON object found; kept as text.");
  }
  const table = asTable(obj["table"]);
  if (table.length === 0) {
    warnings.push("Pass 2 (data): no table rows were extracted.");
  }
  const axes = asStringArray(obj["axes"]);
  const candidate = {
    format: "data" as const,
    table,
    ...(axes.length > 0 ? { axes } : {}),
  };
  const result = dataTranscriptionSchema.safeParse(candidate);
  if (!result.success) {
    return markdownFallback(raw, warnings, "Pass 2 (data): validation failed; kept as text.");
  }
  return { transcription: result.data, warnings };
}

/**
 * Parse a `table_image` transcription. The design maps a table-image figure to
 * a `table` block, but a figure block carries a {@link Transcription}, not a
 * table block; the `data` transcription is exactly a header-plus-rows table and
 * `renderMarkdown` renders it as an HTML/Markdown table, so a table image lands
 * as a `data` transcription with no axes — the same shape a chart produces,
 * which is what "maps onto a table block" means for a figure.
 */
export function parseTableImage(raw: string): ParsedTranscription {
  const result = parseData(raw);
  // Drop any axes the model volunteered — a transcribed table has none.
  if (result.transcription.format === "data" && result.transcription.axes !== undefined) {
    const { axes: _axes, ...rest } = result.transcription;
    return { transcription: rest, warnings: result.warnings };
  }
  return result;
}

/** The per-kind parser table; a kind absent here gets no Pass 2. */
const PASS2_PARSERS: Readonly<Record<string, (raw: string) => ParsedTranscription>> = {
  bpmn: parseProcess,
  flowchart: parseProcess,
  ui_mask: parseFields,
  technical_drawing: parseDrawing,
  chart: parseData,
  table_image: parseTableImage,
};

/**
 * Parse a Pass-2 raw response for a given figure kind into a validated
 * {@link Transcription}. Returns `null` for a kind that gets no Pass 2 (photo,
 * diagram, other), so the caller can gate on the same table the runner does.
 */
export function parseTranscription(kind: string, raw: string): ParsedTranscription | null {
  const parser = PASS2_PARSERS[kind];
  return parser === undefined ? null : parser(raw);
}

/**
 * The fraction of `labels` (0–1) that appear, case-insensitively and
 * whitespace-normalised, somewhere in a transcription's flattened text (design
 * §5 S5, requirement 8.4). An empty label set is fully covered (1) — there is
 * nothing to miss — so a figure with no text layer never triggers a spurious
 * low-coverage retry.
 */
export function labelCoverage(labels: readonly string[], transcription: Transcription): number {
  const normalisedLabels = labels
    .map((l) => l.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((l) => l !== "");
  if (normalisedLabels.length === 0) return 1;
  const haystack = flattenTranscription(transcription).replace(/\s+/g, " ").toLowerCase();
  let hits = 0;
  for (const label of normalisedLabels) {
    if (haystack.includes(label)) hits++;
  }
  return hits / normalisedLabels.length;
}

/** Flatten every text-bearing field of a transcription into one string. */
function flattenTranscription(transcription: Transcription): string {
  switch (transcription.format) {
    case "process":
      return [
        transcription.mermaid,
        ...transcription.nodes.flatMap((n) => [n.id, n.type, n.label, n.lane ?? ""]),
        ...transcription.edges.flatMap((e) => [e.from, e.to, e.condition ?? ""]),
        ...(transcription.lanes ?? []),
        ...transcription.steps,
      ].join(" ");
    case "fields":
      return [
        ...transcription.areas.flatMap((a) => [
          a.name,
          ...a.fields.flatMap((f) => [f.label, f.type, f.default ?? "", f.hint ?? ""]),
        ]),
        ...transcription.actions,
        ...(transcription.messages ?? []),
      ].join(" ");
    case "drawing":
      return [
        ...Object.entries(transcription.titleBlock).flatMap(([k, v]) => [k, v]),
        ...(transcription.partsList ?? []).flatMap((row) => row.map(cellText)),
        ...(transcription.legend ?? []),
        ...(transcription.dimensions ?? []),
        ...(transcription.views ?? []),
        ...(transcription.notes ?? []),
      ].join(" ");
    case "data":
      return [
        ...transcription.table.flatMap((row) => row.map(cellText)),
        ...(transcription.axes ?? []),
      ].join(" ");
    case "markdown":
      return transcription.text;
  }
}

/** The text of a table cell (a bare string, or the `.text` of a span object). */
function cellText(cell: unknown): string {
  if (typeof cell === "string") return cell;
  if (typeof cell === "object" && cell !== null && "text" in cell) {
    return asString((cell as { text: unknown }).text);
  }
  return asString(cell);
}
