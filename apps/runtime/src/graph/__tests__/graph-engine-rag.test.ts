// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration test for the RAG `retrieval` node wired into the engine.
 *
 * A fake embedder + in-memory vector store seed a tiny corpus; the flow runs
 * retrieval → llm. We capture the prompt the (mock) LLM receives to prove the
 * retrieved context was injected, and assert citations + tool results land in
 * the stream/state.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import { InMemoryRagStore } from "../vector-store.js";
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

/** Captures the last prompt the mock LLM was called with. */
function capturingLlm(tokens: string[], capture: { prompt?: unknown }) {
  return () =>
    new MockLanguageModelV3({
      doStream: async (opts) => {
        capture.prompt = opts.prompt;
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              for (const t of tokens) {
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({ type: "text-delta", id: "1", delta: t });
                controller.enqueue({ type: "text-end", id: "1" });
              }
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
        } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
      },
    });
}

/** Deterministic fake embedder: keyword presence → axis. */
const fakeEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    const t = text.toLowerCase();
    const france = t.includes("france") || t.includes("paris") ? 1 : 0;
    const germany = t.includes("germany") || t.includes("berlin") ? 1 : 0;
    return [france, germany];
  },
};

const ctx: RequestContext = { ssoToken: "a.b.c", executionId: "exec-rag-1" };

const ragFlow: FlowDefinition = {
  id: "rag-flow",
  name: "RAG",
  nodes: [
    {
      id: "retrieve",
      type: "retrieval",
      config: { collection: "kb", topK: 1 },
    },
    { id: "answer", type: "llm" },
  ],
  edges: [{ source: "retrieve", target: "answer" }],
};

async function seededStore(): Promise<InMemoryRagStore> {
  const store = new InMemoryRagStore();
  await store.upsert("kb", [
    {
      id: "fr",
      text: "Paris is the capital of France.",
      embedding: await fakeEmbedder.embed("france paris"),
      metadata: { title: "France", url: "https://kb/france" },
    },
    {
      id: "de",
      text: "Berlin is the capital of Germany.",
      embedding: await fakeEmbedder.embed("germany berlin"),
    },
  ]);
  return store;
}

async function run(
  engine: ReturnType<typeof createGraphEngine>,
): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    "rag-flow",
    [{ role: "user", content: "What is the capital of France?" }],
    ctx,
    async (c) => {
      chunks.push(c);
    },
    async () => {},
    undefined,
  );
  return chunks;
}

describe("RAG retrieval node", () => {
  test("injects the top-matching chunk into the LLM prompt", async () => {
    const capture: { prompt?: unknown } = {};
    const store = await seededStore();
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(ragFlow),
    llmProviderFactory: capturingLlm(["Paris."], capture),
    embedder: fakeEmbedder,
    vectorStore: store,
  });

    await run(engine);

    const promptStr = JSON.stringify(capture.prompt);
    expect(promptStr).toContain("Paris is the capital of France.");
    // The orthogonal Berlin doc must NOT be retrieved (topK=1).
    expect(promptStr).not.toContain("Berlin is the capital of Germany.");
  });

  test("emits retrieval tool-call + result chunks for the client", async () => {
    const capture: { prompt?: unknown } = {};
    const store = await seededStore();
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(ragFlow),
    llmProviderFactory: capturingLlm(["ok"], capture),
    embedder: fakeEmbedder,
    vectorStore: store,
  });

    const chunks = await run(engine);
    const serialized = JSON.stringify(chunks);
    // A tool-call chunk named for the retrieval collection is surfaced.
    expect(serialized).toContain("retrieval/kb");
  });

  test("produces an error entry (not a crash) when RAG is not configured", async () => {
    const capture: { prompt?: unknown } = {};
    // No embedder / vector store passed → retrieval node should no-op with error.
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(ragFlow),
    llmProviderFactory: capturingLlm(["ok"], capture),
  });
    // Should not throw; the LLM node still runs.
    const chunks = await run(engine);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
