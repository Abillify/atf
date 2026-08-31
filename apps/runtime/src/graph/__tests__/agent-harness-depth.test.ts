// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for agent-harness delegation depth and cycle safety.
 *
 * The pure helpers are covered directly; the recursion itself is covered by
 * running a REAL nested harness through the real handler and asserting it
 * terminates. That matters more than the unit checks: `delegate()` resolves
 * handlers by node type, so a self-referential allowlist previously recursed
 * until the stack overflowed, and only an end-to-end run proves the bound holds.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { HumanMessage } from "@langchain/core/messages";
import type { FlowNode } from "../../types/flow.js";
import type { ExecRuntime, AgentState, UsageAccumulator } from "../graph-engine.js";
import type { AppConfig } from "../../config/index.js";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { createAgentHarnessNodeHandler } from "../agent-harness.js";
import {
  DEFAULT_MAX_DELEGATION_DEPTH,
  MAX_ALLOWED_DELEGATION_DEPTH,
  partitionCyclicTargets,
  readAncestorChain,
  readDelegationDepth,
  resolveMaxDelegationDepth,
  withChildDelegationDepth,
} from "../agent-harness/depth.js";
import { parseHarnessConfig } from "../agent-harness/types.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("readDelegationDepth", () => {
  test("absent or invalid values read as depth 0", () => {
    // A missing counter must not read as "already deep" — that would block the
    // first legitimate delegation of every run.
    expect(readDelegationDepth(undefined)).toBe(0);
    expect(readDelegationDepth({})).toBe(0);
    expect(readDelegationDepth({ configurable: {} })).toBe(0);
    for (const bad of ["2", -1, Number.NaN, null]) {
      expect(
        readDelegationDepth({
          configurable: { harnessDelegationDepth: bad },
        } as LangGraphRunnableConfig),
      ).toBe(0);
    }
  });

  test("reads a valid depth", () => {
    expect(
      readDelegationDepth({
        configurable: { harnessDelegationDepth: 3 },
      } as LangGraphRunnableConfig),
    ).toBe(3);
  });
});

describe("withChildDelegationDepth", () => {
  test("increments the depth and appends to the ancestor chain", () => {
    const parent = { configurable: { runtime: "r" } } as LangGraphRunnableConfig;
    const child = withChildDelegationDepth(parent, "coordinator");
    expect(readDelegationDepth(child)).toBe(1);
    expect(readAncestorChain(child)).toEqual(["coordinator"]);
    const grandchild = withChildDelegationDepth(child, "specialist");
    expect(readDelegationDepth(grandchild)).toBe(2);
    expect(readAncestorChain(grandchild)).toEqual([
      "coordinator",
      "specialist",
    ]);
  });

  test("does not mutate the parent config", () => {
    // Load-bearing: the parent config is reused for its REMAINING sibling tasks.
    // Mutating it would make the effective depth limit depend on how many
    // siblings ran first.
    const parent = { configurable: { runtime: "r" } } as LangGraphRunnableConfig;
    withChildDelegationDepth(parent, "a");
    withChildDelegationDepth(parent, "b");
    expect(readDelegationDepth(parent)).toBe(0);
    expect(readAncestorChain(parent)).toEqual([]);
  });

  test("preserves other configurable entries (the runtime must survive)", () => {
    const parent = {
      configurable: { runtime: "the-runtime", thread_id: "t1" },
    } as unknown as LangGraphRunnableConfig;
    const child = withChildDelegationDepth(parent, "a");
    const c = child.configurable as Record<string, unknown>;
    expect(c.runtime).toBe("the-runtime");
    expect(c.thread_id).toBe("t1");
  });
});

describe("resolveMaxDelegationDepth", () => {
  test("defaults when unset or nonsensical", () => {
    expect(resolveMaxDelegationDepth(undefined)).toBe(
      DEFAULT_MAX_DELEGATION_DEPTH,
    );
    expect(resolveMaxDelegationDepth(Number.NaN)).toBe(
      DEFAULT_MAX_DELEGATION_DEPTH,
    );
    expect(resolveMaxDelegationDepth(-1)).toBe(DEFAULT_MAX_DELEGATION_DEPTH);
  });

  test("0 is honoured — it forbids nesting entirely", () => {
    // Must not be treated as falsy/absent; "no sub-harnesses" is a real setting.
    expect(resolveMaxDelegationDepth(0)).toBe(0);
  });

  test("clamps to the hard ceiling", () => {
    expect(resolveMaxDelegationDepth(999)).toBe(MAX_ALLOWED_DELEGATION_DEPTH);
  });
});

describe("partitionCyclicTargets", () => {
  test("refuses the harness's own id", () => {
    const { allowed, cyclic } = partitionCyclicTargets(
      ["worker", "coordinator", "researcher"],
      "coordinator",
      [],
    );
    expect(allowed).toEqual(["worker", "researcher"]);
    expect(cyclic).toEqual(["coordinator"]);
  });

  test("refuses any ancestor already on the stack (indirect cycle)", () => {
    const { allowed, cyclic } = partitionCyclicTargets(
      ["worker", "outer"],
      "inner",
      ["outer"],
    );
    expect(allowed).toEqual(["worker"]);
    expect(cyclic).toEqual(["outer"]);
  });

  test("leaves an acyclic allowlist untouched and preserves order", () => {
    const { allowed, cyclic } = partitionCyclicTargets(
      ["c", "a", "b"],
      "self",
      ["ancestor"],
    );
    expect(allowed).toEqual(["c", "a", "b"]);
    expect(cyclic).toEqual([]);
  });
});

