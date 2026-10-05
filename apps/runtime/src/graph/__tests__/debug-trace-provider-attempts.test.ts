// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Debug-trace field `provider_attempts`: the node-level `attempt` counts graph
 * attempts only, so provider retries inside one node attempt are summarised
 * separately from the `llm_provider_attempt_completed` diagnostics.
 */

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { DebugNodeDiagnostic } from "../../types/debug-trace.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import { providerAttemptsSummary } from "../graph-engine/handler-factories.js";

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
  llmRetryBackoffMs: 0,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

const flow: FlowDefinition = {
  id: "provider-attempts-flow",
  name: "Provider attempts",
  nodes: [{ id: "llm-1", type: "llm" }],
  edges: [],
};

const usage = {
  inputTokens: {
    total: 7,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
};

/** Call 1 streams reasoning only (→ retry), call 2 answers. */
function retryingFactory(counter: { calls: number }) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () => {
        counter.calls += 1;
        const first = counter.calls === 1;
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              if (first) {
                controller.enqueue({ type: "reasoning-start", id: "r" });
                controller.enqueue({
                  type: "reasoning-delta",
                  id: "r",
                  delta: "Ich denke nach, antworte aber nicht.",
                });
                controller.enqueue({ type: "reasoning-end", id: "r" });
              } else {
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: "Antwort" });
                controller.enqueue({ type: "text-end", id: "t" });
              }
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage,
              });
              controller.close();
            },
          }),
        } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
      },
    });
}

describe("debug trace — provider_attempts", () => {
  test("provider retry inside one node attempt is summarised; attempt stays 1", async () => {
    const counter = { calls: 0 };
    const map = new Map([[flow.id, flow]]);
    const registry: FlowRegistry = {
      get: (id) => map.get(id),
      list: () => [...map.values()],
    };
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: registry,
      llmProviderFactory: retryingFactory(counter),
    });
    const debugStore = new InMemoryDebugTraceStore();
    engine.setDebugStore?.(debugStore);
    let content = "";
    await engine.executeFlow(
      flow.id,
      [{ role: "user", content: "hallo" }],
      { ssoToken: "a.b.c", executionId: "exec-provider-attempts" },
      async (chunk) => {
        const delta = chunk.choices[0]?.delta.content;
        if (typeof delta === "string") content += delta;
      },
      async () => {},
    );

    expect(counter.calls).toBe(2);
    expect(content).toBe("Antwort");
    const node = debugStore
      .getTrace("exec-provider-attempts")
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect(node?.status).toBe("completed");
    expect(node?.attempt).toBe(1);
    expect(node?.provider_attempts).toEqual({
      total: 2,
      failed: 1,
      final_attempt: 2,
      final_outcome: "ok",
    });
  });
});

describe("providerAttemptsSummary", () => {
  const diag = (
    code: string,
    details?: Record<string, unknown>,
  ): DebugNodeDiagnostic => ({
    at: "2026-01-01T00:00:00.000Z",
    level: "info",
    code,
    message: code,
    ...(details !== undefined ? { details } : {}),
  });

  test("absent without completed provider attempts", () => {
    expect(providerAttemptsSummary(undefined)).toBeUndefined();
    expect(
      providerAttemptsSummary([diag("llm_provider_attempt_started", { attempt: 1 })]),
    ).toBeUndefined();
  });

  test("final attempt failing on a fallback candidate", () => {
    expect(
      providerAttemptsSummary([
        diag("llm_provider_attempt_completed", { attempt: 1, outcome: "error" }),
        diag("retry"),
        diag("llm_provider_attempt_completed", { attempt: 2, outcome: "error" }),
        diag("llm_provider_attempt_completed", { attempt: 1, outcome: "error" }),
      ]),
    ).toEqual({
      provider_attempts: {
        total: 3,
        failed: 3,
        final_attempt: 1,
        final_outcome: "error",
      },
    });
  });
});
