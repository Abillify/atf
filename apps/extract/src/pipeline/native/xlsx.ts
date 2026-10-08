// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/native/xlsx.ts
 *
 * A native spreadsheet reader: an XLSX in, contract `table` blocks out, and a
 * decision about whether the workbook needs rendering at all (design §10.2,
 * requirement 10.2).
 *
 * ## Why native, and why the render is conditional
 *
 * For a plain data spreadsheet the grid *is* the information: cells, merged
 * cells and computed values. Rendering it through LibreOffice → PDF and asking
 * a vision model to read the numbers back off a picture is both lossy (the model
 * mis-reads digits) and wasteful (a model call per page of a 10 000-row sheet).
 * So this reader pulls the values directly out of the OOXML package: each
 * worksheet becomes a `table` block, cells carry their computed values, and
 * merged cells are expressed as `colspan`/`rowspan` on their anchor cell.
 *
 * A spreadsheet only *needs* the picture when it contains something the grid
 * cannot express as text: an embedded chart or an image. So {@link readXlsx}
 * reports `needsRender` — true when the package has any chart (`xl/charts/…`) or
 * image (`xl/media/…`), false for a pure data workbook. The pipeline renders
 * only in the true case (requirement 10.2); otherwise it emits the native tables
 * and skips rendering entirely.
 *
 * ## Why fflate + fast-xml-parser, not a spreadsheet library
 *
 * A full spreadsheet library (exceljs and friends) drags in a ZIP/stream
 * dependency tree with non-permissive transitive licences (GPL-optional jszip,
 * Unlicense/Zlib helpers) that the repo's supply-chain gate rejects (requirement
 * 1.2). An XLSX is just an OOXML ZIP, and reading cell values, shared strings,
 * cached formula results and merge ranges is a bounded, well-specified parse. So
 * this uses `fflate` (MIT) to unzip and `fast-xml-parser` (already a dependency)
 * to read the parts — no new heavyweight dependency, a clean licence tree.
 *
 * ## Tolerant and bounded
 *
 * A workbook that fails to unzip or parse yields an empty result with a warning
 * rather than throwing. A cell's value is its cached computed result: a shared
 * string resolves through the string table, a formula cell (`<f>` + `<v>`) reads
 * the cached `<v>` — exactly the "computed values" the requirement asks for.
 */

import { unzipSync, strFromU8 } from "fflate";
import { ExtractError } from "../../errors.js";
import { safeXmlParser } from "../safe-xml.js";
import { assertZipWithinLimits, type ZipLimits } from "./zip-guard.js";

/** A cell in a native table: text plus optional merge spans (contract shape). */
export interface XlsxCell {
  text: string;
  colspan?: number;
  rowspan?: number;
}

/** One worksheet as a table of rows of cells. */
export interface XlsxSheet {
  name: string;
  /** Rows of cells, top-to-bottom, left-to-right. Merged followers are dropped. */
  rows: XlsxCell[][];
}

/** The parsed workbook plus the render decision and any warnings. */
export interface ParsedXlsx {
  sheets: XlsxSheet[];
  /**
   * True when the workbook embeds a chart or an image, so the pipeline must
   * render it to capture what the grid cannot (requirement 10.2). False for a
   * pure data workbook, which is emitted as native tables with no rendering.
   */
  needsRender: boolean;
  /** Why a render is needed, for the log/warnings (empty when it is not). */
  renderReasons: string[];
  warnings: string[];
}

const parser = safeXmlParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  removeNSPrefix: true,
  isArray: (name) =>
    name === "sheet" ||
    name === "row" ||
    name === "c" ||
    name === "mergeCell" ||
    name === "si",
});

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: unknown, name: string): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const value = (node as Record<string, unknown>)[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

/** Parse `A1` into `{ row, col }` (1-based), or null when malformed. */
function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { row: Number(match[2]), col: columnToNumber(match[1]) };
}

/** Convert a column label (`A`, `Z`, `AA`) to a 1-based column number. */
function columnToNumber(label: string): number {
  let col = 0;
  for (const ch of label.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col;
}

/** A merge region parsed from an `A1:B2` range string, in 1-based coordinates. */
interface MergeRegion {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Parse an `A1:B2` merge range into a {@link MergeRegion}, or null. */
function parseMergeRange(range: string): MergeRegion | null {
  const [a, b] = range.split(":");
  if (a === undefined || b === undefined) return null;
  const start = parseCellRef(a);
  const end = parseCellRef(b);
  if (start === null || end === null) return null;
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.col, end.col),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.col, end.col),
  };
}

/** Collapse a fast-xml-parser text node (string, number, or `{#text}`) to a string. */
function textOf(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null) {
    const text = (value as Record<string, unknown>)["#text"];
    if (typeof text === "string" || typeof text === "number") return String(text);
  }
  return "";
}

/** Read the shared-string table (`xl/sharedStrings.xml`), if present. */
function readSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const sst = doc["sst"];
  if (typeof sst !== "object" || sst === null) return [];
  const strings: string[] = [];
  for (const si of asArray((sst as Record<string, unknown>)["si"])) {
    strings.push(sharedStringText(si));
  }
  return strings;
}

