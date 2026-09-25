// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import type { RFNode, RFEdge } from "../lib/flow-graph";
import {
  edgeOriginKey,
  moveSubflow,
  removeSubflow,
  subflowEdges,
  subflowFragment,
  subflowGroup,
  subflowNodeIds,
  subflowPaths,
} from "../lib/subflows";

const node = (id: string, x = 0, y = 0): RFNode => ({
  id,
  type: "flowNode",
  position: { x, y },
  data: { flowNode: { id, type: "llm" } },
});

const edge = (id: string, source: string, target: string, synthetic = false): RFEdge => ({
  id,
  source,
  target,
  data: synthetic ? { syntheticId: true } : {},
});

// A flow: parent nodes a, b; sub-flow "lib" nodes x, y.
const nodes = [node("a"), node("b"), node("x", 400), node("y", 400, 150)];
const origins = { x: "subflows/lib.yaml", y: "subflows/lib.yaml" };
const edges = [
  edge("e1", "a", "b"), // parent
  edge("e-x-y", "x", "y", true), // inside lib (id-less)
  edge("e2", "b", "x"), // cross-boundary (parent → lib)
];
const edgeOrigins = { "x->y": "subflows/lib.yaml" };

describe("sub-flow group helpers", () => {
  test("edgeOriginKey uses the id, or source->target for id-less edges", () => {
    expect(edgeOriginKey(edge("real", "a", "b"))).toBe("real");
    expect(edgeOriginKey(edge("synthetic", "a", "b", true))).toBe("a->b");
  });

  test("subflowNodeIds / subflowPaths group by origin", () => {
    expect(subflowNodeIds(origins, "subflows/lib.yaml").sort()).toEqual(["x", "y"]);
    expect(subflowPaths(origins)).toEqual(["subflows/lib.yaml"]);
  });

  test("subflowEdges takes recorded and both-endpoints-inside edges, not cross-boundary", () => {
    const es = subflowEdges(edges, origins, edgeOrigins, "subflows/lib.yaml");
    expect(es.map((e) => e.id)).toEqual(["e-x-y"]);
  });

  test("subflowGroup returns the sub-flow's nodes and edges", () => {
    const g = subflowGroup(nodes, edges, origins, edgeOrigins, "subflows/lib.yaml");
    expect(g.nodes.map((n) => n.id)).toEqual(["x", "y"]);
    expect(g.edges.map((e) => e.id)).toEqual(["e-x-y"]);
  });

  test("moveSubflow shifts only the sub-flow's nodes", () => {
    const moved = moveSubflow(nodes, origins, "subflows/lib.yaml", 50, -20);
    expect(moved.find((n) => n.id === "x")?.position).toEqual({ x: 450, y: -20 });
    expect(moved.find((n) => n.id === "y")?.position).toEqual({ x: 450, y: 130 });
    // parent nodes untouched
    expect(moved.find((n) => n.id === "a")?.position).toEqual({ x: 0, y: 0 });
  });

  test("removeSubflow drops the group, touching edges, and its bookkeeping", () => {
    const r = removeSubflow(nodes, edges, origins, edgeOrigins, "subflows/lib.yaml");
    expect(r.removedNodeIds.sort()).toEqual(["x", "y"]);
    expect(r.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    // e-x-y (inside) and e2 (touches x) are gone; the parent edge stays.
    expect(r.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(r.origins).toEqual({});
    expect(r.edgeOrigins).toEqual({});
  });

  test("subflowFragment strips synthetic ids and canvas noise", () => {
    const g = subflowGroup(nodes, edges, origins, edgeOrigins, "subflows/lib.yaml");
    const frag = subflowFragment(g);
    expect(frag.nodes).toEqual([{ id: "x", type: "llm" }, { id: "y", type: "llm" }]);
    // the id-less edge keeps no synthetic id
    expect(frag.edges).toEqual([{ source: "x", target: "y" }]);
  });
});
