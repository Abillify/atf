// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { useState, useCallback } from "react";
import { FlowCanvas } from "../components/FlowCanvas";
import type { RFNode, RFEdge } from "../lib/flow-graph";

/**
 * Regression: the Studio builder (/studio) froze the entire page on mount.
 *
 * Root cause: FlowCanvas handed React Flow a fresh `onSelectionChange` handler
 * every render. React Flow re-registers its selection listener when that
 * handler's identity changes and re-invokes it immediately; the parent handler
 * sets state (fresh arrays), which re-renders, which hands over yet another
 * handler identity — an infinite render loop that blocks the main thread.
 *
 * These tests mount the REAL React Flow canvas (not the mock used elsewhere) so
 * the loop would manifest as a test timeout / "Maximum update depth exceeded".
 */

const initialNodes: RFNode[] = [
  {
    id: "llm-1",
    type: "flowNode",
    position: { x: 0, y: 0 },
    data: { flowNode: { id: "llm-1", type: "llm" } },
  },
];

function noUpdateDepthError(errorSpy: ReturnType<typeof vi.spyOn>): boolean {
  return (
    errorSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("Maximum update depth"),
    ) === undefined
  );
}

describe("FlowCanvas selection-change render loop (regression)", () => {
  // Mirrors StudioBuilder: memoized handler that sets fresh-array state.
  test("does not loop with a memoized onSelectionChange (StudioBuilder)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Harness() {
      const [nodes, setNodes] = useState<RFNode[]>(initialNodes);
      const [edges, setEdges] = useState<RFEdge[]>([]);
      const [, setSelectedNodeIds] = useState<string[]>([]);
      const [, setSelNode] = useState<string | null>(null);
      const onSelectionChange = useCallback(
        (nodeIds: string[]): void => {
          setSelectedNodeIds(nodeIds);
          setSelNode(nodeIds.length === 1 ? nodeIds[0] : null);
        },
        [],
      );
      return (
        <FlowCanvas
          nodes={nodes}
          edges={edges}
          editable
          onNodesChange={setNodes}
          onEdgesChange={setEdges}
          onSelectionChange={onSelectionChange}
          height={400}
        />
      );
    }
    render(<Harness />);
    expect(noUpdateDepthError(errorSpy)).toBe(true);
    errorSpy.mockRestore();
  });

  // Inline (unstable) handler that sets state — the pattern the old FlowEditor used.
  test("does not loop with an inline onSelectionChange", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Harness() {
      const [nodes, setNodes] = useState<RFNode[]>(initialNodes);
      const [edges, setEdges] = useState<RFEdge[]>([]);
      const [, setSel] = useState<string | null>(null);
      return (
        <FlowCanvas
          nodes={nodes}
          edges={edges}
          editable
          onNodesChange={setNodes}
          onEdgesChange={setEdges}
          onSelectionChange={(nodeIds) => setSel(nodeIds[0] ?? null)}
          height={400}
        />
      );
    }
    render(<Harness />);
    expect(noUpdateDepthError(errorSpy)).toBe(true);
    errorSpy.mockRestore();
  });
});
