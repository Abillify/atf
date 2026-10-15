// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-execution run state for the graph engine: the per-node Maps,
 * counters and diagnostic helpers shared by the tool-callback and
 * node-lifecycle closures. Extracted from handler-factories.ts per
 * Req 13.6 (module size); behaviour unchanged.
 */

import type { FlowDefinition } from "../../types/flow.js";
import type { RequestContext, RoutingDecision } from "../../types/monitoring.js";
import type { ChatMessage } from "../../types/openai.js";
import type {
  DebugToolCall,
  DebugToolSelection,
  DebugClassifierOutput,
  DebugNodeDiagnostic,
  DebugNodeAttemptContext,
  DebugSubflowVersion,
} from "../../types/debug-trace.js";
import type { DebugTraceStore } from "../../monitoring/debug-trace-store.js";
import { sanitizeJwtClaims } from "../../monitoring/trace-claims.js";
import type { Logger } from "../../observability/logger.js";

export interface RunStateInit {
  resolvedFlow: FlowDefinition;
  logger: Logger | undefined;
  executionId: string;
  flowId: string;
  flowVersion: string | null;
}

/**
 * Creates the mutable per-execution state object. Mutable scalars are
 * returned as fields (not captured locals) so callbacks in sibling
 * modules observe writes through the shared reference; the Maps are
 * shared by reference anyway.
 */
export function createRunState(init: RunStateInit) {
  const { resolvedFlow, logger, executionId, flowId, flowVersion } = init;

    const flowErrored = false;

    /** Track the most recently started node for tool-call attribution. */
    let lastActiveNodeId: string | undefined;
    const nodeStartTimes = new Map<string, string>();
    // Start timestamps are historical timing data, not lifecycle state. Keep a
    // separate active set until every terminal side effect (trace, progress and
    // monitoring) has completed, and coalesce concurrent end notifications.
    const activeNodeIds = new Set<string>();
    const nodeFinalizationPromises = new Map<string, Promise<void>>();
    /** Per-node execution metadata accumulated during the run for monitoring detail. */
    const nodeModels = new Map<string, string>();
    const nodeInputTokens = new Map<string, number>();
    const nodeOutputTokens = new Map<string, number>();
    /**
     * Cost a tool call REPORTED for itself (e.g. vectorsearch's embedding +
     * rerank spend), keyed by toolCallId. Takes precedence over the
     * nodeModels/estimateCost derivation in emitToolNodeEnd, since no
     * single provider/model price fits a blended embedding+rerank call.
     */
    const nodeToolCostOverride = new Map<string, number>();
    const nodeToolCalls = new Map<
      string,
      import("../../types/monitoring.js").NodeToolCall[]
    >();
    const nodePrompts = new Map<string, string>();
    const nodeResponses = new Map<string, string>();
    const nodeRoutingDecisions = new Map<string, RoutingDecision>();
    /** Sequence counter: order in which node attempts were started (1-based). */
    const nodeSequence = 0;
    const nodeSequences = new Map<string, number>();
    const nodeAttempts = new Map<string, number>();
    const nodeAttemptContexts = new Map<string, DebugNodeAttemptContext>();
    const nodeLabels = new Map<string, string>(
      (resolvedFlow.nodes ?? []).map((n) => [n.id, n.label ?? n.id]),
    );
    const nodeTypes = new Map<string, string>(
      (resolvedFlow.nodes ?? []).map((n) => [n.id, n.type]),
    );

    // -----------------------------------------------------------------------
    /**
     * Captured groundedness reports keyed by node id — read by the debug
     * trace's `upsertNode` call so `GET /monitoring/explain/:executionId`
     * (Decision-Provenance Explainability Card) can cite the exact score the
     * live `groundedness` SSE chunk already reported, instead of re-deriving
     * it (or having nothing to show once the run has finished).
     */
    const nodeGroundedness = new Map<
      string,
      import("../../types/debug-trace.js").DebugGroundedness
    >();
    // Debug trace accumulators
    // -----------------------------------------------------------------------
    const nodeFullPrompts = new Map<string, string>();
    const nodeFullResponses = new Map<string, string>();
    const nodeFullReasoning = new Map<string, string>();
    const nodeDebugToolCalls = new Map<string, DebugToolCall[]>();
    const nodeToolSelections = new Map<string, DebugToolSelection>();
    const nodeClassifications = new Map<string, DebugClassifierOutput>();
    // Per-node diagnostics timeline (retries, fallbacks, salvages, aborts) and
    // the structured error (type/details) of the first error that failed a node
    // — both surfaced in the debug trace to make failures traceable.
    const nodeDiagnostics = new Map<string, DebugNodeDiagnostic[]>();
    const recordNodeDiagnostic = (
      nodeId: string,
      diagnostic: Omit<DebugNodeDiagnostic, "at">,
    ): void => {
      const list = nodeDiagnostics.get(nodeId) ?? [];
      // Cap per node so a pathological retry storm can't grow the trace
      // unbounded (the timeline stays a summary, not a firehose).
      if (list.length < 200) {
        list.push({ at: new Date().toISOString(), ...diagnostic });
        nodeDiagnostics.set(nodeId, list);
      }
      // Diagnostics are already operator-facing and content-free by contract
      // (no prompts, tool arguments or secrets), so they can be mirrored to
      // the server log. Info-level entries stay trace-only to keep volume low.
      if (
        (diagnostic.level === "warn" || diagnostic.level === "error") &&
        logger !== undefined
      ) {
        const fields = {
          execution_id: executionId,
          flow_id: flowId,
          flow_version: flowVersion,
          node_id: nodeId,
          code: diagnostic.code,
          ...(diagnostic.details !== undefined ? { details: diagnostic.details } : {}),
        };
        if (diagnostic.level === "error") logger.error(diagnostic.message, fields);
        else logger.warn(diagnostic.message, fields);
      }
    };
    const nodeErrorInfo = new Map<
      string,
      { type?: string; details?: Record<string, unknown> }
    >();
    const clearNodeAttemptState = (nodeId: string): void => {
      nodeModels.delete(nodeId);
      nodeInputTokens.delete(nodeId);
      nodeOutputTokens.delete(nodeId);
      nodeToolCalls.delete(nodeId);
      nodePrompts.delete(nodeId);
      nodeResponses.delete(nodeId);
      nodeRoutingDecisions.delete(nodeId);
      nodeFullPrompts.delete(nodeId);
      nodeFullResponses.delete(nodeId);
      nodeFullReasoning.delete(nodeId);
      nodeDebugToolCalls.delete(nodeId);
      nodeToolSelections.delete(nodeId);
      nodeClassifications.delete(nodeId);
      nodeDiagnostics.delete(nodeId);
      nodeErrorInfo.delete(nodeId);
      nodeGroundedness.delete(nodeId);
      nodeAttemptContexts.delete(nodeId);
    };

  return {
    activeNodeIds,
    clearNodeAttemptState,
    flowErrored,
    lastActiveNodeId,
    nodeAttemptContexts,
    nodeAttempts,
    nodeClassifications,
    nodeDebugToolCalls,
    nodeDiagnostics,
    nodeErrorInfo,
    nodeFinalizationPromises,
    nodeFullPrompts,
    nodeFullReasoning,
    nodeFullResponses,
    nodeGroundedness,
    nodeInputTokens,
    nodeLabels,
    nodeModels,
    nodeOutputTokens,
    nodePrompts,
    nodeResponses,
    nodeRoutingDecisions,
    nodeSequence,
    nodeSequences,
    nodeStartTimes,
    nodeToolCalls,
    nodeToolCostOverride,
    nodeToolSelections,
    nodeTypes,
    recordNodeDiagnostic,
  };
}

