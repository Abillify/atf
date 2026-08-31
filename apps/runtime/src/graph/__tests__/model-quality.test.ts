// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Model quality registry (`src/graph/model-quality.ts`)
 *
 * EMA of per-model judge scores with an injectable clock, so the recording,
 * clamping, decay, and snapshot logic is fully deterministic under test.
 */

import { describe, test, expect } from "bun:test";
import { ModelQualityRegistry } from "../model-quality.js";
import type { LlmConfig } from "../../types/flow.js";

const M: Pick<LlmConfig, "provider" | "model"> = {
  provider: "openai",
  model: "gpt-x",
};
const N: Pick<LlmConfig, "provider" | "model"> = {
  provider: "google",
  model: "gemini-y",
};

describe("ModelQualityRegistry.record / get", () => {
  test("seeds the EMA with the first observation", () => {
    const r = new ModelQualityRegistry();
    r.record(M, 0.8);
    expect(r.get(M)).toEqual({ meanScore: 0.8, samples: 1 });
  });

  test("blends subsequent observations with the configured alpha", () => {
    const r = new ModelQualityRegistry({ alpha: 0.5 });
    r.record(M, 1);
    r.record(M, 0);
    // ema = 0.5*0 + 0.5*1 = 0.5
    expect(r.get(M)?.meanScore).toBeCloseTo(0.5, 6);
    expect(r.get(M)?.samples).toBe(2);
  });

  test("ignores out-of-range and non-finite scores", () => {
    const r = new ModelQualityRegistry();
    r.record(M, -0.1);
    r.record(M, 1.5);
    r.record(M, Number.NaN);
    expect(r.get(M)).toBeUndefined();
  });

  test("falls back to the default alpha for an invalid alpha option", () => {
    const r = new ModelQualityRegistry({ alpha: 0 });
    r.record(M, 1);
    r.record(M, 0);
    // default alpha 0.2 -> ema = 0.2*0 + 0.8*1 = 0.8
    expect(r.get(M)?.meanScore).toBeCloseTo(0.8, 6);
  });

  test("returns undefined for a never-observed model", () => {
    const r = new ModelQualityRegistry();
    expect(r.get(M)).toBeUndefined();
  });
});

describe("ModelQualityRegistry.decay", () => {
  test("decays a stale score toward the neutral 0.5", () => {
    let now = 1000;
    const r = new ModelQualityRegistry({
      halfLifeMs: 100,
      clock: () => now,
    });
    r.record(M, 1); // ema = 1 at t=1000
    now = 1100; // one half-life later
    // weight = 0.5 -> 1*0.5 + 0.5*0.5 = 0.75
    expect(r.get(M)?.meanScore).toBeCloseTo(0.75, 6);
  });

  test("does not decay when half-life is disabled (default)", () => {
    let now = 0;
    const r = new ModelQualityRegistry({ clock: () => now });
    r.record(M, 0.9);
    now = 10_000_000;
    expect(r.get(M)?.meanScore).toBeCloseTo(0.9, 6);
  });
});

describe("ModelQualityRegistry.lookup / snapshot", () => {
  test("lookup returns a function bound to the registry", () => {
    const r = new ModelQualityRegistry();
    r.record(M, 0.7);
    const fn = r.lookup();
    expect(fn({ provider: "openai", model: "gpt-x" })?.meanScore).toBeCloseTo(
      0.7,
      6,
    );
  });

  test("snapshot lists all models sorted by mean score (desc)", () => {
    const r = new ModelQualityRegistry();
    r.record(M, 0.4);
    r.record(N, 0.9);
    const snap = r.snapshot();
    expect(snap.map((s) => s.model)).toEqual([
      "google/gemini-y",
      "openai/gpt-x",
    ]);
    expect(snap[0]?.samples).toBe(1);
    expect(typeof snap[0]?.lastUpdated).toBe("number");
  });
});
