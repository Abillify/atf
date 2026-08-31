// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Example test: registry registration for the `agent-harness` node type.
 *
 * Asserts that `defaultNodeHandlerRegistry` resolves `agent-harness` to a
 * factory that produces a `NodeHandler`, and that the registration declares
 * `emitsLifecycle: true`.
 *
 * Validates: Requirements 1.3, 1.4
 */

import { describe, test, expect } from "bun:test";
import { defaultNodeHandlerRegistry } from "../graph-engine.js";
import type { FlowNode } from "../../types/flow.js";

describe("agent-harness registry registration", () => {
  test("registry resolves 'agent-harness' to a registration (Req 1.3)", () => {
    const registration = defaultNodeHandlerRegistry.get("agent-harness");
    expect(registration).toBeDefined();
    if (registration === undefined) throw new Error("expected a registration");
    expect(registration.type).toBe("agent-harness");
  });

  test("registration has emitsLifecycle: true (Req 1.4)", () => {
    const registration = defaultNodeHandlerRegistry.get("agent-harness");
    expect(registration).toBeDefined();
    if (registration === undefined) throw new Error("expected a registration");
    expect(registration.emitsLifecycle).toBe(true);
  });

  test("factory produces a NodeHandler function (Req 1.3, 1.4)", () => {
    const registration = defaultNodeHandlerRegistry.get("agent-harness");
    expect(registration).toBeDefined();
    if (registration === undefined) throw new Error("expected a registration");

    // Build a minimal mock node and context with a nodeMap
    const mockNode: FlowNode = {
      id: "test-harness",
      type: "agent-harness",
      config: {
        allowlist: ["worker-1"],
      },
      llm: { provider: "openai", model: "gpt-4o" },
    } as unknown as FlowNode;

    const nodeMap = new Map<string, FlowNode>([
      ["worker-1", { id: "worker-1", type: "llm" } as unknown as FlowNode],
    ]);

    const handler = registration.factory(mockNode, { nodeMap });

    // The factory should return a function (the NodeHandler)
    expect(typeof handler).toBe("function");
  });
});
