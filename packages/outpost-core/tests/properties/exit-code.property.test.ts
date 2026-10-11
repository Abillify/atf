// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 29: exit code in one-shot mode
 *
 * **Validates: Requirements 6.18, 10.5, 10.8**
 *
 * `aggregateExitCode` returns 0 exactly when all sources succeed; 78
 * overrides everything (configuration), then 2
 * (Extract auth/connection), then 1 (source error, failed items
 * or needs-authorization). At least one needs-authorization without an
 * Extract error → 1.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  aggregateExitCode,
  EXIT_CONFIG,
  EXIT_EXTRACT_AUTH_OR_CONNECTION,
  EXIT_ITEM_OR_SOURCE_FAILURE,
  EXIT_OK,
  resultFromRunReport,
  type OnceSourceResult,
} from "../../src/schedule/once.js";
import { newCounters } from "../../src/sync/counters.js";
import type { RunReport } from "../../src/sync/run.js";

const kindArb = fc.constantFrom(
  "ok",
  "needs-authorization",
  "source-error",
  "extract-error",
  "config-error",
) as fc.Arbitrary<OnceSourceResult["kind"]>;

const resultArb: fc.Arbitrary<OnceSourceResult> = kindArb.map(
  (kind): OnceSourceResult => ({ kind }),
);

describe("Property 29: exit code in one-shot mode", () => {
  it("0 exactly when all sources succeed", () => {
    fc.assert(
      fc.property(fc.array(resultArb, { minLength: 1, maxLength: 8 }), (results) => {
        const allOk = results.every((r) => r.kind === "ok");
        if (allOk) {
          expect(aggregateExitCode(results)).toBe(EXIT_OK);
        } else {
          expect(aggregateExitCode(results)).not.toBe(EXIT_OK);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("priority: 78 > 2 > 1; otherwise 0", () => {
    fc.assert(
      fc.property(fc.array(resultArb, { minLength: 1, maxLength: 8 }), (results) => {
        const kinds = new Set(results.map((r) => r.kind));
        const expected = kinds.has("config-error")
          ? EXIT_CONFIG
          : kinds.has("extract-error")
            ? EXIT_EXTRACT_AUTH_OR_CONNECTION
            : kinds.size > 1 || !kinds.has("ok")
              ? EXIT_ITEM_OR_SOURCE_FAILURE
              : EXIT_OK;
        expect(aggregateExitCode(results)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("at least one needs-authorization without an Extract error → exit 1", () => {
    fc.assert(
      fc.property(fc.array(resultArb, { minLength: 1, maxLength: 8 }), (results) => {
        const kinds = new Set(results.map((r) => r.kind));
        if (kinds.has("needs-authorization") && !kinds.has("extract-error") && !kinds.has("config-error")) {
          expect(aggregateExitCode(results)).toBe(EXIT_ITEM_OR_SOURCE_FAILURE);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("RunReport-Abbildung: failed>0 → source-error, needs-auth → needs-authorization", () => {
    fc.assert(
      fc.property(
        fc.record({
          outcome: fc.constantFrom("ok", "incomplete", "needs-authorization", "reauth-required") as fc.Arbitrary<RunReport["outcome"]>,
          failed: fc.integer({ min: 0, max: 5 }),
        }),
        ({ outcome, failed }) => {
          const report: RunReport = {
            outcome,
            counters: { ...newCounters(), failed },
            deletePhase: "none",
          };
          const result = resultFromRunReport(report);
          switch (outcome) {
            case "needs-authorization":
              expect(result.kind).toBe("needs-authorization");
              break;
            case "reauth-required":
              expect(result.kind).toBe("extract-error");
              break;
            case "incomplete":
              expect(result.kind).toBe("source-error");
              break;
            case "ok":
              expect(result.kind).toBe(failed > 0 ? "source-error" : "ok");
              break;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
