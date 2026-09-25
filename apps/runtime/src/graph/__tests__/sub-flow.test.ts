// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for sub-flow extraction (`src/graph/sub-flow.ts`).
 *
 * Pure logic — no I/O. Covers entry inference, edge pruning, parallel-child
 * pruning, id derivation, and the error paths (unknown node, empty scope,
 * ambiguous entry, invalid slice).
 */

import { describe, test, expect } from "bun:test";
import { extractSubFlow, SubFlowError } from "../sub-flow.js";
import type { FlowDefinition } from "../../types/flow.js";

const FLOW: FlowDefinition = {
  id: "pipe",
  name: "Pipeline",
  nodes: [
    {
      id: "clf",
      type: "classifier",
      classifierSchema: { schema: {}, classKey: "k" },
      llm: { provider: "openai", model: "gpt-4o-mini" },
    },
    { id: "retr", type: "retrieval" },
    { id: "resp", type: "llm", systemPrompt: "answer" },
    { id: "tail", type: "llm", systemPrompt: "format" },
  ],
  edges: [
    { source: "clf", target: "retr" },
    { source: "retr", target: "resp" },
    { source: "resp", target: "tail" },
  ],
};

describe("extractSubFlow", () => {
  test("keeps only scoped nodes and internal edges", () => {
    const sub = extractSubFlow(FLOW, ["retr", "resp"]);
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(["resp", "retr"]);
    expect(sub.edges).toHaveLength(1);
    expect(sub.edges[0]).toMatchObject({ source: "retr", target: "resp" });
  });

  test("places the inferred entry node first", () => {
    const sub = extractSubFlow(FLOW, ["resp", "retr"]);
    // retr has no in-scope predecessor → it's the entry → must be first.
    const first = sub.nodes[0];
    if (first === undefined) throw new Error("expected a first node");
    expect(first.id).toBe("retr");
  });

  test("honours an explicit entryNodeId", () => {
    // A loop: both nodes have an in-scope predecessor, so the entry is
    // ambiguous without entryNodeId. (Two unconnected nodes would not do: the
    // second could never run, and the graph compiler rejects that.)
    const loop: FlowDefinition = {
      id: "loop",
      name: "Loop",
      nodes: [
        { id: "draft", type: "llm", systemPrompt: "draft" },
        { id: "review", type: "llm", systemPrompt: "review" },
      ],
      edges: [
        { source: "draft", target: "review" },
        { source: "review", target: "draft", conditions: "hasErrors" },
      ],
    };
    const sub = extractSubFlow(loop, ["draft", "review"], { entryNodeId: "review" });
    const first = sub.nodes[0];
    if (first === undefined) throw new Error("expected a first node");
    expect(first.id).toBe("review");
  });

  test("derives a stable, scoped flow id", () => {
    const sub = extractSubFlow(FLOW, ["resp", "retr"]);
    expect(sub.id).toBe("pipe@scope/resp+retr");
  });

  test("prunes parallel children outside the scope", () => {
    const flowWithParallel: FlowDefinition = {
      id: "par",
      name: "Par",
      nodes: [
        {
          id: "fan",
          type: "parallel",
          parallelNodes: ["a", "b"],
        },
        { id: "a", type: "llm", systemPrompt: "a" },
        { id: "b", type: "llm", systemPrompt: "b" },
      ],
      // No edges to the children: they run inside the parallel node (an edge
      // to a parallel child is rejected by the graph compiler).
      edges: [],
    };
    const sub = extractSubFlow(flowWithParallel, ["fan", "a"]);
    const fan = sub.nodes.find((n) => n.id === "fan");
    if (fan === undefined) throw new Error("expected the fan node");
    expect(fan.parallelNodes).toEqual(["a"]);
  });

  test("throws on an empty scope", () => {
    expect(() => extractSubFlow(FLOW, [])).toThrow(SubFlowError);
  });

  test("throws when a scoped node does not exist", () => {
    expect(() => extractSubFlow(FLOW, ["ghost"])).toThrow(SubFlowError);
    expect(() => extractSubFlow(FLOW, ["ghost"])).toThrow(/does not exist/);
  });

  test("throws on an ambiguous entry (multiple roots)", () => {
    // clf and tail have no in-scope edge between them → two candidate entries.
    expect(() => extractSubFlow(FLOW, ["clf", "tail"])).toThrow(/ambiguous/);
  });

  test("throws when entryNodeId is not in the scope", () => {
    expect(() =>
      extractSubFlow(FLOW, ["resp", "tail"], { entryNodeId: "clf" }),
    ).toThrow(/not in the scope/);
  });

  test("throws SubFlowError when the extracted slice is structurally invalid", () => {
    // A classifier node without a schema is invalid; scoping to it alone
    // surfaces that as a validation failure.
    const bad: FlowDefinition = {
      id: "b",
      name: "B",
      nodes: [
        { id: "c", type: "classifier" }, // no classifierSchema → invalid
        { id: "d", type: "llm", systemPrompt: "x" },
      ],
      edges: [{ source: "d", target: "c" }],
    };
    expect(() => extractSubFlow(bad, ["c"])).toThrow(SubFlowError);
  });
});
