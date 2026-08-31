// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow version diff (`src/graph/flow-diff.ts`).
 */

import { describe, it, expect } from "bun:test";
import { diffFlows, edgeKey } from "../flow-diff.js";
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
