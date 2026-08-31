// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for FinOps forecasting + CO2/ESG accounting (`src/observability/finops.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  linearTrendSlope,
  forecastBudget,
  resolveEnergyFactor,
  estimateCo2,
  co2Report,
  type DailySpendPoint,
} from "../finops.js";

describe("linearTrendSlope", () => {
  it("returns 0 for fewer than 2 points", () => {
    expect(linearTrendSlope([])).toBe(0);
    expect(linearTrendSlope([{ day: "2026-01-01", cost: 5 }])).toBe(0);
  });

  it("fits a positive slope for a rising trend", () => {
    const points: DailySpendPoint[] = [
      { day: "2026-01-01", cost: 1 },
      { day: "2026-01-02", cost: 2 },
      { day: "2026-01-03", cost: 3 },
      { day: "2026-01-04", cost: 4 },
    ];
    expect(linearTrendSlope(points)).toBeCloseTo(1, 5);
  });

  it("fits ~0 slope for flat spend", () => {
    const points: DailySpendPoint[] = [
      { day: "2026-01-01", cost: 5 },
      { day: "2026-01-02", cost: 5 },
      { day: "2026-01-03", cost: 5 },
    ];
    expect(linearTrendSlope(points)).toBeCloseTo(0, 5);
  });

  it("fits a negative slope for a falling trend", () => {
    const points: DailySpendPoint[] = [
      { day: "2026-01-01", cost: 10 },
      { day: "2026-01-02", cost: 8 },
      { day: "2026-01-03", cost: 6 },
    ];
    expect(linearTrendSlope(points)).toBeCloseTo(-2, 5);
  });
});

describe("forecastBudget", () => {
  it("reports 'unbounded' when there is no cap", () => {
    const f = forecastBudget("acme", undefined, 10, 0);
    expect(f.status).toBe("unbounded");
    expect(f.daysToExhaustion).toBeUndefined();
  });

  it("reports 'insufficient_data' with too little history", () => {
    const f = forecastBudget(
      "acme",
      [{ day: "2026-01-01", cost: 1 }],
      1,
      50,
    );
    expect(f.status).toBe("insufficient_data");
  });

  it("reports 'stable' when spend is flat/decreasing and well below the cap", () => {
    const series: DailySpendPoint[] = [
      { day: "2026-01-01", cost: 5 },
      { day: "2026-01-02", cost: 5 },
      { day: "2026-01-03", cost: 5 },
    ];
    const f = forecastBudget("acme", series, 5, 50);
    expect(f.status).toBe("stable");
    expect(f.dailyBurnRate).toBe(5); // the LEVEL, not the (zero) trend
    expect(f.dailyTrend).toBe(0);
  });

  it("flags 'at_risk' for FLAT spend sitting near the cap (the slope-only blind spot)", () => {
    const series: DailySpendPoint[] = [
      { day: "2026-01-01", cost: 48 },
      { day: "2026-01-02", cost: 48 },
      { day: "2026-01-03", cost: 48 },
    ];
    // Flat (trend 0) but 48/50 = 96% of the cap every day → must be at_risk.
    const f = forecastBudget("acme", series, 48, 50);
    expect(f.status).toBe("at_risk");
    expect(f.dailyBurnRate).toBe(48);
    expect(f.dailyTrend).toBe(0);
  });

  it("flags 'at_risk' when the current level already meets/exceeds the cap", () => {
    const series: DailySpendPoint[] = [
      { day: "2026-01-01", cost: 40 },
      { day: "2026-01-02", cost: 45 },
      { day: "2026-01-03", cost: 55 },
    ];
    const f = forecastBudget("acme", series, 55, 50);
    expect(f.status).toBe("at_risk");
    expect(f.daysToExhaustion).toBe(0);
  });

  it("projects a rising trend crossing the cap and flags 'at_risk' within the window", () => {
    const series: DailySpendPoint[] = [
      { day: "2026-01-01", cost: 10 },
      { day: "2026-01-02", cost: 20 },
      { day: "2026-01-03", cost: 30 },
    ];
    // Trend ~10/day; currentLevel 45, cap 50 → (50-45)/10 = 0.5 days.
    const f = forecastBudget("acme", series, 45, 50, { atRiskWindowDays: 3 });
    expect(f.status).toBe("at_risk");
    expect(f.dailyTrend).toBeCloseTo(10, 3);
    expect(f.dailyBurnRate).toBeCloseTo(20, 3); // mean level, not the slope
    expect(f.daysToExhaustion).toBeCloseTo(0.5, 2);
    expect(f.projectedExhaustionDate).toBeDefined();
  });

  it("classifies a distant projected crossing as 'on_track'", () => {
    const series: DailySpendPoint[] = [
      { day: "2026-01-01", cost: 1 },
      { day: "2026-01-02", cost: 2 },
      { day: "2026-01-03", cost: 3 },
    ];
    // Trend ~1/day; currentLevel 3, cap 100 → 97 days.
    const f = forecastBudget("acme", series, 3, 100, { atRiskWindowDays: 3 });
    expect(f.status).toBe("on_track");
    expect(f.daysToExhaustion).toBeGreaterThan(3);
  });
});

