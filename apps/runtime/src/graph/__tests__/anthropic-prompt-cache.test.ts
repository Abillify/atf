// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `applyAnthropicPromptCache` — marks the system message with an
 * ephemeral Anthropic cache_control breakpoint so the system prefix is
 * prompt-cached across requests. Must be pure (no input mutation) and a no-op
 * when there is no system message.
 */

import { describe, test, expect } from "bun:test";
import { applyAnthropicPromptCache } from "../message-mapping.js";
import type { ModelMessage } from "ai";

describe("applyAnthropicPromptCache", () => {
  test("adds ephemeral cacheControl to the system message", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
    ];
    const out = applyAnthropicPromptCache(msgs);
    const sys = out[0] as { providerOptions?: Record<string, unknown> };
    expect(sys.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  test("leaves non-system messages untouched", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ];
    const out = applyAnthropicPromptCache(msgs);
    const secondInput = msgs[1];
    if (secondInput === undefined) throw new Error("expected a second message");
    expect(out[1]).toEqual(secondInput);
    expect(
      (out[1] as { providerOptions?: unknown }).providerOptions,
    ).toBeUndefined();
  });

  test("does not mutate the input array or messages", () => {
    const msgs: ModelMessage[] = [{ role: "system", content: "sys" }];
    const out = applyAnthropicPromptCache(msgs);
    expect(out).not.toBe(msgs);
    expect(
      (msgs[0] as { providerOptions?: unknown }).providerOptions,
    ).toBeUndefined();
  });

  test("is a no-op (content-equal) when there is no system message", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const out = applyAnthropicPromptCache(msgs);
    expect(out).toEqual(msgs);
  });

  test("preserves any existing providerOptions on the system message", () => {
    const msgs: ModelMessage[] = [
      {
        role: "system",
        content: "sys",
        providerOptions: { openai: { foo: "bar" } },
      } as ModelMessage,
    ];
    const out = applyAnthropicPromptCache(msgs);
    const sys = out[0] as { providerOptions?: Record<string, unknown> };
    expect(sys.providerOptions).toEqual({
      openai: { foo: "bar" },
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });
});

import { applyBedrockPromptCache } from "../message-mapping.js";

describe("applyBedrockPromptCache", () => {
  test("adds a default cachePoint to the system message (5m TTL by default)", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
    ];
    const out = applyBedrockPromptCache(msgs);
    const sys = out[0] as { providerOptions?: Record<string, unknown> };
    expect(sys.providerOptions).toEqual({
      bedrock: { cachePoint: { type: "default", ttl: "5m" } },
    });
  });

  test("honours an explicit 1h TTL", () => {
    const msgs: ModelMessage[] = [{ role: "system", content: "sys" }];
    const out = applyBedrockPromptCache(msgs, "1h");
    const sys = out[0] as { providerOptions?: Record<string, unknown> };
    expect(sys.providerOptions).toEqual({
      bedrock: { cachePoint: { type: "default", ttl: "1h" } },
    });
  });

  test("leaves non-system messages untouched", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ];
    const out = applyBedrockPromptCache(msgs);
    const secondInput = msgs[1];
    if (secondInput === undefined) throw new Error("expected a second message");
    expect(out[1]).toEqual(secondInput);
    expect(
      (out[1] as { providerOptions?: unknown }).providerOptions,
    ).toBeUndefined();
  });

  test("does not mutate the input array or messages", () => {
    const msgs: ModelMessage[] = [{ role: "system", content: "sys" }];
    const out = applyBedrockPromptCache(msgs);
    expect(out).not.toBe(msgs);
    expect(
      (msgs[0] as { providerOptions?: unknown }).providerOptions,
    ).toBeUndefined();
  });

  test("is a no-op (content-equal) when there is no system message", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const out = applyBedrockPromptCache(msgs);
    expect(out).toEqual(msgs);
  });

  test("preserves any existing providerOptions on the system message", () => {
    const msgs: ModelMessage[] = [
      {
        role: "system",
        content: "sys",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      } as ModelMessage,
    ];
    const out = applyBedrockPromptCache(msgs);
    const sys = out[0] as { providerOptions?: Record<string, unknown> };
    expect(sys.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
      bedrock: { cachePoint: { type: "default", ttl: "5m" } },
    });
  });
});
