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
  requestsStructuredJson,
  recoverReasoningOnlyJson,
  resolveLlmKeepAlive,
  selectLlmTransportFetches,
} from "../llm-factory.js";
import { egressFetch, egressFetchWithoutKeepAlive } from "../../security/egress.js";
import { generateText } from "ai";
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
describe("requestsStructuredJson", () => {
  test("detects json_schema and json_object response formats", () => {
    expect(
      requestsStructuredJson(
        JSON.stringify({ response_format: { type: "json_schema" } }),
      ),
    ).toBe(true);
    expect(
      requestsStructuredJson(
        JSON.stringify({ response_format: { type: "json_object" } }),
      ),
    ).toBe(true);
  });
  test("is false for free-form requests and non-JSON bodies", () => {
    expect(requestsStructuredJson(JSON.stringify({ model: "m" }))).toBe(false);
    expect(
      requestsStructuredJson(JSON.stringify({ response_format: { type: "text" } })),
    ).toBe(false);
    expect(requestsStructuredJson("not json")).toBe(false);
    expect(requestsStructuredJson(null)).toBe(false);
  });
});
describe("recoverReasoningOnlyJson", () => {
  const doc = '{"title":"x"}';
  test("promotes reasoning_content to content when content is empty", () => {
    const payload = {
      choices: [{ message: { role: "assistant", content: "", reasoning_content: doc } }],
    };
    const out = recoverReasoningOnlyJson(payload) as typeof payload | null;
    expect(out).not.toBeNull();
    const msg = out?.choices[0]?.message as Record<string, unknown> | undefined;
    expect(msg?.content).toBe(doc);
    expect("reasoning_content" in (msg ?? {})).toBe(false);
  });
  test("also accepts the newer `reasoning` key", () => {
    const payload = {
      choices: [{ message: { role: "assistant", content: null, reasoning: doc } }],
    };
    const out = recoverReasoningOnlyJson(payload) as
      | { choices: Array<{ message: Record<string, unknown> }> }
      | null;
    expect(out?.choices[0]?.message.content).toBe(doc);
  });
  test("leaves a populated content untouched", () => {
    const payload = {
      choices: [
        { message: { role: "assistant", content: doc, reasoning_content: "thinking" } },
      ],
    };
    expect(recoverReasoningOnlyJson(payload)).toBeNull();
  });
  test("returns null when there is nothing to recover", () => {
    expect(
      recoverReasoningOnlyJson({ choices: [{ message: { content: "" } }] }),
    ).toBeNull();
    expect(recoverReasoningOnlyJson({})).toBeNull();
    expect(recoverReasoningOnlyJson(null)).toBeNull();
    expect(recoverReasoningOnlyJson("nope")).toBeNull();
  });
});

describe("createLlmProvider — connect retry and keep-alive", () => {
  afterEach(() => {
    setProviderRegistry(undefined);
  });

  const completion = () =>
    new Response(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  test("a socket reset before the response is retried once", async () => {
    setProviderRegistry([{ name: "vllm", protocol: "openai", url: "http://vllm:8000/v1" }]);
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      }
      return completion();
    }) as unknown as typeof fetch;
    const model = createLlmProvider({ provider: "vllm", model: "m" }, cfg(), {
      fetch: stub,
    });
    const result = await generateText({ model, prompt: "hi", maxRetries: 0 });
    expect(result.text).toBe("hello");
    expect(calls).toBe(2);
  });

  test("an HTTP 503 is not retried at the transport layer", async () => {
    setProviderRegistry([{ name: "vllm", protocol: "openai", url: "http://vllm:8000/v1" }]);
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "busy" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const model = createLlmProvider({ provider: "vllm", model: "m" }, cfg(), {
      fetch: stub,
    });
    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("resolveLlmKeepAlive: provider override wins over the global default", () => {
    expect(resolveLlmKeepAlive(undefined, {})).toBe(true);
    expect(resolveLlmKeepAlive(undefined, { llmHttpKeepAlive: false })).toBe(false);
    expect(resolveLlmKeepAlive({ keepAlive: true }, { llmHttpKeepAlive: false })).toBe(true);
    expect(resolveLlmKeepAlive({ keepAlive: false }, { llmHttpKeepAlive: true })).toBe(false);
    expect(resolveLlmKeepAlive({}, {})).toBe(true);
  });
});

describe("selectLlmTransportFetches — real egress choice", () => {
  test("keepAlive=false: primary and fresh are egressFetchWithoutKeepAlive", () => {
    const { primary, fresh } = selectLlmTransportFetches(false);
    expect(primary).toBe(egressFetchWithoutKeepAlive);
    expect(fresh).toBe(egressFetchWithoutKeepAlive);
  });
  test("keepAlive=true: primary egressFetch, the retry still a fresh connection", () => {
    const { primary, fresh } = selectLlmTransportFetches(true);
    expect(primary).toBe(egressFetch);
    expect(fresh).toBe(egressFetchWithoutKeepAlive);
  });
  test("a test override serves both", () => {
    const stub = (async () => new Response("")) as unknown as typeof fetch;
    expect(selectLlmTransportFetches(true, stub)).toEqual({ primary: stub, fresh: stub });
    expect(selectLlmTransportFetches(false, stub)).toEqual({ primary: stub, fresh: stub });
  });
  test("instance/env keep-alive resolution drives the choice", () => {
    const pick = (keepAlive: boolean | undefined, env: boolean | undefined) =>
      selectLlmTransportFetches(
        resolveLlmKeepAlive(
          keepAlive === undefined ? {} : { keepAlive },
          env === undefined ? {} : { llmHttpKeepAlive: env },
        ),
      ).primary;
    expect(pick(undefined, undefined)).toBe(egressFetch);
    expect(pick(undefined, false)).toBe(egressFetchWithoutKeepAlive);
    expect(pick(true, false)).toBe(egressFetch);
    expect(pick(false, true)).toBe(egressFetchWithoutKeepAlive);
  });
});
