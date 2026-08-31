// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for cost estimation + per-tenant budget tracking (src/observability/cost.ts)
 */

import { describe, test, expect } from "bun:test";
import { estimateCost, resolveModelPrice, CostTracker } from "../cost.js";

describe("estimateCost", () => {
  test("computes cost from the built-in pricing table", () => {
    // gpt-4o: $2.5 / 1M prompt, $10 / 1M completion
    const cost = estimateCost("openai", "gpt-4o", {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
    });
    expect(cost).toBe(12.5);
  });

  test("returns 0 for unknown / local models", () => {
    const cost = estimateCost("ollama", "llama3.2:3b", {
      prompt_tokens: 5000,
      completion_tokens: 5000,
    });
    expect(cost).toBe(0);
  });

  test("honours overrides keyed by provider/model", () => {
    const cost = estimateCost(
      "openai",
      "custom",
      { prompt_tokens: 1_000_000, completion_tokens: 0 },
      { "openai/custom": { prompt: 7, completion: 21 } },
    );
    expect(cost).toBe(7);
  });

  test("scales linearly and rounds to micro-dollars", () => {
    const cost = estimateCost("openai", "gpt-4o-mini", {
      prompt_tokens: 1000,
      completion_tokens: 1000,
    });
    // 1000/1e6 * 0.15 + 1000/1e6 * 0.6 = 0.00015 + 0.0006 = 0.00075
    expect(cost).toBeCloseTo(0.00075, 6);
  });
});

describe("resolveModelPrice", () => {
  test("falls back to zero price for unknown models", () => {
    expect(resolveModelPrice("openai", "does-not-exist")).toEqual({
      prompt: 0,
      completion: 0,
    });
  });
});

describe("CostTracker", () => {
  test("allows when no cap is configured", () => {
    const t = new CostTracker(0);
    t.record("acme", 9999);
    expect(t.check("acme").allowed).toBe(true);
    t.stop();
  });

  test("blocks a tenant once it exceeds the daily cap", () => {
    const t = new CostTracker(1.0);
    expect(t.check("acme").allowed).toBe(true);
    t.record("acme", 0.5);
    expect(t.check("acme").allowed).toBe(true);
    t.record("acme", 0.75); // total 1.25 > 1.0
    const decision = t.check("acme");
    expect(decision.allowed).toBe(false);
    expect(decision.spent).toBeCloseTo(1.25, 6);
    expect(decision.cap).toBe(1.0);
    t.stop();
  });

  test("isolates spend per tenant", () => {
    const t = new CostTracker(1.0);
    t.record("a", 2.0);
    expect(t.check("a").allowed).toBe(false);
    expect(t.check("b").allowed).toBe(true);
    t.stop();
  });

  test("uses 'default' bucket when tenant is undefined", () => {
    const t = new CostTracker(1.0);
    t.record(undefined, 2.0);
    expect(t.check(undefined).allowed).toBe(false);
    const snap = t.snapshot();
    expect(snap.some((s) => s.tenant === "default")).toBe(true);
    t.stop();
  });

  test("snapshot reports spend per tenant", () => {
    const t = new CostTracker(5);
    t.record("x", 1.23);
    const snap = t.snapshot();
    const x = snap.find((s) => s.tenant === "x");
    expect(x?.spent).toBeCloseTo(1.23, 6);
    t.stop();
  });
});
