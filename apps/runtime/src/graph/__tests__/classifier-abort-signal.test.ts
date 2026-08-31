// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression test: the `classifier` node handler must bind the flow's
 * execution-deadline signal (`ExecRuntime.signal`) into its generateText /
 * generateObject calls. Without it, a hung classifier call outlives the
 * engine's execution timeout — the graph moves on (or the request ends)
 * while the provider call, and its billed tokens, keep running.
 */
import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import { mkGenerateResult } from "./v3-mock-helpers.js";

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

function classifierFlow(): FlowDefinition {
  return {
    id: "c-flow",
    name: "Classifier",
    nodes: [
      {
        id: "route",
        type: "classifier",
        systemPrompt: "Classify the request.",
        classifierSchema: {
          schema: {
            type: "object",
            properties: { route: { type: "string" } },
            required: ["route"],
          },
          classKey: "route",
        },
      },
    ],
    edges: [],
  };
}

function singleNodeRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

describe("classifier node — execution-deadline signal propagation (regression)", () => {
  test("binds runtime.signal into the generateText call", async () => {
    let captured: { abortSignal?: AbortSignal } | undefined;
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(classifierFlow()),
      llmProviderFactory: () =>
        new MockLanguageModelV3({
          doGenerate: async (options: { abortSignal?: AbortSignal }) => {
            captured = options;
            return mkGenerateResult(
              JSON.stringify({ route: "default" }),
              5,
              5,
            ) as never;
          },
        }),
    });

    await engine.executeFlow(
      "c-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-c" },
      async () => {},
      async () => {},
    );

    expect(captured?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});
