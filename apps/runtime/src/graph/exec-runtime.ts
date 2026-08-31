// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Execution runtime contract + stateless handler helpers
 * (`src/graph/exec-runtime.ts`)
 *
 * Extracted from `graph-engine.ts` to break up that god-file and give the node
 * handler factories (`src/graph/handlers/*`) and the agent harness a single,
 * dependency-light module to import from. This module owns:
 *
 *   - the per-request {@link ExecRuntime} contract injected via the LangGraph
 *     `RunnableConfig.configurable` and {@link getRuntime} to read it back, and
 *   - the pure, engine-agnostic helpers the handlers share (SSE chunk
 *     factories, system-message sanitisation, context placeholder resolution,
 *     citation de-duplication, JSON extraction, classifier fallback, and small
 *     state readers).
 *
 * It deliberately holds NO engine state and NO graph-compilation logic — only
 * the contract and pure functions. It imports `AgentState` from `graph-engine`
 * as a TYPE only (erased at compile time), so there is no runtime import cycle:
 * `graph-engine` and `handlers/*` value-import from here; nothing here
 * value-imports back.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { LanguageModel, ModelMessage } from "ai";
import type { FlowNode, LlmConfig } from "../types/flow.js";
import type { RequestContext, RoutingDecision } from "../types/monitoring.js";
import type {
  StreamError,
  ChatCompletionChunk,
  Citation,
  CitationSource,
} from "../types/openai.js";
import type { AppConfig } from "../config/index.js";
import {
  renderTemplateNamespaced,
  type TurnSnapshot,
} from "./classification-access.js";
import type { McpWrapperService } from "../mcp/mcp-wrapper.js";
import type { ResponseCache } from "./response-cache.js";
import type { SemanticCache, Embedder } from "./semantic-cache.js";
import type { VectorStore } from "./vector-store.js";
import type { Reranker } from "./reranker.js";
import type { ToolIndex } from "./tool-index.js";
import type { ToolGroupSummarizer } from "./tool-group-summary.js";
import type { MemoryStore } from "./memory-store.js";
import type { ToolEgressGuardrail } from "./output-guardrails.js";
import type { ApprovalRegistry, PendingApproval } from "./approval-gate.js";
import type { GroundednessGate, GroundednessReport } from "./groundedness.js";
import type { ModelQualityRegistry } from "./model-quality.js";
import type { Metrics } from "../observability/metrics.js";
import type { SpendRecorder } from "../observability/cost.js";
import type {
  GenAiRequest,
  GenAiResponse,
} from "../observability/gen-ai-semconv.js";
// Type-only — erased at compile time, so this does not create a runtime import
// cycle with graph-engine.ts (which value-imports this module).
import type { AgentState } from "./graph-engine.js";

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

/** Sleep helper for retry backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * "Full jitter" backoff delay: `random(0, base)`, where `base` is the caller's
 * own (typically exponential) backoff schedule. Without jitter, every request
 * that hits the same retryable condition at roughly the same time (a provider
 * 429/5xx burst, a Redis blip) retries in the SAME window — the retries
 * themselves recreate the load spike they were backing off from. Full jitter
 * (AWS's "Exponential Backoff And Jitter" — the strongest of the jitter
 * strategies they benchmark) spreads retries uniformly across `[0, base]`
 * instead of clustering them.
 *
 * `base` is NOT itself randomised — the caller still computes its exponential
 * (or fixed) schedule; this only decorrelates concurrent callers on the same
 * schedule. Returns 0 unchanged (nothing to jitter).
 */
export function fullJitter(base: number): number {
  if (base <= 0) return 0;
  return Math.random() * base;
}

/** Two LLM configs are considered the same target when provider+model match. */
export function sameModel(a: LlmConfig, b: LlmConfig): boolean {
  return a.provider === b.provider && a.model === b.model;
}

// ---------------------------------------------------------------------------
// Per-request runtime injected via RunnableConfig.configurable
// ---------------------------------------------------------------------------

/** Accumulated token usage across all LLM nodes in one execution. */
export interface UsageAccumulator {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Running total USD cost across all nodes, each priced at its OWN
   * provider/model rate. Optional so existing literals stay valid; the engine
   * initialises it to 0 and node handlers add their per-node cost to it.
   */
  costUsd?: number;
  /**
   * Subset of {@link promptTokens} the provider served from its prompt cache
   * (`providerMetadata`/`usage.cachedInputTokens` in the AI SDK). Optional so
   * existing literals stay valid; the engine initialises it to 0.
   *
   * This is the only observable that tells us whether the prompt PREFIX is
   * actually stable across turns. Prompt-cache hit rate cannot be inferred from
   * `promptTokens` — an unstable system prefix bills the same token count, it
   * just re-prefills them. Surfaced as `prompt_tokens_details.cached_tokens`
   * (OpenAI-compatible) and as a `gen_ai.usage.cache_read_input_tokens` span
   * attribute.
   */
  cachedPromptTokens?: number;
}

/**
 * Combines abort signals into one that fires when the FIRST of them fires.
 *
 * Exists so a handler with its own controller (a repetition guard, a per-tool
 * timeout) can honour {@link ExecRuntime.signal} instead of choosing between
 * them — replacing one with the other silently drops a cancellation path, which
 * is how the flow deadline stopped reaching provider calls.
 *
 * Returns `undefined` when nothing is to be watched (so callers can assign the
 * result straight to an optional `abortSignal` field), and the signal itself
 * when there is exactly one — avoiding a wrapper object on the hot path.
 *
 * Uses `AbortSignal.any` where available (Bun, Node ≥ 20) and otherwise falls
 * back to a manual fan-in, with listeners detached once it fires so a long-lived
 * upstream signal cannot retain the downstream ones.
 */
export function combineAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];

  const anyFn = (
    AbortSignal as unknown as {
      any?: (s: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anyFn === "function") return anyFn(present);

  const controller = new AbortController();
  const pairs: { signal: AbortSignal; listener: () => void }[] = [];
  const detach = (): void => {
    for (const { signal, listener } of pairs) {
      signal.removeEventListener("abort", listener);
    }
  };
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    const listener = (): void => {
      controller.abort(signal.reason);
      detach();
    };
    pairs.push({ signal, listener });
    signal.addEventListener("abort", listener, { once: true });
  }
  return controller.signal;
}

/** Factory that produces a LanguageModel from an LlmConfig — injectable for tests. */
export interface ProviderResolution {
  /** An explicit key chosen by the caller (e.g. the rotation pool). */
  apiKey?: string;
  /**
   * Per-request BYOK keys keyed by provider.
   */
  providerKeyOverrides?: Partial<Record<string, string>>;
}
export type LlmProviderFactory = (
  config: LlmConfig,
  appConfig: AppConfig,
  resolution?: ProviderResolution,
) => LanguageModel;

/**
 * Runtime callbacks + dependencies for a single executeFlow invocation.
 * Passed to node handlers via `config.configurable.runtime` so the compiled
 * graph can be cached and reused across requests without leaking callbacks.
 */
