// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { buildAiTools } from "../agent-tools.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowNode } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { AssistantToolJournal } from "../../assistants/session-store.js";
import { ToolJournalConflictError } from "../../assistants/session-store.js";

const ctx: RequestContext = {
  ssoToken: "token",
  executionId: "550e8400-e29b-41d4-a716-446655440000",
};
const node: FlowNode = { id: "respond", type: "llm", tools: ["remote/write"] };

async function execute(tools: ToolSet): Promise<unknown> {
  const tool = tools[Object.keys(tools)[0] ?? ""];
  if (tool?.execute === undefined) throw new Error("missing execute");
  return tool.execute({ value: 1 }, { toolCallId: "call-1" } as never);
}

describe("assistant session tool journal", () => {
  test("commits pending intent before calling an external tool and completes it afterwards", async () => {
    const events: string[] = [];
    const journal: AssistantToolJournal = {
      beforeTool: async () => {
        events.push("pending");
      },
      completeTool: async ({ succeeded }) => {
        events.push(succeeded ? "completed" : "failed");
      },
    };
    const mcp = {
      getFilteredToolSchema: async () => ({
        name: "write",
        inputSchema: { type: "object", properties: {} },
      }),
      callTool: async () => {
        events.push("external");
        return { content: "done" };
      },
    } as unknown as McpWrapperService;
    const { tools } = await buildAiTools(
      node,
      mcp,
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        journal: {
          journal,
          scope: { tenantId: "_", userId: "u", assistantId: "helpdesk" },
          conversationId: "chat",
          executionId: ctx.executionId,
        },
      },
    );
    await execute(tools);
    expect(events).toEqual(["pending", "external", "completed"]);
  });

  test("scopes the durable call id to the execution so reused provider ids cannot collide", async () => {
    const ids: string[] = [];
    const journal: AssistantToolJournal = {
      beforeTool: async ({ toolCallId }) => {
        ids.push(toolCallId);
      },
      completeTool: async ({ toolCallId }) => {
        ids.push(toolCallId);
      },
    };
    const mcp = {
      getFilteredToolSchema: async () => ({
        name: "write",
        inputSchema: { type: "object", properties: {} },
      }),
      callTool: async () => ({ content: "done" }),
    } as unknown as McpWrapperService;
    const { tools } = await buildAiTools(
      node,
      mcp,
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        journal: {
          journal,
          scope: { tenantId: "_", userId: "u", assistantId: "helpdesk" },
          conversationId: "chat",
          executionId: ctx.executionId,
        },
      },
    );
    await execute(tools);
    expect(ids).toEqual([
      `${ctx.executionId}:call-1`,
      `${ctx.executionId}:call-1`,
    ]);
  });

  test("keeps the tool result when settling the journal loses a race after the call", async () => {
    const journal: AssistantToolJournal = {
      beforeTool: async () => {},
      completeTool: async () => {
        throw new ToolJournalConflictError("unknown");
      },
    };
    const mcp = {
      getFilteredToolSchema: async () => ({
        name: "write",
        inputSchema: { type: "object", properties: {} },
      }),
      callTool: async () => ({ content: "done" }),
    } as unknown as McpWrapperService;
    const { tools } = await buildAiTools(
      node,
      mcp,
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        journal: {
          journal,
          scope: { tenantId: "_", userId: "u", assistantId: "helpdesk" },
          conversationId: "chat",
          executionId: ctx.executionId,
        },
      },
    );
    expect(await execute(tools)).toBe("done");
  });

  test("propagates a non-conflict journal failure after the call instead of hiding it", async () => {
    const journal: AssistantToolJournal = {
      beforeTool: async () => {},
      completeTool: async () => {
        throw new Error("database unavailable");
      },
    };
    const mcp = {
      getFilteredToolSchema: async () => ({
        name: "write",
        inputSchema: { type: "object", properties: {} },
      }),
      callTool: async () => ({ content: "done" }),
    } as unknown as McpWrapperService;
    const { tools } = await buildAiTools(
      node,
      mcp,
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        journal: {
          journal,
          scope: { tenantId: "_", userId: "u", assistantId: "helpdesk" },
          conversationId: "chat",
          executionId: ctx.executionId,
        },
      },
    );
    await expect(execute(tools)).rejects.toThrow("database unavailable");
  });

  test("does not call the external tool when the durable pending write fails", async () => {
    let called = false;
    const journal: AssistantToolJournal = {
      beforeTool: async () => {
        throw new Error("database unavailable");
      },
      completeTool: async () => {},
    };
    const mcp = {
      getFilteredToolSchema: async () => ({
        name: "write",
        inputSchema: { type: "object", properties: {} },
      }),
      callTool: async () => {
        called = true;
        return { content: "unexpected" };
      },
    } as unknown as McpWrapperService;
    const { tools } = await buildAiTools(
      node,
      mcp,
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        journal: {
          journal,
          scope: { tenantId: "_", userId: "u", assistantId: "helpdesk" },
          conversationId: "chat",
          executionId: ctx.executionId,
        },
      },
    );
    await expect(execute(tools)).rejects.toThrow("database unavailable");
    expect(called).toBe(false);
  });
});
