// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Local pre-action approval for MCP tools an `llm` node calls.
 *
 * A tool matching APPROVAL_REQUIRE_TOOLS (or the node's
 * `config.requiresApproval`) is confirmed by a human BEFORE the MCP call, so a
 * server that does not gate a write tool itself cannot act unconfirmed. When
 * the server asks as well, the local decision answers its first request once
 * (APPROVAL_RELAY_LOCAL_DECISION, default on) instead of asking again.
 */

import { describe, it, expect } from "bun:test";
import { buildAiTools } from "../agent-tools.js";
import { toolRequiresApproval, approvalOwnerKey } from "../approval-gate.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ToolSet } from "ai";

async function executeOnlyTool(tools: ToolSet, args: unknown): Promise<unknown> {
  const [key] = Object.keys(tools);
  if (key === undefined) throw new Error("expected exactly one tool");
  const tool = tools[key];
  if (tool?.execute === undefined) throw new Error("expected an execute function");
  return tool.execute(args, { toolCallId: "tool-call-1" } as never);
}

const CTX: RequestContext = {
  ssoToken: "a.b.c",
  executionId: "exec-1",
  clientId: "tenant-1",
  userName: "Max",
};

type McpResult = Awaited<ReturnType<McpWrapperService["callTool"]>>;

