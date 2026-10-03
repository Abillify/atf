// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Effective-args reporting for the `select_tools` meta-tool
 * (`buildToolSelectionMetaTool`).
 *
 * The meta-tool is a local tool: it runs server-side with no egress DLP, so
 * the model's raw `query` IS the effective argument. The engine's `onToolCall`
 * telemetry only records `argument_keys` (pre-DLP policy), which left the live
 * graph's INPUT panel showing a key-only placeholder. The execute site must
 * fire `onEffectiveArgs` with the real key-value JSON, mirroring the MCP tool
 * path (`onEffectiveToolArgs` in the MCP execute wrapper).
 */

import { describe, test, expect } from "bun:test";
import type { Tool } from "ai";
import { buildToolSelectionMetaTool } from "../agent-tools.js";
import type { ToolIndex, ToolSelectionHit } from "../tool-index.js";

type ExecutableTool = Tool & {
  execute: (
    args: Record<string, unknown>,
    opts: { toolCallId?: string },
  ) => Promise<Record<string, unknown>>;
};

/** Stub index returning fixed hits for any query. */
function fakeIndex(hits: ToolSelectionHit[]): ToolIndex {
  return {
    select: async () => hits,
  } as unknown as ToolIndex;
}

describe("buildToolSelectionMetaTool — effective args", () => {
  test("reports the effective query as key-value JSON", async () => {
    const effectiveArgs: Array<{
      toolCallId: string;
      toolName: string;
      argsJson: string;
    }> = [];
    const activated: string[] = [];
    const { key, tool } = buildToolSelectionMetaTool({
      name: "select_tools",
      toolIndex: fakeIndex([
        { ref: "worktime/status", score: 0.9 },
      ]),
      pool: ["worktime/status"],
      keyByRef: { "worktime/status": "worktime__status" },
      topK: 2,
      activate: (keys) => activated.push(...keys),
      onEffectiveArgs: (toolCallId, toolName, argsJson) => {
        effectiveArgs.push({ toolCallId, toolName, argsJson });
      },
    });
    const result = await (tool as ExecutableTool).execute(
      { query: "cancel a parking booking" },
      { toolCallId: "call-9" },
    );
    expect(result.activated).toEqual([{ name: "worktime__status" }]);
    expect(activated).toEqual(["worktime__status"]);
    expect(effectiveArgs).toHaveLength(1);
    expect(effectiveArgs[0]?.toolCallId).toBe("call-9");
    expect(effectiveArgs[0]?.toolName).toBe(key);
    expect(JSON.parse(effectiveArgs[0]?.argsJson ?? "")).toEqual({
      query: "cancel a parking booking",
    });
  });

  test("still reports the effective args when the query is blank", async () => {
    // The report fires before validation so the live graph shows what the
    // model actually attempted, even when the call is rejected.
    const effectiveArgs: string[] = [];
    const { tool } = buildToolSelectionMetaTool({
      name: "select_tools",
      toolIndex: fakeIndex([]),
      pool: [],
      keyByRef: {},
      topK: 2,
      activate: () => {},
      onEffectiveArgs: (_id, _name, argsJson) => {
        effectiveArgs.push(argsJson);
      },
    });
    const result = await (tool as ExecutableTool).execute(
      { query: "   " },
      { toolCallId: "call-10" },
    );
    expect(result.isError).toBe(true);
    expect(effectiveArgs).toEqual(['{"query":"   "}']);
  });
});
