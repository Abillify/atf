// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression test: a `parallel` node's fan-out concurrency cap
 * (`config.maxFanoutConcurrency`).
 *
 * Without a cap, a parallel node with many children (a dozen RAG sources, a
 * wide `parallelNodes` list) launches every child's LLM/tool call in the same
 * instant via one `Promise.all`. `maxFanoutConcurrency` bounds how many of a
 * SINGLE parallel node's children run at once, using the same {@link Semaphore}
 * the engine's other concurrency limits use. Default (unset/0) preserves the
 * existing unbounded fan-out for flows that rely on it and have few children.
 */
import { describe, test, expect } from "bun:test";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { createParallelNodeHandler } from "../handlers/parallel.js";
// Importing compile.ts triggers `registerBuiltins`, populating
// defaultNodeHandlerRegistry with the "llm" type (emitsLifecycle: true) that
// createParallelNodeHandler looks up for each static child.
import "../graph-engine/compile.js";
import type { FlowNode } from "../../types/flow.js";
import type { AgentState, ExecRuntime, UsageAccumulator } from "../graph-engine.js";

function mkUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function mkState(): AgentState {
  return {
    messages: [],
    context: { ssoToken: "t", executionId: "exec-1" },
    citations: [],
    toolResults: [],
    errors: [],
    turns: [],
    seenDocRefs: [],
  } as unknown as AgentState;
}

/**
 * Builds N sibling "llm" child nodes plus a parallel parent referencing all of
 * them, and a runtime whose `onNodeEnd` records completion order. Each child's
 * handler comes from the registry's "llm" factory — to make it a controllable
 * worker instead of a real LLM call, we monkey-patch by giving each child node
 * a distinct id and instead observe concurrency via a SHARED counter incremented
 * on start and decremented on end, recording the peak observed value. Since we
 * cannot easily stub the real "llm" handler without a provider, we instead
 * build children of type "tool" — createToolNodeHandler is deterministic and
 * fast, so a delay is injected via a slow toolAuthzEngine... this is overkill.
 *
 * Simpler: register a throwaway node type into the SAME registry used by
 * createParallelNodeHandler (defaultNodeHandlerRegistry), with a delayed
 * handler we fully control. This avoids depending on any real LLM/tool
 * provider and still exercises the exact code path (registry.get(type),
 * emitsLifecycle, factory(...)) that production children go through.
 */
import { defaultNodeHandlerRegistry } from "../node-handler-registry.js";

let registered = false;
function registerProbeNodeType(): void {
  if (registered) return;
  registered = true;
  defaultNodeHandlerRegistry.register({
    type: "fanout-probe",
    emitsLifecycle: true,
    factory: (node) => async (): Promise<Partial<AgentState>> => {
      const cfg = node.config as { delayMs?: number } | undefined;
      probeState.active++;
      probeState.peak = Math.max(probeState.peak, probeState.active);
      probeState.startOrder.push(node.id);
      if (cfg?.delayMs !== undefined && cfg.delayMs > 0) {
        await new Promise((r) => setTimeout(r, cfg.delayMs));
      }
      probeState.active--;
      return { messages: [new AIMessage(`done:${node.id}`)] };
    },
  });
}

const probeState = { active: 0, peak: 0, startOrder: [] as string[] };

function resetProbeState(): void {
  probeState.active = 0;
  probeState.peak = 0;
  probeState.startOrder = [];
}

function mkRuntime(): ExecRuntime {
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
    ctx: { ssoToken: "t", executionId: "exec-1" },
    usage: mkUsage(),
    llmProviderFactory: () => {
      throw new Error("not used in this test");
    },
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
      summary: () => ({}) as never,
    } as unknown as ExecRuntime["metrics"],
  } as unknown as ExecRuntime;
}

function mkChildren(n: number, delayMs: number): FlowNode[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `child-${i}`,
    type: "fanout-probe",
    config: { delayMs },
  })) as unknown as FlowNode[];
}

function mkParallelNode(
  childIds: string[],
  maxFanoutConcurrency?: number,
): FlowNode {
  return {
    id: "fanout",
    type: "parallel",
    parallelNodes: childIds,
    config:
      maxFanoutConcurrency !== undefined ? { maxFanoutConcurrency } : {},
  } as unknown as FlowNode;
}

describe("parallel node — fan-out concurrency cap (config.maxFanoutConcurrency)", () => {
  test("without a cap, all children start immediately (no behaviour change)", async () => {
    registerProbeNodeType();
    resetProbeState();
    const children = mkChildren(5, 30);
    const nodeMap = new Map<string, FlowNode>(children.map((c) => [c.id, c]));
    const parallelNode = mkParallelNode(children.map((c) => c.id));
    nodeMap.set(parallelNode.id, parallelNode);

    const handler = createParallelNodeHandler(parallelNode, nodeMap);
    const runtime = mkRuntime();
    await handler(mkState(), {
      configurable: { runtime },
    } as LangGraphRunnableConfig);

    // All 5 workers were in flight simultaneously.
    expect(probeState.peak).toBe(5);
  });

  test("with a cap, at most N children run at once", async () => {
    registerProbeNodeType();
    resetProbeState();
    const children = mkChildren(6, 30);
    const nodeMap = new Map<string, FlowNode>(children.map((c) => [c.id, c]));
    const parallelNode = mkParallelNode(
      children.map((c) => c.id),
      2,
    );
    nodeMap.set(parallelNode.id, parallelNode);

    const handler = createParallelNodeHandler(parallelNode, nodeMap);
    const runtime = mkRuntime();
    const update = (await handler(mkState(), {
      configurable: { runtime },
    } as LangGraphRunnableConfig)) as { messages?: unknown };

    expect(probeState.peak).toBeLessThanOrEqual(2);
    // Every child still ran and completed — the cap only serialises timing,
    // not completeness.
    const texts = (update.messages as Array<{ content: unknown }>).map((m) =>
      String(m.content),
    );
    expect(texts).toHaveLength(6);
    for (const c of children) {
      expect(texts).toContain(`done:${c.id}`);
    }
  });

  test("a cap larger than the child count has no serialising effect", async () => {
    registerProbeNodeType();
    resetProbeState();
    const children = mkChildren(3, 20);
    const nodeMap = new Map<string, FlowNode>(children.map((c) => [c.id, c]));
    const parallelNode = mkParallelNode(
      children.map((c) => c.id),
      10,
    );
    nodeMap.set(parallelNode.id, parallelNode);

    const handler = createParallelNodeHandler(parallelNode, nodeMap);
    const runtime = mkRuntime();
    await handler(mkState(), {
      configurable: { runtime },
    } as LangGraphRunnableConfig);

    expect(probeState.peak).toBe(3);
  });

  test("a non-numeric or zero maxFanoutConcurrency is treated as unbounded", async () => {
    registerProbeNodeType();
    resetProbeState();
    const children = mkChildren(4, 20);
    const nodeMap = new Map<string, FlowNode>(children.map((c) => [c.id, c]));
    const parallelNode: FlowNode = {
      id: "fanout",
      type: "parallel",
      parallelNodes: children.map((c) => c.id),
      config: { maxFanoutConcurrency: 0 },
    } as unknown as FlowNode;
    nodeMap.set(parallelNode.id, parallelNode);

    const handler = createParallelNodeHandler(parallelNode, nodeMap);
    const runtime = mkRuntime();
    await handler(mkState(), {
      configurable: { runtime },
    } as LangGraphRunnableConfig);

    expect(probeState.peak).toBe(4);
  });
});
