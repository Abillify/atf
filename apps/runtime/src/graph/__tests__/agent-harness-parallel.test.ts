// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for agent-harness parallel batching, per-task retry and planner budget.
 *
 * The contracts that matter:
 *   - a planner that never marks anything `parallelizable` gets exactly the old
 *     sequential behaviour (no silent change for existing flows);
 *   - results are incorporated in TASK order, never completion order — otherwise
 *     the next prompt would depend on network timing, losing prompt-cache reuse
 *     and making runs irreproducible;
 *   - an approval-gated task never shares a batch (approval is an interactive
 *     pause; concurrent prompts would be unordered);
 *   - a parallel batch still costs one iteration PER task, so it cannot be used
 *     to evade the iteration limit;
 *   - retries are opt-in (Req 4.6 stays intact by default).
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { FlowNode } from "../../types/flow.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type {
  AgentState,
  ExecRuntime,
  UsageAccumulator,
} from "../graph-engine.js";
import type { AppConfig } from "../../config/index.js";
import { createAgentHarnessNodeHandler } from "../agent-harness.js";
import {
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_TASK_ATTEMPTS,
  MAX_ALLOWED_CONCURRENT_TASKS,
  MAX_ALLOWED_TASK_ATTEMPTS,
  normalize,
  parseHarnessConfig,
  resolveMaxConcurrentTasks,
  resolveMaxTaskAttempts,
  selectTaskBatch,
  type Task,
} from "../agent-harness/types.js";
import { renderPlannerBudget } from "../agent-harness/tools.js";

// ---------------------------------------------------------------------------
// selectTaskBatch
// ---------------------------------------------------------------------------

function mkTask(
  id: string,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    description: `task ${id}`,
    target: "worker",
    status: "pending",
    ...overrides,
  };
}

