// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/docpass/section-content.ts
 *
 * The section-content accumulator for the summary hierarchy (design §5 S7
 * step 5 "Summary-Hierarchie (RAPTOR-light)", §9a.2; task 2.7, requirement
 * 9.5).
 *
 * ## What it accumulates
 *
 * As the streaming document pass folds pages in order, it feeds every block's
 * text to this accumulator, tagged with the section id the block sits in (the
 * deepest open section from the outline stack). It also records each page's
 * Pass-1 `summary`. When a section closes — the outline stack pops it because a
 * sibling/ancestor heading opened — the summary generator asks this accumulator
 * for that section's content: its page summaries plus its own block text,
 * bounded, which is the RAPTOR-light input the text-LLM condenses (summarise
 * summaries, not raw full text, to keep tokens bounded on a 10 000-page doc).
 *
 * A section's content is trimmed once it has been consumed, so the accumulator
 * never grows without bound: only *open* sections' text is held.
 *
 * ## State and resume
 *
 * The whole thing is a small JSON-serialisable value persisted on
 * `docpass_state`, exactly like the outline/identifier/table states, so a
 * resume rehydrates the same accumulation and produces byte-identical summary
 * inputs (requirement 4.7). Deterministic — no model, no I/O.
 */

/** Per-section accumulated content, keyed by section id. */
interface SectionEntry {
  /** The section's own block text, joined in reading order. */
  blocks: string[];
}

/** The persisted, JSON-serialisable accumulator state. */
export interface SectionContentState {
  version: 1;
  /** section id → accumulated content. Only open (unconsumed) sections remain. */
  sections: Record<string, SectionEntry>;
  /** page number → that page's Pass-1 summary, kept for chapter/document rollups. */
  pageSummaries: Record<number, string>;
}

/** An empty starting state. */
export function emptySectionContentState(): SectionContentState {
  return { version: 1, sections: {}, pageSummaries: {} };
}

/** Coerce an unknown persisted value back to a valid {@link SectionContentState}. */
export function parseSectionContentState(value: unknown): SectionContentState {
  if (typeof value !== "object" || value === null) return emptySectionContentState();
  const v = value as Partial<SectionContentState>;
  const sections: Record<string, SectionEntry> = {};
  if (typeof v.sections === "object" && v.sections !== null) {
    for (const [id, entry] of Object.entries(v.sections)) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Partial<SectionEntry>;
      sections[id] = {
        blocks: Array.isArray(e.blocks) ? e.blocks.filter((s): s is string => typeof s === "string") : [],
      };
    }
  }
  const pageSummaries: Record<number, string> = {};
  if (typeof v.pageSummaries === "object" && v.pageSummaries !== null) {
    for (const [page, summary] of Object.entries(v.pageSummaries)) {
      const n = Number(page);
      if (Number.isInteger(n) && typeof summary === "string") pageSummaries[n] = summary;
    }
  }
  return { version: 1, sections, pageSummaries };
}

/** How much text to keep per section, so the summary input stays bounded. */
const MAX_SECTION_CHARS = 8_000;

/** The section-content accumulator's surface. */
export interface SectionContentAccumulator {
  /** Record a page's Pass-1 summary in the global map (kept for all rollups). */
  observePageSummary(page: number, summary: string): void;
  /** Add a block's text to a section's accumulated content. */
  observeBlock(sectionId: string, text: string): void;
  /**
   * The summary-generation input for a section: the Pass-1 summaries of the
   * pages it spans (the RAPTOR-light bottom layer) followed by its own block
   * text, bounded to {@link MAX_SECTION_CHARS}. Empty string when the section
   * has no accumulated content.
   */
  sectionInput(sectionId: string, pageStart: number, pageEnd: number): string;
  /** Drop a section's accumulated content once it has been consumed. */
  release(sectionId: string): void;
  /** The Pass-1 summary of a page, or undefined. */
  pageSummary(page: number): string | undefined;
  /** The serialisable state to persist after a page. */
  snapshot(): SectionContentState;
}

/** Create a section-content accumulator, optionally rehydrated for a resume. */
export function createSectionContentAccumulator(
  initial: SectionContentState = emptySectionContentState(),
): SectionContentAccumulator {
  const state = parseSectionContentState(initial);
  const sections = new Map<string, SectionEntry>(Object.entries(state.sections));
  const pageSummaries = new Map<number, string>(
    Object.entries(state.pageSummaries).map(([p, s]) => [Number(p), s]),
  );

  function entryOf(sectionId: string): SectionEntry {
    let entry = sections.get(sectionId);
    if (entry === undefined) {
      entry = { blocks: [] };
      sections.set(sectionId, entry);
    }
    return entry;
  }

  function observePageSummary(page: number, summary: string): void {
    const trimmed = summary.replace(/\s+/g, " ").trim();
    if (trimmed === "") return;
    pageSummaries.set(page, trimmed);
  }

  function observeBlock(sectionId: string, text: string): void {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed === "") return;
    const entry = entryOf(sectionId);
    entry.blocks.push(trimmed);
  }

  function sectionInput(sectionId: string, pageStart: number, pageEnd: number): string {
    const entry = sections.get(sectionId);
    // The Pass-1 summaries of the section's pages (deduplicated), the
    // RAPTOR-light bottom layer, then the section's own block text. Bound the
    // whole thing so a huge section cannot blow the token budget.
    const seen = new Set<string>();
    const summaryParts: string[] = [];
    for (let page = pageStart; page <= pageEnd; page++) {
      const summary = pageSummaries.get(page);
      if (summary !== undefined && !seen.has(summary)) {
        seen.add(summary);
        summaryParts.push(summary);
      }
    }
    const parts = [...summaryParts, ...(entry?.blocks ?? [])].filter((p) => p.trim() !== "");
    const joined = parts.join("\n\n");
    return joined.length > MAX_SECTION_CHARS ? joined.slice(0, MAX_SECTION_CHARS) : joined;
  }

  function release(sectionId: string): void {
    sections.delete(sectionId);
  }

  function pageSummary(page: number): string | undefined {
    return pageSummaries.get(page);
  }

  function snapshot(): SectionContentState {
    const sectionsObj: Record<string, SectionEntry> = {};
    for (const [id, entry] of sections) {
      sectionsObj[id] = { blocks: entry.blocks.slice() };
    }
    const pageSummariesObj: Record<number, string> = {};
    for (const [page, summary] of pageSummaries) pageSummariesObj[page] = summary;
    return { version: 1, sections: sectionsObj, pageSummaries: pageSummariesObj };
  }

  return {
    observePageSummary,
    observeBlock,
    sectionInput,
    release,
    pageSummary,
    snapshot,
  };
}
