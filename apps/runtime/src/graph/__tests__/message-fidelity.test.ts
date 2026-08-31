// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-history fidelity tests.
 *
 * Verifies that assistant tool-call / tool-result pairs survive the conversion
 * between LangGraph state (LangChain BaseMessages) and the AI SDK CoreMessage
 * format, so an agent's tool reasoning is preserved across multiple LLM nodes
 * instead of being flattened to anonymous user text.
 */

import { describe, test, expect } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import {
  baseMessagesToModelMessages as baseMessagesToCoreMessages,
  aiResponseMessagesToBaseMessages,
  chatMessageToBaseMessage,
} from "../message-mapping.js";

describe("baseMessagesToCoreMessages — tool-call / tool-result fidelity", () => {
  test("AIMessage with tool_calls becomes an assistant message with tool-call parts (only with matching results)", () => {
    // A tool call without a matching result should be filtered out
    const aiWithoutResult = new AIMessage({
      content: "Let me look that up.",
      tool_calls: [{ id: "call-1", name: "search", args: { q: "weather" } }],
    });

    const msgWithoutResult = baseMessagesToCoreMessages([aiWithoutResult]);
    // The tool call should be filtered, leaving only the text content
    expect(msgWithoutResult.length).toBe(1);
    const firstMsg = msgWithoutResult[0];
    if (firstMsg === undefined) throw new Error("expected a first message");
    expect(firstMsg.role).toBe("assistant");
    const content = firstMsg.content;
    expect(typeof content).toBe("string");
    expect(content).toBe("Let me look that up.");

    // Now with a matching result - should keep the tool call
    const aiWithResult = new AIMessage({
      content: "Let me look that up.",
      tool_calls: [{ id: "call-1", name: "search", args: { q: "weather" } }],
    });
    const toolResult = new ToolMessage({
      content: '{"temp":21}',
      tool_call_id: "call-1",
      name: "search",
    });

    const [assistantMsg] = baseMessagesToCoreMessages([
      aiWithResult,
      toolResult,
    ]);
    if (assistantMsg === undefined) throw new Error("expected an assistant message");
    expect(assistantMsg.role).toBe("assistant");

    const parts = assistantMsg.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(parts)).toBe(true);
    const toolCall = parts.find((p) => p.type === "tool-call");
    expect(toolCall).toBeDefined();
    if (toolCall === undefined) throw new Error("expected a tool-call part");
    expect(toolCall.toolCallId).toBe("call-1");
    expect(toolCall.toolName).toBe("search");
    expect(toolCall.input).toEqual({ q: "weather" }); // ai@6.x: args → input
  });

  test("ToolMessage becomes a tool-role message with a matching tool-result part", () => {
    // Tool message needs a matching AI message with tool_calls
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "call-1", name: "search", args: {} }],
    });
    const tool = new ToolMessage({
      content: JSON.stringify({ temp: 21 }),
      tool_call_id: "call-1",
      name: "search",
    });

    const [, toolResultMsg] = baseMessagesToCoreMessages([ai, tool]);
    if (toolResultMsg === undefined) throw new Error("expected a tool result message");
    expect(toolResultMsg.role).toBe("tool");

    const parts = toolResultMsg.content as unknown as Array<
      Record<string, unknown>
    >;
    const result = parts[0];
    if (result === undefined) throw new Error("expected a first part");
    expect(result.type).toBe("tool-result");
    expect(result.toolCallId).toBe("call-1");
    expect(result.toolName).toBe("search");
    // ai@6.x: result → output: { type:"text", value: string }
    expect((result.output as { value: string }).value).toBe(
      JSON.stringify({ temp: 21 }),
    );
  });

  test("ToolMessage with JSON-serialized parts array becomes a tool-role message with parsed parts", () => {
    const rawParts = [
      {
        type: "tool-result",
        toolCallId: "call-xyz",
        toolName: "get_weather",
        output: { type: "text", value: "sunny" },
      },
    ];
    // Need a matching AI message with tool_calls
    const ai = new AIMessage({
      content: "",
      tool_calls: [{ id: "call-xyz", name: "get_weather", args: {} }],
    });
    const tool = new ToolMessage({
      content: JSON.stringify(rawParts),
      tool_call_id: "call-xyz",
      name: "get_weather",
    });

    const [, toolResultMsg] = baseMessagesToCoreMessages([ai, tool]);
    if (toolResultMsg === undefined) throw new Error("expected a tool result message");
    expect(toolResultMsg.role).toBe("tool");

    const parts = toolResultMsg.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBe(1);
    const firstPart = parts[0];
    if (firstPart === undefined) throw new Error("expected a first part");
    expect(firstPart.type).toBe("tool-result");
    expect(firstPart.toolCallId).toBe("call-xyz");
    expect(firstPart.toolName).toBe("get_weather");
    expect((firstPart.output as { value: string }).value).toBe("sunny");
  });

  test("assistant tool-call is immediately followed by its tool-result (provider-valid ordering)", () => {
    const history: BaseMessage[] = [
      new HumanMessage("What's the weather?"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "c1", name: "search", args: {} }],
      }),
      new ToolMessage({
        content: '{"temp":21}',
        tool_call_id: "c1",
        name: "search",
      }),
    ];

    const core = baseMessagesToCoreMessages(history);
    const assistantIdx = core.findIndex(
      (m: { role: string }) => m.role === "assistant",
    );
    const toolIdx = core.findIndex((m: { role: string }) => m.role === "tool");

    // The tool message must come directly after the assistant tool-call.
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBe(assistantIdx + 1);
  });

  test("plain assistant text (no tool_calls) stays a simple string message", () => {
    const [msg] = baseMessagesToCoreMessages([new AIMessage("Hello world")]);
    if (msg === undefined) throw new Error("expected a message");
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Hello world");
  });
});

