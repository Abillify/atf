// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Concurrent delegations to the same node through the real graph engine.
 *
 * `coverageQueue.lanes > 1` runs several delegations of one target node at
 * once. Each carries its task key as the delegation instance; the engine must
 * keep the target's execution state per instance, so the debug trace holds one
 * entry per delegation with its own `instance_id`, tokens, model and response
 * instead of one merged entry (or a second start being dropped).
 */
import { describe, expect, test } from "bun:test";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { AppConfig } from "../../config/index.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { FlowDefinition, FlowNode } from "../../types/flow.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import { delegate } from "../agent-harness.js";
import { getRuntime } from "../exec-runtime.js";
import { NODE_INSTANCE_KEY } from "../graph-engine/node-instance.js";
import {
  defaultNodeHandlerRegistry,
  NodeHandlerRegistry,
} from "../node-handler-registry.js";

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
  llmRetryBackoffMs: 0,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

const FANOUT_TYPE = "test-delegation-fanout";
const WORKER: FlowNode = { id: "worker", type: "test-delegation-worker" } as FlowNode;
const TOKENS: Record<string, number> = { t1: 11, t2: 22 };

/** The worker reports model, tokens and response for itself, like an LLM node. */
const workerRegistry = new NodeHandlerRegistry().register({
  type: WORKER.type,
  emitsLifecycle: true,
  factory: (node) => async (_state, config) => {
    const runtime = getRuntime(config);
    const instance = (config?.configurable as Record<string, unknown> | undefined)?.[
      NODE_INSTANCE_KEY
    ] as string;
    // The first lane finishes last, so a merged state would be visible.
    await new Promise((resolve) => setTimeout(resolve, instance === "t1" ? 30 : 5));
    runtime?.setGenAiAttributes?.(
      node.id,
      { provider: "openai", model: `model-${instance}` } as never,
      { inputTokens: TOKENS[instance] } as never,
    );
    runtime?.onNodeIo?.(node.id, { response: `answer ${instance}` });
    await runtime?.onToolCall(`call-${instance}`, "srv/lookup", "{}");
    await runtime?.onToolResult(`call-${instance}`, { ok: true }, 0);
    return {};
  },
});

if (!defaultNodeHandlerRegistry.has(FANOUT_TYPE)) {
  defaultNodeHandlerRegistry.register({
    type: FANOUT_TYPE,
    emitsLifecycle: false,
    factory: () => async (state, config) => {
      const runtime = getRuntime(config);
      if (runtime === undefined) throw new Error("runtime missing");
      const nodeMap = new Map<string, FlowNode>([[WORKER.id, WORKER]]);
      const withInstance = (instance: string): LangGraphRunnableConfig => ({
        ...(config ?? {}),
        configurable: { ...(config?.configurable ?? {}), [NODE_INSTANCE_KEY]: instance },
      });
      await Promise.all(
        ["t1", "t2"].map((instance) =>
          delegate(WORKER.id, state, withInstance(instance), runtime, nodeMap, workerRegistry, {
            trigger: "agent-harness-delegation",
          } as never),
        ),
      );
      return {};
    },
  });
}

const flow: FlowDefinition = {
  id: "delegation-instances-flow",
  name: "Delegation instances",
  nodes: [{ id: "fanout", type: FANOUT_TYPE } as unknown as FlowNode],
  edges: [],
};

describe("graph engine · concurrent delegations to one node", () => {
  test("record one trace entry per delegation instance with separate state", async () => {
    const map = new Map([[flow.id, flow]]);
    const registry: FlowRegistry = {
      get: (id) => map.get(id),
      list: () => [...map.values()],
    };
    const engine = createGraphEngine(baseConfig, { flowRegistry: registry });
    const debugStore = new InMemoryDebugTraceStore();
    engine.setDebugStore?.(debugStore);
    await engine.executeFlow(
      flow.id,
      [{ role: "user", content: "hallo" }],
      { ssoToken: "a.b.c", executionId: "exec-delegation-instances" },
      async () => {},
      async () => {},
    );
    const workers = (debugStore.getTrace("exec-delegation-instances")?.nodes ?? [])
      .filter((entry) => entry.node_id === WORKER.id)
      .sort((a, b) => String(a.instance_id).localeCompare(String(b.instance_id)));
    expect(workers.map((entry) => entry.instance_id)).toEqual(["t1", "t2"]);
    expect(workers.map((entry) => entry.status)).toEqual(["completed", "completed"]);
    expect(workers.map((entry) => entry.input_tokens)).toEqual([11, 22]);
    expect(workers.map((entry) => entry.model)).toEqual(["openai/model-t1", "openai/model-t2"]);
    expect(workers.map((entry) => entry.full_response)).toEqual(["answer t1", "answer t2"]);
    expect(workers.map((entry) => entry.tool_calls.map((call) => call.id))).toEqual([
      ["call-t1"],
      ["call-t2"],
    ]);
  });
});

const PROGRESS_TYPE = "test-progress-reporter";
if (!defaultNodeHandlerRegistry.has(PROGRESS_TYPE)) {
  defaultNodeHandlerRegistry.register({
    type: PROGRESS_TYPE,
    emitsLifecycle: false,
    factory: (node) => async (_state, config) => {
      const runtime = getRuntime(config);
      runtime?.onProgress?.(node.id, { phase: "planning", tasksDone: 0, tasksTotal: 2, elapsedMs: 5 });
      runtime?.onProgress?.(node.id, { phase: "research", tasksDone: 1, tasksTotal: 2, elapsedMs: 9 });
      return {};
    },
  });
}

describe("graph engine · harness progress in the debug trace", () => {
  test("records the last progress event of a node as `progress`", async () => {
    const progressFlow: FlowDefinition = {
      id: "progress-trace-flow",
      name: "Progress trace",
      nodes: [{ id: "harness-1", type: PROGRESS_TYPE } as unknown as FlowNode],
      edges: [],
    };
    const map = new Map([[progressFlow.id, progressFlow]]);
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: { get: (id) => map.get(id), list: () => [...map.values()] },
    });
    const debugStore = new InMemoryDebugTraceStore();
    engine.setDebugStore?.(debugStore);
    await engine.executeFlow(
      progressFlow.id,
      [{ role: "user", content: "hallo" }],
      { ssoToken: "a.b.c", executionId: "exec-progress-trace" },
      async () => {},
      async () => {},
    );
    const node = debugStore
      .getTrace("exec-progress-trace")
      ?.nodes.find((entry) => entry.node_id === "harness-1");
    expect(node?.progress).toEqual({ phase: "research", tasksDone: 1, tasksTotal: 2, elapsedMs: 9 });
  });
});
