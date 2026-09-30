// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 26: Sicherheit der Löschplanung
 *
 * **Validates: Requirements 6.12, 9.1, 9.2, 9.4, 9.5, 9.6, 9.11**
 *
 * Ist das Listing unvollständig, ist der Plan leer; bei deaktiviertem
 * Mirror_Delete enthält der Plan keine Löschungen; jede geplante Reference
 * stammt aus dem Sync_State dieser Source und gehört zu einer nicht gesehenen
 * Quell-ID; übersteigt der Anteil der Kandidaten den Schwellwert und liegt
 * keine Bestätigung für genau diese Kandidatenmenge vor, lautet der Plan
 * `awaiting-confirmation`; sonst entspricht die Löschmenge genau der
 * Kandidatenmenge. Bei `awaiting-confirmation` bleibt `state.items`
 * unverändert (der Reducer wird für Kandidaten nicht aufgerufen).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  computeCandidateSetHash,
  planDeletes,
  reduce,
  type SourceState,
} from "../../src/index.js";
import { quellIdArb, sourceStateArb } from "../fakes/sync-arb.js";

/** Kandidaten eines Laufs: im State, aber nicht gesehen. */
function candidates(state: SourceState, seen: ReadonlySet<string>): string[] {
  return Object.keys(state.items)
    .filter((q) => !seen.has(q))
    .sort();
}

const seenArb: fc.Arbitrary<ReadonlySet<string>> = fc
  .array(fc.oneof(quellIdArb, fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/)), { maxLength: 12 })
  .map((ids) => new Set(ids));

