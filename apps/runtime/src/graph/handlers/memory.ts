// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `memory` node type handler.
 *
 * Extracted from the former monolithic `node-handlers.ts` (ADR-0004). A memory
 * node recalls long-term memories for the user/tenant scope and injects them as
 * a personalisation system message.
 */
import { SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import type { FlowNode } from "../../types/flow.js";
import { getRuntime, lastUserQuery } from "../exec-runtime.js";
import { resolveMemoryScope } from "../memory-store.js";
import type { AgentState } from "../graph-engine.js";

interface MemoryNodeConfig {
  /** Number of memories to recall. Default 5. */
  topK?: number;
  /** Minimum cosine similarity for a memory to be included. */
  minScore?: number;
}

/**
 * A `memory` node recalls the most relevant long-term memories for the request's
 * user/tenant scope and injects them as a personalisation system message the
 * next LLM node can use. Unlike `retrieval`, recalled memories are NOT recorded
 * as grounding sources (personalisation is not a citation requirement), so the
 * groundedness gate is unaffected. No-op when memory is disabled or the request
 * is anonymous.
 */
export function createMemoryNodeHandler(
  node: FlowNode,
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Promise<Partial<AgentState>> {
  return async (state, config): Promise<Partial<AgentState>> => {
    const runtime = getRuntime(config);
    if (runtime === undefined) return { currentNodeId: node.id };

    runtime.onNodeStart(node.id);

    if (runtime.memoryStore === undefined) return { currentNodeId: node.id };
    const scope = resolveMemoryScope(runtime.ctx);
    if (scope === undefined) return { currentNodeId: node.id }; // anonymous

    const cfg = (node.config ?? {}) as MemoryNodeConfig;
    // Precedence: node config → MEMORY_TOP_K → 5.
    //
    // The global default used to be missing entirely: `MEMORY_TOP_K` was parsed
    // into `AppConfig.memoryTopK` and then never read, so a deployment that set
    // it saw no effect and every node without an explicit `config.topK` silently
    // recalled 5 memories.
    const globalTopK = runtime.appConfig.memoryTopK;
    const topK =
      typeof cfg.topK === "number" && cfg.topK > 0
        ? Math.floor(cfg.topK)
        : typeof globalTopK === "number" && globalTopK > 0
          ? Math.floor(globalTopK)
          : 5;

    const query = lastUserQuery(state);
    if (query.trim().length === 0) return { currentNodeId: node.id };

    const memories = await runtime.memoryStore.recall(
      scope,
      query,
      topK,
      cfg.minScore,
    );

    // Surface the recall query (input) and the recalled memories (output) to
    // the live monitoring dashboard so the memory node shows meaningful detail.
    runtime.onNodeIo?.(node.id, {
      prompt: JSON.stringify({ query, topK }),
      response: JSON.stringify({
        totalMatches: memories.length,
        findings: memories.map((m) => ({
          id: m.id,
          title: m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text,
          score: m.score,
        })),
      }),
    });

    if (memories.length === 0) return { currentNodeId: node.id };

    const block = memories.map((m) => `- ${m.text}`).join("\n");
    const systemMsg = new SystemMessage({
      content:
        `Relevant context remembered from previous interactions with this ` +
        `user (use it to personalise your answer; do not repeat it verbatim):\n${block}`,
    });
    return { currentNodeId: node.id, messages: [systemMsg as BaseMessage] };
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "memory",
  emitsLifecycle: true,
  factory: (node) => createMemoryNodeHandler(node),
};
