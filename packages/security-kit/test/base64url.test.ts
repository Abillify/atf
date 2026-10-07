// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Base64url is hand-rolled (no Buffer) so the browser bundle stays clean.
 * The decoder is strict: invalid characters, misplaced padding, and non-zero
 * leftover bits are all rejected — a lenient decoder would accept
 * canonicalisation-mutants of the same digest.
 */

import { describe, expect, test } from "bun:test";
import {
  base64UrlDecode,
  base64UrlDecodeToString,
  base64UrlEncode,
  base64UrlEncodePadded,
  base64UrlEncodeString,
} from "../src/browser.js";

describe("base64UrlEncode / Decode round-trip", () => {
  test("all byte lengths 0..64 round-trip", () => {
    for (let len = 0; len <= 64; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + len) & 0xff;
      const encoded = base64UrlEncode(bytes);
      expect(encoded).not.toContain("=");
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
      const decoded = base64UrlDecode(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    }
  });

  test("random buffers round-trip", () => {
    for (let i = 0; i < 50; i++) {
      const len = Math.floor(Math.random() * 300);
      const bytes = new Uint8Array(len);
      crypto.getRandomValues(bytes);
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  test("string round-trip with unicode", () => {
    const text = "Prüfung ✓ ünïcödé 日本語";
    expect(base64UrlDecodeToString(base64UrlEncodeString(text))).toBe(text);
  });

  test("padded encoding decodes as well", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const padded = base64UrlEncodePadded(bytes);
    expect(Array.from(base64UrlDecode(padded))).toEqual(Array.from(bytes));
    expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
  });

  test("known vector", () => {
    // "Man" -> "TWFu" in base64; base64url keeps it identical.
    expect(base64UrlEncode(new Uint8Array([0x4d, 0x61, 0x6e]))).toBe("TWFu");
  });
});

describe("base64UrlDecode strictness", () => {
  test("rejects invalid characters", () => {
    expect(() => base64UrlDecode("ab+d")).toThrow();
    expect(() => base64UrlDecode("ab/d")).toThrow();
    expect(() => base64UrlDecode("ab$d")).toThrow();
    expect(() => base64UrlDecode("ab d")).toThrow();
  });

  test("rejects length % 4 === 1", () => {
    expect(() => base64UrlDecode("a")).toThrow();
    expect(() => base64UrlDecode("abcde")).toThrow();
  });

  test("rejects misplaced or excessive padding", () => {
    expect(() => base64UrlDecode("ab=c")).toThrow();
    expect(() => base64UrlDecode("====")).toThrow();
    expect(() => base64UrlDecode("YWJjZA==x")).toThrow();
  });

  test("rejects unnecessary padding", () => {
    // "TWFu" needs no padding; adding it is a canonicalisation mutant.
    expect(() => base64UrlDecode("TWFu=")).toThrow();
    expect(() => base64UrlDecode("TWFu==")).toThrow();
  });

  test("rejects non-zero leftover bits", () => {
    // Two characters carry 11 bits: the low 3 bits of the second must be 0.
    // "AA" is valid (leftover 000); "A_" (000000 111111) leaves 111.
    expect(base64UrlDecode("AA").length).toBe(1);
    expect(() => base64UrlDecode("A_")).toThrow();
    // Three characters: low 2 bits of the third must be 0. "QUY" ok, "QUZ" not.
    expect(base64UrlDecode("QUY").length).toBe(2);
    expect(() => base64UrlDecode("QUZ")).toThrow();
  });

  test("accepts canonical padded forms", () => {
    expect(Array.from(base64UrlDecode("TWE="))).toEqual([0x4d, 0x61]);
    expect(Array.from(base64UrlDecode("TQ=="))).toEqual([0x4d]);
  });
});
