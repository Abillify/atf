// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render } from "@testing-library/react";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { Position, ReactFlowProvider, type EdgeProps } from "@xyflow/react";
import { LabeledBezierEdge, LabeledSmoothStepEdge } from "../components/graph/LabeledEdge";

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
    // jsdom 30 serializes colours like a browser does (#dc2626 → rgb(220, 38, 38)).
    expect((frames[0] as SVGPathElement).style.stroke).toBe("rgb(220, 38, 38)");
    expect((container.querySelector("text") as SVGTextElement).style.fill).toBe("rgb(220, 38, 38)");
  });

  test("cuts a label longer than the edge at the end, with the full text as tooltip", () => {
    // 300px path, ~6.2px per character in jsdom: room for about 40 characters.
    const label = "Orchestrierung (Multi-Domain/Mehrschritt-Anfragen mit Rückfragen und Delegation)";
    const { container } = renderEdge({ label });
    const shown = container.querySelector("textPath")?.textContent ?? "";
    expect(shown.endsWith("…")).toBe(true);
    expect(label.startsWith(shown.slice(0, -1))).toBe(true);
    expect(shown.length).toBeLessThan(label.length);
    expect(container.querySelector(".react-flow__edge-inline-label > title")?.textContent).toBe(label);
  });

  test("the tooltip shows the caller's untruncated label", () => {
    const full = "Fallback (Schnellpfad) wenn keine andere Route greift";
    const { container } = renderEdge({ label: "Fallback (Schnellpfad)…", data: { fullLabel: full } });
    expect(container.querySelector("textPath")?.textContent).toBe("Fallback (Schnellpfad)…");
    expect(container.querySelector(".react-flow__edge-inline-label > title")?.textContent).toBe(full);
  });

  test("keeps a label that fits unchanged, without a tooltip", () => {
    const { container } = renderEdge({ label: "approved" });
    expect(container.querySelector("textPath")?.textContent).toBe("approved");
    expect(container.querySelector(".react-flow__edge-inline-label > title")).toBeNull();
  });

  test("labels of parallel edges sit at their own spot along the shared curve", () => {
    const first = renderEdge({ label: "Kein Nachschlagebedarf", data: { labelSlot: { index: 0, count: 2 } } });
    expect(first.container.querySelector("textPath")?.getAttribute("startOffset")).toMatch(/^33\.33/);
    first.unmount();
    const second = renderEdge({ label: "Fallback", data: { labelSlot: { index: 1, count: 2 } } });
    expect(second.container.querySelector("textPath")?.getAttribute("startOffset")).toMatch(/^66\.66/);
  });

  test("a label shares the curve's length with its parallel edges when cutting", () => {
    // Alone it would fit on 300px; with three labels on the curve it gets a third.
    const label = "Betrieb mit Info-Bedarf -> rag-context";
    const alone = renderEdge({ label });
    expect(alone.container.querySelector("textPath")?.textContent).toBe(label);
    alone.unmount();
    const shared = renderEdge({ label, data: { labelSlot: { index: 1, count: 3 } } });
    expect(shared.container.querySelector("textPath")?.textContent?.endsWith("…")).toBe(true);
  });

  test("a step edge between close side handles runs straight, without a zigzag mid-way", () => {
    // Tool links: caller's right handle → worker's left handle, 38px apart.
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <title>canvas</title>
          <LabeledSmoothStepEdge
            {...({ id: "r", source: "a", target: "b" } as EdgeProps)}
            sourceX={245}
            sourceY={280}
            sourcePosition={Position.Right}
            targetX={283}
            targetY={360}
            targetPosition={Position.Left}
            label="delegates"
          />
        </svg>
      </ReactFlowProvider>,
    );
    const d = container.querySelector(".react-flow__edge-path")?.getAttribute("d") ?? "";
    // The vertical middle run keeps one x (the zigzag had 265 and 263).
    const xs = new Set([...d.matchAll(/(\d+(?:\.\d+)?)[ ,](\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])).filter((x) => x > 261 && x < 267));
    expect([...xs]).toEqual([264]);
  });

  test("renders no label group without a label", () => {
    const { container } = renderEdge({});
    expect(container.querySelector(".react-flow__edge-inline-label")).toBeNull();
  });
});
