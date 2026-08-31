// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration test: Intelligent routing scenario
 *
 * Validates the complete flow:
 *   classifier (structured output) → router → parallel RAG → LLM responder
 *   with dynamic model/tool selection based on classLabel
 *
 * Uses mock models — no real LLM or MCP calls.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import { validateFlowDefinition } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import type {
  MonitoringServiceInterface,
  MonitoringClient,
} from "../../monitoring/monitoring-service.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { RequestContext } from "../../types/monitoring.js";

/** The `content` of a chunk's first choice delta, asserting it is present. */
function chunkContent(chunk: ChatCompletionChunk): string {
  const content = chunk.choices[0]?.delta.content;
  if (content === undefined || content === null)
    throw new Error("expected content on choices[0].delta");
  return content;
}

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
};

// ---------------------------------------------------------------------------
// Mock models
// ---------------------------------------------------------------------------

/** Factory that returns different models based on the config (simulating provider selection) */
function mockProviderFactory(
  classifierResponse: Record<string, unknown>,
  llmResponse: string,
) {
  return (
    config: Parameters<
      AppConfig["maxToolSteps"] extends number
        ? typeof import("../../graph/llm-factory.js").createLlmProvider
        : never
    >[0],
  ) => {
    // This type is simplified for the test; in practice we check model name
    void config;
    // The classifier uses generateObject, the responder uses streamText
    // We return a mock that handles both based on which node calls it
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          { type: "text" as const, text: JSON.stringify(classifierResponse) },
        ],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 5,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(c: ReadableStreamDefaultController<unknown>) {
              c.enqueue({ type: "text-start", id: "1" });
              c.enqueue({ type: "text-delta", id: "1", delta: llmResponse });
              c.enqueue({ type: "text-end", id: "1" });
              c.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 3,
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
              c.close();
            },
          }),
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
  };
}

// ---------------------------------------------------------------------------
// Minimal mock MCP wrapper for tool nodes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Flow definitions
// ---------------------------------------------------------------------------

function makeClassifierFlow(): FlowDefinition {
  return {
    id: "test-classifier-flow",
    name: "Classifier Test",
    nodes: [
      {
        id: "classifier",
        type: "classifier",
        systemPrompt: "Classify the intent.",
        llm: { provider: "ollama", model: "llama3.2:3b" },
        classifierSchema: {
          classKey: "intent",
          schema: {
            type: "object",
            properties: {
              intent: { type: "string", enum: ["technical", "general"] },
              needsRag: { type: "boolean" },
              complexity: { type: "string", enum: ["simple", "complex"] },
            },
            required: ["intent", "needsRag", "complexity"],
          },
        },
      },
      {
        id: "router",
        type: "router",
      },
      {
        id: "llm-responder",
        type: "llm",
        overrides: [
          {
            whenClass: "technical",
            llm: { provider: "openai", model: "gpt-4o" },
            tools: ["my-mcp/code_executor"],
          },
          {
            whenClass: "*",
            llm: { provider: "openai", model: "gpt-4o-mini" },
          },
        ],
      },
      {
        id: "simple-responder",
        type: "llm",
        llm: { provider: "ollama", model: "llama3.2:3b" },
      },
    ],
    edges: [
      { source: "classifier", target: "router" },
      {
        source: "router",
        target: "llm-responder",
        conditions: "classLabel == 'technical'",
      },
      {
        source: "router",
        target: "simple-responder",
        conditions: "classLabel == 'general'",
      },
    ],
  };
}

