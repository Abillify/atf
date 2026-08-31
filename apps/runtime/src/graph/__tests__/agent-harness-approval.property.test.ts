// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property tests for approval gating in the agent-harness node.
 *
 * Feature: agent-harness-node, Property 24: Consequential targets are gated before delegation
 * Feature: agent-harness-node, Property 25: Approval decision drives delegation or failure
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
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
import type { HarnessProgress } from "../agent-harness.js";
import type { MetricsSummary } from "../../observability/metrics.js";
import type { ApprovalRegistry } from "../approval-gate.js";
import { createAgentHarnessNodeHandler } from "../agent-harness.js";

// ---------------------------------------------------------------------------
// Test-local extractJsonFromText (avoids cross-file mock pollution)
// ---------------------------------------------------------------------------

function extractJsonFromText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TARGET_A = "worker-a";

function mkFlowNode(id: string, type: string = "llm"): FlowNode {
  return { id, type } as FlowNode;
}

function mkNodeMap(...nodes: FlowNode[]): Map<string, FlowNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

interface ApprovalRequest {
  executionId: string;
  nodeId: string;
  tool: string;
  args: Record<string, unknown>;
}

interface SpyRuntime extends ExecRuntime {
  _reasoningCalls: Array<{ nodeId: string; text: string }>;
  _nodeStartCalls: string[];
  _nodeEndCalls: Array<{ nodeId: string; error?: string }>;
  _nodeIoCalls: Array<{
    nodeId: string;
    io: { prompt?: string; response?: string };
  }>;
  _approvalRequests: ApprovalRequest[];
}

/**
 * Build a spy runtime with an approvalGate that resolves with the given decision.
 * `planResponses` controls what the planner LLM returns in sequence.
 * `approvalDecision` controls what the approval gate resolves to.
 */
