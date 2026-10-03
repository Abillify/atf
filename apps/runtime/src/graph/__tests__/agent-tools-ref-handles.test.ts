// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the ref-handle indirection in `buildAiTools` (agent-tools.ts) —
 * `opts.refHandles` resolves the model's short handles back to real document
 * references before the MCP call, and masks references in the tool result the
 * model reads.
 *
 * Regression coverage for trace 55c5b138: a small model cannot copy a long
 * path-like `reference` verbatim into the follow-up `get_document` call (it
 * truncated it to the bare `.pdf`), so every read failed. The handle gives the
 * model something it CAN copy; the runtime owns the real value.
 */

import { describe, it, expect } from "bun:test";
import { buildAiTools } from "../agent-tools.js";
import { HashRefHandleRegistry } from "../ref-handles.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ToolSet } from "ai";

const REF_A =
  "prod/richtlinien/logistik/wareneingang_pruefung_v3.pdf#kapitel-4.2";

async function executeOnlyTool(
  tools: ToolSet,
  args: unknown,
): Promise<unknown> {
  const [key] = Object.keys(tools);
  if (key === undefined) throw new Error("expected exactly one tool");
  const tool = tools[key];
  if (tool?.execute === undefined)
    throw new Error("expected the tool to have an execute function");
  return tool.execute(args, { toolCallId: "tool-call-1" } as never);
}

function fakeMcp(
  result: unknown,
  onCall: (serverName: string, toolName: string, args: unknown) => void,
): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["search", "get_document"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async (serverName: string, toolName: string, args: unknown) => {
      onCall(serverName, toolName, args);
      return { content: result };
    },
    getInstructions: () => undefined,
  };
}

const CTX: RequestContext = { ssoToken: "a.b.c", executionId: "exec-1" };

const NODE: FlowNode = {
  id: "n1",
  type: "llm",
  tools: ["vectorsearch/get_document"],
  config: { refHandles: true },
};

describe("buildAiTools — ref-handle resolution (config.refHandles)", () => {
  it("resolves a handle-valued reference to the real path before the MCP call", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp({ title: "Dok", content: "text" }, (_s, _t, args) => {
      seenArgs = args;
    });
    const registry = new HashRefHandleRegistry();
    const handle = registry.register(REF_A);
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = await executeOnlyTool(tools, { reference: handle });
    expect(seenArgs).toEqual({ reference: REF_A });
    expect(result).toEqual({ title: "Dok", content: "text" });
  });

  it("forwards a real (non-handle) reference unchanged", async () => {
    let seenArgs: unknown;
    const mcp = fakeMcp({ title: "Dok", content: "text" }, (_s, _t, args) => {
      seenArgs = args;
    });
    const registry = new HashRefHandleRegistry();
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    await executeOnlyTool(tools, { reference: REF_A });
    expect(seenArgs).toEqual({ reference: REF_A });
  });

  it("rejects a hallucinated handle-shaped argument without calling the tool", async () => {
    let called = false;
    const mcp = fakeMcp({}, () => {
      called = true;
    });
    const registry = new HashRefHandleRegistry();
    const valid = registry.register(REF_A);
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = (await executeOnlyTool(tools, {
      reference: "QQQQ",
    })) as Record<string, unknown>;
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toBe("unknown_ref_handle");
    // The model gets the valid handles so it can self-correct.
    expect(String(result.message)).toContain(valid);
  });

  it("masks references in the tool result the model reads", async () => {
    const payload = {
      results: [
        { base_ref: REF_A, title: "Wareneingang", content: "Ablauf" },
      ],
    };
    const mcp = fakeMcp(payload, () => {});
    const registry = new HashRefHandleRegistry();
    const { tools } = await buildAiTools(NODE, mcp, CTX, undefined, undefined, undefined, undefined, undefined, { refHandles: registry });
    const result = await executeOnlyTool(tools, { query: "wareneingang" });
    const json = JSON.stringify(result);
    // The model must NOT see the long path anymore…
    expect(json).not.toContain(REF_A);
    // …but the registry knows it, and the handle round-trips.
    const info = registry.list().find((i) => i.ref === REF_A);
    expect(info).toBeDefined();
    expect(json).toContain(info?.handle ?? "???");
  });

  it("leaves tool results untouched when no registry is wired", async () => {
    const payload = { results: [{ base_ref: REF_A, title: "T" }] };
    const mcp = fakeMcp(payload, () => {});
    const { tools } = await buildAiTools(NODE, mcp, CTX);
    const result = await executeOnlyTool(tools, { query: "x" });
    expect(JSON.stringify(result)).toContain(REF_A);
  });
});
