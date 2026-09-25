// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { FlowCanvas } from "../components/FlowCanvas";
import { computeDagreLayout } from "../components/graph/GraphLayoutEngine";
import { SubflowPalette } from "../components/SubflowPalette";
import type { RFNode } from "../lib/flow-graph";
import { BOX_LABEL, BOX_PAD, subflowAt, subflowBoxes, subflowPathFor } from "../lib/subflows";

const node = (id: string, x: number, y: number): RFNode => ({
  id,
  type: "flowNode",
  position: { x, y },
  data: { flowNode: { id, type: "llm" } },
});

describe("sub-flow boxes", () => {
  test("one box per sub-flow around its nodes, with room for the label", () => {
    const boxes = subflowBoxes(
      [node("a", 0, 0), node("b", 300, 100), node("c", 600, 0)],
      { a: "subflows/x.yaml", b: "subflows/x.yaml" },
      { width: 200, height: 50 },
    );
    expect(boxes).toEqual([
      {
        path: "subflows/x.yaml",
        nodeIds: ["a", "b"],
        x: -BOX_PAD,
        y: -BOX_PAD - BOX_LABEL,
        width: 500 + 2 * BOX_PAD,
        height: 150 + 2 * BOX_PAD + BOX_LABEL,
      },
    ]);
    expect(subflowAt({ x: 250, y: 60 }, boxes)).toBe("subflows/x.yaml");
    expect(subflowAt({ x: 900, y: 60 }, boxes)).toBeUndefined();
  });

  test("names become safe sub-flow paths", () => {
    expect(subflowPathFor("Retrieval Steps")).toBe("subflows/Retrieval-Steps.yaml");
    expect(subflowPathFor("x.yaml")).toBe("subflows/x.yaml");
    expect(subflowPathFor("../../etc")).toBe("subflows/etc.yaml");
    expect(subflowPathFor("  ")).toBeNull();
  });

  test("the canvas draws a labelled box behind a sub-flow's nodes", () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas
          nodes={[node("a", 0, 0), node("b", 0, 150), node("c", 400, 0)]}
          edges={[]}
          editable
          nodeOrigins={{ a: "subflows/_retrieval.yaml", b: "subflows/_retrieval.yaml" }}
          height={600}
        />
      </div>,
    );
    const box = container.querySelector('[data-testid="subflow-box-subflows/_retrieval.yaml"]');
    expect(box).not.toBeNull();
    expect(box?.textContent).toContain("_retrieval.yaml");
    expect(box?.textContent).toContain("2 nodes");
  });

  test("a selected node is highlighted with a bold ring", () => {
    const sel: RFNode = { ...node("a", 0, 0), selected: true };
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas nodes={[sel, node("b", 0, 150)]} edges={[]} editable height={600} />
      </div>,
    );
    const card = container.querySelector(
      '.react-flow__node[data-id="a"] [role="button"]',
    ) as HTMLElement | null;
    expect(card).not.toBeNull();
    // Bold selection ring (not the old subtle ring-2).
    expect(card!.className).toContain("ring-4");
    expect(card!.className).toContain("ring-sky-500");
  });

  test("the selected sub-flow group's box is visibly highlighted", () => {
    const nodes = [node("a", 0, 0), node("b", 0, 150)];
    const origins = { a: "subflows/lib.yaml", b: "subflows/lib.yaml" };
    const { container, rerender } = render(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas nodes={nodes} edges={[]} editable nodeOrigins={origins} height={600} />
      </div>,
    );
    const box = () => container.querySelector('[data-testid="subflow-box-subflows/lib.yaml"]');
    expect(box()?.getAttribute("data-selected")).toBe("false");

    rerender(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas
          nodes={nodes}
          edges={[]}
          editable
          nodeOrigins={origins}
          selectedSubflowPath="subflows/lib.yaml"
          height={600}
        />
      </div>,
    );
    expect(box()?.getAttribute("data-selected")).toBe("true");
    // Bold solid ring replaces the muted dashed border when selected.
    expect(box()?.className).toContain("ring-4");
    expect(container.querySelector('[data-testid="subflow-select-subflows/lib.yaml"]')?.getAttribute("aria-pressed")).toBe("true");
    // The selected box's React Flow wrapper is lifted above the edge layer so
    // an edge label crossing the group can't hide its highlight/label.
    const wrapper = box()?.closest(".react-flow__node") as HTMLElement | null;
    expect(Number(wrapper?.style.zIndex)).toBeGreaterThan(1000);
  });

  test("layout keeps a cluster's nodes together", () => {
    const pos = computeDagreLayout(
      ["a", "b", "c", "d"],
      [
        { source: "a", target: "b" },
        { source: "a", target: "c" },
        { source: "b", target: "d" },
        { source: "c", target: "d" },
      ],
      { clusters: new Map([["b", "s"], ["d", "s"]]) },
    );
    // b and d share a column; c is on the other side.
    const bx = pos.get("b")?.x ?? 0;
    const dx = pos.get("d")?.x ?? 0;
    const cx = pos.get("c")?.x ?? 0;
    expect(Math.abs(bx - dx)).toBeLessThan(Math.abs(bx - cx));
  });
});

describe("SubflowPalette", () => {
  const actions = (over: Partial<Parameters<typeof SubflowPalette>[0]["actions"]> = {}) => ({
    selectedCount: 0,
    included: ["subflows/on-canvas.yaml"],
    onInclude: vi.fn().mockResolvedValue("Included subflows/lib.yaml: 2 node(s)"),
    onCreate: vi.fn().mockReturnValue(null),
    ...over,
  });

  test("New subflow: shows the target path and what happens, then creates", () => {
    const a = actions({ selectedCount: 3 });
    render(<SubflowPalette actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: /New subflow/ }));
    fireEvent.change(screen.getByLabelText("New sub-flow name"), { target: { value: "retrieval" } });
    expect(screen.getByText("subflows/retrieval.yaml")).toBeInTheDocument();
    expect(screen.getByText(/the 3 selected node\(s\) move into it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(a.onCreate).toHaveBeenCalledWith("retrieval");
  });

  test("Include: lists sub-flow files, marks those on the canvas, includes on click", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        subflows: [
          { path: "subflows/lib.yaml", name: "Library", nodeIds: ["recall", "vision"], edgeCount: 0, usedBy: ["abby"] },
          { path: "subflows/on-canvas.yaml", nodeIds: ["x"], edgeCount: 0, usedBy: [] },
        ],
      }),
    })) as unknown as typeof fetch;
    const a = actions();
    render(<SubflowPalette actions={a} />);
    fireEvent.click(screen.getByRole("button", { name: /Include/ }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("📄 lib.yaml")).toBeInTheDocument());
    expect(within(dialog).getByText(/used by abby/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "On canvas" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Include" }));
    await waitFor(() => expect(a.onInclude).toHaveBeenCalledWith("subflows/lib.yaml"));
    expect(await within(dialog).findByText(/Included subflows\/lib.yaml/)).toBeInTheDocument();
  });
});
