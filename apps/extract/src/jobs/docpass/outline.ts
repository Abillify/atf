// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/docpass/outline.ts
 *
 * The outline stack for the streaming document pass (design §5 S7 step 1,
 * requirement 9.1).
 *
 * ## What it does
 *
 * As pages stream past in order, the document builds up a heading hierarchy:
 * "4 Wareneingang" › "4.2 Anmeldung" › "4.2.1 Maske WE01". Every block on a
 * page is stamped with the `sectionPath` — the chain of heading titles in force
 * where it sits. The path is what lets Search group by section, keep a chunk
 * inside one section, and show a breadcrumb on a hit.
 *
 * ## How a level is decided
 *
 * Two signals, in priority order:
 *
 *  1. **Numbering.** A heading numbered `4.2.1` is unambiguously level 3 — the
 *     dot count IS the depth. When a heading carries numbering, that wins,
 *     because it is the author's own explicit hierarchy (from DOCX styles or the
 *     text itself, design §5 S2/S7).
 *  2. **Line height.** For an unnumbered heading, the relative font size (the
 *     line-height proxy from `-bbox-layout`, design §5 S2) orders it: a bigger
 *     heading is shallower. We map observed heights to levels by remembering the
 *     distinct heading heights seen so far, largest = level 1.
 *
 * ## The stack, and pop/push
 *
 * The outline is a stack of open headings. A new heading at level L:
 *  - **pops** every open heading at level ≥ L (they have ended), then
 *  - **pushes** itself as the new deepest open heading.
 * So `4.2` following `4.1` pops `4.1` (same level) and pushes `4.2`; `4.2.1`
 * following `4.2` pops nothing and pushes; `5` following `4.2.1` pops `4.2.1`
 * and `4.2` and `4` … wait — `4` is level 1 and `5` is level 1, so it pops `4`
 * too, leaving just `5`. The `sectionPath` a block gets is the titles of the
 * currently-open stack.
 *
 * ## State and resume
 *
 * The whole thing is a small, JSON-serialisable value ({@link OutlineState}):
 * the open stack and the height→level memory. It is persisted on `docpass_state`
 * so a resume rebuilds the exact stack rather than re-deriving it from page 1
 * (design §9a.2). Deterministic — no model, no I/O.
 */

import type { HeadingBlock, OutlineNode } from "@atf/extract-contract/v2";

/**
 * Where a heading's level came from, in priority order. Authoritative sources
 * (`hint`, `numbering`) are the author's own answer and are never revisited by
 * the finalize pass (design §5 S7 point 2, requirement 9.6); a `height` level is
 * a provisional guess from the font-size proxy and CAN move once the whole
 * document's height distribution is known.
 */
export type LevelSource = "hint" | "numbering" | "height";

/** One open heading on the stack. */
export interface OpenHeading {
  /** 1-based level. */
  level: number;
  /** The heading's display title (text). */
  title: string;
  /** The numbering prefix when the heading had one, e.g. `4.2.1`. */
  numbering?: string;
  /** Stable section id, `s<page>-<ordinal>`, minted when the heading opened. */
  sectionId: string;
  /** The page the heading opened on. */
  pageStart: number;
  /**
   * The observed line height for an unnumbered heading, or undefined when there
   * was no font-size signal. Kept so the finalize pass (requirement 9.6) can
   * re-rank the height→level mapping once every heading's height is known.
   */
  lineHeight?: number;
  /** Where {@link level} came from — see {@link LevelSource}. */
  levelSource?: LevelSource;
}

/**
 * A finished outline node, closed when a sibling/ancestor heading opened.
 *
 * It carries the contract {@link OutlineNode} fields plus two INTERNAL fields
 * used only by the finalize pass ({@link finalizeOutlineNodes}): the observed
 * `lineHeight` and the `levelSource`. These are not part of the contract; the
 * emitter builds a clean contract record from the corrected nodes.
 */
export interface ClosedOutlineNode extends OutlineNode {
  /** Observed line height for an unnumbered heading (finalize input). */
  lineHeight?: number;
  /** Where the level came from (finalize skips authoritative sources). */
  levelSource?: LevelSource;
}