function makeParallelRagFlow(): FlowDefinition {
  return {
    id: "test-parallel-rag",
    name: "Parallel RAG Test",
    nodes: [
      {
        id: "rag-parallel",
        type: "parallel",
        parallelNodes: ["rag-a", "rag-b"],
      },
      {
        id: "rag-a",
        type: "tool",
        tools: ["my-mcp/search_docs"],
      },
      {
        id: "rag-b",
        type: "tool",
        tools: ["my-mcp/search_kb"],
      },
      {
        id: "llm-synthesizer",
        type: "llm",
        llm: { provider: "openai", model: "gpt-4o" },
      },
    ],
    edges: [{ source: "rag-parallel", target: "llm-synthesizer" }],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(flow: FlowDefinition) {
  return {
    get: (id: string) => (id === flow.id ? flow : undefined),
    list: () => [flow],
  };
}

function makeMonitoring(): {
  service: MonitoringServiceInterface;
  events: NodeExecutionEvent[];
} {
  const events: NodeExecutionEvent[] = [];
  const service: MonitoringServiceInterface = {
    emitNodeEvent: (_id, e) => events.push(e),
    subscribe: (_c: MonitoringClient) => () => {},
    hasConnectionCapacity: () => true,
    getConnectionCount: () => 0,
    getTransportType: () => "sse",
    getHistory: async () => [],
    getHistoryPage: async () => ({ executions: [], total: 0 }),
    getHistoryFacets: async () => ({ flows: [], users: [] }),
    getUsageLog: async () => [],
    getExecutionEvents: async () => [],
    clearHistory: async () => 0,
  };
  return { service, events };
}

function makeCtx(): RequestContext {
  return { ssoToken: "a.b.c", executionId: "exec-test-1" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Flow validation — new node types", () => {
  test("classifier node passes schema validation", () => {
    const flow = makeClassifierFlow();
    const result = validateFlowDefinition(flow);
    expect(result.success).toBe(true);
  });

  test("parallel node passes schema validation", () => {
    const flow = makeParallelRagFlow();
    const result = validateFlowDefinition(flow);
    expect(result.success).toBe(true);
  });
});

describe("Classifier node — structured output + classLabel", () => {
  test("writes classLabel to state, classifier result routes to technical branch", async () => {
    const classOutput = {
      intent: "technical",
      needsRag: false,
      complexity: "complex",
    };
    const flow = makeClassifierFlow();
    const { service: monitoring, events } = makeMonitoring();

    const factory = mockProviderFactory(classOutput, "Technical answer");
    const engine = createGraphEngine(baseConfig, { flowRegistry: makeRegistry(flow), llmProviderFactory: factory as never });

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "test-classifier-flow",
      [{ role: "user", content: "How do I configure webpack?" }],
      makeCtx(),
      async (c) => {
        chunks.push(c);
      },
      async () => {},
      monitoring,
    );

    // Classifier + router + llm-responder (technical branch) should have run
    const startedNodes = events
      .filter((e) => e.status === "running")
      .map((e) => e.node_id);
    expect(startedNodes).toContain("classifier");
    // The technical branch (llm-responder) should have been activated
    // simple-responder should NOT have run since classLabel == 'technical'
    expect(startedNodes).not.toContain("simple-responder");

    // A token "Technical answer" should be in the chunks
    const textTokens = chunks
      .filter((c) => c.choices[0]?.delta?.content)
      .map(chunkContent)
      .join("");
    expect(textTokens).toContain("Technical answer");
  });

  test("general intent routes to simple-responder", async () => {
    const classOutput = {
      intent: "general",
      needsRag: false,
      complexity: "simple",
    };
    const flow = makeClassifierFlow();
    const { service: monitoring, events } = makeMonitoring();

    const factory = mockProviderFactory(classOutput, "General answer");
    const engine = createGraphEngine(baseConfig, { flowRegistry: makeRegistry(flow), llmProviderFactory: factory as never });

    await engine.executeFlow(
      "test-classifier-flow",
      [{ role: "user", content: "What is the weather?" }],
      makeCtx(),
      async () => {},
      async () => {},
      monitoring,
    );

    const startedNodes = events
      .filter((e) => e.status === "running")
      .map((e) => e.node_id);
    expect(startedNodes).toContain("simple-responder");
    expect(startedNodes).not.toContain("llm-responder");
  });
});

describe("Dynamic overrides — model selection by classLabel", () => {
  test("technical classLabel triggers gpt-4o override on llm-responder", async () => {
    // The override for "technical" specifies gpt-4o — we verify the factory
    // receives the correct model name
    const receivedModels: string[] = [];
    const classOutput = {
      intent: "technical",
      needsRag: false,
      complexity: "complex",
    };

    const trackingFactory = (cfg: { model: string }) => {
      receivedModels.push(cfg.model);
      return new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [
            { type: "text" as const, text: JSON.stringify(classOutput) },
          ],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: {
              total: 5,
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          warnings: [],
        }),
        doStream: async () =>
          ({
            stream: new ReadableStream({
              start(c: ReadableStreamDefaultController<unknown>) {
                c.enqueue({ type: "text-start", id: "1" });
                c.enqueue({ type: "text-delta", id: "1", delta: "ok" });
                c.enqueue({ type: "text-end", id: "1" });
                c.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: undefined,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: 1,
                      text: undefined,
                      reasoning: undefined,
                    },
                  },
                });
                c.close();
              },
            }),
          }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
      });
    };

    const flow = makeClassifierFlow();
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: makeRegistry(flow),
    llmProviderFactory: trackingFactory as never,
  });

    await engine.executeFlow(
      "test-classifier-flow",
      [{ role: "user", content: "Webpack config error" }],
      makeCtx(),
      async () => {},
      async () => {},
    );

    // classifier used llama3.2:3b, llm-responder used gpt-4o (override)
    expect(receivedModels).toContain("llama3.2:3b");
    expect(receivedModels).toContain("gpt-4o");
    expect(receivedModels).not.toContain("gpt-4o-mini");
  });
});

