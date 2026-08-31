// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { McpAssistantSessionIndex } from "../session-index.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";

const scope = { tenantId: "tenant-a", userId: "user-a", assistantId: "assistant-a" };

function wrapper(calls: Array<{ server: string; tool: string; args: Record<string, unknown>; token: string }>): McpWrapperService {
  return {
    callTool: async (server: string, tool: string, args: Record<string, unknown>, context: { ssoToken: string }) => {
      calls.push({ server, tool, args, token: context.ssoToken });
      return { content: { ok: true } };
    },
  } as unknown as McpWrapperService;
}

describe("McpAssistantSessionIndex", () => {
  test("ingests events with a tenant/user/assistant/conversation scope", async () => {
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown>; token: string }> = [];
    const index = new McpAssistantSessionIndex(wrapper(calls));
    await index.ingestEvent({
      scope,
      conversationId: "conversation-a",
      documentId: "event-1",
      content: "private assistant event",
      kind: "event",
      sequence: 7,
      token: "caller-token",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ server: "vectorsearch", tool: "ingest", token: "caller-token" });
    expect(calls[0]?.args).toMatchObject({
      collection: "assistant-sessions",
      reference: "event-1",
      requesting_user: "user-a",
      metadata: { tenant_id: "tenant-a", user_id: "user-a", assistant_id: "assistant-a", conversation_id: "conversation-a", sequence: 7 },
    });
  });

  test("uses hybrid search and never widens the scope", async () => {
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown>; token: string }> = [];
    const index = new McpAssistantSessionIndex(wrapper(calls));
    await index.search({ scope, query: "project status", conversationId: "conversation-a", token: "caller-token" });
    expect(calls[0]?.args).toMatchObject({
      collection: "assistant-sessions",
      query: "project status",
      requesting_user: "user-a",
      hybrid: true,
      filter: { tenant_id: "tenant-a", user_id: "user-a", assistant_id: "assistant-a", conversation_id: "conversation-a" },
    });
  });
});