function mkSpyRuntime(
  planResponses: string[],
  approvalDecision: { approved: boolean; reason?: string } = { approved: true },
): SpyRuntime {
  let callIdx = 0;
  const reasoningCalls: Array<{ nodeId: string; text: string }> = [];
  const nodeStartCalls: string[] = [];
  const nodeEndCalls: Array<{ nodeId: string; error?: string }> = [];
  const nodeIoCalls: Array<{
    nodeId: string;
    io: { prompt?: string; response?: string };
  }> = [];
  const approvalRequests: ApprovalRequest[] = [];

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
    approvalGate: {
      enabled: true,
      request: async (req: ApprovalRequest) => {
        approvalRequests.push(req);
        return approvalDecision;
      },
    },
    onApprovalRequired: () => {},
    _reasoningCalls: reasoningCalls,
    _nodeStartCalls: nodeStartCalls,
    _nodeEndCalls: nodeEndCalls,
    _nodeIoCalls: nodeIoCalls,
    _approvalRequests: approvalRequests,
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

/** Create a harness FlowNode with consequentialTargets config. */
function mkHarnessNode(
  id: string,
  allowlist: string[],
  opts: {
    maxIterations?: number;
    consequentialTargets?: string[];
  } = {},
): FlowNode {
  return {
    id,
    type: "agent-harness",
    llm: { provider: "openai", model: "gpt-4o" },
    config: { allowlist, ...opts },
  } as unknown as FlowNode;
}

/** Build a plan JSON string for the LLM to "return". */
function mkPlanJson(
  tasks: Array<{ description: string; target: string }>,
): string {
  return JSON.stringify({ tasks });
}

/** Register stub handlers for targets that succeed. */
function registerSuccessHandler(type: string): void {
  const handler: NodeHandler = async () => ({
    messages: [new AIMessage("(done)")],
  });
  testRegistry.register({ type, emitsLifecycle: true, factory: () => handler });
}

// ---------------------------------------------------------------------------
// Property 24: Consequential targets are gated before delegation
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 24: Consequential targets are gated before delegation", () => {
  test("approvalGate.request() is called BEFORE the target handler is invoked for consequential targets", async () => {
    // Feature: agent-harness-node, Property 24: Consequential targets are gated before delegation
    // **Validates: Requirements 11.1**
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (numTasks) => {
        testRegistry = new NodeHandlerRegistry();
        registerSuccessHandler("llm");

        const tasks = Array.from({ length: numTasks }, (_, i) => ({
          description: `Task ${i + 1}`,
          target: TARGET_A,
        }));
        const planJson = mkPlanJson(tasks);
        const emptyPlan = mkPlanJson([]);
        const responses = [planJson, ...Array(numTasks + 5).fill(emptyPlan)];

        // Track the order of events: approval requests and delegations (onNodeStart)
        const eventLog: string[] = [];
        const approvalRequests: ApprovalRequest[] = [];

        const runtime = mkSpyRuntime(responses, { approved: true });
        // Override approval gate to record order
        runtime.approvalGate = {
          enabled: true,
          request: async (req: ApprovalRequest) => {
            approvalRequests.push(req);
            eventLog.push("approval");
            return { approved: true };
          },
        } as unknown as ApprovalRegistry;
        // Override onNodeStart to record delegation-start events for the target
        const originalOnNodeStart = runtime.onNodeStart;
        runtime.onNodeStart = (nodeId: string) => {
          if (nodeId === TARGET_A) {
            eventLog.push("delegation");
          }
          originalOnNodeStart.call(runtime, nodeId);
        };

        const node = mkHarnessNode("h1", [TARGET_A], {
          consequentialTargets: [TARGET_A],
        });
        const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
        const handlerFn = createAgentHarnessNodeHandler(node, nodeMap, {
          registry: testRegistry,
          extractJson: extractJsonFromText,
        });

        const result = await handlerFn(mkState(), mkConfig(runtime));
        const harness = (result as { harness?: HarnessProgress }).harness;
        if (harness === undefined) throw new Error("expected harness to be defined");

        // Approval was requested for each task
        expect(approvalRequests.length).toBe(numTasks);

        // The event log should have alternating approval/delegation pairs
        // i.e. for each task: approval comes before delegation (onNodeStart)
        expect(eventLog.length).toBe(numTasks * 2);
        for (let i = 0; i < numTasks; i++) {
          expect(eventLog[i * 2]).toBe("approval");
          expect(eventLog[i * 2 + 1]).toBe("delegation");
        }

        // All tasks completed successfully
        expect(harness.tasks.every((t) => t.status === "completed")).toBe(
          true,
        );
      }),
      { numRuns: 100 },
    );
  });

  test("non-consequential targets do NOT trigger the approval gate", async () => {
    // Feature: agent-harness-node, Property 24: Consequential targets are gated before delegation
    // **Validates: Requirements 11.1**
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (numTasks) => {
        testRegistry = new NodeHandlerRegistry();
        registerSuccessHandler("llm");

        const tasks = Array.from({ length: numTasks }, (_, i) => ({
          description: `Task ${i + 1}`,
          target: TARGET_A,
        }));
        const planJson = mkPlanJson(tasks);
        const emptyPlan = mkPlanJson([]);
        const responses = [planJson, ...Array(numTasks + 5).fill(emptyPlan)];

        const approvalRequests: ApprovalRequest[] = [];
        const runtime = mkSpyRuntime(responses, { approved: true });
        runtime.approvalGate = {
          enabled: true,
          request: async (req: ApprovalRequest) => {
            approvalRequests.push(req);
            return { approved: true };
          },
        } as unknown as ApprovalRegistry;

        // consequentialTargets does NOT include TARGET_A
        const node = mkHarnessNode("h1", [TARGET_A], {
          consequentialTargets: ["some-other-target"],
        });
        const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
        const handlerFn = createAgentHarnessNodeHandler(node, nodeMap, {
          registry: testRegistry,
          extractJson: extractJsonFromText,
        });

        await handlerFn(mkState(), mkConfig(runtime));

        // Approval gate should NOT have been called
        expect(approvalRequests.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25: Approval decision drives delegation or failure
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 25: Approval decision drives delegation or failure", () => {
  test("when approval is granted, delegation proceeds and task completes", async () => {
    // Feature: agent-harness-node, Property 25: Approval decision drives delegation or failure
    // **Validates: Requirements 11.3, 11.4**
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (numTasks) => {
        testRegistry = new NodeHandlerRegistry();
        registerSuccessHandler("llm");

        const tasks = Array.from({ length: numTasks }, (_, i) => ({
          description: `Task ${i + 1}`,
          target: TARGET_A,
        }));
        const planJson = mkPlanJson(tasks);
        const emptyPlan = mkPlanJson([]);
        const responses = [planJson, ...Array(numTasks + 5).fill(emptyPlan)];

        // Approval gate approves everything
        const runtime = mkSpyRuntime(responses, { approved: true });

        const node = mkHarnessNode("h1", [TARGET_A], {
          consequentialTargets: [TARGET_A],
        });
        const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
        const handlerFn = createAgentHarnessNodeHandler(node, nodeMap, {
          registry: testRegistry,
          extractJson: extractJsonFromText,
        });

        const result = await handlerFn(mkState(), mkConfig(runtime));
        const harness = (result as { harness?: HarnessProgress }).harness;
        if (harness === undefined) throw new Error("expected harness to be defined");

        // All tasks should be completed (approval granted → delegation proceeded)
        expect(harness.tasks.every((t) => t.status === "completed")).toBe(
          true,
        );
        expect(harness.stopReason).toBe("completed");
        // Each completed task should have a result set (proving delegation ran)
        for (const task of harness.tasks) {
          expect(task.result).toBeDefined();
          if (task.result === undefined) throw new Error("expected task.result to be defined");
          expect(task.result.length).toBeGreaterThan(0);
        }
        // onNodeStart should have been called for the target (proving delegation emitted lifecycle)
        const targetStarts = runtime._nodeStartCalls.filter(
          (id) => id === TARGET_A,
        );
        expect(targetStarts.length).toBe(numTasks);
      }),
      { numRuns: 100 },
    );
  });

  test("when approval is rejected, task is marked failed with reason and loop re-plans", async () => {
    // Feature: agent-harness-node, Property 25: Approval decision drives delegation or failure
    // **Validates: Requirements 11.3, 11.4**
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 3, maxLength: 50 })
          .filter((s) => s.trim().length > 2),
        async (rejectionReason) => {
          testRegistry = new NodeHandlerRegistry();

          let delegationCount = 0;
          const handler: NodeHandler = async () => {
            delegationCount++;
            return { messages: [new AIMessage("(done)")] };
          };
          testRegistry.register({
            type: "llm",
            emitsLifecycle: true,
            factory: () => handler,
          });

          const tasks = [
            { description: "Consequential work", target: TARGET_A },
          ];
          const planJson = mkPlanJson(tasks);
          const emptyPlan = mkPlanJson([]);
          const responses = [planJson, emptyPlan, emptyPlan, emptyPlan];

          // Approval gate rejects with the given reason
          const runtime = mkSpyRuntime(responses, {
            approved: false,
            reason: rejectionReason,
          });

          const node = mkHarnessNode("h1", [TARGET_A], {
            consequentialTargets: [TARGET_A],
          });
          const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
          const handlerFn = createAgentHarnessNodeHandler(node, nodeMap, {
            registry: testRegistry,
            extractJson: extractJsonFromText,
          });

          const result = await handlerFn(mkState(), mkConfig(runtime));
          const harness = (result as { harness?: HarnessProgress }).harness;
          if (harness === undefined) throw new Error("expected harness to be defined");

          // Delegation should NOT have been called (rejected before delegation)
          expect(delegationCount).toBe(0);

          // The task should be failed with the rejection reason
          const failedTask = harness.tasks.find((t) => t.id === "t1");
          expect(failedTask).toBeDefined();
          if (failedTask === undefined) throw new Error("expected a failed task");
          expect(failedTask.status).toBe("failed");
          expect(failedTask.error).toBe(rejectionReason);

          // Error should be recorded in the state errors
          const errors = result.errors as Array<{ message: string }>;
          expect(errors.length).toBeGreaterThan(0);
          const approvalError = errors.find((e) =>
            e.message.includes("not approved"),
          );
          expect(approvalError).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("when approval is rejected without a reason, task error defaults to 'approval rejected'", async () => {
    // Feature: agent-harness-node, Property 25: Approval decision drives delegation or failure
    // **Validates: Requirements 11.4**
    testRegistry = new NodeHandlerRegistry();
    registerSuccessHandler("llm");

    const tasks = [{ description: "Work", target: TARGET_A }];
    const planJson = mkPlanJson(tasks);
    const emptyPlan = mkPlanJson([]);
    const responses = [planJson, emptyPlan, emptyPlan];

    // Rejection with no reason
    const runtime = mkSpyRuntime(responses, { approved: false });

    const node = mkHarnessNode("h1", [TARGET_A], {
      consequentialTargets: [TARGET_A],
    });
    const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
    const handlerFn = createAgentHarnessNodeHandler(node, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });

    const result = await handlerFn(mkState(), mkConfig(runtime));
    const harness = (result as { harness?: HarnessProgress }).harness;
    if (harness === undefined) throw new Error("expected harness to be defined");

    const failedTask = harness.tasks.find((t) => t.id === "t1");
    if (failedTask === undefined) throw new Error("expected a failed task");
    expect(failedTask.status).toBe("failed");
    expect(failedTask.error).toBe("approval rejected");
  });
});

