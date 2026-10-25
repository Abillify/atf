// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pipeline/text-fast-path.ts
 *
 * The deterministic text fast-path ("Text-Fast-Path").
 *
 * ## Why this exists
 *
 * A vision call is by far the most expensive thing the pipeline does — one to
 * four minutes per page. For a text-heavy Pflichtenheft most pages are plain
 * body text: numbered headings, paragraphs, the odd bullet list. poppler's
 * `-bbox-layout` already gives us all of that verbatim, with coordinates
 * (see {@link ../pipeline/bbox-layout.ts}). So a `text` page with no table or
 * figure candidates does not need the model at all: its blocks can be built
 * straight from the S2 geometry, deterministically, at zero token cost. Design
 * estimates this saves 40–70 % of vision time on text-heavy documents.
 *
 * This module is the *pure* core of that: a per-page eligibility gate
 * ({@link fastPathEligibility}) and a deterministic block builder
 * ({@link buildTextFastPathBlocks}). Neither touches poppler, sharp, a model or
 * the database — they are pure functions of a {@link PageAnalysis} (plus the
 * classifier's signals), so they are unit-tested against synthetic analyses.
 * The job runner wires them into the `vision1` stage: when a page qualifies it
 * builds the blocks here and skips {@link ../vision/client.VisionClient.analyzePage}.
 *
 * ## The gate is the control
 *
 * The fidelity check stays active on the fast path — but because the blocks are
 * the text layer verbatim, comparing them against themselves is trivially
 * perfect. The *useful* role of the gate is to DECIDE eligibility and trigger a
 * fallback to vision on anomaly. A page qualifies only when ALL of:
 *
 *   (a) the fast path is enabled,
 *   (b) the page classified as `text`,
 *   (c) there are NO table or figure candidates on the page,
 *   (d) the S2 geometry is present and usable (real blocks/lines/words with a
 *       positive page size), and
 *   (e) the ink OUTSIDE the text blocks is at or below the configured ceiling —
 *       more ink than that means content the text layer does not capture (a
 *       diagram, a stamp, a scanned overlay), so the page must go through
 *       vision.
 *
 * On ANY doubt the page falls back to vision. A false fast-path — a page that
 * silently drops its non-text content — is far worse than a missed one, so the
 * gate is deliberately conservative. The decision is per-page: a fast-path page
 * and a vision page coexist happily in one document.
 *
 * ## Table / figure candidates from S2
 *
 * S2 surfaces heading candidates but not table/figure candidates. Rather than
 * invent a detector, this derives a conservative signal from what S2 and the
 * classifier already know: the ink-outside-blocks ratio. Body text has ink only
 * inside its text blocks (ratio ≈ 0); a table drawn with ruled lines, or a
 * figure, puts ink where there is no text block, which the ratio catches. So
 * "no table/figure candidates" is expressed as "ink-outside-blocks at or below
 * the ceiling" — the same signal, read conservatively. When the classifier had
 * no ink signal at all (no rendered image), the page does NOT qualify: without
 * that evidence we cannot rule out hidden non-text content, so vision handles
 * it. This is documented as a heuristic; a dedicated table/figure detector can
 * refine it later without changing the gate's contract.
 */

import type { Block } from "@atf/extract-contract/v2";
import type {
  AnalyzedBlock,
  AnalyzedLine,
  HeadingCandidate,
  PageAnalysis,
} from "./bbox-layout.js";
import type { Classification } from "../jobs/page-classifier.js";
import { checkTextFidelity, type TextFidelityResult } from "./text-fidelity.js";

/** The inputs the eligibility gate needs, all already computed by S2. */
export interface FastPathGateInput {
  /** Is the fast path enabled at all (TEXT_FAST_PATH)? */
  enabled: boolean;
  /** The deterministic page classification. */
  classification: Classification;
  /** The S2 geometry for the page. */
  analysis: PageAnalysis;
  /** The ink-outside-blocks ceiling (TEXT_FAST_PATH_MAX_INK_RATIO). */
  maxInkRatio: number;
}

/** Why a page did or did not take the fast path — carried into logs/metrics. */
export type FastPathDecision =
  | { eligible: true }
  | {
      eligible: false;
      /** A short machine reason for the fall-back to vision. */
      reason:
        | "disabled"
        | "not-text"
        | "no-geometry"
        | "ink-outside-blocks"
        | "no-ink-signal";
    };

/**
 * Decide whether a page takes the deterministic text fast-path. Pure and
 * conservative: any doubt returns `eligible: false` with a reason, and the
 * caller runs the normal vision path for that page.
 */
export function fastPathEligibility(input: FastPathGateInput): FastPathDecision {
  const { enabled, classification, analysis, maxInkRatio } = input;

  if (!enabled) return { eligible: false, reason: "disabled" };

  // (b) Only a confidently-text page qualifies. `scan`/`drawing`/`mixed` all
  // carry non-text content the text layer cannot represent.
  if (classification.class !== "text") return { eligible: false, reason: "not-text" };

  // (d) Usable geometry: a positive page size and at least one text block with
  // words. Without it there is nothing deterministic to build blocks from — a
  // page with an empty analysis (no `-bbox-layout`, a scan) must use vision.
  const hasGeometry =
    analysis.size.widthPt > 0 &&
    analysis.size.heightPt > 0 &&
    analysis.blocks.length > 0 &&
    analysis.words.length > 0;
  if (!hasGeometry) return { eligible: false, reason: "no-geometry" };

  // (c)+(e) Table/figure-candidate signal, derived conservatively from the
  // ink-outside-blocks ratio. With no ink signal at all we cannot rule out
  // hidden non-text content, so the page does NOT qualify (vision handles it).
  const ink = classification.inkRatioOutsideBlocks;
  if (ink === null) return { eligible: false, reason: "no-ink-signal" };
  if (ink > maxInkRatio) return { eligible: false, reason: "ink-outside-blocks" };

  return { eligible: true };
}

/** A bullet or numbered list marker at the start of a line. */
const LIST_MARKER = /^\s*(?:[-•·*–]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s+/;
/** A numbered-heading prefix, matching S2's heading-candidate grammar. */
const HEADING_NUMBERING = /^(\d+(?:\.\d+)*)\s+\S/;

/** The heading title after its numbering prefix (`4.2 Anmeldung` → `Anmeldung`). */
function stripNumbering(text: string, numbering: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(numbering)) return trimmed;
  const rest = trimmed.slice(numbering.length).replace(/^\.?\s+/, "").trim();
  return rest === "" ? trimmed : rest;
}

/** Strip a leading list marker from a line, leaving the item text. */
function stripListMarker(text: string): string {
  return text.replace(LIST_MARKER, "").trim();
}

/** The heading level implied by a numbering prefix: `2` → 1, `2.1` → 2, … */
function headingLevel(numbering: string): number {
  const depth = numbering.split(".").filter((p) => p !== "").length;
  // Clamp into the contract's 1..9 range.
  return Math.min(9, Math.max(1, depth));
}

/** Is this analyzed line a heading candidate (starts with a numbering prefix)? */
function headingFor(
  line: AnalyzedLine,
  candidates: readonly HeadingCandidate[],
): HeadingCandidate | null {
  // Prefer a candidate S2 already surfaced for this exact line text, so the
  // numbering and bbox match S2's own detection.
  for (const c of candidates) {
    if (c.text === line.text) return c;
  }
  // Fall back to matching the numbering grammar directly, for a line S2's
  // per-page candidate list did not include (it lists them, we also honour any
  // line that fits the same shape).
  const match = HEADING_NUMBERING.exec(line.text);
  if (match !== null && match[1] !== undefined) {
    return { text: line.text, numbering: match[1], bbox: line.bbox, height: line.height };
  }
  return null;
}

/**
 * Build deterministic v2 blocks for a page straight from its S2 geometry
 * (Text-Fast-Path). Every block carries `source: "text-layer"`,
 * the page number and its normalised bbox; `sectionPath` is left for the
 * document pass to fill.
 *
 * Mapping, per analyzed block:
 *   - a block whose single line is a numbered heading → a `heading` block with
 *     the numbering and the implied level;
 *   - a block whose lines all start with a list marker (and there is more than
 *     one such line) → a `list` block, ordered when the markers are numeric;
 *   - otherwise → a `paragraph` block carrying the block's text verbatim.
 *
 * The text is the poppler text layer verbatim, so it is authoritative for
 * wording — which is exactly what makes the fidelity check pass and the whole
 * fast path safe.
 */
export function buildTextFastPathBlocks(analysis: PageAnalysis, page: number): Block[] {
  const blocks: Block[] = [];
  let ordinal = 0;

  for (const analyzed of analysis.blocks) {
    ordinal += 1;
    const id = `p${page}-b${ordinal}`;
    const built = blockFor(analyzed, analysis.headingCandidates, page, id);
    if (built !== null) blocks.push(built);
  }

  return blocks;
}

/** Map one analyzed block to a heading, list or paragraph block, or null. */
function blockFor(
  analyzed: AnalyzedBlock,
  headingCandidates: readonly HeadingCandidate[],
  page: number,
  id: string,
): Block | null {
  const text = analyzed.text.trim();
  if (text === "") return null;

  // ── heading: a single-line block that is a numbered heading ──────────────
  if (analyzed.lines.length === 1) {
    const line = analyzed.lines[0];
    if (line !== undefined) {
      const heading = headingFor(line, headingCandidates);
      if (heading !== null) {
        return {
          id,
          page,
          type: "heading",
          source: "text-layer",
          bbox: analyzed.bbox,
          level: headingLevel(heading.numbering),
          numbering: heading.numbering,
          // The contract keeps the numbering in its own field; the text is the
          // title after it (so a section path reads `4.2 Anmeldung`, not
          // `4.2 4.2 Anmeldung`).
          text: stripNumbering(heading.text, heading.numbering),
        };
      }
    }
  }

  // ── list: every line starts with a marker and there is more than one ─────
  if (analyzed.lines.length > 1) {
    const marked = analyzed.lines.filter((l) => LIST_MARKER.test(l.text));
    if (marked.length === analyzed.lines.length) {
      const items = analyzed.lines.map((l) => stripListMarker(l.text)).filter((t) => t !== "");
      if (items.length > 0) {
        // Ordered when the markers are numeric (1. 2. …), else a bullet list.
        const ordered = analyzed.lines.every((l) => /^\s*\(?\d{1,3}[.)]/.test(l.text));
        return {
          id,
          page,
          type: "list",
          source: "text-layer",
          bbox: analyzed.bbox,
          ...(ordered ? { ordered: true } : {}),
          items,
        };
      }
    }
  }

  // ── paragraph: the block's text verbatim ─────────────────────────────────
  return {
    id,
    page,
    type: "paragraph",
    source: "text-layer",
    bbox: analyzed.bbox,
    text,
  };
}

/**
 * Render the fast-path blocks back to the plain text the fidelity check
 * compares against the text layer. This is intentionally minimal: heading and
 * paragraph text, and list items one per line. Because the blocks were built
 * from the text layer verbatim, this reproduces (a superset of) the risky
 * tokens the text layer carried, so {@link checkTextFidelity} passes — which is
 * the point of keeping the check wired on the fast path.
 */
export function fastPathMarkdown(blocks: readonly Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        parts.push(block.numbering !== undefined ? `${block.numbering} ${block.text}` : block.text);
        break;
      case "paragraph":
      case "footnote":
      case "code":
        parts.push(block.text);
        break;
      case "list":
        parts.push(block.items.join("\n"));
        break;
      default:
        // Fast-path pages never carry table/figure blocks (the gate excludes
        // them); ignore any other type defensively.
        break;
    }
  }
  return parts.join("\n\n");
}