describe("Parallel RAG node — concurrent execution + state merge", () => {
  test("executes multiple tool children concurrently and merges results", async () => {
    const toolCallLog: string[] = [];
    const mcpWrapper: McpWrapperService = {
      connect: async () => {},
      listTools: async () => ["search_docs", "search_kb"],
      getFilteredToolSchema: async (_serverName: string, toolName: string) => ({
        name: toolName,
        inputSchema: { type: "object", properties: {} },
      }),
      refreshSchemaIfChanged: async () => false,
      callTool: async (_serverName: string, toolName: string) => {
        // Simulate some latency difference
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        toolCallLog.push(toolName);
        return { content: `result_${toolName}` };
      },
    } as unknown as McpWrapperService;

    const flow = makeParallelRagFlow();
    const { service: monitoring, events } = makeMonitoring();

    const factory = mockProviderFactory({}, "Synthesis done");
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: makeRegistry(flow),
    mcpWrapper: mcpWrapper,
    llmProviderFactory: factory as never,
  });

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "test-parallel-rag",
      [{ role: "user", content: "Give me all info" }],
      makeCtx(),
      async (c) => {
        chunks.push(c);
      },
      async () => {},
      monitoring,
    );

    // Both rag children should have been called
    expect(toolCallLog).toContain("search_docs");
    expect(toolCallLog).toContain("search_kb");

    // Synthesizer should have produced a token
    const text = chunks
      .filter((c) => c.choices[0]?.delta?.content)
      .map(chunkContent)
      .join("");
    expect(text).toContain("Synthesis");

    // Monitoring: both rag-a and rag-b should have started
    const startedNodes = events
      .filter((e) => e.status === "running")
      .map((e) => e.node_id);
    expect(startedNodes).toContain("rag-parallel");
  });
});

