// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property tests for streaming emits of createAgentHarnessNodeHandler.
 *
 * Feature: agent-harness-node, Property 18: Task-list changes emit a describing event
 * Feature: agent-harness-node, Property 19: Status changes emit task id and new status
 * Feature: agent-harness-node, Property 20: Delegation emits the selected target
 * Feature: agent-harness-node, Property 21: Termination emits a final status event
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { MockLanguageModelV3 } from "ai/test";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { NodeHandlerRegistry } from "../node-handler-registry.js";
import type { NodeHandler } from "../node-handler-registry.js";
import type { FlowNode } from "../../types/flow.js";
import type { ExecRuntime, AgentState } from "../graph-engine.js";
import type { MetricsSummary } from "../../observability/metrics.js";
import { createAgentHarnessNodeHandler } from "../agent-harness.js";

// ---------------------------------------------------------------------------
// Test-local extractJsonFromText (avoids cross-file mock pollution)
// ---------------------------------------------------------------------------

function extractJsonFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const fencedCapture = fenced?.[1];
  if (fencedCapture) {
    try {
      return JSON.parse(fencedCapture.trim()) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as Record<
              string,
              unknown
            >;
          } catch {
            break;
          }
        }
      }
    }
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let testRegistry: NodeHandlerRegistry;

/** The first element of an array already asserted to be non-empty. */
function first<T>(arr: readonly T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("expected a non-empty array");
  return item;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TARGET_A = "worker-a";
const TARGET_B = "worker-b";

function mkFlowNode(id: string, type: string = "llm"): FlowNode {
  return { id, type } as FlowNode;
}

function mkNodeMap(...nodes: FlowNode[]): Map<string, FlowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

interface SpyRuntime extends ExecRuntime {
  _reasoningCalls: Array<{ nodeId: string; text: string }>;
  _nodeStartCalls: string[];
  _nodeEndCalls: Array<{ nodeId: string; error?: string }>;
  _nodeIoCalls: Array<{
    nodeId: string;
    io: { prompt?: string; response?: string };
  }>;
}

/**
 * Build a spy runtime whose `llmProviderFactory` returns a model that produces
 * the given `planResponses` in sequence.
 */
function mkSpyRuntime(planResponses: string[]): SpyRuntime {
  let callIdx = 0;
  const reasoningCalls: Array<{ nodeId: string; text: string }> = [];
  const nodeStartCalls: string[] = [];
  const nodeEndCalls: Array<{ nodeId: string; error?: string }> = [];
  const nodeIoCalls: Array<{
    nodeId: string;
    io: { prompt?: string; response?: string };
  }> = [];

  const factory = () => {
    const responseText = planResponses[callIdx] ?? "{}";
    callIdx++;
    return new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: responseText }],
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
      }),
    });
  };

  return {
    appConfig: {
      port: 3000,
      flowsDir: "./flows",
      monitoringTransport: "sse",
      mcpServers: [],
      corsOrigins: ["*"],
      monitoringAuthRequired: false,
      logLevel: "error",
      maxToolSteps: 5,
      maxConcurrentExecutions: 50,
    },
    ctx: { ssoToken: "test-token", executionId: "exec-1" },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    llmProviderFactory: factory,
    onToken: async () => {},
    onReasoning: async (nodeId: string, text: string) => {
      reasoningCalls.push({ nodeId, text });
    },
    onToolCall: async () => {},
    onToolResult: async () => {},
    onNodeStart: (nodeId: string) => {
      nodeStartCalls.push(nodeId);
    },
    onNodeEnd: async (nodeId: string, error?: string) => {
      nodeEndCalls.push({ nodeId, error });
    },
    onNodeIo: (nodeId: string, io: { prompt?: string; response?: string }) => {
      nodeIoCalls.push({ nodeId, io });
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
    _reasoningCalls: reasoningCalls,
    _nodeStartCalls: nodeStartCalls,
    _nodeEndCalls: nodeEndCalls,
    _nodeIoCalls: nodeIoCalls,
  } as unknown as SpyRuntime;
}

function mkConfig(runtime: SpyRuntime): LangGraphRunnableConfig {
  return { configurable: { runtime } } as unknown as LangGraphRunnableConfig;
}

function mkState(): AgentState {
  return {
    messages: [new HumanMessage("Do something useful")],
    currentNodeId: undefined,
    context: { ssoToken: "t", executionId: "e1" },
    citations: [],
    toolResults: [],
    errors: [],
    classification: {},
    classLabel: "",
  } as unknown as AgentState;
}