export interface ExecRuntime {
  appConfig: AppConfig;
  mcpWrapper?: McpWrapperService;
  ctx: RequestContext;
  /**
   * Per-execution node error handler implementing `node.config.errorStrategy`
   * (`continue` | `fail-fast` | `fallback`).
   *
   * Lives on the runtime rather than being baked into the compiled node because
   * it is bound to THIS execution's span manager, while compiled graphs are
   * cached and reused across requests. The strategy itself is resolved at
   * compile time (it comes from `node.config`, which is part of the graph
   * checksum).
   *
   * Optional: without it the wrapper falls back to propagating, which is the
   * default strategy anyway.
   */
  nodeErrorHandler?: import("./graph-engine/error-strategy.js").NodeErrorHandler;
  /**
   * The flow's execution-deadline signal (`EXECUTION_TIMEOUT_MS`), fired by the
   * engine and shared by every node in the run.
   *
   * Handlers that start long-running I/O MUST compose this into it — an LLM
   * stream's `abortSignal`, an MCP call's request options. Passing it only to
   * `graph.stream()` bounds the LangGraph loop at node boundaries but leaves the
   * in-flight provider call running: the engine then releases the concurrency
   * slot and emits `[DONE]` while the handler keeps streaming, producing chunks
   * after `[DONE]` and tokens billed into an already-reported usage total.
   *
   * A handler with its own abort controller (e.g. a repetition guard) must
   * COMBINE rather than replace: `AbortSignal.any([runtime.signal, own.signal])`.
   *
   * Optional so a handler can be exercised without an engine in tests.
   */
  signal?: AbortSignal;
  /**
   * Effective per-model token prices for THIS flow: the flow's own `pricing`
   * declarations merged over `appConfig.llmPricing` (flow wins on conflict).
   * Node handlers MUST estimate cost with this table (not
   * `appConfig.llmPricing` alone) — otherwise a flow that declares a custom
   * price for a model unknown to the global/built-in table (e.g. a newly
   * released Bedrock model id) silently prices every call at $0, which skips
   * `costTracker.record()` entirely (that call is gated on `cost > 0`) and
   * makes the model's spend/usage appear to never change on the dashboard.
   */
  pricingOverrides?: Record<string, import("../observability/cost.js").ModelPrice>;
  onToken: (nodeId: string, token: string) => Promise<void>;
  /** Emit a reasoning/thinking token — shown as collapsible block in Open WebUI. */
  onReasoning: (nodeId: string, token: string) => Promise<void>;
  onToolCall: (
    toolCallId: string,
    toolName: string,
    argsJson: string,
    /** Explicit owner for concurrent child runtimes; falls back to active node. */
    ownerNodeId?: string,
  ) => Promise<void>;
  /**
   * Reports the final server-bound arguments after forced flow args, egress
   * handling and contextual enrichment. Internal consumers use this for
   * provenance checks; user-facing tool-call telemetry remains on onToolCall.
   */
  onToolEffectiveArgs?: (
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ) => void | Promise<void>;
  /** Adds structured provenance metadata to one debug-trace tool call. */
  onToolTraceMetadata?: (
    toolCallId: string,
    metadata: NonNullable<
      import("../types/debug-trace.js").DebugToolCall["coverage_search"]
    >,
  ) => void;
  /**
   * Optionally wraps one model-initiated tool execution after its effective
   * arguments are known but before journaling or external dispatch. Coverage
   * assignments use this to single-flight semantically identical read-only
   * searches without changing the global tool journal's call-id semantics.
   */
  executeToolCall?: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    execute: () => Promise<unknown>,
  ) => Promise<unknown>;
  /**
   * Emits a CALLER-supplied tool call straight back to the client as an OpenAI
   * `tool_calls` delta (function-calling passthrough). Distinct from
   * {@link onToolCall}, which surfaces an INTERNAL MCP tool call as a reasoning
   * step and never as `delta.tool_calls` (doing so would trigger Open WebUI's
   * tool-execution loop). Only set when the request carried `tools`.
   */
  onClientToolCall?: (
    toolCallId: string,
    toolName: string,
    argsJson: string,
  ) => Promise<void>;
  onToolResult: (
    toolCallId: string,
    content: unknown,
    execTimeSec: number,
    options?: { streamDetails?: boolean },
  ) => Promise<void>;
  /**
   * Closes a tool call that failed before producing a result (the tool threw,
   * was denied by the approval gate, etc.) so its synthetic node renders as an
   * error instead of being stuck "running". The streaming LLM path reports tool
   * failures through {@link onToolResult} (MCP error results) and does not need
   * this; the dedicated `tool` node handler, which catches throws itself, does.
   * Optional — a no-op when monitoring/tool-node tracking is not wired.
   */
  onToolError?: (
    toolCallId: string,
    errorMessage: string,
    execTimeSec: number,
  ) => void | Promise<void>;
  onNodeStart: (
    nodeId: string,
    context?: import("../types/debug-trace.js").DebugNodeAttemptContext,
  ) => void;
  /**
   * Emits a node's completion (or error) event. Normally the executeFlow stream
   * loop calls this for every top-level graph node. Parallel `parallelNodes`
   * children run inline inside the parallel handler (they are not standalone
   * graph nodes), so the parallel handler must call this for each child itself
   * — otherwise children emit a "running" event via onNodeStart but never a
   * terminal event, leaving them stuck "running" in the dashboard.
   */
  onNodeEnd?: (nodeId: string, errorMessage?: string) => void | Promise<void>;
  /**
   * Captures the resolved prompt, produced response text, and/or the model's
   * full reasoning (chain-of-thought) for a node so the monitoring dashboard
   * and debug-trace export can show what an LLM/classifier node actually saw,
   * returned, and reasoned. Prompt/response are truncated by the monitoring
   * consumer; `reasoning` is retained in full for the debug trace. Optional —
   * a no-op when monitoring detail capture is not wired.
   */
  onNodeIo?: (
    nodeId: string,
    io: { prompt?: string; response?: string; reasoning?: string },
  ) => void;
  /**
   * Captures the routing decision a `router` node made — the outgoing edge it
   * selected and the conditions it evaluated — so the monitoring dashboard can
   * show which branch the run took (and the alternatives it did not). Optional;
   * a no-op when monitoring detail capture is not wired.
   */
  onNodeRouting?: (nodeId: string, decision: RoutingDecision) => void;
  /**
   * Captures the semantic tool-selection decision made by an LLM node so it
   * can be included in the full debug trace export. Called from
   * `createLlmNodeHandler` after the tool index has ranked the candidate pool.
   * Optional — only wired when a {@link DebugTraceStore} is configured.
   */
  onDebugToolSelection?: (
    nodeId: string,
    selection: import("../types/debug-trace.js").DebugToolSelection,
  ) => void;
  /**
   * Captures the structured classification decision made by a classifier
   * (dispatcher) node — output format, schema, raw output, parsed object, and
   * routed class label — so it can be included in the full debug trace export.
   * Called from `createClassifierNodeHandler`. Optional — only wired when a
   * {@link DebugTraceStore} is configured.
   */
  onDebugClassification?: (
    nodeId: string,
    output: import("../types/debug-trace.js").DebugClassifierOutput,
  ) => void;
  /**
   * Records a noteworthy in-node event (retry, provider fallback, repetition
   * abort, reasoning-only salvage, empty response, …) on the node's debug-trace
   * diagnostics timeline. The engine stamps the `at` timestamp on receipt.
   * Optional and best-effort — safe to call unconditionally with `?.`; a no-op
   * when no {@link DebugTraceStore} is configured. This is what turns an opaque
   * `error_message` into a traceable sequence of how a node degraded or failed.
   */
  onNodeDiagnostic?: (
    nodeId: string,
    diagnostic: import("../types/debug-trace.js").NodeDiagnosticInput,
  ) => void;
  /**
   * Annotates a node's open trace span with OpenTelemetry GenAI semantic
   * convention attributes (`gen_ai.*`) so traces are understood by GenAI-aware
   * backends (Langfuse, Arize, Datadog LLM Observability). No-op when tracing
   * is disabled or the node has no open span.
   */
  setGenAiAttributes?: (
    nodeId: string,
    req?: GenAiRequest,
    res?: GenAiResponse,
  ) => void;
  usage: UsageAccumulator;
  /** LLM provider factory — defaults to the real createLlmProvider. */
  llmProviderFactory: LlmProviderFactory;
  /** Flow-local provider availability state shared by all nodes in this run. */
  providerCircuitBreaker?: import("./provider-circuit-breaker.js").ProviderCircuitBreaker;
  /**
   * Persists a generated media payload and returns a short public URL to it,
   * or undefined when media serving is not configured (no store / no
   * mediaBaseUrl) — in which case callers fall back to an inline data-URI.
   * Used so large images are referenced by URL instead of inlined, which Open
   * WebUI cannot render (open-webui#16976).
   */
  publishMedia?: (base64: string, mediaType: string) => string | undefined;
  /** Metrics sink — defaults to a no-op when metrics are disabled. */
  metrics: Metrics;
  /**
   * Id of the flow currently executing. Attached so spend recorded by nodes can
   * be attributed to the flow (per-flow cost breakdown on the dashboard).
   */
  flowId?: string;
  /** Optional per-tenant spend recorder for budget accounting (durable when DB-backed). */
  costTracker?: SpendRecorder;
  /** Optional exact-match response cache for deterministic LLM nodes. */
  responseCache?: ResponseCache;
  /** Optional semantic (near-duplicate) cache for deterministic LLM nodes. */
  semanticCache?: SemanticCache;
  /** Global business-authorization switch. Does not disable integrity/guardrail checks. */
  authorizationEnabled?: boolean;
  /** Optional human-in-the-loop approval gate for consequential tool calls. */
  approvalGate?: ApprovalRegistry;
  /** Optional egress DLP guardrail applied to outbound tool-call arguments. */
  toolEgressGuardrail?: ToolEgressGuardrail;
  /**
   * Surfaces a pending approval to the client (SSE `approval_required` chunk).
   * Synchronous so it can be used as the gate's notify listener; the engine
   * enqueues the chunk without blocking the request path.
   */
  onApprovalRequired?: (pending: PendingApproval) => void;
  /** Optional groundedness/citation gate (anti-hallucination). */
  groundednessGate?: GroundednessGate;
  /** Emits a groundedness report for a node (SSE `groundedness` chunk). */
  onGroundedness?: (
    nodeId: string,
    report: GroundednessReport,
  ) => Promise<void>;
  /**
   * Streams the retrieved sources (RAG / vectorsearch) on a no-op chunk so an
   * Open WebUI filter can render the ones the answer references (`[n]`) as
   * native citations. `sources` must be ordered so position i is citation
   * `[i+1]`. No-op when citation streaming is not wired.
   */
  onCitations?: (sources: Citation[]) => Promise<void>;
  /**
   * Registers retrieved documents in the per-execution citation registry and
   * returns their GLOBAL, contiguous 1-based citation numbers `[n]` (one per
   * entry, in order). A document `key` seen before returns its existing number
   * (dedup across nodes/tool calls in the same stream); a new key is appended
   * and streamed to the client exactly once. Unlike {@link onCitations} (which
   * keys by url→title for already-ordered emitters), this takes an explicit
   * stable document key so a grounding node and a later self-search of the same
   * document collapse to ONE `[n]`. No-op when citation streaming is not wired.
   */
  registerCitations?: (
    entries: { key: string; citation: Citation }[],
  ) => Promise<number[]>;
  /** Optional embedder for RAG retrieval nodes (embeds the query). */
  embedder?: Embedder;
  /** Optional vector store backing RAG retrieval nodes. */
  vectorStore?: VectorStore;
  /**
   * Optional reranker (Bedrock Rerank API) used by a `parallel` rag-context
   * node with `config.ragProfiles.rerank` to fuse the chunks retrieved from all
   * sources into one globally-reranked, deduplicated top-N context. Absent when
   * reranking is disabled or no Bedrock region is resolvable.
   */
  reranker?: Reranker;
  /**
   * Optional per-tool embedding index for Dynamic Tool Retrieval. When present,
   * an LLM node configured with `config.toolSelection.mode: "semantic"` ranks
   * its tool pool against the user's query and only advertises the most
   * relevant tools (+ always-included ones + the `select_tools` meta-tool),
   * keeping the rest bound but inactive. Absent when no embedder is configured.
   */
  toolIndex?: ToolIndex;
  /**
   * Optional LLM-backed summariser of each MCP server's instructions, used to
   * advertise NOT-yet-selected tool groups in the `select_tools` meta-tool
   * description. Summaries are generated on connect/reconnect and cached.
   */
  toolGroupSummarizer?: ToolGroupSummarizer;
  /** Optional long-term memory store for `memory` nodes. */
  memoryStore?: MemoryStore;
  /**
   * Optional registry of observed per-model quality scores, consulted by the
   * "quality-aware" routing strategy so traffic drifts toward the cheapest
   * model that still holds the quality bar.
   */
  modelQuality?: ModelQualityRegistry;
  /**
   * Optional declarative tool authorization engine. When present, every tool
   * call is evaluated against its rules BEFORE dispatching to the MCP wrapper.
   * Denial causes a tool_error that surfaces in the stream; the execution
   * continues with the next tool call or step. Absent → all tool calls allowed.
   */
  toolAuthzEngine?: import("./tool-authz.js").ToolAuthzEngine;
  /**
   * Optional tool output injection validator. When present, every tool result
   * returned by an MCP server is scanned for prompt-injection patterns before
   * being injected back into the LLM context. Absent → no output validation.
   */
  toolOutputValidator?: import("../mcp/tool-output-validator.js").ToolOutputValidator;
  /**
   * Optional declarative compliance policy (`compliance-policy.yaml`, ADR-0009).
   * Consulted by `buildAiTools` (`agent-tools.ts`) so a tool matching an
   * `approvalRules` pattern requires human approval even when it is not
   * statically listed in `node.config.requiresApproval` — same effect as the
   * static gate, evaluated per tool call. Only takes effect when `approvalGate`
   * is ALSO present: the policy decides WHICH calls need approval, the gate
   * provides the pause/notify/resolve mechanism, and the policy has no
   * fallback of its own when the gate is absent.
   */
  compliancePolicy?: import("../compliance/policy-schema.js").CompliancePolicy;
  /**
   * Optional per-user assistant subsystem. When present, an `assistant-context`
   * node resolves the requesting user's assistant and injects its soul, learned
   * procedures, peer inbox and credentials into the turn; `assistant-learn`
   * schedules the post-turn learning pass.
   *
   * Absent on deployments that do not run assistants, in which case those node
   * types pass their turn through unchanged rather than failing — a flow may be
   * shared across deployments, and one without the subsystem should still answer.
   */
  assistants?: import("../assistants/assistant-runtime.js").AssistantRuntime;
  /**
   * Per-session tool-loop detection state for this execution.
   *
   * Lives on the runtime rather than in a module-level map because it is scoped to
   * one execution: a process-wide map keyed by session would have to be reaped, and
   * a leak there would make one conversation's history influence another's loop
   * verdicts. Absent when loop detection is not wired.
   */
  toolLoopState?: import("./tool-loop-detection.js").ToolLoopState;
  /**
   * Scheduler that arms the post-turn learning pass.
   *
   * Injected rather than reached through {@link assistants} because it is
   * process-wide (its single-flight latch spans every assistant) while the runtime is
   * per-request. Absent when learning is disabled, in which case `assistant-learn`
   * still records turn facts and settles canaries.
   */
  assistantReviewScheduler?: import("../assistants/experience-review.js").ExperienceReviewScheduler;
}

