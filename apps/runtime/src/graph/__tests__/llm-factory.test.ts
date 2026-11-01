// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the LLM provider factory — including the newly added Azure OpenAI
 * and AWS Bedrock providers.
 */

import { afterEach, describe, test, expect } from "bun:test";
import {
  createLlmProvider,
  createImageProvider,
  makeImageFetch,
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
import { generateText, generateImage } from "ai";
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

// ---------------------------------------------------------------------------
// createImageProvider — the OpenAI *images* API surface
//
// A self-hosted image server (mflux on the Mac Studio, reached through a
// gateway) implements /v1/images/generations and /v1/images/edits and nothing
// else. The factory must hand back an ImageModelV4 on the same transport
// discipline as chat, and refuse a protocol that has no such endpoint instead
// of silently producing a model that can never answer.
// ---------------------------------------------------------------------------

describe("createImageProvider", () => {
  afterEach(() => {
    setProviderRegistry(undefined);
  });

  test("an openai provider yields an image model for the configured model id", () => {
    setProviderRegistry([
      { name: "litellm", protocol: "openai", url: "http://gateway:4000/v1", apiKey: "k" },
    ]);
    const m = createImageProvider({ provider: "litellm", model: "qwen-image" }, cfg());
    expect(m.specificationVersion).toBe("v4");
    expect(m.provider).toBe("openai.image");
    expect(m.modelId).toBe("qwen-image");
  });

  test("a protocol without an images endpoint is refused by name", () => {
    setProviderRegistry([
      { name: "gemini", protocol: "google", apiKey: "x" },
      { name: "aws", protocol: "bedrock", region: "eu-central-1" },
      { name: "claude", protocol: "anthropic", apiKey: "y" },
    ]);
    for (const provider of ["gemini", "aws", "claude"]) {
      expect(() =>
        createImageProvider({ provider, model: "m" }, cfg()),
      ).toThrow(/images endpoint/);
    }
  });

  test("an unresolvable provider throws UnknownProviderError", () => {
    setProviderRegistry([]);
    expect(() =>
      createImageProvider({ provider: "nope", model: "m" }, cfg()),
    ).toThrow(UnknownProviderError);
  });

  test("an ollama host is normalised to its OpenAI-compatible /v1", () => {
    setProviderRegistry([
      { name: "ollama-box", protocol: "ollama", url: "http://box:11434" },
      { name: "ollama-v1", protocol: "ollama", url: "http://box:11434/v1" },
      { name: "ollama-api", protocol: "ollama", url: "http://box:11434/api/" },
    ]);
    for (const provider of ["ollama-box", "ollama-v1", "ollama-api"]) {
      const m = createImageProvider({ provider, model: "x" }, cfg());
      expect(m.provider).toBe("openai.image");
      expect(m.modelId).toBe("x");
    }
  });

  test("posts a generations request and reads the image back", async () => {
    setProviderRegistry([
      { name: "litellm", protocol: "openai", url: "http://gateway:4000/v1" },
    ]);
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({ created: 1, data: [{ b64_json: "AAAA" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const model = createImageProvider(
      { provider: "litellm", model: "qwen-image" },
      cfg(),
      { fetch: stub },
    );
    const result = await generateImage({ model, prompt: "a red cat", maxRetries: 0 });
    expect(result.images[0]?.base64).toBe("AAAA");
    expect(seen[0]?.url).toBe("http://gateway:4000/v1/images/generations");
    expect(seen[0]?.body.model).toBe("qwen-image");
    expect(seen[0]?.body.prompt).toBe("a red cat");
    // The tool streams the bytes itself, so b64 is the only usable response format.
    expect(seen[0]?.body.response_format).toBe("b64_json");
  });

  test("an edit request goes out as multipart to /images/edits", async () => {
    setProviderRegistry([
      { name: "litellm", protocol: "openai", url: "http://gateway:4000/v1" },
    ]);
    const seen: { url: string; type: string }[] = [];
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        type: init?.body instanceof FormData ? "formdata" : typeof init?.body,
      });
      return new Response(
        JSON.stringify({ created: 1, data: [{ b64_json: "BBBB" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const model = createImageProvider(
      { provider: "litellm", model: "qwen-image-edit" },
      cfg(),
      { fetch: stub },
    );
    const result = await generateImage({
      model,
      prompt: { images: [new Uint8Array([1, 2, 3])], text: "heller" },
      maxRetries: 0,
    });
    expect(result.images[0]?.base64).toBe("BBBB");
    expect(seen[0]?.url).toBe("http://gateway:4000/v1/images/edits");
    expect(seen[0]?.type).toBe("formdata");
  });

  test("parameters.extraBody reaches the JSON body (mflux-only knobs)", async () => {
    setProviderRegistry([
      { name: "litellm", protocol: "openai", url: "http://gateway:4000/v1" },
    ]);
    let body: Record<string, unknown> = {};
    const stub = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: "Qw==" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const model = createImageProvider(
      {
        provider: "litellm",
        model: "qwen-image",
        parameters: { extraBody: { num_inference_steps: 20, negative_prompt: "blur" } },
      },
      cfg(),
      { fetch: stub },
    );
    await generateImage({ model, prompt: "x", maxRetries: 0 });
    // The SDK has no typed field for these; the fetch layer is the only route.
    expect(body.num_inference_steps).toBe(20);
    expect(body.negative_prompt).toBe("blur");
  });

  test("a per-call key override wins over the registry key", async () => {
    setProviderRegistry([
      { name: "litellm", protocol: "openai", url: "http://gateway:4000/v1", apiKey: "pool" },
    ]);
    const seen: { auth: string | null } = { auth: null };
    const stub = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: "RA==" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const model = createImageProvider({ provider: "litellm", model: "m" }, cfg(), {
      fetch: stub,
      apiKey: "byok",
    });
    await generateImage({ model, prompt: "x", maxRetries: 0 });
    // BYOK has to reach the image server too, not just the chat pool.
    expect(seen.auth).toBe("Bearer byok");
  });
});

describe("makeImageFetch", () => {
  test("is identity when there is nothing to inject", () => {
    const base = (async () => new Response("")) as unknown as typeof fetch;
    expect(makeImageFetch(undefined, base)).toBe(base);
    expect(makeImageFetch({}, base)).toBe(base);
  });

  test("merges extraBody into a JSON body", async () => {
    const seen: unknown[] = [];
    const base = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.body);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const wrapped = makeImageFetch({ steps: 30 }, base);
    await wrapped("http://x/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "m", steps: 4 }),
    });
    expect(JSON.parse(String(seen[0]))).toEqual({ model: "m", steps: 30 });
  });

  test("leaves a non-string body (multipart edit) untouched", async () => {
    const form = new FormData();
    form.append("prompt", "heller");
    const seen: unknown[] = [];
    const base = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.body);
      return new Response("{}");
    }) as unknown as typeof fetch;
    await makeImageFetch({ steps: 30 }, base)("http://x/v1/images/edits", {
      method: "POST",
      body: form,
    });
    expect(seen[0]).toBe(form);
  });

  test("keeps every other init field intact", async () => {
    const inits: RequestInit[] = [];
    const base = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response("{}");
    }) as unknown as typeof fetch;
    const signal = new AbortController().signal;
    await makeImageFetch({ a: 1 }, base)("http://x/y", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(inits[0]?.method).toBe("POST");
    expect(inits[0]?.signal).toBe(signal);
    expect(inits[0]?.headers).toEqual({ "content-type": "application/json" });
  });
});
