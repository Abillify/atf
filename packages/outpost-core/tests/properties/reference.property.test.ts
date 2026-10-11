// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 15: stability and uniqueness of the
 * reference
 *
 * **Validates: Requirements 7.2, 7.9, 8.2**
 *
 * For every source ID `s` and source item ID `q`, `deriveReference(s, q)`
 * returns the same value on every call; for different pairs (after NFC) the
 * references differ. NFC/NFD variants of the same path yield the same
 * reference. Format: `outpost:<s>:<h>` with `h` = the first 32 characters
 * of base64url(sha256(s + "\u0000" + q)); `h` matches
 * `^[A-Za-z0-9_-]{32}$` and contains neither the source item ID nor file
 * names as a substring.
 */

import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deriveReference } from "../../src/index.js";

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,12}$/;
const quellIdArb = fc
  .array(fc.stringMatching(SEGMENT), { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"));

/** Referenzimplementierung aus requirements.md 7.9. */
function reference(s: string, q: string): string {
  const h = createHash("sha256")
    .update(s + "\u0000" + q.normalize("NFC"), "utf8")
    .digest("base64url")
    .slice(0, 32);
  return `outpost:${s}:${h}`;
}

describe("Property 15: stability and uniqueness of the reference", () => {
  it("is deterministic and matches the specification formula", () => {
    fc.assert(
      fc.property(fc.stringMatching(SOURCE_ID), quellIdArb, (s, q) => {
        expect(deriveReference(s, q)).toBe(reference(s, q));
        expect(deriveReference(s, q)).toBe(deriveReference(s, q));
      }),
      { numRuns: 100 },
    );
  });

  it("has the format outpost:<s>:<32 base64url characters>", () => {
    fc.assert(
      fc.property(fc.stringMatching(SOURCE_ID), quellIdArb, (s, q) => {
        const ref = deriveReference(s, q);
        expect(ref.startsWith(`outpost:${s}:`)).toBe(true);
        const hash = ref.slice(`outpost:${s}:`.length);
        expect(hash).toMatch(/^[A-Za-z0-9_-]{32}$/);
      }),
      { numRuns: 100 },
    );
  });

  it("is unique for different pairs (after NFC)", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(SOURCE_ID),
        fc.stringMatching(SOURCE_ID),
        quellIdArb,
        quellIdArb,
        (s1, s2, q1, q2) => {
          const nfc1 = q1.normalize("NFC");
          const nfc2 = q2.normalize("NFC");
          if (s1 === s2 && nfc1 === nfc2) return; // gleiches Paar
          expect(deriveReference(s1, q1)).not.toBe(deriveReference(s2, q2));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("NFC and NFD variants of the same path yield the same reference", () => {
    fc.assert(
      fc.property(fc.stringMatching(SOURCE_ID), quellIdArb, (s, q) => {
        expect(deriveReference(s, q.normalize("NFC"))).toBe(
          deriveReference(s, q.normalize("NFD")),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("contains no plain-text path and no file name in the hash part", () => {
    // Segments from the base64url alphabet with ≥ 8 characters: the
    // probability that such a part appears by chance in the 32-character hash
    // is < 1e-13, so a hit would be a real bug.
    const longSegment = /^[A-Za-z0-9][A-Za-z0-9_-]{7,14}$/;
    const pathArb = fc
      .array(fc.stringMatching(longSegment), { minLength: 1, maxLength: 3 })
      .map((segments) => segments.join("/"));
    fc.assert(
      fc.property(fc.stringMatching(SOURCE_ID), pathArb, (s, q) => {
        const ref = deriveReference(s, q);
        const hash = ref.slice(`outpost:${s}:`.length);
        for (const segment of q.normalize("NFC").split("/")) {
          expect(hash).not.toContain(segment);
        }
      }),
      { numRuns: 100 },
    );
  });
});
