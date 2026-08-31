// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";
import {
  flowToGraph,
  graphToFlow,
  makeNode,
  autoPosition,
  emptyFlow,
  uniqueId,
  flowNodeToNodeState,
  mergeLiveState,
  parseValidationPath,
  type RFEdge,
} from "../lib/flow-graph";
import type { FlowDefinition } from "../types/flow";

const def: FlowDefinition = {
  id: "f",
  name: "Flow",
  nodes: [
    { id: "router", type: "router" },
    {
      id: "llm",
      type: "llm",
      llm: { provider: "openai", model: "gpt-4o-mini" },
    },
  ],
  edges: [{ source: "router", target: "llm", conditions: "classLabel == 'A'" }],
};

describe("flowToGraph / graphToFlow", () => {
  test("round-trips nodes and edges", () => {
    const { nodes, edges } = flowToGraph(def);
    expect(nodes.map((n) => n.id)).toEqual(["router", "llm"]);
    expect(edges).toHaveLength(1);

    const back = graphToFlow(def, nodes, edges);
    expect(back.nodes.map((n) => n.id)).toEqual(["router", "llm"]);
    expect(back.edges[0]!.conditions).toBe("classLabel == 'A'");
  });

  test("uses stored metadata.ui.layout positions when present", () => {
    const withLayout: FlowDefinition = {
      ...def,
      metadata: {
        ui: {
          layout: [
            { id: "router", x: 10, y: 20 },
            { id: "llm", x: 300, y: 40 },
          ],
        },
      },
    };
    const { nodes } = flowToGraph(withLayout);
    expect(nodes.find((n) => n.id === "router")!.position).toEqual({
      x: 10,
      y: 20,
    });
  });

  test("falls back to the legacy flat metadata.layout map", () => {
    const withLegacyLayout: FlowDefinition = {
      ...def,
      metadata: {
        layout: { router: { x: 10, y: 20 }, llm: { x: 300, y: 40 } },
      },
    };
    const { nodes } = flowToGraph(withLegacyLayout);
    expect(nodes.find((n) => n.id === "router")!.position).toEqual({
      x: 10,
      y: 20,
    });
  });

  test("restores the saved viewport", () => {
    const withViewport: FlowDefinition = {
      ...def,
      metadata: { ui: { layout: [], viewport: { x: 5, y: 6, zoom: 1.5 } } },
    };
    const { viewport } = flowToGraph(withViewport);
    expect(viewport).toEqual({ x: 5, y: 6, zoom: 1.5 });
  });

  test("auto-positions when no layout is stored", () => {
    const { nodes } = flowToGraph(def);
    expect(nodes[0]!.position).toEqual(autoPosition(0));
  });

  test("graphToFlow persists positions into metadata.ui.layout (and drops legacy metadata.layout)", () => {
    const legacyBase: FlowDefinition = {
      ...def,
      metadata: { layout: { stale: { x: 0, y: 0 } } },
    };
    const { nodes, edges } = flowToGraph(legacyBase);
    nodes[0]!.position = { x: 111, y: 222 };
    const back = graphToFlow(legacyBase, nodes, edges);
    expect(back.metadata?.["layout"]).toBeUndefined();
    expect(back.metadata?.ui?.layout).toContainEqual({
      id: "router",
      x: 111,
      y: 222,
    });
  });

  test("graphToFlow persists the viewport when given one", () => {
    const { nodes, edges } = flowToGraph(def);
    const back = graphToFlow(def, nodes, edges, { x: 1, y: 2, zoom: 0.8 });
    expect(back.metadata?.ui?.viewport).toEqual({ x: 1, y: 2, zoom: 0.8 });
  });

  test("edge condition shows as label when no explicit label", () => {
    const { edges } = flowToGraph(def);
    expect(edges[0]!.label).toBe("classLabel == 'A'");
  });
});

describe("uniqueId", () => {
  test("returns the wanted id when free", () => {
    expect(uniqueId("router", ["llm"])).toBe("router");
  });

  test("disambiguates a taken id with -copy", () => {
    expect(uniqueId("router", ["router"])).toBe("router-copy");
  });

  test("disambiguates further when -copy is also taken", () => {
    expect(uniqueId("router", ["router", "router-copy"])).toBe("router-copy2");
  });
});

