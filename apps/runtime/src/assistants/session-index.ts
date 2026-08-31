// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/** Optional Vectorsearch projection for assistant session events and snapshots.
 * The database/session store remains authoritative; this adapter never offers a
 * local-search fallback. Failed indexing is reported to its caller but does not
 * invalidate a committed assistant turn.
 */
import type { McpWrapperService } from "../mcp/mcp-wrapper.js";
import type { AgentExecutionContext } from "../types/monitoring.js";
import type { AssistantScope } from "./types.js";

export interface AssistantSessionIndex {
  ingestEvent(input: {
    scope: AssistantScope;
    conversationId: string;
    documentId: string;
    content: string;
    kind: "event" | "snapshot";
    sequence: number;
    token: string;
  }): Promise<void>;
  search(input: {
    scope: AssistantScope;
    query: string;
    conversationId?: string;
    limit?: number;
    token: string;
  }): Promise<unknown>;
}

/** Uses the configured MCP wrapper, preserving Vectorsearch ACL and hybrid retrieval. */
export class McpAssistantSessionIndex implements AssistantSessionIndex {
  constructor(
    private readonly mcp: McpWrapperService,
    private readonly serverName = "vectorsearch",
    private readonly collection = "assistant-sessions",
  ) {}

  async ingestEvent(input: Parameters<AssistantSessionIndex["ingestEvent"]>[0]): Promise<void> {
    const context = this.context(input.scope, input.token, `session-index-${input.documentId}`);
    const metadata = {
      tenant_id: input.scope.tenantId,
      user_id: input.scope.userId,
      assistant_id: input.scope.assistantId,
      conversation_id: input.conversationId,
      sequence: input.sequence,
      kind: input.kind,
    };
    const result = await this.mcp.callTool(this.serverName, "ingest", {
      collection: this.collection,
      reference: input.documentId,
      requesting_user: input.scope.userId,
      content: input.content,
      metadata,
    }, context, { invocationId: `assistant-session:${input.documentId}` });
    if (result.isError === true) throw new Error("Vectorsearch session ingest failed.");
  }

  async search(input: Parameters<AssistantSessionIndex["search"]>[0]): Promise<unknown> {
    const result = await this.mcp.callTool(this.serverName, "search", {
      collection: this.collection,
      query: input.query,
      requesting_user: input.scope.userId,
      hybrid: true,
      limit: Math.min(Math.max(input.limit ?? 20, 1), 100),
      filter: {
        tenant_id: input.scope.tenantId,
        user_id: input.scope.userId,
        assistant_id: input.scope.assistantId,
        ...(input.conversationId !== undefined ? { conversation_id: input.conversationId } : {}),
      },
    }, this.context(input.scope, input.token, "session-search"));
    if (result.isError === true) throw new Error("Vectorsearch session search failed.");
    return result.content;
  }

  private context(scope: AssistantScope, token: string, executionId: string): AgentExecutionContext {
    return { ssoToken: token, executionId, clientId: scope.tenantId, userId: scope.userId };
  }
}