/** The persisted, JSON-serialisable outline state (design §9a.2). */
export interface OutlineState {
  version: 1;
  /** The currently-open heading stack, outermost first. */
  stack: OpenHeading[];
  /**
   * Distinct heading line-heights seen so far, largest first. The index of a
   * height in this array + 1 is the level an unnumbered heading of that height
   * maps to, so the mapping is stable across the whole document.
   */
  heights: number[];
  /** Monotonic counter for minting section ids. */
  seq: number;
  /** Every closed outline node, in document order (for `document.end`). */
  closed: ClosedOutlineNode[];
}

/** An empty starting state. */
export function emptyOutlineState(): OutlineState {
  return { version: 1, stack: [], heights: [], seq: 0, closed: [] };
}

/** Coerce an unknown persisted value back to a valid {@link OutlineState}. */
export function parseOutlineState(value: unknown): OutlineState {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1
  ) {
    const v = value as Partial<OutlineState>;
    return {
      version: 1,
      stack: Array.isArray(v.stack)
        ? v.stack
            .filter((s): s is OpenHeading => typeof s === "object" && s !== null && typeof (s as OpenHeading).level === "number")
            .map((s) => ({
              level: s.level,
              title: String(s.title ?? ""),
              ...(typeof s.numbering === "string" ? { numbering: s.numbering } : {}),
              sectionId: String(s.sectionId ?? ""),
              pageStart: typeof s.pageStart === "number" ? s.pageStart : 1,
              ...(typeof s.lineHeight === "number" ? { lineHeight: s.lineHeight } : {}),
              ...(isLevelSource(s.levelSource) ? { levelSource: s.levelSource } : {}),
            }))
        : [],
      heights: Array.isArray(v.heights) ? v.heights.filter((h): h is number => typeof h === "number") : [],
      seq: typeof v.seq === "number" ? v.seq : 0,
      closed: Array.isArray(v.closed)
        ? v.closed.filter((c): c is ClosedOutlineNode => typeof c === "object" && c !== null && typeof (c as OutlineNode).sectionId === "string")
        : [],
    };
  }
  return emptyOutlineState();
}

/** Narrow an unknown persisted value to a {@link LevelSource}. */
function isLevelSource(value: unknown): value is LevelSource {
  return value === "hint" || value === "numbering" || value === "height";
}

/**
 * The number of levels a numbering prefix implies: the count of dot-separated
 * groups. `4` → 1, `4.2` → 2, `4.2.1` → 3. Returns `null` for a non-numbering
 * string.
 */
export function numberingLevel(numbering: string | undefined): number | null {
  if (numbering === undefined) return null;
  const trimmed = numbering.trim().replace(/\.$/, "");
  if (trimmed === "" || !/^\d+(?:\.\d+)*$/.test(trimmed)) return null;
  return trimmed.split(".").length;
}

/** The outline builder's per-page surface. */
export interface OutlineStack {
  /**
   * Fold one heading into the stack and return its assigned level and section
   * id. Pops open headings the new one closes, appending them to the closed
   * list, then pushes the new heading. Headings MUST arrive in document order.
   */
  observeHeading(
    heading: Pick<HeadingBlock, "text" | "numbering">,
    page: number,
    lineHeight?: number,
  ): { level: number; sectionId: string; closed: ClosedOutlineNode[] };
  /** The `sectionPath` currently in force: the open stack's titles. */
  currentPath(): string[];
  /** The open stack's section id chain (parallel to {@link currentPath}). */
  currentSectionIds(): string[];
  /** The heading chain for the previous-page context (titles outermost first). */
  headingChain(): string[];
  /** The current serialisable state, to persist on `docpass_state`. */
  snapshot(): OutlineState;
  /**
   * Close every still-open heading (document end) and return the full outline
   * in document order: the closed nodes plus the remaining open ones, each with
   * its final `pageEnd` set to `lastPage`.
   */
  finish(lastPage: number): OutlineNode[];
}

/**
 * Authoritative heading levels keyed by normalised heading text, from a source
 * that declares them (DOCX styles, design §10.3, requirement 10.3). When a
 * heading's text is in this map its level is taken from here, ahead of both the
 * numbering and the line-height signals, because it is the author's own answer.
 */
