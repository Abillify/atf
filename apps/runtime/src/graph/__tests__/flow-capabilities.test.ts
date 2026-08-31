// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { FlowDefinition } from "../../types/flow.js";
import { describeFlowCapabilities } from "../flow-capabilities.js";

const flow: FlowDefinition = {
  id: "capable",
  name: "Capable",
  requiredScopes: ["z", "a"],
  dataClasses: ["personal"],
  recovery: { retry: true },
  nodes: [
    { id: "one", type: "llm", tools: ["search", "search"], llm: { provider: "openai", model: "gpt-4o", parameters: { contextLength: 12345 } } },
    { id: "two", type: "tool", tools: ["write"] },
  ],
  edges: [],
};

describe("describeFlowCapabilities", () => {
  test("returns deduplicated secret-free graph and effective model capabilities", () => {
    const result = describeFlowCapabilities(flow);
    expect(result.requirements.requiredScopes).toEqual(["a", "z"]);
    expect(result.graph.tools).toEqual(["search", "write"]);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]?.contextLength).toBe(12345);
    expect(JSON.stringify(result)).not.toContain("apiKey");
  });
});
