// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Graph Engine — Service implementation and factory.
 *
 * Contains the GraphEngineServiceImpl class (runtime injection, message
 * mapping, tool building, execution orchestration) and the createGraphEngine
 * factory function.
 *
 * NOTE: This file exceeds the 800-line target. The _executeFlowInternal method
 * constructs ~20 tightly-coupled closure callbacks that share local state
 * (Maps, counters, spans). The two pieces whose state genuinely stood alone —
 * SSE token/reasoning streaming and citation numbering — are extracted into
 * sse-emitter.ts / citation-registry.ts. The rest (tool-call tracking,
 * per-node monitoring, debug-trace capture) share ~10 Maps and call into each
 * other (e.g. emitNodeEnd reads nodeModels/nodeInputTokens/nodeToolCalls
 * alongside spans, guardrail flush, and the debug store in one step); splitting
 * those further would mean threading that shared state through constructors
 * rather than reducing coupling. Documented exception per design.md §1.1.
 */

import crypto from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import type { FlowDefinition, FlowNode } from "../../types/flow.js";
import type {
  RequestContext,
  NodeExecutionEvent,
  RoutingDecision,
} from "../../types/monitoring.js";
import { FLOW_END_NODE_ID } from "../../types/monitoring.js";
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
import {
  chatMessageToBaseMessage,
  isToolErrorOutput,
  sanitizeToolResultOutput,
} from "../message-mapping.js";
import type { ModelQualityRegistry } from "../model-quality.js";
import type { ResponseCache } from "../response-cache.js";
import type { SemanticCache } from "../semantic-cache.js";
import type { Embedder } from "../semantic-cache.js";
import type { VectorStore } from "../vector-store.js";
import type { Reranker } from "../reranker.js";
import { parseVectorSearchResults } from "../reranker.js";
import { ToolIndex } from "../tool-index.js";
import { createToolLoopState } from "../tool-loop-detection.js";
import type { ToolGroupSummarizer } from "../tool-group-summary.js";
import type { MemoryStore } from "../memory-store.js";
import type { MediaStore } from "../media-store.js";
import { decodeBase64Bytes, mediaExtension } from "../media-store.js";
import { HashedImageRefRegistry } from "../image-reference.js";
import { HashRefHandleRegistry } from "../ref-handles.js";
import { classifyEdgeFlow } from "../edge-flow.js";
import type { EdgeFlowCounters } from "../edge-flow.js";
import type { OutputGuardrail } from "../output-guardrails.js";
import type { ToolEgressGuardrail } from "../output-guardrails.js";
import type { FlowGuardrailOverride } from "../flow-guardrail-resolver.js";
import type { ApprovalRegistry, PendingApproval } from "../approval-gate.js";
import { signApprovalLinkToken } from "../approval-link.js";
import type { GroundednessGate, GroundednessReport } from "../groundedness.js";
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
import { sanitizeJwtClaims } from "../../monitoring/trace-claims.js";
import type {
  DebugToolCall,
  DebugToolSelection,
  DebugClassifierOutput,
  DebugStreamError,
  DebugNodeDiagnostic,
  DebugNodeAttemptContext,
  DebugNodeTrace,
  DebugHistoryReconciliation,
} from "../../types/debug-trace.js";
import { reconcileThreadedHistory } from "./history-contract.js";
import type { Metrics } from "../../observability/metrics.js";
import { createMetrics } from "../../observability/metrics.js";
import type { SpendRecorder } from "../../observability/cost.js";
import { estimateCost } from "../../observability/cost.js";
import type { Tracer } from "../../observability/tracing.js";
import { NOOP_TRACER } from "../../observability/tracing.js";
import { createFlowSpanManager } from "./spans.js";
import type { FlowSpanManager } from "./spans.js";
import {
  setGenAiRequestAttributes,
  setGenAiResponseAttributes,
} from "../../observability/gen-ai-semconv.js";
import {
  makeToolCallChunk,
  makeErrorChunk,
  batchBySerializedBytes,
} from "../exec-runtime.js";
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

// ---------------------------------------------------------------------------
// Provider-attempt summary for the debug trace
// ---------------------------------------------------------------------------

/**
 * Summarises the `llm_provider_attempt_completed` diagnostics of one node
 * attempt into the trace field `provider_attempts`. The node-level `attempt`
 * counts GRAPH attempts only, so without this an LLM node that needed two
 * provider calls looked like a single clean call in the trace. Returns
 * `undefined` when no provider attempt was recorded (non-LLM nodes, cache
 * hits), so the field stays absent.
 */
export function providerAttemptsSummary(
  diagnostics: readonly DebugNodeDiagnostic[] | undefined,
): { provider_attempts: NonNullable<DebugNodeTrace["provider_attempts"]> } | undefined {
  const completed = (diagnostics ?? []).filter(
    (d) => d.code === "llm_provider_attempt_completed",
  );
  const last = completed.at(-1);
  if (last === undefined) return undefined;
  const failed = completed.filter((d) => d.details?.outcome !== "ok").length;
  const lastAttempt = last.details?.attempt;
  return {
    provider_attempts: {
      total: completed.length,
      failed,
      final_attempt:
        typeof lastAttempt === "number" ? lastAttempt : completed.length,
      final_outcome: last.details?.outcome === "ok" ? "ok" : "error",
    },
  };
}

// ---------------------------------------------------------------------------
// Tool-reported usage/cost extraction
// ---------------------------------------------------------------------------

export interface ToolReportedUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/**
 * Extracts a tool-reported `usage` block from a raw MCP tool result, when
 * present (e.g. vectorsearch's `search`/`ingest` tools report their own
 * embedding/rerank spend as `{ usage: { input_tokens, output_tokens,
 * cost, model_costs } }`). Handles the MCP text-content wrapper
 * (`[{type:"text", text:"<json>"}]`), a raw JSON string, or an
 * already-parsed object. Returns undefined for any tool result that isn't
 * shaped this way — safe to call on any tool's result.
 */
