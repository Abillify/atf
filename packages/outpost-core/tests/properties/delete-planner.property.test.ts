// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 26: safety of the delete planning
 *
 * **Validates: Requirements 6.12, 9.1, 9.2, 9.4, 9.5, 9.6, 9.11**
 *
 * If the listing is incomplete, the plan is empty; with Mirror_Delete
 * disabled the plan contains no deletions; every planned reference comes
 * from this source's Sync_State and belongs to a source ID that was not
 * seen; if the share of candidates exceeds the threshold and there is no
 * confirmation for exactly this candidate set, the plan is
 * `awaiting-confirmation`; otherwise the delete set equals exactly the
 * candidate set. With `awaiting-confirmation`, `state.items` stays
 * unchanged (the reducer is not called for candidates).
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

/** Candidates of a run: in the state, but not seen. */
function candidates(state: SourceState, seen: ReadonlySet<string>): string[] {
  return Object.keys(state.items)
    .filter((q) => !seen.has(q))
    .sort();
}

const seenArb: fc.Arbitrary<ReadonlySet<string>> = fc
  .array(fc.oneof(quellIdArb, fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/)), { maxLength: 12 })
  .map((ids) => new Set(ids));

describe("Property 26: safety of the delete planning", () => {
  it("incomplete listing → no deletions", () => {
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

  it("disabled Mirror_Delete → no deletions, marking instead", () => {
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

  it("every planned reference comes from the state of an unseen source ID", () => {
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
            // No reference for a seen source ID (9.6).
            for (const [quellId, item] of Object.entries(state.items)) {
              if (seen.has(quellId)) expect(plan.references).not.toContain(item.reference);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("above the threshold without confirmation → awaiting-confirmation with correct counts", () => {
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

  it("below the threshold or confirmed → delete set == candidate set", () => {
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

  it("awaiting-confirmation: state.items stays unchanged, no reduce for candidates", () => {
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
        // planDeletes is pure: the state is not changed.
        expect(state).toEqual(before);
        // And: there are no outcomes for candidates, hence no reducer calls.
        for (const quellId of missing) {
          const prev = state.items[quellId];
          expect(prev).toEqual(before.items[quellId]);
        }
        // Demonstration: an accidental missing-in-source outcome would change
        // the status, which is exactly what the run must not do with awaiting-confirmation.
        const demo = reduce(before.items[missing[0] as string], (before.items[missing[0] as string] as { reference: string }).reference, {
          kind: "missing-in-source",
          mirrorDelete: false,
        });
        expect(demo?.status).toBe("deleted-in-source");
      }),
      { numRuns: 100 },
    );
  });

  it("candidateSetHash is stable and distinguishes different sets", () => {
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
