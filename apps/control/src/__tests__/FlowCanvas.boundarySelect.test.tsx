// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { FlowCanvas } from "../components/FlowCanvas";
import type { RFNode } from "../lib/flow-graph";

const nodes: RFNode[] = [
  { id: "answer", type: "flowNode", position: { x: 0, y: 0 }, data: { flowNode: { id: "answer", type: "llm" } } },
];

describe("FlowCanvas Start selection", () => {
  test("a click on Start reports it as the selected boundary", () => {
    const onSelectBoundary = vi.fn();
    render(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas
          nodes={nodes}
          edges={[]}
          editable
          onNodesChange={() => {}}
          height={600}
          boundaries={{ start: {}, end: {} }}
          onSelectBoundary={onSelectBoundary}
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId("boundary-start"));
    expect(onSelectBoundary).toHaveBeenLastCalledWith("start");
  });
});