interface RuntimeConfigurable {
  runtime?: ExecRuntime;
}

export function getRuntime(
  config: LangGraphRunnableConfig | undefined,
): ExecRuntime | undefined {
  const configurable = config?.configurable as RuntimeConfigurable | undefined;
  return configurable?.runtime;
}

// ---------------------------------------------------------------------------
// Message sanitization
// ---------------------------------------------------------------------------

/**
 * Removes replayed Gemini 3 function-call turns that cannot be validated.
 *
 * Gemini 3 requires the opaque thought signature from its original response on
 * every historical function call. OpenAI-compatible clients do not expose that
 * Google-only metadata. Keeping such a call makes the native Google API reject
 * the complete request, so remove the unsigned call and its matching result.
 */
export function stripUnsignedGeminiToolHistory(
  messages: ModelMessage[],
  llm: LlmConfig,
): ModelMessage[] {
  if (
    llm.provider !== "google" ||
    !/(?:^|\/)gemini-3(?:[.\-/]|$)/i.test(llm.model)
  ) {
    return messages;
  }

  const unsignedCallIds = new Set<string>();
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const retained = message.content.filter((rawPart) => {
        const part = rawPart as {
          type?: string;
          toolCallId?: string;
          providerMetadata?: {
            google?: { thoughtSignature?: unknown };
          };
        };
        if (part.type !== "tool-call") return true;

        const signature = part.providerMetadata?.google?.thoughtSignature;
        if (typeof signature === "string" && signature.length > 0) return true;
        if (part.toolCallId !== undefined) unsignedCallIds.add(part.toolCallId);
        return false;
      });

      if (retained.length > 0) {
        result.push({ ...message, content: retained } as ModelMessage);
      }
      continue;
    }

    if (message.role === "tool" && Array.isArray(message.content)) {
      const retained = message.content.filter((rawPart) => {
        const part = rawPart as { type?: string; toolCallId?: string };
        return !(
          part.type === "tool-result" &&
          part.toolCallId !== undefined &&
          unsignedCallIds.has(part.toolCallId)
        );
      });
      if (retained.length > 0) {
        result.push({ ...message, content: retained } as ModelMessage);
      }
      continue;
    }

    result.push(message);
  }

  return result;
}

