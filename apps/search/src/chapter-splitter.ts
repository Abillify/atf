// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * chapter-splitter.ts
 *
 * Optional top-level splitting of very large documents into "chapters" that
 * are treated as independent sub-documents at ingest time.
 *
 * Motivation
 * ──────────
 * A several-thousand-page specification ingested as a single document produces
 * one giant `base_ref`. A "group by document" search then returns the whole
 * assembled document instead of the one relevant chapter, and a document summary
 * covers the entire file rather than the topic that actually matched.
 *
 * This module splits such a document into chapters *before* chunking. Each
 * chapter becomes its own sub-document by appending a readable suffix to the
 * document reference, e.g.
 *
 *   handbook/volume-1/manual.pdf
 *     → handbook/volume-1/manual.pdf/1. Introduction
 *     → handbook/volume-1/manual.pdf/2. Installation
 *
 * and, when a single chapter is itself too large, recursively at the next
 * heading level:
 *
 *     → handbook/volume-1/manual.pdf/1. Introduction/1. Scope
 *
 * No database schema change is required: the chapter identity lives entirely
 * in `base_ref`, so grouping, path-prefix filtering, deletion by prefix, and
 * per-document summaries all keep working unchanged — they simply operate at
 * chapter granularity.
 *
 * Trigger
 * ───────
 * Splitting is driven by an estimated chunk count. A node is split only when
 * it would produce MORE than `maxChunks` text chunks. Splitting is attempted
 * at heading level 1 first; any resulting section that is still too large is
 * split again at level 2, then 3, and so on up to `maxLevel` (6). A node with
 * no usable heading boundary at a level is left intact and re-evaluated at the
 * next deeper level — we prefer keeping a chapter whole over cutting it at an
 * unnatural (non-heading) boundary.
 */

import { chunkDocument, getHeadingLevel } from "./chunker.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChapterPart {
  /**
   * Suffix appended to the document reference to form the chapter's own
   * `base_ref`. `null` means the document was not split — the caller should
   * use the original reference and content unchanged.
   */
  refSuffix: string | null;
  /** The chapter's text (includes its own heading line for context). */
  content: string;
  /** Inclusive/exclusive span in the original unsplit document. */
  charStart: number;
  charEnd: number;
}

export interface ChapterSplitOptions {
  /**
   * Split a node only when it would produce strictly MORE than this many
   * chunks. Must be a positive integer.
   */
  maxChunks: number;
  /** Chunk size used to estimate the chunk count (same as ingest chunkSize). */
  chunkSize: number;
  /** Chunk overlap used to estimate the chunk count (same as ingest overlap). */
  overlapSize: number;
  /** Deepest heading level to split at (1–6). Default: 6. */
  maxLevel?: number;
  /**
   * When an oversized node has NO usable heading boundary at any level (typical
   * for PDF-extracted text, which carries no Markdown headings), split it into
   * pieces of ~maxChunks chunks instead of leaving it whole. The cut points are
   * chosen structure-aware via recursive character splitting — preferring the
   * strongest available boundary (page breaks / multiple blank lines, then
   * paragraphs, lines, sentences, words) over an arbitrary offset. Headings
   * always take priority; this only applies as a last resort. Default: false.
   */
  sizeFallback?: boolean;
}

/** One section produced by cutting a text at a single heading level. */
interface RawSection {
  /** The heading line that opens the section, or null for a leading preamble. */
  headingText: string | null;
  /** Section text, including the opening heading line when present. */
  content: string;
}

/** A numbered path segment used to build the chapter ref suffix. */
interface PathSegment {
  /** 1-based heading index within its level; 0 for a leading preamble. */
  index: number;
  /** Normalized heading title, or null for a preamble. */
  title: string | null;
}

// ─── Title normalization ──────────────────────────────────────────────────────

/**
 * Turn a raw Markdown heading line into a reference-safe chapter title.
 *
 * - Strips the leading `#` markers and surrounding whitespace.
 * - Replaces `/` with `|` so the title never introduces spurious path segments
 *   in `base_ref` (which uses `/` as its structural separator and is matched
 *   with LIKE patterns by the X-Path-Prefix filter).
 */
