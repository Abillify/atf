// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the self-optimizing flow loop
 * (`src/graph/flow-optimizer.ts` + `src/graph/prompt-variant-generator.ts`)
 *
 * All external I/O is replaced by fakes:
 *   - ReplayStore   → in-memory fake with pre-loaded snapshots
 *   - FlowStore     → InMemoryFlowStore
 *   - FlowExecutor  → sync fake that returns a canned response
 *   - Judge         → fake that returns a configurable score
 *   - Generator LLM → fake that returns pre-built variants
 */

import { describe, test, expect } from "bun:test";
import type { LanguageModel } from "ai";
import { createFlowOptimizer, type FlowOptimizer } from "../flow-optimizer.js";
import {
  applyVariant,
  generatePromptVariants,
} from "../prompt-variant-generator.js";
import { InMemoryFlowStore } from "../flow-store.js";
import type { ReplayStore, ExecutionSnapshot } from "../replay.js";
import type { FlowExecutor, Judge } from "../../eval/eval-runner.js";
import type { FlowDefinition } from "../../types/flow.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_FLOW: FlowDefinition = {
  id: "test-flow",
  name: "Test Flow",
  nodes: [
    {
      id: "responder",
      type: "llm",
      label: "Responder",
      systemPrompt:
        "You are a helpful assistant. Answer the user's question concisely.",
    },
  ],
  edges: [],
};

function makeSnapshot(
  i: number,
  response = "The answer is 42.",
): ExecutionSnapshot {
  return {
    executionId: `exec-${i}`,
    flowId: "test-flow",
    messages: [{ role: "user", content: `Question ${i}` }],
    responseText: response,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
  };
}

function makeReplayStore(snapshots: ExecutionSnapshot[]): ReplayStore {
  return {
    save: async () => {},
    get: async (id) => snapshots.find((s) => s.executionId === id),
    list: async (limit = 500) => snapshots.slice(0, limit),
    purgeOlderThan: async () => 0,
    eraseSubject: async () => 0,
  };
}

function makeExecutor(response = "The answer is 42."): FlowExecutor {
  return async () => ({ text: response, cost: 0.0001 });
}

function makeJudge(score = 0.8): Judge {
  return async () => ({ score, reasoning: "Looks good." });
}

/**
 * Makes a fake LanguageModel that returns a pre-built list of variants as a
 * structured object. The optimizer calls generatePromptVariants which calls
 * generateObject; we fake the doGenerate method.
 */
