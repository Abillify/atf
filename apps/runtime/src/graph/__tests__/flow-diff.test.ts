// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow version diff (`src/graph/flow-diff.ts`).
 */

import { describe, it, expect } from "bun:test";
import { MAX_DETAILS, diffFlows, diffValues, edgeKey } from "../flow-diff.js";
import type { FlowDefinition } from "../../types/flow.js";

function flow(over: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    id: "f",
    name: "Flow",
    nodes: [
      { id: "a", type: "router" },
      {
        id: "b",
        type: "llm",
        llm: { provider: "openai", model: "gpt-4o-mini" },
      },
    ],
    edges: [{ source: "a", target: "b" }],
    ...over,
  };
}

describe("diffFlows", () => {
  it("reports no changes for identical definitions", () => {
    const d = diffFlows(flow(), flow());
    expect(d.changed).toBe(false);
    expect(d.summary).toBe("no changes");
  });

  it("detects an added node", () => {
    const b = flow({
      nodes: [
        { id: "a", type: "router" },
        {
          id: "b",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
        { id: "c", type: "tool", tools: ["x/y"] },
      ],
    });
    const d = diffFlows(flow(), b);
    expect(d.changed).toBe(true);
    expect(d.nodes.added).toEqual(["c"]);
    expect(d.summary).toContain("+1 node");
  });

  it("detects a removed node", () => {
    const a = flow({
      nodes: [
        { id: "a", type: "router" },
        { id: "b", type: "llm" },
        { id: "c", type: "tool" },
      ],
    });
    const d = diffFlows(a, flow());
    expect(d.nodes.removed).toEqual(["c"]);
  });

  it("detects changed node fields", () => {
    const b = flow({
      nodes: [
        { id: "a", type: "router" },
        { id: "b", type: "llm", llm: { provider: "openai", model: "gpt-4o" } }, // model changed
      ],
    });
    const d = diffFlows(flow(), b);
    expect(d.nodes.changed).toHaveLength(1);
    const changed0 = d.nodes.changed[0];
    if (changed0 === undefined) throw new Error("expected a changed node");
    expect(changed0.id).toBe("b");
    expect(changed0.changedFields).toContain("llm");
  });

  it("detects edge additions, removals and changes", () => {
    const a = flow({ edges: [{ source: "a", target: "b" }] });
    const b = flow({
      edges: [
        { source: "a", target: "b", conditions: "state.x == 1" }, // changed
        { source: "b", target: "a" }, // added
      ],
    });
    const d = diffFlows(a, b);
    expect(d.edges.added).toContain("b->a");
    const changedEdge0 = d.edges.changed[0];
    if (changedEdge0 === undefined) throw new Error("expected a changed edge");
    expect(changedEdge0.changedFields).toContain("conditions");
  });

  it("detects name, description and metadata changes", () => {
    const d = diffFlows(
      flow({ name: "Old", description: "x", metadata: { v: 1 } }),
      flow({ name: "New", description: "y", metadata: { v: 2 } }),
    );
    expect(d.name).toEqual({ from: "Old", to: "New" });
    expect(d.description).toEqual({ from: "x", to: "y" });
    expect(d.metadataChanged).toBe(true);
    expect(d.summary).toContain("name");
  });

  it("keys edges by id when present", () => {
    expect(edgeKey({ id: "e1", source: "a", target: "b" })).toBe("a->b#e1");
    expect(edgeKey({ source: "a", target: "b" })).toBe("a->b");
  });
});

describe("value details", () => {
  const live: FlowDefinition = {
    id: "n8n",
    name: "n8n",
    nodes: [{ id: "n8n-responder", type: "llm", llm: { shortcut: "{{vars.model_main}}" } } as FlowDefinition["nodes"][number]],
    edges: [],
  };
  const draft: FlowDefinition = {
    ...live,
    nodes: [
      {
        ...live.nodes[0]!,
        config: { routing: { strategy: "balanced", candidates: [{ shortcut: "qwen-lmstudio" }, { shortcut: "sonnet" }] } },
      },
      { id: "extra", type: "tool", tools: ["search"] },
    ],
    edges: [{ source: "n8n-responder", target: "extra", conditions: "x == 1" }],
  };

  it("lists what changed inside a node's config, and the full added entities", () => {
    const d = diffFlows(live, draft);
    expect(d.nodes.changed).toEqual([
      {
        id: "n8n-responder",
        changedFields: ["config"],
        details: [
          {
            path: "config",
            kind: "added",
            to: { routing: { strategy: "balanced", candidates: [{ shortcut: "qwen-lmstudio" }, { shortcut: "sonnet" }] } },
          },
        ],
      },
    ]);
    expect(d.values?.nodes.added["extra"]).toEqual({ id: "extra", type: "tool", tools: ["search"] });
    expect(d.values?.edges.added["n8n-responder->extra"]).toMatchObject({ conditions: "x == 1" });
  });

  it("goes down to the changed leaf, index by index in arrays", () => {
    expect(
      diffValues(
        { routing: { strategy: "balanced", candidates: [{ shortcut: "a" }, { shortcut: "b" }] } },
        { routing: { strategy: "cheapest", candidates: [{ shortcut: "a" }, { shortcut: "c" }, { shortcut: "d" }] } },
        "config",
      ),
    ).toEqual([
      { path: "config.routing.strategy", kind: "changed", from: "balanced", to: "cheapest" },
      { path: "config.routing.candidates[1].shortcut", kind: "changed", from: "b", to: "c" },
      { path: "config.routing.candidates[2]", kind: "added", to: { shortcut: "d" } },
    ]);
  });

  it("caps the detail list", () => {
    const big = (v: number) => Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, v]));
    expect(diffValues(big(1), big(2))).toHaveLength(MAX_DETAILS);
  });
});
