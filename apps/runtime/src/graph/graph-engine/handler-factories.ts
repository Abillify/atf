// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graph Engine — Service implementation and factory.
 *
 * Contains the GraphEngineServiceImpl class (runtime injection, message
 * mapping, tool building, execution orchestration) and the createGraphEngine
 * factory function.
 *
 * The per-execution closure callbacks that _executeFlowInternal used to build
 * inline are factored into sibling modules (Req 13.6, behaviour unchanged):
 * tool-usage.ts (tool-reported usage + provider-attempt summary), run-state.ts
 * (the shared mutable per-run state object + debug-trace opening),
 * run-tool-callbacks.ts (tool-call streaming, telemetry and the approval
 * widget) and run-node-lifecycle.ts (node start/end events, edge-flow capture
 * and groundedness). Shared Maps are passed by reference through the state
 * object; mutable scalars live on it as fields so writes stay visible across
 * modules. SSE streaming and citation numbering remain in sse-emitter.ts /
 * citation-registry.ts.
 */

import crypto from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import type { FlowDefinition } from "../../types/flow.js";
import type { RequestContext } from "../../types/monitoring.js";
import type {
  StreamError,
  ChatCompletionChunk,
  ChatMessage,
  TokenUsage,
} from "../../types/openai.js";
import type { AppConfig } from "../../config/index.js";
import type { FlowRegistry } from "../flow-parser.js";
import { applyFlowVariables } from "../flow-parser.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import { createLlmProvider } from "../llm-factory.js";
import { chatMessageToBaseMessage } from "../message-mapping.js";
import type { ModelQualityRegistry } from "../model-quality.js";
import type { ResponseCache } from "../response-cache.js";
import type { SemanticCache } from "../semantic-cache.js";
import type { Embedder } from "../semantic-cache.js";
import type { VectorStore } from "../vector-store.js";
import type { Reranker } from "../reranker.js";
import { ToolIndex } from "../tool-index.js";
import { createToolLoopState } from "../tool-loop-detection.js";
import type { ToolGroupSummarizer } from "../tool-group-summary.js";
import type { MemoryStore } from "../memory-store.js";
import type { MediaStore } from "../media-store.js";
import { decodeBase64Bytes, mediaExtension } from "../media-store.js";
import { HashedImageRefRegistry } from "../image-reference.js";
import { HashRefHandleRegistry } from "../ref-handles.js";
import type { OutputGuardrail } from "../output-guardrails.js";
import type { ToolEgressGuardrail } from "../output-guardrails.js";
import type { FlowGuardrailOverride } from "../flow-guardrail-resolver.js";
import {
  sideEffectFreeApprovalGate,
  type ApprovalRegistry,
} from "../approval-gate.js";
import type { GroundednessGate } from "../groundedness.js";
import type { DistributedConcurrencyLimiter } from "../distributed-semaphore.js";
import type { GlobalSlot } from "../distributed-semaphore.js";
import {
  Semaphore,
  QueueFullError,
  AcquireTimeoutError,
} from "../semaphore.js";
import {
  createNodeErrorHandler,
  normaliseSemaphoreError,
} from "./error-strategy.js";
import type { ThreadLock } from "../thread-lock.js";
import { InProcessThreadLock } from "../thread-lock.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { DebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type {
  DebugToolSelection,
  DebugClassifierOutput,
  DebugStreamError,
  DebugHistoryReconciliation,
} from "../../types/debug-trace.js";
import {
  findRegenerateBaseCheckpoint,
  planDuplicateTurnRegenerate,
  reconcileThreadedHistory,
} from "./history-contract.js";
import type { Metrics } from "../../observability/metrics.js";
import { createMetrics } from "../../observability/metrics.js";
import type { SpendRecorder } from "../../observability/cost.js";
import type { Tracer } from "../../observability/tracing.js";
import { NOOP_TRACER } from "../../observability/tracing.js";
import { createFlowSpanManager } from "./spans.js";
import type { FlowSpanManager } from "./spans.js";
import {
  setGenAiRequestAttributes,
  setGenAiResponseAttributes,
} from "../../observability/gen-ai-semconv.js";
import { makeErrorChunk, batchBySerializedBytes } from "../exec-runtime.js";
import type {
  ExecRuntime,
  UsageAccumulator,
  LlmProviderFactory,
} from "../exec-runtime.js";
import {
  createObservedProviderCircuitBreaker,
  createProviderCircuitBreaker,
} from "../provider-circuit-breaker.js";
import type { ProviderCircuitBreaker } from "../provider-circuit-breaker.js";
import type { GraphEngineService } from "./state.js";
import type { AgentState, CompiledAgentGraph } from "./state.js";
import {
  compileFlow,
  computeFlowChecksum,
  touchCacheEntry,
  validateToolReferences,
  evictIfFull,
  deleteFlowEntries,
  MAX_GRAPH_CACHE_ENTRIES,
  type CacheEntry,
} from "./compile.js";
import { SseEmitter } from "./sse-emitter.js";
import { CitationRegistry } from "./citation-registry.js";
import { createRunState, startDebugTrace } from "./run-state.js";
import { computeFlowDigest, subflowVersionsOf } from "../flow-revision.js";
import { createToolCallbacks } from "./run-tool-callbacks.js";
import { createNodeLifecycle } from "./run-node-lifecycle.js";
import type { ExecutionEventMeta } from "../../monitoring/execution-store.js";

/**
 * How many checkpoints of a thread the duplicate-turn regenerate search scans.
 * `getStateHistory` is newest-first and the target input checkpoint sits about
 * (nodes of one turn + 2) entries from the top, so this is ample headroom; a
 * miss falls back to the pre-regenerate behaviour.
 */
const REGENERATE_HISTORY_SCAN_LIMIT = 256;

// ---------------------------------------------------------------------------
// Provider-attempt summary + tool-reported usage — extracted to tool-usage.ts
// (Req 13.6). Re-exported here so existing importers keep working.
// ---------------------------------------------------------------------------
export {
  extractToolUsage,
  providerAttemptsSummary,
  type ToolReportedUsage,
} from "./tool-usage.js";

// ---------------------------------------------------------------------------
// GraphEngineService implementation
// ---------------------------------------------------------------------------

/**
 * Optional collaborators for {@link createGraphEngine} / GraphEngineServiceImpl.
 * Everything here is optional; a feature that depends on one of these
 * (RAG retrieval, guardrails, approvals, ...) is simply unavailable when its
 * field is omitted. Grouping them in one object — rather than ~20 positional
 * parameters — means a call site names what it's wiring instead of relying on
 * argument order, where a misplaced `undefined` used to silently disable a
 * feature with no type error.
 */
