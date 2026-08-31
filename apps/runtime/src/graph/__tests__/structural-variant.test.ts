// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for structural variants
 * (`applyStructuralEdit` / `applyStructuralVariant` / `generateStructuralVariants`
 *  in `src/graph/prompt-variant-generator.ts`).
 *
 * The pure apply-functions are tested directly; the generator is tested with a
 * fake LanguageModel (same pattern as flow-optimizer.test.ts) so no network is
 * touched. Validation-based dropping and the model whitelist are asserted.
 */

import { describe, test, expect } from "bun:test";
import type { LanguageModel } from "ai";
import {
  applyStructuralEdit,
  applyStructuralVariant,
  generateStructuralVariants,
  type StructuralEdit,
} from "../prompt-variant-generator.js";
import type { FlowDefinition } from "../../types/flow.js";

const FLOW: FlowDefinition = {
  id: "f1",
  name: "F1",
  nodes: [
    {
      id: "resp",
      type: "llm",
      systemPrompt: "old",
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        parameters: { temperature: 0.7 },
      },
      tools: ["mcp/a", "mcp/b"],
    },
    { id: "tail", type: "llm", systemPrompt: "tail" },
  ],
  edges: [{ source: "resp", target: "tail" }],
};

/** Fake model returning a pre-built structural-variants object via generateObject. */
function makeModel(variants: unknown[]): LanguageModel {
  const obj = { variants };
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

describe("applyStructuralEdit", () => {
  test("applies systemPrompt, temperature, maxTokens and model swap together", () => {
    const edit: StructuralEdit = {
      nodes: [
        {
          nodeId: "resp",
          systemPrompt: "new",
          temperature: 0.2,
          maxTokens: 2048,
          model: { provider: "anthropic", model: "claude-x" },
        },
      ],
    };
    const out = applyStructuralEdit(FLOW, edit);
    const resp = out.nodes.find((n) => n.id === "resp");
    if (resp === undefined) throw new Error("expected the resp node to exist");
    expect(resp.systemPrompt).toBe("new");
    if (resp.llm === undefined) throw new Error("expected resp.llm to be defined");
    expect(resp.llm.provider).toBe("anthropic");
    expect(resp.llm.model).toBe("claude-x");
    if (resp.llm.parameters === undefined) throw new Error("expected resp.llm.parameters to be defined");
    expect(resp.llm.parameters.temperature).toBe(0.2);
    expect(resp.llm.parameters.maxTokens).toBe(2048);
  });

  test("adds and removes tools, preserving order and deduping", () => {
    const out = applyStructuralEdit(FLOW, {
      nodes: [{ nodeId: "resp", addTools: ["mcp/c", "mcp/b"], removeTools: ["mcp/a"] }],
    });
    const resp = out.nodes.find((n) => n.id === "resp");
    if (resp === undefined) throw new Error("expected the resp node to exist");
    expect(resp.tools).toEqual(["mcp/b", "mcp/c"]);
  });

  test("does not fabricate an llm block for a parameter-only edit on a node without llm", () => {
    const out = applyStructuralEdit(FLOW, {
      nodes: [{ nodeId: "tail", temperature: 0.5 }],
    });
    const tail = out.nodes.find((n) => n.id === "tail");
    if (tail === undefined) throw new Error("expected the tail node to exist");
    expect(tail.llm).toBeUndefined();
  });

  test("adds, updates and removes edges", () => {
    const out = applyStructuralEdit(FLOW, {
      edges: [
        { op: "remove", source: "resp", target: "tail" },
        { op: "add", source: "tail", target: "resp", conditions: "x == 1" },
      ],
    });
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({
      source: "tail",
      target: "resp",
      conditions: "x == 1",
    });
  });

  test("leaves the flow id unchanged", () => {
    const out = applyStructuralEdit(FLOW, {
      nodes: [{ nodeId: "resp", temperature: 0.1 }],
    });
    expect(out.id).toBe("f1");
  });

  test("ignores edits targeting unknown node ids", () => {
    const out = applyStructuralEdit(FLOW, {
      nodes: [{ nodeId: "ghost", systemPrompt: "x" }],
    });
    expect(out.nodes).toHaveLength(2);
    const resp = out.nodes.find((n) => n.id === "resp");
    if (resp === undefined) throw new Error("expected the resp node to exist");
    expect(resp.systemPrompt).toBe("old");
  });
});

describe("applyStructuralVariant", () => {
  test("suffixes the flow id with the label", () => {
    const out = applyStructuralVariant(
      FLOW,
      { nodes: [{ nodeId: "resp", temperature: 0.1 }] },
      "cool",
    );
    expect(out.id).toBe("f1@variant/cool");
  });
});

describe("generateStructuralVariants", () => {
  test("returns validated variants with edit + definition applied", async () => {
    const model = makeModel([
      {
        label: "raise-tokens",
        summary: "raise output budget",
        nodeEdits: [{ nodeId: "resp", maxTokens: 8192 }],
      },
    ]);
    const variants = await generateStructuralVariants(FLOW, model, { count: 1 });
    expect(variants).toHaveLength(1);
    const variant = variants[0];
    if (variant === undefined) throw new Error("expected a first variant");
    expect(variant.label).toBe("raise-tokens");
    const editNodes = variant.edit.nodes;
    if (editNodes === undefined) throw new Error("expected edit.nodes to be defined");
    const firstEditNode = editNodes[0];
    if (firstEditNode === undefined) throw new Error("expected a first edit node");
    expect(firstEditNode.maxTokens).toBe(8192);
    expect(variant.definition.id).toBe("f1@variant/raise-tokens");
    const respDef = variant.definition.nodes.find((n) => n.id === "resp");
    if (respDef === undefined) throw new Error("expected the resp node to exist");
    if (respDef.llm === undefined) throw new Error("expected respDef.llm to be defined");
    if (respDef.llm.parameters === undefined) throw new Error("expected respDef.llm.parameters to be defined");
    expect(respDef.llm.parameters.maxTokens).toBe(8192);
  });

  test("strips model swaps that are not on the whitelist (keeps other edits)", async () => {
    const model = makeModel([
      {
        label: "swap",
        summary: "swap to a disallowed model but also raise temp",
        nodeEdits: [
          {
            nodeId: "resp",
            model: { provider: "openai", model: "not-allowed" },
            temperature: 0.9,
          },
        ],
      },
    ]);
    const variants = await generateStructuralVariants(FLOW, model, {
      count: 1,
      modelCandidates: [{ provider: "google", model: "gemini-flash" }],
    });
    expect(variants).toHaveLength(1);
    const variant = variants[0];
    if (variant === undefined) throw new Error("expected a first variant");
    const resp = variant.definition.nodes.find((n) => n.id === "resp");
    if (resp === undefined) throw new Error("expected the resp node to exist");
    // Model swap stripped → original model retained.
    if (resp.llm === undefined) throw new Error("expected resp.llm to be defined");
    expect(resp.llm.model).toBe("gpt-4o-mini");
    // Non-model edit preserved.
    if (resp.llm.parameters === undefined) throw new Error("expected resp.llm.parameters to be defined");
    expect(resp.llm.parameters.temperature).toBe(0.9);
    const editNodes = variant.edit.nodes;
    if (editNodes === undefined) throw new Error("expected edit.nodes to be defined");
    const firstEditNode = editNodes[0];
    if (firstEditNode === undefined) throw new Error("expected a first edit node");
    expect(firstEditNode.model).toBeUndefined();
  });

  test("keeps a whitelisted model swap", async () => {
    const model = makeModel([
      {
        label: "cheaper",
        summary: "swap to allowed model",
        nodeEdits: [
          { nodeId: "resp", model: { provider: "google", model: "gemini-flash" } },
        ],
      },
    ]);
    const variants = await generateStructuralVariants(FLOW, model, {
      count: 1,
      modelCandidates: [{ provider: "google", model: "gemini-flash" }],
    });
    const variant = variants[0];
    if (variant === undefined) throw new Error("expected a first variant");
    const resp = variant.definition.nodes.find((n) => n.id === "resp");
    if (resp === undefined) throw new Error("expected the resp node to exist");
    if (resp.llm === undefined) throw new Error("expected resp.llm to be defined");
    expect(resp.llm.model).toBe("gemini-flash");
  });

  test("drops variants whose only edits are all no-ops (empty edit)", async () => {
    // A variant with no node/edge edits at all is useless.
    const model = makeModel([
      { label: "empty", summary: "does nothing" },
      {
        label: "real",
        summary: "raise temp",
        nodeEdits: [{ nodeId: "resp", temperature: 0.4 }],
      },
    ]);
    const variants = await generateStructuralVariants(FLOW, model, { count: 2 });
    expect(variants.map((v) => v.label)).toEqual(["real"]);
  });

  test("ignores edge edits unless allowEdgeEdits is set", async () => {
    // Conditional edge (not an unconditional back-edge) so the slice stays a
    // valid graph — the point under test is the allowEdgeEdits gate, not cycles.
    const model = makeModel([
      {
        label: "rewire",
        summary: "add a conditional edge",
        edgeEdits: [
          { op: "add", source: "tail", target: "resp", conditions: "retry == true" },
        ],
      },
    ]);
    const withoutFlag = await generateStructuralVariants(FLOW, model, {
      count: 1,
    });
    // Edge edits stripped → variant becomes an empty no-op → dropped.
    expect(withoutFlag).toHaveLength(0);

    const withFlag = await generateStructuralVariants(FLOW, model, {
      count: 1,
      allowEdgeEdits: true,
    });
    expect(withFlag).toHaveLength(1);
    const variant = withFlag[0];
    if (variant === undefined) throw new Error("expected a first variant");
    const edgeEdits = variant.edit.edges;
    if (edgeEdits === undefined) throw new Error("expected edit.edges to be defined");
    expect(edgeEdits[0]).toMatchObject({
      op: "add",
      source: "tail",
      target: "resp",
    });
  });
});