export type HeadingLevelHints = ReadonlyMap<string, number>;

/** Normalise a heading's text for the hint-map key (case/space-insensitive). */
function headingKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Create an outline stack, optionally rehydrated from persisted state so a
 * resume continues the same hierarchy (design §9a.2). Deterministic.
 *
 * `hints` supplies authoritative heading levels (DOCX styles, requirement
 * 10.3): a heading whose text is in the map uses that level directly, so the
 * outline reflects the document's own hierarchy rather than a font-size guess.
 */
export function createOutlineStack(
  initial: OutlineState = emptyOutlineState(),
  hints: HeadingLevelHints = new Map(),
): OutlineStack {
  const state = parseOutlineState(initial);
  const stack = state.stack.slice();
  const heights = state.heights.slice();
  const closed = state.closed.slice();
  let seq = state.seq;

  /**
   * Map a line height to a level using the remembered distinct heights. A new,
   * larger height becomes a new shallower level; a height between two known
   * ones snaps to the nearest known level. Falls back to one level deeper than
   * the deepest open heading when there is no height signal at all.
   */
  function levelFromHeight(lineHeight: number | undefined): number {
    if (lineHeight === undefined || !(lineHeight > 0)) {
      // No font-size signal: nest one under the current deepest open heading.
      return stack.length === 0 ? 1 : (stack[stack.length - 1]?.level ?? 0) + 1;
    }
    // Register the height (rounded to avoid float noise) into the sorted-desc
    // list of distinct heights.
    const rounded = Math.round(lineHeight * 1000) / 1000;
    if (!heights.some((h) => Math.abs(h - rounded) < 1e-6)) {
      heights.push(rounded);
      heights.sort((a, b) => b - a);
    }
    const idx = heights.findIndex((h) => Math.abs(h - rounded) < 1e-6);
    return idx + 1;
  }

  function observeHeading(
    heading: Pick<HeadingBlock, "text" | "numbering">,
    page: number,
    lineHeight?: number,
  ): { level: number; sectionId: string; closed: ClosedOutlineNode[] } {
    // Authoritative DOCX style level first (requirement 10.3), then the
    // numbering's dot-count, then the font-size proxy.
    const hintLevel = hints.get(headingKey(heading.text));
    const numLevel = numberingLevel(heading.numbering);
    const level = hintLevel ?? numLevel ?? levelFromHeight(lineHeight);
    // Remember WHERE the level came from so the finalize pass (requirement 9.6)
    // only re-ranks the provisional font-size guesses and leaves the author's
    // own hierarchy (DOCX styles, numbering) untouched.
    const levelSource: LevelSource =
      hintLevel !== undefined ? "hint" : numLevel !== null ? "numbering" : "height";

    // Pop every open heading at level >= this one: they have ended here. Each
    // popped heading is a CLOSED section — the "section ended" event the summary
    // hierarchy (task 2.7, requirement 9.5) triggers on. Return them (deepest
    // first, mirroring the pop order) alongside the new section's id/level.
    const closedNow: ClosedOutlineNode[] = [];
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
      const popped = stack.pop();
      if (popped === undefined) break;
      const node: ClosedOutlineNode = {
        sectionId: popped.sectionId,
        level: popped.level,
        ...(popped.numbering !== undefined ? { numbering: popped.numbering } : {}),
        title: popped.title,
        pageStart: popped.pageStart,
        // A closed heading ends on the page before this heading opened, but a
        // heading can open on the same page it ends a sibling; clamp so pageEnd
        // is never before pageStart.
        pageEnd: Math.max(popped.pageStart, page),
        ...(popped.lineHeight !== undefined ? { lineHeight: popped.lineHeight } : {}),
        ...(popped.levelSource !== undefined ? { levelSource: popped.levelSource } : {}),
      };
      closed.push(node);
      closedNow.push(node);
    }

    seq += 1;
    const sectionId = `s${page}-${seq}`;
    const open: OpenHeading = {
      level,
      title: heading.text.replace(/\s+/g, " ").trim(),
      ...(heading.numbering !== undefined ? { numbering: heading.numbering } : {}),
      sectionId,
      pageStart: page,
      ...(levelSource === "height" && lineHeight !== undefined && lineHeight > 0
        ? { lineHeight: Math.round(lineHeight * 1000) / 1000 }
        : {}),
      levelSource,
    };
    stack.push(open);
    return { level, sectionId, closed: closedNow };
  }

  function currentPath(): string[] {
    return stack.map((h) => (h.numbering !== undefined ? `${h.numbering} ${h.title}`.trim() : h.title));
  }

  function currentSectionIds(): string[] {
    return stack.map((h) => h.sectionId);
  }

  function headingChain(): string[] {
    return currentPath();
  }

  function snapshot(): OutlineState {
    return {
      version: 1,
      stack: stack.map((h) => ({ ...h })),
      heights: heights.slice(),
      seq,
      closed: closed.map((c) => ({ ...c })),
    };
  }

  function finish(lastPage: number): OutlineNode[] {
    const all: ClosedOutlineNode[] = closed.map((c) => ({ ...c }));
    for (const open of stack) {
      all.push({
        sectionId: open.sectionId,
        level: open.level,
        ...(open.numbering !== undefined ? { numbering: open.numbering } : {}),
        title: open.title,
        pageStart: open.pageStart,
        pageEnd: Math.max(open.pageStart, lastPage),
        ...(open.lineHeight !== undefined ? { lineHeight: open.lineHeight } : {}),
        ...(open.levelSource !== undefined ? { levelSource: open.levelSource } : {}),
      });
    }
    // Document order: a closed node was appended when it closed, which is after
    // it opened; sort by (pageStart, then the mint order encoded in sectionId)
    // to present the outline top-to-bottom. sectionId is `s<page>-<seq>` and seq
    // is globally monotonic, so a secondary sort on seq restores mint order.
    all.sort((a, b) => {
      if (a.pageStart !== b.pageStart) return a.pageStart - b.pageStart;
      return seqOf(a.sectionId) - seqOf(b.sectionId);
    });
    return all;
  }

  return {
    observeHeading,
    currentPath,
    currentSectionIds,
    headingChain,
    snapshot,
    finish,
  };
}

