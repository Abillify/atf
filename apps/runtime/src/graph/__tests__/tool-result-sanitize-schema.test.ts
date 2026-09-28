// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Regression: a failed tool result sanitized in `prepareStep` must still be a
 * schema-valid AI SDK `ModelMessage`. The bare `{ isError, error }` envelope
 * failed the `output.type` discriminator, aborting the follow-up model step
 * with `AI_InvalidPromptError` and producing an empty answer.
 */

import { describe, expect, test } from "bun:test";
import { type ModelMessage, modelMessageSchema } from "ai";
import { z } from "zod";
import {
  isToolErrorOutput,
  sanitizeToolResultModelMessages,
  sanitizeToolResultOutput,
  toolErrorExcerpt,
} from "../message-mapping.js";

const secret = "Invalid transaction token: sk-canary at https://private.internal";

function toolMessage(output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "parking__availability",
        output,
      },
    ],
  } as ModelMessage;
}

const failedOutputs: Array<[string, unknown]> = [
  ["json envelope", { type: "json", value: { isError: true, content: [{ type: "text", text: secret }] } }],
  // Exact production shape: agent-tools `toModelOutput` stringifies the
  // (already sanitized) MCP error envelope into a text output.
  ["text envelope (production shape)", { type: "text", value: JSON.stringify({ isError: true, error: secret }) }],
  ["error-text", { type: "error-text", value: secret }],
];

describe("sanitizeToolResultModelMessages", () => {
  for (const [label, output] of failedOutputs) {
    test(`keeps a schema-valid ModelMessage for a failed tool (${label})`, () => {
      const [sanitized] = sanitizeToolResultModelMessages([toolMessage(output)]);
      const parsed = z.array(modelMessageSchema).safeParse([sanitized]);
      expect(parsed.success).toBe(true);
      expect(JSON.stringify(sanitized)).toContain("Tool execution failed.");
      expect(JSON.stringify(sanitized)).not.toContain(secret);
    });
  }

  test("is idempotent across prepareStep invocations", () => {
    const once = sanitizeToolResultModelMessages([toolMessage(failedOutputs[0]?.[1])]);
    const twice = sanitizeToolResultModelMessages(once);
    expect(twice).toBe(once);
  });

  test("leaves successful results untouched", () => {
    const messages = [toolMessage({ type: "json", value: { free: 3 } })];
    expect(sanitizeToolResultModelMessages(messages)).toBe(messages);
  });
});

describe("tool error helpers", () => {
  const mcpError = {
    isError: true,
    content: [
      {
        type: "text",
        text: "Invalid transaction token: Envelope.sessionId does not match the authenticated session",
      },
    ],
  };

  test("isToolErrorOutput recognises raw and already-sanitized envelopes", () => {
    expect(isToolErrorOutput(mcpError)).toBe(true);
    // Regression: the llm handler forwards the already-sanitized envelope,
    // which used to be recorded as `is_error: false` in the debug trace.
    expect(isToolErrorOutput(sanitizeToolResultOutput(mcpError))).toBe(true);
    expect(isToolErrorOutput({ free: 3 })).toBe(false);
  });

  test("toolErrorExcerpt extracts the bounded raw cause", () => {
    expect(toolErrorExcerpt(mcpError)).toBe(
      "Invalid transaction token: Envelope.sessionId does not match the authenticated session",
    );
    expect(toolErrorExcerpt({ isError: true, error: "x".repeat(500) })?.length).toBe(300);
    expect(toolErrorExcerpt({ isError: true })).toBeUndefined();
  });
});
