// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 15: Stabilität und Eindeutigkeit der
 * Reference
 *
 * **Validates: Requirements 7.2, 7.9, 8.2**
 *
 * Für jede Source-ID `s` und Quell-ID `q` liefert `deriveReference(s, q)`
 * bei jedem Aufruf denselben Wert; für verschiedene Paare (nach NFC) sind
 * die References verschieden. NFC/NFD-Varianten desselben Pfads ergeben
 * dieselbe Reference. Format: `outpost:<s>:<h>` mit `h` = erste 32 Zeichen
 * von base64url(sha256(s + "\u0000" + q)); `h` passt auf
 * `^[A-Za-z0-9_-]{32}$` und enthält weder Quell-ID noch Dateinamen als
 * Teilstring.
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

describe("Property 15: Stabilität und Eindeutigkeit der Reference", () => {
  it("ist deterministisch und entspricht der Spezifikationsformel", () => {
    fc.assert(
      fc.property(fc.stringMatching(SOURCE_ID), quellIdArb, (s, q) => {
        expect(deriveReference(s, q)).toBe(reference(s, q));
        expect(deriveReference(s, q)).toBe(deriveReference(s, q));
      }),
      { numRuns: 100 },
    );
  });

  it("hat das Format outpost:<s>:<32 base64url-Zeichen>", () => {
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

  it("ist eindeutig für verschiedene Paare (nach NFC)", () => {
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

  it("NFC- und NFD-Variante desselben Pfads ergeben dieselbe Reference", () => {
    fc.assert(
      fc.property(fc.stringMatching(SOURCE_ID), quellIdArb, (s, q) => {
        expect(deriveReference(s, q.normalize("NFC"))).toBe(
          deriveReference(s, q.normalize("NFD")),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("enthält keinen Klartextpfad und keinen Dateinamen im Hash-Teil", () => {
    // Segmente aus dem base64url-Alphabet mit ≥ 8 Zeichen: die
    // Wahrscheinlichkeit, dass so ein Teil zufällig im 32-Zeichen-Hash
    // auftaucht, ist < 1e-13 — ein Treffer wäre ein echter Bug.
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
