// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/src/chunker.ts

/**
 * Represents a detected Markdown heading within a text.
 */
export interface HeadingMatch {
  /** Absolute position in the original document (start of line). */
  position: number;
  /** Heading level (1–6). */
  level: number;
}

/**
 * Matches a page marker line (`## Seite N` / `## Page N`) on its own line.
 *
 * Page markers look like level-2 Markdown headings but are pagination
 * furniture, not document structure. They must not act as chunk boundaries or
 * compete with real headings (defect D6). Ingest strips them from the body
 * before chunking; this guard keeps the chunker correct even if a marker slips
 * through (e.g. a caller that chunks a raw body directly).
 */
const PAGE_MARKER_LINE = /^#{1,6}\s+(?:Seite|Page)\s+\d+\s*$/i;

/**
 * Determines the heading level of a line (0 if not a heading).
 *
 * A Markdown heading is a line that starts with 1–6 `#` characters
 * followed by at least one space. Page markers (`## Seite N` / `## Page N`)
 * are explicitly not headings: they are pagination furniture and must not
 * serve as a heading boundary (defect D6).
 *
 * @param line - The line to check.
 * @returns Heading level (1–6) or 0.
 */
export function getHeadingLevel(line: string): number {
  if (PAGE_MARKER_LINE.test(line)) {
    return 0;
  }
  const match = line.match(/^(#{1,6}) /);
  if (!match) {
    return 0;
  }
  return match[1].length;
}

/**
 * Finds all Markdown headings in a text range.
 * A heading is a line that starts with one or more '#' followed by a space.
 *
 * @param text        - The text to search.
 * @param startOffset - Absolute start position in the original document.
 * @returns Array of HeadingMatch objects.
 */
export function findHeadings(
  text: string,
  startOffset: number,
): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const lines = text.split("\n");
  let currentPosition = 0;

  for (const line of lines) {
    const level = getHeadingLevel(line);
    if (level > 0) {
      headings.push({
        position: startOffset + currentPosition,
        level,
      });
    }
    // +1 for the newline character
    currentPosition += line.length + 1;
  }

  return headings;
}

/**
 * Boundary types in priority order (lower number = higher priority).
 */
const enum BoundaryPriority {
  Heading = 0,
  Paragraph = 1, // \n\n
  Sentence = 2, // ". " / "! " / "? "
  Word = 3, // space or tab
  None = 4, // hard cut (fallback)
}

interface Boundary {
  position: number;
  priority: BoundaryPriority;
  /** Heading level (1–6) if priority === Heading, else 0. */
  headingLevel: number;
}

/**
 * Finds the best split boundary within a text window.
 *
 * Scans the window for boundaries in priority order:
 *   1. Markdown heading (lowest level = most important)
 *   2. Paragraph break (\n\n)
 *   3. Sentence end (". " / "! " / "? ")
 *   4. Word boundary (space / tab)
 *
 * When searching *backwards* (for chunk start extension), returns the
 * boundary closest to `referencePos` (i.e. the last/rightmost one found).
 * When searching *forwards* (for chunk end extension), returns the
 * boundary closest to `referencePos` (i.e. the first/leftmost one found).
 *
 * @param text        - Full document text.
 * @param windowStart - Start of the search window (inclusive, absolute).
 * @param windowEnd   - End of the search window (exclusive, absolute).
 * @param direction   - "backward" = looking before a chunk start,
 *                      "forward"  = looking after a chunk end.
 */
function findBestBoundary(
  text: string,
  windowStart: number,
  windowEnd: number,
  direction: "backward" | "forward",
): Boundary | null {
  if (windowStart >= windowEnd) return null;

  const window = text.slice(windowStart, windowEnd);

  // Collect all candidate boundaries within the window.
  const candidates: Boundary[] = [];

  // --- Headings ---
  const lines = window.split("\n");
  let linePos = 0;
  for (const line of lines) {
    const level = getHeadingLevel(line);
    if (level > 0) {
      candidates.push({
        position: windowStart + linePos,
        priority: BoundaryPriority.Heading,
        headingLevel: level,
      });
    }
    linePos += line.length + 1;
  }

  // --- Paragraph breaks (\n\n) ---
  let searchFrom = 0;
  while (true) {
    const idx = window.indexOf("\n\n", searchFrom);
    if (idx === -1) break;
    // Position is right after the double newline (start of next paragraph).
    candidates.push({
      position: windowStart + idx + 2,
      priority: BoundaryPriority.Paragraph,
      headingLevel: 0,
    });
    searchFrom = idx + 1;
  }

  // --- Sentence boundaries ---
  searchFrom = 0;
  while (true) {
    const dotIdx = findNextSentenceBoundary(window, searchFrom);
    if (dotIdx === -1) break;
    // Position is right after the punctuation+space (start of next sentence).
    candidates.push({
      position: windowStart + dotIdx + 2,
      priority: BoundaryPriority.Sentence,
      headingLevel: 0,
    });
    searchFrom = dotIdx + 1;
  }

  // --- Word boundaries (space / tab) ---
  searchFrom = 0;
  while (true) {
    const idx = findNextWordBoundary(window, searchFrom);
    if (idx === -1) break;
    // Position is right after the space (start of next word).
    candidates.push({
      position: windowStart + idx + 1,
      priority: BoundaryPriority.Word,
      headingLevel: 0,
    });
    searchFrom = idx + 1;
  }

  if (candidates.length === 0) return null;

  // Select the best candidate:
  // 1. Highest priority (lowest BoundaryPriority number).
  // 2. Among same priority: headings → lowest heading level (most important).
  // 3. Among same priority+level: direction determines which one to pick:
  //    - backward: rightmost (closest to original chunk start)
  //    - forward:  leftmost  (closest to original chunk end)

  let bestPriority = BoundaryPriority.None;
  for (const c of candidates) {
    if (c.priority < bestPriority) bestPriority = c.priority;
  }

  let filtered = candidates.filter((c) => c.priority === bestPriority);

  // For headings: prefer the most important (lowest level).
  if (bestPriority === BoundaryPriority.Heading) {
    const lowestLevel = Math.min(...filtered.map((c) => c.headingLevel));
    filtered = filtered.filter((c) => c.headingLevel === lowestLevel);
  }

  // Direction-based selection.
  if (direction === "backward") {
    // Rightmost = last in array (highest position).
    return filtered.reduce((best, c) =>
      c.position > best.position ? c : best,
    );
  } else {
    // Leftmost = first in array (lowest position).
    return filtered.reduce((best, c) =>
      c.position < best.position ? c : best,
    );
  }
}

function findNextSentenceBoundary(text: string, from: number): number {
  for (let i = from; i < text.length - 1; i++) {
    const ch = text[i];
    if ((ch === "." || ch === "!" || ch === "?") && /\s/.test(text[i + 1])) {
      return i;
    }
  }
  return -1;
}

function findNextWordBoundary(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === " " || text[i] === "\t") {
      return i;
    }
  }
  return -1;
}