/**
 * Some providers (Gemma via LM Studio, Mistral, etc.) reject system messages
 * that appear after the first position in the message list. RAG retrieval and
 * memory nodes inject system messages mid-conversation as grounding context.
 * This function moves those into the content of the preceding user (or
 * assistant) message so the list stays valid for all providers.
 *
 * Strategy:
 *   - At most ONE system message is kept, and only when it is still in the
 *     leading position (i.e. before any user/assistant/tool turn). That is the
 *     node's system prompt (or an Open WebUI "User Context:" header).
 *   - Every other system message — a second leading one, or any grounding
 *     context injected mid-conversation by retrieval/memory/tool nodes — is
 *     buffered and merged into an adjacent non-system turn. This guarantees the
 *     output never carries a system message outside position 0, which strict
 *     providers (Google Gemini: "system messages are only supported at the
 *     beginning of the conversation") reject.
 *
 * Note: the node-level system prompt is prepended by the caller AFTER this
 * runs. Keeping a non-leading system message here would therefore yield two
 * system messages (prepended prompt + the stray one) — exactly the failure
 * mode this avoids.
 */
export function sanitizeSystemMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  if (messages.length === 0) return messages;

  const result: ModelMessage[] = [];
  const pendingContext: string[] = [];
  let keptLeadingSystem = false;
  let seenNonSystem = false;

  for (const msg of messages) {
    if (msg.role === "system") {
      if (!seenNonSystem && !keptLeadingSystem) {
        // True leading system message — keep it in system position.
        keptLeadingSystem = true;
        result.push(msg);
      } else {
        // A second leading system message, or any mid-conversation system
        // message — buffer its content to be merged into an adjacent turn.
        const text =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        pendingContext.push(text);
      }
      continue;
    }
    seenNonSystem = true;
    if (pendingContext.length > 0) {
      if (typeof msg.content === "string") {
        // Plain-text turn — safe to prepend the buffered context as text.
        const prefix = `${pendingContext.join("\n\n")}\n\n`;
        pendingContext.length = 0;
        result.push({ ...msg, content: prefix + msg.content } as ModelMessage);
      } else {
        // Structured turn (tool-result / tool-call / multimodal parts). Its
        // content MUST stay an array — JSON.stringify-ing it collapses the
        // structure to a string and breaks the ModelMessage[] schema (the AI
        // SDK requires a `tool` message's content to be an array). Emit the
        // buffered context as its own user turn (provider-valid in any
        // position) and keep the structured message untouched.
        result.push({
          role: "user",
          content: pendingContext.join("\n\n"),
        } as ModelMessage);
        pendingContext.length = 0;
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  // If there were trailing system messages with no following turn, append them
  // to the last message — but only when it carries plain-text content. When the
  // last turn is structured (e.g. a tool result whose content is an array of
  // tool-result parts), stringifying it would break the ModelMessage[] schema,
  // so emit the buffered context as a final user turn instead.
  const last = result[result.length - 1];
  if (pendingContext.length > 0 && last !== undefined) {
    if (typeof last.content === "string") {
      result[result.length - 1] = {
        ...last,
        content: `${last.content}\n\n${pendingContext.join("\n\n")}`,
      } as ModelMessage;
    } else {
      result.push({
        role: "user",
        content: pendingContext.join("\n\n"),
      } as ModelMessage);
    }
    pendingContext.length = 0;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Volatile prompt guidance placement (prompt-cache preservation)
// ---------------------------------------------------------------------------

/**
 * Attaches volatile, per-request guidance text to the message list WITHOUT
 * touching the cacheable prefix.
 *
 * The problem this solves: MCP tool guidance (`getInstructions`) and the
 * "these tools are unavailable" note depend on live server state and on the
 * per-request semantic tool selection. Concatenated onto the FRONT of the system
 * prompt — where they used to live — any change to either invalidates the entire
 * prompt cache: the system message is message 0, so a single changed character
 * there forces a full re-prefill of every subsequent token. On a local
 * OpenAI-compatible server (LM Studio / llama.cpp) that is the difference
 * between a near-instant warm KV cache and reprocessing the whole conversation
 * on every turn.
 *
 * The fix is placement, not content: the guidance is appended to the LAST user
 * message instead. That message is the newest turn — it was never part of the
 * previous request's cacheable prefix anyway — so re-sending changed guidance
 * costs nothing in cache terms. Everything before it stays byte-identical.
 *
 * Why not a second system message: {@link sanitizeSystemMessages} exists because
 * strict providers (Gemini, Gemma/Mistral via LM Studio) reject system messages
 * outside position 0, and the Anthropic provider cannot represent a system block
 * that appears after a user turn. Appending to an existing user message changes
 * neither the message count nor any role, so it is safe on every provider.
 *
 * Recency also helps instruction-following: guidance immediately before the
 * model's turn is followed at least as reliably as guidance buried at the top of
 * a long system prompt.
 *
 * Falls back to returning the list unchanged when there is no user message to
 * attach to (the caller then keeps the guidance in the system prompt, trading
 * cache efficiency for correctness). Pure — never mutates the input.
 */
export function attachVolatileGuidance(
  messages: ModelMessage[],
  guidance: string,
): { messages: ModelMessage[]; attached: boolean } {
  const text = guidance.trim();
  if (text === "") return { messages, attached: false };

  // Target the LAST user message: appending to an earlier one would invalidate
  // everything after it, which is the exact problem being fixed.
  const targetIdx = messages.findLastIndex((m) => m.role === "user");
  const target = targetIdx === -1 ? undefined : messages[targetIdx];
  if (target === undefined) return { messages, attached: false };

  const content = target.content;

  let nextContent: ModelMessage["content"];
  if (typeof content === "string") {
    nextContent = `${content}\n\n${text}`;
  } else if (Array.isArray(content)) {
    // Multimodal / structured user turn: append a text part rather than
    // stringifying the array, which would destroy image/file parts.
    nextContent = [
      ...content,
      { type: "text", text },
    ] as ModelMessage["content"];
  } else {
    // Unknown content shape — leave it alone rather than risk corrupting it.
    return { messages, attached: false };
  }

  const next = [...messages];
  next[targetIdx] = { ...target, content: nextContent } as ModelMessage;
  return { messages: next, attached: true };
}

/**
 * Validates and fixes conversation structure for strict providers like AWS Bedrock.
 *
 * Bedrock rejects conversations that:
 * 1. Start with an assistant message containing tool-calls (without a preceding user message)
 * 2. Have tool-calls without matching tool-results
 * 3. Have orphaned tool messages
 *
 * This function ensures the conversation always starts with a valid turn (system or user)
 * and never begins with an assistant message containing tool-calls.
 *
 * @param messages - The message list after sanitizeSystemMessages
 * @returns Message list safe for strict providers
 */
export function ensureValidConversationStart(
  messages: ModelMessage[],
): ModelMessage[] {
  if (messages.length === 0) return messages;

  // Check if the first non-system message is an assistant message with tool-calls
  const firstNonSystemIdx = messages.findIndex((m) => m.role !== "system");
  const firstNonSystem =
    firstNonSystemIdx === -1 ? undefined : messages[firstNonSystemIdx];
  if (firstNonSystem === undefined) {
    // Only system messages - this is fine
    return messages;
  }

  // Check if it's an assistant message with tool-calls
  if (firstNonSystem.role === "assistant") {
    const content = firstNonSystem.content;
    const hasToolCalls =
      Array.isArray(content) &&
      content.some((part: unknown) => {
        const p = part as { type?: string };
        return p.type === "tool-call";
      });

    if (hasToolCalls) {
      // This is invalid for Bedrock - remove all tool-calls from this message
      // or skip it entirely if it has no text content
      const textParts = Array.isArray(content)
        ? content.filter((part: unknown) => {
            const p = part as { type?: string };
            return p.type === "text";
          })
        : [];

      if (textParts.length > 0) {
        // Keep the message but remove tool-calls
        const textContent = textParts
          .map((part: unknown) => {
            const p = part as { text?: string };
            return p.text || "";
          })
          .join("\n")
          .trim();

        return [
          ...messages.slice(0, firstNonSystemIdx),
          { role: "assistant", content: textContent } as ModelMessage,
          ...messages.slice(firstNonSystemIdx + 1),
        ];
      } else {
        // No text content - skip this message entirely
        return [
          ...messages.slice(0, firstNonSystemIdx),
          ...messages.slice(firstNonSystemIdx + 1),
        ];
      }
    }
  }

  return messages;
}

/**
 * Default text for the turn {@link ensureTrailingUserTurn} appends. Deliberately
 * task-neutral: it must not describe an outcome, only re-open the model's turn
 * and mark the preceding assistant content as engine-supplied context.
 */
export const TRAILING_USER_TURN_TEXT =
  "The preceding assistant messages are supplied context, not your answer. " +
  "Perform the task from the system instruction now and emit exclusively the " +
  "result it requires.";

/**
 * Guarantees the prompt does not END on an assistant turn.
 *
 * Why this exists: engine-internal context is injected as assistant messages —
 * the agent-harness returns its aggregated findings as one `AIMessage`
 * (`resultMode: "context"`), and {@link sanitizeSystemMessages} folds a TRAILING
 * system message (e.g. the coverage verifier's sanitized ledger) into the last
 * message, which is exactly that assistant turn. The resulting message list ends
 * with `assistant`, and an OpenAI-compatible chat endpoint then renders
 * `…<|im_start|>assistant\n<context><|im_end|>\n<|im_start|>assistant\n`: the
 * model is asked to open a SECOND consecutive assistant turn directly after one
 * that already closed. Qwen builds answer that by emitting the end token
 * immediately — an empty completion, deterministically, at temperature 0, on
 * every retry and on every fallback candidate (both local candidates are Qwen).
 * That is the "empty LLM response (no visible text and no tool call)" a
 * fail-closed coverage verifier encountered after a long-running test.
 *
 * Appending one short user turn removes the double-assistant shape, so the model
 * gets a normal turn boundary to answer at, and simultaneously restores the
 * role semantics: carried findings are context handed to the model, not words it
 * supposedly already said.
 *
 * Pure. A list that already ends with a user/tool turn is returned unchanged, so
 * the ordinary chat path (which always ends with the new user message) and the
 * cacheable prefix are untouched.
 */
export function ensureTrailingUserTurn(
  messages: ModelMessage[],
  text: string = TRAILING_USER_TURN_TEXT,
): { messages: ModelMessage[]; appended: boolean } {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== "assistant") {
    return { messages, appended: false };
  }
  return {
    messages: [...messages, { role: "user", content: text } as ModelMessage],
    appended: true,
  };
}

// ---------------------------------------------------------------------------
// SSE chunk factories
// ---------------------------------------------------------------------------

export function makeTokenChunk(
  id: string,
  model: string,
  token: string,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
  };
}

/** Emit a reasoning/thinking token — shown as a collapsible block in Open WebUI. */
export function makeReasoningChunk(
  id: string,
  model: string,
  token: string,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, delta: { reasoning_content: token }, finish_reason: null },
    ],
  };
}