/**
 * Run the text-fidelity check for a fast-path page: compare
 * the raw text layer against the rendered markdown of the deterministic blocks.
 * Kept as a named helper so the runner records exactly the same fidelity metric
 * it records for a vision page, and the "check stays active" requirement is
 * satisfied by a real call, not a comment.
 */
export function checkFastPathFidelity(rawText: string, blocks: readonly Block[]): TextFidelityResult {
  return checkTextFidelity(rawText, fastPathMarkdown(blocks));
}

/**
 * The share of the text layer's words the fast-path blocks must reproduce.
 * The blocks come from the same poppler text layer as the
 * raw text, so anything below this means the geometry lost content (text
 * outside every block, a dropped run) and the page must go through vision.
 */
export const FAST_PATH_MIN_TOKEN_COVERAGE = 0.98;

/** The result of {@link checkFastPathCoverage}. */
export interface FastPathCoverage {
  /** Words (occurrences) in the raw text layer. */
  totalTokens: number;
  /** Of those, how many appear in the blocks. */
  coveredTokens: number;
  /** `coveredTokens / totalTokens`; 1 for an empty text layer. */
  ratio: number;
  /** True when the ratio reaches {@link FAST_PATH_MIN_TOKEN_COVERAGE}. */
  complete: boolean;
}

