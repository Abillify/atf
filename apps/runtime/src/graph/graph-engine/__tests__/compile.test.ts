// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { validateToolReferences } from "../compile.js";
import type { FlowDefinition } from "../../../types/flow.js";

function flowWithTool(tool: string): FlowDefinition {
  return {
    id: "test-flow",
    name: "Test flow",
    nodes: [{ id: "agent", type: "llm", tools: [tool] }],
    edges: [],
  } as FlowDefinition;
}

describe("validateToolReferences", () => {
  test("allows forward-auth server tools for runtime caller-scoped discovery", () => {
    expect(() =>
      validateToolReferences(
        flowWithTool("parking/status"),
        new Set(["parking/*"]),
      ),
    ).not.toThrow();
  });

  test("continues to reject unknown tool references", () => {
    expect(() =>
      validateToolReferences(
        flowWithTool("parking/status"),
        new Set(["worktime/*"]),
      ),
    ).toThrow(/unknown MCP tool ID/);
  });
});
