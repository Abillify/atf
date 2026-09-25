// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow-builder AI copilot. The model call is stubbed via a fake
 * LanguageModel (same technique as input-guardrail-model.test.ts) so tests
 * are deterministic and offline.
 */

import { describe, test, expect } from "bun:test";
import { applyFlowPatch, describeFocus, isPlaceholderNode, proposeFlowEdit, type FlowPatch } from "../flow-copilot.js";
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
    shortcut: "",
    configPatch: {},
    fields: {},
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
  test("adds a node without inventing a model when llm fields are blank (DEFAULT_LLM applies)", () => {
    const patch = emptyPatch({
      addNodes: [blankNode({ id: "guard", type: "llm" })],
    });
    const proposed = applyFlowPatch(base, patch);
    const added = proposed.nodes.find((n) => n.id === "guard");
    expect(added?.llm).toBeUndefined();
  });

  test("sets a model shortcut and keeps existing parameters", () => {
    const withParams = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "llm" ? { ...n, llm: { provider: "openai", model: "m", parameters: { temperature: 0.2 } } } : n,
      ),
    } as FlowDefinition;
    const proposed = applyFlowPatch(
      withParams,
      emptyPatch({ updateNodes: [blankNode({ id: "llm", type: "llm", shortcut: "fast-pool" })] }),
    );
    expect(proposed.nodes.find((n) => n.id === "llm")?.llm).toEqual({
      shortcut: "fast-pool",
      parameters: { temperature: 0.2 },
    } as unknown as FlowDefinition["nodes"][number]["llm"]);
  });

  test("merges configPatchJson into the node config (null removes a key)", () => {
    const withConfig = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "llm"
          ? { ...n, config: { maxToolSteps: 4, toolArgs: { "vectorsearch/search": { limit: 5 } }, dropRagContext: true } }
          : n,
      ),
    } as FlowDefinition;
    const proposed = applyFlowPatch(
      withConfig,
      emptyPatch({
        updateNodes: [
          blankNode({
            id: "llm",
            type: "llm",
            tools: ["vectorsearch/search"],
            configPatch: {
              toolArgs: { "vectorsearch/search": { collection: "kanzlei" } },
              maxToolSteps: 8,
              dropRagContext: null,
            },
          }),
        ],
      }),
    );
    const node = proposed.nodes.find((n) => n.id === "llm");
    expect(node?.tools).toEqual(["vectorsearch/search"]);
    expect(node?.config).toEqual({
      maxToolSteps: 8,
      toolArgs: { "vectorsearch/search": { limit: 5, collection: "kanzlei" } },
    });
  });

  test("empty values in a config patch mean no change; null removes", () => {
    const withConfig = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === "llm" ? { ...n, config: { maxToolSteps: 4, clientTools: false } } : n)),
    } as FlowDefinition;
    const proposed = applyFlowPatch(
      withConfig,
      emptyPatch({
        updateNodes: [
          blankNode({
            id: "llm",
            type: "llm",
            configPatch: { errorStrategy: "continue", fallbackNodeId: "", requiresApproval: [], progress: {}, clientTools: null },
          }),
        ],
      }),
    );
    expect(proposed.nodes.find((n) => n.id === "llm")?.config).toEqual({ maxToolSteps: 4, errorStrategy: "continue" });
  });

  test("drops config keys that aren't documented for the node type", () => {
    const proposed = applyFlowPatch(
      base,
      emptyPatch({
        updateNodes: [blankNode({ id: "llm", type: "llm", shortcut: "fast-pool", configPatch: { maxToolSteps: 10, shortcut: "fast-pool" } })],
      }),
    );
    expect(proposed.nodes.find((n) => n.id === "llm")?.config).toEqual({ maxToolSteps: 10 });
  });

  test("repairs a config patch that arrives as a string with leaked brackets", () => {
    const proposed = applyFlowPatch(
      base,
      emptyPatch({
        updateNodes: [blankNode({ id: "llm", type: "llm", configPatch: '{"maxToolSteps": 10}]}], ' })],
      }),
    );
    expect(proposed.nodes.find((n) => n.id === "llm")?.config).toEqual({ maxToolSteps: 10 });
  });

  test("fields sets parallel children but ignores unknown fields", () => {
    const proposed = applyFlowPatch(
      base,
      emptyPatch({
        addNodes: [
          blankNode({
            id: "fan",
            type: "parallel",
            fields: { parallelNodes: ["llm"], id: "hijack", llm: { provider: "x" } },
          }),
        ],
      }),
    );
    const fan = proposed.nodes.find((n) => n.id === "fan");
    expect(fan?.parallelNodes).toEqual(["llm"]);
    expect(fan?.llm).toBeUndefined();
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

/** Fake model answering with each patch in turn (last one repeats). */
function sequenceModel(patches: FlowPatch[]): { model: LanguageModel; calls: () => number; prompts: string[] } {
  let n = 0;
  const prompts: string[] = [];
  const model = {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-copilot",
    doGenerate: async (opts: { prompt: unknown }) => {
      prompts.push(JSON.stringify(opts.prompt));
      const patch = patches[Math.min(n, patches.length - 1)];
      n++;
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
  return { model, calls: () => n, prompts };
}

describe("proposeFlowEdit repair round", () => {
  const broken = emptyPatch({ addEdges: [{ source: "llm", target: "ghost", conditions: "", label: "" }] });
  const fixed = emptyPatch({ updateNodes: [blankNode({ id: "llm", type: "llm", label: "Answer" })] });

  test("feeds validation errors back once and accepts the corrected patch", async () => {
    const { model, calls, prompts } = sequenceModel([broken, fixed]);
    const result = await proposeFlowEdit(base, "rename", model);
    expect(result.ok).toBe(true);
    expect(calls()).toBe(2);
    expect(prompts[1]).toContain("That patch was rejected");
    expect(prompts[1]).toContain("ghost");
  });

  test("reports the concrete problems when the correction fails too", async () => {
    const { model, calls } = sequenceModel([broken, broken]);
    const result = await proposeFlowEdit(base, "rename", model);
    expect(result.ok).toBe(false);
    expect(calls()).toBe(2);
    if (!result.ok) {
      expect(result.message).toContain("automatic correction");
      expect(result.validation?.errors[0]?.message).toContain("ghost");
    }
  });
});


describe("proposeFlowEdit prompt and no-op handling", () => {
  test("a proposal that changes nothing is reported, not offered for accept", async () => {
    const { model } = sequenceModel([emptyPatch({ explanation: "I enabled cacheStable." })]);
    const result = await proposeFlowEdit(base, "machs besser", model);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("No change");
      expect(result.message).toContain("I enabled cacheStable.");
    }
  });

  test("the prompt shows every config key even of a large config", async () => {
    const big = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === "llm"
          ? {
              ...n,
              config: {
                toolArgs: Object.fromEntries(
                  Array.from({ length: 40 }, (_, i) => [`server/tool${i}`, { collection: "x".repeat(300) }]),
                ),
                toolSelection: { mode: "semantic", cacheStable: true },
              },
            }
          : n,
      ),
    } as FlowDefinition;
    const { model, prompts } = sequenceModel([emptyPatch({ updateNodes: [blankNode({ id: "llm", type: "llm", label: "x" })] })]);
    await proposeFlowEdit(big, "anything", model);
    expect(prompts[0]).toContain("cacheStable");
  });
});

describe("editor selection (focus)", () => {
  test("describes selected nodes, the field in focus and its selected text", () => {
    const lines = describeFocus(base, {
      nodeIds: ["llm"],
      field: "systemPrompt",
      fieldSelection: "Antworte kurz.",
    }).join("\n");
    expect(lines).toContain("selected node: llm");
    expect(lines).toContain("editing its field: systemPrompt");
    expect(lines).toContain('"Antworte kurz."');
  });

  test("drops ids that are not in the flow, and says nothing without a selection", () => {
    expect(describeFocus(base, { nodeIds: ["ghost"] })).toEqual([]);
    expect(describeFocus(base, undefined)).toEqual([]);
    expect(describeFocus(base, { nodeIds: [], edge: { source: "router", target: "llm" } }).join("\n")).toContain(
      "selected edge: router -> llm",
    );
  });

  test("the selection reaches the prompt", async () => {
    const { model, prompts } = sequenceModel([emptyPatch({ updateNodes: [blankNode({ id: "llm", type: "llm", label: "x" })] })]);
    await proposeFlowEdit(base, "mach das günstiger", model, { focus: { nodeIds: ["llm"] } });
    expect(prompts[0]).toContain("selected node: llm");
  });
});

describe("new flow: entry and the placeholder node", () => {
  // What the Studio creates for "— new flow —": one bare llm node.
  const fresh: FlowDefinition = { id: "new-flow", name: "new-flow", nodes: [{ id: "llm-1", type: "llm" }], edges: [] };
  const validator = blankNode({ id: "llm-address-validator", type: "llm", label: "Address validator", systemPrompt: "Prüfe die Adresse." });

  test("the prompt marks the first node and the empty placeholder", async () => {
    const { model, prompts } = sequenceModel([emptyPatch({ removeNodeIds: ["llm-1"], addNodes: [validator] })]);
    await proposeFlowEdit(fresh, "Adressvalidierung bauen", model);
    expect(prompts[0]).toContain("id=llm-1, type=llm, (FIRST node — runs start here), (empty placeholder — no settings yet)");
    expect(prompts[0]).toContain("a run starts at the FIRST node");
  });

  test("an unconnected added node gets a concrete fix hint in the repair round", async () => {
    const dangling = emptyPatch({ addNodes: [validator] });
    const connected = emptyPatch({
      addNodes: [validator],
      addEdges: [{ source: "llm-1", target: "llm-address-validator", conditions: "", label: "" }],
    });
    const { model, prompts } = sequenceModel([dangling, connected]);
    const result = await proposeFlowEdit(fresh, "Adressvalidierung bauen", model);
    expect(result.ok).toBe(true);
    expect(prompts[1]).toContain("not reachable from the start");
    expect(prompts[1]).toContain("To fix an unreachable node: add an edge to it");
  });

  test("placeholder detection", () => {
    expect(isPlaceholderNode({ id: "llm-1", type: "llm" })).toBe(true);
    expect(isPlaceholderNode({ id: "t", type: "tool", tools: [] })).toBe(true);
    expect(isPlaceholderNode({ id: "a", type: "llm", label: "Answer" })).toBe(false);
  });
});
