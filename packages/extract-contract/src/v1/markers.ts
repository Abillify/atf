// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * markers.ts
 *
 * The canonical marker grammar. This file is the normative definition of what
 * an extracted document looks like on the wire; everything else in this package
 * either produces or consumes what is specified here.
 *
 * ## Grammar
 *
 * A document is a sequence of pages joined by {@link PAGE_SEPARATOR}. Each page
 * is:
 *
 *     ## Seite <n>
 *
 *     <summary>One paragraph describing the page.</summary>
 *
 *     <figures>
 *     <figure id="p1-f1" bbox="[0.1204, 0.3388, 0.4810, 0.7204]" page="1">Description…</figure>
 *     </figures>
 *
 *     …page body as Markdown, with <table> HTML for tabular data and
 *     ![figure_p1-f1] placeholders marking where each figure sits in the flow…
 *
 * ## Why these specific markers
 *
 * They are not arbitrary: `apps/search/src/document-structure.ts` already
 * parses this shape, and existing indexed corpora use it. The grammar below is
 * a tightened, fully specified subset of what that parser tolerates, so a
 * document produced here is understood by Search unchanged while being
 * unambiguous enough to round-trip.
 *
 * Three deliberate constraints, each fixing a real defect in the two
 * implementations this contract replaces:
 *
 *  1. **Figure ids are globally unique within a document** (`p<page>-f<n>`).
 *     The previous pipelines restarted numbering at 0 on every page, so Search
 *     saw duplicate ids and silently suffixed them (`0`, `0-2`, `0-3`). Asset
 *     ids are derived from the figure id, so that renaming broke the binding
 *     between an uploaded crop and the chunk referencing it.
 *
 *  2. **bbox is normalised to `[0,1]`, as `[x1, y1, x2, y2]`, origin top-left.**
 *     The prompt in the previous pipeline asked for `[x_min, y_min, x_max,
 *     y_max]` while the cropper computed `crop((left, upper, left + right,
 *     upper + lower))` — i.e. it read the same four numbers as `[x, y, w, h]`.
 *     Every crop was wrong unless the figure happened to start at the origin.
 *     Normalised coordinates additionally make a bbox independent of the DPI
 *     the page was rendered at, so re-rendering at higher resolution does not
 *     invalidate stored geometry.
 *
 *  3. **No contract metadata inside the body.** Search indexes whatever it does
 *     not recognise as structure. A `<!-- version -->` comment or a `<pagemeta>`
 *     tag would become retrievable text. Provenance therefore travels in
 *     headers and the JSON envelope only.
 *
 * ## Regex discipline
 *
 * Exported patterns are non-global so they are safe to share. Functions that
 * need to iterate construct their own `g`-flagged copy via {@link globalize},
 * because a module-level global regex carries `lastIndex` between calls and
 * turns concurrent parses into intermittent misses.
 */

/** Page-marker label. Both are accepted on parse; one is chosen on serialize. */
export const PAGE_LABELS = ["Seite", "Page"] as const;

export type PageLabel = (typeof PAGE_LABELS)[number];

/**
 * Default label.
 *
 * German, because the existing corpora and the upstream extraction prompts are
 * German and re-labelling would make previously ingested documents inconsistent
 * with newly ingested ones. Producers targeting a different language set
 * `pageLabel` explicitly.
 */
export const DEFAULT_PAGE_LABEL: PageLabel = "Seite";

/** Separator between two serialized pages. */
export const PAGE_SEPARATOR = "\n\n---\n\n";

/**
 * A page marker on its own line: `## Seite 12`.
 *
 * Kept byte-compatible with the pattern in
 * `apps/search/src/document-structure.ts`, which is the reason for accepting
 * both labels and tolerating trailing whitespace.
 */
export const PAGE_MARKER_PATTERN = /^##[ \t]+(?:Seite|Page)[ \t]+(\d+)[ \t]*$/im;

/** The `<figures>…</figures>` container that groups a page's figure entries. */
export const FIGURES_BLOCK_PATTERN = /<figures\b[^>]*>([\s\S]*?)<\/figures\s*>/i;

/** A single `<figure …>description</figure>` entry. */
export const FIGURE_PATTERN = /<figure\b([^>]*)>([\s\S]*?)<\/figure\s*>/i;

