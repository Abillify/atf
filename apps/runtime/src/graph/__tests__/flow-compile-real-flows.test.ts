// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { compileFlow } from "../graph-engine/compile.js";
import type { FlowDefinition } from "../../types/flow.js";

const linearFixture: FlowDefinition = {
  id: "public-linear-flow",
  name: "Public linear flow",
  nodes: [{ id: "first", type: "llm" }, { id: "second", type: "llm" }],
  edges: [{ source: "first", target: "second" }],
};

const delegationFixture: FlowDefinition = {
  id: "public-delegation-flow",
  name: "Public delegation flow",
  nodes: [
    { id: "orchestrator", type: "agent-harness", config: { allowlist: ["worker"], verification: { target: "verifier", passSignal: "PASS" } } },
    { id: "worker", type: "llm" },
    { id: "verifier", type: "llm" },
  ],
  edges: [],
};

describe("public flow fixtures compile through LangGraph", () => {
  test("compiles a reachable linear flow", () => {
    expect(() => compileFlow(linearFixture)).not.toThrow();
  });

  test("excludes delegation and verification-only nodes from standalone registration", () => {
    expect(delegationFixture.edges.some((edge) => edge.target === "verifier")).toBe(false);
    expect(() => compileFlow(delegationFixture)).not.toThrow();
  });
});
