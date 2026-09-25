// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { FlowDefinition } from "../../types/flow.js";
import { connectionProblem, flowEdgeIssues } from "../edge-rules.js";
import { validateFlow } from "../flow-validator.js";
import { compileFlow } from "../graph-engine/compile.js";

const flow = (nodes: unknown[], edges: unknown[]): FlowDefinition =>
  ({ id: "f", name: "F", nodes, edges }) as unknown as FlowDefinition;

const parallel = { id: "p", type: "parallel", parallelNodes: ["c"] };
const harness = {
  id: "h",
  type: "agent-harness",
  config: { allowlist: ["w"], verification: { target: "v", passSignal: "APPROVED" } },
};

/** Cases with whether the graph compiler accepts them. */
const cases: Array<[string, FlowDefinition, boolean]> = [
  ["edge into a parallel child", flow([parallel, { id: "a", type: "llm" }, { id: "c", type: "memory" }], [{ source: "p", target: "a" }, { source: "a", target: "c" }]), false],
  ["edge from a parallel child", flow([parallel, { id: "a", type: "llm" }, { id: "c", type: "memory" }], [{ source: "p", target: "a" }, { source: "c", target: "a" }]), false],
  ["edge from a harness-only worker", flow([harness, { id: "a", type: "llm" }, { id: "w", type: "llm" }, { id: "v", type: "llm" }], [{ source: "h", target: "a" }, { source: "w", target: "a" }]), false],
  ["edge into a harness worker (becomes a step)", flow([harness, { id: "a", type: "llm" }, { id: "w", type: "llm" }, { id: "v", type: "llm" }], [{ source: "h", target: "a" }, { source: "a", target: "w" }]), true],
  ["unreachable node", flow([{ id: "a", type: "llm" }, { id: "b", type: "llm" }, { id: "x", type: "llm" }], [{ source: "a", target: "b" }]), false],
  ["reachable chain with a conditional loop", flow([{ id: "a", type: "llm" }, { id: "b", type: "llm" }], [{ source: "a", target: "b" }, { source: "b", target: "a", conditions: "hasErrors" }]), true],
  ["harness with its workers inline", flow([harness, { id: "w", type: "llm" }, { id: "v", type: "llm" }, { id: "a", type: "llm" }], [{ source: "h", target: "a" }]), true],
];

describe("flow edge rules match the graph compiler", () => {
  for (const [name, f, compiles] of cases) {
    test(name, () => {
      let compiled = true;
      try {
        compileFlow(f);
      } catch {
        compiled = false;
      }
      expect(compiled).toBe(compiles);
      expect(flowEdgeIssues(f.nodes, f.edges).length === 0).toBe(compiles);
      expect(validateFlow(f).valid).toBe(compiles);
    });
  }
});

describe("connectionProblem (drawing an edge in the Studio)", () => {
  const nodes = [
    { id: "a", type: "llm" },
    { id: "b", type: "llm" },
    parallel,
    { id: "c", type: "memory" },
    harness,
    { id: "w", type: "llm" },
    { id: "v", type: "llm" },
  ];
  const edges = [
    { source: "a", target: "b" },
    { source: "b", target: "p" },
    { source: "p", target: "h" },
  ];
  const problem = (source: string, target: string, conditions?: string) =>
    connectionProblem(nodes, edges, { source, target, ...(conditions ? { conditions } : {}) });

  test("allows ordinary steps and conditional loops", () => {
    expect(problem("h", "a", "hasErrors")).toBeNull();
    expect(problem("a", "h")).toBeNull();
    expect(problem("a", "w")).toBeNull(); // makes the worker a regular step too
  });

  test("refuses edges that the compiler or validator would reject", () => {
    expect(problem("a", "c")).toMatch(/runs inside the parallel node “p”/);
    expect(problem("c", "a")).toMatch(/runs inside the parallel node “p”/);
    expect(problem("w", "a")).toMatch(/worker of the agent harness “h”/);
    expect(problem("v", "a")).toMatch(/worker of the agent harness “h”/);
    expect(problem("a", "a")).toMatch(/cannot connect to itself/);
    expect(problem("a", "b")).toMatch(/already connected/);
    expect(problem("h", "a")).toMatch(/endless loop \(a → b → p → h → a\)/);
  });
});
