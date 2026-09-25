// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type React from "react";
import type { Connection } from "@xyflow/react";

// Capture the props React Flow is rendered with so the test can invoke the
// real `onConnect` / `isValidConnection` handlers directly — a genuine
// drag-to-connect gesture isn't reproducible in jsdom.
const captured: { onConnect?: (c: Connection) => void; isValidConnection?: (c: Connection) => boolean } = {};

vi.mock("@xyflow/react", () => {
  const ReactFlow = (props: {
    onConnect?: (c: Connection) => void;
    isValidConnection?: (c: Connection) => boolean;
  }) => {
    captured.onConnect = props.onConnect;
    captured.isValidConnection = props.isValidConnection;
    return <div data-testid="react-flow" />;
  };
  return {
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReactFlow: () => ({
      screenToFlowPosition: (p: { x: number; y: number }) => p,
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      fitView: vi.fn(),
    }),
    Background: () => null,
    MiniMap: () => null,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Handle: () => null,
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    // Real addEdge behaviour: append the connection as an edge.
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    applyNodeChanges: (_c: unknown, nodes: unknown[]) => nodes,
    applyEdgeChanges: (_c: unknown, edges: unknown[]) => edges,
  };
});

import { FlowCanvas } from "../components/FlowCanvas";
import type { RFNode, RFEdge } from "../lib/flow-graph";

const node = (id: string, type: string, extra: Record<string, unknown> = {}): RFNode => ({
  id,
  type: "flowNode",
  position: { x: 0, y: 0 },
  data: { flowNode: { id, type, ...extra } as never },
});

const edge = (source: string, target: string): RFEdge => ({
  id: `e-${source}-${target}`,
  source,
  target,
  data: {},
});

function setup(nodes: RFNode[], edges: RFEdge[]) {
  const onEdgesChange = vi.fn();
  const onInvalidConnection = vi.fn();
  render(
    <FlowCanvas
      nodes={nodes}
      edges={edges}
      editable
      onEdgesChange={onEdgesChange}
      onInvalidConnection={onInvalidConnection}
      height={400}
    />,
  );
  return { onEdgesChange, onInvalidConnection };
}

describe("FlowCanvas connection validation", () => {
  beforeEach(() => {
    captured.onConnect = undefined;
    captured.isValidConnection = undefined;
  });

  test("adds a valid connection", () => {
    const nodes = [node("a", "llm"), node("b", "llm")];
    const { onEdgesChange, onInvalidConnection } = setup(nodes, []);

    captured.onConnect?.({ source: "a", target: "b", sourceHandle: null, targetHandle: null });

    expect(onInvalidConnection).not.toHaveBeenCalled();
    expect(onEdgesChange).toHaveBeenCalledTimes(1);
    const next = onEdgesChange.mock.calls[0]![0] as RFEdge[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ source: "a", target: "b" });
  });

  test("rejects a self-loop and reports why", () => {
    const nodes = [node("a", "llm")];
    const { onEdgesChange, onInvalidConnection } = setup(nodes, []);

    captured.onConnect?.({ source: "a", target: "a", sourceHandle: null, targetHandle: null });

    expect(onEdgesChange).not.toHaveBeenCalled();
    expect(onInvalidConnection).toHaveBeenCalledTimes(1);
    expect(onInvalidConnection.mock.calls[0]![0]).toMatch(/cannot connect to itself/);
  });

  test("rejects an edge into a parallel child", () => {
    const nodes = [
      node("p", "parallel", { parallelNodes: ["c"] }),
      node("c", "memory"),
      node("a", "llm"),
    ];
    const { onEdgesChange, onInvalidConnection } = setup(nodes, []);

    captured.onConnect?.({ source: "a", target: "c", sourceHandle: null, targetHandle: null });

    expect(onEdgesChange).not.toHaveBeenCalled();
    expect(onInvalidConnection.mock.calls[0]![0]).toMatch(/runs inside the parallel node “p”/);
  });

  test("rejects a duplicate connection", () => {
    const nodes = [node("a", "llm"), node("b", "llm")];
    const { onEdgesChange, onInvalidConnection } = setup(nodes, [edge("a", "b")]);

    captured.onConnect?.({ source: "a", target: "b", sourceHandle: null, targetHandle: null });

    expect(onEdgesChange).not.toHaveBeenCalled();
    expect(onInvalidConnection.mock.calls[0]![0]).toMatch(/already connected/);
  });

  test("isValidConnection agrees with the reject decision", () => {
    const nodes = [node("a", "llm"), node("b", "llm"), node("c", "llm")];
    setup(nodes, [edge("a", "b")]);

    // Duplicate of an existing edge — refused.
    expect(captured.isValidConnection?.({ source: "a", target: "b", sourceHandle: null, targetHandle: null })).toBe(false);
    // b → a would close the unconditional loop a → b → a — refused.
    expect(captured.isValidConnection?.({ source: "b", target: "a", sourceHandle: null, targetHandle: null })).toBe(false);
    // b → c is a fresh forward edge — allowed.
    expect(captured.isValidConnection?.({ source: "b", target: "c", sourceHandle: null, targetHandle: null })).toBe(true);
  });
});
