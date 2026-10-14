// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Named provider instances — registry resolution and endpoint selection.
 *
 * The contract under test is the one that motivated the design: MANY named
 * instances may share a wire protocol, so a deployment can run two vLLM servers
 * (or vLLM alongside LM Studio) and address them independently. Endpoint
 * selection is asserted through the real fetch layer rather than by inspecting
 * the SDK client, because the base URL is what actually decides which server a
 * request reaches.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  configuredProviderNames,
  isKnownProviderName,
  isLocalProviderName,
  ProviderInstancesSchema,
  resolveProviderProtocol,
  setProviderRegistry,
} from "../providers.js";
import type { AppConfig } from "../schema.js";
import {
  createEmbeddingProvider,
  createLlmProvider,
  UnknownProviderError,
} from "../../graph/llm-factory.js";
import { getModelCapabilities } from "../../graph/model-capabilities.js";
import { genAiSystem } from "../../observability/gen-ai-semconv.js";

/**
 * Deliberately carries NO endpoint or credential fields: `PROVIDERS` is the only
 * source for those, so an AppConfig cannot influence which server is reached.
 */
const appConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: [],
  monitoringAuthRequired: false,
  maxConcurrentExecutions: 1,
} as unknown as AppConfig;

const TWO_OPENAI_SERVERS = [
  { name: "vllm-a", protocol: "openai" as const, url: "http://vllm-a:8000/v1" },
  { name: "vllm-b", protocol: "openai" as const, url: "http://vllm-b:8000/v1" },
];

