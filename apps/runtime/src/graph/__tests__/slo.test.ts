// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the declarative cost/quality SLO registry (`src/graph/slo.ts`).
 */

import { describe, it, expect } from "bun:test";
import { createSloRegistry, parseSloTargets } from "../slo.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

describe("parseSloTargets", () => {
  it("parses valid entries and skips malformed / objective-less ones", () => {
    const targets = parseSloTargets({
      slos: [
        { flow: "a", minQualityScore: 0.8 },
        { flow: "b", maxCostUsdPerRequest: 0.01, minSamples: 3 },
        { flow: "c" }, // no objective → skipped
        { minQualityScore: 0.5 }, // no flow → skipped
        { flow: "d", minQualityScore: 2 }, // out of range → objective dropped → skipped
      ],
    });
    expect(targets.map((t) => t.flow)).toEqual(["a", "b"]);
    expect(targets[1]?.minSamples).toBe(3);
  });

  it("returns [] for a missing/invalid document", () => {
    expect(parseSloTargets(null)).toEqual([]);
    expect(parseSloTargets({})).toEqual([]);
    expect(parseSloTargets({ slos: "nope" })).toEqual([]);
  });
});

describe("SloRegistry", () => {
  it("reports unproven until minSamples, then attained when meeting the floor", () => {
    const now = 0;
    const reg = createSloRegistry(() => now);
    reg.setTargets([{ flow: "a", minQualityScore: 0.8, minSamples: 3 }]);

    reg.record("a", { qualityScore: 0.9 });
    reg.record("a", { qualityScore: 0.9 });
    let r = at(reg.report(), 0);
    expect(r.proven).toBe(false);
    // Unproven objective must not be reported as attained.
    expect(r.attained).toBe(false);

    reg.record("a", { qualityScore: 0.9 });
    r = at(reg.report(), 0);
    expect(r.proven).toBe(true);
    expect(r.observedQuality).toBeGreaterThan(0.8);
    expect(r.meetsQuality).toBe(true);
    expect(r.attained).toBe(true);
  });

  it("marks the SLO as not attained when quality is below the floor", () => {
    const reg = createSloRegistry(() => 0);
    reg.setTargets([{ flow: "a", minQualityScore: 0.8, minSamples: 2 }]);
    reg.record("a", { qualityScore: 0.5 });
    reg.record("a", { qualityScore: 0.5 });
    const r = at(reg.report(), 0);
    expect(r.proven).toBe(true);
    expect(r.meetsQuality).toBe(false);
    expect(r.attained).toBe(false);
  });

  it("enforces a cost cap", () => {
    const reg = createSloRegistry(() => 0);
    reg.setTargets([{ flow: "a", maxCostUsdPerRequest: 0.01, minSamples: 2 }]);
    reg.record("a", { costUsd: 0.05 });
    reg.record("a", { costUsd: 0.05 });
    const r = at(reg.report(), 0);
    expect(r.meetsCost).toBe(false);
    expect(r.attained).toBe(false);
  });

  it("aggregates unmatched flows into the '*' default target", () => {
    const reg = createSloRegistry(() => 0);
    reg.setTargets([{ flow: "*", minQualityScore: 0.7, minSamples: 1 }]);
    reg.record("anything", { qualityScore: 0.9 });
    reg.record("other", { qualityScore: 0.9 });
    const r = at(reg.report(), 0);
    // Both observations surface in the '*' entry (previously they were stored
    // under the concrete flow id and never reported).
    expect(r.flow).toBe("*");
    expect(r.qualitySamples).toBe(2);
    expect(r.attained).toBe(true);
  });

  it("ignores observations for flows without a target", () => {
    const reg = createSloRegistry(() => 0);
    reg.setTargets([{ flow: "a", minQualityScore: 0.8 }]);
    reg.record("b", { qualityScore: 0.1 });
    const r = at(reg.report(), 0);
    expect(r.qualitySamples).toBe(0);
  });

  it("fires a breach webhook once on the transition into breach (edge + cooldown)", async () => {
    const calls: string[] = [];
    const reg = createSloRegistry(() => 0, undefined, {
      webhookUrl: "https://hook.example/slo",
      cooldownMs: 1000,
      fetchFn: async (_url, init) => {
        calls.push(init.body);
        return { ok: true };
      },
    });
    reg.setTargets([{ flow: "a", minQualityScore: 0.8, minSamples: 2 }]);
    // Two below-floor samples → proven breach transition → one alert.
    reg.record("a", { qualityScore: 0.3 });
    reg.record("a", { qualityScore: 0.3 });
    // Another below-floor sample: still breached, no NEW transition → no 2nd alert.
    reg.record("a", { qualityScore: 0.3 });
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(at(calls, 0)).type).toBe("slo_breach");
    expect(JSON.parse(at(calls, 0)).flow).toBe("a");
  });

  it("does not alert while unproven or attained", async () => {
    const calls: string[] = [];
    const reg = createSloRegistry(() => 0, undefined, {
      webhookUrl: "https://hook.example/slo",
      fetchFn: async (_u, init) => {
        calls.push(init.body);
        return { ok: true };
      },
    });
    reg.setTargets([{ flow: "a", minQualityScore: 0.8, minSamples: 3 }]);
    reg.record("a", { qualityScore: 0.3 }); // unproven
    reg.record("a", { qualityScore: 0.9 }); // still unproven
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(0);
  });
});