/**
 * Emit a CALLER-supplied tool call as an OpenAI `tool_calls` delta chunk
 * (function-calling passthrough). The caller executes the tool and returns the
 * result on the next turn — aiperator does not run it.
 */
export function makeToolCallChunk(
  id: string,
  model: string,
  toolCallId: string,
  toolName: string,
  argsJson: string,
  index: number,
): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: toolCallId,
              type: "function",
              function: { name: toolName, arguments: argsJson },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

export function makeErrorChunk(
  model: string,
  error: StreamError,
): ChatCompletionChunk {
  return {
    id: crypto.randomUUID(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: null }, finish_reason: "error" }],
    error,
  } as ChatCompletionChunk & { error: StreamError };
}

/**
 * Splits citation sources into byte-bounded batches so each emitted `sources`
 * `chat.completion.chunk` stays under the aiohttp 131072-byte (128 KiB)
 * per-line cap of Open WebUI's SSE client.
 *
 * A grounding node can register 150+ documents in one call (e.g. the `tool`
 * node after `vectorsearch/get_summaries`); serialised into a single chunk
 * that easily exceeds the cap and aborts the client read with
 * "Got more than 131072 bytes when reading". Open WebUI merges the `sources`
 * arrays across chunks by `index`, so emitting one logical registration as
 * several frames is transparent to the client and keeps `[n]` numbering intact.
 *
 * At least one source is kept per batch, so a lone oversized source is emitted
 * on its own frame rather than dropped (correctness over the byte budget —
 * per-source size is bounded anyway: snippet ≤ 500 chars).
 *
 * @param sources       Ordered citation sources to emit.
 * @param maxBytes      Payload budget per frame. Default 120_000 leaves ample
 *                      headroom below 131072 for the `data: …\n\n` framing.
 * @param envelopeBytes Approx. serialized size of the chunk wrapper around an
 *                      empty `sources` array; counted toward each batch budget.
 */
