// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Operator diagnostics for AI SDK prompt validation failures: the offending
 * message index/role/path must be visible, the prompt content must not.
 */

import { describe, expect, test } from "bun:test";
import { InvalidPromptError, TypeValidationError, modelMessageSchema } from "ai";
import { z } from "zod";
import {
  describePromptSchemaIssues,
  describeProviderError,
} from "../provider-circuit-breaker.js";

const canary = "PROMPT-CANARY-do-not-log";

function promptError(): InvalidPromptError {
  // Reproduces the observed failure: a tool-result part whose `output` is the bare
  // `{ isError, error }` envelope instead of a ToolResultOutput.
  const value = [
    { role: "system", content: `system ${canary}` },
    { role: "user", content: `user ${canary}` },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "parking__availability",
          output: { isError: true, error: { name: "ToolExecutionError", message: "Tool execution failed." } },
        },
      ],
    },
  ];
  const parsed = z.array(modelMessageSchema).safeParse(value);
  if (parsed.success) throw new Error("fixture must be invalid");
  const cause = new TypeValidationError({ value, cause: parsed.error });
  return new InvalidPromptError({
    prompt: value,
    message: "The messages do not match the ModelMessage[] schema.",
    cause,
  });
}

describe("prompt schema diagnostics", () => {
  test("names the offending message and path", () => {
    const issues = describePromptSchemaIssues(promptError());
    expect(issues).toBeDefined();
    expect(issues?.[0]).toMatchObject({ role: "tool" });
    expect(issues?.[0]?.path.slice(0, 4)).toEqual([2, "content", 0, "output"]);
  });

  test("describeProviderError reports the schema path without prompt content", () => {
    const description = describeProviderError(promptError(), 2000);
    expect(description).toContain("tool [2].content[0].output");
    expect(description).not.toContain(canary);
    expect(description).not.toContain("Value:");
  });

  test("returns undefined for non-validation errors", () => {
    expect(describePromptSchemaIssues(new Error("socket closed"))).toBeUndefined();
  });
});