function fakeMcp(callTool: () => Promise<McpResult>): McpWrapperService & { calls: number } {
  const mcp = {
    calls: 0,
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["update_record"],
    getFilteredToolSchema: async (_s: string, t: string) => ({
      name: t,
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async () => {
      mcp.calls += 1;
      return callTool();
    },
    getInstructions: () => undefined,
  };
  return mcp as unknown as McpWrapperService & { calls: number };
}

function gate(
  patterns: string[],
  decide: (request: Record<string, unknown>) => { approved: boolean; by?: string; reason?: string },
) {
  const requests: Array<Record<string, unknown>> = [];
  return {
    requests,
    gate: {
      enabled: true,
      globalPatterns: patterns,
      timeoutMs: 5000,
      requires: (toolRef: string, cfg: Record<string, unknown> | undefined) =>
        toolRequiresApproval(
          toolRef,
          Array.isArray(cfg?.requiresApproval) ? (cfg.requiresApproval as string[]) : undefined,
          patterns,
        ),
      request: async (request: Record<string, unknown>) => {
        requests.push(request);
        return decide(request);
      },
      resolve: () => false,
      listPending: () => [],
      listResolved: () => [],
      getResolved: () => undefined,
    },
  };
}

const node: FlowNode = { id: "n1", type: "llm", tools: ["abiliware/update_record"] };

describe("buildAiTools — local pre-action approval", () => {
  it("asks a human before calling a matching MCP tool and binds the owner key", async () => {
    const mcp = fakeMcp(async () => ({ content: "ok" }) as McpResult);
    const g = gate(["abiliware/update_*"], () => ({ approved: true, by: "max" }));
    const { tools } = await buildAiTools(node, mcp, CTX, { gate: g.gate } as never);

    expect(await executeOnlyTool(tools, { id: 7 })).toBe("ok");
    expect(mcp.calls).toBe(1);
    expect(g.requests).toHaveLength(1);
    expect(g.requests[0]).toMatchObject({
      tool: "abiliware/update_record",
      nodeId: "n1",
      args: { id: 7 },
      tenantId: "tenant-1",
      requestedBy: "Max",
      ownerKey: approvalOwnerKey(CTX),
    });
  });

  it("never calls the tool after a local denial", async () => {
    const mcp = fakeMcp(async () => ({ content: "ok" }) as McpResult);
    const g = gate(["abiliware/*"], () => ({ approved: false, reason: "nein" }));
    const { tools } = await buildAiTools(node, mcp, CTX, { gate: g.gate } as never);

    expect(await executeOnlyTool(tools, { id: 7 })).toEqual({
      isError: true,
      error: "approval_denied",
      message: "nein",
    });
    expect(mcp.calls).toBe(0);
  });

  it("honours the node's own config.requiresApproval list", async () => {
    const mcp = fakeMcp(async () => ({ content: "ok" }) as McpResult);
    const g = gate([], () => ({ approved: true }));
    const withList: FlowNode = { ...node, config: { requiresApproval: ["update_record"] } };
    const { tools } = await buildAiTools(withList, mcp, CTX, { gate: g.gate } as never);
    await executeOnlyTool(tools, {});
    expect(g.requests).toHaveLength(1);
  });

  it("does not ask locally for a tool that matches no pattern", async () => {
    const mcp = fakeMcp(async () => ({ content: "ok" }) as McpResult);
    const g = gate(["abiliware/close_*"], () => ({ approved: false }));
    const { tools } = await buildAiTools(node, mcp, CTX, { gate: g.gate } as never);
    expect(await executeOnlyTool(tools, {})).toBe("ok");
    expect(g.requests).toHaveLength(0);
  });

  function serverGated(resolutions: unknown[], rounds = 1) {
    let left = rounds;
    const respond = (): McpResult =>
      ({
        content: [],
        resultType: "input_required",
        inputRequests: [{ type: "approval", requestState: "s", title: "Server", message: "Bitte prüfen" }],
        resolveApproval: async (_request: unknown, resolution: unknown) => {
          resolutions.push(resolution);
          left -= 1;
          return left > 0
            ? respond()
            : { content: [{ type: "text", text: "done" }], resultType: "complete" };
        },
      }) as unknown as McpResult;
    return fakeMcp(async () => respond());
  }

  it("relays the local decision to the server's first approval request", async () => {
    const resolutions: unknown[] = [];
    const relayed: string[] = [];
    const mcp = serverGated(resolutions);
    const g = gate(["abiliware/update_*"], () => ({ approved: true, by: "max" }));
    const { tools } = await buildAiTools(node, mcp, CTX, {
      gate: g.gate,
      onRelay: (ref: string) => relayed.push(ref),
    } as never);

    expect(await executeOnlyTool(tools, { id: 7 })).toEqual([{ type: "text", text: "done" }]);
    expect(g.requests).toHaveLength(1);
    expect(resolutions).toEqual([{ decision: "approved", approver: "max" }]);
    expect(relayed).toEqual(["abiliware/update_record"]);
  });

  it("relays only once: a second server round asks the human again", async () => {
    const resolutions: unknown[] = [];
    const mcp = serverGated(resolutions, 2);
    const g = gate(["abiliware/update_*"], () => ({ approved: true, by: "max" }));
    const { tools } = await buildAiTools(node, mcp, CTX, { gate: g.gate } as never);

    await executeOnlyTool(tools, { id: 7 });
    expect(g.requests).toHaveLength(2);
    expect(g.requests[1]).toMatchObject({ title: "Server", message: "Bitte prüfen" });
    expect(resolutions).toHaveLength(2);
  });

  it("asks twice when relaying is switched off", async () => {
    const resolutions: unknown[] = [];
    const mcp = serverGated(resolutions);
    const g = gate(["abiliware/update_*"], () => ({ approved: true, by: "max" }));
    const { tools } = await buildAiTools(node, mcp, CTX, {
      gate: g.gate,
      relayLocalDecision: false,
    } as never);

    await executeOnlyTool(tools, { id: 7 });
    expect(g.requests).toHaveLength(2);
    expect(g.requests[1]).toMatchObject({ title: "Server" });
  });

  it("without a local match the server-driven approval is unchanged", async () => {
    const resolutions: unknown[] = [];
    const mcp = serverGated(resolutions);
    const g = gate([], () => ({ approved: true, by: "max" }));
    const { tools } = await buildAiTools(node, mcp, CTX, { gate: g.gate } as never);

    await executeOnlyTool(tools, {});
    expect(g.requests).toHaveLength(1);
    expect(g.requests[0]).toMatchObject({ title: "Server" });
  });
});

describe("toolRequiresApproval — glob patterns", () => {
  it("matches a full-ref glob only within its server", () => {
    expect(toolRequiresApproval("abiliware/update_record", undefined, ["abiliware/update_*"])).toBe(true);
    expect(toolRequiresApproval("other/update_record", undefined, ["abiliware/update_*"])).toBe(false);
    expect(toolRequiresApproval("abiliware/get_record", undefined, ["abiliware/update_*"])).toBe(false);
  });

  it("matches a bare glob against the tool name on any server", () => {
    expect(toolRequiresApproval("abiliware/close_case", undefined, ["*_case"])).toBe(true);
    expect(toolRequiresApproval("taiga/open_case", undefined, ["*_case"])).toBe(true);
    expect(toolRequiresApproval("taiga/cases", undefined, ["*_case"])).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(toolRequiresApproval("a/x.y", undefined, ["a/x.*"])).toBe(true);
    expect(toolRequiresApproval("a/xzy", undefined, ["a/x.*"])).toBe(false);
  });

  it("keeps the existing forms", () => {
    expect(toolRequiresApproval("a/b", undefined, ["*"])).toBe(true);
    expect(toolRequiresApproval("a/b", undefined, ["a/*"])).toBe(true);
    expect(toolRequiresApproval("a/b", undefined, ["b"])).toBe(true);
    expect(toolRequiresApproval("a/b", undefined, ["a/c"])).toBe(false);
  });
});