export function batchCitationSources(
  sources: readonly CitationSource[],
  maxBytes = 120_000,
  envelopeBytes = 0,
): CitationSource[][] {
  return batchBySerializedBytes(sources, maxBytes, envelopeBytes);
}

/**
 * Generic byte-bounded batcher: splits `items` into groups whose serialized
 * JSON size (plus `envelopeBytes` for the enclosing chunk) stays under
 * `maxBytes`. Used for any SSE chunk that carries an array whose total size can
 * exceed the aiohttp 131072-byte (128 KiB) per-line cap of Open WebUI's client
 * — e.g. the per-node streamed `sources` chunk and the merged `sources` chunk
 * emitted at flow end. Open WebUI concatenates the arrays across chunks, so the
 * split is transparent. At least one item is kept per batch (a lone oversized
 * item is emitted on its own rather than dropped).
 */
export function batchBySerializedBytes<T>(
  items: readonly T[],
  maxBytes = 120_000,
  envelopeBytes = 0,
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = envelopeBytes;
  for (const item of items) {
    // `+1` accounts for the comma separator between array elements.
    const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (batch.length > 0 && bytes + itemBytes > maxBytes) {
      batches.push(batch);
      batch = [];
      bytes = envelopeBytes;
    }
    batch.push(item);
    bytes += itemBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Serialized byte size of the SSE frame a chunk becomes on the wire, including
 * the `data: ` prefix and the trailing `\n\n`. This is the exact quantity the
 * aiohttp reader in Open WebUI measures against its 131072-byte (128 KiB)
 * per-line cap.
 */
function sseFrameBytes(chunk: ChatCompletionChunk): number {
  return Buffer.byteLength(`data: ${JSON.stringify(chunk)}\n\n`);
}

/**
 * Final hard-cap guard for a single SSE `chat.completion.chunk`: guarantees the
 * frame it becomes on the wire stays under `maxFrameBytes` by splitting it into
 * several equivalent chunks when it would otherwise exceed the aiohttp
 * 131072-byte (128 KiB) per-line cap that aborts Open WebUI's read with
 * "Got more than 131072 bytes when reading".
 *
 * This is a byte-exact safety net downstream of the per-emitter splitters
 * (`sendToken`/`onReasoning` split by CHARACTERS, `registerCitations`/the
 * merged-source emitter batch by bytes). A 60_000-character `reasoning_content`
 * frame of heavily multibyte (UTF-8) or JSON-escape-heavy content can still
 * cross 128 KiB in BYTES; a single merged source with a large aggregated
 * `document[]` array can too. Rather than trusting every upstream emitter to
 * get the byte budget right, this makes the invariant hold at the one place
 * every frame passes through.
 *
 * Splitting is transparent to the client:
 *   - `sources[]` chunks: the array is re-batched by bytes; Open WebUI merges
 *     `sources` across chunks by `index`.
 *   - `delta.reasoning_content` / `delta.content` frames: the string is cut
 *     into byte-bounded slices the client concatenates back verbatim.
 *   - any other oversized shape (no splittable field): emitted unchanged as a
 *     best effort — these paths (tool_calls, groundedness, approval, error,
 *     finish) carry bounded payloads and are not expected to exceed the cap.
 *
 * Frames already under the cap are returned as `[chunk]` (the fast path).
 */
export function splitChunkByFrameBytes(
  chunk: ChatCompletionChunk,
  maxFrameBytes = 120_000,
): ChatCompletionChunk[] {
  if (sseFrameBytes(chunk) <= maxFrameBytes) return [chunk];

  // 1) sources[] array — re-batch by bytes (transparent: merged by `index`).
  if (Array.isArray(chunk.sources) && chunk.sources.length > 1) {
    const envelopeBytes = sseFrameBytes({ ...chunk, sources: [] });
    return batchBySerializedBytes(
      chunk.sources,
      maxFrameBytes,
      envelopeBytes,
    ).map((sources) => ({ ...chunk, sources }));
  }

  // 2) A string delta field — split into byte-bounded slices the client
  //    concatenates back. reasoning_content first (the largest payloads:
  //    tool-result detail blocks), then content.
  const choice = chunk.choices[0];
  const delta = choice?.delta;
  const field: "reasoning_content" | "content" | undefined =
    typeof delta?.reasoning_content === "string" &&
    delta.reasoning_content.length > 0
      ? "reasoning_content"
      : typeof delta?.content === "string" && delta.content.length > 0
        ? "content"
        : undefined;
  if (delta !== undefined && field !== undefined && choice !== undefined) {
    const text = delta[field] as string;
    const build = (slice: string): ChatCompletionChunk => ({
      ...chunk,
      choices: [{ ...choice, delta: { ...delta, [field]: slice } }],
    });
    return splitStringFieldByFrameBytes(text, maxFrameBytes, build);
  }

  // 3) No splittable field — emit as-is (best effort; bounded payload types).
  return [chunk];
}

/**
 * Splits `text` into the fewest slices such that each `build(slice)` serializes
 * to an SSE frame no larger than `maxFrameBytes`. Uses a per-slice binary
 * search on the character length so the byte budget holds exactly regardless of
 * multibyte/JSON-escape expansion — without measuring at every character.
 */
function splitStringFieldByFrameBytes(
  text: string,
  maxFrameBytes: number,
  build: (slice: string) => ChatCompletionChunk,
): ChatCompletionChunk[] {
  const out: ChatCompletionChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let lo = 1;
    let hi = text.length - start;
    let best = 1; // always make progress; a 1-char frame is far below the cap
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (sseFrameBytes(build(text.slice(start, start + mid))) <= maxFrameBytes) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    out.push(build(text.slice(start, start + best)));
    start += best;
  }
  return out;
}

/**
 * Collapses vectorsearch citations to one entry per document, keyed by url
 * (falling back to title), keeping the highest-scoring chunk's snippet/score,
 * and sorts by score descending. Mirrors the deduplication used for the tool
 * result accordion so the citation numbering `[n]` lines up with the document
 * overview the user sees.
 */
export function dedupeCitations(citations: Citation[]): Citation[] {
  const byDoc = new Map<string, Citation>();
  for (const c of citations) {
    const key = c.url.length > 0 ? c.url : c.title;
    const existing = byDoc.get(key);
    if (existing === undefined) {
      byDoc.set(key, { ...c });
    } else if (c.similarity_score > existing.similarity_score) {
      existing.similarity_score = c.similarity_score;
      existing.snippet = c.snippet;
      existing.title = c.title;
    }
  }
  return Array.from(byDoc.values()).sort(
    (a, b) => b.similarity_score - a.similarity_score,
  );
}

/**
 * Resolves `{{context.<path>}}` placeholders in an LLM system-prompt string
 * using the per-request {@link RequestContext}.  Unknown paths resolve to an
 * empty string so prompts degrade gracefully when a field is absent (e.g.
 * anonymous requests without a userName).
 */
/**
 * Resolves `{{context.<path>}}` and `{{now.<field>}}` placeholders in an LLM
 * system-prompt string.
 *
 * `{{context.<path>}}` reads the per-request {@link RequestContext}; unknown
 * paths resolve to an empty string so prompts degrade gracefully.
 *
 * `{{now.<field>}}` injects the current date/time, so a responder that calls
 * time-based tools (worktime, parking) can resolve relative ranges
 * ("heute"/"morgen"/"diese Woche") to concrete dates itself — the context the
 * mcpgate router LLM used to prepend before it was retired. Fields:
 *   {{now.date}}     → YYYY-MM-DD
 *   {{now.time}}     → HH:MM
 *   {{now.datetime}} → YYYY-MM-DD HH:MM
 *   {{now.weekday}}  → localised weekday (e.g. "Dienstag")
 *   {{now.iso}}      → full ISO-8601 with offset
 *   {{now.timezone}} → IANA timezone used
 * Times are rendered in {@link NOW_TIMEZONE} (Europe/Berlin) to match the
 * worktime/parking domain, independent of the host's clock timezone.
 */
export function resolveContextPlaceholders(
  template: string | undefined,
  ctx: RequestContext,
  namespaces?: { node?: TurnSnapshot; turn?: TurnSnapshot[] },
  now: Date = new Date(),
): string | undefined {
  if (template === undefined || template === "") return template;
  if (!template.includes("{{")) return template;
  // Known template roots. Unknown roots are left intact by
  // renderTemplateNamespaced (so unrelated `{{…}}` text is not swallowed); a
  // known root with a missing sub-path resolves to "" (graceful degradation).
  //   {{context.<path>}}                         → per-request RequestContext
  //   {{now.date|time|datetime|weekday|iso|timezone}}
  //   {{node.<id>.classification.<field>}}        → this run's classifier output
  //   {{turn[<n>].<id>.classification.<field>}}   → n runs ago (0 = current)
  const roots: Record<string, unknown> = {
    context: ctx,
    now: nowTokens(now),
    node: namespaces?.node ?? {},
    turn: namespaces?.turn ?? [],
  };
  return renderTemplateNamespaced(template, roots);
}

/** Timezone the `{{now.*}}` prompt placeholders render in. */
export const NOW_TIMEZONE = "Europe/Berlin";

/**
 * Computes the `{{now.*}}` token values for a given instant, formatted in
 * {@link NOW_TIMEZONE}. Exported for unit testing.
 */
export function nowTokens(now: Date = new Date()): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NOW_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string): string =>
    parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${get("hour")}:${get("minute")}`;
  const weekday = new Intl.DateTimeFormat("de-DE", {
    timeZone: NOW_TIMEZONE,
    weekday: "long",
  }).format(now);
  return {
    date,
    time,
    datetime: `${date} ${time}`,
    weekday,
    iso: now.toISOString(),
    timezone: NOW_TIMEZONE,
  };
}

/**
 * De-duplicates repeated entries in comma-separated LIST lines of an injected
 * MCP tool-guidance block. Motivation: some servers build enumerations from
 * upstream data that contains duplicates — e.g. the taiga guidance's
 * "Known epics" line repeats names like "Internal Development ID" ~6× and
 * "Example Gamma EG" twice, which bloats every responder prompt (and is re-sent on
 * each agent-loop step).
 *
 * Conservative by design: a line is only rewritten when it looks like a plain
 * comma-separated list — at least 4 items, every item short and free of
 * JSON/structural characters (`{}[]":`) and sentence punctuation — so prose and
 * JSON arrays (e.g. the parking user list) are left untouched. Order and the
 * first occurrence's original text are preserved; a line without duplicates is
 * returned unchanged.
 */
