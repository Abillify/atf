// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the optimizer's structural / scoped / analysis-seeded paths
 * (`src/graph/flow-optimizer.ts`), complementing the prompt-only coverage in
 * flow-optimizer.test.ts.
 *
 * All external I/O is faked (ReplayStore, FlowStore, executor, judge, generator
 * + analyzer LanguageModels, DebugTraceStore).
 */

import { describe, test, expect } from "bun:test";
import type { LanguageModel } from "ai";
import { createFlowOptimizer } from "../flow-optimizer.js";
import { InMemoryFlowStore } from "../flow-store.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { ReplayStore, ExecutionSnapshot } from "../replay.js";
import type { FlowExecutor, Judge } from "../../eval/eval-runner.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { DebugTrace } from "../../types/debug-trace.js";

const PIPE_FLOW: FlowDefinition = {
  id: "pipe",
  name: "Pipeline",
  nodes: [
    {
      id: "clf",
      type: "classifier",
      classifierSchema: { schema: {}, classKey: "k" },
      llm: { provider: "openai", model: "gpt-4o-mini" },
    },
    {
      id: "resp",
      type: "llm",
      systemPrompt: "answer the question",
      llm: { provider: "openai", model: "gpt-4o-mini" },
    },
  ],
  edges: [{ source: "clf", target: "resp" }],
};

function makeSnapshot(i: number): ExecutionSnapshot {
  return {
    executionId: `x${i}`,
    flowId: "pipe",
    messages: [{ role: "user", content: `question ${i}` }],
    responseText: `answer ${i}`,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
  };
}

function makeReplayStore(snapshots: ExecutionSnapshot[]): ReplayStore {
  return {
    save: async () => {},
    get: async (id) => snapshots.find((s) => s.executionId === id),
    list: async (limit = 500, filter = {}) =>
      snapshots
        .filter((s) => filter.flowId === undefined || s.flowId === filter.flowId)
        .slice(0, limit),
    purgeOlderThan: async () => 0,
    eraseSubject: async () => 0,
  };
}

function makeModel(obj: unknown): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake",
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(obj) }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 50 } },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
}

const STRUCTURAL_RESPONSE = {
  variants: [
    {
      label: "raise-tokens",
      summary: "raise output budget on resp",
      nodeEdits: [{ nodeId: "resp", maxTokens: 8192 }],
    },
  ],
};

const ANALYSIS_RESPONSE = {
  summary: "resp produced an empty answer.",
  rootCause: "maxTokens too low.",
  findings: [
    { category: "error", severity: "critical", nodeId: "resp", observation: "empty", evidence: "empty_response" },
  ],
  suggestions: [
    {
      category: "error",
      severity: "critical",
      title: "Raise maxTokens",
      rationale: "budget",
      expectedImpact: "no empties",
      edit: { nodes: [{ nodeId: "resp", maxTokens: 8192 }] },
    },
  ],
};

async function makeStore(): Promise<InMemoryFlowStore> {
  const flowStore = new InMemoryFlowStore();
  await flowStore.saveDraft("pipe", PIPE_FLOW, "test");
  await flowStore.publish("pipe", "test");
  return flowStore;
}

const executor: FlowExecutor = async () => ({ text: "response", cost: 0.0001 });
const judge: Judge = async () => ({ score: 0.9, reasoning: "ok" });

describe("FlowOptimizer — structural variants", () => {
  test("generates a structural variant, records its edit, and promotes it onto the full flow", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: makeModel(STRUCTURAL_RESPONSE),
    });

    const run = await optimizer.run({
      flowId: "pipe",
      targetNodeId: "resp",
      allowStructural: true,
      minSamples: 3,
      variantCount: 1,
      autoPromote: true,
      minScoreImprovement: 0,
    });

    expect(run.status).toBe("done");
    expect(run.variants).toHaveLength(1);
    const variant = run.variants[0];
    if (variant === undefined) throw new Error("expected a first variant");
    expect(variant.edit).toBeDefined();
    if (variant.edit === undefined) throw new Error("expected variant.edit to be defined");
    const editNodes = variant.edit.nodes;
    if (editNodes === undefined) throw new Error("expected edit.nodes to be defined");
    const firstEditNode = editNodes[0];
    if (firstEditNode === undefined) throw new Error("expected a first edit node");
    expect(firstEditNode.maxTokens).toBe(8192);
    expect(run.promotedVariant).toBe("raise-tokens");

    // Promotion applied the edit to the FULL flow; clf preserved untouched.
    const rec = await flowStore.get("pipe");
    if (rec === undefined || rec.published === undefined || rec.published === null) {
      throw new Error("expected the flow record and its published definition");
    }
    const resp = rec.published.nodes.find((n) => n.id === "resp");
    if (resp === undefined) throw new Error("expected the resp node to exist");
    if (resp.llm === undefined || resp.llm.parameters === undefined) {
      throw new Error("expected resp.llm.parameters to be defined");
    }
    expect(resp.llm.parameters.maxTokens).toBe(8192);
    expect(rec.published.nodes.some((n) => n.id === "clf")).toBe(true);
  });

  test("structural mode does not require a targetNodeId even with multiple LLM nodes", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: makeModel(STRUCTURAL_RESPONSE),
    });

    // No targetNodeId; PIPE_FLOW has 2 LLM-ish nodes (clf + resp) — prompt mode
    // would skip here, structural mode proceeds.
    const run = await optimizer.run({
      flowId: "pipe",
      allowStructural: true,
      minSamples: 3,
      variantCount: 1,
    });
    expect(run.status).toBe("done");
    expect(run.variants).toHaveLength(1);
  });
});

