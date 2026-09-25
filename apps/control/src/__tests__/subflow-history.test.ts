// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { RFNode, RFEdge } from "../lib/flow-graph";
import { useSubflowHistory, type SubflowSnapshot } from "../lib/subflow-history";

const node = (id: string, x = 0): RFNode => ({
  id,
  type: "flowNode",
  position: { x, y: 0 },
  data: { flowNode: { id, type: "llm" } },
});

const snap = (nodeIds: string[], edges: RFEdge[] = []): SubflowSnapshot => ({
  nodes: nodeIds.map((id) => node(id)),
  edges,
  edgeOrigins: {},
});

const PATH = "subflows/lib.yaml";

describe("useSubflowHistory (scoped per sub-flow)", () => {
  test("undo/redo walk a single sub-flow's edits", () => {
    const { result } = renderHook(() => useSubflowHistory());

    act(() => result.current.init(PATH, snap(["x"])));
    expect(result.current.canUndo(PATH)).toBe(false);
    expect(result.current.isDirty(PATH)).toBe(false);

    act(() => result.current.push(PATH, snap(["x", "y"])));
    expect(result.current.canUndo(PATH)).toBe(true);
    expect(result.current.isDirty(PATH)).toBe(true);

    let undone: SubflowSnapshot | undefined;
    act(() => {
      undone = result.current.undo(PATH);
    });
    expect(undone?.nodes.map((n) => n.id)).toEqual(["x"]);
    expect(result.current.canUndo(PATH)).toBe(false);
    expect(result.current.canRedo(PATH)).toBe(true);
    expect(result.current.isDirty(PATH)).toBe(false); // back at baseline

    let redone: SubflowSnapshot | undefined;
    act(() => {
      redone = result.current.redo(PATH);
    });
    expect(redone?.nodes.map((n) => n.id)).toEqual(["x", "y"]);
  });

  test("push coalesces identical content (no spurious step)", () => {
    const { result } = renderHook(() => useSubflowHistory());
    act(() => result.current.init(PATH, snap(["x"])));
    act(() => result.current.push(PATH, snap(["x"]))); // same content
    expect(result.current.canUndo(PATH)).toBe(false);
  });

  test("history is isolated between sub-flows", () => {
    const { result } = renderHook(() => useSubflowHistory());
    const A = "subflows/a.yaml";
    const B = "subflows/b.yaml";
    act(() => {
      result.current.init(A, snap(["a1"]));
      result.current.init(B, snap(["b1"]));
    });
    act(() => result.current.push(A, snap(["a1", "a2"])));
    expect(result.current.canUndo(A)).toBe(true);
    expect(result.current.canUndo(B)).toBe(false); // B untouched
  });

  test("savedBaseline returns the disk version for reset", () => {
    const { result } = renderHook(() => useSubflowHistory());
    act(() => result.current.init(PATH, snap(["x"])));
    act(() => result.current.push(PATH, snap(["x", "y", "z"])));
    expect(result.current.savedBaseline(PATH)?.nodes.map((n) => n.id)).toEqual(["x"]);
    // A save re-establishes the baseline at the current state.
    act(() => result.current.init(PATH, snap(["x", "y", "z"])));
    expect(result.current.isDirty(PATH)).toBe(false);
    expect(result.current.savedBaseline(PATH)?.nodes.map((n) => n.id)).toEqual(["x", "y", "z"]);
  });

  test("forget drops a removed sub-flow's history", () => {
    const { result } = renderHook(() => useSubflowHistory());
    act(() => result.current.init(PATH, snap(["x"])));
    act(() => result.current.push(PATH, snap(["x", "y"])));
    act(() => result.current.forget(PATH));
    expect(result.current.canUndo(PATH)).toBe(false);
    expect(result.current.savedBaseline(PATH)).toBeUndefined();
  });
});
