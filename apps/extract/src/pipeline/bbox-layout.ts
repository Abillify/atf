// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * bbox-layout.ts
 *
 * Deterministic page geometry from poppler's `pdftotext -bbox-layout`
 * ("Deterministische Seitenanalyse").
 *
 * ## Why this exists
 *
 * `pdftotext -layout` (see {@link ../pipeline/pdf.ts extractPageText}) gives the
 * *wording* of a page but no coordinates: it linearises the text layer into a
 * column-preserving string and throws the geometry away. Phase 2 needs the
 * geometry — where each word, line and block sits — to
 *
 *   - snap a model-proposed figure bbox to the ink and pull the words inside it
 *     (S4, `regionText`, task 2.4),
 *   - offer heading candidates to the Pass-1 prompt (S3, task 2.3),
 *   - build blocks deterministically for the text fast-path without a vision
 *     call (S9/text-fast-path, task 2.9),
 *
 * and poppler already computes it. `-bbox-layout` emits an XHTML document whose
 * elements carry pixel-space coordinates:
 *
 * ```xml
 * <doc>
 *   <page width="612.0" height="792.0">
 *     <flow>
 *       <block>
 *         <line>
 *           <word xMin="72.0" yMin="70.5" xMax="120.3" yMax="82.1">Einleitung</word>
 *           ...
 *         </line>
 *       </block>
 *     </flow>
 *   </page>
 * </doc>
 * ```
 *
 * ## What this module does
 *
 * {@link parseBboxLayout} turns that XHTML *string* into a per-page structure of
 * blocks → lines → words, each carrying a bounding box **normalised to `[0,1]`**
 * against the page's own `width`/`height`. Normalisation is the whole point: the
 * geometry then lives in the same coordinate space as the contract's
 * {@link BBox} (origin top-left, DPI-independent), so it survives re-rendering a
 * page at a different DPI and can be handed straight to bbox snapping or stored
 * on a block. poppler gives per-word coordinates; a line's box is the union of
 * its words and a block's box the union of its lines.
 *
 * The parser is a **pure function of the XHTML string** — it never shells out —
 * so it is tested against fixtures with no poppler present. The wrapper that
 * actually runs `pdftotext -bbox-layout -f N -l N` lives beside the other
 * poppler calls in {@link ../pipeline/pdf.ts}.
 *
 * ## Robustness
 *
 * A page with no text layer (a scan) yields a `<page>` with no `<word>`, and a
 * damaged PDF can make poppler emit malformed or truncated XHTML. Neither is an
 * error here: {@link parseBboxLayout} degrades to an empty (or partial)
 * analysis and never throws, because the caller (the deterministic S2 stage)
 * must be able to fall through to vision rather than fail the page.
 */

import type { BBox } from "@atf/extract-contract/v2";
import { safeXmlParser } from "./safe-xml.js";

/** A single word with its normalised bounding box. */
export interface AnalyzedWord {
  text: string;
  /** `[x1,y1,x2,y2]` in `[0,1]`, origin top-left — the contract's convention. */
  bbox: BBox;
}

/** A line: the words on it and their union bbox. */
export interface AnalyzedLine {
  words: AnalyzedWord[];
  bbox: BBox;
  /** Concatenated word text, single-spaced. */
  text: string;
  /**
   * Line height in normalised units (`y2 - y1`). A proxy for font size: a
   * larger line height is a larger font, which is the signal a heading is set
   * apart from body text.
   */
  height: number;
}

/** A block: the lines in it and their union bbox. */
export interface AnalyzedBlock {
  lines: AnalyzedLine[];
  bbox: BBox;
  /** The block's lines joined by newlines. */
  text: string;
}

/** A heading candidate surfaced from a numbered line. */
export interface HeadingCandidate {
  /** The full line text, e.g. `2.1 Anmeldung`. */
  text: string;
  /** The numbering prefix that matched, e.g. `2.1`. */
  numbering: string;
  /** Where the candidate sits on the page, for the prompt hint / snapping. */
  bbox: BBox;
  /** The line's normalised height, the font-size proxy. */
  height: number;
}

/** The deterministic analysis of one page. */
export interface PageAnalysis {
  /** 1-based page number, when the caller supplied it; else the doc order. */
  page: number;
  /** Page geometry in points, straight from poppler's `<page>` attributes. */
  size: { widthPt: number; heightPt: number };
  blocks: AnalyzedBlock[];
  lines: AnalyzedLine[];
  words: AnalyzedWord[];
  /** Lines whose text begins with a numbering pattern (`^\d+(\.\d+)*\s`). */
  headingCandidates: HeadingCandidate[];
}

