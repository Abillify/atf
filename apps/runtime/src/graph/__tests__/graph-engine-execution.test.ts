// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for GraphEngine.executeFlow with a mocked LLM provider.
 *
 * Exercises the real runtime path: token streaming, usage accounting,
 * monitoring events, and conditional routing — without real LLM API calls.
 *
 * Validates: Requirements 5.2, 5.3, 6.1, 9.1
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import type {
  MonitoringServiceInterface,
  MonitoringClient,
} from "../../monitoring/monitoring-service.js";

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

/** Builds a mock LLM that streams the given tokens then finishes with usage. */
function mockLlmFactory(tokens: string[]) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
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
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
}

function singleNodeRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

describe("executeFlow — token streaming", () => {
  test("emits each token as a separate content chunk in order", async () => {
    const flow: FlowDefinition = {
      id: "stream-flow",
      name: "Stream",
      nodes: [{ id: "llm-1", type: "llm" }],
      edges: [],
    };
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: mockLlmFactory(["Hel", "lo", " world"]),
  });

    const chunks: ChatCompletionChunk[] = [];
    let doneUsage: { total_tokens: number } | undefined;

    await engine.executeFlow(
      "stream-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-1" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async (usage) => {
        doneUsage = usage;
      },
    );

    const contentChunks = chunks.filter((c) => c.choices[0]?.delta?.content);
    const tokens = contentChunks.map((c) => c.choices[0]?.delta.content);
    expect(tokens).toEqual(["Hel", "lo", " world"]);

    // Usage is accumulated and passed to onDone (token accounting)
    expect(doneUsage?.total_tokens).toBe(12); // 7 + 5
  });
});

describe("executeFlow — monitoring events", () => {
  test("emits node:start (running) then node:complete with latency", async () => {
    const flow: FlowDefinition = {
      id: "mon-flow",
      name: "Mon",
      nodes: [{ id: "llm-1", type: "llm" }],
      edges: [],
    };

    const events: NodeExecutionEvent[] = [];
    const monitoring: MonitoringServiceInterface = {
      emitNodeEvent: (_id, event) => {
        events.push(event);
      },
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

    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: mockLlmFactory(["x"]),
  });

    await engine.executeFlow(
      "mon-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-2" },
      async () => {},
      async () => {},
      monitoring,
    );

    const running = events.find((e) => e.status === "running");
    const completed = events.find((e) => e.status === "completed");

    expect(running).toBeDefined();
    expect(running?.node_id).toBe("llm-1");
    expect(running?.end_time).toBeNull();
    expect(running?.latency_ms).toBeNull();

    expect(completed).toBeDefined();
    expect(completed?.node_id).toBe("llm-1");
    expect(completed?.end_time).not.toBeNull();
    expect(typeof completed?.latency_ms).toBe("number");
  });

  test("every node event carries flow_id, not just the synthetic boundary nodes", async () => {
    // Regression test: flow_id used to be attached only to the synthetic
    // __request__/__response__ boundary events emitted by the chat route, so
    // the dashboard's flow-topology resolver (frontend/useFlowTopology) fell
    // back to node-id overlap scoring whenever those boundary events were
    // unavailable — which mislabelled nodes across flows sharing a generic
    // node id (e.g. several passthrough flows all naming their sole LLM node
    // "responder"). Every node-lifecycle event must carry flow_id directly.
    const flow: FlowDefinition = {
      id: "mon-flow-2",
      name: "Mon2",
      nodes: [{ id: "llm-1", type: "llm" }],
      edges: [],
    };

    const events: NodeExecutionEvent[] = [];
    const monitoring: MonitoringServiceInterface = {
      emitNodeEvent: (_id, event) => {
        events.push(event);
      },
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

    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: mockLlmFactory(["x"]),
  });

    await engine.executeFlow(
      "mon-flow-2",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-2b" },
      async () => {},
      async () => {},
      monitoring,
    );

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.flow_id).toBe("mon-flow-2");
    }
  });
});

describe("executeFlow — LLM fallback error", () => {
  test("node without llm and no default emits error chunk + still calls onDone", async () => {
    const flow: FlowDefinition = {
      id: "no-llm",
      name: "NoLLM",
      nodes: [{ id: "n1", type: "llm" }],
      edges: [],
    };
    const configNoDefault: AppConfig = {
      ...baseConfig,
      defaultLlm: undefined as never,
    };

    const engine = createGraphEngine(configNoDefault, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: mockLlmFactory(["unused"]),
  });

    const chunks: ChatCompletionChunk[] = [];
    let done = false;
    await engine.executeFlow(
      "no-llm",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-3" },
      async (c) => {
        chunks.push(c);
      },
      async () => {
        done = true;
      },
    );

    expect(done).toBe(true);
    expect(chunks.some((c) => c.choices[0]?.finish_reason === "error")).toBe(
      true,
    );
  });
});

describe("executeFlow — conditional routing", () => {
  test("routes through a two-node chain based on a condition", async () => {
    // router → (condition true) → llm-1
    const flow: FlowDefinition = {
      id: "route-flow",
      name: "Route",
      nodes: [
        { id: "router", type: "router" },
        { id: "llm-1", type: "llm" },
      ],
      edges: [
        { source: "router", target: "llm-1", conditions: "messageCount >= 1" },
      ],
    };

    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: mockLlmFactory(["ok"]),
  });

    const events: NodeExecutionEvent[] = [];
    const monitoring: MonitoringServiceInterface = {
      emitNodeEvent: (_id, e) => {
        events.push(e);
      },
      subscribe: () => () => {},
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

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "route-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-4" },
      async (c) => {
        chunks.push(c);
      },
      async () => {},
      monitoring,
    );

    // Both nodes executed (router routed to llm-1 because messageCount >= 1)
    const startedNodes = events
      .filter((e) => e.status === "running")
      .map((e) => e.node_id);
    expect(startedNodes).toContain("router");
    expect(startedNodes).toContain("llm-1");
    // The llm produced a token
    expect(chunks.some((c) => c.choices[0]?.delta?.content === "ok")).toBe(
      true,
    );
  });
});
