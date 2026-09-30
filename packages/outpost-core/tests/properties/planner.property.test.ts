// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 16: Planerentscheidungen
 *
 * **Validates: Requirements 7.3, 7.4, 7.5, 8.2, 8.11**
 *
 * `planItem` liefert genau dann `skip`, wenn ein Zustand mit Status `synced`
 * existiert und dessen Marker dem aktuellen entspricht; ein `failed`-Item wird
 * nie übersprungen. Nach dem Hashing liefert `planAfterHash` genau dann
 * `update-marker`, wenn der vorherige Zustand `synced` ist und seine Prüfsumme
 * der berechneten entspricht; sonst `upload` mit
 * `isNewVersion == (vorheriger Zustand existiert)`, oder `reject-too-large`,
 * wenn die Größe `maxUploadBytes` übersteigt.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planAfterHash, planItem } from "../../src/index.js";
import { itemArb, itemStateArb, sha256Arb } from "../fakes/sync-arb.js";

const limitsArb = fc
  .record({
    resumableThresholdBytes: fc.nat({ max: 100_000_000 }),
    extraMax: fc.nat({ max: 100_000_000 }),
  })
  .map((l) => ({
    resumableThresholdBytes: l.resumableThresholdBytes,
    maxUploadBytes: l.resumableThresholdBytes + l.extraMax,
  }));

describe("Property 16: Planerentscheidungen", () => {
  it("planItem skippt genau bei synced mit gleichem Marker", () => {
    fc.assert(
      fc.property(itemArb, fc.option(itemStateArb, { nil: undefined }), (item, prev) => {
        const action = planItem(item, prev);
        const shouldSkip = prev !== undefined && prev.status === "synced" && prev.marker === item.marker;
        expect(action.kind).toBe(shouldSkip ? "skip" : "hash");
      }),
      { numRuns: 100 },
    );
  });

  it("ein failed-Item wird nie übersprungen", () => {
    fc.assert(
      fc.property(itemArb, itemStateArb, (item, state) => {
        const failed = { ...state, status: "failed" as const, marker: item.marker };
        expect(planItem(item, failed).kind).toBe("hash");
      }),
      { numRuns: 100 },
    );
  });

  it("planAfterHash update-marker genau bei synced mit gleicher sha256", () => {
    fc.assert(
      fc.property(
        itemArb,
        fc.option(itemStateArb, { nil: undefined }),
        sha256Arb,
        limitsArb,
        (item, prev, sha256, limits) => {
          const action = planAfterHash(item, prev, sha256, limits);
          const sameContent =
            prev !== undefined && prev.status === "synced" && prev.sha256 === sha256;
          if (sameContent) {
            expect(action.kind).toBe("update-marker");
          } else if (item.size > limits.maxUploadBytes) {
            expect(action.kind).toBe("reject-too-large");
          } else {
            expect(action.kind).toBe("upload");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("upload trägt isNewVersion == (vorheriger Zustand existiert)", () => {
    fc.assert(
      fc.property(
        itemArb,
        fc.option(itemStateArb, { nil: undefined }),
        sha256Arb,
        limitsArb,
        (item, prev, sha256, limits) => {
          const action = planAfterHash(item, prev, sha256, limits);
          if (action.kind === "upload") {
            expect(action.isNewVersion).toBe(prev !== undefined);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("übergroße Items werden verworfen, nicht hochgeladen", () => {
    fc.assert(
      fc.property(
        itemArb,
        fc.option(
          itemStateArb.filter((s) => s.status !== "synced"),
          { nil: undefined },
        ),
        sha256Arb,
        fc.nat({ max: 100_000_000 }),
        (item, prev, sha256, maxUploadBytes) => {
          fc.pre(item.size > maxUploadBytes);
          const action = planAfterHash(item, prev, sha256, {
            resumableThresholdBytes: maxUploadBytes,
            maxUploadBytes,
          });
          expect(action.kind).toBe("reject-too-large");
        },
      ),
      { numRuns: 100 },
    );
  });
});