export function extractToolUsage(
  content: unknown,
): ToolReportedUsage | undefined {
  let parsed: unknown = content;
  try {
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof parsed[0] === "object" &&
      parsed[0] !== null &&
      "text" in (parsed[0] as Record<string, unknown>)
    ) {
      parsed = JSON.parse((parsed[0] as { text: string }).text);
    } else if (typeof parsed === "string") {
      parsed = JSON.parse(parsed);
    }
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const usage = (parsed as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const cost = u.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost))
    return undefined;
  const inputTokens =
    typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outputTokens =
    typeof u.output_tokens === "number" ? u.output_tokens : 0;
  return { inputTokens, outputTokens, cost };
}

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
    let flowErrored = false;

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

    // Tracks in-flight tool calls so onToolResult can build the <details> block
    const _pendingToolCallIds = new Map<
      string,
      { name: string; argsJson: string }
    >();

    // -----------------------------------------------------------------------
    // Synthetic "tool" nodes
    // -----------------------------------------------------------------------
    const toolNodes = new Map<
      string,
      { nodeId: string; parentId: string; startTime: string; sequence: number }
    >();
    /**
     * Captured input (args) and output (result) per tool call, so the synthetic
     * tool node in the live graph can show what a tool (e.g. vectorsearch) was
     * called with and what it returned — not just its timing/token/cost.
     */
    const toolNodeArgs = new Map<string, string>();
    const toolNodeResults = new Map<string, string>();
    const TOOL_IO_LIMIT = 16_000;
    const truncateToolIo = (s: string): string =>
      s.length > TOOL_IO_LIMIT
        ? `${s.slice(0, TOOL_IO_LIMIT)}…[truncated]`
        : s;
    /**
     * Effective tool-call arguments (after forced flow args, ref-handle
     * resolution and egress DLP), reported by `onToolEffectiveArgs` from
     * inside the tool execution. `onToolCall` only ever sees the RAW model
     * output, which is pre-DLP and therefore reduced to `argument_keys` for
     * telemetry — which left operators unable to see the actual search query
     * a tool ran with. The effective arguments are exactly what the tool
     * received (in redact mode already scrubbed), so they may be surfaced
     * wherever the full tool RESULT is already shown: the live graph node,
     * the debug trace and the reasoning `<details>` block.
     */
    const toolEffectiveArgs = new Map<string, string>();
    /**
     * Builds the display "response" text for a tool node. Any tool result that
     * parses as a vectorsearch-style payload (`{ results: [...] }`, incl. the
     * MCP text-content wrapper) is normalised into a compact
     * `{ totalMatches, findings:[{id,title,score,url}] }` shape the dashboard
     * renders as a findings table — this is name-agnostic, so it works for
     * vectorsearch, retrieval, and any other tool returning that shape.
     * `parseVectorSearchResults` returns `[]` for anything else, in which case
     * the raw result JSON is used. Returns undefined when there is nothing to
     * show.
     */
    const buildToolResultDisplay = (content: unknown): string | undefined => {
      const chunks = parseVectorSearchResults(content);
      if (chunks.length > 0) {
        return JSON.stringify({
          totalMatches: chunks.length,
          findings: chunks.map((c) => ({
            id: c.id,
            title: c.title,
            score: c.retrievalScore,
            ...(c.url !== "" ? { url: c.url } : {}),
          })),
        });
      }
      try {
        return typeof content === "string" ? content : JSON.stringify(content);
      } catch {
        return undefined;
      }
    };
    /** Emits the "running" event for a synthetic tool node. */
    const emitToolNodeStart = (toolCallId: string, toolName: string): void => {
      if (!monitoring) return;
      const parentId = lastActiveNodeId ?? "";
      const nodeId = `${parentId}::tool::${toolCallId}`;
      const startTime = new Date().toISOString();
      nodeSequence += 1;
      const sequence = nodeSequence;
      toolNodes.set(toolCallId, { nodeId, parentId, startTime, sequence });
      monitoring.emitNodeEvent(
        executionId,
        {
          execution_id: executionId,
          node_id: nodeId,
          kind: "tool",
          ...(parentId !== "" ? { parent_node_id: parentId } : {}),
          label: toolName,
          status: "running",
          start_time: startTime,
          end_time: null,
          latency_ms: null,
          sequence,
          // Identity fields, stamped like regular node events (see
          // userPromptPreview below): a live picker row built solely from
          // tool-node events (e.g. when the dashboard joined mid-run and
          // missed the parent node's events) would otherwise show no user
          // or prompt until the parent node finally completes.
          ...(ctx.userName !== undefined ? { user_name: ctx.userName } : {}),
          ...(userPromptPreview !== undefined
            ? { user_prompt: userPromptPreview }
            : {}),
          flow_id: flowId,
        },
        monitoringMeta,
      );
    };
    /** Emits the terminal (completed/error) event for a synthetic tool node. */
    const emitToolNodeEnd = (
      toolCallId: string,
      execTimeSec: number,
      errorMessage?: string,
    ): void => {
      if (!monitoring) return;
      const info = toolNodes.get(toolCallId);
      if (info === undefined) return;
      toolNodes.delete(toolCallId);
      let toolCost: number | undefined = nodeToolCostOverride.get(toolCallId);
      nodeToolCostOverride.delete(toolCallId);
      const toolModelKey = nodeModels.get(toolCallId);
      if (toolCost === undefined && toolModelKey !== undefined) {
        const slash = toolModelKey.indexOf("/");
        const provider =
          slash >= 0 ? toolModelKey.slice(0, slash) : toolModelKey;
        const modelName =
          slash >= 0 ? toolModelKey.slice(slash + 1) : toolModelKey;
        const inp = nodeInputTokens.get(toolCallId) ?? 0;
        const out = nodeOutputTokens.get(toolCallId) ?? 0;
        if (inp > 0 || out > 0) {
          toolCost = estimateCost(
            provider,
            modelName,
            { prompt_tokens: inp, completion_tokens: out },
            this.appConfig.llmPricing,
          );
        }
      }
      monitoring.emitNodeEvent(
        executionId,
        {
          execution_id: executionId,
          node_id: info.nodeId,
          kind: "tool",
          ...(info.parentId !== "" ? { parent_node_id: info.parentId } : {}),
          status: errorMessage !== undefined ? "error" : "completed",
          start_time: info.startTime,
          end_time: new Date().toISOString(),
          latency_ms: Math.round(execTimeSec * 1000),
          ...(errorMessage !== undefined
            ? { error_message: errorMessage }
            : {}),
          sequence: info.sequence,
          ...(toolModelKey !== undefined ? { model: toolModelKey } : {}),
          ...(nodeInputTokens.has(toolCallId)
            ? { input_tokens: nodeInputTokens.get(toolCallId) }
            : {}),
          ...(nodeOutputTokens.has(toolCallId)
            ? { output_tokens: nodeOutputTokens.get(toolCallId) }
            : {}),
          ...(toolCost !== undefined ? { cost: toolCost } : {}),
          ...(toolNodeArgs.has(toolCallId)
            ? { prompt: toolNodeArgs.get(toolCallId) }
            : {}),
          ...(toolNodeResults.has(toolCallId)
            ? { response: toolNodeResults.get(toolCallId) }
            : {}),
          // See emitToolNodeStart: keep identity fields on every tool event.
          ...(ctx.userName !== undefined ? { user_name: ctx.userName } : {}),
          ...(userPromptPreview !== undefined
            ? { user_prompt: userPromptPreview }
            : {}),
          flow_id: flowId,
        },
        monitoringMeta,
      );
      toolNodeArgs.delete(toolCallId);
      toolNodeResults.delete(toolCallId);
    };

    // --- Tool streaming callbacks (Req 6.2, 6.3) ---
    type ToolTraceMetadata = NonNullable<DebugToolCall["coverage_search"]>;
    const pendingToolTraceMetadata = new Map<string, ToolTraceMetadata>();
    const toolCallOwnerNodeIds = new Map<string, string>();
    const mergeToolTraceMetadata = (
      toolCallId: string,
      metadata: ToolTraceMetadata,
    ): void => {
      const previous = pendingToolTraceMetadata.get(toolCallId);
      const merged: ToolTraceMetadata = {
        ...previous,
        ...metadata,
        ...(previous?.dedupe !== undefined || metadata.dedupe !== undefined
          ? { dedupe: { ...previous?.dedupe, ...metadata.dedupe } as ToolTraceMetadata["dedupe"] }
          : {}),
      };
      pendingToolTraceMetadata.set(toolCallId, merged);
      if (this.debugStore === undefined) return;
      const ownerNodeId = toolCallOwnerNodeIds.get(toolCallId);
      const call =
        ownerNodeId === undefined
          ? undefined
          : nodeDebugToolCalls
              .get(ownerNodeId)
              ?.findLast((item) => item.id === toolCallId);
      if (call !== undefined) {
        call.coverage_search = merged;
        pendingToolTraceMetadata.delete(toolCallId);
      }
    };

    const onToolCall = async (
      toolCallId: string,
      toolName: string,
      argsJson: string,
      ownerNodeId?: string,
    ): Promise<void> => {
      let safeArgsJson = '{"argument_keys":[]}';
      try {
        const args = JSON.parse(argsJson) as unknown;
        const keys =
          args !== null && typeof args === "object" && !Array.isArray(args)
            ? Object.keys(args as Record<string, unknown>).sort()
            : [];
        safeArgsJson = JSON.stringify({ argument_keys: keys });
      } catch {
        // Invalid arguments are represented by an empty key list, never raw.
      }
      // Tool arguments are pre-DLP model output. Telemetry records shape only;
      // execution receives the original value through the AI SDK tool closure.
      // The SDK can start the tool's execute BEFORE this stream consumer
      // reaches the tool-call part, so effective args may already exist —
      // surface them immediately instead of the key-only placeholder.
      const preEffective = toolEffectiveArgs.get(toolCallId);
      const visibleArgsJson = preEffective ?? safeArgsJson;
      toolNodeArgs.set(toolCallId, visibleArgsJson);
      if (!_pendingToolCallIds.has(toolCallId)) {
        _pendingToolCallIds.set(toolCallId, {
          name: toolName,
          argsJson: safeArgsJson,
        });
      }
      emitToolNodeStart(toolCallId, toolName);
      const activeNodeId = ownerNodeId ?? lastActiveNodeId;
      if (activeNodeId !== undefined) {
        toolCallOwnerNodeIds.set(toolCallId, activeNodeId);
        const existing = nodeToolCalls.get(activeNodeId) ?? [];
        existing.push({
          id: toolCallId,
          name: toolName,
          args_json: visibleArgsJson,
        });
        nodeToolCalls.set(activeNodeId, existing);
      }
      if (this.debugStore !== undefined && activeNodeId !== undefined) {
        let debugArguments: unknown;
        try {
          debugArguments = JSON.parse(visibleArgsJson) as unknown;
        } catch {
          // Truncated effective args are not valid JSON — fall back to the
          // key-only placeholder rather than failing the whole call.
          debugArguments = JSON.parse(safeArgsJson) as unknown;
        }
        const debugCalls = nodeDebugToolCalls.get(activeNodeId) ?? [];
        debugCalls.push({
          id: toolCallId,
          name: toolName,
          arguments: debugArguments,
          result: null,
          is_error: false,
          called_at: new Date().toISOString(),
          ...(pendingToolTraceMetadata.has(toolCallId)
            ? { coverage_search: pendingToolTraceMetadata.get(toolCallId) }
            : {}),
        });
        pendingToolTraceMetadata.delete(toolCallId);
        nodeDebugToolCalls.set(activeNodeId, debugCalls);
      }
      // The initial line carries NO argument payload: at this moment only the
      // raw pre-DLP model output exists, and showing just its keys
      // (`argument_keys`) carried no value for operators. It stays as the
      // "call started" marker (still shown when a tool errors before its
      // effective args exist — approval denial, missing required params,
      // egress block). The full key-value JSON follows on the next
      // `🔧 Tool:` line from `onToolEffectiveArgs`. When the effective args
      // already arrived BEFORE this callback (a fast tool execute racing the
      // stream consumer), that line was emitted already — skip this one.
      if (preEffective === undefined) {
        await emitReasoningStep(`🔧 Tool: **${toolName}**\n`);
      }
    };

    /**
     * Receives the final server-bound arguments once the tool execution
     * derives them (forced args + ref handles + egress DLP applied). Replaces
     * the key-only placeholder on every surface that renders AFTER this point:
     * the live graph node prompt (read at node completion), the owning node's
     * `tool_calls` telemetry (the dashboard's Tool Calls accordion), the
     * debug-trace tool call, and the `<details>` block built by
     * `onToolResult`. It also emits the follow-up `🔧 Tool:` reasoning line
     * carrying the FULL key-value JSON — the effective args are exactly what
     * the tool received (already egress-DLP scrubbed), so they are safe to
     * stream wherever the full tool RESULT is shown.
     */
    const onToolEffectiveArgs = async (
      toolCallId: string,
      toolName: string,
      argsJson: string,
    ): Promise<void> => {
      // Prefer the name `onToolCall` used for the first `🔧 Tool:` line so the
      // follow-up matches it exactly (MCP reports the `server/tool` ref there,
      // while the call line shows the AI-SDK tool key).
      const displayName =
        _pendingToolCallIds.get(toolCallId)?.name ?? toolName;
      const safe = truncateToolIo(argsJson);
      toolEffectiveArgs.set(toolCallId, safe);
      toolNodeArgs.set(toolCallId, safe);
      let parsedValid = false;
      try {
        JSON.parse(argsJson);
        parsedValid = true;
      } catch {
        /* invalid JSON stays key-only on every user-facing surface */
      }
      const ownerNodeId = toolCallOwnerNodeIds.get(toolCallId);
      const call =
        ownerNodeId === undefined
          ? undefined
          : nodeDebugToolCalls
              .get(ownerNodeId)
              ?.findLast((item) => item.id === toolCallId);
      if (call !== undefined && parsedValid) {
        call.arguments = JSON.parse(argsJson) as unknown;
      }
      if (ownerNodeId !== undefined && parsedValid) {
        const tc = nodeToolCalls
          .get(ownerNodeId)
          ?.findLast(
            (item) =>
              item.id === toolCallId && item.exec_time_seconds === undefined,
          );
        if (tc !== undefined) tc.args_json = safe;
      }
      if (parsedValid) {
        try {
          await emitReasoningStep(
            `🔧 Tool: **${displayName}** (arguments: ${safe})\n`,
          );
        } catch {
          /* client disconnect — telemetry must never break tool execution */
        }
      }
    };

    // --- Client tool-call passthrough callback ---
    let clientToolCallIndex = 0;
    const onClientToolCall = async (
      toolCallId: string,
      toolName: string,
      argsJson: string,
    ): Promise<void> => {
      const activeNodeId = lastActiveNodeId;
      if (activeNodeId !== undefined) {
        const existing = nodeToolCalls.get(activeNodeId) ?? [];
        existing.push({ id: toolCallId, name: toolName, args_json: argsJson });
        nodeToolCalls.set(activeNodeId, existing);
      }
      await onChunk(
        makeToolCallChunk(
          crypto.randomUUID(),
          model,
          toolCallId,
          toolName,
          argsJson,
          clientToolCallIndex++,
        ),
      );
      // A client tool has no server-side execute, so nothing ever fires
      // `onToolEffectiveArgs` for it and the node would show no INPUT at all.
      // The raw args are already handed to the client verbatim above and
      // recorded in `nodeToolCalls`, so surfacing them on the node is not a
      // new exposure — it just makes the live graph consistent with the
      // server-side tools, whose effective key-value args are visible there.
      // Must be set BEFORE the end-emit: `emitToolNodeEnd` deletes the entry.
      toolNodeArgs.set(toolCallId, truncateToolIo(argsJson));
      emitToolNodeStart(toolCallId, toolName);
      emitToolNodeEnd(toolCallId, 0);
    };

    const onToolError = (
      toolCallId: string,
      _errorMessage: string,
      execTimeSec: number,
    ): void => {
      const safeMessage = "Tool execution failed.";
      const visibleContent = {
        isError: true,
        error: {
          name: "ToolExecutionError",
          message: safeMessage,
        },
      };
      toolNodeResults.set(toolCallId, JSON.stringify(visibleContent));
      const activeNodeId =
        toolCallOwnerNodeIds.get(toolCallId) ?? lastActiveNodeId;
      if (activeNodeId !== undefined) {
        const calls = nodeToolCalls.get(activeNodeId);
        const call = calls?.findLast(
          (item) =>
            item.id === toolCallId && item.exec_time_seconds === undefined,
        );
        if (call !== undefined) {
          call.exec_time_seconds = Math.round(execTimeSec * 1000) / 1000;
        }
        const debugCalls = nodeDebugToolCalls.get(activeNodeId);
        const debugCall = debugCalls?.findLast(
          (item) => item.id === toolCallId && item.result === null,
        );
        if (debugCall !== undefined) {
          debugCall.result = visibleContent;
          debugCall.exec_time_seconds =
            Math.round(execTimeSec * 1000) / 1000;
          debugCall.is_error = true;
        }
      }
      toolCallOwnerNodeIds.delete(toolCallId);
      _pendingToolCallIds.delete(toolCallId);
      emitToolNodeEnd(toolCallId, execTimeSec, safeMessage);
    };

    const onToolResult = async (
      toolCallId: string,
      content: unknown,
      execTimeSec: number,
      options?: { streamDetails?: boolean },
    ): Promise<void> => {
      // The model was shown ref-handles in place of long document references
      // (config.refHandles). Everything below — the client `tool_calls` details
      // block, the live-graph findings table, and the debug trace — is a
      // USER/OPERATOR surface, so map the handles back to real references
      // first. No-op when the flow has no refHandles.
      const visibleContent =
        refHandles !== undefined
          ? refHandles.unmapContent(sanitizeToolResultOutput(content))
          : sanitizeToolResultOutput(content);
      const errorMessage = isToolErrorOutput(content)
        ? "Tool execution failed."
        : undefined;
      // Error envelopes are untrusted provider/tool output. Preserve successful
      // results, but expose only a stable error object to monitoring, debug
      // traces, and client reasoning streams.
      const toolUsage = extractToolUsage(content);
      if (toolUsage !== undefined) {
        nodeToolCostOverride.set(toolCallId, toolUsage.cost);
        nodeInputTokens.set(
          toolCallId,
          (nodeInputTokens.get(toolCallId) ?? 0) + toolUsage.inputTokens,
        );
        nodeOutputTokens.set(
          toolCallId,
          (nodeOutputTokens.get(toolCallId) ?? 0) + toolUsage.outputTokens,
        );
      }
      // Capture the tool's output for its synthetic node's detail view — a
      // vectorsearch-style payload normalises to a findings table shape.
      const resultDisplay = buildToolResultDisplay(visibleContent);
      if (resultDisplay !== undefined) {
        toolNodeResults.set(toolCallId, truncateToolIo(resultDisplay));
      }
      emitToolNodeEnd(toolCallId, execTimeSec, errorMessage);
      const activeNodeId =
        toolCallOwnerNodeIds.get(toolCallId) ?? lastActiveNodeId;
      if (activeNodeId !== undefined) {
        const calls = nodeToolCalls.get(activeNodeId);
        if (calls !== undefined) {
          const tc = calls.findLast(
            (call) =>
              call.id === toolCallId && call.exec_time_seconds === undefined,
          );
          if (tc !== undefined)
            tc.exec_time_seconds = Math.round(execTimeSec * 1000) / 1000;
        }
      }
      if (this.debugStore !== undefined && activeNodeId !== undefined) {
        const debugCalls = nodeDebugToolCalls.get(activeNodeId);
        if (debugCalls !== undefined) {
          const dtc = debugCalls.findLast(
            (call) => call.id === toolCallId && call.result === null,
          );
          if (dtc !== undefined) {
            dtc.result = visibleContent;
            dtc.exec_time_seconds = Math.round(execTimeSec * 1000) / 1000;
            dtc.is_error = errorMessage !== undefined;
          }
        }
      }
      toolCallOwnerNodeIds.delete(toolCallId);

      const callMeta = _pendingToolCallIds.get(toolCallId);
      _pendingToolCallIds.delete(toolCallId);

      const toolName = callMeta?.name ?? "unknown";
      // Fold a tool-reported cost (e.g. vectorsearch's own embedding/rerank
      // spend) into tenant/user/flow rolling-window spend tracking — mirrors
      // the LLM-backed synthetic tools (agent-tools.ts, agent-harness/tools.ts),
      // and runs independent of `monitoring` since budget enforcement must not
      // depend on whether the live dashboard is enabled.
      if (toolUsage !== undefined && toolUsage.cost > 0) {
        const slash = toolName.indexOf("/");
        this.costTracker?.record(ctx.clientId, toolUsage.cost, {
          provider: slash >= 0 ? toolName.slice(0, slash) : toolName,
          model: toolName,
          promptTokens: toolUsage.inputTokens,
          completionTokens: toolUsage.outputTokens,
        });
      }
      // Prefer the effective (post forced-args / ref-handle / egress-DLP)
      // arguments over the key-only placeholder captured at call time, so the
      // details block shows the ACTUAL query a search ran with — the result
      // body below is far more revealing than these args already.
      const argsJson =
        toolEffectiveArgs.get(toolCallId) ?? callMeta?.argsJson ?? "{}";
      toolEffectiveArgs.delete(toolCallId);

      // The tool call itself was already streamed by onToolCall. Private
      // delegated workers can suppress the potentially large/sensitive result
      // block while all monitoring, timing, cost and error bookkeeping above
      // remains intact.
      if (options?.streamDetails === false) return;

      // Render as Open WebUI <details type="tool_calls"> content block.
      let displayResult: unknown = visibleContent;
      try {
        const raw =
          typeof visibleContent === "string"
            ? JSON.parse(visibleContent)
            : visibleContent;
        if (
          Array.isArray(raw) &&
          raw.length > 0 &&
          typeof raw[0] === "object" &&
          raw[0] !== null &&
          "text" in raw[0]
        ) {
          const inner = JSON.parse((raw[0] as { text: string }).text);
          displayResult = inner;
        } else {
          displayResult = raw;
        }
        if (
          displayResult !== null &&
          typeof displayResult === "object" &&
          "results" in (displayResult as Record<string, unknown>)
        ) {
          const results = (displayResult as { results: unknown[] }).results;
          if (Array.isArray(results)) {
            const mapped = results.map((r: unknown) => {
              const item = r as Record<string, unknown>;
              const meta =
                (item.metadata as Record<string, unknown> | undefined) ?? {};
              const rawTags = item.tags ?? meta.tags ?? meta.tag;
              const tag = Array.isArray(rawTags)
                ? rawTags.join(", ")
                : (rawTags ?? undefined);
              return {
                title:
                  item.title ??
                  meta.title ??
                  meta.name ??
                  item.id ??
                  "–",
                score:
                  typeof item.score === "number"
                    ? Math.round(item.score * 1000) / 1000
                    : item.score,
                tag,
                collection:
                  item.collection ?? meta.collection ?? undefined,
                url:
                  item.link ??
                  item.url ??
                  meta.url ??
                  meta.link ??
                  undefined,
              };
            });
            const byDoc = new Map<
              string,
              Record<string, unknown> & { _chunks: number }
            >();
            for (const m of mapped) {
              const key =
                typeof m.url === "string" && m.url.length > 0
                  ? m.url
                  : String(m.title);
              const existing = byDoc.get(key);
              if (existing === undefined) {
                byDoc.set(key, { ...m, _chunks: 1 });
              } else {
                existing._chunks += 1;
                if (
                  typeof m.score === "number" &&
                  (typeof existing.score !== "number" ||
                    m.score > existing.score)
                ) {
                  existing.score = m.score;
                }
              }
            }
            displayResult = Array.from(byDoc.values()).sort((a, b) => {
              const sa = typeof a.score === "number" ? a.score : -Infinity;
              const sb = typeof b.score === "number" ? b.score : -Infinity;
              return sb - sa;
            });
          }
        }
      } catch {
        displayResult = visibleContent;
      }

      const formatVectorHits = (val: unknown): string | undefined => {
        if (!Array.isArray(val) || val.length === 0) return undefined;
        const entries: Record<string, unknown>[] = [];
        for (const entry of val) {
          if (entry === null || typeof entry !== "object") return undefined;
          const e = entry as Record<string, unknown>;
          if (!("title" in e) || !("score" in e)) return undefined;
          entries.push(e);
        }
        let maxScore = 0;
        for (const e of entries) {
          const s =
            typeof e.score === "number" ? (e.score as number) : NaN;
          if (Number.isFinite(s) && s > maxScore) maxScore = s;
        }
        const lines: string[] = [];
        for (const e of entries) {
          const scoreNum =
            typeof e.score === "number" ? (e.score as number) : NaN;
          const pct = Number.isFinite(scoreNum)
            ? maxScore > 0
              ? `${Math.round((scoreNum / maxScore) * 100)}%`
              : `${Math.round(scoreNum * 100)}%`
            : String(e.score ?? "");
          const pctCol = pct.padStart(4, " ");
          const title = String(e.title ?? "–");
          const url = typeof e.url === "string" ? e.url : "";
          const chunkCount =
            typeof e._chunks === "number" ? (e._chunks as number) : 1;
          const chunkSuffix = chunkCount > 1 ? `  ·  ${chunkCount} Chunks` : "";
          lines.push(`${pctCol}  ${title}${chunkSuffix}`);
          if (url.length > 0) lines.push(`      ${url}`);
        }
        return lines.join("\n");
      };

      const vectorHitsFormatted =
        typeof displayResult === "string"
          ? undefined
          : formatVectorHits(displayResult);
      const resultIsHtml = false;
      const resultStr =
        typeof displayResult === "string"
          ? displayResult
          : (vectorHitsFormatted ?? JSON.stringify(displayResult, null, 2));

      let displayName = toolName;
      try {
        const a = JSON.parse(argsJson) as {
          collection?: unknown;
          filter?: { tag?: unknown };
        };
        const hitCount = Array.isArray(displayResult)
          ? displayResult.length
          : undefined;
        const labelParts: string[] = [];
        if (typeof a.collection === "string" && a.collection.length > 0)
          labelParts.push(a.collection);
        if (
          a.filter &&
          typeof a.filter.tag === "string" &&
          a.filter.tag.length > 0
        )
          labelParts.push(`tag=${a.filter.tag}`);
        if (hitCount !== undefined) labelParts.push(`${hitCount} Treffer`);
        if (labelParts.length > 0)
          displayName = `${toolName} · ${labelParts.join(" · ")}`;
      } catch {
        /* keep the bare tool name */
      }

      const escapeAttr = (s: string): string =>
        s
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      const escapedArgs = escapeAttr(argsJson);
      const escapedName = escapeAttr(displayName);
      const escapedResult = resultIsHtml
        ? resultStr
        : resultStr
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

      const detailsBlock =
        `<details type="tool_calls" done="true" ` +
        `id="${toolCallId}" name="${escapedName}" ` +
        `arguments="${escapedArgs}">\n` +
        `<summary>${escapedName} (${Math.round(execTimeSec * 1000)}ms)</summary>\n` +
        `${escapedResult}\n` +
        `</details>\n`;

      try {
        await emitReasoningStep(detailsBlock);
      } catch {
        /* client disconnected */
      }
    };

    // --- Approval-required callback (human-in-the-loop).
    const onApprovalRequired = (pending: PendingApproval): void => {
      const base = (runtime.appConfig.approvalBaseUrl ?? "").replace(/\/$/, "");
      const linkSecret = runtime.appConfig.oidcSessionSecret;
      const linkToken =
        linkSecret !== undefined
          ? signApprovalLinkToken(
              pending.id,
              linkSecret,
              Date.now() + 3_600_000,
            )
          : undefined;
      const decideTokenQuery =
        linkToken !== undefined
          ? `&token=${encodeURIComponent(linkToken)}`
          : "";
      const approveUrl = `${base}/monitoring/approvals/${pending.id}/decide?decision=approved${decideTokenQuery}`;
      const denyUrl = `${base}/monitoring/approvals/${pending.id}/decide?decision=denied${decideTokenQuery}`;

      const toolLabel = pending.tool.split("/").pop() ?? pending.tool;
      const argEntries = Object.entries(pending.args ?? {});
      const argSummary =
        argEntries.length > 0
          ? argEntries
              .map(([k, v]) => `**${k}**: ${JSON.stringify(v)}`)
              .join(", ")
          : "_keine Argumente_";

      const widgetTokenQuery =
        linkToken !== undefined
          ? `?token=${encodeURIComponent(linkToken)}`
          : "";
      const widgetUrl = `${base}/monitoring/approvals/${pending.id}/widget${widgetTokenQuery}`;
      const approvalMessage =
        base.length > 0
          ? `\n\n<iframe src="${widgetUrl}" title="Freigabe erforderlich: ${toolLabel}" ` +
            `style="width:100%;max-width:520px;height:172px;border:1px solid rgba(127,127,127,.3);` +
            `border-radius:8px;background:transparent" loading="lazy"></iframe>\n\n`
          : `\n\n> ⏳ **Freigabe erforderlich:** \`${toolLabel}\`\n` +
            `>\n` +
            `> Argumente: ${argSummary}\n` +
            `>\n` +
            `> [✅ Genehmigen](${approveUrl}) | [🚫 Ablehnen](${denyUrl})\n\n`;

      void (async () => {
        try {
          await runtime.onToken(
            lastActiveNodeId ?? "approval",
            approvalMessage,
          );
        } catch {
          /* client disconnected */
        }
        await onChunk({
          id: crypto.randomUUID(),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          approval_required: {
            id: pending.id,
            execution_id: pending.executionId,
            node_id: pending.nodeId,
            tool: pending.tool,
            args: pending.args,
            ...(pending.tenantId !== undefined
              ? { tenant_id: pending.tenantId }
              : {}),
            requested_at: pending.requestedAt,
          },
        } as ChatCompletionChunk);
      })();
    };

    // --- Groundedness callback.
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
    const onGroundedness = async (
      nodeId: string,
      report: GroundednessReport,
    ): Promise<void> => {
      nodeGroundedness.set(nodeId, {
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
    const monitoringMeta = {
      flowId,
      ...(ctx.clientId !== undefined ? { tenantId: ctx.clientId } : {}),
      ...(typeof ctx.requestParams?.conversation_id === "string"
        ? { conversationId: ctx.requestParams.conversation_id }
        : {}),
      ...(ctx.chatId !== undefined ? { chatId: ctx.chatId } : {}),
      ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    };
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
    /** Upper bound on captured prompt/response length to keep events bounded. */
    const IO_CAPTURE_LIMIT = 16_000;
    const truncateIo = (s: string): string =>
      s.length > IO_CAPTURE_LIMIT
        ? s.slice(0, IO_CAPTURE_LIMIT) +
          `\n… [truncated ${s.length - IO_CAPTURE_LIMIT} chars]`
        : s;
    /** Sequence counter: order in which node attempts were started (1-based). */
    let nodeSequence = 0;
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
        this.logger !== undefined
      ) {
        const fields = {
          execution_id: executionId,
          flow_id: flowId,
          flow_version: flowVersion,
          node_id: nodeId,
          code: diagnostic.code,
          ...(diagnostic.details !== undefined ? { details: diagnostic.details } : {}),
        };
        if (diagnostic.level === "error") this.logger.error(diagnostic.message, fields);
        else this.logger.warn(diagnostic.message, fields);
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
    const debugErrors: DebugStreamError[] = [];
    // ---------------------------------------------------------------------
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
    /** Last node that completed without error — source of the `__end__` edge. */
    let lastCompletedNodeId: string | undefined;
    let edgeFlowInspectionAnnounced = false;
    let edgeFlowImagesConsumed = false;
    /** Id of the node that consumed the run's images (vision/transcription). */
    let edgeFlowImageConsumerId: string | undefined;
    /**
     * Running merge of every node's state update (same reducer semantics as
     * LangGraph). The entry state of a node lacks that node's OWN writes, so
     * the final edge into `__end__` — which has no following node to observe
     * them — is classified from this merged view instead. Initialised right
     * before the stream loop (once the thread-reconciled messages are final).
     */
    let mergedEdgeState: AgentState;
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
      if (this.debugStore === undefined) return;
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
      });
      edgeFlowInspectionAnnounced = result.inspectionToolAnnounced;
      edgeFlowImagesConsumed = result.imageConsumedUpstream;
      edgeFlowImageConsumerId = result.imageConsumerId;
      this.debugStore.upsertEdgeFlow(executionId, result.record);
    };
    const captureEdgeFlow = (
      nodeId: string,
      state: AgentState,
    ): void => {
      if (this.debugStore === undefined) return;
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
    /**
     * Outcome of the threaded-history contract for this turn. Only known once
     * the thread lock is held and the checkpoint has been read, so it is patched
     * onto the trace context afterwards rather than passed to `startTrace`.
     */
    let historyReconciliation: DebugHistoryReconciliation | undefined;
    if (this.debugStore !== undefined) {
      this.debugStore.startTrace({
        execution_id: executionId,
        flow_id: flowId,
        flow_version: flowVersion,
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

    const onNodeStart = (
      nodeId: string,
      context?: DebugNodeAttemptContext,
    ): void => {
      // Delegation can announce a target immediately before the target handler
      // announces itself. Both callbacks describe the same live attempt.
      if (activeNodeIds.has(nodeId)) return;

      clearNodeAttemptState(nodeId);
      nodeAttemptContexts.set(nodeId, context ?? { trigger: "graph-lifecycle" });
      const attempt = (nodeAttempts.get(nodeId) ?? 0) + 1;
      nodeAttempts.set(nodeId, attempt);
      const startTime = new Date().toISOString();
      nodeStartTimes.set(nodeId, startTime);
      activeNodeIds.add(nodeId);
      lastActiveNodeId = nodeId;
      nodeSequence += 1;
      nodeSequences.set(nodeId, nodeSequence);

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
      this.debugStore?.upsertNode(executionId, {
        node_id: nodeId,
        ...(nodeTypes.has(nodeId) ? { node_type: nodeTypes.get(nodeId) } : {}),
        status: "running",
        started_at: startTime,
        finished_at: null,
        latency_ms: null,
        ...(nodeAttempts.has(nodeId)
          ? { attempt: nodeAttempts.get(nodeId) }
          : {}),
        ...(nodeSequences.has(nodeId)
          ? { sequence: nodeSequences.get(nodeId) }
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
          ...(nodeSequences.has(nodeId)
            ? { sequence: nodeSequences.get(nodeId) }
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

    const emitNodeEnd = (
      nodeId: string,
      errorMessage?: string,
    ): Promise<void> => {
      const existingFinalization = nodeFinalizationPromises.get(nodeId);
      if (existingFinalization !== undefined) return existingFinalization;
      if (!activeNodeIds.has(nodeId)) return Promise.resolve();

      const finalization = (async (): Promise<void> => {
        const startTime =
          nodeStartTimes.get(nodeId) ?? new Date().toISOString();
        const latencyMs = Date.now() - new Date(startTime).getTime();

        let nodeCost: number | undefined;
      const nodeModelKey = nodeModels.get(nodeId);
      if (
        nodeModelKey !== undefined &&
        (nodeInputTokens.has(nodeId) || nodeOutputTokens.has(nodeId))
      ) {
        const slash = nodeModelKey.indexOf("/");
        const provider = slash >= 0 ? nodeModelKey.slice(0, slash) : "";
        const modelName =
          slash >= 0 ? nodeModelKey.slice(slash + 1) : nodeModelKey;
        nodeCost = estimateCost(
          provider,
          modelName,
          {
            prompt_tokens: nodeInputTokens.get(nodeId) ?? 0,
            completion_tokens: nodeOutputTokens.get(nodeId) ?? 0,
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
          this.metrics.recordGuardrail(type, count);
        }
      }

      this.metrics.recordNode(
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
      if (errorMessage !== undefined) flowErrored = true;

      // Citation safety net: sources were registered (and streamed to the
      // client) but this node's answer references none of them via `[n]`. The
      // client filter maps citations ONLY from `[n]` markers, so such an answer
      // shows zero citations even though the source panel was filled — a silent
      // regression that unit tests cannot catch. Surfaced as a trace diagnostic
      // (no behaviour change) so it is visible in the execution trace.
      if (errorMessage === undefined && citations.size > 0) {
        const nodeType = nodeTypes.get(nodeId);
        const responseText = nodeFullResponses.get(nodeId);
        if (
          (nodeType === "llm" || nodeType === "agent-harness") &&
          typeof responseText === "string" &&
          responseText.trim().length > 0
        ) {
          const markers = [...responseText.matchAll(/\[(\d+)\]/g)].map(
            (match) => Number(match[1]),
          );
          if (markers.length === 0) {
            recordNodeDiagnostic(nodeId, {
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
              recordNodeDiagnostic(nodeId, {
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

      if (this.debugStore !== undefined) {
        const errInfo = nodeErrorInfo.get(nodeId);
        this.debugStore.upsertNode(executionId, {
          node_id: nodeId,
          ...(nodeTypes.has(nodeId)
            ? { node_type: nodeTypes.get(nodeId) }
            : {}),
          status: errorMessage !== undefined ? "error" : "completed",
          started_at: startTime,
          finished_at: new Date().toISOString(),
          latency_ms: latencyMs,
          ...(nodeAttempts.has(nodeId)
            ? { attempt: nodeAttempts.get(nodeId) }
            : {}),
          ...(providerAttemptsSummary(nodeDiagnostics.get(nodeId)) ?? {}),
          ...(nodeAttemptContexts.has(nodeId)
            ? {
                attempt_trigger: nodeAttemptContexts.get(nodeId)?.trigger,
                ...(nodeAttemptContexts.get(nodeId)?.parent_node_id !== undefined
                  ? {
                      parent_node_id:
                        nodeAttemptContexts.get(nodeId)?.parent_node_id,
                    }
                  : {}),
                ...(nodeAttemptContexts.get(nodeId)?.delegation_id !== undefined
                  ? {
                      delegation_id:
                        nodeAttemptContexts.get(nodeId)?.delegation_id,
                    }
                  : {}),
              }
            : {}),
          ...(nodeSequences.has(nodeId)
            ? { sequence: nodeSequences.get(nodeId) }
            : {}),
          ...(nodeModels.has(nodeId) ? { model: nodeModels.get(nodeId) } : {}),
          ...(nodeInputTokens.has(nodeId)
            ? { input_tokens: nodeInputTokens.get(nodeId) }
            : {}),
          ...(nodeOutputTokens.has(nodeId)
            ? { output_tokens: nodeOutputTokens.get(nodeId) }
            : {}),
          ...(nodeCost !== undefined ? { cost: nodeCost } : {}),
          ...(nodeFullPrompts.has(nodeId)
            ? { full_prompt: nodeFullPrompts.get(nodeId) }
            : {}),
          ...(nodeFullResponses.has(nodeId)
            ? { full_response: nodeFullResponses.get(nodeId) }
            : {}),
          ...(nodeFullReasoning.has(nodeId)
            ? { full_reasoning: nodeFullReasoning.get(nodeId) }
            : {}),
          ...(nodeGroundedness.has(nodeId)
            ? { groundedness: nodeGroundedness.get(nodeId) }
            : {}),
          tool_calls: nodeDebugToolCalls.get(nodeId) ?? [],
          ...(nodeToolSelections.has(nodeId)
            ? { tool_selection: nodeToolSelections.get(nodeId) }
            : {}),
          ...(nodeClassifications.has(nodeId)
            ? { classifier: nodeClassifications.get(nodeId) }
            : {}),
          ...(nodeDiagnostics.has(nodeId)
            ? { diagnostics: nodeDiagnostics.get(nodeId) }
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
        ...(nodeModels.has(nodeId) ? { model: nodeModels.get(nodeId) } : {}),
        ...(nodeInputTokens.has(nodeId)
          ? { input_tokens: nodeInputTokens.get(nodeId) }
          : {}),
        ...(nodeOutputTokens.has(nodeId)
          ? { output_tokens: nodeOutputTokens.get(nodeId) }
          : {}),
        ...(nodeCost !== undefined ? { cost: nodeCost } : {}),
        ...((nodeToolCalls.get(nodeId)?.length ?? 0) > 0
          ? { tool_calls: nodeToolCalls.get(nodeId) }
          : {}),
        ...(nodePrompts.has(nodeId) ? { prompt: nodePrompts.get(nodeId) } : {}),
        ...(nodeResponses.has(nodeId)
          ? { response: nodeResponses.get(nodeId) }
          : {}),
        ...(nodeRoutingDecisions.has(nodeId)
          ? { routing_decision: nodeRoutingDecisions.get(nodeId) }
          : {}),
        ...(nodeSequences.has(nodeId)
          ? { sequence: nodeSequences.get(nodeId) }
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
        activeNodeIds.delete(nodeId);
        nodeStartTimes.delete(nodeId);
        nodeFinalizationPromises.delete(nodeId);
      });
      nodeFinalizationPromises.set(nodeId, finalization);
      return finalization;
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

    // --- Content processing + multimodal conversion (Req 8.x) ---
    const contentErrors: StreamError[] = [];
    const baseMessages = messages.map((m) =>
      chatMessageToBaseMessage(m, (err) => contentErrors.push(err)),
    );
    for (const err of contentErrors) {
      await onChunk(makeErrorChunk(model, err));
    }

    // Run-scoped image references, created once so the edge-flow capture and
    // the node handlers share ONE registry: the `img-N` refs the edge records
    // are exactly the refs the model sees in the prompt.
    const runImageRefs =
      this.mediaStore !== undefined
        ? new HashedImageRefRegistry({ store: this.mediaStore })
        : undefined;

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
            onNodeDiagnostic: recordNodeDiagnostic,
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
        ? { approvalGate: this.approvalGate, onApprovalRequired }
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
      ...(this.assistants !== undefined
        ? { assistants: this.assistants }
        : {}),
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
      let stateMessages = baseMessages;
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
        if (reconciled.dropped > 0) {
          this.metrics.recordCounter(
            "aiperator_thread_history_reconciled_total",
            {
              flow: flowId,
              outcome: reconciled.duplicateTurn ? "duplicate_turn" : "trimmed",
            },
            reconciled.dropped,
          );
        }
        historyReconciliation = {
          persisted: persisted.length,
          incoming: reconciled.incoming,
          dropped: reconciled.dropped,
          appended: reconciled.messages.length,
          duplicate_turn: reconciled.duplicateTurn,
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
        flowErrored = true;
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
    spanManager.endFlow(flowErrored ? "error" : "ok");

    try {
      if (flowProgressEnabled) {
        const outcome = flowErrored ? "mit Fehlern beendet" : "abgeschlossen";
        await emitReasoningStep(
          `⚙️ Recherche ${outcome} · Gesamtlaufzeit ${formatProgressDuration(
            Date.now() - flowProgressStartedAt,
          )}\n`,
        );
      }

      if (
        !flowErrored &&
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
          flowErrored ? "error" : "completed",
          {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
          },
          debugErrors,
          finalResponse !== undefined
            ? { response: finalResponse, ...(finalNodeId !== undefined ? { nodeId: finalNodeId } : {}) }
            : undefined,
        );
      }
      emitFlowEnd(flowErrored ? "error" : "completed");
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