function makeGeneratorModel(
  variants: Array<{ label: string; systemPrompt: string; reasoning?: string }>,
): LanguageModel {
  const obj = {
    variants: variants.map((v) => ({
      ...v,
      reasoning: v.reasoning ?? "Improvement",
    })),
  };
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-generator",
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

async function makeOptimizer(
  snapshots: ExecutionSnapshot[],
  judgeScore = 0.8,
  variants: Array<{ label: string; systemPrompt: string }> = [
    {
      label: "more-direct",
      systemPrompt: "Answer the question directly and concisely.",
    },
    {
      label: "formal",
      systemPrompt:
        "You are a professional assistant. Provide formal, detailed answers.",
    },
  ],
): Promise<{ optimizer: FlowOptimizer; flowStore: InMemoryFlowStore }> {
  const flowStore = new InMemoryFlowStore();
  await flowStore.saveDraft("test-flow", BASE_FLOW, "test");
  await flowStore.publish("test-flow", "test");

  const optimizer = createFlowOptimizer({
    replayStore: makeReplayStore(snapshots),
    flowStore,
    executor: makeExecutor(),
    judge: makeJudge(judgeScore),
    generatorModel: makeGeneratorModel(variants),
  });
  return { optimizer, flowStore };
}

// ---------------------------------------------------------------------------
// applyVariant (pure)
// ---------------------------------------------------------------------------

describe("applyVariant", () => {
  test("replaces systemPrompt on the target node", () => {
    const variant = applyVariant(BASE_FLOW, "responder", "New prompt.", "v1");
    const node = variant.nodes.find((n) => n.id === "responder");
    if (node === undefined) throw new Error("expected the responder node to exist");
    expect(node.systemPrompt).toBe("New prompt.");
  });

  test("leaves other nodes unchanged", () => {
    const flow: FlowDefinition = {
      ...BASE_FLOW,
      nodes: [
        ...BASE_FLOW.nodes,
        { id: "router", type: "router", label: "Router" },
      ],
    };
    const variant = applyVariant(flow, "responder", "New prompt.", "v1");
    const router = variant.nodes.find((n) => n.id === "router");
    if (router === undefined) throw new Error("expected the router node to exist");
    expect(router.systemPrompt).toBeUndefined();
  });

  test("encodes label in the flow id for distinct caching", () => {
    const variant = applyVariant(
      BASE_FLOW,
      "responder",
      "New prompt.",
      "my-label",
    );
    expect(variant.id).toBe("test-flow@variant/my-label");
  });

  test("applies temperature change to existing llm config", () => {
    const flow: FlowDefinition = {
      ...BASE_FLOW,
      nodes: [
        {
          id: "responder",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
      ],
    };
    const variant = applyVariant(flow, "responder", "Prompt.", "v1", 0.3);
    const node = variant.nodes.find((n) => n.id === "responder");
    if (node === undefined) throw new Error("expected the responder node to exist");
    expect(node.llm?.parameters?.temperature).toBe(0.3);
  });

  test("does NOT add temperature when node has no llm config", () => {
    const variant = applyVariant(BASE_FLOW, "responder", "Prompt.", "v1", 0.3);
    const node = variant.nodes.find((n) => n.id === "responder");
    if (node === undefined) throw new Error("expected the responder node to exist");
    expect(node.llm).toBeUndefined();
  });

  test("returns original flow unchanged when nodeId not found", () => {
    const variant = applyVariant(BASE_FLOW, "nonexistent", "New prompt.", "v1");
    const node = variant.nodes.find((n) => n.id === "responder");
    if (node === undefined) throw new Error("expected the responder node to exist");
    const baseFirstNode = BASE_FLOW.nodes[0];
    if (baseFirstNode === undefined) throw new Error("expected BASE_FLOW to have a first node");
    expect(node.systemPrompt).toBe(baseFirstNode.systemPrompt);
  });
});

// ---------------------------------------------------------------------------
// generatePromptVariants (mocked)
// ---------------------------------------------------------------------------

describe("generatePromptVariants", () => {
  test("returns variants with definitions applied", async () => {
    const model = makeGeneratorModel([
      { label: "direct", systemPrompt: "Be direct." },
      { label: "formal", systemPrompt: "Be formal." },
    ]);
    const variants = await generatePromptVariants(
      BASE_FLOW,
      "responder",
      model,
      { count: 2 },
    );
    expect(variants).toHaveLength(2);
    const variant = variants[0];
    if (variant === undefined) throw new Error("expected a first variant");
    expect(variant.label).toBe("direct");
    expect(variant.systemPrompt).toBe("Be direct.");
    expect(variant.definition.id).toBe("test-flow@variant/direct");
    const firstNode = variant.definition.nodes[0];
    if (firstNode === undefined) throw new Error("expected a first node");
    expect(firstNode.systemPrompt).toBe("Be direct.");
  });
});

// ---------------------------------------------------------------------------
// FlowOptimizer.run
// ---------------------------------------------------------------------------

describe("FlowOptimizer.run", () => {
  test("skips when fewer snapshots than minSamples", async () => {
    const { optimizer } = await makeOptimizer([
      makeSnapshot(1),
      makeSnapshot(2),
    ]);
    const run = await optimizer.run({ flowId: "test-flow", minSamples: 5 });
    expect(run.status).toBe("skipped");
    expect(run.error).toContain("2 snapshots available");
  });

  test("skips when flow not in store", async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const { optimizer } = await makeOptimizer(snapshots);
    const run = await optimizer.run({ flowId: "unknown-flow", minSamples: 5 });
    expect(run.status).toBe("skipped");
    expect(run.error).toContain("not found");
  });

  test("skips when flow has multiple LLM nodes and no targetNodeId", async () => {
    const multiNodeFlow: FlowDefinition = {
      ...BASE_FLOW,
      id: "multi-llm",
      nodes: [
        { id: "node-a", type: "llm", systemPrompt: "Prompt A" },
        { id: "node-b", type: "llm", systemPrompt: "Prompt B" },
      ],
    };
    const flowStore = new InMemoryFlowStore();
    await flowStore.saveDraft("multi-llm", multiNodeFlow, "test");
    await flowStore.publish("multi-llm", "test");
    const snapshots = Array.from({ length: 10 }, (_, i) => ({
      ...makeSnapshot(i),
      flowId: "multi-llm",
    }));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor: makeExecutor(),
      judge: makeJudge(0.8),
      generatorModel: makeGeneratorModel([]),
    });
    const run = await optimizer.run({ flowId: "multi-llm", minSamples: 5 });
    expect(run.status).toBe("skipped");
    expect(run.error).toContain("specify targetNodeId");
  });

  test("completes with variant results when enough snapshots", async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const { optimizer } = await makeOptimizer(snapshots, 0.75);
    const run = await optimizer.run({
      flowId: "test-flow",
      targetNodeId: "responder",
      variantCount: 2,
      minSamples: 5,
    });
    expect(run.status).toBe("done");
    expect(run.sampleCount).toBeGreaterThan(0);
    expect(run.variants).toHaveLength(2);
    const firstVariant = run.variants[0];
    if (firstVariant === undefined) throw new Error("expected a first variant");
    expect(firstVariant.avgScore).toBeDefined();
    expect(run.baselineScore).toBeDefined();
  });

  test("captures per-case eval detail for baseline and variants (traceability)", async () => {
    const snapshots = Array.from({ length: 6 }, (_, i) =>
      makeSnapshot(i, `Response text number ${i}`),
    );
    const { optimizer } = await makeOptimizer(snapshots, 0.8, [
      { label: "v1", systemPrompt: "Variant one prompt." },
    ]);
    const run = await optimizer.run({
      flowId: "test-flow",
      targetNodeId: "responder",
      minSamples: 3,
    });

    expect(run.status).toBe("done");
    // Baseline detail present with a case per mined snapshot.
    expect(run.baselineCases).toBeDefined();
    if (run.baselineCases === undefined) throw new Error("expected baselineCases to be defined");
    expect(run.baselineCases.length).toBeGreaterThan(0);
    const firstBaselineCase = run.baselineCases[0];
    if (firstBaselineCase === undefined) throw new Error("expected a first baseline case");
    expect(firstBaselineCase.caseId).toStartWith("exec-");
    expect(firstBaselineCase.userPrompt).toContain("Question");
    expect(firstBaselineCase.responseText).toBeDefined();
    // Baseline system prompt captured for a before/after diff.
    const baseFirstNode = BASE_FLOW.nodes[0];
    if (baseFirstNode === undefined) throw new Error("expected BASE_FLOW to have a first node");
    expect(run.baselineSystemPrompt).toBe(baseFirstNode.systemPrompt);
    // Each variant carries the same set of per-case results.
    const firstVariant = run.variants[0];
    if (firstVariant === undefined) throw new Error("expected a first variant");
    expect(firstVariant.cases.length).toBe(run.baselineCases.length);
    const firstVariantCase = firstVariant.cases[0];
    if (firstVariantCase === undefined) throw new Error("expected a first variant case");
    expect(firstVariantCase.score).toBeDefined();
  });

  test("start() returns immediately and the detached run completes", async () => {
    const snapshots = Array.from({ length: 6 }, (_, i) => makeSnapshot(i));
    const { optimizer } = await makeOptimizer(snapshots, 0.8, [
      { label: "v1", systemPrompt: "Variant one." },
    ]);

    // start() returns synchronously with an in-progress run.
    const initial = optimizer.start({
      flowId: "test-flow",
      targetNodeId: "responder",
      minSamples: 3,
    });
    expect(initial.id).toBeDefined();
    expect(["mining", "evaluating", "generating", "done"]).toContain(
      initial.status,
    );

    // Poll getRun until the detached run finishes.
    let finalRun = optimizer.getRun(initial.id);
    for (
      let i = 0;
      i < 50 &&
      finalRun?.status !== "done" &&
      finalRun?.status !== "error" &&
      finalRun?.status !== "skipped";
      i++
    ) {
      await new Promise((r) => setTimeout(r, 5));
      finalRun = optimizer.getRun(initial.id);
    }
    expect(finalRun?.status).toBe("done");
    expect(finalRun?.variants.length).toBeGreaterThan(0);
  });

  test("auto-promotes when variant score exceeds threshold", async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    // Baseline judge returns 0.5; variant judge returns 0.9 — clearly better.
    // Both baseline and variant eval phases use this judge; since it's hard
    // to distinguish phases, it just returns a high score always.
    const alternatingJudge: Judge = async () => {
      return { score: 0.9, reasoning: "Excellent" };
    };

    const flowStore = new InMemoryFlowStore();
    await flowStore.saveDraft("test-flow", BASE_FLOW, "test");
    await flowStore.publish("test-flow", "test");

    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor: makeExecutor(),
      judge: alternatingJudge,
      generatorModel: makeGeneratorModel([
        { label: "better-prompt", systemPrompt: "Much better system prompt." },
      ]),
    });

    const run = await optimizer.run({
      flowId: "test-flow",
      targetNodeId: "responder",
      minSamples: 5,
      minScoreImprovement: 0, // Always promote if any variant exists.
      autoPromote: true,
    });

    expect(run.status).toBe("done");
    expect(run.promotedVariant).toBeDefined();
    expect(run.promotedVersion).toBeGreaterThan(1);

    // The flow store should have the new promoted version.
    const record = await flowStore.get("test-flow");
    expect(record?.version).toBeGreaterThan(1);
    expect(record?.published?.nodes[0]?.systemPrompt).toBe(
      "Much better system prompt.",
    );
  });

  test("refuses auto-promotion when the judge model is the same as the candidate model (self-grading guard)", async () => {
    const flowWithLlm: FlowDefinition = {
      ...BASE_FLOW,
      nodes: [
        {
          id: "responder",
          type: "llm",
          systemPrompt: "You are a helpful assistant.",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
      ],
    };
    const flowStore = new InMemoryFlowStore();
    await flowStore.saveDraft("test-flow", flowWithLlm, "test");
    await flowStore.publish("test-flow", "test");

    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor: makeExecutor(),
      judge: makeJudge(0.95),
      generatorModel: makeGeneratorModel([
        { label: "better-prompt", systemPrompt: "Much better system prompt." },
      ]),
    });

    const run = await optimizer.run({
      flowId: "test-flow",
      targetNodeId: "responder",
      minSamples: 5,
      minScoreImprovement: 0,
      autoPromote: true,
      judgeModelId: { provider: "openai", model: "gpt-4o-mini" },
    });

    expect(run.status).toBe("skipped");
    expect(run.error).toContain("same model");
    // No promotion must have happened.
    const record = await flowStore.get("test-flow");
    expect(record?.version).toBe(1);
  });

  test("allows auto-promotion when the judge model differs from the candidate model", async () => {
    const flowWithLlm: FlowDefinition = {
      ...BASE_FLOW,
      nodes: [
        {
          id: "responder",
          type: "llm",
          systemPrompt: "You are a helpful assistant.",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
      ],
    };
    const flowStore = new InMemoryFlowStore();
    await flowStore.saveDraft("test-flow", flowWithLlm, "test");
    await flowStore.publish("test-flow", "test");

    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const optimizer = createFlowOptimizer({
      replayStore: makeReplayStore(snapshots),
      flowStore,
      executor: makeExecutor(),
      judge: makeJudge(0.95),
      generatorModel: makeGeneratorModel([
        { label: "better-prompt", systemPrompt: "Much better system prompt." },
      ]),
    });

    const run = await optimizer.run({
      flowId: "test-flow",
      targetNodeId: "responder",
      minSamples: 5,
      minScoreImprovement: 0,
      autoPromote: true,
      judgeModelId: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
    });

    expect(run.status).toBe("done");
    expect(run.promotedVariant).toBeDefined();
  });

  test("does not auto-promote when improvement is below threshold", async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const { optimizer, flowStore } = await makeOptimizer(snapshots, 0.75);
    const initialRecord = await flowStore.get("test-flow");
    const initialVersion = initialRecord?.version ?? 0;

    const run = await optimizer.run({
      flowId: "test-flow",
      targetNodeId: "responder",
      minSamples: 5,
      minScoreImprovement: 0.5, // Impossible to clear (judge always returns 0.75)
      autoPromote: true,
    });

    expect(run.status).toBe("done");
    expect(run.promotedVariant).toBeUndefined();
    // Version should not have changed.
    const afterRecord = await flowStore.get("test-flow");
    expect(afterRecord?.version).toBe(initialVersion);
  });
});

