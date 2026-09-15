// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for `collectFlowLlmConfigs` (chat/handler.ts) — used by the
 * compliance policy check to evaluate every model a flow statically declares.
 */

import { describe, it, expect } from "bun:test";
import { collectFlowLlmConfigs } from "../handler.js";
import type { FlowDefinition } from "../../../types/flow.js";

describe("collectFlowLlmConfigs", () => {
  it("returns an empty array for an undefined flow", () => {
    expect(collectFlowLlmConfigs(undefined)).toEqual([]);
  });

  it("returns an empty array when no node declares an llm config", () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      nodes: [{ id: "n1", type: "router" }],
      edges: [],
    };
    expect(collectFlowLlmConfigs(flow)).toEqual([]);
  });

  it("collects each distinct node-level llm config", () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      nodes: [
        { id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-4o" } },
        {
          id: "n2",
          type: "classifier",
          llm: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
        },
        { id: "n3", type: "router" },
      ],
      edges: [],
    };
    const configs = collectFlowLlmConfigs(flow);
    expect(configs).toHaveLength(2);
    expect(configs).toEqual([
      { provider: "openai", model: "gpt-4o" },
      { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
    ]);
  });

  it("includes image-inspection models in static policy evaluation", () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      nodes: [
        {
          id: "n1",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o" },
          config: {
            imageInspection: { llm: { provider: "google", model: "gemini-2.0-flash" } },
          },
        },
      ],
      edges: [],
    };
    expect(collectFlowLlmConfigs(flow).map((config) => config.model)).toEqual([
      "gpt-4o",
      "gemini-2.0-flash",
    ]);
  });

  it("deduplicates identical provider+model pairs", () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      nodes: [
        { id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-4o" } },
        { id: "n2", type: "llm", llm: { provider: "openai", model: "gpt-4o" } },
      ],
      edges: [],
    };
    expect(collectFlowLlmConfigs(flow)).toHaveLength(1);
  });

  it("treats the same model on different providers as distinct", () => {
    const flow: FlowDefinition = {
      id: "f1",
      name: "F1",
      nodes: [
        { id: "n1", type: "llm", llm: { provider: "openai", model: "gpt-4o" } },
        { id: "n2", type: "llm", llm: { provider: "azure", model: "gpt-4o" } },
      ],
      edges: [],
    };
    expect(collectFlowLlmConfigs(flow)).toHaveLength(2);
  });
});
