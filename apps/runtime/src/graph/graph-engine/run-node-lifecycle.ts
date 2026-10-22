// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-node lifecycle callbacks for the graph engine execution: edge
 * data-flow capture, node start/end telemetry (monitoring, metrics,
 * spans, debug trace, flow progress), the groundedness callback and the
 * synthetic flow-end rollup marker. Extracted from handler-factories.ts
 * per Req 13.6 (module size); behaviour unchanged.
 */

import crypto from "node:crypto";
import type { FlowDefinition, FlowNode } from "../../types/flow.js";
import type { RequestContext, NodeExecutionEvent } from "../../types/monitoring.js";
import { FLOW_END_NODE_ID } from "../../types/monitoring.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { DebugNodeAttemptContext } from "../../types/debug-trace.js";
import type { OutputGuardrail } from "../output-guardrails.js";
import { classifyEdgeFlow } from "../edge-flow.js";
import type { EdgeFlowCounters } from "../edge-flow.js";
import type { GroundednessReport } from "../groundedness.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { ExecutionEventMeta } from "../../monitoring/execution-store.js";
import type { DebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { Metrics } from "../../observability/metrics.js";
import { estimateCost } from "../../observability/cost.js";
import type { FlowSpanManager } from "./spans.js";
import type { SseEmitter } from "./sse-emitter.js";
import type { CitationRegistry } from "./citation-registry.js";
import type { HashedImageRefRegistry } from "../image-reference.js";
import { cascadeSummary, providerAttemptsSummary } from "./tool-usage.js";
import type { AgentState } from "./state.js";
import type { NodeRunState } from "./run-state.js";
import { nodeStateKey } from "./node-instance.js";

/**
 * Creates the per-execution node lifecycle callbacks. Deps are
 * destructured into locals with the same names the closures used before
 * the extraction; the debug store is a getter because setDebugStore may
 * replace it after the callbacks are created.
 */
export function createNodeLifecycle(deps: {
  monitoring: MonitoringServiceInterface | undefined;
  monitoringMeta: ExecutionEventMeta;
  executionId: string;
  flowId: string;
  model: string;
  ctx: RequestContext;
  st: NodeRunState;
  userPromptPreview: string | undefined;
  resolvedFlow: FlowDefinition;
  sse: SseEmitter;
  citations: CitationRegistry;
  guardrail: OutputGuardrail | undefined;
  metrics: Metrics;
  spanManager: FlowSpanManager;
  pricingOverrides: FlowDefinition["pricing"];
  flowProgressEnabled: boolean;
  formatProgressDuration: (elapsedMs: number) => string;
  emitReasoningStep: (text: string) => Promise<void>;
  onChunk: (chunk: ChatCompletionChunk) => Promise<void>;
  runImageRefs: HashedImageRefRegistry | undefined;
  getDebugStore: () => DebugTraceStore | undefined;
}) {
  const {
    monitoring,
    monitoringMeta,
    executionId,
    flowId,
    model,
    ctx,
    st,
    userPromptPreview,
    resolvedFlow,
    sse,
    citations,
    guardrail,
    metrics,
    spanManager,
    pricingOverrides,
    flowProgressEnabled,
    formatProgressDuration,
    emitReasoningStep,
    onChunk,
    runImageRefs,
    getDebugStore,
  } = deps;
  const {
    nodeStartTimes,
    activeNodeIds,
    nodeFinalizationPromises,
    nodeModels,
    nodeInputTokens,
    nodeOutputTokens,
    nodeToolCalls,
    nodePrompts,
    nodeResponses,
    nodeRoutingDecisions,
    nodeSequences,
    nodeAttempts,
    nodeAttemptContexts,
    nodeLabels,
    nodeTypes,
    nodeFullPrompts,
    nodeFullResponses,
    nodeFullReasoning,
    nodeDebugToolCalls,
    nodeToolSelections,
    nodeClassifications,
    nodeDiagnostics,
    nodeErrorInfo,
    nodeGroundedness,
    nodeProgress,
  } = st;
  /**
   * Execution-state keys currently started per node id. A delegation
   * instance lives under `nodeId#instance`; terminal callbacks that arrive
   * with the plain node id (stream loop, timeout cleanup) finalize every
   * key still live for that node. Without instances each node id maps to
   * exactly `{ nodeId }`, i.e. the behaviour before instance keying.
   */
  const stateKeysByNodeId = new Map<string, Set<string>>();
  /** Reverse lookup for callbacks that pass a state key instead of a node id. */
  const nodeIdByStateKey = new Map<string, string>();

    // --- Groundedness callback.
    const onGroundedness = async (
      nodeId: string,
      report: GroundednessReport,
      instance?: string,
    ): Promise<void> => {
      nodeGroundedness.set(nodeStateKey(nodeId, instance), {
        score: report.score,
        passed: report.passed,
        checked_sentences: report.checkedSentences,
        unsupported: report.unsupported.map((u) => ({
          sentence: u.sentence,
          support: u.support,
        })),
      });
      await onChunk({
        id: crypto.randomUUID(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: null }, finish_reason: null }],
        groundedness: {
          node_id: nodeId,
          score: report.score,
          passed: report.passed,
          checked_sentences: report.checkedSentences,
          unsupported: report.unsupported.map((u) => ({
            sentence: u.sentence,
            support: u.support,
          })),
        },
      } as ChatCompletionChunk);
    };
    // Edge data-flow capture (Studio canvas: solid active edges + colored
    // channel lines + payload list in the property panel).
    //
    // `withNodeErrorStrategy` (compile.ts) calls `onNodeEntry` at the start of
    // every graph-node execution. At that moment `state.currentNodeId` is the
    // node that ran immediately before (every handler returns it), so the state
    // the node received is exactly the payload that crossed the edge
    // currentNodeId → this node. The first node of a run has no predecessor in
    // the state — its incoming edge starts at `__start__`.
    //
    // Capturing at node ENTRY (rather than at routing decisions) covers
    // conditional and unconditional edges uniformly, including parallel
    // fan-out, and needs no edge-topology bookkeeping in the stream loop.
    // The final edge into `__end__` is recorded after the stream loop from the
    // last node's entry baseline.
    // ---------------------------------------------------------------------
    const edgeFlowNodeMap = new Map<string, FlowNode>(
      (resolvedFlow.nodes ?? []).map((n) => [n.id, n]),
    );
    /** Per-node counters captured at entry — the "produced since" baseline. */
    const edgeFlowBaselines = new Map<string, EdgeFlowCounters>();
    /** Global edge traversal counter (1-based). */
    let edgeSequence = 0;
    let edgeFlowInspectionAnnounced = false;
    let edgeFlowImagesConsumed = false;
    /** Id of the node that consumed the run's images (vision/transcription). */
    let edgeFlowImageConsumerId: string | undefined;
    const countersOf = (
      state: AgentState,
    ): EdgeFlowCounters => ({
      messageCount: (state.messages ?? []).length,
      toolResultCount: (state.toolResults ?? []).length,
      citationCount: (state.citations ?? []).length,
      imageRefCount: runImageRefs?.list().length ?? 0,
      classificationJson:
        state.classification && Object.keys(state.classification).length > 0
          ? JSON.stringify(state.classification)
          : "",
    });
    const recordEdge = (
      source: string,
      target: string,
      state: AgentState,
      baseline: EdgeFlowCounters | undefined,
    ): void => {
      const debugStore = getDebugStore();
      if (debugStore === undefined) return;
      edgeSequence += 1;
      const result = classifyEdgeFlow({
        source,
        target,
        sequence: edgeSequence,
        state,
        baseline,
        nodeMap: edgeFlowNodeMap,
        imageRefs: runImageRefs?.list() ?? [],
        inspectionToolAnnounced: edgeFlowInspectionAnnounced,
        imageConsumedUpstream: edgeFlowImagesConsumed,
        imageConsumerId: edgeFlowImageConsumerId,
        // Req 7.12: the debug trace is a persisted copy of what crossed the
        // edge — while output redaction is active it must not hold raw PII.
        // The SAME effective guardrail as the SSE stream applies (per-flow
        // override already resolved into `guardrail`); content the PII vault
        // has already tokenized (`[[PII:...]]`) matches no detector and passes
        // through, so tokenization is respected rather than double-processed.
        ...(guardrail !== undefined
          ? { redact: (text: string): string => guardrail.redact(text).text }
          : {}),
      });
      edgeFlowInspectionAnnounced = result.inspectionToolAnnounced;
      edgeFlowImagesConsumed = result.imageConsumedUpstream;
      edgeFlowImageConsumerId = result.imageConsumerId;
      debugStore.upsertEdgeFlow(executionId, result.record);
    };
    const captureEdgeFlow = (
      nodeId: string,
      state: AgentState,
    ): void => {
      if (getDebugStore() === undefined) return;
      const source = state.currentNodeId ?? "__start__";
      // The first node of a run has no graph predecessor: its incoming edge
      // starts at `__start__`. Nothing was "produced" by the start itself —
      // the baseline is the entry state, so only the query/images/tools show
      // as passed along (threaded checkpoints carry old AI messages, which
      // must NOT masquerade as freshly produced content).
      const baseline =
        source === "__start__" ? countersOf(state) : edgeFlowBaselines.get(source);
      recordEdge(source, nodeId, state, baseline);
      // Baseline for what THIS node produces: counters of the state it
      // received (its own writes land after this point).
      edgeFlowBaselines.set(nodeId, countersOf(state));
    };
    /** Marks an execution-state key as live for its node id. */
    const registerStateKey = (nodeId: string, stateKey: string): void => {
      nodeIdByStateKey.set(stateKey, nodeId);
      const keys = stateKeysByNodeId.get(nodeId);
      if (keys === undefined) {
        stateKeysByNodeId.set(nodeId, new Set([stateKey]));
      } else {
        keys.add(stateKey);
      }
    };
    /** Removes an execution-state key from the live registry. */
    const unregisterStateKey = (nodeId: string, stateKey: string): void => {
      nodeIdByStateKey.delete(stateKey);
      const keys = stateKeysByNodeId.get(nodeId);
      if (keys === undefined) return;
      keys.delete(stateKey);
      if (keys.size === 0) stateKeysByNodeId.delete(nodeId);
    };
    const onNodeStart = (
      nodeId: string,
      context?: DebugNodeAttemptContext,
      instance?: string,
    ): void => {
      const stateKey = nodeStateKey(nodeId, instance);
      // Delegation can announce a target immediately before the target handler
      // announces itself. Both callbacks describe the same live attempt: a key
      // that is already live is ignored, and a start without an instance joins
      // the node that is already active.
      if (nodeIdByStateKey.has(stateKey)) return;
      if (instance === undefined && activeNodeIds.has(nodeId)) return;

      st.clearNodeAttemptState(stateKey);
      nodeAttemptContexts.set(stateKey, context ?? { trigger: "graph-lifecycle" });
      const attempt = (nodeAttempts.get(stateKey) ?? 0) + 1;
      nodeAttempts.set(stateKey, attempt);
      const startTime = new Date().toISOString();
      nodeStartTimes.set(stateKey, startTime);
      activeNodeIds.add(nodeId);
      registerStateKey(nodeId, stateKey);
      st.lastActiveNodeId = nodeId;
      st.nodeSequence += 1;
      nodeSequences.set(stateKey, st.nodeSequence);

      const nodeType = nodeTypes.get(nodeId);
      const progress = (
        resolvedFlow.nodes.find((node) => node.id === nodeId)?.config as
          | {
              progress?: {
                start?: unknown;
                complete?: unknown;
                error?: unknown;
              };
            }
          | undefined
      )?.progress;
      const progressStart =
        typeof progress?.start === "string" && progress.start.trim().length > 0
          ? progress.start.trim()
          : undefined;
      if (nodeType !== "router" && nodeType !== "parallel") {
        const label = progressStart ?? nodeLabels.get(nodeId) ?? nodeId;
        const icon =
          nodeType === "classifier"
            ? "🧭"
            : nodeType === "retrieval"
              ? "📚"
              : nodeType === "memory"
                ? "🧠"
                : nodeType === "tool"
                  ? "🔧"
                  : "⚙️";
        void emitReasoningStep(`${icon} ${label}…\n`);
      }
      spanManager.startNodeSpan(nodeId);
      // Live progress in the debug trace: register the node as "running" the
      // moment it starts, so GET /monitoring/debug/:id shows what a long run
      // is doing right now instead of only the nodes that already finished.
      // The final upsert from emitNodeEnd replaces this stub (same attempt
      // number); a retried attempt appends its own entry.
      getDebugStore()?.upsertNode(executionId, {
        node_id: nodeId,
        ...(instance !== undefined ? { instance_id: instance } : {}),
        ...(nodeTypes.has(nodeId) ? { node_type: nodeTypes.get(nodeId) } : {}),
        status: "running",
        started_at: startTime,
        finished_at: null,
        latency_ms: null,
        ...(nodeAttempts.has(stateKey)
          ? { attempt: nodeAttempts.get(stateKey) }
          : {}),
        ...(nodeSequences.has(stateKey)
          ? { sequence: nodeSequences.get(stateKey) }
          : {}),
        tool_calls: [],
      });
      monitoring?.emitNodeEvent(
        executionId,
        {
          execution_id: executionId,
          node_id: nodeId,
          status: "running",
          start_time: startTime,
          end_time: null,
          latency_ms: null,
          label: nodeLabels.get(nodeId),
          ...(nodeSequences.has(stateKey)
            ? { sequence: nodeSequences.get(stateKey) }
            : {}),
          ...(ctx.userName !== undefined ? { user_name: ctx.userName } : {}),
          ...(userPromptPreview !== undefined
            ? { user_prompt: userPromptPreview }
            : {}),
          flow_id: flowId,
        },
        monitoringMeta,
      );
    };

    const finalizeNode = (
      nodeId: string,
      stateKey: string,
      errorMessage?: string,
    ): Promise<void> => {
      const existingFinalization = nodeFinalizationPromises.get(stateKey);
      if (existingFinalization !== undefined) return existingFinalization;
      // The trace names the delegation instance the state belongs to; the
      // plain node id stays the identity of the flow node itself.
      const separator = stateKey.indexOf("#");
      const instanceId =
        separator >= 0 ? stateKey.slice(separator + 1) : undefined;

      const finalization = (async (): Promise<void> => {
        const startTime =
          nodeStartTimes.get(stateKey) ?? new Date().toISOString();
        const latencyMs = Date.now() - new Date(startTime).getTime();

        let nodeCost: number | undefined;
      const nodeModelKey = nodeModels.get(stateKey);
      if (
        nodeModelKey !== undefined &&
        (nodeInputTokens.has(stateKey) || nodeOutputTokens.has(stateKey))
      ) {
        const slash = nodeModelKey.indexOf("/");
        const provider = slash >= 0 ? nodeModelKey.slice(0, slash) : "";
        const modelName =
          slash >= 0 ? nodeModelKey.slice(slash + 1) : nodeModelKey;
        nodeCost = estimateCost(
          provider,
          modelName,
          {
            prompt_tokens: nodeInputTokens.get(stateKey) ?? 0,
            completion_tokens: nodeOutputTokens.get(stateKey) ?? 0,
          },
          pricingOverrides,
        );
      }

      // Release any ref-handle hold-back tail BEFORE the guardrail flush so
      // the released text still passes through the guardrail stream (whose own
      // tail flush follows). No-op when the flow has no refHandles.
      await sse.flushRefHandlesForNode(nodeId);

      if (guardrail !== undefined) {
        const findings = await sse.flushGuardrailForNode(nodeId);
        for (const [type, count] of Object.entries(findings)) {
          metrics.recordGuardrail(type, count);
        }
      }

      metrics.recordNode(
        flowId,
        nodeId,
        errorMessage !== undefined ? "error" : "completed",
        latencyMs,
      );
      spanManager.endNodeSpan(
        nodeId,
        errorMessage !== undefined ? "error" : "ok",
        errorMessage,
        { "aiperator.latency_ms": latencyMs },
      );
      if (errorMessage !== undefined) st.flowErrored = true;

      // Citation safety net: sources were registered (and streamed to the
      // client) but this node's answer references none of them via `[n]`. The
      // client filter maps citations ONLY from `[n]` markers, so such an answer
      // shows zero citations even though the source panel was filled — a silent
      // regression that unit tests cannot catch. Surfaced as a trace diagnostic
      // (no behaviour change) so it is visible in the execution trace.
      if (errorMessage === undefined && citations.size > 0) {
        const nodeType = nodeTypes.get(nodeId);
        const responseText = nodeFullResponses.get(stateKey);
        if (
          (nodeType === "llm" || nodeType === "agent-harness") &&
          typeof responseText === "string" &&
          responseText.trim().length > 0
        ) {
          const markers = [...responseText.matchAll(/\[(\d+)\]/g)].map(
            (match) => Number(match[1]),
          );
          if (markers.length === 0) {
            st.recordNodeDiagnostic(stateKey, {
              level: "warn",
              code: "answer_without_citation_markers",
              message:
                `${citations.size} source(s) were registered for this stream, but ` +
                "the node response contains no [n] citation marker — the client " +
                "will display no citations.",
              details: {
                registered_sources: citations.size,
                response_chars: responseText.length,
              },
            });
          } else {
            // A marker outside 1..registered is one the model invented (or
            // carried over from a stale numbering): the client renders it as
            // a dead reference. Round 1 showed exactly this — `[151]` cited
            // while far fewer sources existed.
            const outOfRange = [
              ...new Set(
                markers.filter(
                  (n) => !Number.isFinite(n) || n < 1 || n > citations.size,
                ),
              ),
            ].sort((a, b) => a - b);
            if (outOfRange.length > 0) {
              st.recordNodeDiagnostic(stateKey, {
                level: "warn",
                code: "citation_marker_out_of_range",
                message:
                  `The node response cites [n] markers outside the registered ` +
                  `range 1..${citations.size}: ${outOfRange
                    .map((n) => `[${n}]`)
                    .join(
                      ", ",
                    )} — those citations are unresolvable for the client.`,
                details: {
                  registered_sources: citations.size,
                  out_of_range_markers: outOfRange,
                  response_chars: responseText.length,
                },
              });
            }
          }
        }
      }

      const debugStore = getDebugStore();
      if (debugStore !== undefined) {
        const errInfo = nodeErrorInfo.get(stateKey);
        debugStore.upsertNode(executionId, {
          node_id: nodeId,
          ...(instanceId !== undefined ? { instance_id: instanceId } : {}),
          ...(nodeTypes.has(nodeId)
            ? { node_type: nodeTypes.get(nodeId) }
            : {}),
          status: errorMessage !== undefined ? "error" : "completed",
          started_at: startTime,
          finished_at: new Date().toISOString(),
          latency_ms: latencyMs,
          ...(nodeAttempts.has(stateKey)
            ? { attempt: nodeAttempts.get(stateKey) }
            : {}),
          ...(providerAttemptsSummary(nodeDiagnostics.get(stateKey)) ?? {}),
          ...(cascadeSummary(nodeDiagnostics.get(stateKey)) ?? {}),
          ...(nodeAttemptContexts.has(stateKey)
            ? {
                attempt_trigger: nodeAttemptContexts.get(stateKey)?.trigger,
                ...(nodeAttemptContexts.get(stateKey)?.parent_node_id !==
                undefined
                  ? {
                      parent_node_id:
                        nodeAttemptContexts.get(stateKey)?.parent_node_id,
                    }
                  : {}),
                ...(nodeAttemptContexts.get(stateKey)?.delegation_id !==
                undefined
                  ? {
                      delegation_id:
                        nodeAttemptContexts.get(stateKey)?.delegation_id,
                    }
                  : {}),
              }
            : {}),
          ...(nodeSequences.has(stateKey)
            ? { sequence: nodeSequences.get(stateKey) }
            : {}),
          ...(nodeModels.has(stateKey)
            ? { model: nodeModels.get(stateKey) }
            : {}),
          ...(nodeInputTokens.has(stateKey)
            ? { input_tokens: nodeInputTokens.get(stateKey) }
            : {}),
          ...(nodeOutputTokens.has(stateKey)
            ? { output_tokens: nodeOutputTokens.get(stateKey) }
            : {}),
          ...(nodeCost !== undefined ? { cost: nodeCost } : {}),
          ...(nodeFullPrompts.has(stateKey)
            ? { full_prompt: nodeFullPrompts.get(stateKey) }
            : {}),
          ...(nodeFullResponses.has(stateKey)
            ? { full_response: nodeFullResponses.get(stateKey) }
            : {}),
          ...(nodeFullReasoning.has(stateKey)
            ? { full_reasoning: nodeFullReasoning.get(stateKey) }
            : {}),
          ...(nodeGroundedness.has(stateKey)
            ? { groundedness: nodeGroundedness.get(stateKey) }
            : {}),
          ...(nodeProgress.has(stateKey)
            ? { progress: nodeProgress.get(stateKey) }
            : {}),
          tool_calls: nodeDebugToolCalls.get(stateKey) ?? [],
          ...(nodeToolSelections.has(stateKey)
            ? { tool_selection: nodeToolSelections.get(stateKey) }
            : {}),
          ...(nodeClassifications.has(stateKey)
            ? { classifier: nodeClassifications.get(stateKey) }
            : {}),
          ...(nodeDiagnostics.has(stateKey)
            ? { diagnostics: nodeDiagnostics.get(stateKey) }
            : {}),
          ...(errorMessage !== undefined
            ? { error_message: errorMessage }
            : {}),
          ...(errorMessage !== undefined && errInfo?.type !== undefined
            ? { error_type: errInfo.type }
            : {}),
          ...(errorMessage !== undefined && errInfo?.details !== undefined
            ? { error_details: errInfo.details }
            : {}),
        });
      }
      if (flowProgressEnabled) {
        const progress = (
          resolvedFlow.nodes.find((node) => node.id === nodeId)?.config as
            | {
                progress?: {
                  complete?: unknown;
                  error?: unknown;
                };
              }
            | undefined
        )?.progress;
        const message =
          errorMessage !== undefined
            ? (typeof progress?.error === "string" && progress.error.trim().length > 0
                ? progress.error.trim()
                : `${nodeLabels.get(nodeId) ?? nodeId} fehlgeschlagen`)
            : (typeof progress?.complete === "string" &&
                  progress.complete.trim().length > 0
                ? progress.complete.trim()
                : `${nodeLabels.get(nodeId) ?? nodeId} abgeschlossen`);
        await emitReasoningStep(
          `⚙️ ${message} · ${formatProgressDuration(latencyMs)}\n`,
        );
      }
      if (!monitoring) return;
      const event: NodeExecutionEvent = {
        execution_id: executionId,
        node_id: nodeId,
        status: errorMessage !== undefined ? "error" : "completed",
        start_time: startTime,
        end_time: new Date().toISOString(),
        latency_ms: latencyMs,
        ...(errorMessage !== undefined ? { error_message: errorMessage } : {}),
        ...(nodeModels.has(stateKey)
          ? { model: nodeModels.get(stateKey) }
          : {}),
        ...(nodeInputTokens.has(stateKey)
          ? { input_tokens: nodeInputTokens.get(stateKey) }
          : {}),
        ...(nodeOutputTokens.has(stateKey)
          ? { output_tokens: nodeOutputTokens.get(stateKey) }
          : {}),
        ...(nodeCost !== undefined ? { cost: nodeCost } : {}),
        ...((nodeToolCalls.get(stateKey)?.length ?? 0) > 0
          ? { tool_calls: nodeToolCalls.get(stateKey) }
          : {}),
        ...(nodePrompts.has(stateKey)
          ? { prompt: nodePrompts.get(stateKey) }
          : {}),
        ...(nodeResponses.has(stateKey)
          ? { response: nodeResponses.get(stateKey) }
          : {}),
        ...(nodeRoutingDecisions.has(stateKey)
          ? { routing_decision: nodeRoutingDecisions.get(stateKey) }
          : {}),
        ...(nodeSequences.has(stateKey)
          ? { sequence: nodeSequences.get(stateKey) }
          : {}),
        label: nodeLabels.get(nodeId),
        ...(ctx.userName !== undefined ? { user_name: ctx.userName } : {}),
        ...(userPromptPreview !== undefined
          ? { user_prompt: userPromptPreview }
          : {}),
        flow_id: flowId,
      };
        monitoring.emitNodeEvent(executionId, event, monitoringMeta);
      })().finally(() => {
        // A node remains active until every terminal side effect has either
        // completed or failed. Timeout cleanup can therefore neither miss it
        // nor emit a second terminal event while finalization is in flight.
        unregisterStateKey(nodeId, stateKey);
        if (!stateKeysByNodeId.has(nodeId)) activeNodeIds.delete(nodeId);
        nodeStartTimes.delete(stateKey);
        nodeFinalizationPromises.delete(stateKey);
      });
      nodeFinalizationPromises.set(stateKey, finalization);
      return finalization;
    };

    const emitNodeEnd = (
      nodeId: string,
      errorMessage?: string,
      instance?: string,
    ): Promise<void> => {
      if (instance !== undefined) {
        const stateKey = nodeStateKey(nodeId, instance);
        if (!nodeIdByStateKey.has(stateKey)) return Promise.resolve();
        return finalizeNode(nodeId, stateKey, errorMessage);
      }
      // Terminal callbacks that name only the node finalize every execution
      // still live for it — without instances that is exactly one key, the
      // node id itself.
      const liveKeys = [
        ...(stateKeysByNodeId.get(nodeId) ?? new Set<string>([nodeId])),
      ];
      if (liveKeys.length === 0) return Promise.resolve();
      if (liveKeys.length === 1) {
        return finalizeNode(nodeId, liveKeys[0], errorMessage);
      }
      return Promise.all(
        liveKeys.map((stateKey) => finalizeNode(nodeId, stateKey, errorMessage)),
      ).then(() => undefined);
    };

    // Synthetic terminal marker for the execution rollup (see
    // FLOW_END_NODE_ID). Emitted exactly once, at the same place the debug
    // trace is sealed, so the history status flips to its real terminal value
    // only when the whole flow is done — not on the first finished node.
    let flowEndEmitted = false;
    const emitFlowEnd = (status: "completed" | "error"): void => {
      if (flowEndEmitted || monitoring === undefined) return;
      flowEndEmitted = true;
      const now = new Date().toISOString();
      monitoring.emitNodeEvent(
        executionId,
        {
          execution_id: executionId,
          node_id: FLOW_END_NODE_ID,
          status,
          start_time: now,
          end_time: now,
          latency_ms: 0,
          flow_id: flowId,
        },
        monitoringMeta,
      );
    };

  return {
    captureEdgeFlow,
    recordEdge,
    edgeFlowBaselines,
    onNodeStart,
    emitNodeEnd,
    emitFlowEnd,
    onGroundedness,
  };
}
