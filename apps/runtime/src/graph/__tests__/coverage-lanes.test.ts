// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `coverageQueue.lanes` — parallel coverage lanes in the
 * plannerless agent harness.
 *
 * The contracts that matter:
 *   - `lanes: 1` (the default) keeps the plannerless loop exactly as it was:
 *     one assignment, one delegation, strictly sequential;
 *   - `lanes: n` seeds up to n assignments at once, each delegation carrying
 *     its own `atfNodeInstance` so the engine keeps their states apart;
 *   - results are incorporated in assignment (task) order, never in
 *     completion order — a slow first lane must not reorder the ledger or
 *     the carried findings;
 *   - an approval-required target stays single even with lanes > 1
 *     (selectTaskBatch rule 4 outranks the same-target exemption).
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

const DOC_COUNT = 7;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seven one-document summaries; the queue issues coverage-1…coverage-7. */
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

type HarnessUpdate = {
  messages?: unknown;
  errors?: Array<{ message: string }>;
  harness?: {
    stopReason?: string;
    partial?: boolean;
    verified?: boolean;
    iterations: number;
    coverage?: { documents: Array<{ ref: string; status: string }> };
  };
};

function messagesText(messages: unknown): string {
  if (!Array.isArray(messages)) return String(messages ?? "");
  return messages
    .map((message) =>
      String(
        (message as { content?: unknown }).content ??
          (message as { text?: unknown }).text ??
          "",
      ),
    )
    .join("\n");
}

interface LaneRun {
  update: HarnessUpdate;
  /** Ordered trace of `start:<instance>` / `end:<instance>` markers. */
  trace: string[];
  /** Highest number of worker delegations observed in flight at once. */
  maxInFlight: number;
  approvalRequests: number;
}