describe("flowNodeToNodeState / mergeLiveState", () => {
  test("builds an idle pending state with a type-specific subtitle", () => {
    const state = flowNodeToNodeState({
      id: "llm-1",
      type: "llm",
      llm: { provider: "openai", model: "gpt-4o-mini" },
    });
    expect(state.status).toBe("pending");
    expect(state.subtitle).toBe("openai/gpt-4o-mini");
  });

  test("live state overrides status/latency but keeps the base subtitle", () => {
    const base = flowNodeToNodeState({ id: "llm-1", type: "llm" });
    const merged = mergeLiveState(base, {
      id: "llm-1",
      label: "llm-1",
      status: "completed",
      latency_ms: 120,
    });
    expect(merged.status).toBe("completed");
    expect(merged.latency_ms).toBe(120);
    expect(merged.subtitle).toBe(base.subtitle);
  });

  test("returns the base state unchanged when there is no live state", () => {
    const base = flowNodeToNodeState({ id: "llm-1", type: "llm" });
    expect(mergeLiveState(base, undefined)).toEqual(base);
  });
});

describe("nodeOrigins ($includeOrigins round-trip, Phase 4)", () => {
  test("flowToGraph reads $includeOrigins off metadata", () => {
    const composed: FlowDefinition = {
      ...def,
      metadata: { $includeOrigins: { llm: "subflows/guard.yaml" } },
    };
    const { nodeOrigins } = flowToGraph(composed);
    expect(nodeOrigins).toEqual({ llm: "subflows/guard.yaml" });
  });

  test("flowToGraph omits nodeOrigins entirely when absent", () => {
    const { nodeOrigins } = flowToGraph(def);
    expect(nodeOrigins).toBeUndefined();
  });

  test("graphToFlow persists nodeOrigins for nodes still on the canvas", () => {
    const { nodes, edges } = flowToGraph(def);
    const back = graphToFlow(def, nodes, edges, undefined, {
      llm: "subflows/guard.yaml",
    });
    expect(back.metadata?.["$includeOrigins"]).toEqual({
      llm: "subflows/guard.yaml",
    });
  });

  test("graphToFlow drops origins for nodes no longer present", () => {
    const { nodes, edges } = flowToGraph(def);
    const withoutLlm = nodes.filter((n) => n.id !== "llm");
    const back = graphToFlow(def, withoutLlm, edges, undefined, {
      llm: "subflows/guard.yaml",
      router: "subflows/guard.yaml",
    });
    expect(back.metadata?.["$includeOrigins"]).toEqual({
      router: "subflows/guard.yaml",
    });
  });

  test("graphToFlow omits $includeOrigins entirely when the map is empty", () => {
    const { nodes, edges } = flowToGraph(def);
    const back = graphToFlow(def, nodes, edges, undefined, {});
    expect(back.metadata?.["$includeOrigins"]).toBeUndefined();
  });

  test("a stale $includeOrigins on the base flow doesn't leak through when not passed", () => {
    const composed: FlowDefinition = {
      ...def,
      metadata: { $includeOrigins: { llm: "subflows/stale.yaml" } },
    };
    const { nodes, edges } = flowToGraph(composed);
    const back = graphToFlow(composed, nodes, edges);
    expect(back.metadata?.["$includeOrigins"]).toBeUndefined();
  });
});

describe("parseValidationPath", () => {
  const edges: RFEdge[] = [
    { id: "e0", source: "router", target: "llm", data: {} },
  ];

  test("parses a node-scoped path", () => {
    expect(parseValidationPath("nodes[2](llm-node).tools", edges)).toEqual({
      kind: "node",
      id: "llm-node",
      index: 2,
    });
  });

  test("parses an edge-scoped path back to the edge id", () => {
    expect(parseValidationPath("edges[0].conditions", edges)).toEqual({
      kind: "edge",
      id: "e0",
      index: 0,
    });
  });

  test("falls back to global for unscoped paths", () => {
    expect(parseValidationPath("$", edges)).toEqual({ kind: "global" });
    expect(parseValidationPath("edges", edges)).toEqual({ kind: "global" });
  });
});

describe("makeNode", () => {
  test("generates a unique id", () => {
    const n = makeNode("llm", ["llm-1"]);
    expect(n.id).toBe("llm-2");
  });

  test("llm node gets a default model", () => {
    expect(makeNode("llm", []).llm?.model).toBe("gpt-4o-mini");
  });

  test("tool node starts with empty tools", () => {
    expect(makeNode("tool", []).tools).toEqual([]);
  });

  test("classifier node gets a default schema", () => {
    expect(makeNode("classifier", []).classifierSchema?.classKey).toBe(
      "intent",
    );
  });
});

describe("emptyFlow", () => {
  test("scaffolds a single-llm flow", () => {
    const f = emptyFlow("new-flow");
    expect(f.id).toBe("new-flow");
    expect(f.nodes).toHaveLength(1);
    expect(f.nodes[0]!.type).toBe("llm");
  });
});