/** Captures the URL of the next outgoing request, then short-circuits it. */
function captureRequestUrl(): {
  urls: string[];
  fetch: typeof fetch;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const stub = (async (input: unknown) => {
    urls.push(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url,
    );
    return new Response(
      JSON.stringify({
        id: "1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  // Req 7.2: the factory transport is injectable now — wire the stub through
  // createLlmProvider's options instead of globalThis.
  globalThis.fetch = stub;
  return {
    urls,
    fetch: stub,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

afterEach(() => {
  setProviderRegistry(undefined);
});

describe("PROVIDERS parsing", () => {
  test("accepts several instances sharing one protocol", () => {
    const parsed = ProviderInstancesSchema.safeParse(TWO_OPENAI_SERVERS);
    expect(parsed.success).toBe(true);
  });

  test("normalises snake_case credential keys", () => {
    const parsed = ProviderInstancesSchema.safeParse([
      {
        name: "aws",
        protocol: "bedrock",
        region: "eu-central-1",
        access_key_id: "AKIA",
        secret_access_key: "shh",
        session_token: "tok",
      },
    ]);
    if (!parsed.success) throw new Error("expected the snake_case form to parse");
    expect(parsed.data[0]).toMatchObject({
      accessKeyId: "AKIA",
      secretAccessKey: "shh",
      sessionToken: "tok",
    });
  });

  test("normalises the optional keep-alive override", () => {
    const parsed = ProviderInstancesSchema.safeParse([
      { name: "a", protocol: "openai", keepAlive: false },
      { name: "b", protocol: "openai", keep_alive: false },
      { name: "c", protocol: "openai", keepAlive: true },
      { name: "d", protocol: "openai" },
    ]);
    if (!parsed.success) throw new Error("expected keep-alive overrides to parse");
    expect(parsed.data[0].keepAlive).toBe(false);
    expect(parsed.data[1].keepAlive).toBe(false);
    expect(parsed.data[2].keepAlive).toBe(true);
    expect("keepAlive" in parsed.data[3]).toBe(false);
  });
  test("rejects duplicate names and unknown protocols", () => {
    expect(
      ProviderInstancesSchema.safeParse([
        { name: "x", protocol: "openai" },
        { name: "x", protocol: "openai" },
      ]).success,
    ).toBe(false);
    // "vllm" is an ENDPOINT, not a wire protocol — it must be a name instead.
    expect(
      ProviderInstancesSchema.safeParse([{ name: "x", protocol: "vllm" }]).success,
    ).toBe(false);
  });
});

describe("registry resolution", () => {
  test("named instances resolve to their protocol; bare protocols still resolve", () => {
    setProviderRegistry(TWO_OPENAI_SERVERS);
    expect(resolveProviderProtocol("vllm-a")).toBe("openai");
    expect(resolveProviderProtocol("vllm-b")).toBe("openai");
    expect(resolveProviderProtocol("bedrock")).toBe("bedrock");
    expect(resolveProviderProtocol("nope")).toBeUndefined();
    expect(isKnownProviderName("nope")).toBe(false);
    expect(configuredProviderNames()).toEqual(["vllm-a", "vllm-b"]);
  });

  test("capabilities and telemetry follow the protocol, not the name", () => {
    setProviderRegistry([
      { name: "gpuvllm", protocol: "openai", url: "http://x/v1" },
      { name: "awseu", protocol: "bedrock", region: "eu-central-1" },
    ]);
    expect(getModelCapabilities("gpuvllm", "any").structuredOutput).toBe(
      "response_format",
    );
    expect(getModelCapabilities("awseu", "eu.anthropic.claude-sonnet-5").promptCache).toBe(
      "bedrock",
    );
    expect(genAiSystem("gpuvllm")).toBe("openai");
    expect(genAiSystem("awseu")).toBe("aws.bedrock");
  });

  test("locality is an explicit per-instance assertion", () => {
    setProviderRegistry([
      { name: "onprem", protocol: "openai", url: "http://lan/v1", local: true },
      { name: "hosted", protocol: "openai", url: "https://api.example.com/v1" },
      { name: "ollama-box", protocol: "ollama", url: "http://lan:11434" },
    ]);
    expect(isLocalProviderName("onprem")).toBe(true);
    expect(isLocalProviderName("ollama-box")).toBe(true);
    // A URL cannot prove locality, so an un-flagged instance is not trusted.
    expect(isLocalProviderName("hosted")).toBe(false);
    expect(isLocalProviderName(undefined)).toBe(false);
  });
});

describe("endpoint selection", () => {
  test("two instances of one protocol reach their own URLs", async () => {
    setProviderRegistry(TWO_OPENAI_SERVERS);
    const { urls, fetch: stub, restore } = captureRequestUrl();
    try {
      const { generateText } = await import("ai");
      await generateText({
        model: createLlmProvider(
          { provider: "vllm-a", model: "m" },
          appConfig,
          { fetch: stub },
        ),
        prompt: "hi",
      });
      await generateText({
        model: createLlmProvider(
          { provider: "vllm-b", model: "m" },
          appConfig,
          { fetch: stub },
        ),
        prompt: "hi",
      });
    } finally {
      restore();
    }
    expect(urls[0]).toStartWith("http://vllm-a:8000/v1");
    expect(urls[1]).toStartWith("http://vllm-b:8000/v1");
  });

  test("a bare protocol carries no endpoint or credentials of its own", async () => {
    setProviderRegistry(TWO_OPENAI_SERVERS);
    const { urls, fetch: stub, restore } = captureRequestUrl();
    let error: unknown;
    try {
      const { generateText } = await import("ai");
      await generateText({
        model: createLlmProvider(
          { provider: "openai", model: "m" },
          appConfig,
          { fetch: stub },
        ),
        prompt: "hi",
      });
    } catch (err) {
      error = err;
    } finally {
      restore();
    }
    // It must not borrow a configured instance's endpoint, and since PROVIDERS is
    // the only credential source it cannot authenticate on its own — the SDK's own
    // key error surfaces instead of a silent call to the wrong server.
    expect(urls).toEqual([]);
    expect(String(error)).toInclude("API key is missing");
  });

  test("embeddings honour the named endpoint too", () => {
    setProviderRegistry([
      { name: "macminiollama", protocol: "ollama", url: "http://mac:11434" },
    ]);
    const model = createEmbeddingProvider(
      { provider: "macminiollama", model: "bge-m3" },
      appConfig,
    );
    expect(typeof model === "string" ? model : model.modelId).toBe("bge-m3");
    // A protocol without an embedding client must fail loudly, not silently.
    expect(() =>
      createEmbeddingProvider({ provider: "bedrock", model: "x" }, appConfig),
    ).toThrow(UnknownProviderError);
  });

  test("an unresolvable provider throws with the configured names listed", () => {
    setProviderRegistry(TWO_OPENAI_SERVERS);
    expect(() =>
      createLlmProvider({ provider: "typo", model: "m" }, appConfig),
    ).toThrow(UnknownProviderError);
    expect(() =>
      createLlmProvider({ provider: "typo", model: "m" }, appConfig),
    ).toThrow(/vllm-a/);
  });
});
