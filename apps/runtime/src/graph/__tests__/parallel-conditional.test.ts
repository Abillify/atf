// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for conditional `parallelNodes` children.
 *
 * A `parallel` node may list children as either a plain ID string (always
 * runs) or `{ node, condition }` where the child runs only when the condition
 * (same grammar as edge conditions) evaluates true against the run state. This
 * lets one parallel node fan out an optional source (e.g. a vision extraction
 * gated on `classification.hasAttachment == true`) instead of duplicating the
 * whole node for the with/without variants.
 *
 * Covered:
 *   - the `parallelChildId` / `parallelChildCondition` helpers,
 *   - the structured validator (valid + invalid child condition),
 *   - the live engine: a false condition skips the child, a true one runs it.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { parallelChildId, parallelChildCondition } from "../../types/flow.js";
import type { FlowDefinition } from "../../types/flow.js";
import { validateFlow } from "../flow-validator.js";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import type {
  MonitoringServiceInterface,
  MonitoringClient,
} from "../../monitoring/monitoring-service.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

function mockLlmFactory(token: string) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "text-start", id: "1" });
              controller.enqueue({ type: "text-delta", id: "1", delta: token });
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 1,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
              controller.close();
            },
          }),
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
}

/** Runs a flow and returns the node IDs that emitted a `running` event. */
async function runAndCollectStartedNodes(
  flow: FlowDefinition,
): Promise<string[]> {
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    llmProviderFactory: mockLlmFactory("ok"),
  });

  const events: NodeExecutionEvent[] = [];
  const monitoring: MonitoringServiceInterface = {
    emitNodeEvent: (_id, e) => {
      events.push(e);
    },
    subscribe: (_c: MonitoringClient) => () => {},
    hasConnectionCapacity: () => true,
    getConnectionCount: () => 0,
    getTransportType: () => "sse",
    getHistory: async () => [],
    getHistoryPage: async () => ({ executions: [], total: 0 }),
    getHistoryFacets: async () => ({ flows: [], users: [] }),
    getUsageLog: async () => [],
    getExecutionEvents: async () => [],
    clearHistory: async () => 0,
  };

  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "hi" }],
    { ssoToken: "a.b.c", executionId: `exec-${flow.id}` },
    async (c) => {
      chunks.push(c);
    },
    async () => {},
    monitoring,
  );

  return events.filter((e) => e.status === "running").map((e) => e.node_id);
}

/** Builds a flow whose entry `parallel` node has one always-on and one gated child. */
function flowWithGatedChild(id: string, condition: string): FlowDefinition {
  return {
    id,
    name: id,
    nodes: [
      {
        id: "ctx",
        type: "parallel",
        parallelNodes: ["child-always", { node: "child-gated", condition }],
      },
      { id: "child-always", type: "llm" },
      { id: "child-gated", type: "llm" },
      { id: "responder", type: "llm" },
    ],
    edges: [{ source: "ctx", target: "responder" }],
  };
}

describe("parallelChild helpers", () => {
  test("parallelChildId reads the id from string and object entries", () => {
    expect(parallelChildId("vision-extract")).toBe("vision-extract");
    expect(parallelChildId({ node: "vision-extract" })).toBe("vision-extract");
    expect(
      parallelChildId({ node: "vision-extract", condition: "x == true" }),
    ).toBe("vision-extract");
  });

  test("parallelChildCondition is undefined for plain strings, set for objects", () => {
    expect(parallelChildCondition("vision-extract")).toBeUndefined();
    expect(parallelChildCondition({ node: "vision-extract" })).toBeUndefined();
    expect(
      parallelChildCondition({
        node: "vision-extract",
        condition: "classification.hasAttachment == true",
      }),
    ).toBe("classification.hasAttachment == true");
  });
});

describe("validateFlow — conditional parallel children", () => {
  test("accepts a conditional child referencing a known node", () => {
    const report = validateFlow(
      flowWithGatedChild("v-ok", "messageCount >= 1"),
    );
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test("rejects a child whose condition is grammatically invalid", () => {
    const report = validateFlow(
      flowWithGatedChild("v-bad", "messageCount >= && true"),
    );
    expect(report.valid).toBe(false);
    expect(
      report.errors.some((e) => e.message.includes("invalid condition")),
    ).toBe(true);
  });

  test("rejects a conditional child referencing an unknown node", () => {
    const flow: FlowDefinition = {
      id: "v-unknown",
      name: "v-unknown",
      nodes: [
        {
          id: "ctx",
          type: "parallel",
          parallelNodes: [{ node: "does-not-exist", condition: "true" }],
        },
        { id: "responder", type: "llm" },
      ],
      edges: [{ source: "ctx", target: "responder" }],
    };
    const report = validateFlow(flow);
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => e.message.includes("unknown child"))).toBe(
      true,
    );
  });
});

describe("executeFlow — conditional parallel children", () => {
  test("skips the gated child when its condition is false", async () => {
    const started = await runAndCollectStartedNodes(
      flowWithGatedChild("par-false", "messageCount >= 100"),
    );
    expect(started).toContain("child-always");
    expect(started).toContain("responder");
    expect(started).not.toContain("child-gated");
  });

  test("runs the gated child when its condition is true", async () => {
    const started = await runAndCollectStartedNodes(
      flowWithGatedChild("par-true", "messageCount >= 1"),
    );
    expect(started).toContain("child-always");
    expect(started).toContain("child-gated");
    expect(started).toContain("responder");
  });

  test("a plain-string child always runs (no condition)", async () => {
    const flow: FlowDefinition = {
      id: "par-plain",
      name: "par-plain",
      nodes: [
        {
          id: "ctx",
          type: "parallel",
          parallelNodes: ["child-always"],
        },
        { id: "child-always", type: "llm" },
        { id: "responder", type: "llm" },
      ],
      edges: [{ source: "ctx", target: "responder" }],
    };
    const started = await runAndCollectStartedNodes(flow);
    expect(started).toContain("child-always");
  });
});