export function dedupeGuidanceListLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes(",")) return line;
      // Skip JSON / structured lines (e.g. `[{"login":...}]`).
      if (/[{}[\]":]/.test(line)) return line;
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length < 4) return line;
      if (parts.some((p) => p.length === 0 || p.length > 60 || /[.!?]/.test(p)))
        return line;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const p of parts) {
        const key = p.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
      }
      return out.length === parts.length ? line : out.join(", ");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// State readers
// ---------------------------------------------------------------------------

export function lastUserQuery(state: AgentState): string {
  for (const m of state.messages.toReversed()) {
    if (m._getType() === "human") {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .map((p) => {
            const pp = p as { type?: string; text?: string };
            return pp.type === "text" ? (pp.text ?? "") : "";
          })
          .join(" ")
          .trim();
      }
    }
  }
  return "";
}

/**
 * Whether any message carries an image/file attachment. Used by LLM nodes with
 * `config.inputFilter === "attachments"` (e.g. a vision-extraction step) so they
 * are skipped entirely when the request has nothing to extract — otherwise the
 * vision model would just answer the text question and its output would be
 * streamed to the client as a duplicate answer.
 */
export function messagesHaveAttachments(state: AgentState): boolean {
  for (const m of state.messages) {
    const c = m.content;
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      const t = (part as { type?: string }).type;
      if (t === "image_url" || t === "image" || t === "file") return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// RAG context management — prevent accumulation across checkpointed turns
// ---------------------------------------------------------------------------

/**
 * Well-known prefix injected by the `parallel` node's RAG fusion step. Used as
 * a stable marker to identify system messages that carry RAG context, so they
 * can be stripped from prior turns to prevent unbounded growth in checkpointed
 * conversations. The prefix is intentionally kept as a short literal substring
 * rather than a regex so it is fast to match on every message.
 */
export const RAG_CONTEXT_MARKER =
  "The following sources are ordered by relevance to the question.";

/**
 * An alternative marker for tag-scoped RAG context, which begins with the
 * authoritative-source header before the standard citation preamble.
 */
const RAG_AUTHORITATIVE_MARKER = "Authoritative source tag for this question:";

/**
 * Markers used before the prompts were translated to English.
 *
 * A checkpointed conversation persists the system messages verbatim, so a
 * deployment that upgrades mid-conversation still has German-marked RAG context
 * in its history. Without these, `deduplicateRagContext` would stop recognising
 * those messages and the context would grow unbounded for the rest of the
 * session — the exact failure the marker exists to prevent. Safe to drop once no
 * live checkpoint predates the translation.
 */
const LEGACY_RAG_MARKERS = [
  "Die folgenden Quellen wurden nach Relevanz zur Frage sortiert.",
  "Gefragter Mandant:",
] as const;

/**
 * Returns `true` when the given BaseMessage content carries RAG context
 * injected by the parallel node's fusion step.
 */
export function isRagContextMessage(content: string): boolean {
  return (
    content.includes(RAG_CONTEXT_MARKER) ||
    content.startsWith(RAG_AUTHORITATIVE_MARKER) ||
    LEGACY_RAG_MARKERS.some((marker) => content.includes(marker))
  );
}

/**
 * Strips all RAG-context system messages from a `BaseMessage[]` array EXCEPT
 * for the LAST one (which is the freshest retrieval for the current turn).
 * This prevents RAG context from accumulating across checkpointed turns.
 *
 * When called on the messages entering the LLM handler:
 * - Turn 1: 1 RAG message → kept (no-op).
 * - Turn 3: 3 RAG messages → only the last is kept.
 *
 * Non-RAG system messages (e.g. the node's own system prompt) are untouched.
 */
export function deduplicateRagContext(
  messages: import("@langchain/core/messages").BaseMessage[],
): import("@langchain/core/messages").BaseMessage[] {
  // Find indices of all RAG-context system messages.
  const ragIndices: number[] = [];
  for (const [i, m] of messages.entries()) {
    if (m._getType() !== "system") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (isRagContextMessage(content)) ragIndices.push(i);
  }
  if (ragIndices.length <= 1) return messages; // nothing to dedup

  // Keep only the last RAG message; remove all earlier ones.
  const toRemove = new Set(ragIndices.slice(0, -1));
  return messages.filter((_, i) => !toRemove.has(i));
}

// ---------------------------------------------------------------------------
// Conversation history trimming — sliding window for multi-turn dialogs
// ---------------------------------------------------------------------------

/**
 * Trims a ModelMessage[] to at most `maxTurns` user/assistant exchange pairs,
 * always preserving:
 *   - The leading system message(s) (position 0, role === "system").
 *   - The LAST `maxTurns` complete user→assistant exchanges.
 *   - Any trailing messages after the last assistant message (the current
 *     user query + any freshly injected context).
 *
 * This prevents unbounded context growth in multi-turn checkpointed dialogs
 * while keeping the system prompt and recent conversation intact.
 *
 * Tool messages (role: "tool") are kept alongside the assistant turn that
 * requested them — they count as part of the same "exchange".
 */
export function trimConversationHistory(
  messages: ModelMessage[],
  maxTurns: number,
): ModelMessage[] {
  if (maxTurns <= 0) return messages;

  // Separate leading system messages.
  const firstNonSystemIdx = messages.findIndex((m) => m.role !== "system");
  const systemEnd = firstNonSystemIdx === -1 ? messages.length : firstNonSystemIdx;
  const systemPrefix = messages.slice(0, systemEnd);
  const conversationMessages = messages.slice(systemEnd);

  if (conversationMessages.length === 0) return messages;

  // Identify turn boundaries: each "turn" starts with a user message.
  // A turn includes: user, [assistant, [tool, ...]*]*
  const turnStartIndices: number[] = [];
  for (const [i, m] of conversationMessages.entries()) {
    if (m.role === "user") {
      turnStartIndices.push(i);
    }
  }

  if (turnStartIndices.length <= maxTurns) return messages; // no trimming needed

  // Keep only the last `maxTurns` user-initiated turns.
  const keepFrom = turnStartIndices[turnStartIndices.length - maxTurns];
  if (keepFrom === undefined) return messages;
  return [...systemPrefix, ...conversationMessages.slice(keepFrom)];
}

// ---------------------------------------------------------------------------
// Classifier JSON extraction + fallback
// ---------------------------------------------------------------------------

export function extractJsonFromText(
  text: string,
): Record<string, unknown> | null {
  const trimmed = text.trim();

  // 1. ```json ... ``` block
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }

  // 2. First balanced { ... } span
  const start = trimmed.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as Record<
              string,
              unknown
            >;
          } catch {
            break;
          }
        }
      }
    }
  }

  // 3. Entire text
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Builds a safe fallback classification when the classifier LLM fails or returns
 * unparseable output. Reads `node.config.fallback` — an object that is used as
 * the classification, with `classifierSchema.classKey` providing the label.
 * Returns undefined when no fallback is configured (caller then errors).
 */
