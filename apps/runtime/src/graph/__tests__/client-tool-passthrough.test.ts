// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for OpenAI function-calling passthrough.
 *
 * Covers the pure helpers (buildClientTools, mapToolChoice), the assistant
 * tool_calls history round-trip in message-mapping, and the end-to-end engine
 * path: a caller-supplied tool the model "calls" is streamed back as a real
 * OpenAI `tool_calls` delta and is NEVER executed server-side.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { buildClientTools, mapToolChoice } from "../agent-tools.js";
import {
  chatMessageToBaseMessage,
  baseMessagesToModelMessages,
} from "../message-mapping.js";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk, OpenAITool } from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

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

const weatherTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildClientTools", () => {
  test("registers a tool under its verbatim name with no execute", () => {
    const { tools, keys } = buildClientTools([weatherTool]);
    expect(keys.has("get_weather")).toBe(true);
    expect(tools.get_weather).toBeDefined();
    // No execute callback → the SDK forwards the call to the client.
    expect(
      (tools.get_weather as { execute?: unknown }).execute,
    ).toBeUndefined();
  });

  test("skips malformed entries and invalid names", () => {
    const { keys } = buildClientTools([
      { type: "function", function: { name: "bad name!" } } as OpenAITool,
      { type: "other" } as unknown as OpenAITool,
      weatherTool,
    ]);
    expect(keys.has("get_weather")).toBe(true);
    expect(keys.size).toBe(1);
  });
});

describe("mapToolChoice", () => {
  test("passes through auto/none/required", () => {
    expect(mapToolChoice("auto")).toBe("auto");
    expect(mapToolChoice("none")).toBe("none");
    expect(mapToolChoice("required")).toBe("required");
  });

  test("maps a forced function to the AI SDK tool choice", () => {
    expect(
      mapToolChoice({ type: "function", function: { name: "get_weather" } }),
    ).toEqual({ type: "tool", toolName: "get_weather" });
  });

  test("returns undefined when absent", () => {
    expect(mapToolChoice(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Message history round-trip
// ---------------------------------------------------------------------------

describe("assistant tool_calls history round-trip", () => {
  test("preserves assistant tool_calls and pairs them with a tool result", () => {
    const assistant = chatMessageToBaseMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Berlin"}' },
        },
      ],
    });
    expect(assistant).toBeInstanceOf(AIMessage);
    const tc = (assistant as AIMessage).tool_calls;
    expect(tc?.[0]?.name).toBe("get_weather");
    expect(tc?.[0]?.args).toEqual({ city: "Berlin" });

    const toolResult = chatMessageToBaseMessage({
      role: "tool",
      content: '{"tempC":21}',
      tool_call_id: "call-1",
      name: "get_weather",
    });
    expect(toolResult).toBeInstanceOf(ToolMessage);

    // The pair must convert to provider-valid assistant(tool-call)+tool messages.
    const model = baseMessagesToModelMessages([assistant, toolResult]);
    const assistantMsg = at(model, 0);
    expect(assistantMsg.role).toBe("assistant");
    const parts = assistantMsg.content as Array<Record<string, unknown>>;
    const callPart = parts.find((p) => p.type === "tool-call");
    expect(callPart?.toolName).toBe("get_weather");
    expect(at(model, 1).role).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// End-to-end engine passthrough
// ---------------------------------------------------------------------------

/** Mock LLM that "calls" one or more tools, then finishes with reason tool-calls. */
function mockToolCallingLlm(
  calls: Array<{ toolCallId: string; toolName: string; input: string }>,
) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              for (const c of calls) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: c.toolCallId,
                  toolName: c.toolName,
                  input: c.input,
                });
              }
              controller.enqueue({
                type: "finish",
                finishReason: {
                  unified: "tool-calls" as const,
                  raw: "tool_calls",
                },
                usage: {
                  inputTokens: {
                    total: 7,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 3,
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

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

const secondTool: OpenAITool = {
  type: "function",
  function: {
    name: "get_time",
    description: "Get the current time in a timezone",
    parameters: {
      type: "object",
      properties: { tz: { type: "string" } },
    },
  },
};

describe("executeFlow — client tool-call passthrough", () => {
  const flow: FlowDefinition = {
    id: "bedrock-tools",
    name: "Passthrough",
    nodes: [{ id: "responder", type: "llm" }],
    edges: [],
  };

  test("streams a caller tool call back as an OpenAI tool_calls delta", async () => {
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    llmProviderFactory: mockToolCallingLlm([
        {
          toolCallId: "call-xyz",
          toolName: "get_weather",
          input: '{"city":"Berlin"}',
        },
      ]),
  });

    const ctx: RequestContext = {
      ssoToken: "a.b.c",
      executionId: "exec-tools-1",
      clientTools: [weatherTool],
      clientToolChoice: "auto",
    };

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "bedrock-tools",
      [{ role: "user", content: "weather in Berlin?" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );

    const toolCallChunks = chunks.filter(
      (c) =>
        c.choices[0]?.delta?.tool_calls &&
        c.choices[0].delta.tool_calls.length > 0,
    );
    expect(toolCallChunks.length).toBe(1);
    const delta = at(at(toolCallChunks, 0).choices, 0).delta;
    const call = at(delta.tool_calls ?? [], 0);
    expect(call.function.name).toBe("get_weather");
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "Berlin" });
    expect(call.index).toBe(0);
  });

  test("parallel tool calls get distinct, ordered indices", async () => {
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(flow),
    llmProviderFactory: mockToolCallingLlm([
        {
          toolCallId: "c1",
          toolName: "get_weather",
          input: '{"city":"Berlin"}',
        },
        { toolCallId: "c2", toolName: "get_time", input: '{"tz":"CET"}' },
      ]),
  });

    const ctx: RequestContext = {
      ssoToken: "a.b.c",
      executionId: "exec-tools-2",
      clientTools: [weatherTool, secondTool],
    };

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "bedrock-tools",
      [{ role: "user", content: "weather and time?" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );

    const calls = chunks
      .flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
      .filter(Boolean);
    expect(calls.length).toBe(2);
    const [call0, call1] = calls;
    if (call0 === undefined || call1 === undefined)
      throw new Error("expected two tool calls");
    expect(call0.index).toBe(0);
    expect(call0.function.name).toBe("get_weather");
    expect(call1.index).toBe(1);
    expect(call1.function.name).toBe("get_time");
  });
});