describe("aiResponseMessagesToBaseMessages — AI SDK → LangChain", () => {
  test("reconstructs assistant tool_calls and tool results from SDK response messages", () => {
    const sdkMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking it up" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "search",
            input: { q: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "search",
            output: { type: "text", value: JSON.stringify({ hit: true }) },
          },
        ],
      },
    ];

    const lc = aiResponseMessagesToBaseMessages(sdkMessages);
    expect(lc).toBeDefined();
    if (lc === undefined) throw new Error("expected lc to be defined");
    expect(lc.length).toBe(2);

    const ai = lc[0] as AIMessage;
    expect(ai._getType()).toBe("ai");
    expect(ai.tool_calls?.[0]?.id).toBe("c1");
    expect(ai.tool_calls?.[0]?.name).toBe("search");

    const toolMsg = lc[1] as ToolMessage;
    expect(toolMsg._getType()).toBe("tool");
    expect(toolMsg.tool_call_id).toBe("c1");
  });

  test("round-trips SDK response → LangChain → CoreMessages preserving the call id", () => {
    const sdkMessages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "abc",
            toolName: "fetch",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "abc",
            toolName: "fetch",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];

    const lc = aiResponseMessagesToBaseMessages(sdkMessages);
    if (lc === undefined) throw new Error("expected lc to be defined");
    const core = baseMessagesToCoreMessages(lc);

    const assistant = core.find(
      (m: { role: string }) => m.role === "assistant",
    );
    if (assistant === undefined) throw new Error("expected an assistant message");
    const toolCallPart = (
      assistant.content as unknown as Array<Record<string, unknown>>
    ).find((p) => p.type === "tool-call");
    if (toolCallPart === undefined) throw new Error("expected a tool-call part");
    expect(toolCallPart.toolCallId).toBe("abc");

    const toolMsg = core.find((m: { role: string }) => m.role === "tool");
    if (toolMsg === undefined) throw new Error("expected a tool message");
    const resultPart = (
      toolMsg.content as unknown as Array<Record<string, unknown>>
    )[0];
    if (resultPart === undefined) throw new Error("expected a first result part");
    expect(resultPart.toolCallId).toBe("abc");
  });

  test("returns undefined when there are no usable messages", () => {
    expect(aiResponseMessagesToBaseMessages([])).toBeUndefined();
    expect(
      aiResponseMessagesToBaseMessages([{ role: "system", content: "x" }]),
    ).toBeUndefined();
  });
});

describe("chatMessageToBaseMessage", () => {
  test("correctly preserves tool_call_id and name fields for tool messages", () => {
    const inputMessage = {
      role: "tool" as const,
      content: "some result",
      tool_call_id: "call-999",
      name: "my_custom_tool",
    };

    const baseMessage = chatMessageToBaseMessage(inputMessage);
    expect(baseMessage).toBeInstanceOf(ToolMessage);
    const toolMsg = baseMessage as ToolMessage;
    expect(toolMsg.tool_call_id).toBe("call-999");
    expect(toolMsg.name).toBe("my_custom_tool");
    expect(toolMsg.content).toBe("some result");
  });
});

