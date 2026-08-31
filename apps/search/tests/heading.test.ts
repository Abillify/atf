// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect } from "vitest";
import { getHeadingLevel, findHeadings } from "../src/chunker.js";

describe("getHeadingLevel", () => {
  /**
   * Validates: Requirements 8.1, 8.2
   */
  it("recognizes a level 1 heading", () => {
    expect(getHeadingLevel("# Heading")).toBe(1);
  });

  it("recognizes a level 2 heading", () => {
    expect(getHeadingLevel("## Sub")).toBe(2);
  });

  it("recognizes a level 6 heading", () => {
    expect(getHeadingLevel("###### Deep")).toBe(6);
  });

  /**
   * Validates: Requirement 8.4
   * More than 6 # characters is not a valid heading.
   */
  it("rejects more than 6 hashes as not a heading", () => {
    expect(getHeadingLevel("####### TooDeep")).toBe(0);
  });

  /**
   * Validates: Requirement 8.3
   * A # without a following space is not a heading.
   */
  it("rejects hashes without a following space", () => {
    expect(getHeadingLevel("#NoSpace")).toBe(0);
  });

  /**
   * Validates: Requirement 8.1
   * A heading must start at the beginning of the line.
   */
  it("rejects a hash that does not start at the beginning of the line", () => {
    expect(getHeadingLevel("Text # not heading")).toBe(0);
  });
});

describe("findHeadings", () => {
  it("finds headings at correct positions with correct levels", () => {
    const text = "# Title\nSome text\n## Section\nMore text";
    const headings = findHeadings(text, 0);

    expect(headings).toEqual([
      { position: 0, level: 1 },
      { position: 18, level: 2 },
    ]);
  });

  it("applies startOffset to calculate absolute positions", () => {
    const text = "# Title\nSome text\n## Section";
    const startOffset = 100;
    const headings = findHeadings(text, startOffset);

    expect(headings).toEqual([
      { position: 100, level: 1 },
      { position: 118, level: 2 },
    ]);
  });

  it("returns empty array when text contains no headings", () => {
    const text = "Just some plain text\nwithout any headings\nat all.";
    const headings = findHeadings(text, 0);

    expect(headings).toEqual([]);
  });
});
