// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for GraphLayoutEngine.
 *
 */

import { describe, test, expect } from "vitest";
import {
  computeDagreLayout,
  computeChronologicalLayout,
  NODE_W,
  type LayoutTiming,
} from "../components/graph/GraphLayoutEngine";

// ---------------------------------------------------------------------------
// computeDagreLayout
// ---------------------------------------------------------------------------

describe("computeDagreLayout", () => {
  test("returns a position for every node id", () => {
    const positions = computeDagreLayout(
      ["a", "b", "c"],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    expect(positions.has("a")).toBe(true);
    expect(positions.has("b")).toBe(true);
    expect(positions.has("c")).toBe(true);
  });

  test("positions have numeric x and y", () => {
    const positions = computeDagreLayout(
      ["n1", "n2"],
      [{ source: "n1", target: "n2" }],
    );
    const p1 = positions.get("n1")!;
    const p2 = positions.get("n2")!;
    expect(typeof p1.x).toBe("number");
    expect(typeof p1.y).toBe("number");
    expect(typeof p2.x).toBe("number");
    expect(typeof p2.y).toBe("number");
  });

  test("is deterministic — same input always returns same positions", () => {
    const nodeIds = ["start", "middle", "end"];
    const edges = [
      { source: "start", target: "middle" },
      { source: "middle", target: "end" },
    ];
    const first = computeDagreLayout(nodeIds, edges);
    const second = computeDagreLayout(nodeIds, edges);
    for (const id of nodeIds) {
      expect(first.get(id)).toEqual(second.get(id));
    }
  });

  test("nodes lay out top-to-bottom — later nodes have larger y", () => {
    const positions = computeDagreLayout(
      ["a", "b", "c"],
      [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
      ],
    );
    const ya = positions.get("a")!.y;
    const yb = positions.get("b")!.y;
    const yc = positions.get("c")!.y;
    expect(yb).toBeGreaterThan(ya);
    expect(yc).toBeGreaterThan(yb);
  });

  test("handles a single node (no edges)", () => {
    const positions = computeDagreLayout(["solo"], []);
    expect(positions.has("solo")).toBe(true);
    const p = positions.get("solo")!;
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });

  test("ignores edges whose endpoints are not in the nodeIds list", () => {
    // "ghost" is referenced in edges but not in nodeIds — should not throw
    expect(() =>
      computeDagreLayout(
        ["a", "b"],
        [
          { source: "a", target: "ghost" },
          { source: "ghost", target: "b" },
        ],
      ),
    ).not.toThrow();
    const positions = computeDagreLayout(
      ["a", "b"],
      [{ source: "a", target: "ghost" }],
    );
    expect(positions.has("a")).toBe(true);
    expect(positions.has("b")).toBe(true);
    expect(positions.has("ghost")).toBe(false);
  });

  test("returns empty map for empty node list", () => {
    const positions = computeDagreLayout([], []);
    expect(positions.size).toBe(0);
  });

  test("positions are consistent across multiple calls with identical inputs", () => {
    const nodeIds = ["x", "y", "z", "w"];
    const edges = [
      { source: "x", target: "y" },
      { source: "x", target: "z" },
      { source: "y", target: "w" },
      { source: "z", target: "w" },
    ];
    const runs = Array.from({ length: 5 }, () =>
      computeDagreLayout(nodeIds, edges),
    );
    for (let i = 1; i < runs.length; i++) {
      for (const id of nodeIds) {
        expect(runs[i]!.get(id)).toEqual(runs[0]!.get(id));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// computeChronologicalLayout
// ---------------------------------------------------------------------------

describe("computeChronologicalLayout", () => {
  const T0 = 1_700_000_000_000;

  function makeNode(
    id: string,
    startOffset: number,
    endOffset: number,
  ): LayoutTiming {
    return { id, start: T0 + startOffset, end: T0 + endOffset };
  }

  test("returns a LayoutBox for every node", () => {
    const nodes: LayoutTiming[] = [
      makeNode("a", 0, 100),
      makeNode("b", 150, 300),
    ];
    const { positions } = computeChronologicalLayout(nodes);
    expect(positions.has("a")).toBe(true);
    expect(positions.has("b")).toBe(true);
  });

  test("produces non-negative x positions", () => {
    const nodes: LayoutTiming[] = [
      makeNode("a", 0, 200),
      makeNode("b", 300, 500),
    ];
    const { positions } = computeChronologicalLayout(nodes);
    for (const box of positions.values()) {
      expect(box.x).toBeGreaterThanOrEqual(0);
    }
  });

  test("node that starts later has a larger or equal x position", () => {
    const nodes: LayoutTiming[] = [
      makeNode("first", 0, 200),
      makeNode("second", 400, 600),
    ];
    const { positions } = computeChronologicalLayout(nodes);
    const xFirst = positions.get("first")!.x;
    const xSecond = positions.get("second")!.x;
    expect(xSecond).toBeGreaterThan(xFirst);
  });

  test("returns meta with t0 equal to earliest start", () => {
    const nodes: LayoutTiming[] = [
      makeNode("a", 100, 200),
      makeNode("b", 0, 150),
    ];
    const { meta } = computeChronologicalLayout(nodes);
    expect(meta).not.toBeNull();
    expect(meta!.t0).toBe(T0 + 0);
  });

  test("untimed nodes fall to the right of timed nodes", () => {
    const nodes: LayoutTiming[] = [
      { id: "timed", start: T0, end: T0 + 500 },
      { id: "untimed", start: null, end: null },
    ];
    const { positions } = computeChronologicalLayout(nodes);
    const xTimed = positions.get("timed")!.x;
    const xUntimed = positions.get("untimed")!.x;
    expect(xUntimed).toBeGreaterThan(xTimed);
  });

  test("all nodes untimed — assigns y positions and returns null meta", () => {
    const nodes: LayoutTiming[] = [
      { id: "a", start: null, end: null },
      { id: "b", start: null, end: null },
    ];
    const { positions, meta } = computeChronologicalLayout(nodes);
    expect(meta).toBeNull();
    // Both should have x=0, stacked vertically
    expect(positions.get("a")!.x).toBe(0);
    expect(positions.get("b")!.x).toBe(0);
    expect(positions.get("b")!.y).toBeGreaterThan(positions.get("a")!.y);
  });

  test("width is at least NODE_W", () => {
    const nodes: LayoutTiming[] = [
      makeNode("short", 0, 1), // 1 ms — would be tiny without floor
      makeNode("long", 100, 1000),
    ];
    const { positions } = computeChronologicalLayout(nodes);
    for (const box of positions.values()) {
      expect(box.width).toBeGreaterThanOrEqual(NODE_W);
    }
  });

  test("is deterministic — same input always returns same positions", () => {
    const nodes: LayoutTiming[] = [
      makeNode("a", 0, 200),
      makeNode("b", 100, 400),
      makeNode("c", 500, 600),
    ];
    const first = computeChronologicalLayout(nodes);
    const second = computeChronologicalLayout(nodes);
    for (const [id, box] of first.positions) {
      expect(second.positions.get(id)).toEqual(box);
    }
    expect(first.meta).toEqual(second.meta);
  });

  test("empty node list returns empty positions and null meta", () => {
    const { positions, meta } = computeChronologicalLayout([]);
    expect(positions.size).toBe(0);
    expect(meta).toBeNull();
  });
});
