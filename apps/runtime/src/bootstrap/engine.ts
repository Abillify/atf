// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Engine builder (`src/bootstrap/engine.ts`)
 *
 * Wires together every subsystem into the GraphEngine, plus the adjacent
 * runtime helpers that talk to it:
 *   - Provider key pool + BYOK-aware LlmProviderFactory
 *   - Conversation checkpointer + distributed thread lock
 *   - Global concurrency limiter (Redis)
 *   - Model quality registry
 *   - Media store
 *   - GraphEngine (LangGraph + all the above)
 *   - Debug trace store
 *   - Replay service + executor
 *   - Flow optimizer
 *   - Canary judge LLM
 *
 * Everything that touches `graphEngine.executeFlow` or needs the compiled
 * graph lives here. The HTTP layer (Hono app + routes) stays in index.ts.
 */

import type { AppConfig } from "../config/index.js";
import type { FlowDefinition } from "../types/flow.js";
import { supportsEphemeralFlows } from "../graph/flow-registry-studio.js";
import type { Logger } from "../observability/logger.js";
import type { Database } from "../db/database.js";
import type { McpWrapperService as McpWrapper } from "../mcp/mcp-wrapper.js";
import type { Metrics } from "../observability/metrics.js";
import type { SpendRecorder } from "../observability/cost.js";
import type { VectorStore } from "../graph/vector-store.js";
import type { MemoryStore } from "../graph/memory-store.js";
import type { SemanticCache } from "../graph/semantic-cache.js";
import type { ResponseCache } from "../graph/response-cache.js";
import type { Reranker } from "../graph/reranker.js";
import type { Embedder } from "../graph/semantic-cache.js";
import type { ToolGroupSummarizer } from "../graph/tool-group-summary.js";
import type { ApprovalRegistry as ApprovalGate } from "../graph/approval-gate.js";
import type { GroundednessGate } from "../graph/groundedness.js";
import type {
  OutputGuardrail,
  ToolEgressGuardrail,
} from "../graph/output-guardrails.js";
import type { FlowRegistry } from "../graph/flow-parser.js";
import type { RequestContext } from "../types/monitoring.js";

import {
  createGraphEngine,
  type GraphEngineService as GraphEngine,
  type LlmProviderFactory,
} from "../graph/graph-engine.js";
import { ProviderKeyPool } from "../graph/provider-key-pool.js";
import { createLlmProvider } from "../graph/llm-factory.js";
import { createCheckpointer } from "../graph/checkpointer.js";
import { createRedisThreadLock } from "../graph/thread-lock.js";
import { createConcurrencyLimiterFromFactory } from "../graph/distributed-semaphore.js";
import type { StoreFactory } from "../db/store/index.js";
import { ModelQualityRegistry } from "../graph/model-quality.js";
import { InMemoryMediaStore } from "../graph/media-store.js";
import { InMemoryDebugTraceStore } from "../monitoring/debug-trace-store.js";
import {
  createReplayService,
  InMemoryReplayStore,
  PostgresReplayStore,
  type ReplayStore,
  type ReplayExecutor,
  type ReplayService,
} from "../graph/replay.js";
import { createLlmJudgeFromConfig } from "../eval/llm-judge.js";
import {
  requireExecutionAdmission,
  type ExecutionAdmissionService,
} from "../graph/execution-admission.js";
import type { Tracer } from "../observability/tracing.js";
import { verifyExecutionContext } from "../graph/verified-execution-context.js";
import { createProviderCircuitBreaker, type ProviderCircuitBreaker } from "../graph/provider-circuit-breaker.js";
export interface EngineResult {
  graphEngine: GraphEngine;
  modelQuality: ModelQualityRegistry;
  mediaStore: InMemoryMediaStore;
  debugTraceStore: InMemoryDebugTraceStore;
  replayStore: ReplayStore | undefined;
  replayService: ReplayService | undefined;
  replayExecutor: ReplayExecutor;
  /** Completes the bootstrap cycle once the central admission gate is available. */
  setReplayAdmission(admission: ExecutionAdmissionService): void;
  flowOptimizer: import("../graph/flow-optimizer.js").FlowOptimizer | undefined;
  traceAnalyzer: import("../graph/trace-analyzer.js").TraceAnalyzer | undefined;
  canaryJudge: ReturnType<typeof createLlmJudgeFromConfig> | undefined;
  llmProviderFactory: LlmProviderFactory | undefined;
  providerKeyPool: ProviderKeyPool;
  providerCircuitBreaker: ProviderCircuitBreaker;
}