// ---------------------------------------------------------------------------
// FlowOptimizer.promote (manual)
// ---------------------------------------------------------------------------

describe("FlowOptimizer.promote", () => {
  test("promotes a specific variant from a completed run", async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const { optimizer, flowStore } = await makeOptimizer(snapshots, 0.8);

    const run = await optimizer.run({
      flowId: "test-flow",
      targetNodeId: "responder",
      minSamples: 5,
      autoPromote: false,
    });
    expect(run.status).toBe("done");
    expect(run.variants.length).toBeGreaterThan(0);

    const firstVariant = run.variants[0];
    if (firstVariant === undefined) throw new Error("expected a first variant");
    const variantLabel = firstVariant.label;
    const promoted = await optimizer.promote(
      run.id,
      variantLabel,
      "operator-alice",
    );

    expect(promoted.promotedVariant).toBe(variantLabel);
    expect(promoted.promotedVersion).toBeDefined();
    const record = await flowStore.get("test-flow");
    expect(record?.version).toBeGreaterThan(1);
  });

  test("throws when run not found", async () => {
    const { optimizer } = await makeOptimizer([]);
    await expect(
      optimizer.promote("nonexistent", "some-label"),
    ).rejects.toThrow("not found");
  });

  test("throws when variant label not found in run", async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const { optimizer } = await makeOptimizer(snapshots, 0.8);
    const run = await optimizer.run({ flowId: "test-flow", minSamples: 5 });
    await expect(
      optimizer.promote(run.id, "nonexistent-variant"),
    ).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// FlowOptimizer.listRuns / getRun
// ---------------------------------------------------------------------------

describe("FlowOptimizer.getRun / listRuns", () => {
  test("getRun returns a run by id", async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const { optimizer } = await makeOptimizer(snapshots, 0.8);
    const run = await optimizer.run({ flowId: "test-flow", minSamples: 5 });
    const fetched = optimizer.getRun(run.id);
    expect(fetched?.id).toBe(run.id);
    expect(fetched?.flowId).toBe("test-flow");
  });

  test("getRun returns undefined for unknown id", async () => {
    const { optimizer } = await makeOptimizer([]);
    expect(optimizer.getRun("unknown-run")).toBeUndefined();
  });

  test("listRuns returns runs for a specific flow, newest first", async () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => makeSnapshot(i));
    const { optimizer } = await makeOptimizer(snapshots, 0.8);

    // Run twice.
    const r1 = await optimizer.run({ flowId: "test-flow", minSamples: 5 });
    const r2 = await optimizer.run({ flowId: "test-flow", minSamples: 5 });

    const runs = optimizer.listRuns("test-flow");
    expect(runs.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    const ids = runs.map((r) => r.id);
    expect(ids[0]).toBe(r2.id);
    expect(ids[1]).toBe(r1.id);
  });

  test("listRuns returns empty for unknown flow", async () => {
    const { optimizer } = await makeOptimizer([]);
    expect(optimizer.listRuns("unknown-flow")).toHaveLength(0);
  });
});
