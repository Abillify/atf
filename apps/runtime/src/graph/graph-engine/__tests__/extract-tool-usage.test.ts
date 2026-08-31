// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for `extractToolUsage` (handler-factories.ts) — extracts a
 * tool-reported `usage` block (e.g. vectorsearch's own embedding/rerank
 * spend) from a raw MCP tool result, so it can be folded into aiperator's
 * per-call cost accounting instead of being silently dropped.
 */
import { describe, test, expect } from "bun:test";
import { extractToolUsage } from "../handler-factories.js";

describe("extractToolUsage", () => {
  test("parses usage from the MCP text-content wrapper", () => {
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          results: [],
          count: 0,
          usage: {
            input_tokens: 120,
            output_tokens: 0,
            cost: 0.000042,
            model_costs: { "text-embedding-3-small": 0.000042 },
          },
        }),
      },
    ];
    expect(extractToolUsage(content)).toEqual({
      inputTokens: 120,
      outputTokens: 0,
      cost: 0.000042,
    });
  });

  test("parses usage from a raw JSON string", () => {
    const content = JSON.stringify({
      usage: { input_tokens: 5, output_tokens: 3, cost: 0.01 },
    });
    expect(extractToolUsage(content)).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cost: 0.01,
    });
  });

  test("parses usage from an already-parsed object", () => {
    const content = { usage: { input_tokens: 1, cost: 0.5 } };
    expect(extractToolUsage(content)).toEqual({
      inputTokens: 1,
      outputTokens: 0,
      cost: 0.5,
    });
  });

  test("returns undefined when no usage field is present (ordinary tool result)", () => {
    const content = [
      { type: "text", text: JSON.stringify({ results: [], count: 0 }) },
    ];
    expect(extractToolUsage(content)).toBeUndefined();
  });

  test("returns undefined when cost is missing or non-numeric", () => {
    expect(
      extractToolUsage({ usage: { input_tokens: 10 } }),
    ).toBeUndefined();
    expect(
      extractToolUsage({ usage: { cost: "not-a-number" } }),
    ).toBeUndefined();
  });

  test("returns undefined for malformed JSON or unrelated shapes", () => {
    expect(extractToolUsage("not json")).toBeUndefined();
    expect(extractToolUsage(null)).toBeUndefined();
    expect(extractToolUsage(42)).toBeUndefined();
    expect(extractToolUsage([{ type: "text", text: "not json" }])).toBeUndefined();
  });
});
