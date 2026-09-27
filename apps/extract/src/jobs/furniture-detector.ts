// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/furniture-detector.ts
 *
 * Recurring header/footer ("furniture") detection over a rolling window of
 * pages (design §5 S2; task 2.2, requirements 7.3 and D10).
 *
 * ## Why this exists, and why it *keeps* the furniture
 *
 * A running header ("Pflichtenheft WMS · Kapitel 3"), a page footer ("Seite 12
 * von 340") or a plan's title block (drawing number, revision, sheet) repeats
 * at the same place on many pages. The v1 pipeline had no notion of this, and
 * the design (defect D10) calls out the real failure mode: naive extractors
 * *discard* such repeating lines as boilerplate — and on an engineering plan
 * that throws away the drawing number, revision and sheet, which are exactly
 * the identifiers a search needs. So this detector's job is not to strip
 * furniture but to *recognise and record* it: the recurring line is emitted as
 * `furniture` on the page record (a `header`, `footer` or `pageLabel`) rather
 * than dropped.
 *
 * ## How recurrence is decided (rolling window)
 *
 * A line is "the same" across pages when its **normalised text** sits at the
 * **same vertical band** on the page. We keep a small rolling window of the
 * most recent pages' candidate lines (the top band and the bottom band of each
 * page). A candidate that has appeared at the same band on at least
 * {@link RollingWindowConfig.minRepeats} of the last
 * {@link RollingWindowConfig.windowSize} pages is furniture. This tolerates the
 * usual variation — a page number changes every page, so the *digits* are
 * normalised away (`Seite 12 von 340` → `seite N von N`), letting the stable
 * template match while the volatile number does not defeat it.
 *
 * ## State lives in docpass_state
 *
 * The window is per-document streaming state: page N's decision depends on the
 * pages before it. Design §9a.2 requires that state to be persisted after each
 * page so a resume restores it rather than re-deriving it. {@link FurnitureState}
 * is therefore a plain JSON-serialisable value: {@link createFurnitureDetector}
 * rehydrates from it and {@link FurnitureDetector.snapshot} produces the value
 * to persist alongside the rest of the document-pass state. The window is
 * bounded (only the last `windowSize` pages), so the state does not grow with
 * the page count.
 *
 * Everything here is deterministic — no model, no I/O.
 */

import type { AnalyzedLine, PageAnalysis } from "../pipeline/bbox-layout.js";
import type { Furniture } from "@atf/extract-contract/v2";

/** Tunables for the rolling window. */
export interface RollingWindowConfig {
  /** How many recent pages to remember. */
  windowSize: number;
  /** Minimum recurrences (including the current page) to call a line furniture. */
  minRepeats: number;
  /**
   * The fraction of page height treated as the header band (from the top) and,
   * symmetrically, the footer band (from the bottom). A line whose box centre
   * falls in a band is a candidate for that band.
   */
  bandFraction: number;
}

/** Defaults: a line recurring on ≥3 of the last 8 pages, in the top/bottom 12%. */
export const DEFAULT_WINDOW: RollingWindowConfig = {
  windowSize: 8,
  minRepeats: 3,
  bandFraction: 0.12,
};

/** Which band a candidate line sits in. */
type Band = "header" | "footer";

/** One remembered page: the normalised header/footer templates it presented. */
interface WindowEntry {
  page: number;
  header: string | null;
  footer: string | null;
}

/**
 * The persisted, JSON-serialisable rolling-window state (design §9a.2). Held on
 * `docpass_state` so a resume restores the window. `version` guards against a
 * future shape change; an unrecognised version rehydrates to an empty window
 * (which only costs a few pages of re-warming, never correctness).
 */
export interface FurnitureState {
  version: 1;
  window: WindowEntry[];
}

/** An empty starting state. */
export function emptyFurnitureState(): FurnitureState {
  return { version: 1, window: [] };
}

/** Coerce an unknown persisted value back to a valid {@link FurnitureState}. */
export function parseFurnitureState(value: unknown): FurnitureState {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { window?: unknown }).window)
  ) {
    const window = (value as { window: unknown[] }).window
      .filter(
        (e): e is WindowEntry =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as WindowEntry).page === "number",
      )
      .map((e) => ({
        page: e.page,
        header: typeof e.header === "string" ? e.header : null,
        footer: typeof e.footer === "string" ? e.footer : null,
      }));
    return { version: 1, window };
  }
  return emptyFurnitureState();
}

/**
 * Normalise a line's text so a running header/footer matches across pages while
 * the volatile page number does not defeat the match:
 *
 *   - lower-cased and whitespace-collapsed,
 *   - every run of digits replaced by `N` (`Seite 12 von 340` → `seite n von n`),
 *   - surrounding punctuation trimmed.
 *
 * Returns `null` for a line too short to be meaningful furniture (a stray glyph)
 * so it is never treated as a recurring template.
 */
export function normalizeFurnitureText(text: string): string | null {
  const normalized = text
    .toLowerCase()
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .trim();
  return normalized.length >= 2 ? normalized : null;
}