/**
 * Returns true if a chunk contains enough meaningful text to be worth indexing.
 *
 * A chunk is considered meaningless when, after stripping whitespace, it
 * consists only of punctuation, single-character tokens (e.g. "V."), or
 * short decoration sequences (e.g. ".", "--.", "- -").  Concretely, the
 * cleaned text must contain at least one "word" — a run of two or more
 * alphanumeric characters — to be considered meaningful.
 *
 * Examples that are filtered out:
 *   "."   "-- ."   "V."   "-"   "* * *"   "—"
 *
 * @param content - The chunk text to evaluate.
 * @returns true if the chunk is meaningful, false if it should be dropped.
 */
export function isMeaningfulChunk(content: string): boolean {
  // \w{2,} matches any run of ≥2 word characters (letters, digits, _).
  // This accepts all natural-language words while rejecting lone punctuation,
  // single-letter abbreviations ("V."), and decoration-only strings.
  return /\w{2,}/.test(content);
}

/**
 * Represents a single chunk with its content and position information.
 */
export interface Chunk {
  /** Text content of the chunk. */
  content: string;
  /** Zero-based index of the chunk. */
  index: number;
  /** Total number of chunks. */
  total: number;
  /** Characters by which the start was extended backwards (0 for first chunk). */
  overlapStart: number;
  /** Characters by which the end was extended forwards (0 for last chunk). */
  overlapEnd: number;
  /** Inclusive start in the exact input text passed to this chunker. */
  charStart: number;
  /** Exclusive end in the exact input text passed to this chunker. */
  charEnd: number;
}