export interface GraphEngineOptions {
  /**
   * Server logger. When set, every warn/error node diagnostic is also written
   * as one structured log line (with execution/flow/node ids), so failures stay
   * debuggable after the bounded in-memory debug trace has been evicted.
   */
  logger?: import("../../observability/logger.js").Logger;
  flowRegistry?: FlowRegistry;
  mcpWrapper?: McpWrapperService;
  llmProviderFactory?: LlmProviderFactory;
  metrics?: Metrics;
  costTracker?: SpendRecorder;
  checkpointer?: import("@langchain/langgraph").BaseCheckpointSaver;
  threadLock?: ThreadLock;
  tracer?: Tracer;
  responseCache?: ResponseCache;
  semanticCache?: SemanticCache;
  globalLimiter?: DistributedConcurrencyLimiter;
  outputGuardrail?: OutputGuardrail;
  approvalGate?: ApprovalRegistry;
  groundednessGate?: GroundednessGate;
  embedder?: Embedder;
  vectorStore?: VectorStore;
  memoryStore?: MemoryStore;
  /** Optional per-user assistant subsystem, for the assistant node types. */
  assistants?: import("../../assistants/assistant-runtime.js").AssistantRuntime;
  /** Optional process-wide learning-pass scheduler. */
  assistantReviewScheduler?: import("../../assistants/experience-review.js").ExperienceReviewScheduler;
  modelQuality?: ModelQualityRegistry;
  toolEgressGuardrail?: ToolEgressGuardrail;
  mediaStore?: MediaStore;
  toolGroupSummarizer?: ToolGroupSummarizer;
  reranker?: Reranker;
  toolOutputValidator?: import("../../mcp/tool-output-validator.js").ToolOutputValidator;
  /**
   * Engine-wide breaker that OBSERVES provider reachability across executions,
   * so the operator monitoring plane can report it. It deliberately does not
   * decide anything for a run: each execution gets its own flow-local breaker
   * (see `createObservedProviderCircuitBreaker`), so a dead endpoint in one flow
   * cannot skip the provider in another.
   */
  providerCircuitBreaker?: ProviderCircuitBreaker;
}

class GraphEngineServiceImpl implements GraphEngineService {
  /** Plain compiled graphs (no checkpointer) — used for stateless requests. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Checkpointed compiled graphs — used for conversation (threaded) requests. */
  private readonly cacheCkpt = new Map<string, CacheEntry>();
  private readonly semaphore: Semaphore;
  private readonly metrics: Metrics;
  private readonly providerCircuitBreaker: ProviderCircuitBreaker;
  private readonly costTracker: SpendRecorder | undefined;
  private readonly checkpointer:
    | import("@langchain/langgraph").BaseCheckpointSaver
    | undefined;
  /** Serialises concurrent executions of the same conversation thread. */
  private readonly threadLock: ThreadLock;
  private readonly tracer: Tracer;
  /** Optional exact-match response cache for deterministic LLM nodes. */
  private readonly responseCache: ResponseCache | undefined;
  /** Optional semantic (near-duplicate) cache for deterministic LLM nodes. */
  private readonly semanticCache: SemanticCache | undefined;
  /** Optional cluster-wide concurrency limiter (Redis). */
  private readonly globalLimiter: DistributedConcurrencyLimiter | undefined;
  /** Optional output guardrail (PII redaction + blocklist) applied to streamed text. */
  private readonly outputGuardrail: OutputGuardrail | undefined;
  /** Optional human-in-the-loop approval gate for consequential tool calls. */
  private readonly approvalGate: ApprovalRegistry | undefined;
  /** Optional groundedness/citation gate (anti-hallucination). */
  private readonly groundednessGate: GroundednessGate | undefined;
  /** Optional embedder for RAG retrieval nodes. */
  private readonly embedder: Embedder | undefined;
  /** Optional vector store backing RAG retrieval nodes. */
  private readonly vectorStore: VectorStore | undefined;
  /** Optional reranker (Bedrock Rerank API) for rag-context fusion. */
  private readonly reranker: Reranker | undefined;
  /**
   * Optional per-tool embedding index for Dynamic Tool Retrieval. Built from
   * the embedder + MCP wrapper when both are available, so a node can opt into
   * semantic tool selection without any extra wiring.
   */
  private readonly toolIndex: ToolIndex | undefined;
  /** Optional long-term memory store for `memory` nodes. */
  private readonly memoryStore: MemoryStore | undefined;
  /** Optional per-user assistant subsystem for the assistant node types. */
  private readonly assistants:
    | import("../../assistants/assistant-runtime.js").AssistantRuntime
    | undefined;
  /** Optional process-wide learning-pass scheduler. */
  private readonly assistantReviewScheduler:
    | import("../../assistants/experience-review.js").ExperienceReviewScheduler
    | undefined;
  /** Optional observed per-model quality registry for quality-aware routing. */
  private readonly modelQuality: ModelQualityRegistry | undefined;
  /** Optional egress DLP guardrail applied to outbound tool-call arguments. */
  private readonly toolEgressGuardrail: ToolEgressGuardrail | undefined;
  /** Optional injection validator for inbound MCP tool results. */
  private readonly toolOutputValidator:
    | import("../../mcp/tool-output-validator.js").ToolOutputValidator
    | undefined;

  /** Optional transient store for generated media served over `/media/:id`. */
  private readonly mediaStore: MediaStore | undefined;
  /** Optional LLM summariser of MCP server instructions for select_tools. */
  private readonly toolGroupSummarizer: ToolGroupSummarizer | undefined;
  /** Optional debug trace store — captures full, untruncated execution detail. */
  private debugStore: DebugTraceStore | undefined;
  private toolAuthzEngine:
    | import("../tool-authz.js").ToolAuthzEngine
    | undefined;
  /** Optional declarative compliance policy (ADR-0009) — see setCompliancePolicy. */
  private compliancePolicy:
    | import("../../compliance/policy-schema.js").CompliancePolicy
    | undefined;

  private readonly flowRegistry: FlowRegistry | undefined;
  private readonly mcpWrapper: McpWrapperService | undefined;
  private readonly llmProviderFactory: LlmProviderFactory;
  /** Server log sink for warn/error node diagnostics (see recordNodeDiagnostic). */
  private readonly logger: import("../../observability/logger.js").Logger | undefined;

  constructor(
    private readonly appConfig: AppConfig,
    options: GraphEngineOptions = {},
  ) {
    const {
      flowRegistry,
      mcpWrapper,
      llmProviderFactory = createLlmProvider,
      metrics,
      costTracker,
      checkpointer,
      threadLock,
      tracer,
      responseCache,
      semanticCache,
      globalLimiter,
      outputGuardrail,
      approvalGate,
      groundednessGate,
      embedder,
      vectorStore,
      memoryStore,
      assistants,
      assistantReviewScheduler,
      modelQuality,
      toolEgressGuardrail,
      mediaStore,
      toolGroupSummarizer,
      reranker,
      toolOutputValidator,
      providerCircuitBreaker,
      logger,
    } = options;
    this.logger = logger;
    this.flowRegistry = flowRegistry;
    this.mcpWrapper = mcpWrapper;
    this.llmProviderFactory = llmProviderFactory;
    this.checkpointer = checkpointer;
    this.threadLock = threadLock ?? new InProcessThreadLock();
    this.tracer = tracer ?? NOOP_TRACER;
    this.responseCache = responseCache;
    this.semanticCache = semanticCache;
    this.globalLimiter = globalLimiter;
    this.outputGuardrail = outputGuardrail;
    this.approvalGate = approvalGate;
    this.groundednessGate = groundednessGate;
    this.embedder = embedder;
    this.vectorStore = vectorStore;
    // Dynamic Tool Retrieval index — only available when both an embedder and
    // an MCP wrapper are present (the tool schemas come from the wrapper, the
    // vectors from the embedder). Nodes opt in via config.toolSelection.
    this.toolIndex =
      embedder !== undefined && mcpWrapper !== undefined
        ? new ToolIndex(embedder, mcpWrapper)
        : undefined;
    this.memoryStore = memoryStore;
    this.assistants = assistants;
    this.assistantReviewScheduler = assistantReviewScheduler;
    this.modelQuality = modelQuality;
    this.toolEgressGuardrail = toolEgressGuardrail;
    this.mediaStore = mediaStore;
    this.toolGroupSummarizer = toolGroupSummarizer;
    this.reranker = reranker;
    this.toolOutputValidator = toolOutputValidator;
    this.semaphore = new Semaphore(
      appConfig.maxConcurrentExecutions,
      appConfig.maxQueueDepth ?? 0,
    );
    this.metrics = metrics ?? createMetrics(false);
    this.providerCircuitBreaker = providerCircuitBreaker ?? createProviderCircuitBreaker();
    this.costTracker = costTracker;
  }

