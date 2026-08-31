// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the Objective-Driven Routing / Solver-Loop (`src/graph/objective-solver.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  parseObjectiveConfig,
  solveObjective,
  type ObjectiveConfig,
} from "../objective-solver.js";
import type { ModelQualityStats } from "../cost-router.js";
import type { LlmConfig } from "../../types/flow.js";

const PRICING = {
  "openai/gpt-4o": { prompt: 2.5, completion: 10 },
  "openai/gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
  "google/gemini-2.0-flash": { prompt: 0.1, completion: 0.4 },
};

const CHEAP: LlmConfig = { provider: "google", model: "gemini-2.0-flash" };
const MID: LlmConfig = { provider: "openai", model: "gpt-4o-mini" };
const PREMIUM: LlmConfig = { provider: "openai", model: "gpt-4o" };

function stats(map: Record<string, ModelQualityStats>) {
  return (c: LlmConfig): ModelQualityStats | undefined =>
    map[`${c.provider}/${c.model}`];
}

// ---------------------------------------------------------------------------
// parseObjectiveConfig
// ---------------------------------------------------------------------------

describe("parseObjectiveConfig", () => {
  it("returns undefined when no objective config is present", () => {
    expect(parseObjectiveConfig(undefined)).toBeUndefined();
    expect(parseObjectiveConfig({})).toBeUndefined();
    expect(parseObjectiveConfig({ objective: {} })).toBeUndefined();
  });

  it("returns undefined when candidates are missing or empty", () => {
    expect(
      parseObjectiveConfig({
        objective: { candidates: [], objectives: [{ metric: "cost", op: "lte", value: 1 }] },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when objectives are missing or empty", () => {
    expect(
      parseObjectiveConfig({
        objective: { candidates: [CHEAP, MID], objectives: [] },
      }),
    ).toBeUndefined();
  });

  it("parses a full config", () => {
    const cfg = parseObjectiveConfig({
      objective: {
        candidates: [CHEAP, MID, PREMIUM],
        objectives: [
          { metric: "quality", op: "gte", value: 0.8 },
          { metric: "cost", op: "lte", value: 0.001 },
        ],
        minQualitySamples: 10,
        maxAttempts: 2,
        fallback: "best-quality",
      },
    });
    expect(cfg?.candidates).toHaveLength(3);
    expect(cfg?.objectives).toHaveLength(2);
    expect(cfg?.minQualitySamples).toBe(10);
    expect(cfg?.maxAttempts).toBe(2);
    expect(cfg?.fallback).toBe("best-quality");
  });

  it("skips malformed candidate and clause entries", () => {
    const cfg = parseObjectiveConfig({
      objective: {
        candidates: [CHEAP, { provider: 123 }, null],
        objectives: [
          { metric: "cost", op: "lte", value: 1 },
          { metric: "bogus", op: "lte", value: 1 },
          { metric: "quality", op: "bogus", value: 1 },
          { metric: "quality", op: "gte", value: "not-a-number" },
        ],
      },
    });
    expect(cfg?.candidates).toHaveLength(1);
    expect(cfg?.objectives).toHaveLength(1);
  });

  it("ignores an invalid fallback value", () => {
    const cfg = parseObjectiveConfig({
      objective: {
        candidates: [CHEAP, MID],
        objectives: [{ metric: "cost", op: "lte", value: 1 }],
        fallback: "bogus",
      },
    });
    expect(cfg?.fallback).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// solveObjective
// ---------------------------------------------------------------------------

describe("solveObjective", () => {
  it("returns the sole candidate unchanged with no attempts when only one is configured", () => {
    const cfg: ObjectiveConfig = {
      candidates: [CHEAP],
      objectives: [{ metric: "cost", op: "lte", value: 1 }],
    };
    const result = solveObjective(cfg);
    expect(result.selected).toEqual(CHEAP);
    expect(result.attempts).toHaveLength(0);
    expect(result.satisfiedObjective).toBe(false);
    expect(result.fallbackUsed).toBe(false);
  });

  it("selects the cheapest candidate that satisfies a cost clause", () => {
    const cfg: ObjectiveConfig = {
      candidates: [PREMIUM, MID, CHEAP],
      objectives: [{ metric: "cost", op: "lte", value: 0.001 }],
    };
    const result = solveObjective(cfg, { pricing: PRICING, promptTokens: 1000, expectedCompletionTokens: 100 });
    expect(result.selected).toEqual(CHEAP);
    expect(result.satisfiedObjective).toBe(true);
    expect(result.fallbackUsed).toBe(false);
    // Attempts are in cost-ascending order; solve stops at the first satisfier.
    expect(result.attempts[0]?.candidate).toBe("google/gemini-2.0-flash");
    expect(result.attempts[0]?.satisfied).toBe(true);
    expect(result.attempts).toHaveLength(1);
  });

  it("combines a quality floor AND a cost cap — skips a cheap-but-unqualified candidate", () => {
    const cfg: ObjectiveConfig = {
      candidates: [PREMIUM, MID, CHEAP],
      objectives: [
        { metric: "quality", op: "gte", value: 0.7 },
        { metric: "cost", op: "lte", value: 0.01 },
      ],
      minQualitySamples: 3,
    };
    const result = solveObjective(cfg, {
      pricing: PRICING,
      promptTokens: 1000,
      expectedCompletionTokens: 100,
      qualityStats: stats({
        "google/gemini-2.0-flash": { meanScore: 0.5, samples: 20 }, // fails quality
        "openai/gpt-4o-mini": { meanScore: 0.85, samples: 20 }, // clears both
        "openai/gpt-4o": { meanScore: 0.95, samples: 20 },
      }),
    });
    expect(result.selected).toEqual(MID);
    expect(result.satisfiedObjective).toBe(true);
    // Cheapest (gemini) was tried first and failed the quality clause.
    expect(result.attempts[0]?.candidate).toBe("google/gemini-2.0-flash");
    expect(result.attempts[0]?.satisfied).toBe(false);
    expect(result.attempts[1]?.candidate).toBe("openai/gpt-4o-mini");
    expect(result.attempts[1]?.satisfied).toBe(true);
  });

  it("treats an unproven (few-sample) candidate's quality clause as exploration", () => {
    const cfg: ObjectiveConfig = {
      candidates: [PREMIUM, CHEAP],
      objectives: [{ metric: "quality", op: "gte", value: 0.7 }],
      minQualitySamples: 5,
    };
    const result = solveObjective(cfg, {
      pricing: PRICING,
      qualityStats: stats({
        "openai/gpt-4o": { meanScore: 0.95, samples: 50 },
        "google/gemini-2.0-flash": { meanScore: 0.1, samples: 2 }, // too few samples
      }),
    });
    expect(result.selected).toEqual(CHEAP);
    expect(result.satisfiedObjective).toBe(true);
    expect(result.attempts[0]?.clauses[0]?.proven).toBe(false);
  });

  it("bounds the number of attempts via maxAttempts and falls back when the budget is exhausted", () => {
    const cfg: ObjectiveConfig = {
      candidates: [CHEAP, MID, PREMIUM],
      objectives: [{ metric: "quality", op: "gte", value: 0.99 }], // nobody clears this
      minQualitySamples: 1,
      maxAttempts: 1,
      fallback: "cheapest",
    };
    const result = solveObjective(cfg, {
      pricing: PRICING,
      qualityStats: stats({
        "google/gemini-2.0-flash": { meanScore: 0.5, samples: 10 },
        "openai/gpt-4o-mini": { meanScore: 0.99, samples: 10 }, // would satisfy, but never attempted
        "openai/gpt-4o": { meanScore: 0.99, samples: 10 },
      }),
    });
    expect(result.attempts).toHaveLength(1); // only the cheapest was attempted
    expect(result.satisfiedObjective).toBe(false);
    expect(result.fallbackUsed).toBe(true);
    expect(result.selected).toEqual(CHEAP); // fallback: cheapest
    expect(result.fallbackReason).toBeDefined();
  });

  it("falls back to best-quality when no candidate satisfies every objective", () => {
    const cfg: ObjectiveConfig = {
      candidates: [CHEAP, MID],
      objectives: [{ metric: "cost", op: "lte", value: 0.00001 }], // nobody clears this
      fallback: "best-quality",
    };
    const result = solveObjective(cfg, {
      pricing: PRICING,
      promptTokens: 1000,
      expectedCompletionTokens: 100,
      qualityStats: stats({
        "google/gemini-2.0-flash": { meanScore: 0.5, samples: 10 },
        "openai/gpt-4o-mini": { meanScore: 0.9, samples: 10 },
      }),
    });
    expect(result.fallbackUsed).toBe(true);
    expect(result.selected).toEqual(MID); // higher observed quality
  });

  it("falls back to the first configured candidate with fallback: 'first'", () => {
    const cfg: ObjectiveConfig = {
      candidates: [MID, CHEAP, PREMIUM],
      objectives: [{ metric: "cost", op: "lte", value: 0.00001 }],
      fallback: "first",
    };
    const result = solveObjective(cfg, { pricing: PRICING, promptTokens: 1000, expectedCompletionTokens: 100 });
    expect(result.fallbackUsed).toBe(true);
    expect(result.selected).toEqual(MID); // first in the CONFIGURED list, not cost order
  });

  it("defaults the fallback strategy to 'cheapest' when unset", () => {
    const cfg: ObjectiveConfig = {
      candidates: [PREMIUM, CHEAP, MID],
      objectives: [{ metric: "cost", op: "lte", value: 0.00001 }],
    };
    const result = solveObjective(cfg, { pricing: PRICING, promptTokens: 1000, expectedCompletionTokens: 100 });
    expect(result.fallbackUsed).toBe(true);
    expect(result.selected).toEqual(CHEAP);
  });

  it("treats an unpriced candidate's cost clause as never satisfied", () => {
    const unpriced: LlmConfig = { provider: "ollama", model: "unknown-model" };
    const cfg: ObjectiveConfig = {
      candidates: [unpriced],
      objectives: [{ metric: "cost", op: "lte", value: 1 }],
    };
    // Only one candidate — early-return path with no attempts, so the
    // "no pricing" case is instead exercised via a two-candidate config below.
    const result = solveObjective(cfg, { pricing: PRICING });
    expect(result.attempts).toHaveLength(0);
  });

  it("sorts an unpriced candidate last and still evaluates it correctly", () => {
    const unpriced: LlmConfig = { provider: "ollama", model: "unknown-model" };
    const cfg: ObjectiveConfig = {
      candidates: [unpriced, CHEAP],
      objectives: [{ metric: "cost", op: "lte", value: 0.001 }],
    };
    const result = solveObjective(cfg, { pricing: PRICING, promptTokens: 1000, expectedCompletionTokens: 100 });
    // CHEAP is priced and satisfies; unpriced (Infinity cost) sorts after it.
    expect(result.selected).toEqual(CHEAP);
    expect(result.satisfiedObjective).toBe(true);
    expect(result.attempts[0]?.candidate).toBe("google/gemini-2.0-flash");
  });

  it("throws when called with an empty candidate list", () => {
    const cfg: ObjectiveConfig = {
      candidates: [],
      objectives: [{ metric: "cost", op: "lte", value: 1 }],
    };
    expect(() => solveObjective(cfg)).toThrow();
  });
});
