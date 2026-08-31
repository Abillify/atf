// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for context-window resolution and token estimation.
 *
 * These assert CONTRACTS, not the catalog: that precedence holds, that unknown
 * windows stay unknown instead of being guessed, and that the output reservation
 * is subtracted. Specific vendor token counts are deliberately not asserted —
 * they change with every model release and freezing them would only break CI.
 */

import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import type { LlmConfig } from "../../types/flow.js";
import {
  CHARS_PER_TOKEN,
  effectiveInputBudget,
  estimateMessageTokens,
  estimateMessagesTokens,
  measureContextPressure,
  readContextLengthOverride,
  resolveContextWindow,
} from "../context-window.js";
import { getModelCapabilities } from "../model-capabilities.js";

function cfg(
  provider: LlmConfig["provider"],
  model: string,
  parameters?: Record<string, unknown>,
): LlmConfig {
  return {
    provider,
    model,
    ...(parameters !== undefined ? { parameters } : {}),
  } as LlmConfig;
}

describe("readContextLengthOverride", () => {
  test("reads a positive integer from llm.parameters", () => {
    expect(readContextLengthOverride(cfg("openai", "m", { contextLength: 32768 })))
      .toBe(32768);
  });

  test("floors a fractional value", () => {
    expect(
      readContextLengthOverride(cfg("openai", "m", { contextLength: 1000.9 })),
    ).toBe(1000);
  });

  test("rejects values that would collapse every budget to its floor", () => {
    // A zero/negative/NaN window is worse than no window at all: it makes
    // every derived budget zero instead of falling back to absolute defaults.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        readContextLengthOverride(cfg("openai", "m", { contextLength: bad })),
      ).toBeUndefined();
    }
  });

  test("rejects non-numeric values", () => {
    expect(
      readContextLengthOverride(cfg("openai", "m", { contextLength: "32768" })),
    ).toBeUndefined();
  });

  test("returns undefined when absent or when there is no config", () => {
    expect(readContextLengthOverride(cfg("openai", "m"))).toBeUndefined();
    expect(readContextLengthOverride(undefined)).toBeUndefined();
  });
});

describe("resolveContextWindow", () => {
  test("an explicit override wins over the registry", () => {
    // The registry knows a cloud ceiling; the operator knows their actual
    // deployment. The operator must win.
    const withRegistry = resolveContextWindow(cfg("anthropic", "claude-x"));
    expect(withRegistry).toBeGreaterThan(0);
    expect(
      resolveContextWindow(cfg("anthropic", "claude-x", { contextLength: 8_000 })),
    ).toBe(8_000);
  });

  test("falls back to the capability registry", () => {
    expect(resolveContextWindow(cfg("anthropic", "claude-x"))).toBe(
      getModelCapabilities("anthropic", "claude-x").contextLength,
    );
  });

  test("a local model on the openai provider resolves to unknown, not a cloud value", () => {
    // This is the load-bearing case: `openai` is also how we reach LM Studio /
    // vLLM. Inheriting an OpenAI cloud window here would let a 32K local model
    // be treated as 128K and produce requests the server rejects.
    expect(resolveContextWindow(cfg("openai", "qwen3.6-35b-a3b"))).toBeUndefined();
    expect(resolveContextWindow(cfg("openai", "llama3.2:3b"))).toBeUndefined();
  });

  test("ollama resolves to unknown without an explicit override", () => {
    // Same reasoning: the window depends on how the model was pulled/loaded.
    expect(resolveContextWindow(cfg("ollama", "qwen3"))).toBeUndefined();
    expect(
      resolveContextWindow(cfg("ollama", "qwen3", { contextLength: 40_960 })),
    ).toBe(40_960);
  });

  test("returns undefined for no config at all", () => {
    expect(resolveContextWindow(undefined)).toBeUndefined();
  });
});

describe("model-capabilities contextLength invariants", () => {
  test("every declared window is a positive integer", () => {
    // Contract over catalog: whatever entries exist must be usable numbers.
    const probes: Array<[LlmConfig["provider"], string]> = [
      ["anthropic", "claude-sonnet-5"],
      ["bedrock", "anthropic.claude-haiku-4-5"],
      ["google", "gemini-2.5-pro"],
      ["openai", "gpt-4o-mini"],
      ["openai", "o3-mini"],
    ];
    for (const [provider, model] of probes) {
      const len = getModelCapabilities(provider, model).contextLength;
      expect(len).toBeDefined();
      if (len === undefined) throw new Error("expected a contextLength");
      expect(Number.isInteger(len)).toBe(true);
      expect(len).toBeGreaterThan(0);
    }
  });

  test("a model-specific rule can narrow a provider default without erasing other caps", () => {
    // sonnet-5 on bedrock overrides structuredOutput; it must still inherit the
    // provider's window and cache mode.
    const caps = getModelCapabilities("bedrock", "anthropic.claude-sonnet-5-v1");
    expect(caps.structuredOutput).toBe("prompt_validate");
    expect(caps.promptCache).toBe("bedrock");
    expect(caps.contextLength).toBeGreaterThan(0);
  });
});