export type NodeRunState = ReturnType<typeof createRunState>;

/**
 * Opens the debug trace for an execution (no-op without a debug store).
 * The threaded-history reconciliation result is patched on later via
 * annotateContext, once the thread lock is held.
 */
export function startDebugTrace(deps: {
  getDebugStore: () => DebugTraceStore | undefined;
  executionId: string;
  flowId: string;
  flowVersion: string | null;
  flowDigest?: string | null;
  subflowVersions?: DebugSubflowVersion[];
  ctx: RequestContext;
  messages: ChatMessage[];
}) {
  const {
    getDebugStore,
    executionId,
    flowId,
    flowVersion,
    flowDigest,
    subflowVersions,
    ctx,
    messages,
  } = deps;
    const debugStore = getDebugStore();
    if (debugStore !== undefined) {
      debugStore.startTrace({
        execution_id: executionId,
        flow_id: flowId,
        flow_version: flowVersion,
        ...(flowDigest !== undefined ? { flow_digest: flowDigest } : {}),
        ...(subflowVersions !== undefined && subflowVersions.length > 0
          ? { subflow_versions: subflowVersions }
          : {}),
        status: "running",
        started_at: new Date().toISOString(),
        finished_at: null,
        context: {
          ...(ctx.chatId !== undefined ? { chat_id: ctx.chatId } : {}),
          ...(ctx.sessionId !== undefined ? { session_id: ctx.sessionId } : {}),
          ...(ctx.messageId !== undefined ? { message_id: ctx.messageId } : {}),
          ...(ctx.userId !== undefined ? { user_id: ctx.userId } : {}),
          ...(ctx.userEmail !== undefined ? { user_email: ctx.userEmail } : {}),
          ...(ctx.userName !== undefined ? { user_name: ctx.userName } : {}),
          ...(ctx.clientId !== undefined ? { client_id: ctx.clientId } : {}),
          ...(ctx.language !== undefined ? { language: ctx.language } : {}),
          ...(ctx.role !== undefined ? { role: ctx.role } : {}),
          ...(ctx.plan !== undefined ? { plan: ctx.plan } : {}),
          ...(ctx.claims !== undefined
            ? { jwt_claims: sanitizeJwtClaims(ctx.claims) }
            : {}),
          ...(ctx.traceContext !== undefined
            ? { trace_id: ctx.traceContext.traceId }
            : {}),
        },
        input_messages: messages.map((m) => ({
          role: m.role as "system" | "user" | "assistant" | "tool",
          content: m.content,
          ...(m.tool_call_id !== undefined
            ? { tool_call_id: m.tool_call_id }
            : {}),
          ...(m.name !== undefined ? { name: m.name } : {}),
          ...(m.tool_calls !== undefined && m.tool_calls.length > 0
            ? { tool_calls: m.tool_calls }
            : {}),
        })),
        nodes: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        errors: [],
      });
    }

}
