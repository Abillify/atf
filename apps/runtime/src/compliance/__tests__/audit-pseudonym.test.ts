// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Unit tests for `auditPseudonym` (src/compliance/audit-pseudonym.ts):
 * keyed (HMAC-SHA256) and unkeyed (SHA-256) derivation, determinism, the
 * `psn_` prefix and the fixed 36-character output length.
 */

import { describe, it, expect } from "bun:test";
import { createHash, createHmac } from "node:crypto";

import { auditPseudonym } from "../audit-pseudonym.js";

const PEPPER = "pepper-value-0123456789abcdef0123456789abcdef";
const OTHER_PEPPER = "other-pepper-0123456789abcdef0123456789ab";

describe("auditPseudonym", () => {
  it("uses HMAC-SHA256 when a pepper is provided", () => {
    const value = "acme|jane.doe";
    const expected = `psn_${createHmac("sha256", PEPPER)
      .update(value, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    expect(auditPseudonym(value, PEPPER)).toBe(expected);
  });

  it("uses plain SHA-256 when no pepper is provided", () => {
    const value = "acme|jane.doe";
    const expected = `psn_${createHash("sha256")
      .update(value, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    expect(auditPseudonym(value)).toBe(expected);
    expect(auditPseudonym(value, undefined)).toBe(expected);
  });

  it("is deterministic for the same value and pepper", () => {
    expect(auditPseudonym("acme|u-1", PEPPER)).toBe(auditPseudonym("acme|u-1", PEPPER));
    expect(auditPseudonym("acme|u-1")).toBe(auditPseudonym("acme|u-1"));
  });

  it("differs for different values and for different peppers", () => {
    expect(auditPseudonym("acme|u-1", PEPPER)).not.toBe(auditPseudonym("acme|u-2", PEPPER));
    expect(auditPseudonym("acme|u-1", PEPPER)).not.toBe(auditPseudonym("other|u-1", PEPPER));
    expect(auditPseudonym("acme|u-1", PEPPER)).not.toBe(auditPseudonym("acme|u-1", OTHER_PEPPER));
    expect(auditPseudonym("acme|u-1", PEPPER)).not.toBe(auditPseudonym("acme|u-1"));
  });

  it("always carries the psn_ prefix and is 36 characters long", () => {
    for (const value of ["", "u", "acme|jane.doe@example.com", "x".repeat(10_000)]) {
      for (const pseudonym of [auditPseudonym(value), auditPseudonym(value, PEPPER)]) {
        expect(pseudonym.startsWith("psn_")).toBe(true);
        expect(pseudonym.length).toBe(36);
        expect(pseudonym.slice(4)).toMatch(/^[0-9a-f]{32}$/);
      }
    }
  });

  it("does not contain the input value", () => {
    const value = "jane.doe@example.com";
    expect(auditPseudonym(value, PEPPER)).not.toContain(value);
    expect(auditPseudonym(value)).not.toContain(value);
  });
});
