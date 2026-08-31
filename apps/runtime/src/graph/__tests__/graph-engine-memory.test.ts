// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration test for the `memory` node wired into the engine.
 *
 * Seeds a long-term memory for a user, runs memory → llm, and asserts the
 * recalled memory is injected into the LLM prompt. Anonymous requests skip
 * memory entirely.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import { InMemoryRagStore } from "../vector-store.js";
import { createMemoryStore } from "../memory-store.js";
import type { Embedder } from "../semantic-cache.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";

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

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

function capturingLlm(capture: { prompt?: unknown }) {
  return () =>
    new MockLanguageModelV3({
      doStream: async (opts) => {
        capture.prompt = opts.prompt;
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "text-start", id: "1" });
              controller.enqueue({ type: "text-delta", id: "1", delta: "ok" });
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 5,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 2,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
              controller.close();
            },
          }),
        } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
      },
    });
}

const embedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    const t = text.toLowerCase();
    return [
      t.includes("coffee") || t.includes("espresso") ? 1 : 0,
      t.includes("tea") ? 1 : 0,
    ];
  },
};

const memFlow: FlowDefinition = {
  id: "mem-flow",
  name: "Memory",
  nodes: [
    { id: "recall", type: "memory", config: { topK: 3 } },
    { id: "answer", type: "llm" },
  ],
  edges: [{ source: "recall", target: "answer" }],
};

async function buildEngine(capture: { prompt?: unknown }, seed: boolean) {
  const store = new InMemoryRagStore();
  const memory = createMemoryStore({ enabled: true }, store, embedder);
  if (memory === undefined) throw new Error("expected the memory store to be enabled");
  if (seed) {
    await memory.remember(
      { userId: "alice@example.com" },
      "The user strongly prefers espresso-based coffee drinks.",
    );
  }
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(memFlow),
    llmProviderFactory: capturingLlm(capture),
    memoryStore: memory,
  });
  return engine;
}

async function run(
  engine: ReturnType<typeof createGraphEngine>,
  ctx: RequestContext,
) {
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    "mem-flow",
    [{ role: "user", content: "Recommend me a coffee." }],
    ctx,
    async (c) => {
      chunks.push(c);
    },
    async () => {},
    undefined,
  );
  return chunks;
}

describe("memory node", () => {
  test("injects a recalled memory into the LLM prompt for an identified user", async () => {
    const capture: { prompt?: unknown } = {};
    const engine = await buildEngine(capture, true);
    await run(engine, {
      ssoToken: "a.b.c",
      executionId: "e1",
      userEmail: "alice@example.com",
    });
    expect(JSON.stringify(capture.prompt)).toContain("espresso-based coffee");
  });

  test("skips memory for an anonymous request (no identity)", async () => {
    const capture: { prompt?: unknown } = {};
    const engine = await buildEngine(capture, true);
    await run(engine, { ssoToken: "a.b.c", executionId: "e2" });
    expect(JSON.stringify(capture.prompt)).not.toContain(
      "espresso-based coffee",
    );
  });

  test("no-op when the user has no stored memories", async () => {
    const capture: { prompt?: unknown } = {};
    const engine = await buildEngine(capture, false);
    const chunks = await run(engine, {
      ssoToken: "a.b.c",
      executionId: "e3",
      userEmail: "nobody@example.com",
    });
    expect(chunks.length).toBeGreaterThan(0); // flow still runs
  });
});
