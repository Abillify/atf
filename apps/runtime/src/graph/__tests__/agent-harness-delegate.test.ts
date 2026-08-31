// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for delegate() (src/graph/agent-harness.ts).
 *
 * Stubs target node handlers and the `defaultNodeHandlerRegistry` dynamic
 * import to test delegation success, handler-returned errors, thrown errors,
 * target-not-in-nodeMap, and no-registration scenarios.
 *
 * Validates: Requirements 4.3, 4.6, 12.2
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { FlowNode } from "../../types/flow.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { ExecRuntime, AgentState } from "../graph-engine.js";
import type { MetricsSummary } from "../../observability/metrics.js";
import { NodeHandlerRegistry } from "../node-handler-registry.js";
import type { NodeHandler } from "../node-handler-registry.js";
import { delegate } from "../agent-harness.js";

// ---------------------------------------------------------------------------
// Test registry (injected via registryOverride parameter)
// ---------------------------------------------------------------------------

let testRegistry: NodeHandlerRegistry;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkNodeMap(...nodes: FlowNode[]): Map<string, FlowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function mkFlowNode(id: string, type: string = "llm"): FlowNode {
  return { id, type } as FlowNode;
}

function mkRuntime(): ExecRuntime & {
  _nodeStartCalls: string[];
  _nodeEndCalls: Array<{ nodeId: string; error?: string }>;
} {
  const nodeStartCalls: string[] = [];
  const nodeEndCalls: Array<{ nodeId: string; error?: string }> = [];

  return {
    appConfig: {} as ExecRuntime["appConfig"],
    ctx: { ssoToken: "test", executionId: "exec-1" },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    llmProviderFactory: () => ({}),
    onToken: async () => {},
    onReasoning: async () => {},
    onToolCall: async () => {},
    onToolResult: async () => {},
    onNodeStart: (nodeId: string) => {
      nodeStartCalls.push(nodeId);
    },
    onNodeEnd: async (nodeId: string, errorMessage?: string) => {
      nodeEndCalls.push({ nodeId, error: errorMessage });
    },
    metrics: {
      recordRequest: () => {},
      recordNode: () => {},
      recordLlmCall: () => {},
      recordLlmRetry: () => {},
      recordLlmFallback: () => {},
      recordRejected: () => {},
      recordCache: () => {},
      recordGuardrail: () => {},
      recordCounter: () => {},
      setActiveExecutions: () => {},
      setQueueDepth: () => {},
      render: () => "",
      summary: () => ({}) as unknown as MetricsSummary,
    } as ExecRuntime["metrics"],
    costTracker: { record: () => {} },
    _nodeStartCalls: nodeStartCalls,
    _nodeEndCalls: nodeEndCalls,
  } as unknown as ExecRuntime & {
    _nodeStartCalls: string[];
    _nodeEndCalls: Array<{ nodeId: string; error?: string }>;
  };
}

const stubState: AgentState = {
  messages: [],
  currentNodeId: "harness-1",
} as unknown as AgentState;