// ---------------------------------------------------------------------------
// Example: Approval-hold ordering — no new task starts while decision is pending
// ---------------------------------------------------------------------------

describe("Example: approval-hold ordering (Req 11.2)", () => {
  test("no new task starts (no delegation onNodeStart for a target) until after approval resolves", async () => {
    // Validates: Requirements 11.2
    // Verify that `await` on approvalGate.request() holds the loop: no delegation
    // (onNodeStart for a target) happens until after the approval resolves.
    testRegistry = new NodeHandlerRegistry();
    registerSuccessHandler("llm");

    const tasks = [
      { description: "First consequential task", target: TARGET_A },
      { description: "Second task", target: TARGET_A },
    ];
    const planJson = mkPlanJson(tasks);
    const emptyPlan = mkPlanJson([]);
    const responses = [planJson, emptyPlan, emptyPlan, emptyPlan, emptyPlan];

    // Track temporal ordering: when approval resolves vs when delegations happen
    const timeline: Array<{ event: string; time: number }> = [];
    let approvalResolveTime = 0;

    const runtime = mkSpyRuntime(responses, { approved: true });
    // Override approvalGate with a delayed resolution to prove the loop holds
    runtime.approvalGate = {
      enabled: true,
      request: async (req: ApprovalRequest) => {
        // Simulate a delay representing waiting for user approval
        await new Promise((resolve) => setTimeout(resolve, 20));
        approvalResolveTime = Date.now();
        timeline.push({
          event: `approval-resolved:${req.args.taskId}`,
          time: approvalResolveTime,
        });
        return { approved: true };
      },
    } as unknown as ApprovalRegistry;

    // Override onNodeStart to track when delegations happen
    const originalOnNodeStart = runtime.onNodeStart;
    runtime.onNodeStart = (nodeId: string) => {
      if (nodeId === TARGET_A) {
        timeline.push({
          event: `delegation-start:${nodeId}`,
          time: Date.now(),
        });
      }
      originalOnNodeStart(nodeId);
    };

    const node = mkHarnessNode("h1", [TARGET_A], {
      consequentialTargets: [TARGET_A],
    });
    const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
    const handlerFn = createAgentHarnessNodeHandler(node, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });

    const result = await handlerFn(mkState(), mkConfig(runtime));
    const harness = (result as { harness?: HarnessProgress }).harness;
    if (harness === undefined) throw new Error("expected harness to be defined");

    // Both tasks should complete
    expect(harness.tasks.every((t) => t.status === "completed")).toBe(true);

    // Verify ordering: every delegation-start must come after an approval-resolved
    const approvalEvents = timeline.filter((e) =>
      e.event.startsWith("approval-resolved"),
    );
    const delegationEvents = timeline.filter((e) =>
      e.event.startsWith("delegation-start"),
    );

    // There should be approval events (one per consequential task)
    expect(approvalEvents.length).toBe(2);
    expect(delegationEvents.length).toBe(2);

    // Each delegation must happen after (or at same time as) its corresponding approval
    for (const [i, delegationEvent] of delegationEvents.entries()) {
      const approvalEvent = approvalEvents[i];
      if (approvalEvent === undefined) throw new Error("expected a corresponding approval event");
      expect(delegationEvent.time).toBeGreaterThanOrEqual(approvalEvent.time);
    }
  });

  test("approval gate disabled — no approval request is made, delegation proceeds directly", async () => {
    // Validates: Requirements 11.1 (gate only fires when enabled)
    testRegistry = new NodeHandlerRegistry();
    registerSuccessHandler("llm");

    const tasks = [{ description: "Work", target: TARGET_A }];
    const planJson = mkPlanJson(tasks);
    const emptyPlan = mkPlanJson([]);
    const responses = [planJson, emptyPlan, emptyPlan];

    const approvalRequests: ApprovalRequest[] = [];
    const runtime = mkSpyRuntime(responses, { approved: true });
    // Disable the approval gate
    runtime.approvalGate = {
      enabled: false,
      request: async (req: ApprovalRequest) => {
        approvalRequests.push(req);
        return { approved: true };
      },
    } as unknown as ApprovalRegistry;

    const node = mkHarnessNode("h1", [TARGET_A], {
      consequentialTargets: [TARGET_A],
    });
    const nodeMap = mkNodeMap(mkFlowNode(TARGET_A, "llm"));
    const handlerFn = createAgentHarnessNodeHandler(node, nodeMap, {
      registry: testRegistry,
      extractJson: extractJsonFromText,
    });

    const result = await handlerFn(mkState(), mkConfig(runtime));
    const harness = (result as { harness?: HarnessProgress }).harness;
    if (harness === undefined) throw new Error("expected harness to be defined");

    // Approval gate should NOT have been called (disabled)
    expect(approvalRequests.length).toBe(0);
    // Task should still complete via normal delegation
    const firstTask = harness.tasks[0];
    if (firstTask === undefined) throw new Error("expected a first task");
    expect(firstTask.status).toBe("completed");
  });
});