describe("Property 26: Sicherheit der Löschplanung", () => {
  it("unvollständiges Listing → keine Löschungen", () => {
    fc.assert(
      fc.property(sourceStateArb, seenArb, fc.boolean(), fc.integer({ min: 0, max: 100 }), (state, seen, mirror, threshold) => {
        const plan = planDeletes({
          listing: "incomplete",
          seen,
          state,
          mirrorDelete: mirror,
          thresholdPercent: threshold,
          confirmed: false,
        });
        expect(plan).toEqual({ kind: "none", reason: "listing-incomplete" });
      }),
      { numRuns: 100 },
    );
  });

  it("deaktivierter Mirror_Delete → keine Löschungen, Markierung stattdessen", () => {
    fc.assert(
      fc.property(sourceStateArb, seenArb, fc.integer({ min: 0, max: 100 }), (state, seen, threshold) => {
        const plan = planDeletes({
          listing: "complete",
          seen,
          state,
          mirrorDelete: false,
          thresholdPercent: threshold,
          confirmed: true,
        });
        if (plan.kind === "delete") {
          expect(plan.references).toEqual([]);
        } else if (plan.kind === "none") {
          expect(["nothing-missing", "mirror-disabled-marked"]).toContain(plan.reason);
        } else {
          expect(plan.kind).toBe("awaiting-confirmation");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("nichts fehlend → nothing-missing", () => {
    fc.assert(
      fc.property(sourceStateArb, (state) => {
        const seen = new Set(Object.keys(state.items));
        const plan = planDeletes({
          listing: "complete",
          seen,
          state,
          mirrorDelete: true,
          thresholdPercent: 50,
          confirmed: false,
        });
        expect(plan).toEqual({ kind: "none", reason: "nothing-missing" });
      }),
      { numRuns: 100 },
    );
  });

  it("jede geplante Reference stammt aus dem State einer nicht gesehenen Quell-ID", () => {
    fc.assert(
      fc.property(
        sourceStateArb,
        seenArb,
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        (state, seen, threshold, confirmed) => {
          const plan = planDeletes({
            listing: "complete",
            seen,
            state,
            mirrorDelete: true,
            thresholdPercent: threshold,
            confirmed,
          });
          const missing = candidates(state, seen);
          if (plan.kind === "delete") {
            expect(plan.references.length).toBe(missing.length);
            for (const quellId of missing) {
              const ref = state.items[quellId]?.reference;
              expect(plan.references).toContain(ref);
              expect(seen.has(quellId)).toBe(false);
            }
            // Keine Reference für eine gesehene Quell-ID (9.6).
            for (const [quellId, item] of Object.entries(state.items)) {
              if (seen.has(quellId)) expect(plan.references).not.toContain(item.reference);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("über Schwellwert ohne Bestätigung → awaiting-confirmation mit korrekten Zahlen", () => {
    fc.assert(
      fc.property(sourceStateArb, seenArb, (state, seen) => {
        const missing = candidates(state, seen);
        const total = Object.keys(state.items).length;
        fc.pre(total > 0 && (missing.length / total) * 100 > 50);
        const plan = planDeletes({
          listing: "complete",
          seen,
          state,
          mirrorDelete: true,
          thresholdPercent: 50,
          confirmed: false,
        });
        expect(plan).toEqual({ kind: "awaiting-confirmation", count: missing.length, total });
      }),
      { numRuns: 100 },
    );
  });

  it("unter Schwellwert oder bestätigt → Löschmenge == Kandidatenmenge", () => {
    fc.assert(
      fc.property(
        sourceStateArb,
        seenArb,
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        (state, seen, threshold, confirmed) => {
          const missing = candidates(state, seen);
          const total = Object.keys(state.items).length;
          const above = total > 0 && (missing.length / total) * 100 > threshold;
          fc.pre(missing.length > 0 && (!above || confirmed));
          const plan = planDeletes({
            listing: "complete",
            seen,
            state,
            mirrorDelete: true,
            thresholdPercent: threshold,
            confirmed,
          });
          expect(plan.kind).toBe("delete");
          if (plan.kind === "delete") {
            const expectedRefs = missing
              .map((q) => state.items[q]?.reference)
              .filter((r): r is string => typeof r === "string");
            expect([...plan.references].sort()).toEqual([...expectedRefs].sort());
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("awaiting-confirmation: state.items bleibt unverändert, kein reduce für Kandidaten", () => {
    fc.assert(
      fc.property(sourceStateArb, seenArb, (state, seen) => {
        const missing = candidates(state, seen);
        const total = Object.keys(state.items).length;
        fc.pre(total > 0 && (missing.length / total) * 100 > 50);
        const before = structuredClone(state);
        const plan = planDeletes({
          listing: "complete",
          seen,
          state,
          mirrorDelete: true,
          thresholdPercent: 50,
          confirmed: false,
        });
        expect(plan.kind).toBe("awaiting-confirmation");
        // planDeletes ist rein: der State wird nicht verändert.
        expect(state).toEqual(before);
        // Und: es gibt für Kandidaten keine Outcomes, also auch keine Reducer-Aufrufe.
        for (const quellId of missing) {
          const prev = state.items[quellId];
          expect(prev).toEqual(before.items[quellId]);
        }
        // Demonstration: ein versehentlicher missing-in-source-Outcome würde den
        // Status ändern — genau das darf der Run bei awaiting-confirmation nicht tun.
        const demo = reduce(before.items[missing[0] as string], (before.items[missing[0] as string] as { reference: string }).reference, {
          kind: "missing-in-source",
          mirrorDelete: false,
        });
        expect(demo?.status).toBe("deleted-in-source");
      }),
      { numRuns: 100 },
    );
  });

  it("candidateSetHash ist stabil und unterscheidet verschiedene Mengen", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(quellIdArb, { minLength: 1, maxLength: 8 }),
        fc.uniqueArray(quellIdArb, { minLength: 1, maxLength: 8 }),
        (a, b) => {
          const hashA = computeCandidateSetHash(a);
          const hashAgain = computeCandidateSetHash([...a].reverse());
          expect(hashA).toBe(hashAgain); // Reihenfolge egal
          expect(hashA).toMatch(/^[0-9a-f]{64}$/);
          const setA = new Set(a);
          const setB = new Set(b);
          const same = setA.size === setB.size && [...setA].every((x) => setB.has(x));
          if (!same) {
            expect(hashA).not.toBe(computeCandidateSetHash(b));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
