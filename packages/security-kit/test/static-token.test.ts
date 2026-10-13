// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Static service-token matching with rotation (requirement 11.8).
 *
 * During a rotation window both the old and the new token are valid; the
 * matcher must accept either, reject everything else, and ignore
 * null/empty entries so optional tokens can be passed straight through.
 */

import { describe, expect, test } from "bun:test";
import { createStaticTokenMatcher } from "../src/index.js";

describe("createStaticTokenMatcher", () => {
  const PRIMARY = "primary-token-value";
  const NEXT = "rotation-token-value";

  test("accepts the single configured token", () => {
    const matcher = createStaticTokenMatcher([PRIMARY]);
    expect(matcher(PRIMARY)).toBe(true);
    expect(matcher("other")).toBe(false);
  });

  test("accepts both tokens during a rotation", () => {
    const matcher = createStaticTokenMatcher([PRIMARY, NEXT]);
    expect(matcher(PRIMARY)).toBe(true);
    expect(matcher(NEXT)).toBe(true);
    expect(matcher("neither-token")).toBe(false);
  });

  test("ignores null and empty entries", () => {
    const matcher = createStaticTokenMatcher([PRIMARY, null, undefined, ""]);
    expect(matcher(PRIMARY)).toBe(true);
    expect(matcher("")).toBe(false);
  });

  test("works with only a rotation token configured", () => {
    const matcher = createStaticTokenMatcher([null, NEXT]);
    expect(matcher(NEXT)).toBe(true);
    expect(matcher(PRIMARY)).toBe(false);
  });

  test("a matcher without any configured token rejects everything", () => {
    const matcher = createStaticTokenMatcher([null, undefined, ""]);
    expect(matcher("")).toBe(false);
    expect(matcher("anything")).toBe(false);
  });

  test("does not accept prefixes or suffixes of a configured token", () => {
    const matcher = createStaticTokenMatcher([PRIMARY, NEXT]);
    expect(matcher(PRIMARY.slice(0, -1))).toBe(false);
    expect(matcher(`${NEXT}x`)).toBe(false);
  });
});