describe("baseMessagesToCoreMessages — orphaned tool call/result filtering", () => {
  test("filters out tool results without matching tool calls", () => {
    const history: BaseMessage[] = [
      new HumanMessage("What's the weather?"),
      // Missing AIMessage with tool_calls
      new ToolMessage({
        content: '{"temp":21}',
        tool_call_id: "orphan",
        name: "search",
      }),
    ];

    const core = baseMessagesToCoreMessages(history);

    // The orphaned tool message should be filtered out
    const toolMsg = core.find((m: { role: string }) => m.role === "tool");
    expect(toolMsg).toBeUndefined();
  });

  test("filters out tool calls without matching tool results", () => {
    const history: BaseMessage[] = [
      new HumanMessage("What's the weather?"),
      new AIMessage({
        content: "Looking it up",
        tool_calls: [{ id: "orphan", name: "search", args: { q: "weather" } }],
      }),
      // Missing ToolMessage for "orphan"
      new AIMessage("I couldn't find that."),
    ];

    const core = baseMessagesToCoreMessages(history);

    // The assistant message should still be there, but without tool_calls
    const assistantMsg = core.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    if (assistantMsg === undefined) throw new Error("expected an assistant message");

    // Check if tool calls were removed
    const parts = assistantMsg.content;
    if (Array.isArray(parts)) {
      const toolCallPart = parts.find(
        (p: { type?: string }) => p.type === "tool-call",
      );
      expect(toolCallPart).toBeUndefined();
    } else {
      // It should be converted to a simple text message
      expect(typeof parts).toBe("string");
    }
  });

  test("keeps complete tool call/result pairs", () => {
    const history: BaseMessage[] = [
      new HumanMessage("What's the weather?"),
      new AIMessage({
        content: "Looking it up",
        tool_calls: [{ id: "call-1", name: "search", args: { q: "weather" } }],
      }),
      new ToolMessage({
        content: '{"temp":21}',
        tool_call_id: "call-1",
        name: "search",
      }),
    ];

    const core = baseMessagesToCoreMessages(history);

    // Both the assistant with tool_calls and the tool result should be present
    const assistantMsg = core.find(
      (m: { role: string }) => m.role === "assistant",
    );
    const toolMsg = core.find((m: { role: string }) => m.role === "tool");

    expect(assistantMsg).toBeDefined();
    expect(toolMsg).toBeDefined();
    if (assistantMsg === undefined) throw new Error("expected an assistant message");

    // Check that the tool call is still present
    const parts = assistantMsg.content as unknown as Array<
      Record<string, unknown>
    >;
    const toolCallPart = parts.find((p) => p.type === "tool-call");
    expect(toolCallPart).toBeDefined();
    if (toolCallPart === undefined) throw new Error("expected a tool-call part");
    expect(toolCallPart.toolCallId).toBe("call-1");
  });

  test("filters multiple orphaned calls and keeps valid pairs", () => {
    const history: BaseMessage[] = [
      new HumanMessage("Do multiple things"),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call-1", name: "search", args: {} },
          { id: "call-2", name: "fetch", args: {} },
          { id: "call-3", name: "calc", args: {} },
        ],
      }),
      // Only call-1 and call-3 have results
      new ToolMessage({
        content: "result1",
        tool_call_id: "call-1",
        name: "search",
      }),
      new ToolMessage({
        content: "result3",
        tool_call_id: "call-3",
        name: "calc",
      }),
    ];

    const core = baseMessagesToCoreMessages(history);

    const assistantMsg = core.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    if (assistantMsg === undefined) throw new Error("expected an assistant message");

    // Should only have call-1 and call-3 in tool_calls
    const parts = assistantMsg.content as unknown as Array<
      Record<string, unknown>
    >;
    const toolCallParts = parts.filter((p) => p.type === "tool-call");
    expect(toolCallParts.length).toBe(2);

    const callIds = toolCallParts.map((p) => p.toolCallId);
    expect(callIds).toContain("call-1");
    expect(callIds).toContain("call-3");
    expect(callIds).not.toContain("call-2"); // orphaned call should be filtered

    // Should have 2 tool result messages
    const toolMsgs = core.filter((m: { role: string }) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
  });

  test("passes through messages unchanged when there are no tool calls at all", () => {
    const history: BaseMessage[] = [
      new HumanMessage("Hello"),
      new AIMessage("Hi there"),
      new HumanMessage("How are you?"),
    ];

    const core = baseMessagesToCoreMessages(history);
    expect(core.length).toBe(3);
  });
});