  setDebugStore(store: DebugTraceStore): void {
    this.debugStore = store;
  }

  setToolAuthzEngine(engine: import("../tool-authz.js").ToolAuthzEngine): void {
    this.toolAuthzEngine = engine;
  }

  /**
   * Sets (or clears, via `undefined`) the declarative compliance policy
   * (ADR-0009) consulted for `approvalRules` on each tool call. Constructed
   * after the engine (see `src/index.ts`), so it is set post-construction —
   * same pattern as `setToolAuthzEngine` — and re-set on every hot-reload of
   * `compliance-policy.yaml` via the flow-parser's `onComplianceChange` hook.
   */
  setCompliancePolicy(
    policy: import("../../compliance/policy-schema.js").CompliancePolicy | undefined,
  ): void {
    this.compliancePolicy = policy;
  }

  hasCapacity(): boolean {
    const limit = this.appConfig.maxQueueDepth ?? 0;
    if (limit <= 0) return true; // unbounded queue
    // A slot is free, or the wait-queue still has room.
    return this.semaphore.available > 0 || this.semaphore.waiting < limit;
  }

  getQueueState(): {
    active: number;
    waiting: number;
    available: number;
    queueLimit: number;
  } {
    return {
      active: this.semaphore.active,
      waiting: this.semaphore.waiting,
      available: this.semaphore.available,
      queueLimit: this.semaphore.queueLimit,
    };
  }

  /**
   * Persists a generated media payload (base64) and returns a short public URL
   * (`<mediaBaseUrl>/media/<id>.<ext>`) to embed in the chat stream, or
   * undefined when media serving is not configured (no store / no
   * `mediaBaseUrl`) so the caller falls back to an inline data-URI.
   */
  private publishMediaUrl(
    base64: string,
    mediaType: string,
  ): string | undefined {
    if (this.mediaStore === undefined) return undefined;
    const base = this.appConfig.mediaBaseUrl;
    if (base === undefined || base === "") return undefined;
    const bytes = decodeBase64Bytes(base64);
    if (bytes === undefined) return undefined;
    const id = this.mediaStore.put(bytes, mediaType);
    if (id === undefined) return undefined;
    return `${base.replace(/\/$/, "")}/v1/media/${id}.${mediaExtension(mediaType)}`;
  }

