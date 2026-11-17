// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/subdoc-split.ts
 *
 * Sub-document splitting of very large documents (contract 2.5).
 *
 * Motivation
 * ──────────
 * A several-hundred-page specification indexed as ONE document produces one
 * giant `base_ref`: a group-by-document search returns the whole file instead
 * of the chapter that matched, and the document summary covers everything at
 * once. Search's v1 ingest solved this with a text-level chapter splitter;
 * the v2 pipeline has a real document graph (the docpass outline), so the
 * split here works on CHAPTER PAGE RANGES instead of Markdown headings.
 *
 * Semantics (the user-confirmed design): each sub-document is an
 * INDEPENDENT document — its own reference `<parent>/<chapter>`, its own
 * revision, its own group-by-document group. There is no root-document
 * coupling on the Search side; when a split is active the parent reference
 * itself is NOT indexed. Folder-prefix browsing still works because the
 * sub-document references live beneath the parent path.
 *
 * Trigger and shape
 * ─────────────────
 * The caller supplies a chunk BUDGET (`subdocumentMaxChunks`). The document
 * is split only when its estimated chunk count exceeds the budget. Chapters
 * (the outline's top-level nodes) are packed greedily in reading order so no
 * sub-document exceeds the budget; a single chapter that is itself oversized
 * falls back to hard PAGE boundaries (the estimate is per page), mirroring
 * Search's v1 size-fallback. A document without a usable outline splits at
 * page boundaries alone.
 *
 * The estimate uses {@link CHARS_PER_CHUNK}: Search builds units of roughly
 * 350–500 tokens, about 1 600 characters of plain text.
 *
 * The resulting plan is FROZEN into the job config (key `subdocSplit`)
 * before the first revision opens, exactly like `emitBatchPages`: a resume
 * or a new emit generation must re-derive the exact same sub-documents.
 */

import type { OutlineNode } from "@atf/extract-contract";

/** Job-config key under which the split plan is frozen. */
export const SUBDOC_SPLIT_KEY = "subdocSplit";

/** Plain-text characters per Search chunk used for the size estimate. */
export const CHARS_PER_CHUNK = 1600;

/** One sub-document of a split: its reference suffix and page range (inclusive). */
export interface SubdocRange {
  /** Reference-safe suffix appended to the parent reference. */
  suffix: string;
  firstPage: number;
  lastPage: number;
}

/** The frozen split plan of a job. */
export interface SubdocSplitPlan {
  /** The budget the plan was built for (plan validity check on resume). */
  maxChunks: number;
  subdocuments: SubdocRange[];
}

/** Estimate the Search chunk count of `chars` characters of plain text. */
export function estimateChunks(chars: number): number {
  return Math.max(chars > 0 ? 1 : 0, Math.ceil(chars / CHARS_PER_CHUNK));
}

/**
 * Turn an outline title into a reference-safe suffix segment: `/` (the
 * reference separator) becomes `|`, whitespace collapses, length is capped.
 * An empty result falls back to `kapitel`.
 */
export function slugifyChapterTitle(title: string): string {
  const slug = title
    .replace(/\//g, "|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return slug === "" ? "kapitel" : slug;
}

/** Read a frozen plan from a job config; null when absent or malformed. */
export function subdocSplitPlanOf(config: Record<string, unknown>): SubdocSplitPlan | null {
  const raw = config[SUBDOC_SPLIT_KEY];
  if (raw === null || typeof raw !== "object") return null;
  const plan = raw as Partial<SubdocSplitPlan>;
  if (typeof plan.maxChunks !== "number" || !Array.isArray(plan.subdocuments)) return null;
  const subdocuments = plan.subdocuments.filter(
    (s): s is SubdocRange =>
      s !== null &&
      typeof s === "object" &&
      typeof s.suffix === "string" &&
      s.suffix !== "" &&
      Number.isInteger(s.firstPage) &&
      Number.isInteger(s.lastPage) &&
      (s.firstPage as number) >= 1 &&
      (s.lastPage as number) >= (s.firstPage as number),
  );
  if (subdocuments.length < 2) return null;
  return { maxChunks: plan.maxChunks, subdocuments };
}

export interface SubdocSplitOptions {
  /** The finished document outline (may be empty). */
  outline: OutlineNode[];
  /** First and last page of the emitted stream, in source page numbers. */
  firstPage: number;
  lastPage: number;
  /** Chunk budget per sub-document. */
  maxChunks: number;
  /** Plain-text characters per page; pages absent from the map count as 0. */
  charsPerPage: Map<number, number>;
}

/**
 * Plan the split, or return null when the document should stay whole.
 *
 * Null is returned when the whole document fits the budget, when the plan
 * would not actually produce more than one sub-document, or when the page
 * range is degenerate. The ranges are contiguous and cover
 * `[firstPage, lastPage]` exactly: preamble pages before the first chapter
 * join the first sub-document, trailing pages join the last, and gaps
 * between chapters join the preceding one.
 */
export function planSubdocSplit(opts: SubdocSplitOptions): SubdocSplitPlan | null {
  const { firstPage, lastPage, maxChunks } = opts;
  if (lastPage <= firstPage || maxChunks < 1) return null;
  const charsOf = (from: number, to: number): number => {
    let sum = 0;
    for (let p = from; p <= to; p++) sum += opts.charsPerPage.get(p) ?? 0;
    return sum;
  };
  if (estimateChunks(charsOf(firstPage, lastPage)) <= maxChunks) return null;

  const chapters = topLevelChapters(opts.outline, firstPage, lastPage);
  const parts =
    chapters.length === 0
      ? pageBudgetParts(firstPage, lastPage, maxChunks, charsOf).map((r, i) => ({
          suffix: `teil-${i + 1}`,
          firstPage: r.firstPage,
          lastPage: r.lastPage,
        }))
      : chapterParts(firstPage, lastPage, maxChunks, chapters, charsOf);
  if (parts.length < 2) return null;
  return { maxChunks, subdocuments: dedupeSuffixes(parts) };
}

/** A chapter candidate: a top-level outline node clamped to the stream range. */
interface Chapter {
  title: string;
  pageStart: number;
  pageEnd: number;
}

/**
 * The outline's top-level nodes (smallest level present), clamped to the
 * stream range, in page order, overlapping nodes merged into the previous
 * one so the chapter starts stay a strictly increasing partition skeleton.
 */
function topLevelChapters(outline: OutlineNode[], firstPage: number, lastPage: number): Chapter[] {
  const levels = outline.map((n) => n.level);
  if (levels.length === 0) return [];
  const top = Math.min(...levels);
  const chapters: Chapter[] = [];
  for (const node of outline) {
    if (node.level !== top) continue;
    const from = Math.max(node.pageStart, firstPage);
    const to = Math.min(node.pageEnd ?? lastPage, lastPage);
    if (to < from) continue;
    const previous = chapters[chapters.length - 1];
    if (previous !== undefined && from <= previous.pageEnd) {
      // Overlapping or same-page sibling: extend the previous chapter rather
      // than opening a zero-length or negative-range part.
      previous.pageEnd = Math.max(previous.pageEnd, to);
      continue;
    }
    chapters.push({ title: node.title, pageStart: from, pageEnd: to });
  }
  return chapters;
}

/**
 * Cut `[from, to]` into consecutive page windows whose chunk estimate stays
 * within budget. Always makes progress (at least one page per part), so a
 * single very dense page cannot loop.
 */
function pageBudgetParts(
  from: number,
  to: number,
  maxChunks: number,
  charsOf: (from: number, to: number) => number,
): { firstPage: number; lastPage: number }[] {
  const ranges: { firstPage: number; lastPage: number }[] = [];
  let start = from;
  while (start <= to) {
    let end = start;
    while (end + 1 <= to && estimateChunks(charsOf(start, end + 1)) <= maxChunks) end++;
    ranges.push({ firstPage: start, lastPage: end });
    start = end + 1;
  }
  return ranges;
}

/**
 * Pack chapters into sub-documents in reading order. A chapter that exceeds
 * the budget on its own is cut at page boundaries (parts `title`, `title-2`,
 * …). Preamble pages join the first part, trailing pages the last.
 */
function chapterParts(
  firstPage: number,
  lastPage: number,
  maxChunks: number,
  chapters: Chapter[],
  charsOf: (from: number, to: number) => number,
): SubdocRange[] {
  const parts: SubdocRange[] = [];
  const pushPageParts = (from: number, to: number, title: string): void => {
    const pieces = pageBudgetParts(from, to, maxChunks, charsOf);
    pieces.forEach((piece, i) => {
      parts.push({
        suffix: slugifyChapterTitle(title) + (i === 0 ? "" : `-${i + 1}`),
        firstPage: piece.firstPage,
        lastPage: piece.lastPage,
      });
    });
  };

  const first = chapters[0] as Chapter;
  // Preamble: pages before the first chapter join the first part's range;
  // the part keeps the first chapter's title.
  let groupStart = firstPage;
  let groupEnd = Math.min(first.pageStart, lastPage) - 1;
  let groupTitle = first.title;
  let groupChunks = estimateChunks(charsOf(groupStart, groupEnd));

  const flush = (): void => {
    if (groupEnd < groupStart) return;
    pushPageParts(groupStart, groupEnd, groupTitle);
  };

  for (const chapter of chapters) {
    const chapterChunks = estimateChunks(charsOf(chapter.pageStart, chapter.pageEnd));
    // Gap pages between the running group and this chapter belong to the
    // group, so the group always ends right before the next chapter starts.
    const closeGroup = (): void => {
      if (groupEnd < chapter.pageStart - 1) groupEnd = chapter.pageStart - 1;
      flush();
    };
    if (chapterChunks > maxChunks) {
      // Oversized chapter: close the current group, then cut the chapter at
      // page boundaries.
      closeGroup();
      pushPageParts(chapter.pageStart, chapter.pageEnd, chapter.title);
      groupStart = chapter.pageEnd + 1;
      groupEnd = groupStart - 1;
      groupChunks = 0;
      groupTitle = chapter.title;
      continue;
    }
    if (groupEnd >= groupStart && groupChunks + chapterChunks > maxChunks) {
      closeGroup();
      groupStart = chapter.pageStart;
      groupChunks = 0;
      groupTitle = chapter.title;
    }
    if (groupEnd < groupStart) {
      groupStart = chapter.pageStart;
      groupTitle = chapter.title;
      groupChunks = 0;
    }
    // Gap pages between the group and this chapter join the group.
    groupEnd = chapter.pageEnd;
    groupChunks += chapterChunks;
  }
  // Trailing pages after the last chapter join the last group.
  if (groupEnd >= groupStart) {
    groupEnd = lastPage;
    flush();
  } else if (groupStart <= lastPage) {
    pushPageParts(groupStart, lastPage, groupTitle);
  }
  return parts;
}

/** Make every suffix unique by appending `-2`, `-3`, … to repeats. */
function dedupeSuffixes(parts: SubdocRange[]): SubdocRange[] {
  const used = new Set<string>();
  return parts.map((part) => {
    let suffix = part.suffix;
    // The counter must keep going past suffixes a later part already uses
    // verbatim (e.g. an oversized chapter's own `title-2` piece).
    for (let n = 2; used.has(suffix); n++) suffix = `${part.suffix}-${n}`;
    used.add(suffix);
    return suffix === part.suffix ? part : { ...part, suffix };
  });
}
