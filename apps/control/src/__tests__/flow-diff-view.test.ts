// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";
import { buildDiffOverlay, parseEdgeKey } from "../lib/flow-diff-view";
import { flowToGraph } from "../lib/flow-graph";
import type { FlowDefinition, FlowDiff } from "../types/flow";

function emptyDiff(): FlowDiff {
  return {
    changed: false,
    metadataChanged: false,
    nodes: { added: [], removed: [], changed: [] },
    edges: { added: [], removed: [], changed: [] },
    summary: "no changes",
  };
}

const fromDef: FlowDefinition = {
  id: "f",
  name: "Flow",
  nodes: [
    { id: "router", type: "router" },
    { id: "old-llm", type: "llm" },
  ],
  edges: [{ source: "router", target: "old-llm" }],
  metadata: { ui: { layout: [{ id: "router", x: 0, y: 0 }, { id: "old-llm", x: 200, y: 0 }] } },
};

const toDef: FlowDefinition = {
  id: "f",
  name: "Flow",
  nodes: [
    { id: "router", type: "router" },
    { id: "new-llm", type: "llm" },
  ],
  edges: [{ source: "router", target: "new-llm" }],
};

describe("parseEdgeKey", () => {
  test("parses a plain source->target key", () => {
    expect(parseEdgeKey("router->llm")).toEqual({ source: "router", target: "llm" });
  });

  test("strips a trailing #id suffix", () => {
    expect(parseEdgeKey("router->llm#e0")).toEqual({ source: "router", target: "llm" });
  });
});

describe("buildDiffOverlay", () => {
  test("marks an added node present in the current canvas", () => {
    const { nodes, edges } = flowToGraph(toDef);
    const diff: FlowDiff = {
      ...emptyDiff(),
      changed: true,
      nodes: { added: ["new-llm"], removed: ["old-llm"], changed: [] },
    };
    const overlay = buildDiffOverlay(fromDef, nodes, edges, diff);
    expect(overlay.nodeDiff.get("new-llm")).toEqual({ status: "added" });
  });

  test("produces a ghost node for a removed node, positioned per the from-version layout", () => {
    const { nodes, edges } = flowToGraph(toDef);
    const diff: FlowDiff = {
      ...emptyDiff(),
      changed: true,
      nodes: { added: ["new-llm"], removed: ["old-llm"], changed: [] },
    };
    const overlay = buildDiffOverlay(fromDef, nodes, edges, diff);
    expect(overlay.ghostNodes).toHaveLength(1);
    expect(overlay.ghostNodes[0]!.id).toBe("old-llm");
    expect(overlay.ghostNodes[0]!.position).toEqual({ x: 200, y: 0 });
    expect(overlay.ghostNodes[0]!.draggable).toBe(false);
    expect(overlay.ghostNodes[0]!.selectable).toBe(false);
  });

  test("marks a changed node with its changed fields", () => {
    const { nodes, edges } = flowToGraph(toDef);
    const diff: FlowDiff = {
      ...emptyDiff(),
      changed: true,
      nodes: { added: [], removed: [], changed: [{ id: "router", changedFields: ["label"] }] },
    };
    const overlay = buildDiffOverlay(fromDef, nodes, edges, diff);
    expect(overlay.nodeDiff.get("router")).toEqual({
      status: "changed",
      changedFields: ["label"],
    });
  });

  test("resolves an added edge to its rendered edge id by source/target", () => {
    const { nodes, edges } = flowToGraph(toDef);
    const diff: FlowDiff = {
      ...emptyDiff(),
      changed: true,
      edges: { added: ["router->new-llm"], removed: [], changed: [] },
    };
    const overlay = buildDiffOverlay(fromDef, nodes, edges, diff);
    const edgeId = edges.find((e) => e.source === "router" && e.target === "new-llm")!.id;
    expect(overlay.edgeDiff.get(edgeId)).toEqual({ status: "added" });
  });

  test("produces a ghost edge for a removed edge when both endpoints resolve", () => {
    const { nodes, edges } = flowToGraph(toDef);
    const diff: FlowDiff = {
      ...emptyDiff(),
      changed: true,
      nodes: { added: ["new-llm"], removed: ["old-llm"], changed: [] },
      edges: { added: [], removed: ["router->old-llm"], changed: [] },
    };
    const overlay = buildDiffOverlay(fromDef, nodes, edges, diff);
    expect(overlay.ghostEdges).toHaveLength(1);
    expect(overlay.ghostEdges[0]).toMatchObject({ source: "router", target: "old-llm" });
  });

  test("skips a removed edge when an endpoint cannot be resolved at all", () => {
    const { nodes, edges } = flowToGraph(toDef);
    const diff: FlowDiff = {
      ...emptyDiff(),
      changed: true,
      // "ghost-node" is removed but not listed in nodes.removed, so it never
      // becomes a ghost node — the edge referencing it must be skipped.
      edges: { added: [], removed: ["ghost-node->router"], changed: [] },
    };
    const overlay = buildDiffOverlay(fromDef, nodes, edges, diff);
    expect(overlay.ghostEdges).toHaveLength(0);
  });

  test("returns empty maps/arrays for a no-op diff", () => {
    const { nodes, edges } = flowToGraph(toDef);
    const overlay = buildDiffOverlay(fromDef, nodes, edges, emptyDiff());
    expect(overlay.nodeDiff.size).toBe(0);
    expect(overlay.edgeDiff.size).toBe(0);
    expect(overlay.ghostNodes).toHaveLength(0);
    expect(overlay.ghostEdges).toHaveLength(0);
  });
});