describe("parseHarnessConfig — maxDelegationDepth", () => {
  test("reads a valid value including 0", () => {
    expect(
      parseHarnessConfig({ allowlist: ["a"], maxDelegationDepth: 0 })
        .maxDelegationDepth,
    ).toBe(0);
    expect(
      parseHarnessConfig({ allowlist: ["a"], maxDelegationDepth: 3 })
        .maxDelegationDepth,
    ).toBe(3);
  });

  test("ignores invalid values so the runtime default applies", () => {
    for (const bad of [-1, "2", Number.NaN, null]) {
      expect(
        parseHarnessConfig({ allowlist: ["a"], maxDelegationDepth: bad })
          .maxDelegationDepth,
      ).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a self-referential harness must terminate
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

interface Harness {
  runtime: ExecRuntime;
  diagnostics: Array<{ code: string; message: string }>;
  plannerCalls: number;
}

/**
 * Runtime whose planner always plans exactly one task against `target`, so a
 * self-referential allowlist would recurse forever without the guard.
 */
function mkRuntime(target: string): Harness {
  const diagnostics: Harness["diagnostics"] = [];
  const state = { plannerCalls: 0 };
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      state.plannerCalls++;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              tasks: [{ description: "arbeite weiter", target }],
            }),
          },
        ],
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
    onNodeDiagnostic: (
      _nodeId: string,
      d: { code: string; message: string },
    ) => {
      diagnostics.push(d);
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

  return {
    runtime,
    diagnostics,
    get plannerCalls() {
      return state.plannerCalls;
    },
  };
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

describe("nested harness recursion (end-to-end)", () => {
  test("a self-referential allowlist terminates instead of overflowing the stack", async () => {
    // Before the guard this recursed until the stack blew: the planner keeps
    // choosing the harness itself, and delegate() happily re-enters it.
    const selfHarness: FlowNode = {
      id: "coordinator",
      type: "agent-harness",
      config: {
        allowlist: ["coordinator", "worker"],
        maxIterations: 3,
      },
    } as unknown as FlowNode;
    const worker: FlowNode = {
      id: "worker",
      type: "transform",
      config: { set: {} },
    } as unknown as FlowNode;

    const nodeMap = new Map<string, FlowNode>([
      ["coordinator", selfHarness],
      ["worker", worker],
    ]);
    const h = mkRuntime("coordinator");
    const handler = createAgentHarnessNodeHandler(selfHarness, nodeMap);

    const update = await handler(mkState(), {
      configurable: { runtime: h.runtime },
    } as LangGraphRunnableConfig);

    // Terminated (no throw, no stack overflow) and reported the cycle.
    expect(update).toBeDefined();
    const codes = h.diagnostics.map((d) => d.code);
    expect(codes).toContain("harness_cyclic_target");
    // The cycle diagnostic names the offending target.
    const cyc = h.diagnostics.find(
      (d) => d.code === "harness_cyclic_target",
    );
    if (cyc === undefined) throw new Error("expected a cyclic-target diagnostic");
    expect(cyc.message).toContain("coordinator");
  });

  test("a harness entered above the depth limit stops without planning", async () => {
    const nested: FlowNode = {
      id: "inner",
      type: "agent-harness",
      config: { allowlist: ["worker"], maxDelegationDepth: 1 },
    } as unknown as FlowNode;
    const worker: FlowNode = {
      id: "worker",
      type: "transform",
      config: { set: {} },
    } as unknown as FlowNode;
    const nodeMap = new Map<string, FlowNode>([
      ["inner", nested],
      ["worker", worker],
    ]);
    const h = mkRuntime("worker");
    const handler = createAgentHarnessNodeHandler(nested, nodeMap);

    // Entered at depth 2 with a limit of 1.
    const update = (await handler(mkState(), {
      configurable: {
        runtime: h.runtime,
        harnessDelegationDepth: 2,
        harnessAncestorIds: ["outer", "middle"],
      },
    } as LangGraphRunnableConfig)) as {
      harness?: { stopReason?: string; depth?: number };
    };

    expect(update.harness?.stopReason).toBe("depth-limit");
    expect(update.harness?.depth).toBe(2);
    // No planner call was spent discovering it was too deep.
    expect(h.plannerCalls).toBe(0);
  });

  test("maxDelegationDepth: 0 forbids nesting but the harness itself still runs", async () => {
    const outer: FlowNode = {
      id: "outer",
      type: "agent-harness",
      // A planner LLM is required for the planner to run at all; without it the
      // handler stops early with "planning-failure" and never reaches the loop.
      llm: { provider: "openai", model: "test-model" },
      config: {
        allowlist: ["worker"],
        maxDelegationDepth: 0,
        maxIterations: 1,
      },
    } as unknown as FlowNode;
    const worker: FlowNode = {
      id: "worker",
      type: "transform",
      config: { set: {} },
    } as unknown as FlowNode;
    const nodeMap = new Map<string, FlowNode>([
      ["outer", outer],
      ["worker", worker],
    ]);
    const h = mkRuntime("worker");
    const handler = createAgentHarnessNodeHandler(outer, nodeMap);

    const update = (await handler(mkState(), {
      configurable: { runtime: h.runtime },
    } as LangGraphRunnableConfig)) as {
      harness?: { stopReason?: string; depth?: number };
    };

    // Depth 0 <= limit 0 → runs normally.
    expect(update.harness?.depth).toBe(0);
    expect(update.harness?.stopReason).not.toBe("depth-limit");
    expect(h.plannerCalls).toBeGreaterThan(0);
  });
});