/** The monotonic seq encoded in a `s<page>-<seq>` section id (for ordering). */
function seqOf(sectionId: string): number {
  const m = /-(\d+)$/.exec(sectionId);
  return m?.[1] !== undefined ? Number(m[1]) : 0;
}

/** The display title of an outline node: "4.2 Anmeldung" or just "Anmeldung". */
function nodeTitle(node: OutlineNode): string {
  return node.numbering !== undefined ? `${node.numbering} ${node.title}`.trim() : node.title;
}

/** A section whose path the finalize pass changed, so Search can reconcile. */
export interface SectionPathChange {
  sectionId: string;
  /** The section path the streaming pass produced (provisional). */
  before: string[];
  /** The corrected section path after re-ranking the height→level mapping. */
  after: string[];
}

/** The result of the finalize pass: the corrected outline and what changed. */
export interface FinalizedOutline {
  /** The outline with corrected heading levels, in document order. */
  outline: OutlineNode[];
  /**
   * Every section whose corrected `sectionPath` differs from its provisional
   * one, keyed by `sectionId`. Search re-embeds exactly the units whose path is
   * in here and leaves the rest untouched (requirement 9.6). Empty when the
   * finalize pass changed nothing.
   */
  changes: SectionPathChange[];
}

/**
 * The finalize pass (design §5 S7 point 2, requirement 9.6): a deterministic,
 * MODEL-FREE correction of the outline metadata once the whole document is
 * known.
 *
 * ## Why a correction is needed at all
 *
 * The streaming pass maps an unnumbered heading's line height to a level from
 * the heights seen SO FAR ({@link createOutlineStack}'s `levelFromHeight`). A
 * height first observed early gets a provisional level from a partial ranking;
 * once a LARGER height turns up later, the earlier heading should have been one
 * level deeper. Its provisional level — and the `sectionPath` of every block
 * under it — is therefore skewed until the full height distribution is in.
 *
 * ## What it does
 *
 * Given the finished outline (in document order, each `height`-sourced node
 * carrying its observed `lineHeight`), it:
 *  1. builds the AUTHORITATIVE height→level ranking from every `height` node's
 *     line height (largest height = shallowest level),
 *  2. reassigns each `height` node's level from that ranking, leaving `hint` and
 *     `numbering` nodes (the author's own hierarchy) exactly as they are,
 *  3. re-derives every node's `sectionPath` by walking the corrected levels as
 *     an ancestor stack,
 *  4. reports each section whose path actually moved.
 *
 * It is a pure function of its input: no model, no I/O, no clock — so a resume
 * that re-runs it produces byte-identical output (requirement 4.7).
 */