const stubConfig: LangGraphRunnableConfig = {} as LangGraphRunnableConfig;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delegate(target, state, config, runtime, nodeMap)", () => {
  beforeEach(() => {
    testRegistry = new NodeHandlerRegistry();
  });

  test("success: handler returns a state update with no errors → { update, ok: true }", async () => {
    const workerNode = mkFlowNode("worker-1", "llm");
    const nodeMap = mkNodeMap(workerNode);
    const runtime = mkRuntime();

    const expectedUpdate: Partial<AgentState> = {
      messages: [
        { role: "assistant", content: "Done!" },
      ] as unknown as BaseMessage[],
    };

    const stubHandler: NodeHandler = async () => expectedUpdate;

    testRegistry.register({
      type: "llm",
      emitsLifecycle: true,
      factory: () => stubHandler,
    });

    const result = await delegate(
      "worker-1",
      stubState,
      stubConfig,
      runtime as ExecRuntime,
      nodeMap,
      testRegistry,
    );

    expect(result.ok).toBe(true);
    expect(result.update).toEqual(expectedUpdate);

    // Lifecycle events emitted
    expect(runtime._nodeStartCalls).toEqual(["worker-1"]);
    expect(runtime._nodeEndCalls).toEqual([
      { nodeId: "worker-1", error: undefined },
    ]);
  });

  test("handler-returned error: handler returns update with errors array → { update, ok: false }", async () => {
    const workerNode = mkFlowNode("error-worker", "tool");
    const nodeMap = mkNodeMap(workerNode);
    const runtime = mkRuntime();

    const errorUpdate: Partial<AgentState> = {
      errors: [{ message: "Tool execution failed", type: "tool_error" }],
    } as Partial<AgentState>;

    const stubHandler: NodeHandler = async () => errorUpdate;

    testRegistry.register({
      type: "tool",
      emitsLifecycle: true,
      factory: () => stubHandler,
    });

    const result = await delegate(
      "error-worker",
      stubState,
      stubConfig,
      runtime as ExecRuntime,
      nodeMap,
      testRegistry,
    );

    expect(result.ok).toBe(false);
    expect(result.update).toEqual(errorUpdate);

    // onNodeEnd called with the error message
    expect(runtime._nodeEndCalls).toHaveLength(1);
    const firstEndCall = runtime._nodeEndCalls[0];
    if (firstEndCall === undefined) throw new Error("expected a first onNodeEnd call");
    expect(firstEndCall.nodeId).toBe("error-worker");
    expect(firstEndCall.error).toContain("Tool execution failed");
  });

  test("thrown error: handler throws an exception → caught, returns { update: {errors: [...]}, ok: false }", async () => {
    const workerNode = mkFlowNode("throw-worker", "llm");
    const nodeMap = mkNodeMap(workerNode);
    const runtime = mkRuntime();

    const stubHandler: NodeHandler = async () => {
      throw new Error("Connection timeout");
    };

    testRegistry.register({
      type: "llm",
      emitsLifecycle: true,
      factory: () => stubHandler,
    });

    const result = await delegate(
      "throw-worker",
      stubState,
      stubConfig,
      runtime as ExecRuntime,
      nodeMap,
      testRegistry,
    );

    expect(result.ok).toBe(false);
    expect(result.update.errors).toBeDefined();
    expect(Array.isArray(result.update.errors)).toBe(true);

    const errors = result.update.errors as Array<{ message: string }>;
    expect(errors.length).toBe(1);
    const firstError = errors[0];
    if (firstError === undefined) throw new Error("expected a first error");
    expect(firstError.message).toContain("Connection timeout");
    expect(firstError.message).toContain("throw-worker");

    // onNodeStart still emitted before the error
    expect(runtime._nodeStartCalls).toEqual(["throw-worker"]);
    // onNodeEnd emitted with the error message
    expect(runtime._nodeEndCalls).toHaveLength(1);
    const firstEndCall = runtime._nodeEndCalls[0];
    if (firstEndCall === undefined) throw new Error("expected a first onNodeEnd call");
    expect(firstEndCall.nodeId).toBe("throw-worker");
    expect(firstEndCall.error).toContain("Connection timeout");
  });

  test("target unavailable: target not in nodeMap → { update: {errors: [...]}, ok: false }", async () => {
    const nodeMap = mkNodeMap(); // empty node map
    const runtime = mkRuntime();

    const result = await delegate(
      "missing-node",
      stubState,
      stubConfig,
      runtime as ExecRuntime,
      nodeMap,
      testRegistry,
    );

    expect(result.ok).toBe(false);
    expect(result.update.errors).toBeDefined();

    const errors = result.update.errors as Array<{
      message: string;
      type: string;
      details: { node_id: string };
    }>;
    expect(errors.length).toBe(1);
    const firstError = errors[0];
    if (firstError === undefined) throw new Error("expected a first error");
    expect(firstError.message).toContain("missing-node");
    expect(firstError.message).toContain("not found");
    expect(firstError.type).toBe("execution_error");
    expect(firstError.details.node_id).toBe("missing-node");

    // No lifecycle events emitted when target not found
    expect(runtime._nodeStartCalls).toEqual([]);
    expect(runtime._nodeEndCalls).toEqual([]);
  });

  test("no registration: target found in nodeMap but type not registered → { update: {errors: [...]}, ok: false }", async () => {
    // Node exists in nodeMap with type "custom-type" but no handler is registered
    const workerNode = mkFlowNode("unregistered-worker", "custom-type");
    const nodeMap = mkNodeMap(workerNode);
    const runtime = mkRuntime();

    // testRegistry is empty — no handler registered for "custom-type"

    const result = await delegate(
      "unregistered-worker",
      stubState,
      stubConfig,
      runtime as ExecRuntime,
      nodeMap,
      testRegistry,
    );

    expect(result.ok).toBe(false);
    expect(result.update.errors).toBeDefined();

    const errors = result.update.errors as Array<{
      message: string;
      type: string;
      details: { node_id: string };
    }>;
    expect(errors.length).toBe(1);
    const firstError = errors[0];
    if (firstError === undefined) throw new Error("expected a first error");
    expect(firstError.message).toContain("No handler registered");
    expect(firstError.message).toContain("custom-type");
    expect(firstError.message).toContain("unregistered-worker");
    expect(firstError.type).toBe("execution_error");
    expect(firstError.details.node_id).toBe("unregistered-worker");

    // No lifecycle events emitted when registration not found
    expect(runtime._nodeStartCalls).toEqual([]);
    expect(runtime._nodeEndCalls).toEqual([]);
  });

  test("success: handler receives the full state and config", async () => {
    const workerNode = mkFlowNode("context-worker", "llm");
    const nodeMap = mkNodeMap(workerNode);
    const runtime = mkRuntime();

    let receivedState: AgentState | undefined;
    let receivedConfig: LangGraphRunnableConfig | undefined;

    const stubHandler: NodeHandler = async (state, config) => {
      receivedState = state;
      receivedConfig = config;
      return {};
    };

    testRegistry.register({
      type: "llm",
      emitsLifecycle: true,
      factory: () => stubHandler,
    });

    await delegate(
      "context-worker",
      stubState,
      stubConfig,
      runtime as ExecRuntime,
      nodeMap,
      testRegistry,
    );

    expect(receivedState).toBe(stubState);
    expect(receivedConfig).toBe(stubConfig);
  });

  test("factory receives the target node and nodeMap context", async () => {
    const workerNode = mkFlowNode("factory-worker", "llm");
    const nodeMap = mkNodeMap(workerNode);
    const runtime = mkRuntime();

    let receivedNode: FlowNode | undefined;
    let receivedCtx: { nodeMap: Map<string, FlowNode> } | undefined;

    testRegistry.register({
      type: "llm",
      emitsLifecycle: true,
      factory: (node, ctx) => {
        receivedNode = node;
        receivedCtx = ctx;
        return async () => ({});
      },
    });

    await delegate(
      "factory-worker",
      stubState,
      stubConfig,
      runtime as ExecRuntime,
      nodeMap,
      testRegistry,
    );

    expect(receivedNode).toBe(workerNode);
    expect(receivedCtx?.nodeMap).toBe(nodeMap);
  });

  test("thrown non-Error: handler throws a non-Error value → still caught and returns ok: false", async () => {
    const workerNode = mkFlowNode("string-throw", "llm");
    const nodeMap = mkNodeMap(workerNode);
    const runtime = mkRuntime();

    const stubHandler: NodeHandler = async () => {
      throw "raw string error";
    };

    testRegistry.register({
      type: "llm",
      emitsLifecycle: true,
      factory: () => stubHandler,
    });

    const result = await delegate(
      "string-throw",
      stubState,
      stubConfig,
      runtime as ExecRuntime,
      nodeMap,
      testRegistry,
    );

    expect(result.ok).toBe(false);
    expect(result.update.errors).toBeDefined();

    const errors = result.update.errors as Array<{ message: string }>;
    const firstError = errors[0];
    if (firstError === undefined) throw new Error("expected a first error");
    expect(firstError.message).toContain("raw string error");
  });
});
