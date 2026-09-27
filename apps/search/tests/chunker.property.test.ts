// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { getHeadingLevel, chunkDocument } from "../src/chunker.js";

describe("Feature: document-chunking, Property 10: Heading-Parsing Round-Trip", () => {
  /**
   * **Validates: Requirements 8.5**
   *
   * For any valid Markdown heading line (Level 1–6), parsing the line
   * and reconstructing it from the parsed level and text SHALL reproduce
   * the original line.
   */
  it("parsing a heading and reconstructing it yields the original line", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc
          .string({ minLength: 1 })
          .filter(
            (s) =>
              !s.includes("\n") &&
              !s.includes("\r") &&
              // Page markers (`## Seite N` / `## Page N`) are intentionally not
              // headings (defect D6), so exclude that text from the round-trip.
              !/^(?:Seite|Page)\s+\d+\s*$/i.test(s.trim()),
          ),
        (level, text) => {
          // Construct a valid heading line
          const headingLine = "#".repeat(level) + " " + text;

          // Parse the heading level
          const parsedLevel = getHeadingLevel(headingLine);

          // Assert parsed level matches original
          expect(parsedLevel).toBe(level);

          // Reconstruct the heading line from parsed level and text
          const reconstructed = "#".repeat(parsedLevel) + " " + text;

          // Assert round-trip: reconstructed equals original
          expect(reconstructed).toBe(headingLine);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 11: Non-headings are rejected", () => {
  /**
   * **Validates: Requirements 8.3**
   *
   * For any line that starts with one or more `#` characters but is NOT
   * followed by a space, `getHeadingLevel` SHALL return 0 (not recognized
   * as a heading).
   */
  it("lines starting with # but without a following space are not headings", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }).chain((hashCount) =>
          fc
            .string({ minLength: 1 })
            .filter(
              (s) =>
                // The char after the leading '#' run must not be a space, or
                // the line would be a valid heading. Forbidding a leading '#'
                // in the suffix keeps the run length exactly `hashCount`, so
                // the next char is suffix[0] — which we require to be neither a
                // space nor '#'. (Newlines/CR would split the line.)
                !s.startsWith(" ") &&
                !s.startsWith("#") &&
                !s.includes("\n") &&
                !s.includes("\r"),
            )
            .map((suffix) => "#".repeat(hashCount) + suffix),
        ),
        (line) => {
          const level = getHeadingLevel(line);
          expect(level).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 1: Text coverage — no text loss", () => {
  /**
   * **Validates: Requirements 6.1**
   *
   * For any document and for any valid combination of chunkSize (positive integer)
   * and overlapSize (non-negative integer < chunkSize), the union of all chunk contents
   * SHALL contain every character of the original document at least once.
   */
  it("every character of the original text appears in at least one chunk", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10000 }),
        fc
          .integer({ min: 10, max: 1000 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.integer({ min: 0, max: chunkSize - 1 }),
            ),
          ),
        (text, [chunkSize, overlapSize]) => {
          const chunks = chunkDocument(text, chunkSize, overlapSize);

          // Reconstruct which positions are covered by each chunk.
          // Each chunk's start in the original text can be derived:
          //   initial start = chunk.index * chunkSize
          //   adjusted start = initial start - chunk.overlapStart
          const covered = new Uint8Array(text.length);

          for (const chunk of chunks) {
            const initialStart = chunk.index * chunkSize;
            const adjustedStart = initialStart - chunk.overlapStart;

            // Mark all positions covered by this chunk
            for (let j = 0; j < chunk.content.length; j++) {
              const pos = adjustedStart + j;
              if (pos >= 0 && pos < text.length) {
                covered[pos] = 1;
              }
            }
          }

          // Every character position in the original text must be covered
          for (let i = 0; i < text.length; i++) {
            expect(covered[i]).toBe(1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 2: Chunk order matches document order", () => {
  /**
   * **Validates: Requirements 6.2**
   *
   * For any document and for any valid combination of chunkSize (positive integer)
   * and overlapSize (non-negative integer < chunkSize), the start position of
   * chunk[i] SHALL be less than or equal to the start position of chunk[i+1]
   * for all consecutive chunk pairs.
   */
  it("start positions of consecutive chunks are in non-decreasing order", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10000 }),
        fc
          .integer({ min: 10, max: 1000 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.integer({ min: 0, max: chunkSize - 1 }),
            ),
          ),
        (text, [chunkSize, overlapSize]) => {
          const chunks = chunkDocument(text, chunkSize, overlapSize);

          // For consecutive chunks, verify start positions are non-decreasing
          for (let i = 0; i < chunks.length - 1; i++) {
            const startPositionI =
              chunks[i].index * chunkSize - chunks[i].overlapStart;
            const startPositionNext =
              chunks[i + 1].index * chunkSize - chunks[i + 1].overlapStart;

            expect(startPositionI).toBeLessThanOrEqual(startPositionNext);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 3: Determinism of the chunking engine", () => {
  /**
   * **Validates: Requirements 6.3**
   *
   * For any document, chunkSize, and overlapSize, two calls to
   * chunkDocument(text, chunkSize, overlapSize) with identical inputs
   * SHALL produce identical results.
   */
  it("two calls with identical inputs produce identical results", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10000 }),
        fc
          .integer({ min: 10, max: 1000 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.integer({ min: 0, max: chunkSize - 1 }),
            ),
          ),
        (text, [chunkSize, overlapSize]) => {
          const result1 = chunkDocument(text, chunkSize, overlapSize);
          const result2 = chunkDocument(text, chunkSize, overlapSize);

          expect(result1).toEqual(result2);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 4: Chunk metadata consistency", () => {
  /**
   * **Validates: Requirements 5a.1, 5a.2, 5a.3, 5a.4, 5a.5, 6.4, 6.5**
   *
   * For any chunking result with N chunks:
   * - All chunks have `index` in range [0, N-1]
   * - All chunks have `total` = N
   * - The first chunk has `overlapStart` = 0
   * - The last chunk has `overlapEnd` = 0
   * - All `overlapStart` and `overlapEnd` values are non-negative integers
   */
  it("all chunk metadata fields are consistent and valid", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10000 }),
        fc
          .integer({ min: 10, max: 1000 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.integer({ min: 0, max: chunkSize - 1 }),
            ),
          ),
        (text, [chunkSize, overlapSize]) => {
          const chunks = chunkDocument(text, chunkSize, overlapSize);
          const N = chunks.length;

          // Must produce at least one chunk for non-empty text
          expect(N).toBeGreaterThanOrEqual(1);

          for (const chunk of chunks) {
            // All chunks have index in range [0, N-1]
            expect(chunk.index).toBeGreaterThanOrEqual(0);
            expect(chunk.index).toBeLessThanOrEqual(N - 1);

            // All chunks have total = N
            expect(chunk.total).toBe(N);

            // All overlapStart and overlapEnd values are non-negative integers
            expect(chunk.overlapStart).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(chunk.overlapStart)).toBe(true);
            expect(chunk.overlapEnd).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(chunk.overlapEnd)).toBe(true);
          }

          // First chunk has overlapStart = 0
          expect(chunks[0].overlapStart).toBe(0);

          // Last chunk has overlapEnd = 0
          expect(chunks[N - 1].overlapEnd).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 5: Short documents produce exactly one chunk", () => {
  /**
   * **Validates: Requirements 2.2**
   *
   * For any document with length ≤ chunkSize, chunkDocument SHALL return
   * exactly one chunk whose content equals the entire document, with
   * overlapStart = 0 and overlapEnd = 0.
   */
  it("documents shorter than or equal to chunkSize produce exactly one chunk with full content", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 100 })
          .chain((text) =>
            fc.tuple(
              fc.constant(text),
              // chunkSize >= text.length
              fc.integer({ min: text.length, max: text.length + 1000 }),
            ),
          )
          .chain(([text, chunkSize]) =>
            fc.tuple(
              fc.constant(text),
              fc.constant(chunkSize),
              // overlapSize: 0 to chunkSize - 1
              fc.integer({ min: 0, max: chunkSize - 1 }),
            ),
          ),
        ([text, chunkSize, overlapSize]) => {
          const chunks = chunkDocument(text, chunkSize, overlapSize);

          // Exactly one chunk is returned
          expect(chunks.length).toBe(1);

          // The chunk's content equals the entire text
          expect(chunks[0].content).toBe(text);

          // overlapStart = 0
          expect(chunks[0].overlapStart).toBe(0);

          // overlapEnd = 0
          expect(chunks[0].overlapEnd).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 6: Heading-aware extension at the start", () => {
  /**
   * **Validates: Requirements 3.2, 3.3**
   *
   * For any document with at least one Markdown heading in the overlap area
   * before a chunk boundary, the chunk start SHALL be moved to the position
   * of the most important heading (lowest level). When multiple headings share
   * the same lowest level, the last one (closest to the original chunk start)
   * SHALL be chosen.
   */
  it("chunk start is moved to the most important heading in the overlap area", () => {
    fc.assert(
      fc.property(
        // Generate chunkSize and overlapSize with enough room for headings
        fc
          .integer({ min: 50, max: 200 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              // overlapSize must be large enough to contain a heading (at least 10 chars)
              fc.integer({ min: 10, max: chunkSize - 1 }),
            ),
          )
          .chain(([chunkSize, overlapSize]) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.constant(overlapSize),
              // Heading level 1-6
              fc.integer({ min: 1, max: 6 }),
              // Position of heading within the overlap area (offset from start of overlap area)
              // The overlap area is [chunkSize - overlapSize, chunkSize)
              // We need room for the heading line: "# X\n" is at least 4 chars
              fc.integer({ min: 0, max: Math.max(0, overlapSize - 5) }),
            ),
          ),
        ([chunkSize, overlapSize, headingLevel, headingOffset]) => {
          // Build a document where:
          // - First chunkSize characters are padding (no headings)
          // - A heading is placed within the overlap area before the chunk boundary
          //
          // The overlap area for chunk 1 is [chunkSize - overlapSize, chunkSize)
          // We place the heading at position: (chunkSize - overlapSize) + headingOffset

          const headingPosition = chunkSize - overlapSize + headingOffset;
          const headingLine = "#".repeat(headingLevel) + " Heading\n";

          // Ensure the heading fits before chunkSize boundary
          if (headingPosition + headingLine.length > chunkSize) {
            return; // Skip this case - heading doesn't fit in overlap area
          }

          // Build padding before the heading (no newlines that could create heading-like patterns)
          // Use 'a' characters with occasional newlines that don't start with #
          const paddingBefore =
            "a".repeat(headingPosition === 0 ? 0 : headingPosition - 1) +
            (headingPosition > 0 ? "\n" : "");

          // Build padding after the heading to fill up to chunkSize
          const afterHeadingStart = paddingBefore.length + headingLine.length;
          const remainingForFirstChunk = chunkSize - afterHeadingStart;

          if (remainingForFirstChunk < 0) {
            return; // Skip - heading doesn't fit
          }

          const paddingAfterHeading = "b".repeat(remainingForFirstChunk);

          // Add enough text for a second chunk
          const secondChunkText = "c".repeat(chunkSize);

          const document =
            paddingBefore + headingLine + paddingAfterHeading + secondChunkText;

          const chunks = chunkDocument(document, chunkSize, overlapSize);

          // We expect at least 2 chunks
          expect(chunks.length).toBeGreaterThanOrEqual(2);

          // The second chunk (index 1) should have its start moved to the heading position
          const expectedHeadingPos = paddingBefore.length;
          const chunk1 = chunks[1];

          // The chunk's start in the original document:
          // initialStart = 1 * chunkSize
          // adjustedStart = initialStart - overlapStart
          const adjustedStart = 1 * chunkSize - chunk1.overlapStart;

          expect(adjustedStart).toBe(expectedHeadingPos);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("lowest heading level wins among multiple headings in the overlap area", () => {
    fc.assert(
      fc.property(
        // Generate chunkSize large enough to fit multiple headings in overlap
        fc
          .integer({ min: 100, max: 300 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              // overlapSize large enough for two headings
              fc.integer({ min: 40, max: chunkSize - 1 }),
            ),
          )
          .chain(([chunkSize, overlapSize]) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.constant(overlapSize),
              // Two different heading levels (higherLevel has bigger number = less important)
              fc
                .integer({ min: 1, max: 5 })
                .chain((lowerLevel) =>
                  fc.tuple(
                    fc.constant(lowerLevel),
                    fc.integer({ min: lowerLevel + 1, max: 6 }),
                  ),
                ),
            ),
          ),
        ([chunkSize, overlapSize, [lowerLevel, higherLevel]]) => {
          // Place two headings in the overlap area:
          // - First: a less important heading (higher level number)
          // - Second: a more important heading (lower level number)
          // The chunk start should move to the more important heading (lower level)

          const overlapStart = chunkSize - overlapSize;

          // First heading (less important) near the start of overlap area
          const heading1Line = "#".repeat(higherLevel) + " Less Important\n";
          // Second heading (more important) further into the overlap area
          const heading2Line = "#".repeat(lowerLevel) + " More Important\n";

          // Position heading1 at the start of overlap area
          const paddingBeforeH1 =
            "a".repeat(overlapStart === 0 ? 0 : overlapStart - 1) +
            (overlapStart > 0 ? "\n" : "");

          // Some padding between headings
          const paddingBetween = "x".repeat(5) + "\n";

          const afterH1 = paddingBeforeH1.length + heading1Line.length;
          const afterPadding = afterH1 + paddingBetween.length;
          const afterH2 = afterPadding + heading2Line.length;

          // Check if everything fits before chunkSize
          if (afterH2 > chunkSize) {
            return; // Skip - doesn't fit
          }

          // Fill remaining space to reach chunkSize
          const remainingForFirstChunk = chunkSize - afterH2;
          const paddingAfterH2 = "b".repeat(remainingForFirstChunk);

          // Second chunk content
          const secondChunkText = "c".repeat(chunkSize);

          const document =
            paddingBeforeH1 +
            heading1Line +
            paddingBetween +
            heading2Line +
            paddingAfterH2 +
            secondChunkText;

          const chunks = chunkDocument(document, chunkSize, overlapSize);

          expect(chunks.length).toBeGreaterThanOrEqual(2);

          // The second chunk should start at the more important heading (lower level)
          const expectedPos = afterH1 + paddingBetween.length; // position of heading2
          const chunk1 = chunks[1];
          const adjustedStart = 1 * chunkSize - chunk1.overlapStart;

          expect(adjustedStart).toBe(expectedPos);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("last heading of same lowest level wins (closest to chunk start)", () => {
    fc.assert(
      fc.property(
        // Generate chunkSize large enough to fit multiple headings in overlap
        fc
          .integer({ min: 100, max: 300 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              // overlapSize large enough for two headings of same level
              fc.integer({ min: 40, max: chunkSize - 1 }),
            ),
          )
          .chain(([chunkSize, overlapSize]) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.constant(overlapSize),
              // Heading level for both headings
              fc.integer({ min: 1, max: 6 }),
            ),
          ),
        ([chunkSize, overlapSize, headingLevel]) => {
          // Place two headings of the same level in the overlap area.
          // The LAST one (closest to the original chunk start) should win.

          const overlapStart = chunkSize - overlapSize;

          // First heading near the start of overlap area
          const heading1Line = "#".repeat(headingLevel) + " First\n";
          // Second heading further into the overlap area (closer to chunk boundary)
          const heading2Line = "#".repeat(headingLevel) + " Second\n";

          // Position heading1 at the start of overlap area
          const paddingBeforeH1 =
            "a".repeat(overlapStart === 0 ? 0 : overlapStart - 1) +
            (overlapStart > 0 ? "\n" : "");

          // Some padding between headings
          const paddingBetween = "x".repeat(5) + "\n";

          const afterH1 = paddingBeforeH1.length + heading1Line.length;
          const afterPadding = afterH1 + paddingBetween.length;
          const afterH2 = afterPadding + heading2Line.length;

          // Check if everything fits before chunkSize
          if (afterH2 > chunkSize) {
            return; // Skip - doesn't fit
          }

          // Fill remaining space to reach chunkSize
          const remainingForFirstChunk = chunkSize - afterH2;
          const paddingAfterH2 = "b".repeat(remainingForFirstChunk);

          // Second chunk content
          const secondChunkText = "c".repeat(chunkSize);

          const document =
            paddingBeforeH1 +
            heading1Line +
            paddingBetween +
            heading2Line +
            paddingAfterH2 +
            secondChunkText;

          const chunks = chunkDocument(document, chunkSize, overlapSize);

          expect(chunks.length).toBeGreaterThanOrEqual(2);

          // The second chunk should start at the LAST heading (heading2) since
          // both have the same level and heading2 is closest to the original chunk start
          const expectedPos = afterH1 + paddingBetween.length; // position of heading2
          const chunk1 = chunks[1];
          const adjustedStart = 1 * chunkSize - chunk1.overlapStart;

          expect(adjustedStart).toBe(expectedPos);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 7: Heading-aware extension at the end", () => {
  /**
   * **Validates: Requirements 4.2, 4.3**
   *
   * For any document with at least one Markdown heading in the overlap area
   * after a chunk boundary, the chunk end SHALL be moved to the position
   * directly before the most important heading (lowest level). When multiple
   * headings share the same lowest level, the first one (closest to the
   * original chunk end) SHALL be chosen.
   */
  it("chunk end is moved to the position directly before the most important heading in the overlap area", () => {
    fc.assert(
      fc.property(
        // Generate chunkSize and overlapSize with enough room for headings
        fc
          .integer({ min: 50, max: 200 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              // overlapSize must be large enough to contain a heading (at least 10 chars)
              fc.integer({ min: 10, max: chunkSize - 1 }),
            ),
          )
          .chain(([chunkSize, overlapSize]) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.constant(overlapSize),
              // Heading level 1-6
              fc.integer({ min: 1, max: 6 }),
              // Position of heading within the overlap area after chunk end
              // The overlap area is [chunkSize, chunkSize + overlapSize)
              // We need room for the heading line: "# X\n" is at least 4 chars
              fc.integer({ min: 0, max: Math.max(0, overlapSize - 5) }),
            ),
          ),
        ([chunkSize, overlapSize, headingLevel, headingOffset]) => {
          // Build a document where:
          // - First chunkSize characters are padding (no headings)
          // - A heading is placed within the overlap area AFTER the first chunk boundary
          //   (between chunkSize and chunkSize + overlapSize)
          // - More text follows to ensure there's a second chunk

          const headingLine = "#".repeat(headingLevel) + " Heading\n";

          // The heading must start at a newline boundary in the overlap area.
          // We place it at position: chunkSize + headingOffset
          // But it must start at a line beginning, so we ensure a \n before it.

          // Build padding for the first chunk (exactly chunkSize chars, no headings)
          // We need the last char before the overlap area to be \n so the heading
          // is recognized at a line start. But we also need exactly chunkSize chars.
          // Strategy: fill with 'a' chars, place a \n at position (chunkSize + headingOffset - 1)
          // if headingOffset > 0, or at position (chunkSize - 1) if headingOffset == 0.

          // Simpler approach: build padding of (chunkSize + headingOffset) chars
          // ending with \n, then the heading, then more text.
          const totalBeforeHeading = chunkSize + headingOffset;

          // Ensure the heading fits within the overlap area
          if (headingOffset + headingLine.length > overlapSize) {
            return; // Skip - heading doesn't fit in overlap area
          }

          // Build text before heading: all 'a' chars except last char is '\n'
          // (so heading starts at a line beginning)
          let paddingBeforeHeading: string;
          if (totalBeforeHeading === 0) {
            paddingBeforeHeading = "";
          } else if (totalBeforeHeading === 1) {
            paddingBeforeHeading = "\n";
          } else {
            paddingBeforeHeading = "a".repeat(totalBeforeHeading - 1) + "\n";
          }

          // Add enough text after the heading for a second chunk
          const textAfterHeading = "b".repeat(chunkSize);

          const document =
            paddingBeforeHeading + headingLine + textAfterHeading;

          const chunks = chunkDocument(document, chunkSize, overlapSize);

          // We expect at least 2 chunks
          expect(chunks.length).toBeGreaterThanOrEqual(2);

          // The first chunk's end should be moved to the position directly BEFORE the heading.
          // The heading starts at position: paddingBeforeHeading.length
          // So the first chunk should end at paddingBeforeHeading.length (exclusive end).
          const expectedEnd = paddingBeforeHeading.length;

          // The first chunk's content length tells us where it ends:
          // chunk[0] starts at 0 (first chunk, no overlapStart adjustment)
          // chunk[0] end = chunk[0].content.length
          const chunk0End = chunks[0].content.length;

          expect(chunk0End).toBe(expectedEnd);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("lowest heading level wins among multiple headings in the overlap area after chunk end", () => {
    fc.assert(
      fc.property(
        // Generate chunkSize large enough to fit multiple headings in overlap
        fc
          .integer({ min: 100, max: 300 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              // overlapSize large enough for two headings
              fc.integer({ min: 50, max: chunkSize - 1 }),
            ),
          )
          .chain(([chunkSize, overlapSize]) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.constant(overlapSize),
              // Two different heading levels (lowerLevel is more important)
              fc
                .integer({ min: 1, max: 5 })
                .chain((lowerLevel) =>
                  fc.tuple(
                    fc.constant(lowerLevel),
                    fc.integer({ min: lowerLevel + 1, max: 6 }),
                  ),
                ),
            ),
          ),
        ([chunkSize, overlapSize, [lowerLevel, higherLevel]]) => {
          // Place two headings in the overlap area after chunk end:
          // - First: a less important heading (higher level number)
          // - Second: a more important heading (lower level number)
          // The chunk end should move to directly before the more important heading (lower level)

          const heading1Line = "#".repeat(higherLevel) + " Less Important\n";
          const heading2Line = "#".repeat(lowerLevel) + " More Important\n";

          // Check that both headings fit in the overlap area
          const totalHeadingsSize =
            heading1Line.length + heading2Line.length + 6; // +6 for padding between
          if (totalHeadingsSize > overlapSize) {
            return; // Skip - doesn't fit
          }

          // Build padding for first chunk (exactly chunkSize chars, ending with \n)
          const paddingFirstChunk = "a".repeat(chunkSize - 1) + "\n";

          // First heading (less important) right after chunk boundary
          // Then some padding, then second heading (more important)
          const paddingBetween = "x".repeat(5) + "\n";

          // Verify everything fits in overlap area
          const heading1Start = chunkSize; // right after first chunk
          const heading2Start =
            heading1Start + heading1Line.length + paddingBetween.length;
          const heading2End = heading2Start + heading2Line.length;

          if (heading2End - chunkSize > overlapSize) {
            return; // Skip - doesn't fit in overlap area
          }

          // Add text after for second chunk
          const textAfter = "b".repeat(chunkSize);

          const document =
            paddingFirstChunk +
            heading1Line +
            paddingBetween +
            heading2Line +
            textAfter;

          const chunks = chunkDocument(document, chunkSize, overlapSize);

          expect(chunks.length).toBeGreaterThanOrEqual(2);

          // The first chunk's end should be at the position directly before
          // the MORE IMPORTANT heading (lower level = heading2)
          const expectedEnd = heading2Start;
          const chunk0End = chunks[0].content.length;

          expect(chunk0End).toBe(expectedEnd);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("first heading of same lowest level wins (closest to original chunk end)", () => {
    fc.assert(
      fc.property(
        // Generate chunkSize large enough to fit multiple headings in overlap
        fc
          .integer({ min: 100, max: 300 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              // overlapSize large enough for two headings of same level
              fc.integer({ min: 50, max: chunkSize - 1 }),
            ),
          )
          .chain(([chunkSize, overlapSize]) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.constant(overlapSize),
              // Heading level for both headings
              fc.integer({ min: 1, max: 6 }),
            ),
          ),
        ([chunkSize, overlapSize, headingLevel]) => {
          // Place two headings of the same level in the overlap area after chunk end.
          // The FIRST one (closest to the original chunk end) should win.

          const heading1Line = "#".repeat(headingLevel) + " First\n";
          const heading2Line = "#".repeat(headingLevel) + " Second\n";

          // Check that both headings fit in the overlap area
          const totalHeadingsSize =
            heading1Line.length + heading2Line.length + 6; // +6 for padding between
          if (totalHeadingsSize > overlapSize) {
            return; // Skip - doesn't fit
          }

          // Build padding for first chunk (exactly chunkSize chars, ending with \n)
          const paddingFirstChunk = "a".repeat(chunkSize - 1) + "\n";

          // First heading right after chunk boundary, then padding, then second heading
          const paddingBetween = "x".repeat(5) + "\n";

          // Verify everything fits in overlap area
          const heading1Start = chunkSize;
          const heading2Start =
            heading1Start + heading1Line.length + paddingBetween.length;
          const heading2End = heading2Start + heading2Line.length;

          if (heading2End - chunkSize > overlapSize) {
            return; // Skip - doesn't fit in overlap area
          }

          // Add text after for second chunk
          const textAfter = "b".repeat(chunkSize);

          const document =
            paddingFirstChunk +
            heading1Line +
            paddingBetween +
            heading2Line +
            textAfter;

          const chunks = chunkDocument(document, chunkSize, overlapSize);

          expect(chunks.length).toBeGreaterThanOrEqual(2);

          // The first chunk's end should be at the position directly before
          // the FIRST heading (closest to original chunk end)
          const expectedEnd = heading1Start;
          const chunk0End = chunks[0].content.length;

          expect(chunk0End).toBe(expectedEnd);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: document-chunking, Property 8: Without headings, boundaries stay unchanged", () => {
  /**
   * **Validates: Requirements 3.4, 4.4**
   *
   * For any document without Markdown headings, the chunk boundaries SHALL
   * lie exactly at chunkSize multiples (no extension). That is, overlapStart = 0
   * and overlapEnd = 0 for all chunks.
   */
  it("all chunk boundaries remain at exact chunkSize multiples when no headings are present", () => {
    // Generator: random text using characters that are never *boundary*
    // characters for the chunker. The chunker snaps boundaries to headings,
    // paragraph breaks (\n\n), sentence ends (".!?" + whitespace) and word
    // breaks (space/tab). To guarantee no snapping can occur, the alphabet
    // excludes '#' (headings) and all whitespace (space/tab/newline). Without
    // whitespace, ".!?" can never form a sentence boundary either, so the only
    // possible split is the hard cut at chunkSize multiples.
    const noBoundaryAlphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?";

    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(...noBoundaryAlphabet.split("")), {
            minLength: 1,
            maxLength: 10000,
          })
          .map((chars) => chars.join("")),
        fc
          .integer({ min: 10, max: 1000 })
          .chain((chunkSize) =>
            fc.tuple(
              fc.constant(chunkSize),
              fc.integer({ min: 0, max: chunkSize - 1 }),
            ),
          ),
        (text, [chunkSize, overlapSize]) => {
          const chunks = chunkDocument(text, chunkSize, overlapSize);

          // For every chunk, overlapStart and overlapEnd must be 0
          // (no heading-aware extension occurred)
          for (const chunk of chunks) {
            expect(chunk.overlapStart).toBe(0);
            expect(chunk.overlapEnd).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