describe("selectTaskBatch", () => {
  test("returns nothing when no task is pending", () => {
    expect(selectTaskBatch([], 3)).toEqual([]);
    expect(
      selectTaskBatch(
        [mkTask("t1", { status: "completed" }), mkTask("t2", { status: "failed" })],
        3,
      ),
    ).toEqual([]);
  });

  test("a plan with no parallelizable flags stays strictly sequential", () => {
    // The no-silent-change contract: this is what every existing flow produces.
    const tasks = [mkTask("t1"), mkTask("t2"), mkTask("t3")];
    const batch = selectTaskBatch(tasks, 3);
    expect(batch.map((t) => t.id)).toEqual(["t1"]);
  });

  test("batches contiguous parallelizable tasks up to the cap", () => {
    // Distinct targets: two tasks aimed at the SAME node cannot run
    // concurrently (rule 5) — the engine's per-node state is keyed by node id.
    const tasks = [
      mkTask("t1", { parallelizable: true, target: "w1" }),
      mkTask("t2", { parallelizable: true, target: "w2" }),
      mkTask("t3", { parallelizable: true, target: "w3" }),
      mkTask("t4", { parallelizable: true, target: "w4" }),
    ];
    expect(selectTaskBatch(tasks, 3).map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
    expect(selectTaskBatch(tasks, 2).map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  test("a non-parallelizable task is a barrier — later tasks are not pulled forward", () => {
    // Contiguity is the point: t3 may depend on t2's result, so it must not be
    // hoisted past it into t1's batch.
    const tasks = [
      mkTask("t1", { parallelizable: true }),
      mkTask("t2"), // barrier
      mkTask("t3", { parallelizable: true }),
    ];
    expect(selectTaskBatch(tasks, 5).map((t) => t.id)).toEqual(["t1"]);
  });

  test("a sequential head runs alone even when later tasks are parallelizable", () => {
    const tasks = [
      mkTask("t1"),
      mkTask("t2", { parallelizable: true }),
      mkTask("t3", { parallelizable: true }),
    ];
    expect(selectTaskBatch(tasks, 5).map((t) => t.id)).toEqual(["t1"]);
  });

  test("skips settled tasks when forming the batch", () => {
    const tasks = [
      mkTask("t1", { status: "completed" }),
      mkTask("t2", { status: "failed" }),
      mkTask("t3", { parallelizable: true, target: "w3" }),
      mkTask("t4", { parallelizable: true, target: "w4" }),
    ];
    expect(selectTaskBatch(tasks, 3).map((t) => t.id)).toEqual(["t3", "t4"]);
  });

  // -------------------------------------------------------------------------
  // Rule 5: one node must never run twice concurrently
  // -------------------------------------------------------------------------

  test("two parallelizable tasks on the SAME target are not batched together", () => {
    // The regression this guards: the engine keys per-node execution state
    // (streaming guardrail buffer, chunk ids, start time, model, token counts,
    // prompt/response capture) by node id alone. Delegating to one node twice at
    // once interleaved two token streams through a single guardrail buffer —
    // corrupting the emitted text — overwrote the timing/model bookkeeping, and
    // fired the node's completion event twice.
    const tasks = [
      mkTask("t1", { parallelizable: true, target: "researcher" }),
      mkTask("t2", { parallelizable: true, target: "researcher" }),
    ];
    expect(selectTaskBatch(tasks, 5).map((t) => t.id)).toEqual(["t1"]);
  });

  test("the duplicate still runs — in the NEXT batch, not never", () => {
    const tasks = [
      mkTask("t1", { parallelizable: true, target: "researcher" }),
      mkTask("t2", { parallelizable: true, target: "researcher" }),
    ];
    const first = selectTaskBatch(tasks, 5);
    expect(first.map((t) => t.id)).toEqual(["t1"]);
    // Simulate the first task settling, as the loop does.
    const task0 = tasks[0];
    if (task0 === undefined) throw new Error("expected a first task");
    task0.status = "completed";
    expect(selectTaskBatch(tasks, 5).map((t) => t.id)).toEqual(["t2"]);
  });

  test("a repeated target acts as a barrier, not a filter", () => {
    // t3 targets a different node but sits AFTER the duplicate, so it must not
    // be pulled forward past work it may depend on.
    const tasks = [
      mkTask("t1", { parallelizable: true, target: "a" }),
      mkTask("t2", { parallelizable: true, target: "a" }),
      mkTask("t3", { parallelizable: true, target: "b" }),
    ];
    expect(selectTaskBatch(tasks, 5).map((t) => t.id)).toEqual(["t1"]);
  });

  test("allowSameTarget batches duplicate targets, still honouring the cap", () => {
    // Coverage lanes: every delegation carries its own instance key, so the
    // engine's per-node state no longer collides and one target may run twice.
    const tasks = [
      mkTask("t1", { parallelizable: true, target: "researcher" }),
      mkTask("t2", { parallelizable: true, target: "researcher" }),
      mkTask("t3", { parallelizable: true, target: "researcher" }),
    ];
    expect(
      selectTaskBatch(tasks, 5, () => false, { allowSameTarget: true }).map(
        (t) => t.id,
      ),
    ).toEqual(["t1", "t2", "t3"]);
    expect(
      selectTaskBatch(tasks, 2, () => false, { allowSameTarget: true }).map(
        (t) => t.id,
      ),
    ).toEqual(["t1", "t2"]);
  });

  test("allowSameTarget keeps the other rules intact", () => {
    // A non-parallelizable task is still a barrier, and an approval-gated task
    // still runs alone — approval is an interactive pause, lanes or not.
    const barrier = [
      mkTask("t1", { parallelizable: true, target: "a" }),
      mkTask("t2", { target: "a" }),
      mkTask("t3", { parallelizable: true, target: "a" }),
    ];
    expect(
      selectTaskBatch(barrier, 5, () => false, { allowSameTarget: true }).map(
        (t) => t.id,
      ),
    ).toEqual(["t1"]);

    const tasks = [
      mkTask("t1", { parallelizable: true, target: "danger" }),
      mkTask("t2", { parallelizable: true, target: "danger" }),
    ];
    expect(
      selectTaskBatch(tasks, 5, (t) => t.target === "danger", {
        allowSameTarget: true,
      }).map((t) => t.id),
    ).toEqual(["t1"]);
  });

  test("distinct targets still batch fully up to the cap", () => {
    const tasks = [
      mkTask("t1", { parallelizable: true, target: "a" }),
      mkTask("t2", { parallelizable: true, target: "b" }),
      mkTask("t3", { parallelizable: true, target: "c" }),
    ];
    expect(selectTaskBatch(tasks, 5).map((t) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  test("every batch has unique targets, for any plan (invariant)", () => {
    const targets = ["a", "b", "a", "c", "b", "a", "c"];
    const tasks = targets.map((target, i) =>
      mkTask(`t${i}`, { parallelizable: true, target }),
    );
    const batch = selectTaskBatch(tasks, 10);
    expect(new Set(batch.map((t) => t.target)).size).toBe(batch.length);
  });

  test("an approval-gated task is returned ALONE", () => {
    // Interactive approval must not interleave with concurrent siblings.
    const tasks = [
      mkTask("t1", { parallelizable: true, target: "danger" }),
      mkTask("t2", { parallelizable: true }),
    ];
    const batch = selectTaskBatch(tasks, 3, (t) => t.target === "danger");
    expect(batch.map((t) => t.id)).toEqual(["t1"]);
  });

  test("a later approval-gated task ends the batch before itself", () => {
    const tasks = [
      mkTask("t1", { parallelizable: true }),
      mkTask("t2", { parallelizable: true, target: "danger" }),
      mkTask("t3", { parallelizable: true }),
    ];
    const batch = selectTaskBatch(tasks, 5, (t) => t.target === "danger");
    expect(batch.map((t) => t.id)).toEqual(["t1"]);
  });

  test("a concurrency cap below 1 still yields one task (progress guarantee)", () => {
    const tasks = [mkTask("t1", { parallelizable: true })];
    expect(selectTaskBatch(tasks, 0)).toHaveLength(1);
    expect(selectTaskBatch(tasks, -5)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe("resolveMaxConcurrentTasks", () => {
  test("defaults and clamps", () => {
    expect(resolveMaxConcurrentTasks(undefined)).toBe(
      DEFAULT_MAX_CONCURRENT_TASKS,
    );
    expect(resolveMaxConcurrentTasks(0)).toBe(DEFAULT_MAX_CONCURRENT_TASKS);
    expect(resolveMaxConcurrentTasks(Number.NaN)).toBe(
      DEFAULT_MAX_CONCURRENT_TASKS,
    );
    expect(resolveMaxConcurrentTasks(2)).toBe(2);
    expect(resolveMaxConcurrentTasks(999)).toBe(MAX_ALLOWED_CONCURRENT_TASKS);
  });
});

describe("resolveMaxTaskAttempts", () => {
  test("retries are OFF by default (Req 4.6 preserved)", () => {
    expect(DEFAULT_MAX_TASK_ATTEMPTS).toBe(0);
    expect(resolveMaxTaskAttempts(undefined)).toBe(0);
  });

  test("0 is honoured explicitly and values clamp to the ceiling", () => {
    expect(resolveMaxTaskAttempts(0)).toBe(0);
    expect(resolveMaxTaskAttempts(2)).toBe(2);
    expect(resolveMaxTaskAttempts(99)).toBe(MAX_ALLOWED_TASK_ATTEMPTS);
    expect(resolveMaxTaskAttempts(-1)).toBe(DEFAULT_MAX_TASK_ATTEMPTS);
  });
});

describe("parseHarnessConfig — concurrency and retries", () => {
  test("reads both fields, honouring 0 for retries", () => {
    const cfg = parseHarnessConfig({
      allowlist: ["a"],
      maxConcurrentTasks: 4,
      maxTaskAttempts: 0,
    });
    expect(cfg.maxConcurrentTasks).toBe(4);
    expect(cfg.maxTaskAttempts).toBe(0);
  });

  test("ignores invalid values so runtime defaults apply", () => {
    const cfg = parseHarnessConfig({
      allowlist: ["a"],
      maxConcurrentTasks: 0,
      maxTaskAttempts: -3,
    });
    expect(cfg.maxConcurrentTasks).toBeUndefined();
    expect(cfg.maxTaskAttempts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalize — parallelizable + id offset
// ---------------------------------------------------------------------------

describe("normalize — parallelizable coercion", () => {
  test("only a literal true enables concurrency", () => {
    // A language model may emit "true", 1, or "yes"; none of those may silently
    // turn into concurrency.
    const tasks = normalize(
      [
        { description: "a", target: "w", parallelizable: true },
        { description: "b", target: "w", parallelizable: "true" },
        { description: "c", target: "w", parallelizable: 1 },
        { description: "d", target: "w" },
      ],
      ["w"],
    );
    expect(tasks.map((t) => t.parallelizable)).toEqual([
      true,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("normalize — id offset", () => {
  test("re-plan ids continue after the already-issued ones", () => {
    // Task id is the merge key in mergeHarnessProgress; restarting at t1 would
    // overwrite the record of a settled task.
    const first = normalize(
      [
        { description: "a", target: "w" },
        { description: "b", target: "w" },
      ],
      ["w"],
    );
    expect(first.map((t) => t.id)).toEqual(["t1", "t2"]);
    const replan = normalize([{ description: "c", target: "w" }], ["w"], 2);
    expect(replan.map((t) => t.id)).toEqual(["t3"]);
  });

  test("dropped invalid targets do not consume ids", () => {
    const tasks = normalize(
      [
        { description: "bad", target: "nope" },
        { description: "good", target: "w" },
      ],
      ["w"],
      5,
    );
    expect(tasks.map((t) => t.id)).toEqual(["t6"]);
  });
});

// ---------------------------------------------------------------------------
// Planner budget rendering
// ---------------------------------------------------------------------------

describe("renderPlannerBudget", () => {
  test("always states the remaining iterations", () => {
    const text = renderPlannerBudget({ remainingIterations: 3 });
    expect(text).toContain("Remaining iterations: 3");
    expect(text).toContain("BUDGET");
  });

  test("omits limits that are not configured", () => {
    const text = renderPlannerBudget({ remainingIterations: 2 });
    expect(text).not.toContain("USD");
    expect(text).not.toContain("Remaining time");
  });

  test("includes cost and time when configured", () => {
    const text = renderPlannerBudget({
      remainingIterations: 2,
      remainingCostUsd: 0.25,
      remainingTimeMs: 45_000,
    });
    expect(text).toContain("0.2500 USD");
    expect(text).toContain("45 s");
  });

  test("mentions the concurrency budget so the planner can use it", () => {
    const text = renderPlannerBudget({
      remainingIterations: 5,
      maxConcurrentTasks: 3,
    });
    expect(text).toContain("3 steps");
    expect(text).toContain("parallelizable");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: batching, ordering, iteration accounting, retry
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
} as AppConfig;

function mkUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function mkState(): AgentState {
  return {
    messages: [new HumanMessage("Erledige eine komplexe Aufgabe.")],
    context: { ssoToken: "t", executionId: "exec-1" },
    citations: [],
    toolResults: [],
    errors: [],
    turns: [],
  } as unknown as AgentState;
}

interface RunHarness {
  runtime: ExecRuntime;
  /** Order in which delegated workers STARTED. */
  starts: string[];
  /** Ordered `start:<id>` / `end:<id>` events, for overlap assertions. */
  trace: string[];
  diagnostics: Array<{ code: string }>;
  plannerCalls: number;
  plannerPrompts: string[];
}

/**
 * Builds a runtime plus a fake registry whose worker resolves after a
 * per-target delay, so completion order can be made to differ from task order.
 */
function mkRun(
  plan: Array<{ description: string; target: string; parallelizable?: boolean }>,
  workerBehaviour: (target: string, callIndex: number) => {
    delayMs?: number;
    fail?: boolean;
    text?: string;
  },
): {
  harness: RunHarness;
  registry: {
    get: (type: string) => {
      factory: (
        node: FlowNode,
      ) => (state: AgentState) => Promise<Partial<AgentState>>;
    };
  };
} {
  const starts: string[] = [];
  /**
   * Ordered `start:<id>` / `end:<id>` trace.
   *
   * Concurrency is asserted from this interleaving rather than from elapsed wall
   * time: a wall-clock bound is flaky on a loaded machine and proves nothing
   * about overlap, whereas "beta started before alpha ended" is exactly the
   * property and is deterministic.
   */
  const trace: string[] = [];
  const diagnostics: Array<{ code: string }> = [];
  const plannerPrompts: string[] = [];
  const counters = new Map<string, number>();
  const state = { plannerCalls: 0 };

  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      state.plannerCalls++;
      const prompt = options.prompt as Array<{
        role?: string;
        content?: unknown;
      }>;
      const sys = prompt.find((p) => p.role === "system");
      plannerPrompts.push(
        typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content),
      );
      // Only the FIRST call returns the plan; re-plans return nothing further so
      // the run terminates once the initial tasks settle.
      const tasks = state.plannerCalls === 1 ? plan : [];
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ tasks }) }],
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
    onNodeDiagnostic: (_n: string, d: { code: string }) => diagnostics.push(d),
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
      factory: (targetNode: FlowNode) => async (): Promise<Partial<AgentState>> => {
        const idx = counters.get(targetNode.id) ?? 0;
        counters.set(targetNode.id, idx + 1);
        starts.push(targetNode.id);
        trace.push(`start:${targetNode.id}`);
        const behaviour = workerBehaviour(targetNode.id, idx);
        if (behaviour.delayMs !== undefined && behaviour.delayMs > 0) {
          await new Promise((r) => setTimeout(r, behaviour.delayMs));
        }
        trace.push(`end:${targetNode.id}`);
        if (behaviour.fail === true) {
          return {
            errors: [
              {
                message: `worker ${targetNode.id} failed`,
                type: "execution_error",
                details: { node_id: targetNode.id },
              },
            ],
          };
        }
        return {
          messages: [new AIMessage(behaviour.text ?? `ok:${targetNode.id}`)],
        };
      },
    }),
  };

  return {
    harness: {
      runtime,
      starts,
      trace,
      diagnostics,
      plannerPrompts,
      get plannerCalls() {
        return state.plannerCalls;
      },
    },
    registry,
  };
}

function mkNodeMap(ids: string[]): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  for (const id of ids) {
    map.set(id, { id, type: "llm" } as unknown as FlowNode);
  }
  return map;
}

const harnessNode = (config: Record<string, unknown>): FlowNode =>
  ({
    id: "orchestrator",
    type: "agent-harness",
    llm: { provider: "openai", model: "test-model" },
    config,
  }) as unknown as FlowNode;

describe("harness parallel execution (end-to-end)", () => {
  test("parallel tasks all start before any finishes", async () => {
    // The actual concurrency proof: with a 60 ms worker, sequential execution
    // would show start-finish-start; a batch shows both starts up front.
    const node = harnessNode({
      allowlist: ["alpha", "beta"],
      maxIterations: 5,
      maxConcurrentTasks: 2,
    });
    const { harness, registry } = mkRun(
      [
        { description: "a", target: "alpha", parallelizable: true },
        { description: "b", target: "beta", parallelizable: true },
      ],
      () => ({ delayMs: 60 }),
    );
    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "alpha", "beta"]),
      { registry },
    );

    const update = (await handler(mkState(), {
      configurable: { runtime: harness.runtime },
    } as LangGraphRunnableConfig)) as {
      harness?: { tasks: Task[]; iterations: number; stopReason?: string };
    };

    expect(harness.starts).toEqual(["alpha", "beta"]);
    // Overlap, asserted from the event trace rather than elapsed time: beta must
    // have STARTED before alpha ENDED. Sequential execution can never produce
    // that ordering, and this holds regardless of machine load.
    expect(harness.trace.indexOf("start:beta")).toBeLessThan(
      harness.trace.indexOf("end:alpha"),
    );
    expect(update.harness?.tasks.every((t) => t.status === "completed")).toBe(
      true,
    );
  });

  test("results are incorporated in TASK order even when completion order differs", async () => {
    // Determinism contract: the shared context is rebuilt from findings, so
    // completion-order folding would make the next prompt depend on timing.
    const node = harnessNode({
      allowlist: ["slow", "fast"],
      maxIterations: 5,
      maxConcurrentTasks: 2,
      carryForward: "condensed",
    });
    const { harness, registry } = mkRun(
      [
        { description: "erst langsam", target: "slow", parallelizable: true },
        { description: "dann schnell", target: "fast", parallelizable: true },
      ],
      (target) => ({
        delayMs: target === "slow" ? 80 : 5,
        text: `finding-${target}`,
      }),
    );
    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "slow", "fast"]),
      { registry },
    );

    const update = (await handler(mkState(), {
      configurable: { runtime: harness.runtime },
    } as LangGraphRunnableConfig)) as { messages?: unknown };

    const texts = (update.messages as Array<{ content: unknown }>).map((m) =>
      String(m.content),
    );
    const slowAt = texts.findIndex((t) => t.includes("finding-slow"));
    const fastAt = texts.findIndex((t) => t.includes("finding-fast"));
    expect(slowAt).toBeGreaterThanOrEqual(0);
    expect(fastAt).toBeGreaterThanOrEqual(0);
    // slow was task 1, so its finding must come first despite finishing last.
    expect(slowAt).toBeLessThan(fastAt);
  });

  test("a parallel batch costs one iteration PER task", async () => {
    // Otherwise a planner could evade the iteration limit by marking everything
    // parallelizable.
    const node = harnessNode({
      allowlist: ["alpha", "beta", "gamma"],
      maxIterations: 10,
      maxConcurrentTasks: 3,
    });
    const { harness, registry } = mkRun(
      [
        { description: "a", target: "alpha", parallelizable: true },
        { description: "b", target: "beta", parallelizable: true },
        { description: "c", target: "gamma", parallelizable: true },
      ],
      () => ({}),
    );
    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "alpha", "beta", "gamma"]),
      { registry },
    );
    const update = (await handler(mkState(), {
      configurable: { runtime: harness.runtime },
    } as LangGraphRunnableConfig)) as { harness?: { iterations: number } };

    expect(update.harness?.iterations).toBe(3);
  });

  test("a sequential plan runs one worker at a time (no behaviour change)", async () => {
    const node = harnessNode({
      allowlist: ["alpha", "beta"],
      maxIterations: 5,
    });
    const { harness, registry } = mkRun(
      [
        { description: "a", target: "alpha" },
        { description: "b", target: "beta" },
      ],
      () => ({ delayMs: 30 }),
    );
    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "alpha", "beta"]),
      { registry },
    );
    await handler(mkState(), {
      configurable: { runtime: harness.runtime },
    } as LangGraphRunnableConfig);

    expect(harness.starts).toEqual(["alpha", "beta"]);
    // Strictly serialised: alpha fully completes before beta begins. No overlap.
    expect(harness.trace).toEqual([
      "start:alpha",
      "end:alpha",
      "start:beta",
      "end:beta",
    ]);
  });

  test("the planner prompt carries the remaining budget", async () => {
    const node = harnessNode({
      allowlist: ["alpha"],
      maxIterations: 4,
      maxCost: 0.5,
      maxTimeMs: 30_000,
    });
    const { harness, registry } = mkRun(
      [{ description: "a", target: "alpha" }],
      () => ({}),
    );
    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "alpha"]),
      { registry },
    );
    await handler(mkState(), {
      configurable: { runtime: harness.runtime },
    } as LangGraphRunnableConfig);

    expect(harness.plannerPrompts[0]).toContain("BUDGET");
    expect(harness.plannerPrompts[0]).toContain("Remaining iterations: 4");
    expect(harness.plannerPrompts[0]).toContain("USD");
  });
});

describe("harness per-task retry (opt-in)", () => {
  test("without maxTaskAttempts a failing task fails immediately (Req 4.6)", async () => {
    const node = harnessNode({ allowlist: ["flaky"], maxIterations: 5 });
    const { harness, registry } = mkRun(
      [{ description: "a", target: "flaky" }],
      () => ({ fail: true }),
    );
    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "flaky"]),
      { registry },
    );
    const update = (await handler(mkState(), {
      configurable: { runtime: harness.runtime },
    } as LangGraphRunnableConfig)) as { harness?: { tasks: Task[] } };

    expect(harness.starts).toEqual(["flaky"]); // exactly one attempt
    expect(update.harness?.tasks[0]?.status).toBe("failed");
  });

  test("with maxTaskAttempts a transient failure is retried and can succeed", async () => {
    const node = harnessNode({
      allowlist: ["flaky"],
      maxIterations: 5,
      maxTaskAttempts: 1,
    });
    const { harness, registry } = mkRun(
      [{ description: "a", target: "flaky" }],
      // Fails on the first call, succeeds on the retry.
      (_target, callIndex) => (callIndex === 0 ? { fail: true } : {}),
    );
    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "flaky"]),
      { registry },
    );
    const update = (await handler(mkState(), {
      configurable: { runtime: harness.runtime },
    } as LangGraphRunnableConfig)) as {
      harness?: { tasks: Task[]; stopReason?: string };
    };

    expect(harness.starts).toEqual(["flaky", "flaky"]);
    expect(update.harness?.tasks[0]?.status).toBe("completed");
    expect(update.harness?.tasks[0]?.attempts).toBe(1);
    expect(update.harness?.stopReason).toBe("completed");
    expect(harness.diagnostics.map((d) => d.code)).toContain(
      "harness_task_retry",
    );
  });

  test("retries are bounded — a permanently broken target still fails", async () => {
    const node = harnessNode({
      allowlist: ["broken"],
      maxIterations: 10,
      maxTaskAttempts: 2,
    });
    const { harness, registry } = mkRun(
      [{ description: "a", target: "broken" }],
      () => ({ fail: true }),
    );
    const handler = createAgentHarnessNodeHandler(
      node,
      mkNodeMap(["orchestrator", "broken"]),
      { registry },
    );
    const update = (await handler(mkState(), {
      configurable: { runtime: harness.runtime },
    } as LangGraphRunnableConfig)) as { harness?: { tasks: Task[] } };

    // Initial attempt + 2 retries, then failed.
    expect(harness.starts).toHaveLength(3);
    expect(update.harness?.tasks[0]?.status).toBe("failed");
    expect(update.harness?.tasks[0]?.error).toContain("failed");
  });
});
