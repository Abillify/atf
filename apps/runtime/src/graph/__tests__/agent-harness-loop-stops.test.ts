// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Example tests for loop stop scenarios in createAgentHarnessNodeHandler.
 *
 * Covers:
 * - Empty-plan stop → `no-tasks` (Req 3.3)
 * - Full-completion stop → `completed` (Req 4.5)
 * - Default iteration limit applied when absent (Req 5.3)
 * - No Cost_Limit / no Time_Limit run without those stops (Req 6.3, 7.3)
 *
 * Validates: Requirements 3.3, 4.5, 5.3, 6.3, 7.3
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { FlowNode } from "../../types/flow.js";
import type {
  ExecRuntime,
  AgentState,
  UsageAccumulator,
} from "../graph-engine.js";
import type { AppConfig } from "../../config/index.js";
import type { MetricsSummary } from "../../observability/metrics.js";
import { NodeHandlerRegistry } from "../node-handler-registry.js";
import type { NodeHandler } from "../node-handler-registry.js";
import type { HarnessProgress } from "../agent-harness.js";
import {
  createAgentHarnessNodeHandler,
  DEFAULT_MAX_ITERATIONS,
} from "../agent-harness.js";
import { HumanMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

// ---------------------------------------------------------------------------
// Test-local helpers (avoids mock.module pollution)
// ---------------------------------------------------------------------------

let testRegistry: NodeHandlerRegistry;

/**
 * extractJsonFromText — parses JSON from text (simplified version).
 */
function extractJsonFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  // Try to parse as JSON directly
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) return parsed;
    return null;
  } catch {
    // Try stripping markdown code fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const fenceCapture = fenceMatch?.[1];
    if (fenceCapture !== undefined) {
      try {
        const parsed = JSON.parse(fenceCapture);
        if (typeof parsed === "object" && parsed !== null) return parsed;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function mkUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * Build a mock runtime whose `llmProviderFactory` returns a model that
 * produces `responseText` on each call. Supports a sequence of responses
 * for multiple plan/re-plan calls.
 */
function mockRuntime(responses: string[]): ExecRuntime {
  let callIndex = 0;

  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const lastResponse = responses[responses.length - 1];
      if (lastResponse === undefined) throw new Error("expected at least one response");
      const text = responses[callIndex] ?? lastResponse;
      callIndex++;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  return {
    appConfig: baseConfig,
    ctx: {
      ssoToken: "test-token",
      executionId: "exec-1",
    },
    usage: mkUsage(),
    llmProviderFactory: () => model,
    onToken: async () => {},
    onReasoning: async () => {},
    onToolCall: async () => {},
    onToolResult: async () => {},
    onNodeStart: () => {},
    onNodeEnd: async () => {},
    onNodeIo: () => {},
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
    costTracker: {
      record: () => {},
    },
  } as unknown as ExecRuntime;
}

function mkFlowNode(id: string, type: string = "llm"): FlowNode {
  return { id, type } as FlowNode;
}

function mkNodeMap(...nodes: FlowNode[]): Map<string, FlowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

function mkState(): AgentState {
  return {
    messages: [new HumanMessage("Do something useful")],
    currentNodeId: undefined,
    context: { ssoToken: "test", executionId: "exec-1" },
    citations: [],
    toolResults: [],
    errors: [],
    classification: {},
    classLabel: "",
  } as unknown as AgentState;
}

function mkConfig(runtime: ExecRuntime): LangGraphRunnableConfig {
  return {
    configurable: { runtime },
  } as unknown as LangGraphRunnableConfig;
}

/** A stub worker handler that always succeeds with a simple message. */
const successHandler: NodeHandler = async () => ({
  messages: [new HumanMessage("Task done")],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentHarnessNodeHandler — loop stop scenarios", () => {
  beforeEach(() => {
    testRegistry = new NodeHandlerRegistry();
    testRegistry.register({
      type: "llm",
      emitsLifecycle: true,
      factory: () => successHandler,
    });
  });

  test("empty-plan stop → stopReason 'no-tasks' (Req 3.3)", async () => {
    // Planner returns an empty tasks array
    const emptyPlanResponse = JSON.stringify({ tasks: [] });
    const runtime = mockRuntime([emptyPlanResponse]);

    const workerNode = mkFlowNode("worker-1", "llm");
    const nodeMap = mkNodeMap(workerNode);

    const harnessNode: FlowNode = {
      id: "harness-1",
      type: "agent-harness",
      config: {
        allowlist: ["worker-1"],
      },
      llm: { provider: "openai", model: "gpt-4o" },
    } as unknown as FlowNode;

    const handler = createAgentHarnessNodeHandler(harnessNode, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });
    const state = mkState();
    const config = mkConfig(runtime);

    const result = await handler(state, config);

    // The handler should return harness progress with stopReason "no-tasks"
    const harness = (result as Record<string, unknown>)
      .harness as HarnessProgress;
    expect(harness).toBeDefined();
    expect(harness.stopReason).toBe("no-tasks");
    expect(harness.tasks).toEqual([]);
    expect(harness.partial).toBe(true);
    expect(harness.statusMessage).toContain("No actionable tasks");
  });

  test("full-completion stop → stopReason 'completed' (Req 4.5)", async () => {
    // Planner returns one task targeting worker-1, then re-plan returns empty
    const initialPlan = JSON.stringify({
      tasks: [{ description: "Do the thing", target: "worker-1" }],
    });
    // Re-plan after completion returns empty (no new tasks)
    const replanResponse = JSON.stringify({ tasks: [] });
    const runtime = mockRuntime([initialPlan, replanResponse]);

    const workerNode = mkFlowNode("worker-1", "llm");
    const nodeMap = mkNodeMap(workerNode);

    const harnessNode: FlowNode = {
      id: "harness-1",
      type: "agent-harness",
      config: {
        allowlist: ["worker-1"],
      },
      llm: { provider: "openai", model: "gpt-4o" },
    } as unknown as FlowNode;

    const handler = createAgentHarnessNodeHandler(harnessNode, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });
    const state = mkState();
    const config = mkConfig(runtime);

    const result = await handler(state, config);

    const harness = (result as Record<string, unknown>)
      .harness as HarnessProgress;
    expect(harness).toBeDefined();
    expect(harness.stopReason).toBe("completed");
    expect(harness.partial).toBe(false);
    expect(harness.tasks).toHaveLength(1);
    const task0 = harness.tasks[0];
    if (task0 === undefined) throw new Error("expected a task");
    expect(task0.status).toBe("completed");
    expect(harness.statusMessage).toContain("All tasks completed");
  });

  test("default iteration limit applied when maxIterations absent (Req 5.3)", async () => {
    // Verify that DEFAULT_MAX_ITERATIONS = 12 is used when config omits maxIterations
    expect(DEFAULT_MAX_ITERATIONS).toBe(12);

    // Create a plan with many tasks (more than 12) that always re-plans with
    // enough pending tasks to prevent "completed" before the limit.
    // After each delegation + re-plan, there must still be pending tasks.
    const manyTasks = Array.from({ length: 15 }, (_, i) => ({
      description: `Task ${i + 1}`,
      target: "worker-1",
    }));
    const bigPlan = JSON.stringify({ tasks: manyTasks });
    // Re-plan always produces many new pending tasks so the loop never runs out
    const replanTasks = Array.from({ length: 15 }, (_, i) => ({
      description: `Replan task ${i + 1}`,
      target: "worker-1",
    }));
    const replanResponse = JSON.stringify({ tasks: replanTasks });
    const runtime = mockRuntime([bigPlan, ...Array(25).fill(replanResponse)]);

    const workerNode = mkFlowNode("worker-1", "llm");
    const nodeMap = mkNodeMap(workerNode);

    const harnessNode: FlowNode = {
      id: "harness-1",
      type: "agent-harness",
      config: {
        allowlist: ["worker-1"],
        // NOTE: maxIterations is NOT set — DEFAULT_MAX_ITERATIONS should apply
      },
      llm: { provider: "openai", model: "gpt-4o" },
    } as unknown as FlowNode;

    const handler = createAgentHarnessNodeHandler(harnessNode, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });
    const state = mkState();
    const config = mkConfig(runtime);

    const result = await handler(state, config);

    const harness = (result as Record<string, unknown>)
      .harness as HarnessProgress;
    expect(harness).toBeDefined();
    expect(harness.stopReason).toBe("iteration-limit");
    // The loop should have performed exactly DEFAULT_MAX_ITERATIONS iterations
    expect(harness.iterations).toBe(DEFAULT_MAX_ITERATIONS);
    expect(harness.partial).toBe(true);
    expect(harness.statusMessage).toContain("iteration limit");
  });

  test("no Cost_Limit: runs to completion without cost-limit stop (Req 6.3)", async () => {
    // When maxCost is NOT configured, the loop should NOT stop due to cost
    // even though tasks accumulate theoretical cost
    const initialPlan = JSON.stringify({
      tasks: [
        { description: "Task A", target: "worker-1" },
        { description: "Task B", target: "worker-1" },
      ],
    });
    // Re-plan returns empty after both complete
    const replanResponse = JSON.stringify({ tasks: [] });
    const runtime = mockRuntime([initialPlan, replanResponse, replanResponse]);

    const workerNode = mkFlowNode("worker-1", "llm");
    const nodeMap = mkNodeMap(workerNode);

    const harnessNode: FlowNode = {
      id: "harness-1",
      type: "agent-harness",
      config: {
        allowlist: ["worker-1"],
        // NOTE: maxCost is NOT set — cost limit should NOT fire
      },
      llm: { provider: "openai", model: "gpt-4o" },
    } as unknown as FlowNode;

    const handler = createAgentHarnessNodeHandler(harnessNode, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });
    const state = mkState();
    const config = mkConfig(runtime);

    const result = await handler(state, config);

    const harness = (result as Record<string, unknown>)
      .harness as HarnessProgress;
    expect(harness).toBeDefined();
    // Should complete normally, NOT stop due to cost-limit
    expect(harness.stopReason).not.toBe("cost-limit");
    expect(harness.stopReason).toBe("completed");
    expect(harness.tasks.every((t) => t.status === "completed")).toBe(true);
  });

  test("no Time_Limit: runs to completion without time-limit stop (Req 7.3)", async () => {
    // When maxTimeMs is NOT configured, the loop should NOT stop due to time
    // even if execution takes a while (simulated by the loop itself)
    const initialPlan = JSON.stringify({
      tasks: [
        { description: "Task X", target: "worker-1" },
        { description: "Task Y", target: "worker-1" },
        { description: "Task Z", target: "worker-1" },
      ],
    });
    // Re-plan returns empty after tasks complete
    const replanResponse = JSON.stringify({ tasks: [] });
    const runtime = mockRuntime([
      initialPlan,
      replanResponse,
      replanResponse,
      replanResponse,
    ]);

    const workerNode = mkFlowNode("worker-1", "llm");
    const nodeMap = mkNodeMap(workerNode);

    const harnessNode: FlowNode = {
      id: "harness-1",
      type: "agent-harness",
      config: {
        allowlist: ["worker-1"],
        // NOTE: maxTimeMs is NOT set — time limit should NOT fire
      },
      llm: { provider: "openai", model: "gpt-4o" },
    } as unknown as FlowNode;

    const handler = createAgentHarnessNodeHandler(harnessNode, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });
    const state = mkState();
    const config = mkConfig(runtime);

    const result = await handler(state, config);

    const harness = (result as Record<string, unknown>)
      .harness as HarnessProgress;
    expect(harness).toBeDefined();
    // Should complete normally, NOT stop due to time-limit
    expect(harness.stopReason).not.toBe("time-limit");
    expect(harness.stopReason).toBe("completed");
    expect(harness.tasks.every((t) => t.status === "completed")).toBe(true);
    expect(harness.tasks).toHaveLength(3);
  });
});
