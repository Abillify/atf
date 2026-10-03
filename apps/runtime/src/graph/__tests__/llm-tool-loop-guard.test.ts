// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression tests for the opt-in `config.toolLoopGuard` on LLM nodes.
 *
 * Live trace (a production flow): an unanswerable question drove the responder
 * through 18 tool calls / 863k prompt tokens — the model re-issued near-identical
 * searches until `maxToolSteps`. `tool-loop-detection.ts` existed but was never
 * wired into the execution path. The guard now wraps `executeToolCall`:
 * repeated identical calls get ONE model-visible warning, then the call is
 * refused (`tool_loop_blocked`) without reaching MCP. Off by default.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { RequestContext } from "../../types/monitoring.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 10,
  maxConcurrentExecutions: 50,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

const ctx: RequestContext = { ssoToken: "a.b.c", executionId: "exec-loop" };

function mcpCountingCalls(
  calls: Array<Record<string, unknown>>,
): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["search"],
    getFilteredToolSchema: async (_server: string, tool: string) => ({
      name: tool,
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async (
      _server: string,
      _tool: string,
      args: Record<string, unknown>,
    ) => {
      calls.push(args);
      return { content: "Treffer: keine neuen Ergebnisse." };
    },
    getInstructions: () => undefined,
  } as unknown as McpWrapperService;
}

/**
 * A model stuck in a loop: every step re-issues the SAME search call until
 * the engine stops it. Every prompt it sees is appended to `prompts` so the
 * test can inspect the tool results fed back to the model.
 */
function stuckModelFactory(
  prompts: Array<Array<{ role: string; content: unknown }>>,
) {
  let steps = 0;
  return () =>
    new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        // Unique per step: the AI SDK rejects duplicate tool-call ids in one
        // conversation, and the pool may reuse this instance across steps.
        steps += 1;
        const step = steps;
        const messages = prompt as Array<{ role: string; content: unknown }>;
        prompts.push(messages);
        // Once the guard has refused the call, the model "gives up" and
        // answers — the run ends cleanly instead of burning pool candidates.
        const blocked = JSON.stringify(messages).includes("loop_blocked");
        const usage = {
          inputTokens: {
            total: 100,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: 5,
            text: undefined,
            reasoning: undefined,
          },
        };
        if (blocked) {
          return {
            stream: new ReadableStream({
              start(controller: ReadableStreamDefaultController<unknown>) {
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({
                  type: "text-delta",
                  id: "1",
                  delta: "Ich habe die Suche eingestellt.",
                });
                controller.enqueue({ type: "text-end", id: "1" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage,
                });
                controller.close();
              },
            }),
          } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
        }
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: `c${step}`,
                toolName: "vectorsearch__search",
                input: '{"query":"richtlinie reisekosten"}',
              });
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: "tool-calls" as const,
                  raw: "tool_calls",
                },
                usage: {
                  inputTokens: {
                    total: 100,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 5,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
              controller.close();
            },
          }),
        } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
      },
    });
}

function loopFlow(nodeConfig: Record<string, unknown>): FlowDefinition {
  return {
    id: "loop-guard-flow",
    name: "Loop Guard",
    nodes: [
      {
        id: "responder",
        type: "llm",
        tools: ["vectorsearch/search"],
        config: nodeConfig,
      },
    ],
    edges: [],
  };
}

async function runStuckLoop(
  flow: FlowDefinition,
  mcpCalls: Array<Record<string, unknown>>,
  prompts: Array<Array<{ role: string; content: unknown }>>,
): Promise<void> {
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    mcpWrapper: mcpCountingCalls(mcpCalls),
    llmProviderFactory: stuckModelFactory(prompts) as never,
  });
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "Was steht in der Reisekostenrichtlinie?" }],
    ctx,
    async () => {},
    async () => {},
  );
}

describe("toolLoopGuard (llm node, opt-in)", () => {
  test("identical repeats: warns once, then refuses the call without hitting MCP", async () => {
    const mcpCalls: Array<Record<string, unknown>> = [];
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    // identicalWarnAt 2 → the 2nd identical call carries the model-visible
    // warning; identicalBlockAt 4 → the 4th is refused and never reaches MCP.
    // maxToolSteps 5 lets the model see the refusal in one more prompt.
    await runStuckLoop(
      loopFlow({
        toolLoopGuard: { identicalWarnAt: 2, identicalBlockAt: 4 },
        maxToolSteps: 5,
      }),
      mcpCalls,
      prompts,
    );

    // Call 1 executed against MCP; calls 2–3 were served from the result memo
    // (identical arguments, read-only tool — the guard still COUNTS them, so
    // the block threshold is unaffected); call 4 was refused and never ran.
    expect(mcpCalls.length).toBe(1);

    const lastPrompt = JSON.stringify(prompts.at(-1) ?? []);
    // The refusal is model-visible — as a readable `loop_blocked` result, NOT
    // an error envelope (those are anonymised to "Tool execution failed."
    // before reaching the prompt, which would erase the signal).
    expect(lastPrompt).toContain("loop_blocked");
    expect(lastPrompt).not.toContain("Tool execution failed");
    // The warning appears exactly once in the tool history: only the 2nd
    // call's result is wrapped in `loop_warning` (the 3rd verdict reuses the
    // already-emitted warning key and falls through to a plain result).
    const warningCount = lastPrompt.split("loop_warning").length - 1;
    expect(warningCount).toBe(1);
  });

  test("guard disabled by default: every identical call reaches MCP", async () => {
    const mcpCalls: Array<Record<string, unknown>> = [];
    await runStuckLoop(loopFlow({ maxToolSteps: 4 }), mcpCalls, []);
    // Every step runs to the step budget — nothing is refused.
    expect(mcpCalls.length).toBeGreaterThanOrEqual(4);
  });
});