export function buildFallbackClassification(
  node: FlowNode,
  schema: { classKey: string },
): { classification: Record<string, unknown>; label: string } | undefined {
  const cfg = (node.config ?? {}) as { fallback?: unknown };
  const fb = cfg.fallback;
  if (fb === null || typeof fb !== "object") return undefined;
  const classification = fb as Record<string, unknown>;
  const rawLabel = classification[schema.classKey];
  const label =
    typeof rawLabel === "string" ? rawLabel : String(rawLabel ?? "");
  if (label.length === 0) return undefined;
  return { classification, label };
}

// ---------------------------------------------------------------------------
// Classifier XML extraction + schema hint
// ---------------------------------------------------------------------------

/**
 * Extracts a flat key-value object from XML text. Designed for the classifier
 * node's structured output when `config.responseFormat` is `"xml"`.
 *
 * Parsing strategy (in order):
 *   1. Strip any ```xml … ``` fenced code block wrapper.
 *   2. Find the first XML-like root element (`<response>…</response>` or any
 *      single root tag).
 *   3. Extract each direct child element as a key-value pair.
 *   4. Coerce values using the JSON schema's `properties` type hints:
 *      - `type: "boolean"` → `true` / `false`
 *      - `type: "number"` / `type: "integer"` → `parseFloat`
 *      - everything else → string (trimmed)
 *
 * Falls back to `extractJsonFromText` if the text looks like JSON (starts with
 * `{`) — models sometimes ignore the XML instruction and emit JSON anyway.
 */
export function extractXmlToJson(
  text: string,
  schema: Record<string, unknown>,
): Record<string, unknown> | null {
  let trimmed = text.trim();

  // Unwrap fenced code block if present (```xml ... ``` or ``` ... ```)
  const fenced = trimmed.match(/```(?:xml)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    trimmed = fenced[1].trim();
  }

  // Fallback: if the model emitted JSON despite being asked for XML, handle it.
  if (trimmed.startsWith("{")) {
    return extractJsonFromText(trimmed);
  }

  // Find root element content — accept any single root tag name.
  const rootMatch = trimmed.match(/^<(\w+)>([\s\S]*)<\/\1>\s*$/);
  const inner = rootMatch?.[2] ?? trimmed;

  // Extract child tags: <key>value</key>
  const tagPattern = /<(\w+)>([\s\S]*?)<\/\1>/g;
  const result: Record<string, unknown> = {};
  let found = false;

  // Resolve property types from the JSON schema for coercion.
  const properties =
    (schema.properties as Record<string, { type?: string }> | undefined) ?? {};

  for (const match of inner.matchAll(tagPattern)) {
    found = true;
    const [, key = "", rawTag = ""] = match;
    const rawValue = rawTag.trim();
    const propType = properties[key]?.type;

    if (propType === "boolean") {
      result[key] = rawValue.toLowerCase() === "true";
    } else if (propType === "number" || propType === "integer") {
      const num = parseFloat(rawValue);
      result[key] = Number.isFinite(num) ? num : rawValue;
    } else {
      result[key] = rawValue;
    }
  }

  return found ? result : null;
}

/**
 * Generates an XML schema hint prompt section from a JSON schema. The hint
 * instructs the model to respond with an XML document and provides a concrete
 * example showing the expected tag structure and allowed values.
 *
 * Example output:
 * ```
 * Respond with ONLY a valid XML document, no markdown, no explanation.
 * Use this exact structure:
 * <response>
 *   <category>OPTION_A|OPTION_B|OPTION_C</category>
 *   <needsDetail>true|false</needsDetail>
 * </response>
 * ```
 */
export function buildXmlSchemaHint(schema: Record<string, unknown>): string {
  const properties =
    (schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined) ?? {};
  const required = (schema.required as string[] | undefined) ?? [];

  const lines: string[] = [];
  lines.push(
    "\nRespond with ONLY a valid XML document wrapped in <response> tags. No markdown, no explanation.",
  );
  lines.push("Use this exact structure:");
  lines.push("<response>");

  for (const [key, prop] of Object.entries(properties)) {
    const isRequired = required.includes(key);
    const type = prop.type as string | undefined;
    const enumValues = prop.enum as unknown[] | undefined;
    const desc = prop.description as string | undefined;

    let valueHint: string;
    if (enumValues !== undefined) {
      // Show allowed values separated by |
      valueHint = enumValues
        .map((v) => (v === "" ? "(empty string)" : String(v)))
        .join("|");
    } else if (type === "boolean") {
      valueHint = "true|false";
    } else if (type === "string") {
      valueHint = desc ? `string: ${desc}` : "string";
    } else {
      valueHint = type ?? "value";
    }

    const optionalMarker = isRequired ? "" : " (optional)";
    lines.push(`  <${key}>${valueHint}</${key}>${optionalMarker}`);
  }

  lines.push("</response>");
  return lines.join("\n");
}