/** The text of one `<si>` shared string: a plain `<t>` or concatenated rich-text runs. */
function sharedStringText(si: unknown): string {
  if (typeof si !== "object" || si === null) return textOf(si);
  const node = si as Record<string, unknown>;
  if (node["t"] !== undefined) return textOf(node["t"]);
  // Rich text: concatenate every run's `<t>`.
  const runs = asArray(node["r"]);
  if (runs.length > 0) {
    return runs
      .map((r) => (typeof r === "object" && r !== null ? textOf((r as Record<string, unknown>)["t"]) : ""))
      .join("");
  }
  return "";
}

/** The displayed value of one `<c>` cell, resolving shared strings and formulas. */
function cellValue(cell: Record<string, unknown>, sharedStrings: string[]): string {
  const type = attr(cell, "t"); // s = shared, str = formula string, inlineStr, b = bool
  const vNode = cell["v"];
  const raw = vNode !== undefined ? textOf(vNode) : "";
  if (type === "s") {
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < sharedStrings.length
      ? sharedStrings[index] ?? ""
      : "";
  }
  if (type === "inlineStr") {
    const is = cell["is"];
    if (typeof is === "object" && is !== null) return sharedStringText(is);
    return raw;
  }
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  // Number, date (serial), formula-string (`t="str"`) or a formula's cached `<v>`.
  return raw;
}

/** Read a worksheet part into rows of cells, applying merges. */
function readSheet(name: string, xml: string, sharedStrings: string[]): XlsxSheet {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { name, rows: [] };
  }
  const worksheet = doc["worksheet"];
  if (typeof worksheet !== "object" || worksheet === null) return { name, rows: [] };
  const ws = worksheet as Record<string, unknown>;

  // Merge regions.
  const regions: MergeRegion[] = [];
  const mergeCellsNode = ws["mergeCells"];
  if (typeof mergeCellsNode === "object" && mergeCellsNode !== null) {
    for (const mc of asArray((mergeCellsNode as Record<string, unknown>)["mergeCell"])) {
      const ref = attr(mc, "ref");
      const region = ref !== undefined ? parseMergeRange(ref) : null;
      if (region !== null) regions.push(region);
    }
  }
  const followers = new Set<string>();
  const anchors = new Map<string, { colspan: number; rowspan: number }>();
  for (const region of regions) {
    anchors.set(`${region.top},${region.left}`, {
      colspan: region.right - region.left + 1,
      rowspan: region.bottom - region.top + 1,
    });
    for (let row = region.top; row <= region.bottom; row++) {
      for (let col = region.left; col <= region.right; col++) {
        if (row === region.top && col === region.left) continue;
        followers.add(`${row},${col}`);
      }
    }
  }

  const sheetData = ws["sheetData"];
  if (typeof sheetData !== "object" || sheetData === null) return { name, rows: [] };

  const rows: XlsxCell[][] = [];
  for (const rowNode of asArray((sheetData as Record<string, unknown>)["row"])) {
    if (typeof rowNode !== "object" || rowNode === null) continue;
    const rowRec = rowNode as Record<string, unknown>;
    const rowNumber = Number(attr(rowRec, "r") ?? "0");
    // Cells carry their own `r` (e.g. `C4`); fill gaps by column so the grid
    // stays aligned across rows with sparse cells.
    const parsed: { col: number; cell: XlsxCell }[] = [];
    for (const cNode of asArray(rowRec["c"])) {
      if (typeof cNode !== "object" || cNode === null) continue;
      const cell = cNode as Record<string, unknown>;
      const ref = attr(cell, "r");
      const pos = ref !== undefined ? parseCellRef(ref) : null;
      const col = pos?.col ?? parsed.length + 1;
      const key = `${rowNumber},${col}`;
      if (followers.has(key)) continue; // absorbed into an anchor's span
      const text = cellValue(cell, sharedStrings).replace(/\s+/g, " ").trim();
      const span = anchors.get(key);
      const xlsxCell: XlsxCell = { text };
      if (span !== undefined) {
        if (span.colspan > 1) xlsxCell.colspan = span.colspan;
        if (span.rowspan > 1) xlsxCell.rowspan = span.rowspan;
      }
      parsed.push({ col, cell: xlsxCell });
    }
    if (parsed.length === 0) continue;
    // Emit cells in column order, filling missing columns with blanks so a
    // merged anchor and its neighbours stay in the right place.
    parsed.sort((a, b) => a.col - b.col);
    const maxCol = parsed[parsed.length - 1]?.col ?? 0;
    const byCol = new Map(parsed.map((p) => [p.col, p.cell]));
    const cells: XlsxCell[] = [];
    for (let col = 1; col <= maxCol; col++) {
      cells.push(byCol.get(col) ?? { text: "" });
    }
    if (cells.some((c) => c.text !== "" || c.colspan !== undefined || c.rowspan !== undefined)) {
      rows.push(cells);
    }
  }

  return { name, rows };
}

