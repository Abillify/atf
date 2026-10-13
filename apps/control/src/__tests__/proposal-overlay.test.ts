// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";
import { buildProposalOverlay } from "../lib/flow-diff-view";
import { flowToGraph } from "../lib/flow-graph";
import type { FlowDefinition, FlowDiff } from "../types/flow";

const current: FlowDefinition = {
  id: "f",
  name: "F",
  nodes: [
    { id: "llm-1", type: "llm" },
    { id: "old", type: "tool" },
  ],
  edges: [{ source: "old", target: "llm-1" }],
};
const proposed: FlowDefinition = {
  id: "f",
  name: "F",
  nodes: [
    { id: "retrieval-1", type: "retrieval" },
    { id: "llm-1", type: "llm", label: "Answer" },
  ],
  edges: [{ source: "retrieval-1", target: "llm-1", label: "context" }],
};
const diff: FlowDiff = {
  changed: true,
  metadataChanged: false,
  nodes: { added: ["retrieval-1"], removed: ["old"], changed: [{ id: "llm-1", changedFields: ["label"] }] },
  edges: { added: ["retrieval-1->llm-1"], removed: ["old->llm-1"], changed: [] },
  summary: "+1 node(s), -1 node(s)",
};

describe("buildProposalOverlay", () => {
  test("draws added nodes/edges as ghosts and badges removals in place", () => {
    const { nodes, edges } = flowToGraph(current);
    // the operator moved llm-1 somewhere far away
    nodes[0].position = { x: 5000, y: 3000 };
    const overlay = buildProposalOverlay(nodes, edges, proposed, diff);

    expect(overlay.ghostNodes.map((n) => [n.id, n.ghostKind])).toEqual([["retrieval-1", "added"]]);
    // placed relative to the real llm-1, i.e. above it (it feeds into it)
    const ghost = overlay.ghostNodes[0];
    expect(ghost.position.y).toBeLessThan(3000);
    expect(Math.abs(ghost.position.x - 5000)).toBeLessThan(400);

    expect(overlay.ghostEdges).toEqual([
      expect.objectContaining({ source: "retrieval-1", target: "llm-1", label: "context", data: { ghostKind: "added" } }),
    ]);
    expect(overlay.nodeDiff.get("old")).toEqual({ status: "removed" });
    expect(overlay.nodeDiff.get("llm-1")).toEqual({ status: "changed", changedFields: ["label"] });
    expect(overlay.edgeDiff.get(edges[0].id)).toEqual({ status: "removed" });
  });
});