describe("effectiveInputBudget", () => {
  test("subtracts the output reservation from the window", () => {
    // The completion shares the window, so the usable INPUT budget is smaller.
    expect(effectiveInputBudget(100_000, 40_000)).toBe(60_000);
  });

  test("no reservation means the full window", () => {
    expect(effectiveInputBudget(100_000)).toBe(100_000);
    expect(effectiveInputBudget(100_000, 0)).toBe(100_000);
  });

  test("an oversized reservation falls back to the raw window instead of going non-positive", () => {
    // A misconfigured maxTokens must not produce a zero/negative budget that
    // makes every downstream threshold nonsensical.
    expect(effectiveInputBudget(32_000, 32_000)).toBe(32_000);
    expect(effectiveInputBudget(32_000, 99_000)).toBe(32_000);
  });

  test("unknown window stays unknown", () => {
    expect(effectiveInputBudget(undefined, 1_000)).toBeUndefined();
    expect(effectiveInputBudget(0, 1_000)).toBeUndefined();
  });
});

describe("token estimation", () => {
  test("scales with content length at roughly CHARS_PER_TOKEN", () => {
    const text = "x".repeat(4_000);
    const tokens = estimateMessageTokens({
      role: "user",
      content: text,
    } as ModelMessage);
    const expected = 4_000 / CHARS_PER_TOKEN;
    expect(tokens).toBeGreaterThanOrEqual(expected);
    // Only the small fixed per-message overhead may be added on top.
    expect(tokens).toBeLessThan(expected + 20);
  });

  test("a longer message never estimates fewer tokens than a shorter one", () => {
    const short = estimateMessageTokens({
      role: "user",
      content: "kurz",
    } as ModelMessage);
    const long = estimateMessageTokens({
      role: "user",
      content: "kurz".repeat(500),
    } as ModelMessage);
    expect(long).toBeGreaterThan(short);
  });

  test("counts text parts of multimodal content", () => {
    const plain = estimateMessageTokens({
      role: "user",
      content: "a".repeat(400),
    } as ModelMessage);
    const parts = estimateMessageTokens({
      role: "user",
      content: [{ type: "text", text: "a".repeat(400) }],
    } as unknown as ModelMessage);
    // Same text, so the estimate must be in the same ballpark (JSON scaffolding
    // for non-text parts is absent here).
    expect(Math.abs(parts - plain)).toBeLessThan(10);
  });

  test("a message list sums its members", () => {
    const a = { role: "user", content: "x".repeat(400) } as ModelMessage;
    const b = { role: "assistant", content: "y".repeat(800) } as ModelMessage;
    expect(estimateMessagesTokens([a, b])).toBe(
      estimateMessageTokens(a) + estimateMessageTokens(b),
    );
  });

  test("empty list is zero", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

describe("measureContextPressure", () => {
  const msgs: ModelMessage[] = [
    { role: "system", content: "s".repeat(4_000) } as ModelMessage,
    { role: "user", content: "u".repeat(4_000) } as ModelMessage,
  ];

  test("reports utilization against the usable input budget", () => {
    // 8000 chars ≈ 2000 tokens; window 10_000 with 2_000 reserved → budget 8_000.
    const p = measureContextPressure(
      msgs,
      cfg("openai", "local", { contextLength: 10_000 }),
      2_000,
    );
    expect(p.contextLength).toBe(10_000);
    expect(p.inputBudget).toBe(8_000);
    expect(p.utilization).toBeCloseTo(p.estimatedTokens / 8_000, 5);
  });

  test("utilization is undefined for an unknown window, distinct from zero pressure", () => {
    // "cannot tell" must not read as "plenty of room".
    const p = measureContextPressure(msgs, cfg("openai", "qwen3.6-35b-a3b"));
    expect(p.estimatedTokens).toBeGreaterThan(0);
    expect(p.contextLength).toBeUndefined();
    expect(p.inputBudget).toBeUndefined();
    expect(p.utilization).toBeUndefined();
  });

  test("utilization above 1 signals an expected provider rejection", () => {
    const p = measureContextPressure(
      msgs,
      cfg("openai", "local", { contextLength: 500 }),
    );
    expect(p.utilization).toBeGreaterThan(1);
  });
});