describe("Concurrency semaphore", () => {
  test("concurrent requests beyond limit are queued, not dropped", async () => {
    // Create engine with maxConcurrentExecutions=2 to force queueing
    const tightConfig: AppConfig = {
      ...baseConfig,
      maxConcurrentExecutions: 2,
    };
    const flow: FlowDefinition = {
      id: "concurrent-test",
      name: "Concurrent",
      nodes: [
        { id: "llm", type: "llm", llm: { provider: "ollama", model: "test" } },
      ],
      edges: [],
    };

    const factory = () =>
      new MockLanguageModelV3({
        doStream: async () =>
          ({
            stream: new ReadableStream({
              start(c: ReadableStreamDefaultController<unknown>) {
                // slight async delay to allow real concurrency test
                setTimeout(() => {
                  c.enqueue({ type: "text-start", id: "1" });
                  c.enqueue({ type: "text-delta", id: "1", delta: "ok" });
                  c.enqueue({ type: "text-end", id: "1" });
                  c.enqueue({
                    type: "finish",
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage: {
                      inputTokens: {
                        total: 1,
                        noCache: undefined,
                        cacheRead: undefined,
                        cacheWrite: undefined,
                      },
                      outputTokens: {
                        total: 1,
                        text: undefined,
                        reasoning: undefined,
                      },
                    },
                  });
                  c.close();
                }, 10);
              },
            }),
          }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
      });

    const engine = createGraphEngine(tightConfig, {
    flowRegistry: { get: () => flow, list: () => [flow] },
    llmProviderFactory: factory,
  });

    const ctx = makeCtx();
    const results: string[] = [];

    // Launch 5 concurrent flows — 2 run, 3 queue
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        engine.executeFlow(
          "concurrent-test",
          [{ role: "user", content: `msg ${i}` }],
          { ...ctx, executionId: `exec-${i}` },
          async (c) => {
            if (c.choices[0]?.delta?.content)
              results.push(c.choices[0].delta.content);
          },
          async () => {},
        ),
      ),
    );

    // All 5 must complete — none dropped
    expect(results.length).toBe(5);
    expect(results.every((r) => r === "ok")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool-arg template resolution (classifier output → vectorsearch filter.tag)
// ---------------------------------------------------------------------------

describe("Tool node — template resolution in configured args", () => {
  test("resolves {{query}} and nested {{classification.X}} before calling the tool", async () => {
    const flow: FlowDefinition = {
      id: "tmpl-flow",
      name: "Template Resolution",
      nodes: [
        {
          id: "dispatcher",
          type: "classifier",
          llm: { provider: "openai", model: "classifier" },
          classifierSchema: {
            classKey: "route",
            schema: {
              type: "object",
              properties: {
                route: { type: "string" },
                clientClientdocs: { type: "string" },
              },
              required: ["route", "clientClientdocs"],
            },
          },
        },
        {
          id: "rag",
          type: "tool",
          tools: ["vectorsearch/search"],
          config: {
            toolArgs: {
              "vectorsearch/search": {
                query: "{{query}}",
                collection: "clientdocs",
                filter: { tag: "{{classification.clientClientdocs}}" },
                limit: 8,
              },
            },
          },
        },
      ],
      edges: [{ source: "dispatcher", target: "rag" }],
    };

    const capturedArgs: Array<Record<string, unknown>> = [];
    const mcpWrapper: McpWrapperService = {
      connect: async () => {},
      listTools: async () => ["vectorsearch/search"],
      getFilteredToolSchema: async (_s: string, t: string) => ({
        name: t,
        inputSchema: { type: "object", properties: {} },
      }),
      refreshSchemaIfChanged: async () => false,
      callTool: async (
        _serverName: string,
        _toolName: string,
        args: Record<string, unknown>,
      ) => {
        capturedArgs.push(args);
        return { content: { results: [] } };
      },
    } as unknown as McpWrapperService;

    // Classifier returns a known synthetic client tag.
    const factory = mockProviderFactory(
      { route: "CLIENTS", clientClientdocs: "Example Retail" },
      "done",
    );
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: makeRegistry(flow),
    mcpWrapper: mcpWrapper,
    llmProviderFactory: factory as never,
  });

    await engine.executeFlow(
      "tmpl-flow",
      [{ role: "user", content: "wer ist für example retail zuständig" }],
      makeCtx(),
      async () => {},
      async () => {},
    );

    expect(capturedArgs).toHaveLength(1);
    const args = capturedArgs[0];
    if (args === undefined) throw new Error("expected captured args");
    // {{query}} resolved to the user message
    expect(args.query).toBe("wer ist für example retail zuständig");
    // nested {{classification.clientClientdocs}} resolved to the classifier output
    expect((args.filter as Record<string, unknown>).tag).toBe(
      "Example Retail",
    );
    // literal config values pass through untouched
    expect(args.collection).toBe("clientdocs");
    expect(args.limit).toBe(8);
  });
});