async function runLanes(options: {
  lanes: number;
  delayFor: (instance: string) => number;
  consequential?: boolean;
  approval?: boolean;
}): Promise<LaneRun> {
  const trace: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let approvalRequests = 0;

  // The plannerless loop never calls the planner; the model fake only keeps
  // `llmProviderFactory` honest.
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

  const runtime = {
    appConfig: baseConfig,
    ctx: { ssoToken: "t", executionId: "exec-1" },
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
    ...(options.approval === true
      ? {
          approvalGate: {
            enabled: true,
            request: async () => {
              approvalRequests += 1;
              return { approved: true };
            },
          },
        }
      : {}),
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
          // The delegation instance is stamped by the harness onto the child
          // config (`atfNodeInstance`); it is what keeps concurrent lanes of
          // the SAME target node apart inside the engine.
          const instance = nodeInstanceOf(childConfig) ?? "no-instance";
          trace.push(`start:${instance}`);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await sleep(options.delayFor(instance));
          inFlight -= 1;
          trace.push(`end:${instance}`);
          // Task tN is seeded from coverage-N, which covers exactly /DN
          // (batchSize 1 over the seeded order), so the report can be built
          // from the instance alone.
          const n = /^t(\d+)-attempt-\d+$/u.exec(instance)?.[1] ?? "0";
          return {
            messages: [
              new AIMessage(
                `ABGEDECKT: /D${n}\nBEFUNDE: Befund D${n}.\n<COVERAGE>` +
                  `{"assignmentId":"coverage-${n}","documents":[{"ref":"/D${n}","decision":"excluded","reason":"Nicht einschlaegig"}]}` +
                  `</COVERAGE>`,
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
      ...(options.consequential === true
        ? { consequentialTargets: ["worker"] }
        : {}),
      coverageQueue: {
        enabled: true,
        sourceTool: "vectorsearch/get_summaries",
        batchSize: 1,
        maxOriginalsPerBatch: 1,
        assignmentCharBudget: 1000,
        documentWindowChars: 1000,
        lanes: options.lanes,
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
    context: { ssoToken: "t", executionId: "exec-1" },
    citations: [],
    toolResults: [mkSeed()],
    errors: [],
    turns: [],
  } as unknown as AgentState;
  const update = (await handler(state, {
    configurable: { runtime },
  } as LangGraphRunnableConfig)) as HarnessUpdate;
  return { update, trace, maxInFlight, approvalRequests };
}

describe("coverage lanes (coverageQueue.lanes)", () => {
  test("lanes: 1 keeps the plannerless coverage loop strictly sequential", async () => {
    const { update, trace, maxInFlight } = await runLanes({
      lanes: 1,
      delayFor: () => 1,
    });

    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.verified).toBe(true);
    expect(maxInFlight).toBe(1);
    // Exactly one delegation at a time: start and end strictly alternate.
    expect(trace).toEqual(
      Array.from({ length: DOC_COUNT }, (_unused, index) => [
        `start:t${index + 1}-attempt-1`,
        `end:t${index + 1}-attempt-1`,
      ]).flat(),
    );
  });

  test("lanes: 3 works batches 3/3/1 with distinct instances and merges findings in assignment order", async () => {
    // Lane 1 of the first batch is the SLOWEST: completion order is
    // t2, t3, t1 while the ledger and the carried findings must stay t1, t2, t3.
    const delays: Record<string, number> = {
      "t1-attempt-1": 60,
      "t2-attempt-1": 20,
      "t3-attempt-1": 30,
    };
    const { update, trace, maxInFlight } = await runLanes({
      lanes: 3,
      delayFor: (instance) => delays[instance] ?? 1,
    });

    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.verified).toBe(true);

    const starts = trace
      .filter((entry) => entry.startsWith("start:"))
      .map((entry) => entry.slice("start:".length));
    expect(starts).toHaveLength(DOC_COUNT);
    expect(new Set(starts).size).toBe(DOC_COUNT);
    expect([...starts].sort((a, b) => a.localeCompare(b, "en"))).toEqual(
      Array.from({ length: DOC_COUNT }, (_unused, index) => `t${index + 1}-attempt-1`),
    );

    // Three lanes really ran concurrently — and never more than three.
    expect(maxInFlight).toBe(3);
    // The first batch is three tasks: all three start before the fastest one
    // (t2, 20 ms) can finish.
    expect(trace.slice(0, 3)).toEqual([
      "start:t1-attempt-1",
      "start:t2-attempt-1",
      "start:t3-attempt-1",
    ]);
    // Lane 1 finished LAST of the first batch…
    const end1 = trace.indexOf("end:t1-attempt-1");
    expect(end1).toBeGreaterThan(trace.indexOf("end:t2-attempt-1"));
    expect(end1).toBeGreaterThan(trace.indexOf("end:t3-attempt-1"));
    // …yet the findings are folded in assignment (task) order, not
    // completion order.
    const text = messagesText(update.messages);
    const p1 = text.indexOf("[t1]");
    const p2 = text.indexOf("[t2]");
    const p3 = text.indexOf("[t3]");
    expect(p1).toBeGreaterThanOrEqual(0);
    expect(p2).toBeGreaterThan(p1);
    expect(p3).toBeGreaterThan(p2);
    expect(text).toContain("[t7]");

    // Every document settled: the ledger is terminal, not merely "done".
    const statuses = update.harness?.coverage?.documents.map((d) => d.status);
    expect(statuses).toHaveLength(DOC_COUNT);
    for (const status of statuses ?? []) {
      expect(["reviewed", "excluded"]).toContain(status);
    }
  });

  test("an approval-required target still runs one delegation at a time with lanes > 1", async () => {
    const { update, maxInFlight, approvalRequests } = await runLanes({
      lanes: 3,
      delayFor: () => 1,
      consequential: true,
      approval: true,
    });

    expect(update.harness?.stopReason).toBe("completed");
    expect(update.harness?.verified).toBe(true);
    // Rule 4 (approval gate) outranks the same-target exemption: every batch
    // is a single task, so every task is approved individually.
    expect(maxInFlight).toBe(1);
    expect(approvalRequests).toBe(DOC_COUNT);
  });
});
