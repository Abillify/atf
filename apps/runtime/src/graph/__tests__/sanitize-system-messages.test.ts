// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import { sanitizeSystemMessages } from "../graph-engine.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

/**
 * Regression tests for sanitizeSystemMessages.
 *
 * The RAG/tool node appends a citation `system` message AFTER a `tool` message
 * whose content is a structured array of `tool-result` parts. A previous
 * implementation merged trailing/mid-conversation system messages by
 * JSON.stringify-ing the adjacent message's content. When that adjacent message
 * was the tool result, its array content collapsed into a string, which the AI
 * SDK rejects with: "Invalid prompt: The messages do not match the
 * ModelMessage[] schema" (a `tool` message's content must be an array).
 */
describe("sanitizeSystemMessages — structured (tool) content preservation", () => {
  const toolMessage = (): ModelMessage =>
    ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "vectorsearch",
          output: { type: "text", value: '{"results":[]}' },
        },
      ],
    }) as unknown as ModelMessage;

  it("keeps a tool message's array content intact when a trailing system message follows", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are Helpdesk." },
      { role: "user", content: "who was shortest in the office today" },
      toolMessage(),
      {
        role: "system",
        content: "The retrieved sources are numbered below.\n\n[1] Foo",
      },
    ];

    const out = sanitizeSystemMessages(messages);

    const tool = out.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    if (tool === undefined) throw new Error("expected a tool message");
    // The whole point: content must remain an array, not a stringified array.
    expect(Array.isArray(tool.content)).toBe(true);

    // The citation context must survive somewhere as a plain-text turn.
    const flat = out
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(flat).toContain("The retrieved sources are numbered below.");
  });

  it("preserves array content for a mid-conversation system message before a tool turn", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "You are Helpdesk." },
      { role: "system", content: "Extra grounding context." },
      toolMessage(),
      { role: "user", content: "follow up" },
    ];

    const out = sanitizeSystemMessages(messages);

    const tool = out.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    if (tool === undefined) throw new Error("expected a tool message");
    expect(Array.isArray(tool.content)).toBe(true);

    const flat = out
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(flat).toContain("Extra grounding context.");
  });

  it("never emits more than the first system message in system position", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "first" },
      { role: "user", content: "hi" },
      { role: "system", content: "second" },
    ];

    const out = sanitizeSystemMessages(messages);
    const systemCount = out.filter((m) => m.role === "system").length;
    expect(systemCount).toBe(1);
    expect(at(out, 0).role).toBe("system");
  });

  it("still merges trailing system context into a plain-text last message", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "first" },
      { role: "user", content: "question" },
      { role: "system", content: "trailing note" },
    ];

    const out = sanitizeSystemMessages(messages);
    const last = at(out, out.length - 1);
    expect(typeof last.content).toBe("string");
    expect(last.content as string).toContain("question");
    expect(last.content as string).toContain("trailing note");
  });

  // Regression: history starts with a USER turn (no node system prompt yet —
  // it is prepended by the caller afterwards) and the RAG/memory nodes append
  // their grounding context as system messages. The previous implementation
  // kept the first *injected* system message in its mid-conversation position;
  // the caller then prepended the node prompt, producing TWO system messages
  // that Google Gemini rejects with "system messages are only supported at the
  // beginning of the conversation".
  it("leaves no system message mid-conversation when history begins with a user turn", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "who is out of office today" },
      {
        role: "system",
        content: "Relevant context remembered: prefers German.",
      },
      {
        role: "system",
        content: "Use ONLY the following retrieved context:\n[1] docs",
      },
      { role: "system", content: "[2] taiga ticket" },
    ];

    const out = sanitizeSystemMessages(messages);

    expect(out.filter((m) => m.role === "system").length).toBe(0);
    const flat = out
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(flat).toContain("prefers German.");
    expect(flat).toContain("[1] docs");
    expect(flat).toContain("[2] taiga ticket");
  });

  it("merges a second leading system message into the conversation, keeping one in system position", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "User Context: name=Alex" },
      { role: "system", content: "Extra grounding." },
      { role: "user", content: "hi" },
    ];

    const out = sanitizeSystemMessages(messages);

    expect(out.filter((m) => m.role === "system").length).toBe(1);
    expect(at(out, 0).role).toBe("system");
    const flat = out
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(flat).toContain("Extra grounding.");
  });
});
