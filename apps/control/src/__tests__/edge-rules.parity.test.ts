// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
// The Studio's copy of the edge rules and the runtime's source of truth. The
// two files carry the same logic on purpose (the runtime enforces it at
// compile/validate time, the Studio rejects a bad connection as it is drawn);
// this test fails the moment they drift apart.
import * as control from "../lib/edge-rules";
import * as runtime from "../../../runtime/src/graph/edge-rules";

type NodeLike = control.NodeLike;
type EdgeLike = control.EdgeLike;

const parallel: NodeLike = { id: "p", type: "parallel", parallelNodes: ["c"] };
const harness: NodeLike = {
  id: "h",
  type: "agent-harness",
  config: { allowlist: ["w"], verification: { target: "v", passSignal: "APPROVED" } },
};

// The same graph the runtime's own edge-rules test uses, so both suites cover
// the identical shapes.
const nodes: NodeLike[] = [
  { id: "a", type: "llm" },
  { id: "b", type: "llm" },
  parallel,
  { id: "c", type: "memory" },
  harness,
  { id: "w", type: "llm" },
  { id: "v", type: "llm" },
];
const edges: EdgeLike[] = [
  { source: "a", target: "b" },
  { source: "b", target: "p" },
  { source: "p", target: "h" },
];

const candidates: EdgeLike[] = [
  { source: "h", target: "a", conditions: "hasErrors" }, // ok — conditional loop
  { source: "a", target: "h" }, // ok
  { source: "a", target: "w" }, // ok — makes the worker a step
  { source: "a", target: "c" }, // into a parallel child
  { source: "c", target: "a" }, // from a parallel child
  { source: "w", target: "a" }, // from a harness worker
  { source: "v", target: "a" }, // from a harness verifier
  { source: "a", target: "a" }, // self-loop
  { source: "a", target: "b" }, // duplicate
  { source: "h", target: "a" }, // unconditional cycle
  { source: "x", target: "a" }, // unknown node
];

describe("Studio edge rules stay in parity with the runtime", () => {
  test("connectionProblem matches for every candidate", () => {
    for (const candidate of candidates) {
      expect(control.connectionProblem(nodes, edges, candidate)).toBe(
        runtime.connectionProblem(nodes, edges, candidate),
      );
    }
  });

  test("flowEdgeIssues matches for whole flows", () => {
    const flows: Array<{ nodes: NodeLike[]; edges: EdgeLike[] }> = [
      { nodes, edges },
      {
        nodes: [parallel, { id: "a", type: "llm" }, { id: "c", type: "memory" }],
        edges: [
          { source: "p", target: "a" },
          { source: "a", target: "c" },
        ],
      },
      {
        nodes: [
          { id: "a", type: "llm" },
          { id: "b", type: "llm" },
          { id: "x", type: "llm" },
        ],
        edges: [{ source: "a", target: "b" }],
      },
    ];
    for (const f of flows) {
      expect(control.flowEdgeIssues(f.nodes, f.edges)).toEqual(
        runtime.flowEdgeIssues(f.nodes, f.edges),
      );
    }
  });

  test("inlineNodes matches", () => {
    expect([...control.inlineNodes(nodes, edges).entries()]).toEqual(
      [...runtime.inlineNodes(nodes, edges).entries()],
    );
  });
});
