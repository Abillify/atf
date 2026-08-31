// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * A `parallel` node must not run one child twice, and must not lose a child
 * silently.
 *
 * The engine keys per-node execution state — the streaming guardrail buffer,
 * chunk ids, start time, selected model, token counts, prompt/response capture —
 * by node id ALONE. Running one node concurrently with itself therefore
 * interleaves two token streams through a single guardrail buffer (corrupting the
 * emitted text), overwrites the timing/model bookkeeping, and fires the node's
 * completion event twice. A duplicate child entry is now dropped.
 *
 * Separately: a child whose type emits no monitoring lifecycle is replaced by a
 * no-op. That is right for `router`, but it also silently swallowed a NESTED
 * `parallel` — the child did nothing and the flow looked fine. Both cases now
 * emit a diagnostic.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { FlowDefinition } from "../../types/flow.js";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
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

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
  } as unknown as FlowRegistry;
}

function mockLlmFactory(token: string) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "text-start", id: "1" });
              controller.enqueue({ type: "text-delta", id: "1", delta: token });
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
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
                    reasoning: undefined,
                  },
                  totalTokens: 2,
                },
              });
              controller.close();
            },
          }),
        }) as never,
    });
}

/** Runs a flow and returns the node ids that reported `running`, plus the debug trace. */
async function runFlow(flow: FlowDefinition): Promise<{
  running: string[];
  completed: string[];
}> {
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    llmProviderFactory: mockLlmFactory("ok"),
  });

  const events: NodeExecutionEvent[] = [];
  const monitoring: MonitoringServiceInterface = {
    emitNodeEvent: (_id: string, e: NodeExecutionEvent) => {
      events.push(e);
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
  } as unknown as MonitoringServiceInterface;

  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "hi" }],
    { ssoToken: "a.b.c", executionId: `exec-${flow.id}` },
    async (c) => {
      chunks.push(c);
    },
    async () => {},
    monitoring,
  );

  return {
    running: events.filter((e) => e.status === "running").map((e) => e.node_id),
    completed: events
      .filter((e) => e.status === "completed")
      .map((e) => e.node_id),
  };
}

const countOf = (list: string[], id: string): number =>
  list.filter((n) => n === id).length;

// ---------------------------------------------------------------------------

describe("duplicate parallel children", () => {
  test("a child listed twice runs exactly ONCE", async () => {
    const flow: FlowDefinition = {
      id: "dup-child",
      name: "dup-child",
      nodes: [
        {
          id: "fan",
          type: "parallel",
          // The same worker named twice — previously this ran one node
          // concurrently with itself.
          parallelNodes: ["worker", "worker", "other"],
        },
        { id: "worker", type: "llm" },
        { id: "other", type: "llm" },
        { id: "responder", type: "llm" },
      ],
      edges: [{ source: "fan", target: "responder" }],
    };

    const { running, completed } = await runFlow(flow);
    expect(countOf(running, "worker")).toBe(1);
    expect(countOf(completed, "worker")).toBe(1);
    // The distinct sibling is unaffected.
    expect(countOf(running, "other")).toBe(1);
  });

  test("the object form is de-duplicated against the string form", async () => {
    const flow: FlowDefinition = {
      id: "dup-mixed",
      name: "dup-mixed",
      nodes: [
        {
          id: "fan",
          type: "parallel",
          parallelNodes: ["worker", { node: "worker" }],
        },
        { id: "worker", type: "llm" },
        { id: "responder", type: "llm" },
      ],
      edges: [{ source: "fan", target: "responder" }],
    };

    const { running } = await runFlow(flow);
    expect(countOf(running, "worker")).toBe(1);
  });

  test("distinct children all still run", async () => {
    const flow: FlowDefinition = {
      id: "distinct",
      name: "distinct",
      nodes: [
        {
          id: "fan",
          type: "parallel",
          parallelNodes: ["a", "b", "c"],
        },
        { id: "a", type: "llm" },
        { id: "b", type: "llm" },
        { id: "c", type: "llm" },
        { id: "responder", type: "llm" },
      ],
      edges: [{ source: "fan", target: "responder" }],
    };

    const { running } = await runFlow(flow);
    for (const id of ["a", "b", "c"]) {
      expect(countOf(running, id)).toBe(1);
    }
  });
});

describe("children that cannot run as a parallel branch", () => {
  test("a nested parallel child does not break the run", async () => {
    // It contributes nothing (unsupported), but the surrounding flow must still
    // complete — and the author now gets a diagnostic instead of silence.
    const flow: FlowDefinition = {
      id: "nested",
      name: "nested",
      nodes: [
        {
          id: "outer",
          type: "parallel",
          parallelNodes: ["inner", "worker"],
        },
        { id: "inner", type: "parallel", parallelNodes: ["leaf"] },
        { id: "leaf", type: "llm" },
        { id: "worker", type: "llm" },
        { id: "responder", type: "llm" },
      ],
      edges: [{ source: "outer", target: "responder" }],
    };

    const { running } = await runFlow(flow);
    // The executable sibling ran; the nested parallel produced no lifecycle.
    expect(countOf(running, "worker")).toBe(1);
    expect(countOf(running, "inner")).toBe(0);
  });

  test("a router child is tolerated without failing the run", async () => {
    const flow: FlowDefinition = {
      id: "router-child",
      name: "router-child",
      nodes: [
        {
          id: "fan",
          type: "parallel",
          parallelNodes: ["route", "worker"],
        },
        { id: "route", type: "router" },
        { id: "worker", type: "llm" },
        { id: "responder", type: "llm" },
      ],
      edges: [{ source: "fan", target: "responder" }],
    };

    const { running } = await runFlow(flow);
    expect(countOf(running, "worker")).toBe(1);
  });
});
