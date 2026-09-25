// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";
import { entryProblem, flowBoundaries, withEntryFirst } from "../lib/flow-boundaries";
import type { NodeLike } from "../lib/edge-rules";

const nodes: NodeLike[] = [
  { id: "triage", type: "classifier" },
  { id: "answer", type: "llm" },
  { id: "fanout", type: "parallel", parallelNodes: ["a", "b"] },
  { id: "a", type: "llm" },
  { id: "b", type: "llm" },
  { id: "escalate", type: "tool" },
];
const edges = [
  { source: "triage", target: "answer", conditions: "classLabel == 'x'" },
  { source: "triage", target: "fanout", conditions: "classLabel == 'y'" },
  { source: "fanout", target: "escalate" },
];

describe("flowBoundaries", () => {
  test("the first node is the entry; nodes without outgoing edges and routers without a match end the run", () => {
    const b = flowBoundaries(nodes, edges);
    expect(b.entryId).toBe("triage");
    expect(b.exits).toEqual([
      { nodeId: "triage", kind: "nomatch" },
      { nodeId: "answer", kind: "last" },
      { nodeId: "escalate", kind: "last" },
    ]);
  });

  test("parallel children are not exits (they run inside their parent)", () => {
    const ids = flowBoundaries(nodes, edges).exits.map((x) => x.nodeId);
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
  });

  test("an empty flow has no entry", () => {
    expect(flowBoundaries([], [])).toEqual({ entryId: null, exits: [] });
  });
});

describe("setting the entry", () => {
  test("moves the node to the front, keeping the others in order", () => {
    const list = [{ id: "x" }, { id: "y" }, { id: "z" }];
    expect(withEntryFirst(list, "z").map((n) => n.id)).toEqual(["z", "x", "y"]);
    expect(withEntryFirst(list, "x")).toBe(list);
  });

  test("refuses inline nodes and nodes of a sub-flow file", () => {
    expect(entryProblem(nodes, edges, "answer")).toBeNull();
    expect(entryProblem(nodes, edges, "a")).toMatch(/runs inside “fanout”/);
    expect(entryProblem(nodes, edges, "answer", { answer: "subflows/x.yaml" })).toMatch(/sub-flow/);
    expect(entryProblem(nodes, edges, "nope")).not.toBeNull();
  });
});
