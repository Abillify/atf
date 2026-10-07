// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Comparison must be constant-time and must not leak lengths: both operands
 * are digested before the timing-safe compare, so equal-length and
 * different-length inputs behave identically from an observer's perspective.
 */

import { describe, expect, test } from "bun:test";
import { safeEqual, safeEqualBytes } from "../src/index.js";

describe("safeEqual", () => {
  test("equal strings compare true", () => {
    expect(safeEqual("secret-token", "secret-token")).toBe(true);
  });

  test("different strings compare false", () => {
    expect(safeEqual("secret-token", "secret-tokeX")).toBe(false);
  });

  test("different lengths compare false", () => {
    expect(safeEqual("short", "much longer value")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "a")).toBe(false);
  });

  test("unicode round-trips through UTF-8", () => {
    expect(safeEqual("straße", "straße")).toBe(true);
    expect(safeEqual("straße", "strasse")).toBe(false);
  });
});

describe("safeEqualBytes", () => {
  test("equal bytes compare true", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(safeEqualBytes(a, b)).toBe(true);
  });

  test("single differing byte compares false", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(safeEqualBytes(a, b)).toBe(false);
  });

  test("different lengths compare false", () => {
    expect(safeEqualBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(safeEqualBytes(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});