/**
 * Read an XLSX into native tables and decide whether it needs rendering
 * (requirement 10.2). Never throws — except for a ZIP-guard violation
 * (`DOCUMENT_TOO_COMPLEX`, requirement 5.1), which is a rejection, not a
 * warning: a bomb must fail the job, not degrade to an empty sheet set.
 */
export async function readXlsx(
  buffer: Uint8Array,
  limits?: ZipLimits,
): Promise<ParsedXlsx> {
  const warnings: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    // Checked before any inflation (requirement 5.1). A limit violation throws
    // ExtractError, which the catch below re-throws instead of downgrading to
    // a warning; a buffer that is not a ZIP at all throws fflate's own error,
    // which keeps degrading to a warning as before.
    assertZipWithinLimits(buffer, limits);
    entries = unzipSync(buffer, {
      filter: (file) =>
        file.name === "xl/workbook.xml" ||
        file.name === "xl/_rels/workbook.xml.rels" ||
        file.name === "xl/sharedStrings.xml" ||
        /^xl\/worksheets\/sheet\d+\.xml$/.test(file.name) ||
        /^xl\/charts\//.test(file.name) ||
        /^xl\/media\//.test(file.name),
    });
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    warnings.push(
      `Das XLSX konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { sheets: [], needsRender: false, renderReasons: [], warnings };
  }

  const workbookBytes = entries["xl/workbook.xml"];
  if (workbookBytes === undefined) {
    warnings.push("xl/workbook.xml fehlt; keine Arbeitsblätter.");
    return { sheets: [], needsRender: false, renderReasons: [], warnings };
  }

  const sharedStrings = readSharedStrings(
    entries["xl/sharedStrings.xml"] !== undefined
      ? strFromU8(entries["xl/sharedStrings.xml"])
      : undefined,
  );

  // Map sheet name → worksheet part via the workbook's sheet order and rels.
  const rels = readWorkbookRels(
    entries["xl/_rels/workbook.xml.rels"] !== undefined
      ? strFromU8(entries["xl/_rels/workbook.xml.rels"])
      : undefined,
  );
  const sheetRefs = readWorkbookSheets(strFromU8(workbookBytes));

  const sheets: XlsxSheet[] = [];
  let fallbackIndex = 0;
  for (const ref of sheetRefs) {
    fallbackIndex += 1;
    // Resolve the worksheet part: prefer the r:id → target rel, else the Nth
    // worksheet part by name (a workbook without rels still resolves in order).
    const target = ref.rid !== undefined ? rels.get(ref.rid) : undefined;
    const partName =
      target !== undefined
        ? normalizeXlPart(target)
        : `xl/worksheets/sheet${fallbackIndex}.xml`;
    const bytes =
      entries[partName] ?? entries[`xl/worksheets/sheet${fallbackIndex}.xml`];
    if (bytes === undefined) {
      warnings.push(`Arbeitsblatt „${ref.name}“ konnte nicht gelesen werden.`);
      continue;
    }
    sheets.push(readSheet(ref.name, strFromU8(bytes), sharedStrings));
  }

  // Charts and images force a render (they cannot be expressed as a text grid).
  const renderReasons: string[] = [];
  const names = Object.keys(entries);
  if (names.some((n) => /^xl\/charts\//.test(n))) renderReasons.push("charts");
  if (names.some((n) => /^xl\/media\//.test(n))) renderReasons.push("images");

  return {
    sheets,
    needsRender: renderReasons.length > 0,
    renderReasons,
    warnings,
  };
}

/** Read the workbook's `<sheet name= r:id=>` entries in document order. */
function readWorkbookSheets(xml: string): { name: string; rid?: string }[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const workbook = doc["workbook"];
  if (typeof workbook !== "object" || workbook === null) return [];
  const sheetsNode = (workbook as Record<string, unknown>)["sheets"];
  if (typeof sheetsNode !== "object" || sheetsNode === null) return [];
  const result: { name: string; rid?: string }[] = [];
  for (const sheet of asArray((sheetsNode as Record<string, unknown>)["sheet"])) {
    const name = attr(sheet, "name") ?? `Sheet${result.length + 1}`;
    // The relationship id attribute is `r:id`; with NS prefixes stripped it is `id`.
    const rid = attr(sheet, "id") ?? attr(sheet, "r:id");
    result.push({ name, ...(rid !== undefined ? { rid } : {}) });
  }
  return result;
}

/** Read `xl/_rels/workbook.xml.rels` into an r:id → target map. */
function readWorkbookRels(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (xml === undefined) return map;
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return map;
  }
  const relationships = doc["Relationships"];
  if (typeof relationships !== "object" || relationships === null) return map;
  const list = (relationships as Record<string, unknown>)["Relationship"];
  for (const rel of asArray(list)) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id !== undefined && target !== undefined) map.set(id, target);
  }
  return map;
}

/** Normalise a rel target (`worksheets/sheet1.xml`, `/xl/…`) to a package path. */
function normalizeXlPart(target: string): string {
  const clean = target.replace(/^\.\//, "");
  if (clean.startsWith("/")) return clean.replace(/^\//, "");
  return clean.startsWith("xl/") ? clean : `xl/${clean}`;
}
