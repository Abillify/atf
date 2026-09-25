// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { FlowCanvas } from "../components/FlowCanvas";
import type { RFNode } from "../lib/flow-graph";
import type { GhostRFNode } from "../lib/flow-diff-view";

/**
 * Regression: Copilot-proposed nodes (ghosts) never appeared. React Flow keeps
 * a node `visibility: hidden` until it has dimensions, and the measurements
 * for overlay nodes were dropped because they aren't part of `nodes`.
 * Mounts the REAL React Flow canvas.
 */
describe("FlowCanvas ghost nodes", () => {
  test("renders a proposed (ghost) node visibly next to the real ones", () => {
    const nodes: RFNode[] = [
      { id: "llm-1", type: "flowNode", position: { x: 0, y: 200 }, data: { flowNode: { id: "llm-1", type: "llm" } } },
    ];
    const ghost: GhostRFNode = {
      id: "retrieval-1",
      type: "flowNode",
      position: { x: 0, y: 0 },
      data: { flowNode: { id: "retrieval-1", type: "retrieval" } },
      draggable: false,
      selectable: false,
      connectable: false,
      ghostKind: "added",
    };
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas nodes={nodes} edges={[]} editable ghostNodes={[ghost]} height={600} />
      </div>,
    );
    const el = container.querySelector('.react-flow__node[data-id="retrieval-1"]') as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el!.style.visibility).not.toBe("hidden");
  });
});
