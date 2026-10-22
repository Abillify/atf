// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the structured harness progress events.
 *
 * The contracts that matter:
 *   - `buildHarnessProgress` counts `tasksDone` over terminal tasks only
 *     (`completed`/`failed`) and reports `tasksTotal` over all tasks;
 *   - `etaMs` follows `(elapsedMs / tasksDone) * (tasksTotal - tasksDone)`
 *     and is only present once at least two tasks are done;
 *   - the harness loop calls `runtime.onProgress` with the phase of the
 *     region that emitted the status line (research during the task loop);
 *   - the SSE sink receives the same events and the wire frame is exactly
 *     `event: atf.progress\ndata: <JSON>\n\n`.
 */

import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { FlowNode } from "../../types/flow.js";
import type { ToolResultEntry } from "../../types/monitoring.js";
import { createAgentHarnessNodeHandler } from "../agent-harness.js";
import { nodeInstanceOf } from "../graph-engine/node-instance.js";
import type {
  AgentState,
  ExecRuntime,
  UsageAccumulator,
} from "../graph-engine.js";
import type { HarnessProgress as HarnessRunProgress } from "../agent-harness/types.js";
import {
  buildHarnessProgress,
  emitHarnessProgress,
  harnessProgressSseFrame,
  registerHarnessProgressSink,
  type HarnessProgress,
} from "../agent-harness/progress-event.js";

const DOC_COUNT = 3;

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
} as AppConfig;

function mkUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Seven one-document summaries; the queue issues coverage-1…coverage-N. */
function mkSeed(): ToolResultEntry {
  return {
    tool_call_id: "seed",
    tool_name: "vectorsearch/get_summaries",
    result: {
      summaries: Array.from({ length: DOC_COUNT }, (_unused, index) => ({
        reference: `/D${index + 1}`,
        title: `D${index + 1}`,
        summary: `Summary D${index + 1}.`,
      })),
      count: DOC_COUNT,
      total: DOC_COUNT,
    },
    execution_time_seconds: 0,
  };
}

function mkNodeMap(ids: string[]): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  for (const id of ids) {
    map.set(id, {
      id,
      type: "llm",
      llm: { provider: "openai", model: "test-model" },
    } as unknown as FlowNode);
  }
  return map;
}

function mkRunProgress(statuses: HarnessRunProgress["tasks"][number]["status"][]): HarnessRunProgress {
  return {
    tasks: statuses.map((status, index) => ({
      id: `t${index + 1}`,
      displayStep: index + 1,
      description: `Task ${index + 1}`,
      target: "worker",
      status,
    })),
    iterations: 0,
    cost: 0,
  };
}

describe("buildHarnessProgress", () => {
  test("tasksDone counts terminal tasks, tasksTotal counts all", () => {
    const progress = mkRunProgress([
      "completed",
      "failed",
      "in-progress",
      "pending",
    ]);
    const event = buildHarnessProgress(progress, "research", Date.now() - 100);
    expect(event.tasksDone).toBe(2);
    expect(event.tasksTotal).toBe(4);
    expect(event.phase).toBe("research");
  });

  test("etaMs extrapolates linearly once two tasks are done", () => {
    const progress = mkRunProgress([
      "completed",
      "completed",
      "pending",
      "pending",
    ]);
    const startTime = Date.now() - 1000;
    const event = buildHarnessProgress(progress, "research", startTime);
    // (elapsed / 2 done) * 2 remaining ≈ elapsed; allow for the ms boundary.
    expect(event.etaMs).toBeDefined();
    expect(event.etaMs ?? Number.NaN).toBeCloseTo(event.elapsedMs, -2);
  });

  test("etaMs is absent while fewer than two tasks are done", () => {
    expect(
      buildHarnessProgress(
        mkRunProgress(["completed", "pending"]),
        "research",
        Date.now() - 500,
      ).etaMs,
    ).toBeUndefined();
    expect(
      buildHarnessProgress(
        mkRunProgress(["pending"]),
        "planning",
        Date.now() - 500,
      ).etaMs,
    ).toBeUndefined();
  });

  test("coverage snapshot and message are passed through when provided", () => {
    const event = buildHarnessProgress(
      mkRunProgress(["completed"]),
      "research",
      Date.now(),
      { covered: 2, total: 5, open: 3 },
      "Task t1 → completed",
    );
    expect(event.coverage).toEqual({ covered: 2, total: 5, open: 3 });
    expect(event.message).toBe("Task t1 → completed");
    expect(
      buildHarnessProgress(mkRunProgress([]), "planning", Date.now()).coverage,
    ).toBeUndefined();
  });
});

describe("atf.progress SSE frame", () => {
  test("frame is exactly `event: atf.progress` plus the JSON payload", () => {
    const event: HarnessProgress = {
      phase: "research",
      tasksDone: 1,
      tasksTotal: 2,
      elapsedMs: 42,
      message: "Task t1 → completed",
    };
    expect(harnessProgressSseFrame(event)).toBe(
      `event: atf.progress\ndata: ${JSON.stringify(event)}\n\n`,
    );
  });

  test("sinks receive events per execution id and stop after unregister", () => {
    const seen: HarnessProgress[] = [];
    const other: HarnessProgress[] = [];
    const unregister = registerHarnessProgressSink("exec-progress-1", (p) =>
      seen.push(p),
    );
    registerHarnessProgressSink("exec-progress-2", (p) => other.push(p));

    const event: HarnessProgress = {
      phase: "planning",
      tasksDone: 0,
      tasksTotal: 0,
      elapsedMs: 1,
    };
    emitHarnessProgress("exec-progress-1", event);
    expect(seen).toEqual([event]);
    expect(other).toEqual([]);

    unregister();
    emitHarnessProgress("exec-progress-1", event);
    expect(seen).toHaveLength(1);
  });

  test("a throwing sink does not break the emit for the others", () => {
    const seen: HarnessProgress[] = [];
    registerHarnessProgressSink("exec-progress-3", () => {
      throw new Error("dead transport");
    });
    registerHarnessProgressSink("exec-progress-3", (p) => seen.push(p));
    const event: HarnessProgress = {
      phase: "research",
      tasksDone: 0,
      tasksTotal: 1,
      elapsedMs: 1,
    };
    emitHarnessProgress("exec-progress-3", event);
    expect(seen).toHaveLength(1);
  });
});

