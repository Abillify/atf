// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 13: Include-/Exclude-Semantik
 *
 * **Validates: Requirements 1.9, 6.11**
 *
 * Für jeden Pfad `p` und beliebige Include-/Exclude-Listen gilt:
 * `isIncluded(p, include, exclude)` ist genau dann `true`, wenn kein
 * Exclude-Muster matcht UND (keine Include-Muster gesetzt sind ODER
 * mindestens ein Include-Muster matcht). Exclude gewinnt also immer; bei
 * leerer Include-Liste gilt „alles außer Exclude". Als Referenz dient
 * `picomatch` direkt mit denselben Optionen (`dot: true`).
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

// Erzeugt Pfadsegmente ohne Glob-Metazeichen, damit Pfade selbst determiniert
// matchen; Muster kommen aus einem separaten, kleinen Vorrat.
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
  it("isIncluded == (!exclude matcht && (include leer || include matcht))", () => {
    fc.assert(
      fc.property(pathArb, patternsArb, patternsArb, (path, include, exclude) => {
        expect(isIncluded(path, include, exclude)).toBe(
          referenceIncluded(path, include, exclude),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("Exclude gewinnt immer: geschützte Pfade sind nie enthalten", () => {
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

  it("Rückwärts-Separatoren und ./ werden vor dem Match normalisiert", () => {
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
