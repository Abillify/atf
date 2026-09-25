// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render } from "@testing-library/react";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Position, ReactFlowProvider, type EdgeProps } from "@xyflow/react";
import { LabeledBezierEdge } from "../components/graph/LabeledEdge";

function renderEdge(props: Partial<EdgeProps>) {
  const base = {
    id: "e1",
    source: "a",
    target: "b",
    sourceX: 0,
    sourceY: 0,
    sourcePosition: Position.Bottom,
    targetX: 0,
    targetY: 300,
    targetPosition: Position.Top,
  } as EdgeProps;
  return render(
    <ReactFlowProvider>
      <svg>
        <title>canvas</title>
        <LabeledBezierEdge {...base} {...props} />
      </svg>
    </ReactFlowProvider>,
  );
}

describe("LabeledEdge", () => {
  // jsdom has no SVG geometry: pretend every path is a 300px vertical line.
  const proto = SVGElement.prototype as unknown as Record<string, unknown>;
  beforeAll(() => {
    proto.getTotalLength = () => 300;
    proto.getPointAtLength = (l: number) => ({ x: 0, y: l });
  });
  afterAll(() => {
    delete proto.getTotalLength;
    delete proto.getPointAtLength;
  });

  test("draws the label along the edge path", () => {
    const { container } = renderEdge({ label: "approved" });
    const textPath = container.querySelector("textPath");
    expect(textPath?.textContent).toBe("approved");
    const target = container.querySelector(textPath?.getAttribute("href") ?? "");
    expect(target?.tagName.toLowerCase()).toBe("path");
    expect(target?.getAttribute("d")).toBe(container.querySelector(".react-flow__edge-path")?.getAttribute("d"));
  });

  test("frames the label in the edge colour", () => {
    const { container } = renderEdge({ label: "approved", style: { stroke: "#dc2626" } });
    const frames = [...container.querySelectorAll<SVGPathElement>(".react-flow__edge-inline-label path")].filter(
      (p) => p.style.strokeDasharray !== "",
    );
    expect(frames.length).toBe(2);
    expect((frames[0] as SVGPathElement).style.stroke).toBe("#dc2626");
    expect((container.querySelector("text") as SVGTextElement).style.fill).toBe("#dc2626");
  });

  test("renders no label group without a label", () => {
    const { container } = renderEdge({});
    expect(container.querySelector(".react-flow__edge-inline-label")).toBeNull();
  });
});
