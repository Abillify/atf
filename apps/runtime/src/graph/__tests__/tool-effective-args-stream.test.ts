// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Live-stream visibility of tool-call arguments.
 *
 * Operators complained that the live stream only ever showed
 * `{"argument_keys":[...]}` for tool calls. The key-only placeholder is a
 * pre-DLP measure for the RAW model output — but once the tool execution
 * derives the effective arguments (forced args + ref handles + egress DLP),
 * those are exactly what the tool received and may be surfaced everywhere the
 * tool RESULT is already shown. Verifies:
 *   1. The `🔧 Tool:` reasoning line carries the FULL key-value JSON once the
 *      effective args exist (and never the `argument_keys` placeholder).
 *   2. The owning node's `tool_calls` telemetry (dashboard Tool Calls
 *      accordion) reports the effective args_json, not the key list.
 *   3. The synthetic tool node's INPUT (prompt) shows the effective args.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import type {
  MonitoringServiceInterface,
  MonitoringClient,
} from "../../monitoring/monitoring-service.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";

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

function singleNodeRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

const mcp: McpWrapperService = {
  connect: async () => {},
  reconnect: async () => {},
  listTools: async () => ["datetime"],
  getFilteredToolSchema: async (_server: string, tool: string) => ({
    name: tool,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  }),
  refreshSchemaIfChanged: async () => false,
  callTool: async () => ({ content: "2026-01-01 10:00" }),
  getInstructions: () => undefined,
} as unknown as McpWrapperService;

const usage = (output: number) => ({
  inputTokens: {
    total: 7,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: undefined, reasoning: undefined },
});

/** Step 1 emits a tool call, step 2 the final text answer. */
function toolThenAnswerLlm() {
  let steps = 0;
  return () =>
    new MockLanguageModelV3({
      doStream: async () => {
        steps += 1;
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              if (steps === 1) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "call-eff-1",
                  toolName: "base__datetime",
                  input: '{"query":"Berlin"}',
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: {
                    unified: "tool-calls" as const,
                    raw: "tool_calls",
                  },
                  usage: usage(3),
                });
              } else {
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({
                  type: "text-delta",
                  id: "1",
                  delta: "Die Zeit ist 10:00.",
                });
                controller.enqueue({ type: "text-end", id: "1" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage: usage(5),
                });
              }
              controller.close();
            },
          }),
        } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
      },
    });
}

const flow: FlowDefinition = {
  id: "eff-args-flow",
  name: "Effective Args",
  nodes: [{ id: "llm-1", type: "llm", tools: ["base/datetime"] }],
  edges: [],
};

async function run() {
  const events: NodeExecutionEvent[] = [];
  const monitoring: MonitoringServiceInterface = {
    emitNodeEvent: (_id, event) => {
      events.push(event);
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

  const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(flow),
    mcpWrapper: mcp,
    llmProviderFactory: toolThenAnswerLlm(),
  });

  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "Wie spaet ist es in Berlin?" }],
    { ssoToken: "a.b.c", executionId: "exec-eff-args" },
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
    monitoring,
  );

  const reasoning = chunks
    .map(
      (chunk) =>
        (
          chunk.choices[0]?.delta as
            | { reasoning_content?: string }
            | undefined
        )?.reasoning_content,
    )
    .filter((text): text is string => typeof text === "string")
    .join("");

  return { events, reasoning };
}

describe("live stream — tool-call arguments show full key-value JSON", () => {
  test("the 🔧 Tool reasoning line carries the effective args, never argument_keys", async () => {
    const { reasoning } = await run();

    // Exactly one line carries the argument payload, with the REAL values the
    // tool was called with. (A second key-less `🔧 Tool: **name**` marker may
    // precede it; the name is the AI-SDK tool key or the `server/tool` ref,
    // depending on whether the tool execute raced the stream consumer.)
    const argLines = reasoning
      .split("\n")
      .filter((line) => line.includes("(arguments:"));
    expect(argLines).toHaveLength(1);
    expect(argLines[0]).toMatch(
      /^🔧 Tool: \*\*base(__|\/)datetime\*\* \(arguments: \{"query":"Berlin"\}\)$/,
    );
    // The key-only placeholder must not appear anywhere in the stream.
    expect(reasoning).not.toContain("argument_keys");
  });

  test("the owning node's tool_calls telemetry reports the effective args_json", async () => {
    const { events } = await run();

    const llmDone = events.find(
      (e) => e.node_id === "llm-1" && e.status === "completed",
    );
    expect(llmDone?.tool_calls).toBeDefined();
    expect(llmDone?.tool_calls?.[0]?.name).toBe("base__datetime");
    expect(llmDone?.tool_calls?.[0]?.args_json).toBe('{"query":"Berlin"}');
  });

  test("the synthetic tool node INPUT shows the effective args", async () => {
    const { events } = await run();

    const toolDone = events.find(
      (e) => e.kind === "tool" && e.status === "completed",
    );
    expect(toolDone?.prompt).toBe('{"query":"Berlin"}');
  });
});
