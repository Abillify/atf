// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the "quality-aware" routing strategy and the ModelQualityRegistry.
 */

import { describe, it, expect } from "bun:test";
import {
  parseRoutingConfig,
  selectModel,
  type ModelQualityStats,
} from "../cost-router.js";
import { ModelQualityRegistry } from "../model-quality.js";
import type { LlmConfig } from "../../types/flow.js";

/** `parseRoutingConfig` for a document known to yield a routing config. */
function mustParseRoutingConfig(
  ...args: Parameters<typeof parseRoutingConfig>
): NonNullable<ReturnType<typeof parseRoutingConfig>> {
  const routing = parseRoutingConfig(...args);
  if (routing === undefined) throw new Error("expected a parsed routing config");
  return routing;
}

const PRICING = {
  "openai/gpt-4o": { prompt: 2.5, completion: 10 },
  "openai/gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
  "google/gemini-2.0-flash": { prompt: 0.1, completion: 0.4 },
};

const CHEAP: LlmConfig = { provider: "google", model: "gemini-2.0-flash" };
const MID: LlmConfig = { provider: "openai", model: "gpt-4o-mini" };
const PREMIUM: LlmConfig = { provider: "openai", model: "gpt-4o" };

describe("parseRoutingConfig — quality-aware", () => {
  it("parses strategy and quality knobs", () => {
    const r = mustParseRoutingConfig({
      routing: {
        strategy: "quality-aware",
        minQualityScore: 0.8,
        minQualitySamples: 10,
        candidates: [CHEAP, PREMIUM],
      },
    });
    expect(r?.strategy).toBe("quality-aware");
    expect(r?.minQualityScore).toBe(0.8);
    expect(r?.minQualitySamples).toBe(10);
  });

  it("ignores out-of-range quality knobs", () => {
    const r = mustParseRoutingConfig({
      routing: {
        strategy: "quality-aware",
        minQualityScore: 1.5,
        candidates: [CHEAP, MID],
      },
    });
    expect(r?.minQualityScore).toBeUndefined();
  });
});

describe("selectModel — quality-aware", () => {
  const stats = (map: Record<string, ModelQualityStats>) => (c: LlmConfig) =>
    map[`${c.provider}/${c.model}`];

  it("picks the cheapest candidate that clears the quality floor", () => {
    const routing = mustParseRoutingConfig({
      routing: {
        strategy: "quality-aware",
        minQualityScore: 0.7,
        minQualitySamples: 3,
        candidates: [PREMIUM, MID, CHEAP],
      },
    });
    const chosen = selectModel(routing, {
      pricing: PRICING,
      qualityStats: stats({
        "openai/gpt-4o": { meanScore: 0.95, samples: 20 },
        "openai/gpt-4o-mini": { meanScore: 0.85, samples: 20 },
        "google/gemini-2.0-flash": { meanScore: 0.5, samples: 20 }, // below floor
      }),
    });
    // gemini is cheapest but fails the floor → gpt-4o-mini (cheaper than gpt-4o) wins.
    expect(chosen).toEqual(MID);
  });

  it("treats an unproven (few-sample) cheap model as eligible for exploration", () => {
    const routing = mustParseRoutingConfig({
      routing: {
        strategy: "quality-aware",
        minQualityScore: 0.7,
        minQualitySamples: 5,
        candidates: [PREMIUM, CHEAP],
      },
    });
    const chosen = selectModel(routing, {
      pricing: PRICING,
      qualityStats: stats({
        "openai/gpt-4o": { meanScore: 0.95, samples: 50 },
        "google/gemini-2.0-flash": { meanScore: 0.2, samples: 2 }, // too few samples → explored
      }),
    });
    expect(chosen).toEqual(CHEAP);
  });

  it("falls back to the best-scoring model when none clears the floor", () => {
    const routing = mustParseRoutingConfig({
      routing: {
        strategy: "quality-aware",
        minQualityScore: 0.9,
        minQualitySamples: 3,
        candidates: [CHEAP, MID],
      },
    });
    const chosen = selectModel(routing, {
      pricing: PRICING,
      qualityStats: stats({
        "google/gemini-2.0-flash": { meanScore: 0.6, samples: 10 },
        "openai/gpt-4o-mini": { meanScore: 0.75, samples: 10 },
      }),
    });
    expect(chosen).toEqual(MID); // higher observed score
  });

  it("explores all candidates when nothing has been observed yet", () => {
    const routing = mustParseRoutingConfig({
      routing: { strategy: "quality-aware", candidates: [PREMIUM, CHEAP] },
    });
    const chosen = selectModel(routing, { pricing: PRICING });
    expect(chosen).toEqual(CHEAP); // all eligible → cheapest
  });
});

describe("ModelQualityRegistry", () => {
  it("records the first score as the initial EMA", () => {
    const reg = new ModelQualityRegistry();
    reg.record(CHEAP, 0.8);
    expect(reg.get(CHEAP)).toEqual({ meanScore: 0.8, samples: 1 });
  });

  it("blends subsequent scores via EMA and counts samples", () => {
    const reg = new ModelQualityRegistry({ alpha: 0.5 });
    reg.record(CHEAP, 1.0);
    reg.record(CHEAP, 0.0);
    const s = reg.get(CHEAP);
    if (s === undefined) throw new Error("expected quality stats");
    expect(s.meanScore).toBeCloseTo(0.5, 6);
    expect(s.samples).toBe(2);
  });

  it("ignores out-of-range or non-finite scores", () => {
    const reg = new ModelQualityRegistry();
    reg.record(CHEAP, 1.5);
    reg.record(CHEAP, -0.1);
    reg.record(CHEAP, Number.NaN);
    expect(reg.get(CHEAP)).toBeUndefined();
  });

  it("decays a stale score toward neutral when a half-life is set", () => {
    let now = 0;
    const reg = new ModelQualityRegistry({
      halfLifeMs: 1000,
      clock: () => now,
    });
    reg.record(CHEAP, 1.0);
    now = 1000; // one half-life later
    const decayed = reg.get(CHEAP);
    if (decayed === undefined) throw new Error("expected quality stats");
    expect(decayed.meanScore).toBeCloseTo(0.75, 6); // 1.0*0.5 + 0.5*0.5
  });

  it("provides a lookup bound to the registry usable by selectModel", () => {
    const reg = new ModelQualityRegistry();
    reg.record(PREMIUM, 0.95);
    for (let i = 0; i < 10; i++) reg.record(MID, 0.4);

    const routing = mustParseRoutingConfig({
      routing: {
        strategy: "quality-aware",
        minQualityScore: 0.7,
        minQualitySamples: 3,
        candidates: [PREMIUM, MID],
      },
    });
    const chosen = selectModel(routing, {
      pricing: PRICING,
      qualityStats: reg.lookup(),
    });
    expect(chosen).toEqual(PREMIUM); // MID regressed below floor
  });
});
