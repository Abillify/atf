// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AWS Bedrock conversation validation tests.
 *
 * Bedrock has strict requirements about conversation structure:
 * - Cannot start with an assistant message containing tool-calls
 * - Every tool-call must have a corresponding tool-result
 * - Every tool-result must have a corresponding tool-call
 *
 * These tests verify that the validation functions ensure Bedrock-compatible
 * message lists.
 */

import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { ensureValidConversationStart } from "../exec-runtime.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

describe("ensureValidConversationStart — Bedrock validation", () => {
  test("allows conversation starting with system message", () => {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: "You are a helpful assistant",
      } as ModelMessage,
      { role: "user", content: "Hello" } as ModelMessage,
    ];

    const result = ensureValidConversationStart(messages);
    expect(result.length).toBe(2);
    expect(at(result, 0).role).toBe("system");
  });

  test("allows conversation starting with user message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello" } as ModelMessage,
      { role: "assistant", content: "Hi there" } as ModelMessage,
    ];

    const result = ensureValidConversationStart(messages);
    expect(result).toEqual(messages);
  });

  test("removes tool-calls from assistant message when it starts the conversation (after system)", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System prompt" } as ModelMessage,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: {},
          },
        ],
      } as unknown as ModelMessage,
    ];

    const result = ensureValidConversationStart(messages);

    expect(result.length).toBe(2);
    expect(at(result, 0).role).toBe("system");
    expect(at(result, 1).role).toBe("assistant");

    // Tool-call should be removed, only text remains
    expect(typeof at(result, 1).content).toBe("string");
    expect(at(result, 1).content).toBe("Let me search");
  });

  test("skips assistant message entirely if it has only tool-calls at conversation start", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System prompt" } as ModelMessage,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: {},
          },
        ],
      } as unknown as ModelMessage,
      { role: "user", content: "Follow up" } as ModelMessage,
    ];

    const result = ensureValidConversationStart(messages);

    // The assistant message with only tool-calls should be removed
    expect(result.length).toBe(2);
    expect(at(result, 0).role).toBe("system");
    expect(at(result, 1).role).toBe("user");
  });

  test("allows assistant message with tool-calls when it's not at the start", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Search for something" } as ModelMessage,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: {},
          },
        ],
      } as unknown as ModelMessage,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "search",
            output: { type: "text", value: "result" },
          },
        ],
      } as unknown as ModelMessage,
    ];

    const result = ensureValidConversationStart(messages);

    // Should remain unchanged - tool-calls are OK when not at the start
    expect(result).toEqual(messages);
  });

  test("handles empty message list", () => {
    const messages: ModelMessage[] = [];
    const result = ensureValidConversationStart(messages);
    expect(result).toEqual([]);
  });

  test("handles message list with only system messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System 1" } as ModelMessage,
    ];
    const result = ensureValidConversationStart(messages);
    expect(result).toEqual(messages);
  });

  test("preserves plain assistant messages at the start", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System prompt" } as ModelMessage,
      {
        role: "assistant",
        content: "Hello, I'm ready to help",
      } as ModelMessage,
      { role: "user", content: "Great!" } as ModelMessage,
    ];

    const result = ensureValidConversationStart(messages);
    expect(result).toEqual(messages);
  });

  test("handles conversation starting directly with assistant + tool-calls (no system)", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: {},
          },
        ],
      } as unknown as ModelMessage,
    ];

    const result = ensureValidConversationStart(messages);

    // Should remove tool-calls
    expect(result.length).toBe(1);
    expect(at(result, 0).role).toBe("assistant");
    expect(typeof at(result, 0).content).toBe("string");
    expect(at(result, 0).content).toBe("Searching");
  });
});
