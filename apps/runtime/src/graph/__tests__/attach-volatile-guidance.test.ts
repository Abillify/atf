// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `attachVolatileGuidance` — the placement rule that keeps volatile
 * per-request guidance (MCP tool instructions, unavailable-tool notes) out of
 * the cacheable prompt prefix.
 *
 * The invariant under test: attaching guidance must not change any message
 * BEFORE the last user message, and must not change the message count or any
 * role (which is what makes it safe on providers that reject system messages
 * outside position 0).
 */

import { describe, test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { attachVolatileGuidance } from "../exec-runtime.js";
import {
  comparePrefix,
  fingerprintMessages,
} from "../prompt-prefix-stability.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

function sys(text: string): ModelMessage {
  return { role: "system", content: text } as ModelMessage;
}
function user(text: string): ModelMessage {
  return { role: "user", content: text } as ModelMessage;
}
function assistant(text: string): ModelMessage {
  return { role: "assistant", content: text } as ModelMessage;
}

const GUIDANCE = "[Tool guidance] use foo before bar";

describe("attachVolatileGuidance", () => {
  test("appends to the last user message and leaves everything before it byte-identical", () => {
    const input = [sys("S"), user("f1"), assistant("a1"), user("f2")];
    const { messages, attached } = attachVolatileGuidance(input, GUIDANCE);

    expect(attached).toBe(true);
    expect(messages).toHaveLength(input.length);
    // Prefix untouched.
    expect(messages[0]).toEqual(sys("S"));
    expect(messages[1]).toEqual(user("f1"));
    expect(messages[2]).toEqual(assistant("a1"));
    // Only the newest user turn grew.
    expect(at(messages, 3).content).toBe(`f2\n\n${GUIDANCE}`);
  });

  test("does not mutate the input array or its messages", () => {
    const input = [sys("S"), user("f1")];
    const snapshot = JSON.stringify(input);
    attachVolatileGuidance(input, GUIDANCE);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("preserves roles and message count (provider safety)", () => {
    // The whole point of appending instead of inserting a system message: no
    // provider can reject the result on message-shape grounds.
    const input = [sys("S"), user("f1"), assistant("a1"), user("f2")];
    const { messages } = attachVolatileGuidance(input, GUIDANCE);
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  test("targets the LAST user message, not an earlier one", () => {
    const input = [user("erste"), assistant("a"), user("letzte")];
    const { messages } = attachVolatileGuidance(input, GUIDANCE);
    expect(at(messages, 0).content).toBe("erste");
    expect(at(messages, 2).content).toBe(`letzte\n\n${GUIDANCE}`);
  });

  test("appends a text part to a multimodal user turn instead of stringifying it", () => {
    const input = [
      sys("S"),
      {
        role: "user",
        content: [
          { type: "text", text: "was ist das?" },
          { type: "image", image: "base64..." },
        ],
      } as unknown as ModelMessage,
    ];
    const { messages, attached } = attachVolatileGuidance(input, GUIDANCE);
    expect(attached).toBe(true);
    const content = at(messages, 1).content as Array<{
      type: string;
      text?: string;
      image?: string;
    }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(3);
    // Image part survived — a JSON.stringify fallback would have destroyed it.
    expect(at(content, 1).type).toBe("image");
    expect(content[2]).toEqual({ type: "text", text: GUIDANCE });
  });

  test("reports not-attached when there is no user message", () => {
    const { messages, attached } = attachVolatileGuidance(
      [sys("S"), assistant("a")],
      GUIDANCE,
    );
    expect(attached).toBe(false);
    expect(messages).toEqual([sys("S"), assistant("a")]);
  });

  test("empty or whitespace-only guidance is a no-op", () => {
    const input = [sys("S"), user("f1")];
    expect(attachVolatileGuidance(input, "").attached).toBe(false);
    expect(attachVolatileGuidance(input, "   \n  ").attached).toBe(false);
    expect(attachVolatileGuidance(input, "").messages).toBe(input);
  });

  test("trims surrounding whitespace so leading newlines cannot drift", () => {
    // The old call site built the note with a leading "\n\n"; if that leaked
    // through, the same guidance could produce different bytes depending on
    // which notes were present.
    const a = at(attachVolatileGuidance([user("f")], "\n\nNOTE").messages, 0)
      .content;
    const b = at(attachVolatileGuidance([user("f")], "NOTE").messages, 0)
      .content;
    expect(a).toBe(b);
  });
});

describe("attachVolatileGuidance + prefix stability (regression contract)", () => {
  test("changing the guidance between turns does not break the prefix", () => {
    // This is the behaviour the change exists for. Turn 1 and turn 2 carry
    // DIFFERENT guidance (an MCP server went away). The history grew by one
    // exchange. The prefix must still be reusable up to the newest user turn.
    const turn1 = attachVolatileGuidance(
      [sys("STABLE SYSTEM"), user("f1")],
      "guidance A",
    ).messages;

    const turn2 = attachVolatileGuidance(
      [sys("STABLE SYSTEM"), user("f1"), assistant("a1"), user("f2")],
      "guidance B — server foo is unavailable",
    ).messages;

    const report = comparePrefix(
      fingerprintMessages(turn1),
      fingerprintMessages(turn2),
    );

    // The system message survives, which is the expensive part.
    expect(report.stableMessages).toBeGreaterThanOrEqual(1);
    expect(report.firstDivergenceIndex).not.toBe(0);
  });

  test("the OLD layout (guidance in the system prompt) diverges at index 0", () => {
    // Documents the regression this replaced: concatenating volatile guidance
    // onto the system prompt invalidates message 0 and therefore everything.
    const oldTurn1 = [sys("STABLE SYSTEM" + "\n\nguidance A"), user("f1")];
    const oldTurn2 = [
      sys("STABLE SYSTEM" + "\n\nguidance B — server foo is unavailable"),
      user("f1"),
    ];
    const report = comparePrefix(
      fingerprintMessages(oldTurn1),
      fingerprintMessages(oldTurn2),
    );
    expect(report.firstDivergenceIndex).toBe(0);
    expect(report.reuseRatio).toBe(0);
  });

  test("identical guidance across turns is fully append-only", () => {
    const turn1 = attachVolatileGuidance(
      [sys("STABLE SYSTEM"), user("f1")],
      GUIDANCE,
    ).messages;
    // Turn 2 keeps turn 1's messages verbatim and appends the new exchange.
    const turn2 = attachVolatileGuidance(
      [...turn1, assistant("a1"), user("f2")],
      GUIDANCE,
    ).messages;

    const report = comparePrefix(
      fingerprintMessages(turn1),
      fingerprintMessages(turn2),
    );
    expect(report.appendOnly).toBe(true);
    expect(report.firstDivergenceIndex).toBe(-1);
  });
});
