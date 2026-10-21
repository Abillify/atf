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
  CONTEXT_OUTPUT_SAFETY_TOKENS,
  charsPerTokenFor,
  effectiveInputBudget,
  estimateMessageTokens,
  estimateMessagesTokens,
  measureContextPressure,
  readContextLengthOverride,
  resolveContextWindow,
  setDefaultCharsPerToken,
  truncateMessagesToWindow,
} from "../context-window.js";
import { budgetForContextWindow } from "../tool-result-budget.js";
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

describe("truncateMessagesToWindow", () => {
  function sys(text: string): ModelMessage {
    return { role: "system", content: text } as ModelMessage;
  }
  function user(text: string): ModelMessage {
    return { role: "user", content: text } as ModelMessage;
  }

  test("returns the input unchanged when the window is unknown", () => {
    const messages = [sys("x".repeat(400_000)), user("frage")];
    const result = truncateMessagesToWindow(
      messages,
      cfg("openai", "local-unknown"),
      1_000,
    );
    expect(result.truncated).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.removedChars).toBe(0);
  });

  test("returns the input unchanged when the prompt already fits", () => {
    const messages = [sys("kurzer kontext"), user("frage")];
    const result = truncateMessagesToWindow(
      messages,
      cfg("openai", "local", { contextLength: 128_000 }),
      8_000,
    );
    expect(result.truncated).toBe(false);
    expect(result.messages).toBe(messages);
  });

  test("shrinks an oversized prompt to fit window minus output reservation", () => {
    // ~128k tokens of context in one message; window 128k, reserve 12k output.
    const oversized = "a".repeat(512_000); // ~128k tokens at 4 chars/token
    const messages = [sys(oversized), user("die eigentliche frage")];
    const contextLength = 128_000;
    const reserve = 12_288;
    const result = truncateMessagesToWindow(
      messages,
      cfg("openai", "local", { contextLength }),
      reserve,
    );

    expect(result.truncated).toBe(true);
    expect(result.truncatedMessages).toBe(1);
    expect(result.removedChars).toBeGreaterThan(0);
    // The surviving prompt must leave room for the full output reservation.
    expect(result.estimatedTokensAfter).toBeLessThanOrEqual(contextLength - reserve);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
  });

  test("never truncates the final message (the current task)", () => {
    const oversized = "a".repeat(512_000);
    const question = "die eigentliche frage bleibt vollstaendig erhalten";
    const messages = [sys(oversized), user(question)];
    const result = truncateMessagesToWindow(
      messages,
      cfg("openai", "local", { contextLength: 128_000 }),
      12_288,
    );

    expect(result.truncated).toBe(true);
    const last = result.messages[result.messages.length - 1];
    expect(last?.content).toBe(question);
  });

  test("preserves head and tail of a truncated message around a marker", () => {
    const head = "KOPF_MARKIERUNG_START";
    const tail = "SCHWANZ_MARKIERUNG_ENDE";
    const oversized = `${head}${"a".repeat(512_000)}${tail}`;
    const messages = [sys(oversized), user("frage")];
    const result = truncateMessagesToWindow(
      messages,
      cfg("openai", "local", { contextLength: 128_000 }),
      12_288,
    );

    expect(result.truncated).toBe(true);
    const shortened = result.messages[0]?.content as string;
    expect(shortened.startsWith(head)).toBe(true);
    expect(shortened.endsWith(tail)).toBe(true);
    expect(shortened).toContain("gekürzt");
  });

  test("is deterministic — identical input yields byte-identical output", () => {
    const messages = [sys("a".repeat(512_000)), user("frage")];
    const first = truncateMessagesToWindow(
      messages,
      cfg("openai", "local", { contextLength: 128_000 }),
      12_288,
    );
    const second = truncateMessagesToWindow(
      messages,
      cfg("openai", "local", { contextLength: 128_000 }),
      12_288,
    );
    expect(first.messages[0]?.content).toBe(second.messages[0]?.content as string);
    expect(first.removedChars).toBe(second.removedChars);
  });

  test("cuts the largest string message first", () => {
    const big = "b".repeat(600_000);
    const small = "s".repeat(20_000);
    const messages = [sys(small), sys(big), user("frage")];
    const result = truncateMessagesToWindow(
      messages,
      cfg("openai", "local", { contextLength: 128_000 }),
      12_288,
    );

    expect(result.truncated).toBe(true);
    // The big message shrank; the small one is untouched.
    const shortenedBig = result.messages[1]?.content as string;
    expect(shortenedBig.length).toBeLessThan(big.length);
    expect(result.messages[0]?.content).toBe(small);
  });

  test("leaves image and tool-call content untouched (string-only truncation)", () => {
    const imageMessage = {
      role: "user",
      content: [{ type: "image", image: "data:image/png;base64,AAAA" }],
    } as unknown as ModelMessage;
    const oversized = "a".repeat(512_000);
    const messages = [sys(oversized), imageMessage, user("frage")];
    const result = truncateMessagesToWindow(
      messages,
      cfg("openai", "local", { contextLength: 128_000 }),
      12_288,
    );

    // The image message is not a string, so it is not the truncation target.
    expect(result.messages[1]).toBe(imageMessage);
  });
});

