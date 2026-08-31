// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow-builder AI copilot. The model call is stubbed via a fake
 * LanguageModel (same technique as input-guardrail-model.test.ts) so tests
 * are deterministic and offline.
 */

import { describe, test, expect } from "bun:test";
import { applyFlowPatch, proposeFlowEdit, type FlowPatch } from "../flow-copilot.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { LanguageModel } from "ai";

const base: FlowDefinition = {
  id: "f1",
  name: "Flow 1",
  nodes: [
    { id: "router", type: "router" },
    { id: "llm", type: "llm", llm: { provider: "openai", model: "gpt-4o-mini" } },
  ],
  edges: [{ source: "router", target: "llm" }],
};

function emptyPatch(overrides: Partial<FlowPatch> = {}): FlowPatch {
  return {
    explanation: "",
    addNodes: [],
    updateNodes: [],
    removeNodeIds: [],
    addEdges: [],
    removeEdges: [],
    ...overrides,
  };
}

function blankNode(overrides: Partial<FlowPatch["addNodes"][number]>) {
  return {
    id: "",
    type: "",
    label: "",
    provider: "",
    model: "",
    systemPrompt: "",
    tools: [],
    ...overrides,
  };
}

/** Builds a fake LanguageModel whose generateObject call returns `patch` as JSON text. */
function fakeModel(patch: FlowPatch | "throw"): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-copilot",
    doGenerate: async () => {
      if (patch === "throw") throw new Error("provider down");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(patch) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
}

describe("applyFlowPatch", () => {
  test("adds a node with defaults when llm fields are blank", () => {
    const patch = emptyPatch({
      addNodes: [blankNode({ id: "guard", type: "llm" })],
    });
    const proposed = applyFlowPatch(base, patch);
    const added = proposed.nodes.find((n) => n.id === "guard");
    expect(added?.llm).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  test("updates an existing node's system prompt without touching other fields", () => {
    const patch = emptyPatch({
      updateNodes: [blankNode({ id: "llm", type: "llm", systemPrompt: "Be concise." })],
    });
    const proposed = applyFlowPatch(base, patch);
    const updated = proposed.nodes.find((n) => n.id === "llm");
    expect(updated?.systemPrompt).toBe("Be concise.");
    expect(updated?.llm).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  test("removing a node also removes edges touching it", () => {
    const patch = emptyPatch({ removeNodeIds: ["llm"] });
    const proposed = applyFlowPatch(base, patch);
    expect(proposed.nodes.map((n) => n.id)).toEqual(["router"]);
    expect(proposed.edges).toHaveLength(0);
  });

  test("adds an edge with a condition", () => {
    const patch = emptyPatch({
      addNodes: [blankNode({ id: "tool-a", type: "tool" })],
      addEdges: [{ source: "llm", target: "tool-a", conditions: "classLabel == 'x'", label: "" }],
    });
    const proposed = applyFlowPatch(base, patch);
    const edge = proposed.edges.find((e) => e.source === "llm" && e.target === "tool-a");
    expect(edge?.conditions).toBe("classLabel == 'x'");
  });

  test("removes an edge by source/target", () => {
    const patch = emptyPatch({ removeEdges: [{ source: "router", target: "llm" }] });
    const proposed = applyFlowPatch(base, patch);
    expect(proposed.edges).toHaveLength(0);
    // nodes are untouched by an edge-only removal
    expect(proposed.nodes).toHaveLength(2);
  });
});

describe("proposeFlowEdit", () => {
  test("returns the proposed flow, diff, and explanation for a valid patch", async () => {
    const patch = emptyPatch({
      explanation: "Added a guardrail tool node after the router.",
      addNodes: [blankNode({ id: "guardrail", type: "tool" })],
      addEdges: [{ source: "router", target: "guardrail", conditions: "", label: "" }],
    });
    const result = await proposeFlowEdit(base, "add a guardrail node", fakeModel(patch));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.explanation).toBe(patch.explanation);
    expect(result.proposed.nodes.map((n) => n.id)).toContain("guardrail");
    expect(result.diff.nodes.added).toEqual(["guardrail"]);
    expect(result.diff.edges.added.length).toBeGreaterThan(0);
  });

  test("fails without a patch when the model call errors", async () => {
    const result = await proposeFlowEdit(base, "add a node", fakeModel("throw"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("Copilot request failed");
    expect(result.validation).toBeUndefined();
  });

  test("refuses (with validation detail) a patch that would make the flow invalid", async () => {
    // Adds an edge to a node that doesn't exist and is not being added — the
    // resulting flow fails schema validation (unknown edge reference).
    const patch = emptyPatch({
      addEdges: [{ source: "llm", target: "ghost-node", conditions: "", label: "" }],
    });
    const result = await proposeFlowEdit(base, "wire it up", fakeModel(patch));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.validation).toBeDefined();
    expect(result.validation?.valid).toBe(false);
  });
});
