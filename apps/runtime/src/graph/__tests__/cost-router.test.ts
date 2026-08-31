// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the cost-based model router (`src/graph/cost-router.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  parseRoutingConfig,
  selectModel,
  type RoutingConfig,
} from "../cost-router.js";
import type { LlmConfig } from "../../types/flow.js";

describe("parseRoutingConfig", () => {
  it("returns undefined when no routing config is present", () => {
    expect(parseRoutingConfig(undefined)).toBeUndefined();
    expect(parseRoutingConfig({})).toBeUndefined();
    expect(parseRoutingConfig({ routing: { candidates: [] } })).toBeUndefined();
  });

  it("parses candidates and defaults strategy to cheapest", () => {
    const cfg = parseRoutingConfig({
      routing: {
        candidates: [
          { provider: "openai", model: "gpt-4o-mini" },
          { provider: "google", model: "gemini-2.0-flash" },
        ],
      },
    });
    expect(cfg?.strategy).toBe("cheapest");
    expect(cfg?.candidates).toHaveLength(2);
  });

  it("skips malformed candidate entries", () => {
    const cfg = parseRoutingConfig({
      routing: {
        strategy: "balanced",
        candidates: [
          { provider: "openai", model: "gpt-4o" },
          { provider: 123 },
          null,
        ],
      },
    });
    expect(cfg?.strategy).toBe("balanced");
    expect(cfg?.candidates).toHaveLength(1);
  });
});

describe("selectModel — cheapest", () => {
  const routing: RoutingConfig = {
    strategy: "cheapest",
    candidates: [
      { provider: "openai", model: "gpt-4o" }, // 2.5 + 10 = 12.5
      { provider: "google", model: "gemini-2.0-flash" }, // 0.1 + 0.4 = 0.5
      { provider: "openai", model: "gpt-4o-mini" }, // 0.15 + 0.6 = 0.75
    ],
  };

  it("picks the lowest blended price from the built-in table", () => {
    const chosen = selectModel(routing);
    expect(chosen.model).toBe("gemini-2.0-flash");
  });

  it("returns the single candidate without pricing lookup", () => {
    const only: LlmConfig = { provider: "ollama", model: "llama3" };
    expect(selectModel({ candidates: [only] }).model).toBe("llama3");
  });

  it("falls back to the first candidate when none can be priced", () => {
    const r: RoutingConfig = {
      strategy: "cheapest",
      candidates: [
        { provider: "ollama", model: "unknown-a" },
        { provider: "ollama", model: "unknown-b" },
      ],
    };
    expect(selectModel(r).model).toBe("unknown-a");
  });
});

describe("selectModel — balanced", () => {
  it("ranks by estimated cost for the actual prompt size", () => {
    // Model A: cheap prompt, pricey completion. Model B: pricey prompt, cheap completion.
    const pricing = {
      "openai/a": { prompt: 0.1, completion: 100 },
      "openai/b": { prompt: 100, completion: 0.1 },
    };
    const routing: RoutingConfig = {
      strategy: "balanced",
      candidates: [
        { provider: "openai", model: "a" },
        { provider: "openai", model: "b" },
      ],
    };
    // Large prompt, tiny completion → B's pricey prompt dominates → pick A.
    const chosen = selectModel(routing, {
      promptTokens: 1_000_000,
      expectedCompletionTokens: 1,
      pricing,
    });
    expect(chosen.model).toBe("a");
  });
});
