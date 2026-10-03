// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { FlowCanvas } from "../components/FlowCanvas";
import { type RFNode, referenceEdges } from "../lib/flow-graph";

const node = (id: string, type: string, extra: Record<string, unknown> = {}, y = 0): RFNode => ({
  id,
  type: "flowNode",
  position: { x: 0, y },
  data: { flowNode: { id, type, ...extra } as never },
});

describe("FlowCanvas tool connections", () => {
  test("callers dock tool links on the right, called nodes on the left; flow handles stay top/bottom", () => {
    const nodes = [
      node("ctx", "parallel", { parallelNodes: ["recall"] }),
      node("recall", "memory", {}, 150),
      node("answer", "llm", {}, 300),
    ];
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <FlowCanvas
          nodes={nodes}
          edges={[{ id: "e1", source: "ctx", target: "answer", data: {} }]}
          referenceEdges={referenceEdges(nodes.map((n) => n.data.flowNode))}
          editable
          height={600}
        />
      </div>,
    );
    const handles = (id: string) =>
      [...container.querySelectorAll(`.react-flow__node[data-id="${id}"] .react-flow__handle`)].map(
        (h) => `${h.getAttribute("data-handlepos")}:${h.getAttribute("data-handleid") ?? ""}`,
      );
    expect(handles("ctx")).toEqual(["top:", "bottom:", "right:tool-out"]);
    expect(handles("recall")).toEqual(["top:", "bottom:", "left:tool-in"]);
    expect(handles("answer")).toEqual(["top:", "bottom:"]);
  });
});
