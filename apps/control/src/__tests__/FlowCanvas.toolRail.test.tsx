// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { FlowCanvas } from "../components/FlowCanvas";
import { EDITOR_NODE_H, EDITOR_NODE_W } from "../components/graph/GraphLayoutEngine";
import type { NodeState } from "../components/graph/graphUtils";
import { layoutEditorGraph, type RFNode } from "../lib/flow-graph";
import { TOOL_RAIL_GAP, toolRailSize } from "../lib/tool-chips";

const nodes: RFNode[] = [
  {
    id: "assist",
    type: "flowNode",
    position: { x: 0, y: 0 },
    data: { flowNode: { id: "assist", type: "llm", tools: ["tickets/lookup", "tickets/create"] } },
  },
  { id: "other", type: "flowNode", position: { x: 0, y: 200 }, data: { flowNode: { id: "other", type: "router" } } },
];

const canvas = (liveStates?: Map<string, NodeState>) =>
  render(
    <div style={{ width: 800, height: 600 }}>
      <FlowCanvas nodes={nodes} edges={[]} editable height={600} {...(liveStates ? { liveStates } : {})} />
    </div>,
  );

describe("FlowCanvas tool chips — click", () => {
  test("a click on a chip reports its node and tool", () => {
    const onToolClick = vi.fn();
    render(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas nodes={nodes} edges={[]} editable height={600} onToolClick={onToolClick} />
      </div>,
    );
    fireEvent.click(screen.getByTestId("tool-chip-tickets/create"));
    expect(onToolClick).toHaveBeenCalledWith("assist", "tickets/create");
  });
});

describe("layoutEditorGraph reserves the tool column", () => {
  test("nodes beside an LLM keep clear of its stacked tools", () => {
    const tools = ["parking/status", "parking/availability", "parking/eligible_users", "parking/book_space"];
    const layout = layoutEditorGraph(
      [
        { id: "entry", type: "router" },
        { id: "assist", type: "llm", tools },
        { id: "other", type: "llm" },
        { id: "after", type: "llm" },
      ],
      [
        { source: "entry", target: "assist" },
        { source: "entry", target: "other" },
        { source: "assist", target: "after" },
      ],
    );
    const rail = toolRailSize(tools);
    const { assist: a, other: o, after } = layout;
    if (!a || !o || !after) throw new Error("layout is missing a node");
    const railLeft = a.x + EDITOR_NODE_W + TOOL_RAIL_GAP;
    const railTop = a.y + EDITOR_NODE_H / 2 - rail.height / 2;
    const railBottom = railTop + rail.height;
    // Horizontally: the neighbour sits left of the node or right of the column.
    expect(o.x + EDITOR_NODE_W <= a.x || o.x >= railLeft + rail.width).toBe(true);
    // Vertically: the next rank starts below the column.
    expect(after.y).toBeGreaterThanOrEqual(railBottom);
  });
});

describe("FlowCanvas tool chips and run emphasis", () => {
  test("every node gets its type icon; an LLM's tools show as chips", () => {
    canvas();
    expect(screen.getAllByTestId("node-type-icon")).toHaveLength(2);
    expect(screen.getByTestId("tool-chip-tickets/lookup")).toHaveAttribute("data-status", "idle");
    expect(screen.getByTestId("tool-chip-tickets/create")).toBeInTheDocument();
    // No run: nodes are drawn at full strength.
    expect(document.querySelectorAll('[data-emphasis="idle"]')).toHaveLength(2);
  });

  test("a traced run highlights what it used and marks a running tool", () => {
    const states = new Map<string, NodeState>([
      ["assist", { id: "assist", label: "assist", status: "running", latency_ms: null, sequence: 1 }],
      [
        "assist::tool::c1",
        {
          id: "assist::tool::c1",
          label: "tickets__lookup",
          status: "running",
          latency_ms: null,
          kind: "tool",
          parent_node_id: "assist",
          sequence: 2,
        },
      ],
    ]);
    canvas(states);
    const chip = screen.getByTestId("tool-chip-tickets/lookup");
    expect(chip).toHaveAttribute("data-status", "running");
    expect(chip.parentElement?.querySelector(".node-running-border")).not.toBeNull();
    expect(screen.getByTestId("tool-chip-tickets/create").className).toContain("opacity-40");
    expect(document.querySelectorAll('[data-emphasis="used"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-emphasis="unused"]')).toHaveLength(1);
  });
});