/** A page-level `<summary>…</summary>` block. */
export const SUMMARY_PATTERN = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

/** An in-body figure placeholder: `![figure_p1-f1]`. */
export const FIGURE_PLACEHOLDER_PATTERN = /!\[figure_([^\]]+)\](?:\([^)]*\))?/i;

/**
 * Permitted figure-id shape.
 *
 * Restricted to the characters Search preserves verbatim
 * (`[a-zA-Z0-9._-]`). Anything else is rewritten to `-` there, which would
 * break the asset-id binding.
 */
export const FIGURE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Ids that Search rewrites even though every character is allowed: it strips a
 * leading `figure_` prefix. A producer must never emit one.
 */
export const RESERVED_FIGURE_ID_PREFIX = /^figure_/i;

/** Image formats accepted for a figure crop, matching Search's asset whitelist. */
export const FIGURE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type FigureMimeType = (typeof FIGURE_MIME_TYPES)[number];

/** Normalised bounding box: `[x1, y1, x2, y2]` in `[0,1]`, origin top-left. */
export type BoundingBox = readonly [number, number, number, number];

/** Number of decimals a serialized bbox coordinate carries. */
export const BBOX_PRECISION = 4;

/** Return a fresh global-flagged copy of a shared pattern. */
export function globalize(pattern: RegExp): RegExp {
  return new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
}

/** `## Seite 3` */
export function buildPageMarker(
  page: number,
  label: PageLabel = DEFAULT_PAGE_LABEL,
): string {
  return `## ${label} ${page}`;
}

/**
 * Canonical figure id: `p<page>-f<ordinal>`, both 1-based.
 *
 * Page-scoped and document-unique at the same time, which is what keeps asset
 * ids stable when a single page is re-extracted.
 */
export function buildFigureId(page: number, ordinal: number): string {
  return `p${page}-f${ordinal}`;
}

/** `![figure_p1-f1]` — marks where a figure sits in the reading order. */
export function buildFigurePlaceholder(figureId: string): string {
  return `![figure_${figureId}]`;
}

/**
 * Clamp and round a bounding box into the contract's coordinate space.
 *
 * Vision models routinely return slightly out-of-range or inverted boxes.
 * Rejecting those would drop otherwise usable figures, so the contract
 * normalises instead: clamp to `[0,1]`, order the corners, and round to
 * {@link BBOX_PRECISION}. A box that collapses to zero area is returned as-is
 * and rejected later by validation, because that is a genuine extraction
 * failure rather than a rounding artefact.
 */
export function normalizeBoundingBox(bbox: BoundingBox): BoundingBox {
  const clamp = (value: number): number =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const round = (value: number): number =>
    Number.parseFloat(value.toFixed(BBOX_PRECISION));
  const [rawX1, rawY1, rawX2, rawY2] = bbox;
  const x1 = clamp(rawX1);
  const y1 = clamp(rawY1);
  const x2 = clamp(rawX2);
  const y2 = clamp(rawY2);
  return [
    round(Math.min(x1, x2)),
    round(Math.min(y1, y2)),
    round(Math.max(x1, x2)),
    round(Math.max(y1, y2)),
  ];
}

/** True when the box is inside `[0,1]`, correctly ordered and has area. */
export function isValidBoundingBox(bbox: BoundingBox): boolean {
  const [x1, y1, x2, y2] = bbox;
  return (
    [x1, y1, x2, y2].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
    x2 > x1 &&
    y2 > y1
  );
}

/** `[0.1204, 0.3388, 0.4810, 0.7204]` */
export function formatBoundingBox(bbox: BoundingBox): string {
  return `[${bbox.map((v) => v.toFixed(BBOX_PRECISION)).join(", ")}]`;
}

/**
 * Convert a normalised box to absolute pixels for a rendered page of the given
 * size. Rounds outward so a crop never clips content, and guarantees at least
 * one pixel in each dimension.
 */
