// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for useFlowHistory — the Studio builder's undo/redo stack.
 */

import { describe, test, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFlowHistory } from "../lib/flow-history";
import type { RFNode, RFEdge } from "../lib/flow-graph";

function node(id: string, x: number): RFNode {
  return {
    id,
    type: "flowNode",
    position: { x, y: 0 },
    data: { flowNode: { id, type: "llm" } },
  };
}

const noEdges: RFEdge[] = [];

describe("useFlowHistory", () => {
  test("starts with nothing to undo or redo", () => {
    const { result } = renderHook(() =>
      useFlowHistory({ nodes: [node("a", 0)], edges: noEdges }),
    );
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  test("maybePush enables undo, and undo restores the previous snapshot", () => {
    const initial = { nodes: [node("a", 0)], edges: noEdges };
    const { result } = renderHook(() => useFlowHistory(initial));

    act(() => {
      result.current.maybePush({ nodes: [node("a", 100)], edges: noEdges });
    });
    expect(result.current.canUndo).toBe(true);

    let snap;
    act(() => {
      snap = result.current.undo();
    });
    expect(snap).toEqual(initial);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  test("redo re-applies the undone snapshot", () => {
    const initial = { nodes: [node("a", 0)], edges: noEdges };
    const moved = { nodes: [node("a", 100)], edges: noEdges };
    const { result } = renderHook(() => useFlowHistory(initial));

    act(() => {
      result.current.maybePush(moved);
    });
    act(() => {
      result.current.undo();
    });

    let redone;
    act(() => {
      redone = result.current.redo();
    });
    expect(redone).toEqual(moved);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.canUndo).toBe(true);
  });

  test("maybePush is a no-op when content is unchanged (ignoring `.selected`)", () => {
    const initial = { nodes: [node("a", 0)], edges: noEdges };
    const { result } = renderHook(() => useFlowHistory(initial));

    act(() => {
      // Same content, only the transient `selected` flag differs.
      result.current.maybePush({
        nodes: [{ ...node("a", 0), selected: true }],
        edges: noEdges,
      });
    });
    expect(result.current.canUndo).toBe(false);
  });

  test("a new push after undo clears the redo stack", () => {
    const initial = { nodes: [node("a", 0)], edges: noEdges };
    const { result } = renderHook(() => useFlowHistory(initial));

    act(() => {
      result.current.maybePush({ nodes: [node("a", 100)], edges: noEdges });
    });
    act(() => {
      result.current.undo();
    });
    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.maybePush({ nodes: [node("a", 200)], edges: noEdges });
    });
    expect(result.current.canRedo).toBe(false);
  });

  test("reset clears both stacks and sets a new baseline", () => {
    const initial = { nodes: [node("a", 0)], edges: noEdges };
    const { result } = renderHook(() => useFlowHistory(initial));

    act(() => {
      result.current.maybePush({ nodes: [node("a", 100)], edges: noEdges });
    });
    act(() => {
      result.current.reset({ nodes: [node("b", 0)], edges: noEdges });
    });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
