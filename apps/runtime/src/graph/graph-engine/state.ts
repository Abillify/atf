// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graph Engine — AgentState definition and related types.
 *
 * Contains the LangGraph state annotation (AgentStateAnnotation), the derived
 * AgentState type, the compiled graph type alias, and the GraphEngineService
 * interface.
 */

import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { CompiledStateGraph } from "@langchain/langgraph";
import type {
  RequestContext,
  ToolResultEntry,
} from "../../types/monitoring.js";
import type {
  StreamError,
  ChatCompletionChunk,
  ChatMessage,
  Citation,
  TokenUsage,
} from "../../types/openai.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { FlowGuardrailOverride } from "../flow-guardrail-resolver.js";
import type { HarnessProgress } from "../agent-harness.js";
import { mergeHarnessProgress } from "../agent-harness.js";
import type { DebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { TurnSnapshot } from "../classification-access.js";

// ---------------------------------------------------------------------------
// AgentState Annotation (LangGraph)
// ---------------------------------------------------------------------------

export const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left: BaseMessage[], right: BaseMessage | BaseMessage[]) =>
      left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  context: Annotation<RequestContext>(),
  citations: Annotation<Citation[]>({
    reducer: (left: Citation[], right: Citation | Citation[]) =>
      left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  toolResults: Annotation<ToolResultEntry[]>({
    reducer: (
      left: ToolResultEntry[],
      right: ToolResultEntry | ToolResultEntry[],
    ) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  errors: Annotation<StreamError[]>({
    reducer: (left: StreamError[], right: StreamError | StreamError[]) =>
      left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  currentNodeId: Annotation<string | undefined>(),
  /**
   * Structured output from the most recent `classifier` node.
   * Used by routing conditions and dynamic override resolution.
   * LastValue semantics — later writes win.
   */
  classification: Annotation<Record<string, unknown>>({
    default: () => ({}),
    reducer: (_left: Record<string, unknown>, right: Record<string, unknown>) =>
      right,
  }),
  /**
   * The routing label extracted from classification.classKey.
   * Exposed in condition expressions as `classLabel`.
   */
  classLabel: Annotation<string>({
    default: () => "",
    reducer: (_left: string, right: string) => right,
  }),
  /**
   * Non-destructive per-turn history of EVERY classifier node's output.
   * `turns[i]` is one run's snapshot (`{ [nodeId]: {classification, classLabel} }`);
   * the array grows by one snapshot per conversation turn (persisted across
   * turns by the checkpointer in threaded mode). Unlike `classification` /
   * `classLabel` (LastValue "most recent" pointers), this preserves the output
   * of earlier classifiers in the same run AND of previous turns. Backs the
   * `node.<id>.classification.<field>` and `turn[<n>].<id>.classification.<field>`
   * accessors. The classifier handler computes the full next value from
   * `state.turns` via {@link appendNodeClassification}, so the reducer replaces.
   */
  turns: Annotation<TurnSnapshot[]>({
    default: () => [],
    reducer: (_left: TurnSnapshot[], right: TurnSnapshot[]) => right,
  }),
  /**
   * Document refs (base_ref/url/title) already shown to the responder in
   * EARLIER turns of this conversation. Accumulated + capped by the rag-context
   * node, which down-weights already-seen documents in later turns' retrieval
   * fusion (see rag-followup). Persisted across turns by the checkpointer in
   * threaded mode; empty (no effect) without a conversation_id. The node
   * computes the full next value from state, so the reducer replaces.
   */
  seenDocRefs: Annotation<string[]>({
    default: () => [],
    reducer: (_left: string[], right: string[]) => right,
  }),
  /**
   * Progress record for the agent-harness node.
   * Merged incrementally by task id; scalars take the newer value.
   */
  harness: Annotation<HarnessProgress | undefined>({
    default: () => undefined,
    reducer: mergeHarnessProgress,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

// ---------------------------------------------------------------------------
// Compiled graph type alias
// ---------------------------------------------------------------------------

export type CompiledAgentGraph = CompiledStateGraph<
  AgentState,
  typeof AgentStateAnnotation.Update,
  string
>;

// ---------------------------------------------------------------------------
// GraphEngineService interface
// ---------------------------------------------------------------------------

export interface GraphEngineService {
  buildGraph(
    flow: FlowDefinition,
    knownToolIds?: Set<string>,
  ): CompiledAgentGraph;
  executeFlow(
    flowId: string,
    messages: ChatMessage[],
    ctx: RequestContext,
    onChunk: (chunk: ChatCompletionChunk) => Promise<void>,
    onDone: (usage: TokenUsage) => Promise<void>,
    monitoring?: MonitoringServiceInterface,
    guardrailOverride?: FlowGuardrailOverride,
    onFinalResponse?: (response: string) => void | Promise<void>,
  ): Promise<void>;
  invalidateCache(flowId: string): void;
  /**
   * Backpressure pre-check. Returns false when accepting another execution
   * would exceed the bounded wait-queue, so callers can reject with HTTP 503
   * before opening a stream. A best-effort gate; the semaphore enforces the
   * hard bound.
   */
  hasCapacity(): boolean;
  /** Current concurrency/queue state (for metrics and diagnostics). */
  getQueueState(): {
    active: number;
    waiting: number;
    available: number;
    queueLimit: number;
  };
  /**
   * Attaches a debug trace store to the engine. When set, every execution
   * captures a full, untruncated trace (prompts, responses, tool calls with
   * results, RAG chunks, tool selection decisions) retrievable via
   * GET /monitoring/debug/:executionId.
   */
  setDebugStore?(store: DebugTraceStore): void;
  /**
   * Hot-updates the declarative tool authorization engine. Called when the
   * `tool-authz.json` policy file changes so new rules apply without a restart.
   */
  setToolAuthzEngine?(engine: import("../tool-authz.js").ToolAuthzEngine): void;
  /**
   * Hot-updates the declarative compliance policy (ADR-0009). Called when
   * `compliance-policy.yaml` changes so new `approvalRules` apply without a
   * restart. Pass `undefined` to clear an unloaded/removed policy.
   */
  setCompliancePolicy?(
    policy: import("../../compliance/policy-schema.js").CompliancePolicy | undefined,
  ): void;
}