/**
 * Splits a document into overlapping, boundary-aware chunks.
 *
 * Algorithm:
 * 1. Initial split at exact chunkSize character boundaries.
 * 2. Boundary-aware adjustment at the start (for all chunks except the first):
 *    Searches the overlap area before the chunk boundary for the best boundary.
 *    Priority: Heading (most important first) > Paragraph > Sentence > Word.
 * 3. Boundary-aware adjustment at the end (for all chunks except the last):
 *    Searches the overlap area after the chunk boundary for the best boundary.
 *    Priority: Heading (most important first) > Paragraph > Sentence > Word.
 *
 * When overlapSize = 0, no adjustments are made (hard cut).
 *
 * @param text       - The complete document text.
 * @param chunkSize  - Target chunk size in characters (positive integer).
 * @param overlapSize - Maximum overlap size in characters (non-negative, < chunkSize).
 * @returns Array of chunks in document order.
 */
export function chunkDocument(
  text: string,
  chunkSize: number,
  overlapSize: number,
): Chunk[] {
  // Empty string → empty array.
  if (text.length === 0) {
    return [];
  }

  // Document ≤ chunkSize → exactly one chunk with entire content.
  if (text.length <= chunkSize) {
    return [
      {
        content: text,
        index: 0,
        total: 1,
        overlapStart: 0,
        overlapEnd: 0,
        charStart: 0,
        charEnd: text.length,
      },
    ];
  }

  // Step 1: Initial split at exact chunkSize character boundaries.
  const numChunks = Math.ceil(text.length / chunkSize);
  const initialBoundaries: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min((i + 1) * chunkSize, text.length);
    initialBoundaries.push({ start, end });
  }

  // Steps 2 & 3: Boundary-aware adjustment.
  const adjustedBoundaries: Array<{
    start: number;
    end: number;
    overlapStart: number;
    overlapEnd: number;
  }> = [];

  for (let i = 0; i < initialBoundaries.length; i++) {
    let { start, end } = initialBoundaries[i];
    let overlapStart = 0;
    let overlapEnd = 0;

    // Step 2: Boundary-aware extension at beginning (for all chunks except first).
    if (i > 0 && overlapSize > 0) {
      const windowStart = Math.max(0, start - overlapSize);
      const windowEnd = start;
      const boundary = findBestBoundary(
        text,
        windowStart,
        windowEnd,
        "backward",
      );
      if (boundary !== null) {
        overlapStart = start - boundary.position;
        start = boundary.position;
      }
    }

    // Step 3: Boundary-aware extension at end (for all chunks except last).
    if (i < initialBoundaries.length - 1 && overlapSize > 0) {
      const windowStart = end;
      const windowEnd = Math.min(text.length, end + overlapSize);
      const boundary = findBestBoundary(
        text,
        windowStart,
        windowEnd,
        "forward",
      );
      if (boundary !== null) {
        overlapEnd = boundary.position - end;
        end = boundary.position;
      }
    }

    adjustedBoundaries.push({ start, end, overlapStart, overlapEnd });
  }

  // Build chunks from adjusted boundaries.
  //
  // NOTE: chunkDocument is intentionally *lossless* — it never drops chunks and
  // keeps `index` aligned with document order (Requirement 6.1: "Kein
  // Textverlust"). Filtering out low-value ("meaningless") chunks is an
  // indexing-layer concern and is applied by the ingest job builders via
  // isMeaningfulChunk, so that the chunking contract stays a pure, reversible
  // split of the input.
  const total = adjustedBoundaries.length;
  return adjustedBoundaries.map((boundary, i) => ({
    content: text.slice(boundary.start, boundary.end),
    index: i,
    total,
    overlapStart: boundary.overlapStart,
    overlapEnd: boundary.overlapEnd,
    charStart: boundary.start,
    charEnd: boundary.end,
  }));
}