export function boundingBoxToPixels(
  bbox: BoundingBox,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const [x1, y1, x2, y2] = bbox;
  const left = Math.max(0, Math.floor(x1 * width));
  const top = Math.max(0, Math.floor(y1 * height));
  const right = Math.min(width, Math.ceil(x2 * width));
  const bottom = Math.min(height, Math.ceil(y2 * height));
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Convert an absolute pixel box on a page of the given size to `[0,1]`. */
export function boundingBoxFromPixels(
  pixels: readonly [number, number, number, number],
  width: number,
  height: number,
): BoundingBox {
  if (width <= 0 || height <= 0) return [0, 0, 0, 0];
  const [x1, y1, x2, y2] = pixels;
  return normalizeBoundingBox([x1 / width, y1 / height, x2 / width, y2 / height]);
}

/**
 * Make prose safe to place inside a `<figure>` element.
 *
 * Angle brackets are removed rather than entity-escaped: the description is
 * read back by a regex that stops at the first `>`, and Search strips residual
 * tags from it anyway, so an escaped entity would only survive as literal
 * `&lt;` in a retrieved snippet.
 */
export function escapeFigureDescription(description: string): string {
  return description
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Make a value safe as a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/"/g, "&quot;");
}

/** Fields needed to render a `<figure>` element. */
export interface FigureTagInput {
  id: string;
  page: number;
  description: string;
  bbox: BoundingBox;
}

/**
 * `<figure id="p1-f1" bbox="[…]" page="1">description</figure>`
 *
 * Attribute order is fixed with `id` first. Search locates the id with a
 * `(?:^|\s)(?:id|data-figure-id)=` pattern, and putting a longer attribute
 * first has previously caused surprising matches; a fixed order removes the
 * question.
 */
export function buildFigureTag(figure: FigureTagInput): string {
  return (
    `<figure id="${escapeAttribute(figure.id)}"` +
    ` bbox="${formatBoundingBox(figure.bbox)}"` +
    ` page="${figure.page}">` +
    `${escapeFigureDescription(figure.description)}</figure>`
  );
}

/** `<figures>` block wrapping one `<figure>` element per line. */
export function buildFiguresBlock(figures: readonly FigureTagInput[]): string {
  if (figures.length === 0) return "";
  return `<figures>\n${figures.map(buildFigureTag).join("\n")}\n</figures>`;
}

/** `<summary>…</summary>`, or the empty string for blank input. */
export function buildSummaryTag(summary: string): string {
  const text = summary.replace(/\s+/g, " ").trim();
  return text === "" ? "" : `<summary>${text.replace(/<\/summary/gi, "< /summary")}</summary>`;
}

/**
 * Extract the `id` attribute from a raw attribute string.
 *
 * Mirrors Search's tolerance deliberately: unquoted, single-quoted and
 * comma-terminated forms all appear in documents produced before this contract
 * existed, and a parser that rejected them could not re-read them.
 */
export function parseFigureIdAttribute(rawAttrs: string): string | undefined {
  const match =
    /(?:^|\s)(?:id|data-figure-id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s>]+))/i.exec(
      rawAttrs,
    );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** Extract the `page` attribute from a raw attribute string. */
export function parsePageAttribute(rawAttrs: string): number | undefined {
  const match = /(?:^|\s)(?:page|data-page)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s>]+))/i.exec(
    rawAttrs,
  );
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  if (raw === undefined) return undefined;
  const page = Number.parseInt(raw, 10);
  return Number.isInteger(page) && page >= 1 ? page : undefined;
}

/**
 * Extract the `bbox` attribute from a raw attribute string.
 *
 * Accepts `bbox="[a, b, c, d]"`, `bbox=[a b c d]` and semicolon separators, for
 * the same backward-compatibility reason as {@link parseFigureIdAttribute}.
 * Returns undefined unless exactly four finite numbers are present.
 */
export function parseBoundingBoxAttribute(
  rawAttrs: string,
): BoundingBox | undefined {
  const match =
    /(?:^|\s)(?:bbox|data-bbox)\s*=\s*(?:\[([^\]]+)\]|"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
      rawAttrs,
    );
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4];
  if (raw === undefined || raw.trim() === "") return undefined;
  const values = raw
    .replace(/^\[|\]$/g, "")
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite)) return undefined;
  const [x1, y1, x2, y2] = values;
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
    return undefined;
  }
  return [x1, y1, x2, y2];
}