describe("harness loop emits structured progress", () => {
  test("runtime.onProgress receives research-phase events with task counters", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({ tasks: [] }) }],
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

    const captured: Array<{ nodeId: string; progress: HarnessProgress }> = [];
    const sinkEvents: HarnessProgress[] = [];
    const executionId = "exec-progress-loop";
    const unregister = registerHarnessProgressSink(executionId, (p) =>
      sinkEvents.push(p),
    );

    const runtime = {
      appConfig: baseConfig,
      ctx: { ssoToken: "t", executionId },
      usage: mkUsage(),
      llmProviderFactory: () => model,
      onToken: async () => {},
      onReasoning: async () => {},
      onToolCall: async () => {},
      onToolResult: async () => {},
      onNodeStart: () => {},
      onNodeEnd: async () => {},
      onNodeIo: () => {},
      onNodeDiagnostic: () => {},
      onProgress: (nodeId: string, progress: HarnessProgress) => {
        captured.push({ nodeId, progress });
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
        summary: () => ({}) as never,
      } as unknown as ExecRuntime["metrics"],
      costTracker: { record: () => {} },
    } as unknown as ExecRuntime;

    const registry = {
      get: (_type: string) => ({
        factory:
          (targetNode: FlowNode) =>
          async (
            _state: AgentState,
            childConfig?: LangGraphRunnableConfig,
          ): Promise<Partial<AgentState>> => {
            if (targetNode.id === "reviewer") {
              return { messages: [new AIMessage("VERIFIKATION OK")] };
            }
            // Task tN is seeded from coverage-N, which covers exactly /DN
            // (batchSize 1 over the seeded order).
            const instance = nodeInstanceOf(childConfig) ?? "t1-attempt-1";
            const n = /^t(\d+)-attempt-\d+$/u.exec(instance)?.[1] ?? "1";
            return {
              messages: [
                new AIMessage(
                  `ABGEDECKT: /D${n}\nBEFUNDE: Befund D${n}.\n<COVERAGE>` +
                    `{"assignmentId":"coverage-${n}","documents":[{"ref":"/D${n}","decision":"excluded","reason":"Nicht einschlaegig"}]}` +
                    "</COVERAGE>",
                ),
              ],
            };
          },
      }),
    };

    const node = {
      id: "orchestrator",
      type: "agent-harness",
      llm: { provider: "openai", model: "test-model" },
      config: {
        allowlist: ["worker"],
        plannerless: true,
        carryForward: "condensed",
        maxIterations: 20,
        coverageQueue: {
          enabled: true,
          sourceTool: "vectorsearch/get_summaries",
          batchSize: 1,
          maxOriginalsPerBatch: 1,
          assignmentCharBudget: 1000,
          documentWindowChars: 1000,
          markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        },
        verification: {
          target: "reviewer",
          passSignal: "VERIFIKATION OK",
          failClosed: true,
        },
      },
    } as unknown as FlowNode;

    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "worker", "reviewer"]),
      { registry },
    );
    const state = {
      messages: [new HumanMessage("Pruefe die Akte.")],
      context: { ssoToken: "t", executionId },
      citations: [],
      toolResults: [mkSeed()],
      errors: [],
      turns: [],
    } as unknown as AgentState;
    try {
      await handler(state, {
        configurable: { runtime },
      } as LangGraphRunnableConfig);
    } finally {
      unregister();
    }

    // Every status line produced a structured event for this node.
    expect(captured.length).toBeGreaterThan(0);
    for (const { nodeId } of captured) {
      expect(nodeId).toBe("orchestrator");
    }
    // Planning happens before the loop…
    expect(captured.some((e) => e.progress.phase === "planning")).toBe(true);
    // …and the task loop itself reports research with growing counters.
    const research = captured.filter(
      (e) => e.progress.phase === "research",
    );
    expect(research.length).toBeGreaterThan(0);
    expect(
      research.some(
        (e) => e.progress.tasksTotal > 0 && e.progress.tasksDone >= 0,
      ),
    ).toBe(true);
    // The verification gate ran (failClosed verifier passed).
    expect(captured.some((e) => e.progress.phase === "verification")).toBe(
      true,
    );
    // The final status lines come from the synthesis phase.
    expect(captured.some((e) => e.progress.phase === "synthesis")).toBe(true);
    // The last event carries the terminal counters for all seeded tasks.
    const last = captured[captured.length - 1];
    expect(last.progress.tasksTotal).toBe(DOC_COUNT);
    expect(last.progress.tasksDone).toBe(DOC_COUNT);
    expect(last.progress.coverage).toBeDefined();
    expect(last.progress.coverage?.total).toBe(DOC_COUNT);

    // The side-channel sink (the streaming route's transport) saw the same
    // events.
    expect(sinkEvents.length).toBe(captured.length);
    expect(sinkEvents[0].phase).toBe("planning");
  });
});