export function normalizeChapterTitle(headingLine: string): string {
  return headingLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/\//g, "|")
    .trim();
}

// ─── Heading-level splitting ──────────────────────────────────────────────────

/**
 * Split `content` at every Markdown heading whose level equals `level`.
 *
 * The text before the first matching heading (if any non-empty) is returned as
 * a leading preamble section with `headingText === null`. Each heading opens a
 * new section whose content includes the heading line itself (lossless).
 *
 * Returns a single section covering the whole input when no heading at `level`
 * is present.
 */
export function splitByHeadingLevel(
  content: string,
  level: number,
): RawSection[] {
  const lines = content.split("\n");
  const sections: RawSection[] = [];

  let currentHeading: string | null = null;
  let buffer: string[] = [];
  let started = false;

  const flush = () => {
    sections.push({ headingText: currentHeading, content: buffer.join("\n") });
  };

  for (const line of lines) {
    if (getHeadingLevel(line) === level) {
      if (started) flush();
      currentHeading = line;
      buffer = [line];
      started = true;
    } else {
      buffer.push(line);
      started = true;
    }
  }
  if (started) flush();

  return sections;
}

// ─── Ref suffix formatting ─────────────────────────────────────────────────────

function segmentToString(seg: PathSegment): string {
  if (seg.title && seg.title.length > 0) return `${seg.index}. ${seg.title}`;
  // Preamble, size-fallback part, or a heading that normalized to empty: number.
  return `${seg.index}`;
}

/**
 * Separator hierarchy for structure-aware size splitting, strongest first.
 *
 * This mirrors the well-established "recursive character text splitting"
 * approach (popularised by LangChain's RecursiveCharacterTextSplitter): cut at
 * the strongest boundary that keeps pieces under the size budget, and only fall
 * back to weaker boundaries for fragments that are still too large.
 *
 * The ordering encodes the user-visible intuition that MORE consecutive
 * newlines mark a stronger section break in extracted text (form feeds and
 * multi-blank-line gaps first, then paragraphs, lines, sentences, words, and
 * finally a hard character cut).
 */
const SIZE_SEPARATORS: readonly string[] = [
  "\f", // form feed — often a page break in extracted PDFs
  "\n\n\n",
  "\n\n",
  "\n",
  ". ",
  " ",
  "", // hard cut (last resort)
];

/** Split on `sep` but keep the separator attached to each fragment (lossless). */
function splitKeepSeparator(text: string, sep: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf(sep, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    out.push(text.slice(i, idx + sep.length));
    i = idx + sep.length;
  }
  return out;
}

/** Fixed-width slices — the hard-cut fallback when no separator remains. */
function hardSlice(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Recursively split `text` into pieces no larger than `maxChars`, cutting at
 * the strongest available boundary and greedily merging adjacent fragments back
 * together so pieces stay as large as the budget allows.
 *
 * Losslessness: separators are kept attached to their fragment and merging only
 * ever concatenates, so joining all returned pieces reproduces `text` exactly.
 */
function splitTextBySize(
  text: string,
  maxChars: number,
  separators: readonly string[] = SIZE_SEPARATORS,
): string[] {
  if (text.length <= maxChars) return [text];

  // Choose the strongest separator that actually occurs in the text.
  let sepIndex = separators.findIndex((s) => s !== "" && text.includes(s));
  if (sepIndex === -1) sepIndex = separators.length - 1; // "" → hard cut
  const sep = separators[sepIndex]!;
  const rest = separators.slice(sepIndex + 1);

  const fragments =
    sep === "" ? hardSlice(text, maxChars) : splitKeepSeparator(text, sep);

  const pieces: string[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer) {
      pieces.push(buffer);
      buffer = "";
    }
  };

  for (const frag of fragments) {
    if (frag.length > maxChars) {
      // Fragment still too big → recurse with weaker separators.
      flush();
      const sub =
        rest.length > 0
          ? splitTextBySize(frag, maxChars, rest)
          : hardSlice(frag, maxChars);
      pieces.push(...sub);
    } else if (buffer.length + frag.length <= maxChars) {
      buffer += frag;
    } else {
      flush();
      buffer = frag;
    }
  }
  flush();
  return pieces;
}

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Split a document into chapter parts.
 *
 * Returns a single part with `refSuffix === null` when the document is small
 * enough (≤ maxChunks) or has no usable heading structure — signalling "do not
 * split, index as-is".
 */