/**
 * Pick the top-band and bottom-band candidate lines of a page. The header is
 * the topmost line whose box centre is within `bandFraction` of the top; the
 * footer the bottom-most line within `bandFraction` of the bottom. Returns the
 * *normalised* template text for each band, or `null` when the band is empty.
 */
function bandTemplates(
  analysis: PageAnalysis,
  bandFraction: number,
): { header: string | null; footer: string | null } {
  let headerLine: AnalyzedLine | null = null;
  let footerLine: AnalyzedLine | null = null;
  let headerY = Number.POSITIVE_INFINITY;
  let footerY = Number.NEGATIVE_INFINITY;

  for (const line of analysis.lines) {
    const centreY = (line.bbox[1] + line.bbox[3]) / 2;
    if (centreY <= bandFraction && centreY < headerY) {
      headerY = centreY;
      headerLine = line;
    }
    if (centreY >= 1 - bandFraction && centreY > footerY) {
      footerY = centreY;
      footerLine = line;
    }
  }

  return {
    header: headerLine !== null ? normalizeFurnitureText(headerLine.text) : null,
    footer: footerLine !== null ? normalizeFurnitureText(footerLine.text) : null,
  };
}

/** The verbatim (un-normalised) band lines, kept for the emitted furniture. */
function bandVerbatim(
  analysis: PageAnalysis,
  bandFraction: number,
): { header: string | null; footer: string | null } {
  let headerLine: AnalyzedLine | null = null;
  let footerLine: AnalyzedLine | null = null;
  let headerY = Number.POSITIVE_INFINITY;
  let footerY = Number.NEGATIVE_INFINITY;

  for (const line of analysis.lines) {
    const centreY = (line.bbox[1] + line.bbox[3]) / 2;
    if (centreY <= bandFraction && centreY < headerY) {
      headerY = centreY;
      headerLine = line;
    }
    if (centreY >= 1 - bandFraction && centreY > footerY) {
      footerY = centreY;
      footerLine = line;
    }
  }
  return {
    header: headerLine !== null ? headerLine.text.trim() : null,
    footer: footerLine !== null ? footerLine.text.trim() : null,
  };
}

/** A page-number-like footer ("Seite 12", "12 / 340") → the `pageLabel` slot. */
const PAGE_LABEL_TEMPLATE = /^(seite|page|blatt|s\.?)\b|^n( von N| ?\/ ?N| of N)?$|^-? ?N ?-?$/;

/** The furniture detector's per-page surface. */
export interface FurnitureDetector {
  /**
   * Fold one page into the window and return the furniture recognised on it.
   * A line at the top or bottom band that has recurred at that band on at least
   * `minRepeats` of the recent pages is furniture; a one-off line is not.
   * Pages MUST be fed in ascending page order (the streaming document pass owns
   * that order, design §9a.2).
   */
  observe(analysis: PageAnalysis): Furniture | null;
  /** The current window state, to persist on `docpass_state`. */
  snapshot(): FurnitureState;
}

/**
 * Create a furniture detector, optionally rehydrated from persisted state so a
 * resume continues the same window (design §9a.2). Deterministic.
 */
export function createFurnitureDetector(
  initial: FurnitureState = emptyFurnitureState(),
  config: RollingWindowConfig = DEFAULT_WINDOW,
): FurnitureDetector {
  // Copy so the caller's persisted value is never mutated in place.
  const window: WindowEntry[] = parseFurnitureState(initial).window.slice(
    -config.windowSize,
  );

  /** How often `template` appears in `band` across the remembered window. */
  function countIn(band: Band, template: string): number {
    let count = 0;
    for (const entry of window) {
      if (entry[band] === template) count += 1;
    }
    return count;
  }

  function observe(analysis: PageAnalysis): Furniture | null {
    const templates = bandTemplates(analysis, config.bandFraction);
    const verbatim = bandVerbatim(analysis, config.bandFraction);

    // Count recurrence *including* the current page (append first, then judge),
    // so `minRepeats` is the total number of pages the line appears on.
    const entry: WindowEntry = {
      page: analysis.page,
      header: templates.header,
      footer: templates.footer,
    };
    window.push(entry);
    while (window.length > config.windowSize) window.shift();

    const furniture: Furniture = {};

    if (
      templates.header !== null &&
      verbatim.header !== null &&
      countIn("header", templates.header) >= config.minRepeats
    ) {
      furniture.header = verbatim.header;
    }

    if (
      templates.footer !== null &&
      verbatim.footer !== null &&
      countIn("footer", templates.footer) >= config.minRepeats
    ) {
      // A footer that reads like a page number is recorded as the pageLabel
      // slot (design §5 S2: page label kept as furniture) as well as the footer,
      // so a consumer that wants the label does not have to re-parse the footer.
      if (PAGE_LABEL_TEMPLATE.test(templates.footer)) {
        furniture.pageLabel = verbatim.footer;
      } else {
        furniture.footer = verbatim.footer;
      }
    }

    return furniture.header !== undefined ||
      furniture.footer !== undefined ||
      furniture.pageLabel !== undefined
      ? furniture
      : null;
  }

  function snapshot(): FurnitureState {
    return { version: 1, window: window.slice() };
  }

  return { observe, snapshot };
}