  buildGraph(
    flow: FlowDefinition,
    knownToolIds?: Set<string>,
  ): CompiledAgentGraph {
    if (knownToolIds !== undefined) {
      validateToolReferences(flow, knownToolIds);
    }
    const checksum = computeFlowChecksum(flow);
    const key = `${flow.id}\u0000${checksum}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      touchCacheEntry(this.cache, key);
      return cached.graph;
    }
    const graph = compileFlow(flow);
    evictIfFull(this.cache, MAX_GRAPH_CACHE_ENTRIES);
    this.cache.set(key, { graph, checksum, flowId: flow.id });
    return graph;
  }

  /**
   * Returns a compiled graph wired with the checkpointer (for conversation
   * threads). Cached separately from the plain graph so stateless requests
   * never pay for checkpointing.
   */
  private buildCheckpointedGraph(flow: FlowDefinition): CompiledAgentGraph {
    const checksum = computeFlowChecksum(flow);
    const key = `${flow.id}\u0000${checksum}`;
    const cached = this.cacheCkpt.get(key);
    if (cached !== undefined) {
      touchCacheEntry(this.cacheCkpt, key);
      return cached.graph;
    }
    const graph = compileFlow(flow, this.checkpointer);
    evictIfFull(this.cacheCkpt, MAX_GRAPH_CACHE_ENTRIES);
    this.cacheCkpt.set(key, { graph, checksum, flowId: flow.id });
    return graph;
  }

  invalidateCache(flowId: string): void {
    deleteFlowEntries(this.cache, flowId);
    deleteFlowEntries(this.cacheCkpt, flowId);
  }

  async executeFlow(
    flowId: string,
    messages: ChatMessage[],
    ctx: RequestContext,
    onChunk: (chunk: ChatCompletionChunk) => Promise<void>,
    onDone: (usage: TokenUsage) => Promise<void>,
    monitoring?: MonitoringServiceInterface,
    guardrailOverride?: FlowGuardrailOverride,
    onFinalResponse?: (response: string) => void | Promise<void>,
  ): Promise<void> {
    if (this.flowRegistry === undefined) {
      throw new Error(
        "executeFlow: no FlowRegistry provided to GraphEngineService.",
      );
    }
    const queuedFlow = this.flowRegistry.get(flowId);
    const flowPriority = Math.max(
      queuedFlow?.priority ?? 50,
      ...(queuedFlow?.nodes
        .filter((node) => node.type === "llm" || node.type === "classifier")
        .map((node) => node.priority ?? 0) ?? [0]),
    );
    // --- Execution deadline (starts NOW, before any waiting) ---
    //
    // The timer used to start after the concurrency slot AND the thread lock had
    // been acquired, so queue time and lock time fell entirely outside
    // EXECUTION_TIMEOUT_MS: a request could sit for minutes and then still be
    // granted its full budget, while holding resources the whole time. Anchoring
    // the deadline here makes the timeout mean what it says — a bound on the
    // total time the server spends on this request — and lets the same signal
    // cancel the waits themselves.
    const timeoutMs = this.appConfig.executionTimeoutMs ?? 120_000;
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), timeoutMs);

    // --- Concurrency limit + backpressure ---
    try {
      await this.semaphore.acquire({
        timeoutMs,
        signal: deadline.signal,
        priority: flowPriority,
      });
    } catch (err) {
      clearTimeout(deadlineTimer);
      if (err instanceof QueueFullError || err instanceof AcquireTimeoutError) {
        this.metrics.recordRejected("queue_full");
        this.metrics.setQueueDepth(this.semaphore.waiting);
      }
      // Normalise saturation to a transport-meaningful error (Req. 5.3):
      // QueueOverflowError carries `code: "QUEUE_FULL"` and `httpStatus: 503`,
      // so a caller can map it without knowing about the semaphore. Previously
      // both escaped as opaque internal errors and surfaced as a 500.
      throw normaliseSemaphoreError(err);
    }
    this.metrics.setActiveExecutions(this.semaphore.active);
    this.metrics.setQueueDepth(this.semaphore.waiting);

    // --- Cluster-wide concurrency bound (Redis). Acquired after the local
    // slot so per-replica memory stays bounded; released in finally. Rejects
    // with QueueFullError when the whole cluster is saturated. ---
    let globalSlot: GlobalSlot | undefined;
    if (this.globalLimiter !== undefined) {
      try {
        globalSlot = await this.globalLimiter.acquire();
      } catch (err) {
        clearTimeout(deadlineTimer);
        this.semaphore.release();
        this.metrics.setActiveExecutions(this.semaphore.active);
        this.metrics.setQueueDepth(this.semaphore.waiting);
        if (err instanceof QueueFullError)
          this.metrics.recordRejected("queue_full");
        throw err;
      }
    }

    try {
      await this._executeFlowInternal(
        flowId,
        messages,
        ctx,
        onChunk,
        onDone,
        monitoring,
        guardrailOverride,
        onFinalResponse,
        { timeoutMs, deadline },
      );
    } finally {
      clearTimeout(deadlineTimer);
      await globalSlot?.release();
      this.semaphore.release();
      this.metrics.setActiveExecutions(this.semaphore.active);
      this.metrics.setQueueDepth(this.semaphore.waiting);
    }
  }

  private async _executeFlowInternal(
    flowId: string,
    messages: ChatMessage[],
    ctx: RequestContext,
    onChunk: (chunk: ChatCompletionChunk) => Promise<void>,
    onDone: (usage: TokenUsage) => Promise<void>,
    monitoring?: MonitoringServiceInterface,
    guardrailOverride?: FlowGuardrailOverride,
    onFinalResponse?: (response: string) => void | Promise<void>,
    /**
     * Execution deadline owned by `executeFlow`, which starts it BEFORE the
     * concurrency/lock waits. Optional so the internal path stays callable on
     * its own (tests, direct use); it then creates its own deadline.
     */
    deadlineOpts?: { timeoutMs: number; deadline: AbortController },
  ): Promise<void> {
    const flowDef = this.flowRegistry?.get(flowId);
    if (flowDef === undefined) {
      throw new Error(`executeFlow: flow "${flowId}" not found in registry.`);
    }

    // --- Execution deadline ---
    //
    // Established here (before the runtime is built) so `runtime.signal` can
    // carry it into every node handler. The deadline normally comes from
    // `executeFlow`, which starts it BEFORE the concurrency/lock waits; only
    // when this method is entered directly do we start one ourselves.
    const timeoutMs =
      deadlineOpts?.timeoutMs ?? this.appConfig.executionTimeoutMs ?? 120_000;
    const controller = deadlineOpts?.deadline ?? new AbortController();
    const timer =
      deadlineOpts === undefined
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;

    // Resolve flow variables once per execution: the registry stores the flow
    // with `{{vars.<name>}}` placeholders intact, and here we bake in the
    // effective values (declared defaults overlaid with any per-request
    // overrides from ctx.variableOverrides) before the graph is compiled.
    const resolvedFlow = applyFlowVariables(flowDef, ctx.variableOverrides);
    const flowVersion =
      typeof resolvedFlow.metadata?.version === "string"
        ? resolvedFlow.metadata.version
        : null;
    // Revision identity beyond the declared version (see flow-revision.ts).
    const flowDigest = computeFlowDigest(flowDef);
    const subflowVersions = subflowVersionsOf(flowDef);
    // Progress is explicitly opt-in per node. This keeps ordinary chat flows
    // unchanged while Deep-Research flows can expose safe, server-authored
    // lifecycle updates instead of provider/model chain-of-thought.
    const flowProgressEnabled = resolvedFlow.nodes.some(
      (node) =>
        typeof (node.config as { progress?: unknown } | undefined)?.progress ===
        "object",
    );
    const flowProgressStartedAt = Date.now();
    const formatProgressDuration = (elapsedMs: number): string => {
      const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return minutes > 0
        ? `${minutes} Min. ${seconds} Sek.`
        : `${seconds} Sek.`;
    };

    // Per-flow token prices override the global pricing config (which in turn
    // overrides the built-in table). Used to estimate the USD cost of every LLM
    // call so it can be surfaced on the live graph and in the history view.
    const pricingOverrides =
      resolvedFlow.pricing !== undefined
        ? { ...this.appConfig.llmPricing, ...resolvedFlow.pricing }
        : this.appConfig.llmPricing;

    const executionId = ctx.executionId;
    const model = flowId;

    // --- Distributed tracing: one flow span (child of the inbound caller
    // trace when present), with a child span per executed node. ---
    const spanManager: FlowSpanManager = createFlowSpanManager(this.tracer, {
      flowId,
      executionId,
      tenantId: ctx.clientId,
      parentContext: ctx.traceContext,
    });

    // Per-execution handler for `node.config.errorStrategy` (Req. 5.2). Bound to
    // THIS run's span manager, so it must be created here and handed to the
    // compiled nodes via the runtime rather than baked in at compile time
    // (compiled graphs are cached across requests).
    const nodeErrorHandler = createNodeErrorHandler(spanManager);

    // --- Token streaming callback (Req 6.1) ---
    // When output guardrails are enabled, each node's deltas pass through a
    // streaming scrubber (PII redaction / blocklist) that buffers a trailing
    // window so a sensitive value split across deltas is still caught. The
    // remainder is flushed at node end (see emitNodeEnd).
    // Per-flow guardrail override (from guardrails.json) takes precedence over
    // the engine's global instance: `null` disables the guardrail for this run,
    // an instance replaces it, and an absent key inherits the global default.
    const guardrail =
      guardrailOverride !== undefined && "output" in guardrailOverride
        ? (guardrailOverride.output ?? undefined)
        : this.outputGuardrail;
    // Same precedence for the egress DLP guardrail (outbound tool-call args).
    const effectiveEgressGuardrail =
      guardrailOverride !== undefined && "egress" in guardrailOverride
        ? (guardrailOverride.egress ?? undefined)
        : this.toolEgressGuardrail;
    // SSE token/reasoning streaming + citation numbering — extracted into
    // standalone collaborators (see their own file headers) since, unlike the
    // tool-tracking / node-monitoring / debug-trace state further below, their
    // state isn't shared with anything else in this method.
    // Ref-handle indirection (config.refHandles): created for the whole run
    // when ANY node opts in, so a handle registered by one node's tool result
    // resolves in another node's tool call and the SSE layer can unmap every
    // channel. Flows without the flag pay nothing (undefined everywhere).
    const refHandles = resolvedFlow.nodes.some(
      (node) =>
        (node.config as { refHandles?: unknown } | undefined)?.refHandles ===
        true,
    )
      ? new HashRefHandleRegistry()
      : undefined;
    const sse = new SseEmitter(onChunk, model, guardrail, refHandles);
    const { onToken, onReasoning, emitReasoningStep } = sse;    if (flowProgressEnabled) {
      await emitReasoningStep("🧭 Recherche gestartet\n");
    }
    const citations = new CitationRegistry(onChunk, model);
    const { registerCitations, onCitations, citationAt } = citations;

    const monitoringMeta: ExecutionEventMeta = {
      flowId,
      ...(ctx.clientId !== undefined ? { tenantId: ctx.clientId } : {}),
      ...(typeof ctx.requestParams?.conversation_id === "string"
        ? { conversationId: ctx.requestParams.conversation_id }
        : {}),
      ...(ctx.chatId !== undefined ? { chatId: ctx.chatId } : {}),
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      ...(typeof ctx.claims?.iss === "string" && ctx.claims.iss !== ""
        ? { issuer: ctx.claims.iss }
        : {}),
    };
    // User attribution — derived once per execution and stamped on every node
    // event so the Live Graph and History view can show the requester even when
    // only the "running" event has arrived (agent-harness delegated nodes would
    // otherwise appear as "Anonymous" because no completed event had been
    // received yet).
    // -----------------------------------------------------------------------
    const USER_PROMPT_PREVIEW_LIMIT = 200;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const userPromptPreview =
      lastUserMsg !== undefined && typeof lastUserMsg.content === "string"
        ? lastUserMsg.content.slice(0, USER_PROMPT_PREVIEW_LIMIT)
        : undefined;

    // -----------------------------------------------------------------------

    // Run-scoped image references, created once so the edge-flow capture and
    // the node handlers share ONE registry: the `img-N` refs the edge records
    // are exactly the refs the model sees in the prompt.
    const runImageRefs =
      this.mediaStore !== undefined
        ? new HashedImageRefRegistry({ store: this.mediaStore })
        : undefined;


    const st = createRunState({
      resolvedFlow,
      logger: this.logger,
      executionId,
      flowId,
      flowVersion,
    });
    const {
      nodePrompts,
      nodeResponses,
      nodeRoutingDecisions,
      nodeFullPrompts,
      nodeFullResponses,
      nodeFullReasoning,
      nodeModels,
      nodeInputTokens,
      nodeOutputTokens,
      nodeToolSelections,
      nodeClassifications,
      nodeErrorInfo,
      activeNodeIds,
    } = st;

    const toolCb = createToolCallbacks({
      monitoring,
      monitoringMeta,
      executionId,
      flowId,
      model,
      ctx,
      st,
      userPromptPreview,
      emitReasoningStep,
      onChunk,
      refHandles,
      llmPricing: this.appConfig.llmPricing,
      costTracker: this.costTracker,
      getDebugStore: () => this.debugStore,
      getRuntime: () => runtime,
    });
    const {
      toolNodes,
      emitToolNodeEnd,
      mergeToolTraceMetadata,
      onToolCall,
      onToolEffectiveArgs,
      onClientToolCall,
      onToolResult,
      onToolError,
      onApprovalRequired,
    } = toolCb;

    /** Upper bound on captured prompt/response length to keep events bounded. */
    const IO_CAPTURE_LIMIT = 16_000;
    const truncateIo = (s: string): string =>
      s.length > IO_CAPTURE_LIMIT
        ? s.slice(0, IO_CAPTURE_LIMIT) +
          `\n… [truncated ${s.length - IO_CAPTURE_LIMIT} chars]`
        : s;
    const debugErrors: DebugStreamError[] = [];
    // ---------------------------------------------------------------------
    /**
     * Outcome of the threaded-history contract for this turn. Only known once
     * the thread lock is held and the checkpoint has been read, so it is patched
     * onto the trace context afterwards rather than passed to `startTrace`.
     */
    let historyReconciliation: DebugHistoryReconciliation | undefined;
    startDebugTrace({
      getDebugStore: () => this.debugStore,
      executionId,
      flowId,
      flowVersion,
      flowDigest,
      subflowVersions,
      ctx,
      messages,
    });
    const lifecycle = createNodeLifecycle({
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
      metrics: this.metrics,
      spanManager,
      pricingOverrides,
      flowProgressEnabled,
      formatProgressDuration,
      emitReasoningStep,
      onChunk,
      runImageRefs,
      getDebugStore: () => this.debugStore,
    });
    const {
      captureEdgeFlow,
      recordEdge,
      edgeFlowBaselines,
      onNodeStart,
      emitNodeEnd,
      emitFlowEnd,
      onGroundedness,
    } = lifecycle;
    /** Last node that completed without error — source of the `__end__` edge. */
    let lastCompletedNodeId: string | undefined;
    /**
     * Running merge of every node's state update (same reducer semantics as
     * LangGraph). The entry state of a node lacks that node's OWN writes, so
     * the final edge into `__end__` — which has no following node to observe
     * them — is classified from this merged view instead. Initialised right
     * before the stream loop (once the thread-reconciled messages are final).
     */
    let mergedEdgeState: AgentState;

    // --- Content processing + multimodal conversion (Req 8.x) ---
    const contentErrors: StreamError[] = [];
    const baseMessages = messages.map((m) =>
      chatMessageToBaseMessage(m, (err) => contentErrors.push(err)),
    );
    for (const err of contentErrors) {
      await onChunk(makeErrorChunk(model, err));
    }

    const usage: UsageAccumulator = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      // `cachedPromptTokens` is deliberately left undefined rather than 0: the
      // node handlers only set it once a provider actually reports prompt-cache
      // usage, which keeps "no cache data available" distinguishable from a
      // confirmed zero cache reads. Only the latter indicates a broken
      // cacheable prefix, and reporting a hard 0 for local models (which have
      // no cache concept) would be a false alarm.
    };

    const runtime: ExecRuntime = {
      appConfig: this.appConfig,
      pricingOverrides,
      ...(this.mcpWrapper !== undefined ? { mcpWrapper: this.mcpWrapper } : {}),
      ctx,
      flowId,
      // The flow-level execution deadline. Handlers MUST compose this into any
      // long-running I/O they start (provider streams, MCP calls) — passing it
      // only to `graph.stream()` bounded the LangGraph loop at node boundaries
      // while leaving the actual provider call running past the timeout.
      signal: controller.signal,
      nodeErrorHandler,
      onToken,
      onReasoning,
      onToolCall,
      onToolEffectiveArgs,
      onToolTraceMetadata: mergeToolTraceMetadata,
      onClientToolCall,
      onToolResult,
      onToolError,
      onCitations,
      registerCitations,
      lookupCitation: citationAt,
      onNodeStart,
      onNodeEnd: emitNodeEnd,
      onNodeIo: (nodeId, io) => {
        if (io.prompt !== undefined) {
          nodePrompts.set(nodeId, truncateIo(io.prompt));
          nodeFullPrompts.set(nodeId, io.prompt);
        }
        if (io.response !== undefined) {
          nodeResponses.set(nodeId, truncateIo(io.response));
          nodeFullResponses.set(nodeId, io.response);
        }
        if (io.reasoning !== undefined) {
          nodeFullReasoning.set(nodeId, io.reasoning);
        }
      },
      onNodeRouting: (nodeId, decision) => {
        nodeRoutingDecisions.set(nodeId, decision);
      },
      // Edge data-flow capture: fires at every graph-node entry (compile.ts
      // wrapper). Only wired with a debug store — the Studio canvas reads the
      // resulting `edge_flows` after the run.
      ...(this.debugStore !== undefined
        ? { onNodeEntry: captureEdgeFlow }
        : {}),
      ...(this.debugStore !== undefined
        ? {
            onDebugToolSelection: (
              nodeId: string,
              selection: DebugToolSelection,
            ) => {
              nodeToolSelections.set(nodeId, selection);
            },
            onDebugClassification: (
              nodeId: string,
              output: DebugClassifierOutput,
            ) => {
              nodeClassifications.set(nodeId, output);
            },
            onNodeDiagnostic: st.recordNodeDiagnostic,
          }
        : {}),
      setGenAiAttributes: (nodeId, req, res) => {
        if (
          req !== undefined &&
          req.provider !== undefined &&
          req.model !== undefined
        ) {
          nodeModels.set(nodeId, `${req.provider}/${req.model}`);
        }
        if (res !== undefined) {
          if (res.inputTokens !== undefined)
            nodeInputTokens.set(
              nodeId,
              (nodeInputTokens.get(nodeId) ?? 0) + res.inputTokens,
            );
          if (res.outputTokens !== undefined)
            nodeOutputTokens.set(
              nodeId,
              (nodeOutputTokens.get(nodeId) ?? 0) + res.outputTokens,
            );
        }
        const span = spanManager.getNodeSpan(nodeId);
        if (span === undefined) return;
        if (req !== undefined) setGenAiRequestAttributes(span, req);
        if (res !== undefined) setGenAiResponseAttributes(span, res);
      },
      usage,
      llmProviderFactory: this.llmProviderFactory,
      // Flow-local decisions (a dead endpoint in this run must not skip the
      // provider in unrelated runs), while the reachability signal is also fed
      // to the engine-wide breaker that the operator monitoring plane reads.
      providerCircuitBreaker: createObservedProviderCircuitBreaker(
        this.providerCircuitBreaker,
      ),
      ...(this.mediaStore !== undefined &&
      this.appConfig.mediaBaseUrl !== undefined
        ? {
            publishMedia: (base64: string, mediaType: string) =>
              this.publishMediaUrl(base64, mediaType),
          }
        : {}),
      // Run-scoped image references. Unlike publishMedia this needs no
      // `mediaBaseUrl`: the bytes are only ever read back in-process by the
      // `inspect_image` tool, never served to a browser.
      ...(runImageRefs !== undefined ? { imageRefs: runImageRefs } : {}),
      ...(refHandles !== undefined ? { refHandles } : {}),
      metrics: this.metrics,
      authorizationEnabled: this.appConfig.authzEnabled ?? true,
      ...(this.costTracker !== undefined
        ? { costTracker: this.costTracker }
        : {}),
      ...(this.responseCache !== undefined
        ? { responseCache: this.responseCache }
        : {}),
      ...(this.semanticCache !== undefined
        ? { semanticCache: this.semanticCache }
        : {}),
      ...(this.approvalGate !== undefined
        ? {
            approvalGate:
              ctx.suppressSideEffects === true
                ? sideEffectFreeApprovalGate(this.approvalGate)
                : this.approvalGate,
            onApprovalRequired,
          }
        : {}),
      ...(this.groundednessGate !== undefined
        ? { groundednessGate: this.groundednessGate, onGroundedness }
        : {}),
      ...(this.embedder !== undefined ? { embedder: this.embedder } : {}),
      ...(this.vectorStore !== undefined
        ? { vectorStore: this.vectorStore }
        : {}),
      ...(this.reranker !== undefined ? { reranker: this.reranker } : {}),
      ...(this.toolIndex !== undefined ? { toolIndex: this.toolIndex } : {}),
      ...(this.toolGroupSummarizer !== undefined
        ? { toolGroupSummarizer: this.toolGroupSummarizer }
        : {}),
      ...(this.memoryStore !== undefined
        ? { memoryStore: this.memoryStore }
        : {}),
      // Per-user assistant subsystem. Absent on deployments that do not run
      // assistants, in which case the assistant node types pass their turn through.
      ...(this.assistants !== undefined ? { assistants: this.assistants } : {}),
      ...(this.assistantReviewScheduler !== undefined
        ? { assistantReviewScheduler: this.assistantReviewScheduler }
        : {}),
      // One loop-detection state per execution. Created here rather than held in a
      // module-level map keyed by session: a process-wide map would need reaping, and
      // a leak there would let one conversation's history influence another's loop
      // verdicts.
      toolLoopState: createToolLoopState(),
      ...(this.modelQuality !== undefined
        ? { modelQuality: this.modelQuality }
        : {}),
      ...(effectiveEgressGuardrail !== undefined
        ? { toolEgressGuardrail: effectiveEgressGuardrail }
        : {}),
      ...(this.toolAuthzEngine?.active
        ? { toolAuthzEngine: this.toolAuthzEngine }
        : {}),
      ...(this.compliancePolicy !== undefined
        ? { compliancePolicy: this.compliancePolicy }
        : {}),
      ...(this.toolOutputValidator?.enabled
        ? { toolOutputValidator: this.toolOutputValidator }
        : {}),
    };

    // --- Compile once (cached by checksum) + pass runtime via configurable ---
    const conversationId =
      this.checkpointer !== undefined &&
      typeof ctx.requestParams?.conversation_id === "string" &&
      (ctx.requestParams.conversation_id as string).length > 0
        ? (ctx.requestParams.conversation_id as string)
        : undefined;
    const threaded = conversationId !== undefined;
    // Checkpoint thread key.
    //
    // This MUST include the flow id. `conversation_id` is chosen by the client
    // (Open WebUI passes its chat id), and the same chat routinely drives more
    // than one flow: a coach flow, the CR generator it hands off to, and a
    // classifier can all be invoked with the same id. With a bare
    // `conversation_id` as `thread_id` and an empty `checkpoint_ns`, every one of
    // those flows read and wrote the SAME persisted transcript, so the CR
    // generator loaded the coach's dialogue (which its prompt does not expect)
    // and its own JSON answer came back as a prior assistant turn on the coach's
    // next turn — corrupting the coach's first-contact/continuation decision and
    // making it repeat questions. The thread-lock key already had the flow id;
    // the checkpoint key now matches it, so a thread is scoped to exactly one
    // flow. (Pre-existing checkpoints written under the bare conversation id are
    // not read by the new key: affected threads start fresh once, which is the
    // intended outcome for already-mixed state.)
    const threadKey = threaded ? `${flowId}:${conversationId}` : undefined;
    const graph = threaded
      ? this.buildCheckpointedGraph(resolvedFlow)
      : this.buildGraph(resolvedFlow);

    // Lock acquisition is bounded by the SAME deadline, so a stalled holder on
    // this conversation can no longer block later turns indefinitely (each
    // blocked turn was holding a concurrency slot while it waited).
    const threadHandle =
      threadKey !== undefined
        ? await this.threadLock.acquire(threadKey, {
            maxWaitMs: timeoutMs,
            signal: controller.signal,
          })
        : undefined;
    let finalResponse: string | undefined;
    let finalNodeId: string | undefined;

    try {
      // --- Threaded-history contract (see graph-engine/history-contract.ts) ---
      //
      // The persisted checkpoint is authoritative; only the request's genuinely
      // new tail is appended. Without this, a client that resends the whole
      // transcript each turn (the OpenAI Chat-Completions default) duplicated
      // every earlier turn through the append-only messages reducer. Read AFTER
      // the thread lock so it cannot race a concurrent turn on the same thread.
      //
      // A duplicate turn that repeats the thread's latest user message (double
      // submit, "regenerate") is REPLAYED from that turn's input checkpoint
      // instead of running on top of the old answer. Without the fork the
      // responder saw `[system, user, assistant(old answer), …]` plus the fresh
      // retrieval context and ended its answer early, and the append-only
      // reducer stacked a second answer onto the same turn. Forking keeps the
      // reducer untouched and the persisted thread consistent: the new
      // checkpoints descend from the base checkpoint and become the latest
      // state, the old branch stays in history (nothing is deleted). Tools of
      // the regenerated turn run again, exactly as they did for every duplicate
      // turn before this change. When the base checkpoint cannot be found the
      // turn falls back to the previous behaviour.
      let stateMessages = baseMessages;
      let forkCheckpointId: string | undefined;
      if (threaded) {
        let persisted: BaseMessage[] = [];
        try {
          const snapshot = await graph.getState({
            configurable: { thread_id: threadKey, checkpoint_ns: "" },
          });
          const values = snapshot?.values as
            | { messages?: BaseMessage[] }
            | undefined;
          if (Array.isArray(values?.messages)) persisted = values.messages;
        } catch {
          // A checkpoint that cannot be read is treated as "no thread yet":
          // appending the full request transcript still produces a correct turn,
          // whereas failing the request would lose the user's message.
          persisted = [];
        }
        const reconciled = reconcileThreadedHistory(persisted, baseMessages);
        stateMessages = reconciled.messages;
        let regenerate: DebugHistoryReconciliation["regenerate"];
        if (reconciled.duplicateTurn) {
          const plan = planDuplicateTurnRegenerate(
            persisted,
            baseMessages,
            reconciled,
          );
          if (plan.kind === "regenerate") {
            let baseCheckpointId: string | undefined;
            let unreadable = false;
            try {
              for await (const snap of graph.getStateHistory(
                { configurable: { thread_id: threadKey, checkpoint_ns: "" } },
                { limit: REGENERATE_HISTORY_SCAN_LIMIT },
              )) {
                const checkpointId = snap.config.configurable?.checkpoint_id;
                if (typeof checkpointId !== "string") continue;
                const values = snap.values as
                  | { messages?: BaseMessage[] }
                  | undefined;
                baseCheckpointId = findRegenerateBaseCheckpoint(
                  persisted,
                  plan.userIndex,
                  [
                    {
                      checkpointId,
                      source: snap.metadata?.source,
                      messages: Array.isArray(values?.messages)
                        ? values.messages
                        : [],
                    },
                  ],
                );
                if (baseCheckpointId !== undefined) break;
              }
            } catch {
              unreadable = true;
              baseCheckpointId = undefined;
            }
            const lastIncoming = baseMessages[baseMessages.length - 1];
            if (baseCheckpointId !== undefined && lastIncoming !== undefined) {
              forkCheckpointId = baseCheckpointId;
              stateMessages = [lastIncoming];
              regenerate = {
                outcome: "duplicate_turn_regenerated",
                base_checkpoint_id: baseCheckpointId,
                replaced_messages: persisted.length - plan.userIndex - 1,
              };
              this.logger?.info("Duplicate turn regenerated from turn start", {
                execution_id: executionId,
                flow_id: flowId,
                thread_key: threadKey,
                base_checkpoint_id: baseCheckpointId,
                replaced_messages: persisted.length - plan.userIndex - 1,
              });
            } else {
              const reason = unreadable
                ? "history_unreadable"
                : "base_checkpoint_not_found";
              regenerate = { outcome: "duplicate_turn_kept", reason };
              this.logger?.warn(
                "Duplicate turn could not be regenerated; continuing on the persisted thread",
                {
                  execution_id: executionId,
                  flow_id: flowId,
                  thread_key: threadKey,
                  reason,
                },
              );
            }
          } else if (plan.reason !== "not_duplicate") {
            regenerate = { outcome: "duplicate_turn_kept", reason: plan.reason };
          }
        }
        if (reconciled.dropped > 0) {
          this.metrics.recordCounter(
            "aiperator_thread_history_reconciled_total",
            {
              flow: flowId,
              outcome:
                forkCheckpointId !== undefined
                  ? "duplicate_turn_regenerated"
                  : reconciled.duplicateTurn
                    ? "duplicate_turn"
                    : "trimmed",
            },
            reconciled.dropped,
          );
        }
        historyReconciliation = {
          persisted: persisted.length,
          incoming: reconciled.incoming,
          dropped: reconciled.dropped,
          appended: stateMessages.length,
          duplicate_turn: reconciled.duplicateTurn,
          ...(regenerate !== undefined ? { regenerate } : {}),
        };
      }

      // Record the thread identity and the reconciliation on the trace. This is
      // what makes "the same answer three times" diagnosable after the fact:
      // `thread_key` shows whether two runs shared persisted history, and
      // `duplicate_turn` shows whether the request added anything at all.
      this.debugStore?.annotateContext(executionId, {
        ...(conversationId !== undefined
          ? { conversation_id: conversationId }
          : {}),
        ...(threadKey !== undefined ? { thread_key: threadKey } : {}),
        ...(historyReconciliation !== undefined
          ? { history_reconciliation: historyReconciliation }
          : {}),
      });

      const initialState: Partial<AgentState> = {
        messages: stateMessages,
        context: ctx,
        citations: [],
        toolResults: [],
        errors: [],
      };
      // Seed the edge-flow merged view with the initial state (see the
      // declaration above for why the final `__end__` edge needs it).
      mergedEdgeState = {
        ...(initialState as AgentState),
        messages: stateMessages,
      };

      const streamIterator = await graph.stream(initialState, {
        streamMode: "updates",
        configurable: {
          runtime,
          ...(threaded ? { thread_id: threadKey, checkpoint_ns: "" } : {}),
          ...(forkCheckpointId !== undefined
            ? { checkpoint_id: forkCheckpointId }
            : {}),
        },
        signal: controller.signal,
      });

      const sourceMap = new Map<
        string,
        {
          source: { name: string; url?: string };
          document: string[];
          metadata: { source: string; name?: string }[];
          distances: number[];
        }
      >();

      for await (const updateChunk of streamIterator) {
        const updates = updateChunk as Record<string, Partial<AgentState>>;
        for (const [nodeId, nodeUpdate] of Object.entries(updates)) {
          if (nodeId === "__start__" || nodeId === "__end__") continue;
          for (const message of nodeUpdate.messages ?? []) {
            if (
              message._getType() === "ai" &&
              typeof message.content === "string" &&
              message.content.trim().length > 0
            ) {
              finalResponse = message.content;
              finalNodeId = nodeId;
            }
          }
          const nodeErrors = nodeUpdate.errors ?? [];
          const nodeErrorMsg =
            nodeErrors.length > 0
              ? nodeErrors.map((e) => e.message).join("; ")
              : undefined;
          for (const error of nodeErrors) {
            await onChunk(makeErrorChunk(model, error));
            debugErrors.push({
              message: error.message,
              type: error.type,
              ...(error.details !== undefined
                ? { details: error.details as Record<string, unknown> }
                : {}),
            });
          }
          // Preserve the structured error (type + details) of the FIRST error
          // that failed this node so the debug trace can triage it without
          // re-parsing the joined message string.
          const first = nodeErrors[0];
          if (first !== undefined && !nodeErrorInfo.has(nodeId)) {
            nodeErrorInfo.set(nodeId, {
              ...(first.type !== undefined ? { type: first.type } : {}),
              ...(first.details !== undefined
                ? { details: first.details as Record<string, unknown> }
                : {}),
            });
          }
          await emitNodeEnd(nodeId, nodeErrorMsg);

          // Edge-flow merged view: fold this node's update in with the same
          // reducer semantics as LangGraph (messages/toolResults/citations
          // concat, classification last-write) so the final `__end__` edge can
          // be classified from the complete post-run state.
          mergedEdgeState = {
            ...mergedEdgeState,
            messages: mergedEdgeState.messages.concat(
              nodeUpdate.messages ?? [],
            ),
            toolResults: mergedEdgeState.toolResults.concat(
              nodeUpdate.toolResults ?? [],
            ),
            citations: mergedEdgeState.citations.concat(
              nodeUpdate.citations ?? [],
            ),
            ...(nodeUpdate.classification !== undefined
              ? { classification: nodeUpdate.classification }
              : {}),
          };
          if (nodeErrorMsg === undefined) lastCompletedNodeId = nodeId;

          const nodeCitations = nodeUpdate.citations ?? [];
          for (const cit of nodeCitations) {
            const key = cit.url || cit.title;
            const existing = sourceMap.get(key);
            if (existing) {
              existing.document.push(cit.snippet);
              existing.metadata.push({
                source: cit.url || cit.title,
                name: cit.title,
              });
              existing.distances.push(cit.similarity_score);
            } else {
              sourceMap.set(key, {
                source: {
                  name: cit.title,
                  ...(cit.url ? { url: cit.url } : {}),
                },
                document: [cit.snippet],
                metadata: [{ source: cit.url || cit.title, name: cit.title }],
                distances: [cit.similarity_score],
              });
            }
          }
        }
      }

      // Final edge into `__end__`: the answer the user sees crossed it. The
      // merged view carries the last node's own writes (its entry state did
      // not), so classify from it with the last node's entry baseline.
      if (
        this.debugStore !== undefined &&
        lastCompletedNodeId !== undefined &&
        finalResponse !== undefined
      ) {
        recordEdge(
          lastCompletedNodeId,
          "__end__",
          mergedEdgeState,
          edgeFlowBaselines.get(lastCompletedNodeId),
        );
      }

      // Emit the merged sources chunk(s) once, before onDone/[DONE].
      //
      // Split into byte-bounded batches so no single SSE line exceeds the
      // aiohttp 131072-byte (128 KiB) per-line cap of Open WebUI's client. A
      // grounding-heavy flow (for example, one that grounds on the
      // full get_summaries overview) aggregates hundreds of documents here,
      // each with snippets — serialised into one chunk that far exceeds the cap
      // and aborts the client read with "Got more than 131072 bytes when
      // reading". Open WebUI merges `sources` across chunks, so splitting is
      // transparent.
      if (sourceMap.size > 0) {
        const allSources = Array.from(sourceMap.values());
        const makeMergedSourcesChunk = (
          sources: typeof allSources,
        ): ChatCompletionChunk =>
          ({
            id: crypto.randomUUID(),
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [],
            sources,
          }) as unknown as ChatCompletionChunk;
        const mergedEnvelopeBytes = Buffer.byteLength(
          JSON.stringify(makeMergedSourcesChunk([])),
        );
        try {
          for (const batch of batchBySerializedBytes(
            allSources,
            120_000,
            mergedEnvelopeBytes,
          )) {
            await onChunk(makeMergedSourcesChunk(batch));
          }
        } catch {
          /* client disconnected */
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        st.flowErrored = true;
        const timeoutMessage =
          `Flow "${flowId}" execution exceeded the ${timeoutMs}ms timeout and was aborted.`;
        // graph.stream() can abort before it yields a terminal update for the
        // active node. Explicitly close all still-started nodes so monitoring,
        // Postgres and the debug trace receive an error event with finished_at.
        for (const activeNodeId of [...activeNodeIds]) {
          nodeErrorInfo.set(activeNodeId, {
            type: "execution_error",
            details: { flow_id: flowId, timeout_ms: timeoutMs },
          });
          await emitNodeEnd(activeNodeId, timeoutMessage);
        }
        const timeoutError: StreamError = {
          message: timeoutMessage,
          type: "execution_error",
          details: { flow_id: flowId, timeout_ms: timeoutMs },
        };
        await onChunk(makeErrorChunk(model, timeoutError));
        debugErrors.push({
          message: timeoutError.message,
          type: timeoutError.type,
          details: { flow_id: flowId, timeout_ms: timeoutMs },
        });
      } else {
        spanManager.recordFlowException(err);
        spanManager.endFlow("error");
        if (this.debugStore !== undefined) {
          this.debugStore.finishTrace(
            executionId,
            "error",
            {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
            },
            [
              ...debugErrors,
              {
                message: err instanceof Error ? err.message : String(err),
                type: "execution_error",
                details: { flow_id: flowId },
              },
            ],
          );
        }
        // Terminal rollup marker: without this the execution would stay
        // "running" in the history store forever — the exception skips the
        // success path below, and the chat route's `__response__` boundary
        // only covers requests that go through it (not triggers/MCP).
        emitFlowEnd("error");
        throw err;
      }
    } finally {
      // Only clear a timer we own; `executeFlow` clears the one it created.
      if (timer !== undefined) clearTimeout(timer);
      await threadHandle?.release();
      for (const toolCallId of [...toolNodes.keys()]) {
        emitToolNodeEnd(toolCallId, 0);
      }
    }

    // Close the flow span (success or handled timeout).
    spanManager.endFlow(st.flowErrored ? "error" : "ok");

    try {
      if (flowProgressEnabled) {
        const outcome = st.flowErrored
          ? "mit Fehlern beendet"
          : "abgeschlossen";
        await emitReasoningStep(
          `⚙️ Recherche ${outcome} · Gesamtlaufzeit ${formatProgressDuration(
            Date.now() - flowProgressStartedAt,
          )}\n`,
        );
      }

      if (
        !st.flowErrored &&
        finalResponse !== undefined &&
        onFinalResponse !== undefined
      ) {
        await onFinalResponse(finalResponse);
      }

      await onDone({
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
        ...(usage.costUsd !== undefined && usage.costUsd > 0
          ? { cost_usd: Math.round(usage.costUsd * 1e6) / 1e6 }
          : {}),
        // Only present when a provider in this run reported prompt-cache usage,
        // so an OpenAI-compatible client can read the cache hit rate the same way
        // it would from OpenAI itself.
        ...(usage.cachedPromptTokens !== undefined
          ? {
              prompt_tokens_details: {
                cached_tokens: usage.cachedPromptTokens,
              },
            }
          : {}),
      });
      if (this.debugStore !== undefined) {
        this.debugStore.finishTrace(
          executionId,
          st.flowErrored ? "error" : "completed",
          {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
          },
          debugErrors,
          finalResponse !== undefined
            ? {
                response: finalResponse,
                ...(finalNodeId !== undefined ? { nodeId: finalNodeId } : {}),
              }
            : undefined,
        );
      }
      emitFlowEnd(st.flowErrored ? "error" : "completed");
    } catch (err) {
      // The flow itself finished but delivering the result failed (e.g. the
      // client disconnected in `onDone`). Without a terminal marker the
      // execution would stay "running" in the rollup forever.
      emitFlowEnd("error");
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGraphEngine(
  appConfig: AppConfig,
  options: GraphEngineOptions = {},
): GraphEngineService {
  return new GraphEngineServiceImpl(appConfig, options);
}
