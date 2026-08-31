// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * End-to-end test: the per-request BYOK provider key reaches the LLM factory
 * via executeFlow → ExecRuntime → llmProviderFactory(resolution).
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine, type ProviderResolution } from "../graph-engine.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk, TokenUsage } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";

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
  defaultLlm: {
    provider: "openai",
    model: "gpt-4o-mini",
    parameters: { temperature: 0 },
  },
};

const flow: FlowDefinition = {
  id: "byok-flow",
  name: "BYOK flow",
  nodes: [{ id: "answer", type: "llm" }],
  edges: [],
};

function registry(f: FlowDefinition) {
  return {
    get: (id: string) => (id === f.id ? f : undefined),
    list: () => [f],
  };
}

function ctx(overrides?: Partial<Record<string, string>>): RequestContext {
  return {
    ssoToken: "t",
    executionId: crypto.randomUUID(),
    clientId: "acme",
    ...(overrides !== undefined ? { providerKeyOverrides: overrides } : {}),
  };
}

async function runWith(
  overrides?: Partial<Record<string, string>>,
): Promise<ProviderResolution[]> {
  const seen: ProviderResolution[] = [];
  const factory = (
    _c: unknown,
    _a: unknown,
    resolution?: ProviderResolution,
  ) => {
    seen.push(resolution ?? {});
    return new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(c: ReadableStreamDefaultController<unknown>) {
              c.enqueue({ type: "text-start", id: "1" });
              c.enqueue({ type: "text-delta", id: "1", delta: "ok" });
              c.enqueue({ type: "text-end", id: "1" });
              c.enqueue({
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
              c.close();
            },
          }),
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
  };

  const engine = createGraphEngine(baseConfig, { flowRegistry: registry(flow), llmProviderFactory: factory as never });
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "hi" }],
    ctx(overrides),
    async (chunk: ChatCompletionChunk) => {
      chunks.push(chunk);
    },
    async (_usage: TokenUsage) => {},
  );
  return seen;
}

describe("BYOK passthrough to the LLM factory", () => {
  test("forwards the tenant's provider key override to the factory", async () => {
    const seen = await runWith({ openai: "sk-byok-tenant" });
    expect(seen.length).toBeGreaterThan(0);
    const first = seen[0];
    if (first === undefined) throw new Error("expected a seen config");
    expect(first.providerKeyOverrides).toEqual({ openai: "sk-byok-tenant" });
  });

  test("passes no override when the tenant has no BYOK key", async () => {
    const seen = await runWith(undefined);
    expect(seen.length).toBeGreaterThan(0);
    const first = seen[0];
    if (first === undefined) throw new Error("expected a seen config");
    expect(first.providerKeyOverrides).toBeUndefined();
  });
});
