// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 21: choice of the upload path
 *
 * **Validates: Requirements 8.5**
 *
 * For every file size `n` and every threshold `t` the planner chooses the
 * resumable path (`/v2/uploads` + `POST /v2/jobs`) exactly when `n > t`,
 * and otherwise `POST /v1/ingest` (`direct`).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planAfterHash } from "../../src/index.js";
import { itemArb, sha256Arb } from "../fakes/sync-arb.js";

describe("Property 21: choice of the upload path", () => {
  it("resumable exactly when size > resumableThresholdBytes", () => {
    fc.assert(
      fc.property(
        itemArb,
        sha256Arb,
        fc.nat({ max: 200_000_000 }),
        fc.nat({ max: 200_000_000 }),
        (item, sha256, threshold, extraMax) => {
          const maxUploadBytes = threshold + extraMax;
          fc.pre(item.size <= maxUploadBytes); // otherwise reject-too-large
          const action = planAfterHash(item, undefined, sha256, {
            resumableThresholdBytes: threshold,
            maxUploadBytes,
          });
          expect(action.kind).toBe("upload");
          if (action.kind === "upload") {
            expect(action.mode).toBe(item.size > threshold ? "resumable" : "direct");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("edge cases: size == threshold → direct, size == threshold+1 → resumable", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 200_000_000 }),
        sha256Arb,
        (threshold, sha256) => {
          const base = {
            quellId: "a.txt",
            name: "a.txt",
            modified: new Date("2025-01-01T00:00:00Z"),
            marker: "m",
          };
          const limits = {
            resumableThresholdBytes: threshold,
            maxUploadBytes: Number.MAX_SAFE_INTEGER,
          };
          const atThreshold = planAfterHash(
            { ...base, size: threshold },
            undefined,
            sha256,
            limits,
          );
          expect(atThreshold.kind === "upload" && atThreshold.mode).toBe("direct");
          const aboveThreshold = planAfterHash(
            { ...base, size: threshold + 1 },
            undefined,
            sha256,
            limits,
          );
          expect(aboveThreshold.kind === "upload" && aboveThreshold.mode).toBe("resumable");
        },
      ),
      { numRuns: 100 },
    );
  });
});
