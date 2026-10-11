// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 13: include/exclude semantics
 *
 * **Validates: Requirements 1.9, 6.11**
 *
 * For every path `p` and arbitrary include/exclude lists:
 * `isIncluded(p, include, exclude)` is `true` exactly when no
 * exclude pattern matches AND (no include patterns are set OR
 * at least one include pattern matches). Exclude therefore always wins; with
 * an empty include list "everything except exclude" applies. The reference is
 * `picomatch` directly with the same options (`dot: true`).
 */

import fc from "fast-check";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { isIncluded, normalizeMatchPath } from "../../src/index.js";

/** Referenz-Implementierung aus requirements.md 1.9/6.11. */
function referenceIncluded(
  path: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const norm = normalizeMatchPath(path);
  if (exclude.length > 0 && picomatch(exclude as string[], { dot: true })(norm)) return false;
  if (include.length === 0) return true;
  return picomatch(include as string[], { dot: true })(norm);
}

// Generates path segments without glob metacharacters so paths match
// deterministically; patterns come from a separate, small pool.
const SEGMENT = /^[a-z][a-z0-9._-]{0,8}$/;
const pathArb = fc
  .array(fc.stringMatching(SEGMENT), { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("/"));

const PATTERN_POOL = [
  "*.txt",
  "**/*.log",
  "docs/**",
  "tmp/*",
  "*.tmp",
  "**/secret/**",
  "a/b/*.md",
  "*",
  "**",
  ".hidden/**",
  "docs/a.txt",
];

const patternsArb = fc.subarray(PATTERN_POOL, { minLength: 0, maxLength: 4 });

describe("Property 13: Include-/Exclude-Semantik", () => {
  it("isIncluded == (!exclude matches && (include empty || include matches))", () => {
    fc.assert(
      fc.property(pathArb, patternsArb, patternsArb, (path, include, exclude) => {
        expect(isIncluded(path, include, exclude)).toBe(
          referenceIncluded(path, include, exclude),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("exclude always wins: protected paths are never included", () => {
    fc.assert(
      fc.property(pathArb, patternsArb, (path, exclude) => {
        const norm = normalizeMatchPath(path);
        if (exclude.length > 0 && picomatch(exclude as string[], { dot: true })(norm)) {
          expect(isIncluded(path, ["**"], exclude)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Leere Listen bedeuten: alles enthalten", () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        expect(isIncluded(path, [], [])).toBe(true);
        expect(isIncluded(path, undefined, undefined)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("backslash separators and ./ are normalized before matching", () => {
    fc.assert(
      fc.property(pathArb, patternsArb, (path, include) => {
        const windows = path.replaceAll("/", "\\");
        const dotted = `./${path}`;
        expect(isIncluded(windows, include, [])).toBe(isIncluded(path, include, []));
        expect(isIncluded(dotted, include, [])).toBe(isIncluded(path, include, []));
      }),
      { numRuns: 100 },
    );
  });
});
