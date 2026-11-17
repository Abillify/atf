// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the include/exclude glob filter.
 *
 * Covered: the ReDoS guard for single-branch repeated extglobs with a
 * wildcard (CVE-2026-112366 / GHSA-fc5q-39xc-vjpf, picomatch <= 4.0.7 has
 * no patched release yet), and that ordinary glob semantics — including
 * unaffected extglob shapes — keep working.
 */

import { describe, expect, it } from "vitest";
import { isIncluded, UnsafeGlobPatternError } from "../../src/index.js";

describe("ReDoS guard for repeated extglobs (CVE-2026-112366)", () => {
  it("rejects +( * )-style single-branch repeated extglobs with a wildcard", () => {
    for (const pattern of ["+(*)", "+(*a)", "*(a*)", "?(*.log)", "+(**/x)"]) {
      expect(() => isIncluded("a.txt", [pattern])).toThrow(UnsafeGlobPatternError);
      expect(() => isIncluded("a.txt", undefined, [pattern])).toThrow(
        UnsafeGlobPatternError,
      );
    }
  });

  it("rejects the crafted pattern before matching, not after", () => {
    // The guard throws at compile time — the pathological path never reaches
    // picomatch, so no backtracking can happen.
    let threw = false;
    try {
      isIncluded("x".repeat(30), ["+(*a)"]);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(UnsafeGlobPatternError);
      expect((err as Error).message).toContain("+(*a)");
    }
    expect(threw).toBe(true);
  });

  it("keeps multi-branch and wildcard-free extglobs, which are not affected", () => {
    // +(|a|b) and +(v1) do not hit the exponential-backtracking path.
    expect(isIncluded("v1/notes.txt", ["+(v1|v2)/**"])).toBe(true);
    expect(isIncluded("v3/notes.txt", ["+(v1|v2)/**"])).toBe(false);
    expect(isIncluded("a.log", ["+(*.tmp|*.log)"])).toBe(true);
    expect(isIncluded("a.txt", ["+(*.tmp|*.log)"])).toBe(false);
  });
});

describe("isIncluded glob semantics", () => {
  it("exclude wins over include", () => {
    expect(isIncluded("docs/a.txt", ["**/*.txt"], ["**/secret/**"])).toBe(true);
    expect(isIncluded("docs/secret/a.txt", ["**/*.txt"], ["**/secret/**"])).toBe(
      false,
    );
  });

  it("no include patterns means everything that is not excluded", () => {
    expect(isIncluded("a/b/c.bin")).toBe(true);
    expect(isIncluded("a/b/c.bin", undefined, ["**/*.bin"])).toBe(false);
  });

  it("normalises backslashes and a leading ./ before matching", () => {
    expect(isIncluded("docs\\a.txt", ["docs/*.txt"])).toBe(true);
    expect(isIncluded("./docs/a.txt", ["docs/*.txt"])).toBe(true);
  });
});