/** Normalise a word for the coverage comparison: case- and punctuation-blind. */
function coverageToken(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function coverageTokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map(coverageToken)
    .filter((t) => t !== "");
}

/**
 * Check that the fast-path blocks cover the raw text layer word for word.
 * The risky-token fidelity check only looks at numbers and
 * identifiers; this complements it with plain-word coverage, so a page whose
 * geometry silently dropped a sentence cannot take the fast path.
 */
export function checkFastPathCoverage(
  rawText: string,
  blocks: readonly Block[],
  minCoverage: number = FAST_PATH_MIN_TOKEN_COVERAGE,
): FastPathCoverage {
  const raw = coverageTokens(rawText);
  if (raw.length === 0) return { totalTokens: 0, coveredTokens: 0, ratio: 1, complete: true };
  const present = new Set(coverageTokens(fastPathMarkdown(blocks)));
  let covered = 0;
  for (const token of raw) if (present.has(token)) covered += 1;
  const ratio = covered / raw.length;
  return { totalTokens: raw.length, coveredTokens: covered, ratio, complete: ratio >= minCoverage };
}

/** Horizontal gap (normalised page width) that separates table columns. */
const COLUMN_GAP = 0.04;
/** Lines with ≥2 column gaps needed before a page counts as tabular. */
const MIN_TABULAR_LINES = 3;
/** A caption that announces a figure or table: `Abbildung 3`, `Tab. 2`, … */
const FIGURE_CAPTION = /^\s*(?:abbildung|abb\.|bild|grafik|figure|fig\.|diagramm)\s*\d+/imu;
const TABLE_CAPTION = /^\s*(?:tabelle|tab\.|table)\s*\d+/imu;

