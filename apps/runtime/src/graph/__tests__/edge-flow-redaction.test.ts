// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 7.12 — Edge-Data-Flow traces must respect PII redaction and tokenization.
 *
 * Integration-level: run the real engine with the output guardrail enabled and
 * a debug-trace store attached, then inspect the stored `edge_flows`. The
 * trace is a persisted copy of what crossed each edge; while output redaction
 * is active it must not contain raw PII — even though the graph state itself
 * carries the raw values (the guardrail scrubs the SSE stream, not the state,
 * and the PII vault — when enabled — tokenizes the state before the engine
 * even runs, in which case the placeholders pass through untouched).
 */

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import { createOutputGuardrail } from "../output-guardrails.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { EdgeFlowItem } from "../../types/edge-flow.js";

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

const flow: FlowDefinition = {
  id: "edge-redaction-flow",
  name: "Edge redaction",
  nodes: [{ id: "llm-1", type: "llm" }],
  edges: [],
};

const registry: FlowRegistry = {
  get: (id) => (id === flow.id ? flow : undefined),
  list: () => [flow],
};

const usage = {
  inputTokens: {
    total: 7,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

function mockLlmFactory(tokens: string[]) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "text-start", id: "1" });
              for (const t of tokens)
                controller.enqueue({ type: "text-delta", id: "1", delta: t });
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage,
              });
              controller.close();
            },
          }),
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
}

const EMAIL = "jane.doe@example.com";

async function runAndCollectEdgeFlows(
  withGuardrail: boolean,
): Promise<EdgeFlowItem[]> {
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry,
    llmProviderFactory: mockLlmFactory([`Antwort mit ${EMAIL} darin. `]),
    ...(withGuardrail
      ? { outputGuardrail: createOutputGuardrail({ enabled: true, redactPii: true }) }
      : {}),
  });
  const debugStore = new InMemoryDebugTraceStore();
  engine.setDebugStore?.(debugStore);
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: `Schreib an ${EMAIL}` }],
    { ssoToken: "a.b.c", executionId: `exec-edge-redaction-${withGuardrail}` },
    async (_chunk: ChatCompletionChunk) => {},
    async () => {},
  );
  const trace = debugStore.getTrace(`exec-edge-redaction-${withGuardrail}`);
  expect(trace).toBeDefined();
  const flows = trace?.edge_flows ?? [];
  expect(flows.length).toBeGreaterThan(0);
  return flows.flatMap((r) => r.items);
}

describe("edge data-flow trace — redaction (Req 7.12)", () => {
  test("guardrail enabled: stored edge items contain no raw PII", async () => {
    const items = await runAndCollectEdgeFlows(true);
    // The run must actually have produced content items (query + answer),
    // otherwise the assertion below would pass vacuously.
    const withContent = items.filter((i) => i.content !== undefined);
    expect(withContent.length).toBeGreaterThan(0);
    for (const item of withContent) {
      expect(item.content).not.toContain(EMAIL);
    }
    // And the redaction actually happened — placeholders present.
    expect(withContent.some((i) => i.content?.includes("[REDACTED_EMAIL]"))).toBe(
      true,
    );
  });

  test("guardrail disabled: trace keeps the raw content (passthrough)", async () => {
    const items = await runAndCollectEdgeFlows(false);
    const query = items.find((i) => i.label === "Query");
    expect(query?.content).toContain(EMAIL);
  });
});
