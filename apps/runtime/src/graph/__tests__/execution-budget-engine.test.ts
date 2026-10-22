// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Flow `budgets` through the real graph engine and a multi-step tool loop.
 *
 * The tool-call budget is enforced inside the model's tool `execute`; the AI
 * SDK turns a throw there into a tool-error result, so without explicit
 * propagation the loop would go on and the model would simply read the error.
 * The token budget must hold per model STEP of one call, not only per
 * attempt. Both end the execution with `finish_reason: "budget_exceeded"`
 * instead of an error.
 */
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 8,
  maxConcurrentExecutions: 50,
  llmRetryBackoffMs: 0,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

/** 10 tokens per model step. */
const usage = {
  inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
};

function fakeMcp(calls: string[]): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["lookup"],
    getFilteredToolSchema: async (_server: string, tool: string) => ({
      name: tool,
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async (_server: string, tool: string) => {
      calls.push(tool);
      return { content: [{ type: "text", text: JSON.stringify({ hits: calls.length }) }] };
    },
    getInstructions: () => undefined,
  } as unknown as McpWrapperService;
}

/** A model that asks for one more lookup on every step. */
function loopingModel(steps: { count: number }) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () => {
        steps.count += 1;
        const call = steps.count;
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "text-start", id: `t${call}` });
              controller.enqueue({ type: "text-delta", id: `t${call}`, delta: `Schritt ${call}. ` });
              controller.enqueue({ type: "text-end", id: `t${call}` });
              controller.enqueue({
                type: "tool-call",
                toolCallId: `c${call}`,
                toolName: "kb__lookup",
                input: JSON.stringify({ q: `frage ${call}` }),
              });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                usage,
              });
              controller.close();
            },
          }),
        } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
      },
    });
}

async function run(budgets: FlowDefinition["budgets"]) {
  const flow: FlowDefinition = {
    id: "budget-flow",
    name: "Budget",
    budgets,
    nodes: [{ id: "researcher", type: "llm", tools: ["kb/lookup"] }],
    edges: [],
  };
  const registry: FlowRegistry = {
    get: (id) => (id === flow.id ? flow : undefined),
    list: () => [flow],
  };
  const mcpCalls: string[] = [];
  const steps = { count: 0 };
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry,
    mcpWrapper: fakeMcp(mcpCalls),
    llmProviderFactory: loopingModel(steps),
  });
  const debug = new InMemoryDebugTraceStore();
  engine.setDebugStore?.(debug);
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "Recherchiere bitte." }],
    { ssoToken: "a.b.c", executionId: `exec-budget-${Object.keys(budgets ?? {}).join("-")}` },
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
  );
  const finishReasons = chunks
    .map((chunk) => chunk.choices[0]?.finish_reason)
    .filter((reason) => reason !== null && reason !== undefined);
  const errors = chunks.filter((chunk) => (chunk as { error?: unknown }).error !== undefined);
  const content = chunks
    .map((chunk) => chunk.choices[0]?.delta.content)
    .filter((text): text is string => typeof text === "string")
    .join("");
  return { mcpCalls, steps, finishReasons, errors, content };
}

describe("execution budgets · engine", () => {
  test("maxToolCalls: 2 runs two tools, never the third, and ends with budget_exceeded", async () => {
    const r = await run({ maxToolCalls: 2 });
    expect(r.mcpCalls).toEqual(["lookup", "lookup"]);
    expect(r.finishReasons).toContain("budget_exceeded");
    expect(r.errors).toEqual([]);
    // The text produced so far is kept.
    expect(r.content).toContain("Schritt 1.");
  });

  test("maxTokens stops the tool loop before the next model step, not only before the attempt", async () => {
    // 10 tokens per step: step 1 (0 used) and step 2 (10 used) run; before
    // step 3, 20 tokens are used, which reaches the limit of 15.
    const r = await run({ maxTokens: 15 });
    expect(r.steps.count).toBe(2);
    expect(r.finishReasons).toContain("budget_exceeded");
    expect(r.errors).toEqual([]);
  });

  test("without budgets the loop runs until the tool-step limit", async () => {
    const r = await run(undefined);
    expect(r.steps.count).toBeGreaterThan(3);
    expect(r.finishReasons).not.toContain("budget_exceeded");
  });
});
