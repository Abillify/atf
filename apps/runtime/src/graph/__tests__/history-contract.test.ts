// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the threaded-history contract
 * (`src/graph/graph-engine/history-contract.ts`).
 *
 * The regression these guard: `AgentStateAnnotation.messages` is append-only, so
 * a client that resends its whole transcript each turn (the OpenAI
 * Chat-Completions default) used to duplicate every earlier turn into the
 * checkpointed thread. The model then saw its own earlier question a second and
 * third time and asked it again.
 */

import { describe, test, expect } from "bun:test";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { reconcileThreadedHistory } from "../graph-engine/history-contract.js";

function texts(messages: BaseMessage[]): string[] {
  return messages.map((m) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  );
}

describe("reconcileThreadedHistory — fresh thread", () => {
  test("nothing persisted → the full request is appended", () => {
    const incoming = [new HumanMessage("Hallo")];
    const result = reconcileThreadedHistory([], incoming);
    expect(texts(result.messages)).toEqual(["Hallo"]);
    expect(result.dropped).toBe(0);
    expect(result.duplicateTurn).toBe(false);
  });

  test("empty request against a populated thread appends nothing", () => {
    const result = reconcileThreadedHistory([new HumanMessage("Hallo")], []);
    expect(result.messages).toEqual([]);
    expect(result.dropped).toBe(0);
  });
});

describe("reconcileThreadedHistory — full-history client", () => {
  test("only the new tail is appended", () => {
    const persisted = [
      new HumanMessage("Ich brauche ein Ticket"),
      new AIMessage("Welche Anwendung ist betroffen?"),
    ];
    const incoming = [
      new HumanMessage("Ich brauche ein Ticket"),
      new AIMessage("Welche Anwendung ist betroffen?"),
      new HumanMessage("Das Zeiterfassungssystem"),
    ];

    const result = reconcileThreadedHistory(persisted, incoming);

    expect(texts(result.messages)).toEqual(["Das Zeiterfassungssystem"]);
    expect(result.incoming).toBe(3);
    expect(result.dropped).toBe(2);
    expect(result.duplicateTurn).toBe(false);
  });

  test("messages the client never saw do not break the walk", () => {
    // RAG system blocks and tool results live in the checkpoint but are never
    // echoed by the client. They must not stop the prefix match.
    const persisted = [
      new HumanMessage("Frage"),
      new SystemMessage("[RAG-Kontext] …"),
      new AIMessage("Rückfrage"),
    ];
    const incoming = [
      new HumanMessage("Frage"),
      new AIMessage("Rückfrage"),
      new HumanMessage("Antwort"),
    ];

    const result = reconcileThreadedHistory(persisted, incoming);

    expect(texts(result.messages)).toEqual(["Antwort"]);
    expect(result.dropped).toBe(2);
  });

  test("an unchanged transcript is recognised as a duplicate turn", () => {
    const persisted = [
      new HumanMessage("Frage"),
      new AIMessage("Rückfrage"),
    ];
    const incoming = [new HumanMessage("Frage"), new AIMessage("Rückfrage")];

    const result = reconcileThreadedHistory(persisted, incoming);

    expect(result.messages).toEqual([]);
    expect(result.dropped).toBe(2);
    expect(result.duplicateTurn).toBe(true);
  });

  test("repeated reconciliation is idempotent — history cannot grow", () => {
    let persisted: BaseMessage[] = [];
    const clientTranscript: BaseMessage[] = [new HumanMessage("Frage")];

    // Three identical submits of the same transcript (the triple-submit case).
    for (let i = 0; i < 3; i++) {
      const result = reconcileThreadedHistory(persisted, clientTranscript);
      persisted = [...persisted, ...result.messages];
    }

    expect(texts(persisted)).toEqual(["Frage"]);
  });
});

describe("reconcileThreadedHistory — order and content sensitivity", () => {
  test("a genuinely repeated user message is kept, not deduplicated away", () => {
    const persisted = [new HumanMessage("ja"), new AIMessage("Und weiter?")];
    const incoming = [
      new HumanMessage("ja"),
      new AIMessage("Und weiter?"),
      new HumanMessage("ja"),
    ];

    const result = reconcileThreadedHistory(persisted, incoming);

    expect(texts(result.messages)).toEqual(["ja"]);
    expect(result.duplicateTurn).toBe(false);
  });

  test("same text but a different role does not match", () => {
    const result = reconcileThreadedHistory(
      [new AIMessage("hallo")],
      [new HumanMessage("hallo")],
    );
    expect(texts(result.messages)).toEqual(["hallo"]);
    expect(result.dropped).toBe(0);
  });

  test("an edited transcript ends the walk at the first divergence", () => {
    const persisted = [
      new HumanMessage("Frage A"),
      new AIMessage("Antwort A"),
    ];
    const incoming = [
      new HumanMessage("Frage A"),
      new AIMessage("Antwort B"), // diverges here
      new HumanMessage("Frage C"),
    ];

    const result = reconcileThreadedHistory(persisted, incoming);

    expect(texts(result.messages)).toEqual(["Antwort B", "Frage C"]);
    expect(result.dropped).toBe(1);
  });

  test("tool results are matched on their tool_call_id, not text alone", () => {
    const persisted = [
      new ToolMessage({ content: "ok", tool_call_id: "call-1" }),
    ];
    const incoming = [
      new ToolMessage({ content: "ok", tool_call_id: "call-2" }),
    ];

    const result = reconcileThreadedHistory(persisted, incoming);

    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(1);
  });
});
