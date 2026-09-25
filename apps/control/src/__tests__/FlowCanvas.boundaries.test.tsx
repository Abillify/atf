// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { FlowCanvas } from "../components/FlowCanvas";
import type { RFNode } from "../lib/flow-graph";

const nodes: RFNode[] = [
  { id: "triage", type: "flowNode", position: { x: 0, y: 0 }, data: { flowNode: { id: "triage", type: "classifier" } } },
  { id: "answer", type: "flowNode", position: { x: 0, y: 200 }, data: { flowNode: { id: "answer", type: "llm" } } },
];

describe("FlowCanvas Start / End", () => {
  test("draws Start and End with their summaries when asked", () => {
    render(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas
          nodes={nodes}
          edges={[]}
          editable
          height={600}
          boundaries={{ start: { summary: "📌 Where is my order?" }, end: { summary: "On its way.", status: "completed" } }}
        />
      </div>,
    );
    expect(screen.getByTestId("boundary-start")).toHaveTextContent("Where is my order?");
    expect(screen.getByTestId("boundary-end")).toHaveTextContent("On its way.");
    expect(screen.getByTestId("boundary-end").className).toContain("ring-green-500");
  });

  test("draws neither without the prop", () => {
    render(<FlowCanvas nodes={nodes} edges={[]} height={600} />);
    expect(screen.queryByTestId("boundary-start")).toBeNull();
  });
});
