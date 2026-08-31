// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the LLM provider factory — including the newly added Azure OpenAI
 * and AWS Bedrock providers.
 */

import { afterEach, describe, test, expect } from "bun:test";
import {
  createLlmProvider,
  UnknownProviderError,
  injectChatTemplateKwargs,
  injectReasoningEffort,
  injectExtraBody,
} from "../llm-factory.js";
import { setProviderRegistry } from "../../config/providers.js";
import type { AppConfig } from "../../config/index.js";
import type { LlmConfig } from "../../types/flow.js";

function cfg(overrides?: Partial<AppConfig>): AppConfig {
  return {
    port: 3000,
    flowsDir: "./flows",
    monitoringTransport: "sse",
    mcpServers: [],
    corsOrigins: ["*"],
    monitoringAuthRequired: false,
    logLevel: "info",
    maxToolSteps: 5,
    maxConcurrentExecutions: 50,
    ...overrides,
  } as AppConfig;
}

describe("injectChatTemplateKwargs", () => {
  test("merges chat_template_kwargs into a JSON string body", () => {
    const body = JSON.stringify({ model: "m", messages: [] });
    const out = injectChatTemplateKwargs(body, { enable_thinking: false });
    expect(JSON.parse(out as string)).toEqual({
      model: "m",
      messages: [],
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  test("merges with pre-existing chat_template_kwargs (new keys win)", () => {
    const body = JSON.stringify({
      chat_template_kwargs: { foo: 1, enable_thinking: true },
    });
    const out = injectChatTemplateKwargs(body, { enable_thinking: false });
    expect(JSON.parse(out as string).chat_template_kwargs).toEqual({
      foo: 1,
      enable_thinking: false,
    });
  });

  test("is a no-op for empty kwargs", () => {
    const body = JSON.stringify({ model: "m" });
    expect(injectChatTemplateKwargs(body, {})).toBe(body);
  });

  test("returns non-string bodies unchanged", () => {
    const buf = new Uint8Array([1, 2, 3]);
    expect(injectChatTemplateKwargs(buf, { enable_thinking: false })).toBe(buf);
    expect(injectChatTemplateKwargs(undefined, { enable_thinking: false })).toBe(
      undefined,
    );
  });

  test("returns a non-JSON string body unchanged (never breaks the request)", () => {
    expect(injectChatTemplateKwargs("not json", { enable_thinking: false })).toBe(
      "not json",
    );
  });
});

describe("injectReasoningEffort", () => {
  test("sets a top-level reasoning_effort on a JSON string body", () => {
    const body = JSON.stringify({ model: "m", messages: [] });
    const out = injectReasoningEffort(body, "none");
    expect(JSON.parse(out as string)).toEqual({
      model: "m",
      messages: [],
      reasoning_effort: "none",
    });
  });

  test("overwrites a pre-existing reasoning_effort", () => {
    const body = JSON.stringify({ reasoning_effort: "high" });
    const out = injectReasoningEffort(body, "none");
    expect(JSON.parse(out as string).reasoning_effort).toBe("none");
  });

  test("is a no-op for an empty effort string", () => {
    const body = JSON.stringify({ model: "m" });
    expect(injectReasoningEffort(body, "")).toBe(body);
  });

  test("returns non-string bodies unchanged", () => {
    const buf = new Uint8Array([1, 2, 3]);
    expect(injectReasoningEffort(buf, "none")).toBe(buf);
    expect(injectReasoningEffort(undefined, "none")).toBe(undefined);
  });

  test("returns a non-JSON string body unchanged (never breaks the request)", () => {
    expect(injectReasoningEffort("not json", "none")).toBe("not json");
  });
});

describe("injectExtraBody", () => {
  test("merges anti-repetition penalties verbatim into a JSON string body", () => {
    const body = JSON.stringify({ model: "m", messages: [] });
    const out = injectExtraBody(body, {
      repeat_penalty: 1.15,
      frequency_penalty: 0.4,
      presence_penalty: 0.3,
    });
    expect(JSON.parse(out as string)).toEqual({
      model: "m",
      messages: [],
      repeat_penalty: 1.15,
      frequency_penalty: 0.4,
      presence_penalty: 0.3,
    });
  });

  test("overwrites pre-existing top-level fields", () => {
    const body = JSON.stringify({ repeat_penalty: 1.0, keep: "me" });
    const out = injectExtraBody(body, { repeat_penalty: 1.2 });
    expect(JSON.parse(out as string)).toEqual({
      repeat_penalty: 1.2,
      keep: "me",
    });
  });

  test("is a no-op for empty fields", () => {
    const body = JSON.stringify({ model: "m" });
    expect(injectExtraBody(body, {})).toBe(body);
  });

  test("returns non-string bodies unchanged", () => {
    const buf = new Uint8Array([1, 2, 3]);
    expect(injectExtraBody(buf, { repeat_penalty: 1.1 })).toBe(buf);
    expect(injectExtraBody(undefined, { repeat_penalty: 1.1 })).toBe(undefined);
  });

  test("returns a non-JSON string body unchanged (never breaks the request)", () => {
    expect(injectExtraBody("not json", { repeat_penalty: 1.1 })).toBe(
      "not json",
    );
  });
});

// Endpoints and credentials come from named PROVIDERS entries; the protocol only
// selects the SDK client. See config/__tests__/providers.test.ts for the routing
// assertions (which URL a named instance actually reaches).
describe("createLlmProvider — protocols via named providers", () => {
  afterEach(() => {
    setProviderRegistry(undefined);
  });

  test("openai returns a model", () => {
    setProviderRegistry([
      { name: "vllm", protocol: "openai", url: "http://vllm:8000/v1", apiKey: "sk-x" },
    ]);
    const m = createLlmProvider({ provider: "vllm", model: "gpt-4o-mini" }, cfg());
    expect(m).toBeDefined();
    expect((m as { provider?: string }).provider).toBe("openai.chat");
  });

  test("google returns a model", () => {
    setProviderRegistry([{ name: "gemini", protocol: "google", apiKey: "x" }]);
    const m = createLlmProvider(
      { provider: "gemini", model: "gemini-2.0-flash" },
      cfg(),
    );
    expect(m).toBeDefined();
  });

  test("ollama returns a model", () => {
    setProviderRegistry([
      { name: "ollama-box", protocol: "ollama", url: "http://localhost:11434" },
    ]);
    const m = createLlmProvider(
      { provider: "ollama-box", model: "llama3.2:3b" },
      cfg(),
    );
    expect(m).toBeDefined();
    expect((m as { provider?: string }).provider).toBe("openai.chat");
  });

  test("constructs an Azure model from resource name + key", () => {
    setProviderRegistry([
      {
        name: "az",
        protocol: "azure",
        resourceName: "my-resource",
        apiKey: "az-key",
        apiVersion: "2024-10-01-preview",
      },
    ]);
    const m = createLlmProvider({ provider: "az", model: "my-deployment" }, cfg());
    expect(m).toBeDefined();
  });

  test("constructs an Azure model from an explicit base URL", () => {
    setProviderRegistry([
      {
        name: "az",
        protocol: "azure",
        url: "https://example.openai.azure.com",
        apiKey: "k",
      },
    ]);
    const m = createLlmProvider({ provider: "az", model: "dep" }, cfg());
    expect(m).toBeDefined();
  });

  test("constructs a Bedrock model from region + static creds", () => {
    setProviderRegistry([
      {
        name: "aws",
        protocol: "bedrock",
        region: "us-east-1",
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
      },
    ]);
    const m = createLlmProvider(
      { provider: "aws", model: "anthropic.claude-3-5-haiku-20241022-v1:0" },
      cfg(),
    );
    expect(m).toBeDefined();
  });

  test("constructs an Anthropic model, optionally through a gateway URL", () => {
    setProviderRegistry([
      { name: "claude", protocol: "anthropic", apiKey: "sk-ant-x" },
      {
        name: "claude-gw",
        protocol: "anthropic",
        apiKey: "sk-ant-x",
        url: "https://gw.example.com",
      },
    ]);
    expect(
      createLlmProvider({ provider: "claude", model: "claude-3-5-sonnet-latest" }, cfg()),
    ).toBeDefined();
    expect(
      createLlmProvider({ provider: "claude-gw", model: "claude-3-5-haiku-latest" }, cfg()),
    ).toBeDefined();
  });

  test("uses a per-call override key (pool / BYOK)", () => {
    setProviderRegistry([{ name: "claude", protocol: "anthropic" }]);
    const m = createLlmProvider(
      { provider: "claude", model: "claude-3-5-sonnet-latest" },
      cfg(),
      { apiKey: "sk-ant-override" },
    );
    expect(m).toBeDefined();
  });
});

describe("createLlmProvider — unknown provider", () => {
  test("throws UnknownProviderError", () => {
    const bad = { provider: "made-up", model: "x" } as unknown as LlmConfig;
    expect(() => createLlmProvider(bad, cfg())).toThrow(UnknownProviderError);
  });
});