export function splitDocumentIntoChapters(
  content: string,
  opts: ChapterSplitOptions,
): ChapterPart[] {
  const maxLevel = opts.maxLevel ?? 6;
  const result: ChapterPart[] = [];

  const countChunks = (text: string): number =>
    chunkDocument(text, opts.chunkSize, opts.overlapSize).length;

  const emit = (text: string, path: PathSegment[]): void => {
    if (path.length === 0) {
      result.push({ refSuffix: null, content: text, charStart: 0, charEnd: 0 });
      return;
    }
    result.push({ refSuffix: path.map(segmentToString).join("/"), content: text, charStart: 0, charEnd: 0 });
  };

  // Character budget per size-fallback piece, chosen so a full piece yields
  // about `maxChunks` chunks. Uses the chunker's effective step (chunkSize −
  // overlap) so the estimate stays accurate when overlap is large; this errs
  // slightly on the small side, keeping summary inputs safely bounded.
  const step = Math.max(1, opts.chunkSize - opts.overlapSize);
  const maxCharsPerPart = Math.max(opts.chunkSize, opts.maxChunks * step);

  const emitSizeParts = (text: string, path: PathSegment[]): void => {
    const pieces = splitTextBySize(text, maxCharsPerPart);
    if (pieces.length < 2) {
      emit(text, path);
      return;
    }
    pieces.forEach((piece, i) => {
      emit(piece, [...path, { index: i + 1, title: null }]);
    });
  };

  const recurse = (text: string, path: PathSegment[], level: number): void => {
    // Small enough → keep as one part.
    if (countChunks(text) <= opts.maxChunks) {
      emit(text, path);
      return;
    }

    // Oversized but no deeper heading level available. Split by size as a last
    // resort (opt-in), otherwise keep the node whole.
    if (level > maxLevel) {
      if (opts.sizeFallback) emitSizeParts(text, path);
      else emit(text, path);
      return;
    }

    const sections = splitByHeadingLevel(text, level);

    // Fewer than 2 sections means there is no usable boundary at this level
    // (0 headings, or a single heading with no preamble). Prefer keeping the
    // node whole: retry at the next deeper level rather than cutting oddly.
    if (sections.length < 2) {
      recurse(text, path, level + 1);
      return;
    }

    let headingIndex = 0;
    for (const sec of sections) {
      let seg: PathSegment;
      if (sec.headingText === null) {
        // Leading preamble — skip when it carries no real text.
        if (sec.content.trim() === "") continue;
        seg = { index: 0, title: null };
      } else {
        headingIndex += 1;
        seg = { index: headingIndex, title: normalizeChapterTitle(sec.headingText) };
      }
      recurse(sec.content, [...path, seg], level + 1);
    }
  };

  recurse(content, [], 1);

  // Defensive: recursion always emits at least once, but guarantee a result.
  if (result.length === 0) {
    return [{ refSuffix: null, content, charStart: 0, charEnd: content.length }];
  }
  // Parts are emitted in document order and splitting is lossless. Resolve each
  // occurrence after the previous one so repeated chapter text remains deterministic.
  let cursor = 0;
  return result.map((part) => {
    const start = content.indexOf(part.content, cursor);
    if (start < 0) throw new Error("Chapter split lost original source coordinates");
    cursor = start + part.content.length;
    return { ...part, charStart: start, charEnd: cursor };
  });
}