export function finalizeOutlineNodes(nodes: readonly OutlineNode[]): FinalizedOutline {
  // Recover the finalize metadata each node carries internally.
  const meta = nodes.map((n) => n as ClosedOutlineNode);

  // 1. The authoritative height ranking across the WHOLE document: the distinct
  //    line heights of every height-sourced heading, largest first. A height's
  //    index + 1 is its final level.
  const heights: number[] = [];
  for (const n of meta) {
    if (n.levelSource === "height" && typeof n.lineHeight === "number" && n.lineHeight > 0) {
      const rounded = Math.round(n.lineHeight * 1000) / 1000;
      if (!heights.some((h) => Math.abs(h - rounded) < 1e-6)) heights.push(rounded);
    }
  }
  heights.sort((a, b) => b - a);

  function finalHeightLevel(lineHeight: number): number {
    const rounded = Math.round(lineHeight * 1000) / 1000;
    const idx = heights.findIndex((h) => Math.abs(h - rounded) < 1e-6);
    return idx >= 0 ? idx + 1 : 1;
  }

  // 2. Reassign levels. Authoritative sources keep their level; a height node
  //    with no usable height keeps its provisional level (nothing to re-rank).
  const corrected: ClosedOutlineNode[] = meta.map((n) => {
    if (n.levelSource === "height" && typeof n.lineHeight === "number" && n.lineHeight > 0) {
      return { ...n, level: finalHeightLevel(n.lineHeight) };
    }
    return { ...n };
  });

  // 3. Re-derive each node's section path by walking the corrected levels as an
  //    ancestor stack (mirrors the streaming pop/push, now over final levels).
  const stack: ClosedOutlineNode[] = [];
  const pathBySection = new Map<string, string[]>();
  for (const node of corrected) {
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= node.level) {
      stack.pop();
    }
    stack.push(node);
    pathBySection.set(node.sectionId, stack.map(nodeTitle));
  }

  // 4. Report the sections whose path moved. The BEFORE path is the provisional
  //    ancestor chain, recomputed the same way over the ORIGINAL levels, so the
  //    comparison is path-vs-path rather than level-vs-level.
  const beforeStack: OutlineNode[] = [];
  const beforeBySection = new Map<string, string[]>();
  for (const node of meta) {
    while (beforeStack.length > 0 && (beforeStack[beforeStack.length - 1]?.level ?? 0) >= node.level) {
      beforeStack.pop();
    }
    beforeStack.push(node);
    beforeBySection.set(node.sectionId, beforeStack.map(nodeTitle));
  }

  const changes: SectionPathChange[] = [];
  for (const node of corrected) {
    const before = beforeBySection.get(node.sectionId) ?? [];
    const after = pathBySection.get(node.sectionId) ?? [];
    if (!pathsEqual(before, after)) {
      changes.push({ sectionId: node.sectionId, before, after });
    }
  }

  // Strip the internal finalize fields so the emitter gets clean contract nodes.
  const outline: OutlineNode[] = corrected.map((n) => ({
    sectionId: n.sectionId,
    level: n.level,
    ...(n.numbering !== undefined ? { numbering: n.numbering } : {}),
    title: n.title,
    pageStart: n.pageStart,
    ...(n.pageEnd !== undefined ? { pageEnd: n.pageEnd } : {}),
  }));

  return { outline, changes };
}

/** Structural equality of two section paths. */
function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