function mkHarnessNode(
  id: string,
  allowlist: string[],
  opts: { maxIterations?: number; maxCost?: number; maxTimeMs?: number } = {},
): FlowNode {
  return {
    id,
    type: "agent-harness",
    llm: { provider: "openai", model: "gpt-4o" },
    config: { allowlist, ...opts },
  } as unknown as FlowNode;
}

function mkPlanJson(
  tasks: Array<{ description: string; target: string }>,
): string {
  return JSON.stringify({ tasks });
}

function registerSuccessHandler(
  type: string,
  result?: Partial<AgentState>,
): void {
  const handler: NodeHandler = async () =>
    result ?? { messages: [new AIMessage("(done)")] };
  testRegistry.register({ type, emitsLifecycle: true, factory: () => handler });
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate 1–5 task descriptions (non-empty, no weird unicode). */
const arbTaskDescriptions: fc.Arbitrary<string[]> = fc.array(
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
  { minLength: 1, maxLength: 5 },
);

// ---------------------------------------------------------------------------
// Property 18: Task-list changes emit a describing event
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 18: Task-list changes emit a describing event", () => {
  test("after initial plan, at least one onReasoning call contains the rendered task list", async () => {
    // Feature: agent-harness-node, Property 18: Task-list changes emit a describing event
    // **Validates: Requirements 9.1**
    await fc.assert(
      fc.asyncProperty(arbTaskDescriptions, async (descriptions) => {
        testRegistry = new NodeHandlerRegistry();
        registerSuccessHandler("llm");

        const tasks = descriptions.map((d) => ({
          description: d,
          target: TARGET_A,
        }));
        const planJson = mkPlanJson(tasks);
        const emptyPlan = mkPlanJson([]);
        const responses = [
          planJson,
          ...Array(descriptions.length + 3).fill(emptyPlan),
        ];

        const runtime = mkSpyRuntime(responses);
        const node = mkHarnessNode("h1", [TARGET_A]);
        const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
        const handler = createAgentHarnessNodeHandler(node, nodeMap, {
          registry: testRegistry,
          extractJson: extractJsonFromText,
        });

        await handler(mkState(), mkConfig(runtime));

        // There must be at least one onReasoning call containing "Task list"
        // that also references the task descriptions (rendered task list)
        const taskListEmits = runtime._reasoningCalls.filter(
          (c) =>
            c.nodeId === "h1" && c.text.toLowerCase().includes("task list"),
        );
        expect(taskListEmits.length).toBeGreaterThanOrEqual(1);

        // The initial task list emit should contain all task IDs (t1, t2, etc.)
        const initialEmit = first(taskListEmits);
        for (let i = 0; i < descriptions.length; i++) {
          expect(initialEmit.text).toContain(`t${i + 1}`);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("after re-plan updates the task list, a new task-list event is emitted", async () => {
    // Feature: agent-harness-node, Property 18: Task-list changes emit a describing event
    // **Validates: Requirements 9.1**
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 4 }),
        async (numInitialTasks) => {
          testRegistry = new NodeHandlerRegistry();
          registerSuccessHandler("llm");

          // Initial plan with numInitialTasks tasks — need ≥2 so that after
          // the first task completes, the loop reaches re-plan before all settle.
          const initialTasks = Array.from(
            { length: numInitialTasks },
            (_, i) => ({
              description: `Initial-${i + 1}`,
              target: TARGET_A,
            }),
          );

          // Re-plan adds an extra task
          const replanTasks = [
            { description: "Extra-replan-task", target: TARGET_A },
          ];

          const planJson = mkPlanJson(initialTasks);
          const replanJson = mkPlanJson(replanTasks);
          const emptyPlan = mkPlanJson([]);
          // First call = initial plan, subsequent calls = re-plans
          const responses = [
            planJson,
            replanJson,
            emptyPlan,
            emptyPlan,
            emptyPlan,
            emptyPlan,
            emptyPlan,
            emptyPlan,
            emptyPlan,
          ];

          const runtime = mkSpyRuntime(responses);
          const node = mkHarnessNode("h1", [TARGET_A]);
          const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
          const handler = createAgentHarnessNodeHandler(node, nodeMap, {
            registry: testRegistry,
            extractJson: extractJsonFromText,
          });

          await handler(mkState(), mkConfig(runtime));

          // Count task-list emits — should have at least 2 (initial + after re-plan update)
          const taskListEmits = runtime._reasoningCalls.filter(
            (c) =>
              c.nodeId === "h1" && c.text.toLowerCase().includes("task list"),
          );
          expect(taskListEmits.length).toBeGreaterThanOrEqual(2);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19: Status changes emit task id and new status
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 19: Status changes emit task id and new status", () => {
  test("each task status transition emits an onReasoning event with the task id and new status", async () => {
    // Feature: agent-harness-node, Property 19: Status changes emit task id and new status
    // **Validates: Requirements 9.2**
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (numTasks) => {
        testRegistry = new NodeHandlerRegistry();
        registerSuccessHandler("llm");

        const tasks = Array.from({ length: numTasks }, (_, i) => ({
          description: `Task-${i + 1}`,
          target: TARGET_A,
        }));
        const planJson = mkPlanJson(tasks);
        const emptyPlan = mkPlanJson([]);
        const responses = [planJson, ...Array(numTasks + 5).fill(emptyPlan)];

        const runtime = mkSpyRuntime(responses);
        const node = mkHarnessNode("h1", [TARGET_A]);
        const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
        const handler = createAgentHarnessNodeHandler(node, nodeMap, {
          registry: testRegistry,
          extractJson: extractJsonFromText,
        });

        await handler(mkState(), mkConfig(runtime));

        // For each task, there should be:
        // 1. An emit for "in-progress" transition
        // 2. An emit for "completed" (or "failed") transition
        for (let i = 0; i < numTasks; i++) {
          const taskId = `t${i + 1}`;

          // Check in-progress emit
          const inProgressEmit = runtime._reasoningCalls.find(
            (c) =>
              c.nodeId === "h1" &&
              c.text.includes(taskId) &&
              c.text.includes("in-progress"),
          );
          expect(inProgressEmit).toBeDefined();

          // Check completed emit
          const completedEmit = runtime._reasoningCalls.find(
            (c) =>
              c.nodeId === "h1" &&
              c.text.includes(taskId) &&
              c.text.includes("completed"),
          );
          expect(completedEmit).toBeDefined();
        }
      }),
      { numRuns: 100 },
    );
  });

  test("failed tasks emit a status event with the task id and 'failed'", async () => {
    // Feature: agent-harness-node, Property 19: Status changes emit task id and new status
    // **Validates: Requirements 9.2**
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (numTasks) => {
        testRegistry = new NodeHandlerRegistry();
        // Register a handler for "llm" (needed for plan call factory resolution)
        // but use a target whose type ("unregistered-type") has no handler —
        // this makes delegate return ok:false reliably without depending on
        // mock state ordering.
        registerSuccessHandler("llm");

        const tasks = Array.from({ length: numTasks }, (_, i) => ({
          description: `Fail-Task-${i + 1}`,
          target: TARGET_A,
        }));
        const planJson = mkPlanJson(tasks);
        const emptyPlan = mkPlanJson([]);
        const responses = [planJson, ...Array(numTasks + 5).fill(emptyPlan)];

        const runtime = mkSpyRuntime(responses);
        const node = mkHarnessNode("h1", [TARGET_A]);
        // KEY: nodeMap has TARGET_A as type "unregistered-type" which has no handler
        const nodeMap = mkNodeMap({
          id: TARGET_A,
          type: "unregistered-type",
        } as unknown as FlowNode);
        const handlerFn = createAgentHarnessNodeHandler(node, nodeMap, {
          registry: testRegistry,
          extractJson: extractJsonFromText,
        });

        await handlerFn(mkState(), mkConfig(runtime));

        // Each task should have a "failed" status emit
        for (let i = 0; i < numTasks; i++) {
          const taskId = `t${i + 1}`;
          const failedEmit = runtime._reasoningCalls.find(
            (c) =>
              c.nodeId === "h1" &&
              c.text.includes(taskId) &&
              c.text.includes("failed"),
          );
          expect(failedEmit).toBeDefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20: Delegation emits the selected target
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 20: Delegation emits the selected target", () => {
  test("for each delegation, an onReasoning event contains 'delegating to <target>'", async () => {
    // Feature: agent-harness-node, Property 20: Delegation emits the selected target
    // **Validates: Requirements 9.3**
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom(TARGET_A, TARGET_B),
        async (numTasks, target) => {
          testRegistry = new NodeHandlerRegistry();
          registerSuccessHandler("llm");

          const tasks = Array.from({ length: numTasks }, (_, i) => ({
            description: `Task-${i + 1}`,
            target,
          }));
          const planJson = mkPlanJson(tasks);
          const emptyPlan = mkPlanJson([]);
          const responses = [planJson, ...Array(numTasks + 5).fill(emptyPlan)];

          const runtime = mkSpyRuntime(responses);
          const node = mkHarnessNode("h1", [TARGET_A, TARGET_B]);
          const nodeMap = mkNodeMap(
            mkFlowNode(TARGET_A, "llm"),
            mkFlowNode(TARGET_B, "llm"),
          );
          const handler = createAgentHarnessNodeHandler(node, nodeMap, {
            registry: testRegistry,
            extractJson: extractJsonFromText,
          });

          await handler(mkState(), mkConfig(runtime));

          // Count delegation events mentioning the target
          const delegationEmits = runtime._reasoningCalls.filter(
            (c) =>
              c.nodeId === "h1" &&
              c.text.includes("delegating to") &&
              c.text.includes(target),
          );
          // Should have exactly numTasks delegation emits
          expect(delegationEmits.length).toBe(numTasks);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("with mixed targets, each delegation emit names the correct target", async () => {
    // Feature: agent-harness-node, Property 20: Delegation emits the selected target
    // **Validates: Requirements 9.3**
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(TARGET_A, TARGET_B), {
          minLength: 1,
          maxLength: 5,
        }),
        async (targets) => {
          testRegistry = new NodeHandlerRegistry();
          registerSuccessHandler("llm");

          const tasks = targets.map((t, i) => ({
            description: `Task-${i + 1}`,
            target: t,
          }));
          const planJson = mkPlanJson(tasks);
          const emptyPlan = mkPlanJson([]);
          const responses = [
            planJson,
            ...Array(targets.length + 5).fill(emptyPlan),
          ];

          const runtime = mkSpyRuntime(responses);
          const node = mkHarnessNode("h1", [TARGET_A, TARGET_B]);
          const nodeMap = mkNodeMap(
            mkFlowNode(TARGET_A, "llm"),
            mkFlowNode(TARGET_B, "llm"),
          );
          const handler = createAgentHarnessNodeHandler(node, nodeMap, {
            registry: testRegistry,
            extractJson: extractJsonFromText,
          });

          await handler(mkState(), mkConfig(runtime));

          // Find all delegation emits (in order)
          const delegationEmits = runtime._reasoningCalls.filter(
            (c) => c.nodeId === "h1" && c.text.includes("delegating to"),
          );

          // Should have one per task
          expect(delegationEmits.length).toBe(targets.length);

          // Each delegation emit should mention the correct target in order
          for (const [i, target] of targets.entries()) {
            const emit = delegationEmits[i];
            if (emit === undefined) throw new Error(`expected a delegation emit at index ${i}`);
            expect(emit.text).toContain(target);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21: Termination emits a final status event
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 21: Termination emits a final status event", () => {
  test("on every termination, onReasoning emits a 'Harness stopped' event and onNodeIo emits the assembled result exactly once", async () => {
    // Feature: agent-harness-node, Property 21: Termination emits a final status event
    // **Validates: Requirements 9.4**
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (numTasks) => {
        testRegistry = new NodeHandlerRegistry();
        registerSuccessHandler("llm");

        const tasks = Array.from({ length: numTasks }, (_, i) => ({
          description: `Task-${i + 1}`,
          target: TARGET_A,
        }));
        const planJson = mkPlanJson(tasks);
        const emptyPlan = mkPlanJson([]);
        const responses = [planJson, ...Array(numTasks + 5).fill(emptyPlan)];

        const runtime = mkSpyRuntime(responses);
        const node = mkHarnessNode("h1", [TARGET_A]);
        const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
        const handler = createAgentHarnessNodeHandler(node, nodeMap, {
          registry: testRegistry,
          extractJson: extractJsonFromText,
        });

        await handler(mkState(), mkConfig(runtime));

        // Final status reasoning emit — should contain "Harness stopped"
        const finalStatusEmits = runtime._reasoningCalls.filter(
          (c) => c.nodeId === "h1" && c.text.includes("Harness stopped"),
        );
        expect(finalStatusEmits.length).toBe(1);
        // It should mention the stop reason
        expect(first(finalStatusEmits).text).toContain("completed");

        // onNodeIo should be called exactly once for the harness node with a response
        const ioEmits = runtime._nodeIoCalls.filter(
          (c) => c.nodeId === "h1" && c.io.response !== undefined,
        );
        expect(ioEmits.length).toBe(1);
        // The response should contain the assembled result (task IDs)
        const response = first(ioEmits).io.response;
        if (response === undefined) throw new Error("expected an io response");
        for (let i = 0; i < numTasks; i++) {
          expect(response).toContain(`t${i + 1}`);
        }
      }),
      { numRuns: 100 },
    );
  });

  test("iteration-limit stop emits a final status event with the limit reason", async () => {
    // Feature: agent-harness-node, Property 21: Termination emits a final status event
    // **Validates: Requirements 9.4**
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (maxIter) => {
        testRegistry = new NodeHandlerRegistry();
        registerSuccessHandler("llm");

        // More tasks than limit
        const numTasks = maxIter + 3;
        const tasks = Array.from({ length: numTasks }, (_, i) => ({
          description: `Task-${i + 1}`,
          target: TARGET_A,
        }));
        const planJson = mkPlanJson(tasks);
        const emptyPlan = mkPlanJson([]);
        const responses = [planJson, ...Array(numTasks + 5).fill(emptyPlan)];

        const runtime = mkSpyRuntime(responses);
        const node = mkHarnessNode("h1", [TARGET_A], {
          maxIterations: maxIter,
        });
        const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
        const handler = createAgentHarnessNodeHandler(node, nodeMap, {
          registry: testRegistry,
          extractJson: extractJsonFromText,
        });

        await handler(mkState(), mkConfig(runtime));

        // Final status reasoning emit must mention "iteration-limit"
        const finalStatusEmits = runtime._reasoningCalls.filter(
          (c) => c.nodeId === "h1" && c.text.includes("Harness stopped"),
        );
        expect(finalStatusEmits.length).toBe(1);
        expect(first(finalStatusEmits).text).toContain("iteration-limit");

        // onNodeIo emits exactly once
        const ioEmits = runtime._nodeIoCalls.filter(
          (c) => c.nodeId === "h1" && c.io.response !== undefined,
        );
        expect(ioEmits.length).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  test("planning-failure stop emits a final status event", async () => {
    // Feature: agent-harness-node, Property 21: Termination emits a final status event
    // **Validates: Requirements 9.4**
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => {
          try {
            const p = JSON.parse(s);
            return !p || !Array.isArray(p.tasks);
          } catch {
            return true;
          }
        }),
        async (garbageText) => {
          testRegistry = new NodeHandlerRegistry();
          registerSuccessHandler("llm");

          const runtime = mkSpyRuntime([garbageText]);
          const node = mkHarnessNode("h1", [TARGET_A]);
          const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
          const handler = createAgentHarnessNodeHandler(node, nodeMap, {
            registry: testRegistry,
            extractJson: extractJsonFromText,
          });

          await handler(mkState(), mkConfig(runtime));

          // Final status event must be emitted even on planning failure
          const finalStatusEmits = runtime._reasoningCalls.filter(
            (c) => c.nodeId === "h1" && c.text.includes("Harness stopped"),
          );
          expect(finalStatusEmits.length).toBe(1);
          expect(first(finalStatusEmits).text).toContain("planning-failure");

          // onNodeIo emits exactly once
          const ioEmits = runtime._nodeIoCalls.filter(
            (c) => c.nodeId === "h1" && c.io.response !== undefined,
          );
          expect(ioEmits.length).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("no-tasks stop emits a final status event", async () => {
    // Feature: agent-harness-node, Property 21: Termination emits a final status event
    // **Validates: Requirements 9.4**
    testRegistry = new NodeHandlerRegistry();
    registerSuccessHandler("llm");

    const emptyPlan = mkPlanJson([]);
    const runtime = mkSpyRuntime([emptyPlan]);
    const node = mkHarnessNode("h1", [TARGET_A]);
    const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
    const handler = createAgentHarnessNodeHandler(node, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });

    await handler(mkState(), mkConfig(runtime));

    // Final status event
    const finalStatusEmits = runtime._reasoningCalls.filter(
      (c) => c.nodeId === "h1" && c.text.includes("Harness stopped"),
    );
    expect(finalStatusEmits.length).toBe(1);
    expect(first(finalStatusEmits).text).toContain("no-tasks");

    // onNodeIo exactly once
    const ioEmits = runtime._nodeIoCalls.filter(
      (c) => c.nodeId === "h1" && c.io.response !== undefined,
    );
    expect(ioEmits.length).toBe(1);
  });
});
