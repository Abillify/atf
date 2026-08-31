// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `retrieval` (RAG) node type handler.
 *
 * Extracted from the former monolithic `node-handlers.ts` (ADR-0004). A
 * retrieval node embeds the latest user query, fetches top-K chunks from a
 * vector collection, and injects them as grounding context for the next LLM.
 */
import crypto from "node:crypto";
import { SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import type { FlowNode } from "../../types/flow.js";
import type { ToolResultEntry } from "../../types/monitoring.js";
import type { Citation } from "../../types/openai.js";
import { getRuntime, lastUserQuery } from "../exec-runtime.js";
import type { AgentState } from "../graph-engine.js";

interface RetrievalNodeConfig {
  /** Vector collection to search (required for the node to do anything). */
  collection?: string;
  /** Number of chunks to retrieve. Default 4. */
  topK?: number;
  /** Minimum cosine similarity for a chunk to be included. Default none. */
  minScore?: number;
}

/**
 * A `retrieval` node embeds the latest user query, fetches the top-K most
 * similar chunks from its configured vector collection, and:
 *   - injects them as a system "context" message so the *next* LLM node can use
 *     them (provider-safe — no tool-call pairing required),
 *   - records them in `state.toolResults` so the groundedness gate can verify
 *     the answer against them, and
 *   - emits them as `citations` + tool-call/result SSE chunks for the client
 *     and the dashboard.
 *
 * No-op (with an error entry) when no embedder/vector store is wired or no
 * collection is configured — the flow still runs, just ungrounded.
 */
export function createRetrievalNodeHandler(
  node: FlowNode,
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Promise<Partial<AgentState>> {
  return async (state, config): Promise<Partial<AgentState>> => {
    const runtime = getRuntime(config);
    if (runtime === undefined) return { currentNodeId: node.id };

    runtime.onNodeStart(node.id);

    const cfg = (node.config ?? {}) as RetrievalNodeConfig;
    const collection = cfg.collection;
    const topK =
      typeof cfg.topK === "number" && cfg.topK > 0 ? Math.floor(cfg.topK) : 4;

    if (runtime.vectorStore === undefined || runtime.embedder === undefined) {
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Retrieval node "${node.id}": RAG is not configured (no vector store / embedding model).`,
            type: "execution_error",
            details: { node_id: node.id },
          },
        ],
      };
    }
    if (collection === undefined || collection.trim() === "") {
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Retrieval node "${node.id}": no "collection" set in node.config.`,
            type: "invalid_request_error",
            details: { node_id: node.id },
          },
        ],
      };
    }

    const query = lastUserQuery(state);
    if (query.trim().length === 0) {
      return { currentNodeId: node.id };
    }

    const toolCallId = crypto.randomUUID();
    try {
      await runtime.onToolCall(
        toolCallId,
        `retrieval/${collection}`,
        JSON.stringify({ collection, topK }),
      );
      const startMs = Date.now();
      const vector = await runtime.embedder.embed(query);
      const chunks = await runtime.vectorStore.query(
        collection,
        vector,
        topK,
        cfg.minScore,
      );
      const execTimeSec = (Date.now() - startMs) / 1000;

      await runtime.onToolResult(
        toolCallId,
        { collection, retrieved: chunks.length, chunks },
        execTimeSec,
      );

      // Surface the query (input) + findings (output) to the live monitoring
      // dashboard so the retrieval node shows what it searched for and what it
      // found (id/title/score), not just its timing/cost.
      runtime.onNodeIo?.(node.id, {
        prompt: query,
        response: JSON.stringify({
          collection,
          totalMatches: chunks.length,
          findings: chunks.map((c) => {
            const md = c.metadata ?? {};
            const title =
              typeof md.title === "string" ? (md.title as string) : undefined;
            return {
              id: c.id,
              ...(title !== undefined ? { title } : {}),
              score: c.score,
            };
          }),
        }),
      });

      // Emit a reasoning step so Open WebUI shows RAG retrieval in the thinking block
      try {
        await runtime.onReasoning(
          node.id,
          `📚 RAG **${collection}**: ${chunks.length} document${chunks.length !== 1 ? "s" : ""} found (${execTimeSec.toFixed(1)}s)\n`,
        );
      } catch {
        /* non-critical */
      }

      if (chunks.length === 0) {
        return {
          currentNodeId: node.id,
          toolResults: [
            {
              tool_call_id: toolCallId,
              tool_name: `retrieval/${collection}`,
              result: { collection, retrieved: 0 },
              execution_time_seconds: Math.round(execTimeSec * 1000) / 1000,
            },
          ],
        };
      }

      // Build a grounding context system message the next LLM node will see.
      const contextBlock = chunks
        .map((c, i) => `[${i + 1}] ${c.text}`)
        .join("\n\n");
      const systemMsg = new SystemMessage({
        content:
          `Use ONLY the following retrieved context to answer the user's ` +
          `question, and cite sources as [n]. If the context is insufficient, ` +
          `say so explicitly.\n\n${contextBlock}`,
      });

      const citations: Citation[] = chunks.map((c, i) => {
        const md = c.metadata ?? {};
        const title =
          typeof md.title === "string"
            ? (md.title as string)
            : `Source ${i + 1}`;
        const url = typeof md.url === "string" ? (md.url as string) : "";
        return {
          title,
          url,
          snippet: c.text.slice(0, 500),
          similarity_score: Math.max(0, Math.min(1, c.score)),
        };
      });

      const toolResults: ToolResultEntry[] = [
        {
          tool_call_id: toolCallId,
          tool_name: `retrieval/${collection}`,
          // Stored as JSON; the groundedness gate stringifies this so the chunk
          // text becomes part of the verifiable source set.
          result: {
            collection,
            retrieved: chunks.length,
            chunks: chunks.map((c) => ({
              id: c.id,
              text: c.text,
              score: c.score,
            })),
          },
          execution_time_seconds: Math.round(execTimeSec * 1000) / 1000,
        },
      ];

      // Stream the retrieved sources (already in [n] order) so the Open WebUI
      // citation filter can render the ones the answer references as native
      // citations.
      try {
        await runtime.onCitations?.(citations);
      } catch {
        /* ignore client disconnect */
      }

      return {
        currentNodeId: node.id,
        messages: [systemMsg as BaseMessage],
        toolResults,
        citations,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Close the synthetic tool node as errored — the throw skipped
      // onToolResult, which would otherwise emit its terminal event.
      await runtime.onToolError?.(toolCallId, errMsg, 0);
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Retrieval node "${node.id}" failed: ${errMsg}`,
            type: "execution_error",
            details: { node_id: node.id },
          },
        ],
      };
    }
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "retrieval",
  emitsLifecycle: true,
  factory: (node) => createRetrievalNodeHandler(node),
};