describe("FlowOptimizer — scoped (sub-graph) optimization", () => {
  test("records the scope and evaluates without error", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: makeModel(STRUCTURAL_RESPONSE),
    });

    const run = await optimizer.run({
      flowId: "pipe",
      scopeNodeIds: ["resp"],
      allowStructural: true,
      minSamples: 3,
      variantCount: 1,
    });

    expect(run.status).toBe("done");
    expect(run.scopeNodeIds).toEqual(["resp"]);
    expect(run.variants).toHaveLength(1);
    // The temporary sub-flow draft must be cleaned up.
    expect(await flowStore.get("pipe@scope/resp")).toBeUndefined();
  });

  test("skips when the scope cannot be extracted", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: makeModel(STRUCTURAL_RESPONSE),
    });

    const run = await optimizer.run({
      flowId: "pipe",
      scopeNodeIds: ["does-not-exist"],
      allowStructural: true,
      minSamples: 3,
    });
    expect(run.status).toBe("skipped");
    expect(run.error).toContain("Sub-flow extraction failed");
  });
});

describe("FlowOptimizer — analysis-seeded generation", () => {
  test("analyses a seed trace and attaches the analysis to the run", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const debugTraceStore = new InMemoryDebugTraceStore(50);
    const trace: DebugTrace = {
      execution_id: "seed-1",
      flow_id: "pipe",
      status: "error",
      started_at: new Date(Date.now() - 2000).toISOString(),
      finished_at: new Date().toISOString(),
      context: {},
      input_messages: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      errors: [],
      nodes: [
        {
          node_id: "resp",
          node_type: "llm",
          status: "error",
          started_at: "",
          finished_at: "",
          latency_ms: 800,
          error_message: "empty",
          error_type: "execution_error",
          diagnostics: [{ at: "", level: "error", code: "empty_response", message: "empty" }],
          tool_calls: [],
        },
      ],
    };
    debugTraceStore.startTrace(trace);

    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: makeModel(STRUCTURAL_RESPONSE),
      analyzerModel: makeModel(ANALYSIS_RESPONSE),
      debugTraceStore,
    });

    const run = await optimizer.run({
      flowId: "pipe",
      targetNodeId: "resp",
      allowStructural: true,
      analysisExecutionId: "seed-1",
      minSamples: 3,
      variantCount: 1,
    });

    expect(run.status).toBe("done");
    expect(run.analysis).toBeDefined();
    if (run.analysis === undefined) throw new Error("expected run.analysis to be defined");
    expect(run.analysis.rootCause).toBeDefined();
    const firstSuggestion = run.analysis.suggestions[0];
    if (firstSuggestion === undefined) throw new Error("expected a first suggestion");
    expect(firstSuggestion.edit).toBeDefined();
  });

  test("proceeds without analysis when the seed execution id is unknown", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: makeModel(STRUCTURAL_RESPONSE),
      analyzerModel: makeModel(ANALYSIS_RESPONSE),
      debugTraceStore: new InMemoryDebugTraceStore(50),
    });

    const run = await optimizer.run({
      flowId: "pipe",
      targetNodeId: "resp",
      allowStructural: true,
      analysisExecutionId: "missing",
      minSamples: 3,
      variantCount: 1,
    });

    expect(run.status).toBe("done");
    expect(run.analysis).toBeUndefined();
  });
});

