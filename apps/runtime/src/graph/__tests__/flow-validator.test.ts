// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the structured flow validator (dry-run validation).
 */

import { describe, test, expect } from "bun:test";
import { validateFlow } from "../flow-validator.js";
import type { FlowDefinition } from "../../types/flow.js";

const base: FlowDefinition = {
  id: "f1",
  name: "Flow 1",
  nodes: [
    { id: "router", type: "router" },
    {
      id: "llm",
      type: "llm",
      llm: { provider: "openai", model: "gpt-4o-mini" },
    },
  ],
  edges: [{ source: "router", target: "llm" }],
};

describe("validateFlow", () => {
  test("accepts a valid flow", () => {
    const r = validateFlow(base);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
    expect(r.meta).toEqual({ nodeCount: 2, edgeCount: 1, flowId: "f1" });
  });

  test("schema failure → invalid with an error", () => {
    const r = validateFlow({ id: "x", name: "X", nodes: [], edges: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
  });

  test("unknown edge reference is reported by the schema layer", () => {
    const r = validateFlow({
      ...base,
      edges: [{ source: "router", target: "ghost" }],
    });
    expect(r.valid).toBe(false);
  });

  test("invalid routing condition is an error", () => {
    const r = validateFlow({
      ...base,
      edges: [{ source: "router", target: "llm", conditions: "state.x ===" }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.includes("conditions"))).toBe(true);
  });

  test("valid routing condition passes", () => {
    const r = validateFlow({
      ...base,
      edges: [
        { source: "router", target: "llm", conditions: "classLabel == 'A'" },
      ],
    });
    expect(r.valid).toBe(true);
  });

  test("classifier without schema is an error", () => {
    const r = validateFlow({
      id: "c",
      name: "C",
      nodes: [{ id: "cls", type: "classifier" }],
      edges: [],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("classifierSchema"))).toBe(
      true,
    );
  });

  test("parallel referencing an unknown child is an error", () => {
    const r = validateFlow({
      id: "p",
      name: "P",
      nodes: [{ id: "par", type: "parallel", parallelNodes: ["nope"] }],
      edges: [],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.message.includes("unknown child"))).toBe(
      true,
    );
  });

  test("unknown tool is a warning, not an error", () => {
    const r = validateFlow(
      {
        id: "t",
        name: "T",
        nodes: [{ id: "tool", type: "tool", tools: ["mcp/unknown"] }],
        edges: [],
      },
      new Set(["mcp/known"]),
    );
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.message.includes("mcp/unknown"))).toBe(
      true,
    );
  });

  test("known tool produces no warning", () => {
    const r = validateFlow(
      {
        id: "t",
        name: "T",
        nodes: [{ id: "tool", type: "tool", tools: ["mcp/known"] }],
        edges: [],
      },
      new Set(["mcp/known"]),
    );
    expect(r.warnings.filter((w) => w.path.includes("tools"))).toHaveLength(0);
  });
});
