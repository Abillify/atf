// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect } from "vitest";
import { chunkDocument, isMeaningfulChunk } from "../src/chunker.js";

describe("isMeaningfulChunk", () => {
  it.each([
    [".", false],
    ["-- .", false],
    ["V.", false],
    ["-", false],
    ["* * *", false],
    ["—", false],
    ["  \n  ", false],
    ["Hello world", true],
    ["V. Dies ist ein Satz.", true],
    ["42", true],
    ["ab", true],
  ])("isMeaningfulChunk(%j) === %s", (input, expected) => {
    expect(isMeaningfulChunk(input)).toBe(expected);
  });
});

describe("chunkDocument", () => {
  /**
   * Validates: Requirements 2.1, 2.2, 6.1
   */
  describe("empty string", () => {
    it("returns an empty array for an empty string", () => {
      const result = chunkDocument("", 100, 10);
      expect(result).toEqual([]);
    });
  });

  /**
   * Validates: Requirements 2.2
   */
  describe("document exactly = chunkSize", () => {
    it("returns exactly one chunk when document length equals chunkSize", () => {
      const text = "A".repeat(50);
      const result = chunkDocument(text, 50, 10);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(text);
      expect(result[0].index).toBe(0);
      expect(result[0].total).toBe(1);
      expect(result[0].overlapStart).toBe(0);
      expect(result[0].overlapEnd).toBe(0);
    });
  });

  /**
   * Validates: Requirements 2.1, 2.3, 6.1, 6.2, 6.4, 6.5
   */
  describe("document = 2.5 × chunkSize", () => {
    it("produces three chunks for a document 2.5 times chunkSize", () => {
      const chunkSize = 20;
      const text = "x".repeat(50); // 2.5 * 20 = 50
      const result = chunkDocument(text, chunkSize, 0);

      expect(result).toHaveLength(3);

      // First chunk: characters 0–19
      expect(result[0].content).toBe("x".repeat(20));
      expect(result[0].index).toBe(0);
      expect(result[0].total).toBe(3);
      expect(result[0].overlapStart).toBe(0);

      // Second chunk: characters 20–39
      expect(result[1].content).toBe("x".repeat(20));
      expect(result[1].index).toBe(1);
      expect(result[1].total).toBe(3);

      // Third chunk: characters 40–49 (remaining 10 chars)
      expect(result[2].content).toBe("x".repeat(10));
      expect(result[2].index).toBe(2);
      expect(result[2].total).toBe(3);
      expect(result[2].overlapEnd).toBe(0);
    });
  });

  /**
   * Validates: Requirements 3.4, 4.4
   */
  describe("overlap = 0", () => {
    it("produces exact boundaries with no extension when overlap is 0", () => {
      const chunkSize = 10;
      const text = "abcdefghij" + "klmnopqrst" + "uvwxy"; // 25 chars
      const result = chunkDocument(text, chunkSize, 0);

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe("abcdefghij");
      expect(result[0].overlapStart).toBe(0);
      expect(result[0].overlapEnd).toBe(0);

      expect(result[1].content).toBe("klmnopqrst");
      expect(result[1].overlapStart).toBe(0);
      expect(result[1].overlapEnd).toBe(0);

      expect(result[2].content).toBe("uvwxy");
      expect(result[2].overlapStart).toBe(0);
      expect(result[2].overlapEnd).toBe(0);
    });
  });

  /**
   * Validates: Requirements 3.1, 3.2, 4.1, 4.2
   */
  describe("heading exactly at chunk boundary", () => {
    it("extends chunk start backward to a heading in the overlap area", () => {
      // Build a document where a heading sits in the overlap area before chunk boundary
      // chunkSize = 20, overlapSize = 10
      // The heading must start at the beginning of a line (after \n or at position 0)
      // Place a \n at position 13, then "# H\n" at position 14 (line start)
      const part1 = "a".repeat(13); // 13 chars (positions 0–12)
      const newline1 = "\n"; // 1 char (position 13)
      const heading = "# H\n"; // 4 chars (positions 14–17), heading at line start position 14
      const part2 = "bb"; // 2 chars (positions 18–19) → chunk boundary at 20
      const part3 = "c".repeat(20); // 20 chars (positions 20–39)

      const text = part1 + newline1 + heading + part2 + part3;
      // text length = 13 + 1 + 4 + 2 + 20 = 40
      // Initial boundaries: chunk0=[0,20), chunk1=[20,40)
      // Overlap area for chunk1 start: [10, 20) → text[10:20] = "aaa\n# H\nbb"
      // findHeadings splits by \n: lines = ["aaa", "# H", "bb"]
      // "# H" is at position 14 in the document
      // Chunk1 start should be extended back to position 14

      const result = chunkDocument(text, 20, 10);

      expect(result).toHaveLength(2);
      // Chunk 1 should start at the heading position (14)
      expect(result[1].content).toContain("# H");
      expect(result[1].overlapStart).toBe(6); // 20 - 14 = 6
    });

    it("extends chunk end forward to just before a heading in the overlap area", () => {
      // chunkSize = 20, overlapSize = 10
      // Place a heading after chunk 0 end at 20, within overlap area [20, 30)
      // The heading must start at a line beginning
      const part1 = "a".repeat(20); // 20 chars (positions 0–19) → chunk 0 ends at 20
      const part2 = "bbbb\n"; // 5 chars (positions 20–24), newline at 24
      const heading = "# H\n"; // 4 chars (positions 25–28), heading at line start position 25
      const part3 = "c".repeat(20); // 20 chars (positions 29–48)

      const text = part1 + part2 + heading + part3;
      // text length = 20 + 5 + 4 + 20 = 49
      // Initial boundaries: chunk0=[0,20), chunk1=[20,40), chunk2=[40,49)
      // Overlap area for chunk0 end: [20, 30) → text[20:30] = "bbbb\n# H\ncc..."
      // findHeadings splits by \n: lines = ["bbbb", "# H", "cc..."]
      // "# H" is at position 25 in the document
      // Chunk0 end should be extended to position 25 (just before the heading)

      const result = chunkDocument(text, 20, 10);

      // Chunk 0 should end just before the heading
      expect(result[0].overlapEnd).toBe(5); // 25 - 20 = 5
      expect(result[0].content).not.toContain("# H");
    });
  });

  /**
   * Validates: Requirements 3.2, 3.3
   */
  describe("multiple headings of different levels in overlap", () => {
    it("selects the heading with the lowest level (most important)", () => {
      // chunkSize = 30, overlapSize = 20
      // Place headings at different levels in the overlap area before chunk 1 start at 30
      // Overlap area: [10, 30)
      // Headings must be at line starts (after \n)
      const filler1 = "a".repeat(11); // 11 chars (positions 0–10)
      const nl1 = "\n"; // 1 char (position 11)
      const h3 = "### Three\n"; // 10 chars (positions 12–21), level 3 at line start
      const h1 = "# One\n"; // 6 chars (positions 22–27), level 1 at line start
      const filler2 = "xx"; // 2 chars (positions 28–29) → boundary at 30
      const part2 = "b".repeat(30); // 30 chars (positions 30–59)

      const text = filler1 + nl1 + h3 + h1 + filler2 + part2;
      // text length = 11 + 1 + 10 + 6 + 2 + 30 = 60
      // Initial boundaries: chunk0=[0,30), chunk1=[30,60)
      // Overlap area for chunk1 start: [10, 30) (overlapSize=20)
      // text[10:30] = "a\n### Three\n# One\nxx"
      // findHeadings: "### Three" at position 12 (level 3), "# One" at position 22 (level 1)
      // Lowest level = 1, so chunk1 start should extend to position 22

      const result = chunkDocument(text, 30, 20);

      expect(result).toHaveLength(2);
      // Chunk 1 should start at the # One heading (position 22)
      expect(result[1].overlapStart).toBe(8); // 30 - 22 = 8
      expect(result[1].content.startsWith("# One")).toBe(true);
    });

    it("among same-level headings, picks the last one (closest to chunk start)", () => {
      // chunkSize = 30, overlapSize = 25
      // Place two level-2 headings in the overlap area before chunk 1 start at 30
      // Headings must be at line starts (after \n)
      const filler1 = "a".repeat(5); // 5 chars (positions 0–4)
      const nl1 = "\n"; // 1 char (position 5)
      const h2_a = "## A\n"; // 5 chars (positions 6–10), level 2 at line start
      const filler2 = "b".repeat(8); // 8 chars (positions 11–18)
      const nl2 = "\n"; // 1 char (position 19)
      const h2_b = "## B\n"; // 5 chars (positions 20–24), level 2 at line start
      const filler3 = "ccccc"; // 5 chars (positions 25–29) → boundary at 30
      const part2 = "d".repeat(30); // 30 chars (positions 30–59)

      const text =
        filler1 + nl1 + h2_a + filler2 + nl2 + h2_b + filler3 + part2;
      // text length = 5 + 1 + 5 + 8 + 1 + 5 + 5 + 30 = 60
      // Initial boundaries: chunk0=[0,30), chunk1=[30,60)
      // Overlap area for chunk1 start: [5, 30) (overlapSize=25)
      // text[5:30] = "\n## A\nbbbbbbbb\n## B\nccccc"
      // findHeadings splits by \n: ["", "## A", "bbbbbbbb", "## B", "ccccc"]
      // "## A" at position 6, "## B" at position 20
      // Both level 2 → pick the last one (closest to boundary) → position 20

      const result = chunkDocument(text, 30, 25);

      expect(result).toHaveLength(2);
      // Chunk 1 should start at ## B (position 20)
      expect(result[1].overlapStart).toBe(10); // 30 - 20 = 10
      expect(result[1].content.startsWith("## B")).toBe(true);
    });
  });

  /**
   * Validates: Requirements 3.4, 4.4
   */
  describe("heading outside the overlap area", () => {
    it("does not extend when heading is outside the overlap area (before start)", () => {
      // chunkSize = 20, overlapSize = 5
      // Place a heading at position 5, but overlap area for chunk1 is [15, 20)
      // So the heading at position 5 is outside the overlap area
      const heading = "# H\n"; // 4 chars (positions 0–3)
      const filler = "a".repeat(16); // 16 chars (positions 4–19) → boundary at 20
      const part2 = "b".repeat(20); // 20 chars (positions 20–39)

      const text = heading + filler + part2;
      // Overlap area for chunk1 start: [15, 20) (overlapSize=5)
      // Heading at position 0 is outside [15, 20)
      // No extension should happen

      const result = chunkDocument(text, 20, 5);

      expect(result).toHaveLength(2);
      expect(result[1].overlapStart).toBe(0);
      expect(result[1].content).toBe("b".repeat(20));
    });

    it("does not extend when heading is outside the overlap area (after end)", () => {
      // chunkSize = 20, overlapSize = 5
      // Place a heading at position 28, but overlap area for chunk0 end is [20, 25)
      // So the heading at position 28 is outside the overlap area
      const part1 = "a".repeat(20); // 20 chars (positions 0–19) → chunk 0 ends at 20
      const filler = "b".repeat(8); // 8 chars (positions 20–27)
      const heading = "\n# H\n"; // 5 chars, heading at position 29
      const part3 = "c".repeat(7); // 7 chars

      const text = part1 + filler + heading + part3;
      // Overlap area for chunk0 end: [20, 25) (overlapSize=5)
      // Heading at position 29 is outside [20, 25)
      // No extension should happen

      const result = chunkDocument(text, 20, 5);

      expect(result).toHaveLength(2);
      expect(result[0].overlapEnd).toBe(0);
    });
  });
});