describe("resolveEnergyFactor", () => {
  it("resolves a model-specific factor over the provider default", () => {
    const mini = resolveEnergyFactor("openai", "gpt-4o-mini");
    const full = resolveEnergyFactor("openai", "gpt-4o");
    expect(mini).toBeLessThan(full);
  });

  it("falls back to the unknown-model default for an unmatched model", () => {
    const factor = resolveEnergyFactor("openai", "some-brand-new-model-xyz");
    expect(factor).toBeGreaterThan(0);
  });

  it("honours an override table", () => {
    const factor = resolveEnergyFactor("custom-provider", "custom-model", [
      { provider: "custom-provider", kwhPer1kTokens: 0.02 },
    ]);
    expect(factor).toBe(0.02);
  });

  it("prefers a later-declared override on tie (same convention as model-capabilities)", () => {
    const factor = resolveEnergyFactor("openai", "gpt-4o", [
      { provider: "openai", modelPattern: "*gpt-4o*", kwhPer1kTokens: 0.099 },
    ]);
    expect(factor).toBe(0.099);
  });
});

describe("estimateCo2", () => {
  it("scales with total tokens", () => {
    const small = estimateCo2("openai", "gpt-4o-mini", {
      promptTokens: 100,
      completionTokens: 100,
    });
    const large = estimateCo2("openai", "gpt-4o-mini", {
      promptTokens: 1000,
      completionTokens: 1000,
    });
    expect(large.estimatedKwh).toBeGreaterThan(small.estimatedKwh);
    expect(large.estimatedKgCo2e).toBeGreaterThan(small.estimatedKgCo2e);
  });

  it("applies the configured grid carbon intensity", () => {
    const usage = { promptTokens: 1000, completionTokens: 1000 };
    const low = estimateCo2("openai", "gpt-4o", usage, {
      gridCarbonIntensity: 0.1,
    });
    const high = estimateCo2("openai", "gpt-4o", usage, {
      gridCarbonIntensity: 0.8,
    });
    expect(high.estimatedKgCo2e).toBeGreaterThan(low.estimatedKgCo2e);
    expect(high.estimatedKwh).toBeCloseTo(low.estimatedKwh, 6);
  });

  it("returns zero emissions for zero tokens", () => {
    const result = estimateCo2("openai", "gpt-4o", {
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(result.estimatedKwh).toBe(0);
    expect(result.estimatedKgCo2e).toBe(0);
  });
});

describe("co2Report", () => {
  it("aggregates across models, sorted by descending emissions", () => {
    const report = co2Report({
      "openai/gpt-4o": { promptTokens: 100_000, completionTokens: 50_000 },
      "openai/gpt-4o-mini": { promptTokens: 1_000, completionTokens: 500 },
    });
    expect(report.byModel).toHaveLength(2);
    const first = report.byModel[0];
    if (first === undefined) throw new Error("expected a first model entry");
    expect(first.model).toBe("gpt-4o");
    expect(report.totalEstimatedKgCo2e).toBeGreaterThan(0);
    expect(report.carKmEquivalent).toBeGreaterThanOrEqual(0);
  });

  it("returns an empty report for no usage", () => {
    const report = co2Report({});
    expect(report.byModel).toHaveLength(0);
    expect(report.totalEstimatedKgCo2e).toBe(0);
    expect(report.carKmEquivalent).toBe(0);
  });

  it("handles a bare model key without a provider prefix", () => {
    const report = co2Report({
      "some-local-model": { promptTokens: 1000, completionTokens: 1000 },
    });
    expect(report.byModel).toHaveLength(1);
    const first = report.byModel[0];
    if (first === undefined) throw new Error("expected a first model entry");
    expect(first.provider).toBe("unknown");
    expect(first.model).toBe("some-local-model");
  });
});
