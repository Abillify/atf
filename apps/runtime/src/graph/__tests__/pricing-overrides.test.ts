// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { CostDetail, SpendRecorder } from "../../observability/cost.js";

const config: AppConfig = { port: 3000, flowsDir: "./fixtures", monitoringTransport: "sse", mcpServers: [], corsOrigins: ["*"], monitoringAuthRequired: false, logLevel: "error", maxToolSteps: 5, maxConcurrentExecutions: 50, defaultLlm: { provider: "bedrock", model: "fixture-model" } };
const flow: FlowDefinition = { id: "priced-fixture", name: "Priced fixture", pricing: { "bedrock/fixture-model": { prompt: 3, completion: 15 } }, nodes: [{ id: "llm", type: "llm", llm: { provider: "bedrock", model: "fixture-model" } }], edges: [] };

function model() {
  return new MockLanguageModelV3({ doStream: async () => ({ stream: new ReadableStream({ start(controller) { controller.enqueue({ type: "text-start", id: "1" }); controller.enqueue({ type: "text-delta", id: "1", delta: "ok" }); controller.enqueue({ type: "text-end", id: "1" }); controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1000, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 500, text: undefined, reasoning: undefined } } }); controller.close(); } }) }) as never });
}

describe("per-flow pricing overrides", () => {
  test("records a nonzero cost when a fixture flow is the only pricing source", async () => {
    const recorded: Array<{ usd: number; detail?: CostDetail }> = [];
    const registry: FlowRegistry = { get: (id) => id === flow.id ? flow : undefined, list: () => [flow] };
    const recorder: SpendRecorder = { record: (_tenant, usd, detail) => recorded.push({ usd, detail }) };
    const engine = createGraphEngine(config, { flowRegistry: registry, llmProviderFactory: () => model(), costTracker: recorder });
    await engine.executeFlow(flow.id, [{ role: "user", content: "hello" }], { ssoToken: "test", executionId: "test" }, async () => {}, async () => {});
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.usd).toBeCloseTo(0.0105, 6);
    expect(recorded[0]?.detail?.model).toBe("fixture-model");
  });
});