/** Table/figure candidates the fast path must not swallow. */
export interface FastPathCandidates {
  /** Column-aligned lines or a table caption: a table vision must structure. */
  table: boolean;
  /** A figure caption: an image/diagram the text layer cannot represent. */
  figure: boolean;
}

/**
 * Detect table and figure candidates on a would-be fast-path page ("no
 * table/figure candidates"). The ink-outside-blocks gate catches raster/vector
 * graphics; this catches what it cannot:
 *
 *   - a *text* table (a table whose cells are real text, so its ink lies inside
 *     the text blocks): several lines whose words are separated by wide
 *     column gaps, or a `Tabelle n` caption;
 *   - a figure announced by its caption (`Abbildung n`), whose graphic may be
 *     too faint for the ink gate.
 *
 * Deliberately conservative — a false positive only costs a vision call.
 */
export function detectFastPathCandidates(analysis: PageAnalysis, rawText: string): FastPathCandidates {
  let tabularLines = 0;
  for (const line of analysis.lines) {
    let gaps = 0;
    for (let i = 1; i < line.words.length; i++) {
      const prev = line.words[i - 1];
      const word = line.words[i];
      if (prev === undefined || word === undefined) continue;
      if (word.bbox[0] - prev.bbox[2] > COLUMN_GAP) gaps += 1;
    }
    if (gaps >= 2) tabularLines += 1;
  }
  return {
    table: tabularLines >= MIN_TABULAR_LINES || TABLE_CAPTION.test(rawText),
    figure: FIGURE_CAPTION.test(rawText),
  };
}
