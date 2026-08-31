// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for GraphEngine.executeFlow wiring of the output guardrail
 * and the semantic cache, with a mocked LLM provider (no network).
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import { createOutputGuardrail } from "../output-guardrails.js";
import { createSemanticCache, type Embedder } from "../semantic-cache.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

function mockLlmFactory(tokens: string[]) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "text-start", id: "1" });
              for (const t of tokens)
                controller.enqueue({ type: "text-delta", id: "1", delta: t });
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 7,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 5,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
              controller.close();
            },
          }),
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
}

function singleNodeRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

const flow: FlowDefinition = {
  id: "g-flow",
  name: "Guardrail Flow",
  nodes: [{ id: "llm-1", type: "llm" }],
  edges: [],
};

async function collect(
  engine: ReturnType<typeof createGraphEngine>,
): Promise<string> {
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    "g-flow",
    [{ role: "user", content: "hi" }],
    { ssoToken: "a.b.c", executionId: "exec-1" },
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
  );
  return chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
}

describe("executeFlow — output guardrail", () => {
  test("redacts PII in streamed output, including across delta boundaries", async () => {
    const guardrail = createOutputGuardrail({ enabled: true, redactPii: true });
    // Stream an email split across two deltas, padded so the buffer flushes.
    const pad = "word ".repeat(80);
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: mockLlmFactory([pad, "mail me at jane.", "doe@example.com please ", pad]),
    outputGuardrail: guardrail,
  });

    const out = await collect(engine);
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).toContain("[REDACTED_EMAIL]");
  });

  test("passes clean output through unchanged", async () => {
    const guardrail = createOutputGuardrail({ enabled: true, redactPii: true });
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: mockLlmFactory(["Hello ", "world"]),
    outputGuardrail: guardrail,
  });
    expect(await collect(engine)).toBe("Hello world");
  });
});

describe("executeFlow — semantic cache", () => {
  test("a near-duplicate prompt reuses the cached response (no second provider call)", async () => {
    // Both prompts embed to almost the same vector → semantic hit.
    const embedder: Embedder = {
      embed: async (text: string) => {
        if (text.includes("hi")) return [1, 0, 0];
        return [0.99, 0.01, 0];
      },
    };
    const semCache = createSemanticCache(
      { enabled: true, threshold: 0.9, ttlSeconds: 300 },
      embedder,
    );
    if (semCache === undefined) throw new Error("expected the semantic cache to be enabled");

    let calls = 0;
    const countingFactory = () => {
      calls++;
      return new MockLanguageModelV3({
        doStream: async () =>
          ({
            stream: new ReadableStream({
              start(controller: ReadableStreamDefaultController<unknown>) {
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({
                  type: "text-delta",
                  id: "1",
                  delta: "Paris",
                });
                controller.enqueue({ type: "text-end", id: "1" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage: {
                    inputTokens: {
                      total: 7,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: 5,
                      text: undefined,
                      reasoning: undefined,
                    },
                  },
                });
                controller.close();
              },
            }),
          }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
      });
    };

    const engine = createGraphEngine({
        ...baseConfig,
        defaultLlm: {
          provider: "openai",
          model: "mock-model",
          parameters: { temperature: 0 },
        },
      }, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: countingFactory,
    semanticCache: semCache,
  });

    const first = await collect(engine);
    expect(first).toBe("Paris");
    expect(calls).toBe(1);

    // Second, paraphrased request → served from semantic cache.
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "g-flow",
      [{ role: "user", content: "different but similar" }],
      { ssoToken: "a.b.c", executionId: "exec-2" },
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );
    const second = chunks
      .map((c) => c.choices[0]?.delta?.content ?? "")
      .join("");
    expect(second).toBe("Paris");
    expect(calls).toBe(1); // no new provider call
  });

  test("a near-duplicate prompt from a DIFFERENT tenant never reuses another tenant's cached response (regression)", async () => {
    const embedder: Embedder = {
      embed: async (text: string) => {
        if (text.includes("hi")) return [1, 0, 0];
        return [0.99, 0.01, 0];
      },
    };
    const semCache = createSemanticCache(
      { enabled: true, threshold: 0.9, ttlSeconds: 300 },
      embedder,
    );
    if (semCache === undefined) throw new Error("expected the semantic cache to be enabled");

    let calls = 0;
    const countingFactory = () => {
      calls++;
      return new MockLanguageModelV3({
        doStream: async () =>
          ({
            stream: new ReadableStream({
              start(controller: ReadableStreamDefaultController<unknown>) {
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({
                  type: "text-delta",
                  id: "1",
                  delta: "Paris",
                });
                controller.enqueue({ type: "text-end", id: "1" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage: {
                    inputTokens: {
                      total: 7,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: 5,
                      text: undefined,
                      reasoning: undefined,
                    },
                  },
                });
                controller.close();
              },
            }),
          }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
      });
    };

    const engine = createGraphEngine(
      {
        ...baseConfig,
        defaultLlm: {
          provider: "openai",
          model: "mock-model",
          parameters: { temperature: 0 },
        },
      },
      {
        flowRegistry: singleNodeRegistry(flow),
        llmProviderFactory: countingFactory,
        semanticCache: semCache,
      },
    );

    const chunksA: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "g-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-a", clientId: "tenant-a" },
      async (c) => {
        chunksA.push(c);
      },
      async () => {},
    );
    expect(chunksA.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe(
      "Paris",
    );
    expect(calls).toBe(1);

    // A near-duplicate prompt from tenant-b must NOT hit tenant-a's cache
    // entry — it must issue its own provider call.
    const chunksB: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "g-flow",
      [{ role: "user", content: "different but similar" }],
      { ssoToken: "x.y.z", executionId: "exec-b", clientId: "tenant-b" },
      async (c) => {
        chunksB.push(c);
      },
      async () => {},
    );
    expect(chunksB.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe(
      "Paris",
    );
    expect(calls).toBe(2); // a SECOND provider call — no cross-tenant reuse
  });
});
