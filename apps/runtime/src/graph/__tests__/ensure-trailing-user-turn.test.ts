// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import {
  ensureTrailingUserTurn,
  sanitizeSystemMessages,
} from "../graph-engine.js";

/**
 * Regression tests for an empty-completion shape observed by a fail-closed
 * coverage verifier: a prompt ending on an ASSISTANT turn asks a chat
 * model to open a second consecutive assistant turn, which local Qwen builds
 * answer with an immediate end token.
 */
describe("ensureTrailingUserTurn", () => {
  it("appends a user turn when the prompt ends on an assistant message", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "Du bist der Pruefer." },
      { role: "user", content: "Frage" },
      { role: "assistant", content: "Getragene Befunde" },
    ];

    const { messages: out, appended } = ensureTrailingUserTurn(messages);

    expect(appended).toBe(true);
    expect(out.length).toBe(4);
    expect(out[3]?.role).toBe("user");
    // The original list is not mutated.
    expect(messages.length).toBe(3);
  });

  it("leaves a normal chat prompt untouched", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "System" },
      { role: "assistant", content: "Vorherige Antwort" },
      { role: "user", content: "Neue Frage" },
    ];

    const { messages: out, appended } = ensureTrailingUserTurn(messages);

    expect(appended).toBe(false);
    expect(out).toBe(messages);
  });

  it("uses a caller-supplied instruction when given", () => {
    const { messages: out } = ensureTrailingUserTurn(
      [{ role: "assistant", content: "Kontext" }],
      "Antworte jetzt.",
    );

    expect(out[1]?.content).toBe("Antworte jetzt.");
  });

  it("handles an empty list", () => {
    const { messages: out, appended } = ensureTrailingUserTurn([]);
    expect(appended).toBe(false);
    expect(out).toEqual([]);
  });

  it("repairs the exact harness shape: a trailing ledger folded into a finding", () => {
    // What the coverage verifier used to receive: request, carried findings, and
    // the sanitized ledger as a TRAILING system message.
    const verifierContext: ModelMessage[] = [
      { role: "user", content: "Welche Fristen sind offen?" },
      { role: "assistant", content: "ABGEDECKT: … BEFUNDE: …" },
      { role: "system", content: "SANITIZED COVERAGE LEDGER: {…}" },
    ];

    const sanitized = sanitizeSystemMessages(verifierContext);
    // The ledger is folded into the assistant turn — the list now ends on
    // `assistant`, which is the failure shape.
    expect(sanitized.length).toBe(2);
    expect(sanitized[1]?.role).toBe("assistant");

    const { appended, messages } = ensureTrailingUserTurn(sanitized);
    expect(appended).toBe(true);
    expect(messages[messages.length - 1]?.role).toBe("user");
  });
});