describe("FlowOptimizer — seed edits (create-variant-from-suggestion)", () => {
  // A generator that throws if invoked — proves a variantCount:0 seed-only run
  // never spends an LLM call on variant generation.
  const throwingGenerator: LanguageModel = {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake",
    doGenerate: async () => {
      throw new Error("generator must not be called for a seed-only run");
    },
    doStream: async () => {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;

  test("evaluates an explicit seed edit as a variant with variantCount:0 (no generation) and promotes it", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: throwingGenerator,
    });

    const run = await optimizer.run({
      flowId: "pipe",
      targetNodeId: "resp",
      variantCount: 0,
      minSamples: 3,
      seedEdits: [
        { summary: "raise output budget", nodes: [{ nodeId: "resp", maxTokens: 8192 }] },
      ],
      autoPromote: true,
      minScoreImprovement: 0,
    });

    expect(run.status).toBe("done");
    expect(run.variants).toHaveLength(1);
    const variant = run.variants[0];
    if (variant === undefined) throw new Error("expected a first variant");
    expect(variant.label).toBe("suggestion-1");
    if (variant.edit === undefined) throw new Error("expected variant.edit to be defined");
    const editNodes = variant.edit.nodes;
    if (editNodes === undefined) throw new Error("expected edit.nodes to be defined");
    const firstEditNode = editNodes[0];
    if (firstEditNode === undefined) throw new Error("expected a first edit node");
    expect(firstEditNode.maxTokens).toBe(8192);
    expect(run.promotedVariant).toBe("suggestion-1");

    // Promotion applied the seeded edit to the full flow.
    const rec = await flowStore.get("pipe");
    if (rec === undefined || rec.published === undefined || rec.published === null) {
      throw new Error("expected the flow record and its published definition");
    }
    const resp = rec.published.nodes.find((n) => n.id === "resp");
    if (resp === undefined) throw new Error("expected the resp node to exist");
    if (resp.llm === undefined || resp.llm.parameters === undefined) {
      throw new Error("expected resp.llm.parameters to be defined");
    }
    expect(resp.llm.parameters.maxTokens).toBe(8192);
  });

  test("drops a structurally-invalid seed edit (edge to a non-existent node)", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: throwingGenerator,
    });

    const run = await optimizer.run({
      flowId: "pipe",
      targetNodeId: "resp",
      variantCount: 0,
      minSamples: 3,
      seedEdits: [{ edges: [{ op: "add", source: "resp", target: "ghost" }] }],
    });

    expect(run.status).not.toBe("error");
    expect(run.variants).toHaveLength(0);
  });

  test("evaluates seed edits ALONGSIDE generated variants when variantCount > 0", async () => {
    const flowStore = await makeStore();
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor,
      judge,
      generatorModel: makeModel(STRUCTURAL_RESPONSE),
    });

    const run = await optimizer.run({
      flowId: "pipe",
      targetNodeId: "resp",
      allowStructural: true,
      variantCount: 1,
      minSamples: 3,
      seedEdits: [
        { summary: "lower temperature", nodes: [{ nodeId: "resp", temperature: 0.1 }] },
      ],
    });

    expect(run.status).toBe("done");
    // 1 seeded (suggestion-1, evaluated first) + 1 generated (raise-tokens).
    expect(run.variants).toHaveLength(2);
    const firstVariant = run.variants[0];
    if (firstVariant === undefined) throw new Error("expected a first variant");
    expect(firstVariant.label).toBe("suggestion-1");
    expect(run.variants.some((v) => v.label === "raise-tokens")).toBe(true);
  });
});

describe("FlowOptimizer — a flow that only exists as a file (FLOWS_DIR)", () => {
  const run = (fileFlows?: (id: string) => FlowDefinition | undefined) => {
    const flowStore = new InMemoryFlowStore(); // empty: nothing online
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(Array.from({ length: 6 }, (_, i) => makeSnapshot(i))),
      flowStore,
      executor,
      judge,
      generatorModel: makeModel(STRUCTURAL_RESPONSE),
      ...(fileFlows ? { fileFlows } : {}),
    });
    return {
      flowStore,
      result: optimizer.run({
        flowId: "pipe",
        targetNodeId: "resp",
        allowStructural: true,
        minSamples: 3,
        variantCount: 1,
        autoPromote: true,
        minScoreImprovement: 0,
      }),
    };
  };

  test("is optimized from the file, and the promoted variant is published online", async () => {
    const { flowStore, result } = run((id) => (id === "pipe" ? PIPE_FLOW : undefined));
    const r = await result;
    expect(r.status).toBe("done");
    expect(r.promotedVariant).toBe("raise-tokens");
    const rec = await flowStore.get("pipe");
    expect(rec?.published?.nodes.find((n) => n.id === "resp")?.llm?.parameters?.maxTokens).toBe(8192);
  });

  test("without the file source it is skipped with a clear reason", async () => {
    const r = await run().result;
    expect(r.status).toBe("skipped");
    expect(r.error ?? "").toContain("neither online nor in FLOWS_DIR");
  });
});