/**
 * A numbered-heading pattern: a line that begins with `1`,
 * `2.1`, `3.4.2` and so on, followed by whitespace and then some text. The
 * trailing text requirement keeps a bare figure number ("2.1" alone, or a page
 * number) from being mistaken for a heading.
 */
const HEADING_NUMBERING = /^(\d+(?:\.\d+)*)\s+\S/;

/**
 * Parser configured to keep attributes (the coordinates live there) and to
 * leave every value as a string so we control numeric coercion ourselves —
 * `parseAttributeValue` would turn `xMin="072"` into `72` inconsistently and
 * drop the leading-zero cases poppler occasionally emits. `<word>` text is the
 * element's `#text`.
 */
const parser = safeXmlParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // A single <word>/<line>/<block> must still be an array so the walk below is
  // uniform whether a page has one element or many.
  isArray: (name) =>
    name === "word" ||
    name === "line" ||
    name === "block" ||
    name === "flow" ||
    name === "page",
});

/** Coerce a possibly-undefined attribute string to a finite number, or null. */
function num(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Clamp a normalised coordinate into `[0,1]`; poppler can round a hair past. */
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** The union of two boxes (min of mins, max of maxes). */
function unionBBox(a: BBox, b: BBox): BBox {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

/** An empty analysis for a given page — the graceful-degradation result. */
function emptyAnalysis(page: number): PageAnalysis {
  return {
    page,
    size: { widthPt: 0, heightPt: 0 },
    blocks: [],
    lines: [],
    words: [],
    headingCandidates: [],
  };
}

/**
 * Parse a `<word>` into a normalised {@link AnalyzedWord}, or `null` when its
 * coordinates are missing/degenerate. `width`/`height` are the page dimensions
 * the coordinates are normalised against.
 */
function parseWord(
  node: unknown,
  width: number,
  height: number,
): AnalyzedWord | null {
  if (typeof node !== "object" || node === null) return null;
  const attrs = node as Record<string, unknown>;
  const xMin = num(attrs["@_xMin"]);
  const yMin = num(attrs["@_yMin"]);
  const xMax = num(attrs["@_xMax"]);
  const yMax = num(attrs["@_yMax"]);
  if (xMin === null || yMin === null || xMax === null || yMax === null)
    return null;

  const raw = attrs["#text"];
  const text = raw === undefined || raw === null ? "" : String(raw);

  const bbox: BBox = [
    clamp01(xMin / width),
    clamp01(yMin / height),
    clamp01(xMax / width),
    clamp01(yMax / height),
  ];
  return { text, bbox };
}

/** The union of a non-empty list of boxes, or `null` for an empty list. */
function unionOf(boxes: readonly BBox[]): BBox | null {
  const first = boxes[0];
  if (first === undefined) return null;
  return boxes.slice(1).reduce<BBox>((acc, box) => unionBBox(acc, box), first);
}

/** Roll up words into a line with a union bbox and a font-size proxy height. */
function buildLine(words: AnalyzedWord[]): AnalyzedLine | null {
  const bbox = unionOf(words.map((w) => w.bbox));
  if (bbox === null) return null;
  const text = words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { words, bbox, text, height: bbox[3] - bbox[1] };
}

/** Roll up lines into a block with a union bbox. */
function buildBlock(lines: AnalyzedLine[]): AnalyzedBlock | null {
  const bbox = unionOf(lines.map((l) => l.bbox));
  if (bbox === null) return null;
  const text = lines.map((l) => l.text).join("\n");
  return { lines, bbox, text };
}

/**
 * Find the `<doc>` element in the parse tree. poppler nests it under
 * `<html><body>`, so a plain top-level lookup misses it; a bounded depth-first
 * walk over object children finds it wherever poppler put it. Returns the first
 * `<doc>` (there is exactly one), or `null`.
 */
function findDoc(node: unknown, depth = 0): unknown {
  if (depth > 8 || typeof node !== "object" || node === null) return null;
  const record = node as Record<string, unknown>;
  const direct = record.doc;
  if (typeof direct === "object" && direct !== null) {
    // `isArray` does not force `doc`, so it may be an array or a single object.
    return Array.isArray(direct) ? (direct[0] ?? null) : direct;
  }
  for (const value of Object.values(record)) {
    if (typeof value !== "object" || value === null) continue;
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      const found = findDoc(child, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Coerce a fast-xml-parser child to an array (it is one, per `isArray`). */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/**
 * Parse one `<page>` node into a {@link PageAnalysis}. `pageNumber` is the
 * caller-facing page number (1-based); pages with an unreadable size or no
 * words still return a well-formed, empty-ish analysis.
 */
function parsePage(node: unknown, pageNumber: number): PageAnalysis {
  if (typeof node !== "object" || node === null)
    return emptyAnalysis(pageNumber);
  const attrs = node as Record<string, unknown>;
  const widthPt = num(attrs["@_width"]) ?? 0;
  const heightPt = num(attrs["@_height"]) ?? 0;

  const analysis = emptyAnalysis(pageNumber);
  analysis.size = { widthPt, heightPt };

  // Without a positive page size the coordinates cannot be normalised; return
  // the size we did read and no geometry rather than dividing by zero.
  if (!(widthPt > 0) || !(heightPt > 0)) return analysis;

  const blocks: AnalyzedBlock[] = [];
  const allLines: AnalyzedLine[] = [];
  const allWords: AnalyzedWord[] = [];

  // <page> → <flow>* → <block>* → <line>* → <word>*
  for (const flow of asArray(attrs.flow)) {
    if (typeof flow !== "object" || flow === null) continue;
    for (const blockNode of asArray((flow as Record<string, unknown>).block)) {
      if (typeof blockNode !== "object" || blockNode === null) continue;
      const lines: AnalyzedLine[] = [];
      for (const lineNode of asArray(
        (blockNode as Record<string, unknown>).line,
      )) {
        if (typeof lineNode !== "object" || lineNode === null) continue;
        const words: AnalyzedWord[] = [];
        for (const wordNode of asArray(
          (lineNode as Record<string, unknown>).word,
        )) {
          const word = parseWord(wordNode, widthPt, heightPt);
          if (word !== null) words.push(word);
        }
        const line = buildLine(words);
        if (line !== null) {
          lines.push(line);
          allLines.push(line);
          allWords.push(...words);
        }
      }
      const block = buildBlock(lines);
      if (block !== null) blocks.push(block);
    }
  }

  analysis.blocks = blocks;
  analysis.lines = allLines;
  analysis.words = allWords;
  analysis.headingCandidates = detectHeadingCandidates(allLines);
  return analysis;
}

/**
 * Flag lines whose text begins with a numbering pattern as heading candidates
 * These are *hints* for the Pass-1 prompt, not a
 * decision — the model still confirms structure — so the bar is deliberately
 * low: a numbered prefix followed by text.
 */
export function detectHeadingCandidates(
  lines: readonly AnalyzedLine[],
): HeadingCandidate[] {
  const candidates: HeadingCandidate[] = [];
  for (const line of lines) {
    const match = HEADING_NUMBERING.exec(line.text);
    if (match !== null && match[1] !== undefined) {
      candidates.push({
        text: line.text,
        numbering: match[1],
        bbox: line.bbox,
        height: line.height,
      });
    }
  }
  return candidates;
}

/**
 * Parse the XHTML string produced by `pdftotext -bbox-layout` into one
 * {@link PageAnalysis} per `<page>`, in document order.
 *
 * Never throws: malformed, truncated or empty XHTML degrades to an empty result
 * (an empty array, or per-page empty analyses) so the deterministic S2 stage can
 * fall through to vision rather than fail the page. A caller that ran
 * `-bbox-layout` over a single page range gets a one-element array.
 *
 * @param xhtml   The raw `pdftotext -bbox-layout` output.
 * @param firstPage  The 1-based number of the first `<page>` in the string, so a
 *   single-page extraction (`-f N -l N`) reports page `N` rather than `1`.
 *   Defaults to 1.
 */
export function parseBboxLayout(xhtml: string, firstPage = 1): PageAnalysis[] {
  if (typeof xhtml !== "string" || xhtml.trim() === "") return [];

  let doc: unknown;
  try {
    doc = parser.parse(xhtml);
  } catch {
    // fast-xml-parser is tolerant, but a truncated document can still throw.
    // A parse failure is a graceful empty analysis, not a page failure.
    return [];
  }

  if (typeof doc !== "object" || doc === null) return [];

  // poppler wraps the geometry in `<html><body><doc>…`, so the `<doc>` element
  // is not at the top level of the parse tree. Find it wherever it sits rather
  // than assuming a fixed depth; a document without a `<doc>` has no geometry.
  const docNode = findDoc(doc);
  if (docNode === null) return [];

  const pageNodes = asArray((docNode as Record<string, unknown>).page);
  return pageNodes.map((node, index) => parsePage(node, firstPage + index));
}

/**
 * Parse the output of a single-page `-bbox-layout` run into one
 * {@link PageAnalysis}. Convenience over {@link parseBboxLayout} for the S2
 * stage, which analyses one page at a time; returns an empty analysis when the
 * string held no `<page>`.
 */
export function parseBboxLayoutPage(xhtml: string, page: number): PageAnalysis {
  const pages = parseBboxLayout(xhtml, page);
  return pages[0] ?? emptyAnalysis(page);
}