describe("charsPerTokenFor", () => {
  test("defaults to the exported CHARS_PER_TOKEN constant", () => {
    expect(charsPerTokenFor()).toBe(CHARS_PER_TOKEN);
    expect(charsPerTokenFor({})).toBe(CHARS_PER_TOKEN);
  });

  test("a valid node-level charsPerToken wins over the default", () => {
    expect(charsPerTokenFor({ charsPerToken: 2.5 })).toBe(2.5);
  });

  test("invalid node-level values fall back to the default", () => {
    for (const bad of [0, -1, 8.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(charsPerTokenFor({ charsPerToken: bad })).toBe(
        charsPerTokenFor(),
      );
    }
  });

  test("the process-wide default follows setDefaultCharsPerToken", () => {
    try {
      setDefaultCharsPerToken(3);
      expect(charsPerTokenFor()).toBe(3);
      // A node value still beats the env default.
      expect(charsPerTokenFor({ charsPerToken: 2.5 })).toBe(2.5);
    } finally {
      setDefaultCharsPerToken(CHARS_PER_TOKEN);
    }
  });

  test("setDefaultCharsPerToken ignores out-of-range values", () => {
    setDefaultCharsPerToken(99);
    expect(charsPerTokenFor()).toBe(CHARS_PER_TOKEN);
  });
});

describe("configurable characters-per-token estimate", () => {
  test("env default 3 scales tool-result budget chars to tokens × 3", () => {
    try {
      setDefaultCharsPerToken(3);
      const b = budgetForContextWindow(20_000);
      // Window chars = 20 000 × 3 = 60 000; fractions 0.15 / 0.3, above floors.
      expect(b.perResultChars).toBe(Math.floor(60_000 * 0.15));
      expect(b.perTurnChars).toBe(Math.floor(60_000 * 0.3));
    } finally {
      setDefaultCharsPerToken(CHARS_PER_TOKEN);
    }
  });

  test("an explicit charsPerToken argument scales the budget too", () => {
    const b = budgetForContextWindow(100_000, 2);
    expect(b.perResultChars).toBe(Math.floor(200_000 * 0.15));
  });

  test("truncation removes tokens × charsPerToken characters", () => {
    try {
      setDefaultCharsPerToken(3);
      // 300k chars = 100k tokens at 3 chars/token; window 60k tokens, no
      // reservation → 40k tokens (120k chars) must go.
      const messages = [
        { role: "system", content: "x".repeat(300_000) } as ModelMessage,
        { role: "user", content: "frage" } as ModelMessage,
      ];
      const before = estimateMessagesTokens(messages);
      const tokensToRemove =
        before - (60_000 - CONTEXT_OUTPUT_SAFETY_TOKENS);
      const result = truncateMessagesToWindow(
        messages,
        {
          provider: "openai",
          model: "local",
          parameters: { contextLength: 60_000 },
        } as LlmConfig,
        0,
      );
      expect(result.truncated).toBe(true);
      // Chars removed scale with the configured ratio (3), minus the elision
      // marker that replaces the cut span.
      expect(result.removedChars).toBeLessThanOrEqual(tokensToRemove * 3);
      expect(result.removedChars).toBeGreaterThan(tokensToRemove * 3 - 200);
    } finally {
      setDefaultCharsPerToken(CHARS_PER_TOKEN);
    }
  });

  test("node-level charsPerToken 2.5 wins over the env default", () => {
    try {
      setDefaultCharsPerToken(3);
      expect(charsPerTokenFor({ charsPerToken: 2.5 })).toBe(2.5);
      const messages = [
        { role: "system", content: "x".repeat(300_000) } as ModelMessage,
        { role: "user", content: "frage" } as ModelMessage,
      ];
      const before = estimateMessagesTokens(messages);
      const tokensToRemove =
        before - (60_000 - CONTEXT_OUTPUT_SAFETY_TOKENS);
      const result = truncateMessagesToWindow(
        messages,
        {
          provider: "openai",
          model: "local",
          parameters: { contextLength: 60_000 },
          charsPerToken: 2.5,
        } as LlmConfig,
        0,
      );
      expect(result.truncated).toBe(true);
      // Scaled by the node's 2.5, not by the env default 3.
      expect(result.removedChars).toBeLessThanOrEqual(tokensToRemove * 2.5);
      expect(result.removedChars).toBeGreaterThan(tokensToRemove * 2.5 - 200);
    } finally {
      setDefaultCharsPerToken(CHARS_PER_TOKEN);
    }
  });
});