export async function buildEngine(
  config: AppConfig,
  logger: Logger,
  database: Database | undefined,
  flowRegistry: FlowRegistry,
  mcpWrapper: McpWrapper,
  _knownToolIds: Set<string>,
  toolGroupSummarizer: ToolGroupSummarizer | undefined,
  metrics: Metrics,
  spendRecorder: SpendRecorder,
  tracer: Tracer,
  {
    semanticCache,
    responseCache,
    vectorStore,
    memoryStore,
    assistants,
    assistantReviewScheduler,
    ragEmbedder,
    reranker,
    outputGuardrail,
    toolEgressGuardrail,
    approvalGate,
    groundednessGate,
    flowStore,
    storeFactory,
    toolOutputValidator,
  }: {
    semanticCache: SemanticCache | undefined;
    responseCache: ResponseCache | undefined;
    vectorStore: VectorStore | undefined;
    memoryStore: MemoryStore | undefined;
    /**
     * Per-user assistant subsystem. Passed through to the handler factories so the
     * `assistant-context` / `assistant-learn` nodes can reach it via the runtime.
     */
    assistants?: import("../assistants/assistant-runtime.js").AssistantRuntime;
    /** Process-wide learning-pass scheduler. */
    assistantReviewScheduler?: import("../assistants/experience-review.js").ExperienceReviewScheduler;
    ragEmbedder: Embedder | undefined;
    reranker: Reranker | undefined;
    outputGuardrail: OutputGuardrail | undefined;
    toolEgressGuardrail: ToolEgressGuardrail | undefined;
    approvalGate: ApprovalGate | undefined;
    groundednessGate: GroundednessGate | undefined;
    flowStore: import("../graph/flow-store.js").FlowStore | undefined;
    storeFactory?: StoreFactory;
    toolOutputValidator?: import("../mcp/tool-output-validator.js").ToolOutputValidator;
  },
): Promise<EngineResult> {
  // ── Provider key pool ──────────────────────────────────────────────────────
  const providerKeyPool = new ProviderKeyPool(config.providerKeys ?? {});
  const byokEnabled = config.byokEnabled === true;
  const llmProviderFactory: LlmProviderFactory | undefined =
    providerKeyPool.active || byokEnabled
      ? (llmConfig, appConfig, resolution) => {
          const provider = llmConfig.provider;
          const byokKey = resolution?.providerKeyOverrides?.[provider];
          if (byokKey !== undefined) {
            return createLlmProvider(llmConfig, appConfig, { apiKey: byokKey });
          }
          if (
            provider === "openai" ||
            provider === "google" ||
            provider === "azure" ||
            provider === "bedrock" ||
            provider === "anthropic"
          ) {
            const key = providerKeyPool.acquire(provider);
            if (key !== undefined) {
              return createLlmProvider(llmConfig, appConfig, { apiKey: key });
            }
          }
          return createLlmProvider(llmConfig, appConfig);
        }
      : undefined;
  if (providerKeyPool.active) {
    logger.info("Provider key pool enabled", {
      providers: Object.keys(config.providerKeys ?? {}),
    });
  }

  // ── Checkpointer + distributed thread lock ─────────────────────────────────
  const checkpointer = createCheckpointer(config, database, logger);
  const threadLock =
    config.redisUrl !== undefined && config.checkpointingEnabled === true
      ? createRedisThreadLock(config.redisUrl, logger, undefined, metrics)
      : undefined;
  if (threadLock !== undefined) {
    logger.info("Distributed conversation thread locking enabled via Redis");
  }

  // ── Global concurrency limiter (Req. 2.4 — cluster-wide via StoreFactory) ──
  const globalConcurrencyCap = config.maxGlobalConcurrentExecutions ?? 0;
  const globalLimiter =
    globalConcurrencyCap > 0 && storeFactory !== undefined
      ? createConcurrencyLimiterFromFactory(
          storeFactory,
          {
            maxConcurrent: globalConcurrencyCap,
            ttlMs: (config.executionTimeoutMs ?? 120_000) + 30_000,
            redisUrl: config.redisUrl,
            database,
            // Req 7.8: count fail-open degradations of the cluster limiter.
            metrics,
          },
          logger,
        )
      : undefined;
  if (globalLimiter !== undefined) {
    logger.info("Cluster-wide concurrency limit enabled", {
      maxConcurrent: globalConcurrencyCap,
      backing: storeFactory?.backing() ?? "none",
    });
  }

  // ── Model quality registry ─────────────────────────────────────────────────
  const modelQuality = new ModelQualityRegistry(
    config.routerQualityHalfLifeMs !== undefined
      ? { halfLifeMs: config.routerQualityHalfLifeMs }
      : {},
  );

  // ── Media store ────────────────────────────────────────────────────────────
  const mediaStore = new InMemoryMediaStore();
  if (config.mediaBaseUrl === undefined) {
    logger.warn(
      "MEDIA_BASE_URL (and APPROVAL_BASE_URL) are unset — generated images will " +
        "be inlined as base64 data-URIs, which Open WebUI may fail to render. " +
        "Set MEDIA_BASE_URL to this instance's public URL to serve images via /v1/media/:id.",
    );
  }

  // ── Graph engine ───────────────────────────────────────────────────────────
  const providerCircuitBreaker = createProviderCircuitBreaker();
  const graphEngine = createGraphEngine(config, {
    flowRegistry,
    mcpWrapper,
    llmProviderFactory,
    metrics,
    costTracker: spendRecorder,
    checkpointer,
    threadLock,
    tracer,
    responseCache,
    semanticCache,
    globalLimiter,
    outputGuardrail,
    approvalGate,
    groundednessGate,
    embedder: ragEmbedder,
    vectorStore,
    memoryStore,
    ...(assistants !== undefined ? { assistants } : {}),
    ...(assistantReviewScheduler !== undefined
      ? { assistantReviewScheduler }
      : {}),
    modelQuality,
    toolEgressGuardrail,
    mediaStore,
    toolGroupSummarizer,
    reranker,
    toolOutputValidator,
    providerCircuitBreaker,
    logger,
  });

  // ── Debug trace store ──────────────────────────────────────────────────────
  const debugTraceStore = new InMemoryDebugTraceStore(200);
  graphEngine.setDebugStore?.(debugTraceStore);
  logger.info("Debug trace export enabled at /monitoring/debug/:executionId");

  // ── Replay store + service ─────────────────────────────────────────────────
  const replayStore: ReplayStore | undefined =
    config.replayEnabled === true
      ? database !== undefined
        ? new PostgresReplayStore(database, logger)
        : new InMemoryReplayStore()
      : undefined;

  let replayAdmission: ExecutionAdmissionService | undefined;
  const replayExecutor: ReplayExecutor = async (flowId, msgs, md) => {
    const meta = { ...(md ?? {}) };
    const token =
      typeof meta.__token === "string" ? (meta.__token as string) : "";
    delete meta.__token;
    const hasVerifiedContext = Object.hasOwn(meta, "__verifiedContext");
    const verified = hasVerifiedContext
      ? verifyExecutionContext(meta.__verifiedContext, process.env.AGENT_TRANSACTION_SECRET)
      : undefined;
    delete meta.__verifiedContext;
    if (hasVerifiedContext && verified === undefined) {
      throw new Error("Replay execution context attestation is invalid or unavailable.");
    }
    const replayCtx: RequestContext = {
      ssoToken: token,
      executionId: crypto.randomUUID(),
      ...(verified?.claims !== undefined ? { claims: verified.claims } : {}),
      ...(verified?.clientId !== undefined ? { clientId: verified.clientId } : {}),
      ...(verified?.userId !== undefined ? { userId: verified.userId } : {}),
      ...(verified?.userEmail !== undefined ? { userEmail: verified.userEmail } : {}),
      ...(verified?.role !== undefined ? { role: verified.role } : {}),
      ...(verified?.groups !== undefined ? { groups: verified.groups } : {}),
      requestParams: meta,
    };
    if (replayAdmission === undefined) {
      throw new Error("Replay execution admission has not been configured.");
    }
    await requireExecutionAdmission(replayAdmission, flowId, replayCtx);
    let text = "";
    await graphEngine.executeFlow(
      flowId,
      msgs,
      replayCtx,
      async (chunk) => {
        const content = chunk.choices[0]?.delta?.content;
        if (typeof content === "string") text += content;
      },
      async () => {},
      undefined,
    );
    return { text };
  };

  const replayService: ReplayService | undefined =
    replayStore !== undefined
      ? createReplayService(replayStore, replayExecutor, logger)
      : undefined;
  if (replayService !== undefined) logger.info("Time-travel replay enabled");

  // ── Flow optimizer ─────────────────────────────────────────────────────────
  let flowOptimizer:
    | import("../graph/flow-optimizer.js").FlowOptimizer
    | undefined;
  let traceAnalyzer:
    | import("../graph/trace-analyzer.js").TraceAnalyzer
    | undefined;
  if (
    config.optimizerEnabled === true &&
    replayStore !== undefined &&
    flowStore !== undefined
  ) {
    const generatorLlm = (() => {
      const modelCfg = config.optimizerGeneratorModel ?? config.defaultLlm;
      if (modelCfg === undefined) return undefined;
      try {
        return createLlmProvider(modelCfg, config);
      } catch (err) {
        logger.warn("Failed to build optimizer generator model", {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    })();

    const judgeModelConfig =
      config.optimizerJudgeModel ??
      config.canaryJudgeModel ??
      config.defaultLlm;
    const judgeModel = (() => {
      if (judgeModelConfig === undefined) return undefined;
      try {
        return createLlmProvider(judgeModelConfig, config);
      } catch {
        return undefined;
      }
    })();

    if (generatorLlm !== undefined && judgeModel !== undefined) {
      const { createFlowOptimizer } = await import(
        "../graph/flow-optimizer.js"
      );
      const { createLlmJudge } = await import("../eval/llm-judge.js");
      flowOptimizer = createFlowOptimizer({
        replayStore,
        flowStore,
        executor: replayExecutor,
        judge: createLlmJudge(judgeModel),
        generatorModel: generatorLlm,
        logger,
        // The analyzer reasons over failure/latency evidence — use the judge
        // model (typically the strongest configured reasoning model), falling
        // back to the generator model inside the optimizer when absent.
        analyzerModel: judgeModel,
        debugTraceStore,
        // File flows (FLOWS_DIR) in source form, like the Studio edits them.
        fileFlows: (id) =>
          (flowRegistry.getSource?.(id)?.definition as FlowDefinition | undefined) ?? flowRegistry.get(id),
        // Variants run under `<flowId>@variant/<label>` — resolvable only once
        // registered in the outer (Studio test) layer of the registry.
        ...(supportsEphemeralFlows(flowRegistry)
          ? { registerFlow: (def: FlowDefinition) => flowRegistry.registerEphemeral(def) }
          : {}),
      });
      // Standalone trace analyzer, backing POST /optimizer/analyze/:executionId.
      const { createTraceAnalyzer } = await import(
        "../graph/trace-analyzer.js"
      );
      traceAnalyzer = createTraceAnalyzer({
        debugTraceStore,
        model: judgeModel,
        logger,
      });
      logger.info("Self-optimizing flow loop enabled at /optimizer/*", {
        generator:
          config.optimizerGeneratorModel?.model ?? config.defaultLlm?.model,
        judge: judgeModelConfig?.model,
      });
    } else {
      logger.warn(
        "OPTIMIZER_ENABLED is set but no generator model is available. " +
          "Set OPTIMIZER_GENERATOR_MODEL (and optionally OPTIMIZER_JUDGE_MODEL).",
      );
    }
  }

  // ── Canary judge ───────────────────────────────────────────────────────────
  const canaryJudge =
    config.canaryJudgeModel !== undefined
      ? createLlmJudgeFromConfig(config.canaryJudgeModel, config)
      : undefined;

  return {
    graphEngine,
    modelQuality,
    mediaStore,
    debugTraceStore,
    replayStore,
    replayService,
    replayExecutor,
    setReplayAdmission(admission) {
      replayAdmission = admission;
    },
    flowOptimizer,
    traceAnalyzer,
    canaryJudge,
    llmProviderFactory,
    providerKeyPool,
    providerCircuitBreaker,
  };
}
