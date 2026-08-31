// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AI Agent Orchestration Platform — Backend Entry Point
 *
 * Startup sequence (import.meta.main):
 *   1.  loadConfig()              — validates env vars, exits 1 on failure
 *   2.  logger + tracer           — structured JSON logging + OTel
 *   3.  readiness gate            — refuses insecure prod config
 *   4.  buildPersistence()        — DB + migrations + all durable stores
 *   5.  buildObservability()      — metrics, budgets, token limits, audit log
 *   6.  buildCache()              — embedder, semantic/response cache, RAG, memory
 *   7.  flow registry             — parse + hot-reload YAML/JSON flows
 *   8.  buildMcp()                — connect MCP servers + periodic reconnect
 *   9.  buildGuardrails()         — input/output guardrails + approval gate
 *   10. buildEngine()             — graph engine + replay + optimizer
 *   11. Hono app                  — CORS, auth, all routes
 *   12. Bun.serve()               — HTTP server
 *   13. SIGTERM/SIGINT            — graceful shutdown
 *
 * Requirements: 10.5, 10.6, 11.5
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { csrf } from "hono/csrf";
import { loadConfig, checkProductionReadiness } from "./config/index.js";
import {
  authMiddleware,
  TRACE_CONTEXT_KEY,
  type AuthContext,
} from "./middleware/auth.js";
import { resolveApiKey } from "./middleware/api-key-auth.js";
import { approvalWidgetEmbeddingMiddleware } from "./middleware/approval-widget-embedding.js";
import {
  rateLimitMiddleware,
  preAuthRateLimitMiddleware,
  postAuthRateLimitMiddleware,
  createStoreBackedRateLimitStore,
  createRedisRateLimitStore,
} from "./middleware/rate-limit.js";
import { buildOperatorAuthentication } from "./bootstrap/operator-auth.js";
import { createOidcAuthRouter } from "./routes/auth-oidc.js";
import { createOidcSessionStore } from "./routes/oidc-session-store.js";
import { createFlowParserService } from "./graph/flow-parser.js";
import {
  auditFlowIdentityForwarding,
  formatIdentityAuditWarnings,
} from "./graph/flow-identity-audit.js";
import { partitionFlowsByRecoveryDeclaration } from "./graph/flow-recovery.js";
import { isLocalInferenceProvider } from "./graph/model-capabilities.js";
import { defaultNodeHandlerRegistry } from "./graph/node-handler-registry.js";
import { loadHandlerPlugins } from "./graph/handler-loader.js";
import { createFlowDispatcher } from "./graph/flow-dispatcher.js";
import { createFlowAuthorizer } from "./graph/flow-authorizer.js";
import { createGuardrailPolicy } from "./graph/guardrail-policy.js";
import { FlowPiiDetectorResolver } from "./graph/pii-detector.js";
import { createCanaryManager } from "./graph/canary.js";
import { createSloRegistry, parseSloTargets } from "./graph/slo.js";
import { parseFlowFile, resolveConfigFile } from "./util/parse-flow-file.js";
import {
  createMonitoringService,
  createMonitoringRouter,
  createRedisPubSub,
} from "./monitoring/monitoring-service.js";
import { createLogger } from "./observability/logger.js";
import { createTracer, parseTraceparent } from "./observability/tracing.js";
import { createChatRouter } from "./routes/chat.js";
import { createResponsesRouter } from "./routes/responses.js";
import { createHealthRouter } from "./routes/health.js";
import { createMetricsRouter } from "./routes/metrics.js";
import { createLimitsRouter } from "./routes/limits.js";
import { createModelsRouter } from "./routes/models.js";
import { createMediaRouter } from "./routes/media.js";
import { createRagRouter } from "./routes/rag.js";
import { createMemoryRouter } from "./routes/memory.js";
import { createControlRouter } from "./routes/control.js";
import { createFlowsRouter } from "./routes/flows.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createComplianceRouter } from "./routes/compliance.js";
import { createTenantsRouter } from "./routes/tenants.js";
import { createProviderKeysRouter } from "./routes/provider-keys.js";
import { createGuardrailsRouter } from "./routes/guardrails.js";
import { createEvalRouter } from "./routes/eval.js";
import { createAnalysisArtifactsRouter } from "./routes/analysis-artifacts.js";
import { AnalysisArtifactService } from "./artifacts/analysis-artifacts.js";
import { createEvalCaseStore } from "./eval/eval-case-store.js";
import { createDebugRouter } from "./routes/debug.js";
import {
  createDbFlowSource,
  createCompositeRegistry,
  createVersionedRegistry,
} from "./graph/flow-registry-composite.js";
import { createAbManager, type AbManager } from "./graph/flow-ab.js";
import { createToolAuthzLoader } from "./graph/tool-authz-loader.js";
import { createFlowMcpServer } from "./mcp/flow-mcp-server.js";
import { createFlowMcpRouter } from "./routes/flow-mcp.js";
import { createRedTeamEngine } from "./security/red-team-engine.js";
import { createRedTeamScheduler } from "./security/red-team-scheduler.js";
import { createRedTeamRouter } from "./routes/red-team.js";
// ── Bootstrap modules ─────────────────────────────────────────────────────
import { buildPersistence } from "./bootstrap/persistence.js";
import { withPiiVault } from "./graph/pii-vault-engine.js";
import { buildObservability } from "./bootstrap/observability.js";
import { buildCache } from "./bootstrap/cache.js";
import { buildMcp } from "./bootstrap/mcp.js";
import { buildGuardrails } from "./bootstrap/guardrails.js";
import { buildEngine } from "./bootstrap/engine.js";
import { buildAssistants } from "./bootstrap/assistants.js";
import { createAssistantsRouter } from "./routes/assistants.js";
import { createRocketChatRouter } from "./routes/rocketchat.js";
import { createRocketChatConnectRouter } from "./routes/rocketchat-connect.js";
import {
  REQUEST_NODE_ID,
  RESPONSE_NODE_ID,
  emitBoundaryNode,
} from "./routes/chat/handler.js";
import { ensureBunGlobals } from "./bun-globals.js";
import crypto from "node:crypto";
import { createLlmProvider } from "./graph/llm-factory.js";
import {
  ExecutionAdmissionService,
  requireExecutionAdmission,
} from "./graph/execution-admission.js";

if (import.meta.main) {
  // 0. Bun globals (SQL / RedisClient on globalThis).
  ensureBunGlobals();

  // 1. Config
  const config = loadConfig();

  // 2. Logger + tracer
  const logger = createLogger(config.logLevel);
  logger.info("Starting aiperator backend", {
    port: config.port,
    env: config.appEnv ?? "development",
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
  });
  const tracer = createTracer(config, logger);
  if (tracer.enabled) {
    logger.info("Distributed tracing enabled", {
      exporter: config.otelExporterOtlpEndpoint ?? "debug-log",
      service: config.otelServiceName ?? "aiperator",
    });
  }

  // 3. Production-readiness gate
  const readiness = checkProductionReadiness(config);
  for (const w of readiness.warnings) logger.warn(`Readiness warning: ${w}`);
  if (readiness.fatal.length > 0) {
    for (const f of readiness.fatal) logger.error(`Readiness failure: ${f}`);
    logger.error(
      "Refusing to start in production with insecure configuration. " +
        "Fix the issues above or set APP_ENV=development.",
    );
    process.exit(1);
  }

  // 4. Persistence
  const persistence = await buildPersistence(config, logger);
  const {
    database,
    storeFactory,
    executionStore,
    tenantStore,
    usageMeter,
    providerKeyStore,
    byokResolver,
    idempotencyStore,
    jobStore,
    flowStore,
    analysisArtifactStore,
    piiVault,
    piiVaultStore,
    piiDetectorFactory,
    rlsVerified,
    tenantCount,
  } = persistence;

  // 4b. Cluster-state readiness gate (Req 2.2, 2.3, 3.1)
  // Runs after persistence so we know the actual store backing.
  const clusterReadiness = checkProductionReadiness(config, {
    storeBacking: storeFactory.backing(),
    rlsVerified,
    ...(tenantCount !== undefined ? { tenantCount } : {}),
  });
  for (const w of clusterReadiness.warnings)
    logger.warn(`Readiness warning: ${w}`);
  if (clusterReadiness.fatal.length > 0) {
    for (const f of clusterReadiness.fatal)
      logger.error(`Readiness failure: ${f}`);
    logger.error(
      "Refusing to start in production with insecure cluster/RLS configuration. " +
        "Fix the issues above or set APP_ENV=development.",
    );
    process.exit(1);
  }

  // 5. Cache (embedder must be ready before guardrails + engine)
  const cacheResult = await buildCache(config, logger, database, storeFactory);
  const {
    embedder,
    semanticCache,
    responseCache,
    vectorStore,
    memoryStore,
    memoryExtractor,
    reranker,
  } = cacheResult;
  const ragEmbedder = vectorStore !== undefined ? embedder : undefined;

  // 6. Observability (retention needs memoryStore reference — passed later via
  //    buildObservability; we pass it now because retention targets are wired at
  //    construction time, not lazily).
  const obs = buildObservability(config, logger, database, {
    executionStore,
    memoryStore,
    piiVaultStore,
  });
  const {
    metrics,
    budgetService,
    spendRecorder,
    tokenLimitService,
    tokenLimitEnforcer,
    tokenLimitStore,
    usageAnalytics,
    auditLog,
    retentionService,
    auditAnchor,
  } = obs;

  // 7. Node-type handler plugins (before flow parsing so plugin types are known)
  if (config.pluginsDir !== undefined) {
    logger.warn(
      config.pluginsSandbox === true
        ? "Loading node-type handler plugins in SANDBOX mode (isolated Bun Workers, no env/secrets access). Ensure PLUGINS_DIR is trusted."
        : "Loading node-type handler plugins — plugin code runs in-process with full privileges. Ensure PLUGINS_DIR is trusted. Set PLUGINS_SANDBOX=true for isolation.",
      { dir: config.pluginsDir },
    );
    const pluginResult = await loadHandlerPlugins(
      defaultNodeHandlerRegistry,
      config.pluginsDir,
      logger,
      {
        allowlist: config.pluginsAllowlist,
        manifestPath:
          config.pluginsManifestPath ??
          (config.pluginsDir
            ? `${config.pluginsDir}/plugins.manifest.json`
            : undefined),
        appEnv: config.appEnv,
        logger,
        sandbox: config.pluginsSandbox,
        sandboxTimeoutMs: config.pluginsSandboxTimeoutMs,
      },
    );
    logger.info("Node-type plugin load complete", {
      loaded: pluginResult.loaded,
      failedCount: pluginResult.failed.length,
    });
  }

  // 7b. Flow dispatcher / authorizer / canary / guardrail policy
  const flowDispatcher = createFlowDispatcher(config.flowsDir, logger);
  const flowAuthorizer = createFlowAuthorizer(config.flowsDir, logger);
  if (flowAuthorizer.hasPolicy())
    logger.info("Flow access policy loaded (access.json)");
  const canaryManager = createCanaryManager(config.flowsDir, logger);
  if (canaryManager.enabled) {
    logger.info("Canary rollout policy loaded (canary.json)", {
      deployments: canaryManager.status().length,
    });
  }
  const guardrailPolicy = createGuardrailPolicy(config.flowsDir, logger);
  if (guardrailPolicy.hasPolicy())
    logger.info("Guardrail policy loaded (guardrails.json)");

  // ── Declarative cost/quality SLO registry ─────────────────────────────────
  // Loads per-flow SLO targets from flows/slo.json|yaml (hot-reloaded) and
  // records quality/cost observations from the chat metering path. Attainment
  // is exposed at GET /monitoring/slo.
  const sloRegistry = createSloRegistry(
    Date.now,
    logger,
    config.sloAlertWebhookUrl !== undefined
      ? { webhookUrl: config.sloAlertWebhookUrl }
      : {},
  );
  const loadSloTargets = (): void => {
    const path = resolveConfigFile(config.flowsDir, "slo");
    if (path === null) {
      sloRegistry.setTargets([]);
      return;
    }
    try {
      sloRegistry.setTargets(parseSloTargets(parseFlowFile(path)));
    } catch {
      sloRegistry.setTargets([]);
    }
  };
  loadSloTargets();
  if (sloRegistry.enabled) {
    logger.info("Cost/quality SLO registry loaded (slo.json)", {
      flows: sloRegistry.report().map((r) => r.flow),
    });
  }

  // Wire the per-flow PII detector resolver (ADR-0015). The vault is built in
  // persistence (before the guardrail policy exists), so the resolver — which
  // reads the policy's per-flow `detectors` field — is injected here via a
  // setter, once both the detector factory and the guardrail policy are ready.
  if (piiVault !== undefined && piiDetectorFactory !== undefined) {
    const detectorResolver = new FlowPiiDetectorResolver({
      factory: piiDetectorFactory,
      ...(config.piiDetectors !== undefined
        ? { globalNames: config.piiDetectors }
        : {}),
      flowLookup: (flowId: string) => guardrailPolicy.resolve(flowId)?.detectors,
      flowTypesLookup: (flowId: string) => guardrailPolicy.resolve(flowId)?.piiTypes,
      generation: () => guardrailPolicy.generation(),
    });
    piiVault.setDetectorResolver(detectorResolver);
    piiVault.setMetrics(metrics);
    logger.info("PII detector resolver wired (per-flow detector selection active)", {
      globalDetectors: config.piiDetectors ?? ["regex (legacy sync)"],
    });
  }

  const toolAuthzLoader = createToolAuthzLoader(config.flowsDir, logger, {
    failClosed: config.toolAuthzFailClosed === true,
  });

  // 7c. Flow parser + hot-reload wiring
  let abManager: AbManager | undefined;
  // Lazy reference so the flow-parser watcher can call syncTools() on the
  // MCP server that's constructed after the parser starts.
  let flowMcpServerRef:
    | import("./mcp/flow-mcp-server.js").FlowMcpServer
    | undefined;
  // Lazy reference for the compliance policy loader (constructed after parser start).
  let compliancePolicyLoaderRef:
    | import("./compliance/policy-loader.js").CompliancePolicyLoader
    | undefined;
  // Lazy reference for the shadow mode service (constructed after engine is ready).
  let shadowModeServiceRef:
    | import("./graph/shadow-mode.js").ShadowModeService
    | undefined;
  // Lazy reference for the trigger scheduler (constructed after engine is ready).
  let triggerSchedulerRef:
    | import("./graph/trigger-scheduler.js").TriggerScheduler
    | undefined;

  const flowParserService = createFlowParserService(config.flowsDir, {
    onDispatchChange: () => flowDispatcher.reload(),
    onAccessChange: () => flowAuthorizer.reload(),
    onCanaryChange: () => canaryManager.reload(),
    onGuardrailsChange: () => guardrailPolicy.reload(),
    onExperimentsChange: () => {
      void abManager?.reload();
    },
    onToolAuthzChange: () => {
      toolAuthzLoader.reload();
      graphEngine.setToolAuthzEngine?.(toolAuthzLoader.engine);
    },
    onFlowChange: () => {
      flowMcpServerRef?.syncTools();
      // Re-scan for schedule triggers so new/changed/removed scheduled flows
      // take effect without a restart.
      triggerSchedulerRef?.sync();
      // Reload SLO targets (slo.json) on any flow-dir change.
      loadSloTargets();
    },
    onComplianceChange: () => {
      compliancePolicyLoaderRef?.reload();
      graphEngine.setCompliancePolicy?.(compliancePolicyLoaderRef?.policy);
    },
    onShadowChange: () => {
      shadowModeServiceRef?.reload(loadShadowConfig(config.flowsDir));
    },
  });
  await flowParserService.start();
  const fileRegistry = flowParserService.getRegistry();

  // 7d. Online flow store + composite registry
  let dbFlowSource: ReturnType<typeof createDbFlowSource> | undefined;
  let flowRegistry = fileRegistry;
  if (config.flowEditorEnabled === true && flowStore !== undefined) {
    const flowStoreForAb = flowStore;
    dbFlowSource = createDbFlowSource(flowStoreForAb, logger);
    await dbFlowSource.refresh();
    dbFlowSource.startPolling(10_000);
    flowRegistry = createCompositeRegistry(fileRegistry, dbFlowSource);

    abManager = createAbManager(
      config.flowsDir,
      async (flow, version) => {
        const versions = await flowStoreForAb.listVersions(flow);
        return versions.find((v) => v.version === version)?.definition;
      },
      logger,
    );
    const activeAbManager = abManager;
    await activeAbManager.reload();
    if (activeAbManager.enabled) {
      flowRegistry = createVersionedRegistry(flowRegistry, (id) =>
        activeAbManager.resolveVersioned(id),
      );
      logger.info("A/B experiments enabled", {
        experiments: activeAbManager.status().length,
      });
    }
  }

  // 8. MCP
  const { mcpWrapper, knownToolIds, toolGroupSummarizer } = await buildMcp(
    config,
    logger,
  );

  // 9. JWT + operator auth
  const {
    jwtVerifier,
    operatorAuth,
    metricsOperatorAuth,
    metricsAuthRequiredFlag,
  } = buildOperatorAuthentication(config, logger);

  // 10. Guardrails
  const guardrails = await buildGuardrails(
    config,
    logger,
    guardrailPolicy,
    embedder,
  );
  const {
    inputGuardrail,
    inputGuardrailClassify,
    outputGuardrail,
    toolEgressGuardrail,
    toolOutputValidator,
    flowGuardrailResolver,
    approvalGate,
    groundednessGate,
  } = guardrails;

  // 11. Monitoring service
  const pubsub =
    config.redisUrl !== undefined
      ? await createRedisPubSub(config.redisUrl, logger)
      : undefined;
  if (pubsub !== undefined)
    logger.info("Distributed monitoring enabled via Redis");
  const monitoringService = createMonitoringService(
    config,
    pubsub,
    logger,
    executionStore,
  );

  // 11b. Per-user assistants.
  //
  // Built BEFORE the engine because the engine's handler factories need the runtime
  // to hand to the assistant nodes. The learning-pass runner is bound afterwards
  // (see `assistantLearningRunner` below): it needs the engine, so passing it here
  // would be a construction cycle. Until it is bound, turns are still recorded and
  // canaries still settle — only capture waits.
  let assistantLearningRunner:
    | ((
        candidate: import("./assistants/experience-review.js").ReviewCandidate,
      ) => Promise<void>)
    | undefined;
  const assistantsResult = await buildAssistants({
    config,
    logger,
    ...(database !== undefined ? { db: database } : {}),
    ...(approvalGate !== undefined ? { approvals: approvalGate } : {}),
    runLearningPass: async (candidate) => {
      // Late-bound indirection: the scheduler is constructed inside
      // buildAssistants, but the pass it runs needs the engine that is built next.
      if (assistantLearningRunner === undefined) return;
      await assistantLearningRunner(candidate);
    },
  });

  // 12. Graph engine + replay + optimizer
  const _engineResult = await buildEngine(
    config,
    logger,
    database,
    flowRegistry,
    mcpWrapper,
    knownToolIds,
    toolGroupSummarizer,
    metrics,
    spendRecorder,
    tracer,
    {
      semanticCache,
      responseCache,
      vectorStore,
      memoryStore,
      ...(assistantsResult !== undefined
        ? { assistants: assistantsResult.runtime }
        : {}),
      ...(assistantsResult?.reviewScheduler !== undefined
        ? { assistantReviewScheduler: assistantsResult.reviewScheduler }
        : {}),
      ragEmbedder,
      reranker,
      outputGuardrail,
      toolEgressGuardrail,
      approvalGate,
      groundednessGate,
      flowStore,
      storeFactory,
      toolOutputValidator,
    },
  );
  const {
    graphEngine: rawGraphEngine,
    modelQuality,
    mediaStore,
    debugTraceStore,
    replayStore,
    replayService,
    replayExecutor,
    flowOptimizer,
    traceAnalyzer,
    canaryJudge,
    providerKeyPool,
  } = _engineResult;

  // Close the learning loop. Bound here rather than inside buildAssistants because
  // the pass needs a model and the replay store, both of which come from the engine
  // built above — passing it in earlier would be a construction cycle. The scheduler
  // holds an indirection that becomes live at this assignment.
  if (assistantsResult !== undefined && replayStore !== undefined) {
    const { createLearningPassRunner } = await import(
      "./assistants/learning-pass.js"
    );
    // The deployment's memory-extraction model when configured, else its default:
    // the pass is a short judgement over a bounded transcript, so it belongs on the
    // same model that already serves the deployment's side tasks rather than on a
    // setting of its own.
    const reviewModelConfig = config.memoryExtractionModel ?? config.defaultLlm;
    if (reviewModelConfig === undefined) {
      // No model at all on this deployment. Learning cannot run, and saying so is
      // better than an assistant that silently never improves.
      logger.warn(
        "Assistant learning is enabled but no default LLM is configured, so no procedures can be captured.",
      );
    } else {
      assistantLearningRunner = createLearningPassRunner({
      runtime: assistantsResult.runtime,
      model: createLlmProvider(reviewModelConfig, config),
      loadTranscript: async (candidate) => {
        const snapshot = await replayStore.get(candidate.executionId);
        if (snapshot === undefined) return [];
        // The snapshot holds the request messages and the final answer. Appending the
        // answer reconstructs the full turn, which is what the pass must judge — the
        // request alone shows the goal but not how it was reached.
        return [
          ...snapshot.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          ...(snapshot.responseText.length > 0
            ? [{ role: "assistant", content: snapshot.responseText }]
            : []),
        ];
      },
      logger,
      });
      logger.info("Assistant learning pass wired to the replay store");
    }
  } else if (assistantsResult?.reviewScheduler !== undefined) {
    // Learning is on but there is nothing to learn FROM. Said plainly, because the
    // symptom otherwise is an assistant that never improves and no indication why.
    logger.warn(
      "Assistant learning is enabled but replay is not (REPLAY_ENABLED). " +
        "Turns are recorded and canaries settle, but no procedures can be captured — " +
        "the pass has no transcript to review.",
    );
  }

  // Wire the tracer into the engine — pass it to buildEngine via config (it reads
  // TRACING_ENABLED from config already; the tracer is passed at construction).
  // Note: setTracer() does not exist on GraphEngineService; the tracer is wired
  // inside buildEngine which now accepts it explicitly.

  // Reversible PII tokenization vault (Killer Feature): transparently
  // tokenizes inbound message text and detokenizes outbound chunks around
  // EVERY call path (chat, triggers, replay, MCP) by decorating the engine
  // once here — see src/graph/pii-vault-engine.ts.
  // Multimodal (image/file) PII handling (ADR-0016): image/file attachments
  // cannot be reversibly tokenized like text, so the vault applies a one-way
  // control — "block" (strip attachments before they reach the provider) or
  // "redact" (swap in a redacted copy via a configured image redactor). Off by
  // default, fully backward compatible.
  const piiMultimodalMode = config.piiVaultMultimodalMode ?? "off";
  let piiMultimodalOptions:
    | import("./graph/pii-image-scanner.js").MultimodalOptions
    | undefined;
  if (piiVault !== undefined && piiMultimodalMode !== "off") {
    const { createRemoteImageRedactor, createLlmImageDescriber } = await import(
      "./graph/pii-image-scanner.js"
    );
    const imageRedactor =
      config.piiImageRemoteEndpoint !== undefined
        ? createRemoteImageRedactor({
            endpoint: config.piiImageRemoteEndpoint,
            ...(config.piiImageRemoteApiKey !== undefined
              ? { apiKey: config.piiImageRemoteApiKey }
              : {}),
            ...(config.piiImageRemoteTimeoutMs !== undefined
              ? { timeoutMs: config.piiImageRemoteTimeoutMs }
              : {}),
            logger,
          })
        : undefined;
    // `describe` mode: build a vision-model describer. The description text is
    // then tokenized like normal content, so the downstream provider never sees
    // the raw image. The describer model SHOULD be local/on-prem (it sees the
    // raw pixels) — logged as a reminder when it isn't obviously local.
    const piiImageDescribeModel = config.piiImageDescribeModel;
    const imageDescriber =
      piiMultimodalMode === "describe" && piiImageDescribeModel !== undefined
        ? (() => {
            try {
              const model = createLlmProvider(piiImageDescribeModel, config);
              return createLlmImageDescriber(model, {
                logger,
                ...(config.piiImageDescribePrompt !== undefined
                  ? { prompt: config.piiImageDescribePrompt }
                  : {}),
              });
            } catch (err) {
              logger.warn(
                "Failed to build PII_IMAGE_DESCRIBE_MODEL — describe mode will STRIP attachments instead",
                { error: err instanceof Error ? err.message : String(err) },
              );
              return undefined;
            }
          })()
        : undefined;
    piiMultimodalOptions = {
      mode: piiMultimodalMode,
      failMode: config.piiVaultMultimodalFailMode ?? "open",
      logger,
      ...(imageRedactor !== undefined ? { redactor: imageRedactor } : {}),
      ...(imageDescriber !== undefined ? { describer: imageDescriber } : {}),
    };
    if (piiMultimodalMode === "redact" && imageRedactor === undefined) {
      logger.warn(
        "PII_VAULT_MULTIMODAL_MODE=redact but no PII_IMAGE_REMOTE_ENDPOINT configured — image/file attachments will be STRIPPED (blocked) instead of redacted.",
      );
    } else if (piiMultimodalMode === "describe" && imageDescriber === undefined) {
      logger.warn(
        "PII_VAULT_MULTIMODAL_MODE=describe but no PII_IMAGE_DESCRIBE_MODEL configured — image/file attachments will be STRIPPED (blocked) instead of described.",
      );
    } else {
      if (
        piiMultimodalMode === "describe" &&
        !isLocalInferenceProvider(config.piiImageDescribeModel?.provider)
      ) {
        logger.warn(
          "PII vault describe mode uses a non-local describer provider — the describer model SEES the raw image; prefer a local/on-prem vision model (e.g. Ollama) so PII never leaves your infrastructure.",
          { provider: config.piiImageDescribeModel?.provider },
        );
      }
      logger.info("PII vault multimodal handling active", {
        mode: piiMultimodalMode,
        redactor: imageRedactor !== undefined ? "remote" : "none",
        describer: imageDescriber !== undefined ? "llm" : "none",
        failMode: config.piiVaultMultimodalFailMode ?? "open",
      });
    }
  }

  function rocketChatProgressMessage(raw: string): string | undefined {
    const toolDetails = Array.from(
      raw.matchAll(
        /<details\b(?=[^>]*\btype=["']tool_calls["'])[^>]*\bname=["']([^"']+)["']/gi,
      ),
    );
    const toolName =
      toolDetails.at(-1)?.[1] ??
      Array.from(raw.matchAll(/🔧\s*Tool:\s*\*\*([^*]+)\*\*/gi)).at(-1)?.[1];
    if (toolName !== undefined) {
      const readable = toolName.split(" · ")[0]?.replaceAll("__", "/").trim();
      if (readable !== undefined && readable.length > 0) {
        return `Working …\n\nQuerying the ${readable} tool …`;
      }
    }
    const structured = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(?:🧭|📚|⚙️|🧠)\s+/.test(line))
      .at(-1);
    if (structured === undefined) return undefined;
    return `Working …\n\n${structured.slice(0, 240)}`;
  }

  const graphEngine =
    piiVault !== undefined
      ? withPiiVault(rawGraphEngine, piiVault, piiMultimodalOptions)
      : rawGraphEngine;

  // Durable assistant work uses the same public engine entry point as triggers.
  // Bootstrap is built before the engine, so this deliberately closes that cycle
  // only after the final (PII-decorated) engine exists.
  assistantsResult?.setRunDispatcher(async (run) => {
    const flowId = run.resumePayload.flowId;
    if (typeof flowId !== "string" || flowId.length === 0) {
      throw new Error("Assistant run payload requires a non-empty flowId.");
    }
    const message = typeof run.resumePayload.message === "string"
      ? run.resumePayload.message
      : JSON.stringify(run.resumePayload);
    const conversationId = typeof run.resumePayload.conversationId === "string"
      ? run.resumePayload.conversationId
      : undefined;
    const runTrigger = run.origin === "schedule" ? "schedule" : "message";
    const userName =
      typeof run.resumePayload.userName === "string" &&
      run.resumePayload.userName.trim().length > 0
        ? run.resumePayload.userName.trim()
        : run.scope.userId;
    const authority = await assistantsResult.resolveRunAuthority({
      scope: run.scope,
      trigger: runTrigger,
      userInitiated: run.origin === "rocket-chat",
    });
    const responseParts: string[] = [];
    let finalResponse = "";
    const rocketChat =
      run.resumePayload.delivery === "rocket-chat" ? assistantsResult.rocketChat : undefined;
    let reasoning = "";
    let lastProgress = "";
    let lastProgressAt = 0;
    const boundaryMeta = {
      flowId,
      tenantId: run.scope.tenantId,
    };
    const executionContext = {
      ssoToken: authority.token,
      // Durable assistant runs carry a delegated bearer rather than entering
      // through the HTTP auth middleware, so no decoded claims existed here.
      // Preserve the consented OIDC scope returned by the authority resolver.
      // TransactionOrchestrator derives signed envelope scopes exclusively
      // from ctx.claims.scope/scp; this forwards the authority as issued and
      // does not add legacy tools:read or tools:write scopes.
      ...(authority.scope !== undefined
        ? { claims: { scope: authority.scope } }
        : {}),
      executionId: run.id,
      clientId: run.scope.tenantId,
      userId: run.scope.userId,
      userName,
      ...(conversationId !== undefined ? { chatId: conversationId } : {}),
      requestParams: {
        trigger: runTrigger,
        assistant_id: run.scope.assistantId,
        assistant_run_id: run.id,
        ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
        ...(authority.notice !== undefined ? { authority_notice: authority.notice } : {}),
      },
    };
    emitBoundaryNode(monitoringService, run.id, boundaryMeta, {
      nodeId: REQUEST_NODE_ID,
      sequence: 0,
      userName,
      userId: run.scope.userId,
      userPrompt: message.slice(0, 500),
      prompt: JSON.stringify({
        origin: run.origin,
        trigger: runTrigger,
        flowId,
        assistantId: run.scope.assistantId,
        conversationId: conversationId ?? null,
      }),
    });

    try {
      await requireExecutionAdmission(executionAdmission, flowId, executionContext);
      await graphEngine.executeFlow(
        flowId,
        [{ role: "user", content: message }],
        executionContext,
      async (chunk) => {
        const delta = chunk.choices[0]?.delta;
        if (typeof delta?.content === "string") responseParts.push(delta.content);
        if (rocketChat !== undefined && typeof delta?.reasoning_content === "string") {
          reasoning = `${reasoning}${delta.reasoning_content}`.slice(-8_000);
          const progress = rocketChatProgressMessage(reasoning);
          const now = Date.now();
          const reachedBoundary = /[.!?…]\s*$|\n/.test(delta.reasoning_content);
          if (
            progress !== undefined &&
            progress !== lastProgress &&
            (reachedBoundary || now - lastProgressAt >= 1_000)
          ) {
            lastProgress = progress;
            lastProgressAt = now;
            try {
              const queued = await rocketChat.outbox.enqueueRunProgress(run, progress);
              if (queued !== undefined) await rocketChat.flushOutbox();
            } catch (error) {
              logger.warn("Rocket.Chat progress update failed; the durable run continues", {
                runId: run.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      },
      async () => {},
      monitoringService,
      undefined,
      async (response) => {
        finalResponse = response;
      },
      );
    } catch (error) {
      emitBoundaryNode(monitoringService, run.id, boundaryMeta, {
        nodeId: RESPONSE_NODE_ID,
        hadError: true,
        response: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const streamedResponse = responseParts.join("");
    const responseText =
      streamedResponse.trim().length > 0 ? streamedResponse : finalResponse;
    emitBoundaryNode(monitoringService, run.id, boundaryMeta, {
      nodeId: RESPONSE_NODE_ID,
      response: responseText,
    });
    if (run.resumePayload.delivery === "rocket-chat") {
      if (rocketChat === undefined) {
        throw new Error("Rocket.Chat delivery was requested but the channel is unavailable.");
      }
      const queued = await rocketChat.outbox.enqueueRunResult(run, responseText);
      if (queued === undefined) {
        throw new Error("Rocket.Chat delivery was requested but no active binding or response was available.");
      }
      try {
        await rocketChat.flushOutbox();
      } catch (error) {
        logger.warn("Immediate Rocket.Chat final delivery failed; durable outbox will retry", {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  // Wire tool authorization policy engine (hot-reload).
  graphEngine.setToolAuthzEngine?.(toolAuthzLoader.engine);

  // ── Shadow Mode — Continuous Quality Monitoring ────────────────────────────
  // Lazy-load shadow config (shadow.yaml / shadow.json in flows dir), build the
  // service with the canary judge (reused — same model, already configured), and
  // store the ref for hot-reload wiring above.
  const { parseFlowFile: _parseFlowFileFn, resolveConfigFile: _resolveConfigFileFn } =
    await import("./util/parse-flow-file.js");
  const loadShadowConfig = (flowsDir: string): unknown => {
    const path = _resolveConfigFileFn(flowsDir, "shadow");
    if (path === null) return null;
    try {
      return _parseFlowFileFn(path);
    } catch {
      return null;
    }
  };

  const { createShadowModeService } = await import("./graph/shadow-mode.js");
  const shadowExecutor = replayExecutor; // same executor shape as replay
  const shadowModeService = createShadowModeService({
    ...(canaryJudge !== undefined ? { judge: canaryJudge } : {}),
    executor: shadowExecutor,
    shadowTimeoutMs: config.executionTimeoutMs ?? 120_000,
    judgeTimeoutMs: 30_000,
    logger,
  });
  shadowModeService.reload(loadShadowConfig(config.flowsDir));
  shadowModeServiceRef = shadowModeService;
  if (shadowModeService.runner !== undefined) {
    const cfgs = shadowModeService.configs();
    if (cfgs.length > 0) {
      logger.info("Shadow mode enabled (continuous quality monitoring)", {
        pairs: cfgs.map((c) => `${c.productionFlow}→${c.shadowFlow}`),
        totalPairs: cfgs.length,
      });
    }
  } else {
    logger.info(
      "Shadow mode loaded but no judge configured (set CANARY_JUDGE_MODEL to enable scoring). " +
        "Stats route /monitoring/shadow is available without scoring.",
    );
  }

  // One transport-neutral gate protects every engine entry point (HTTP,
  // async/recovery, MCP, webhooks and schedules) before executeFlow.
  const executionAdmission = new ExecutionAdmissionService({
    flowRegistry,
    graphEngine,
    authorizationEnabled: config.authzEnabled ?? true,
    authorizer: flowAuthorizer,
    flowScopeClaims: config.flowScopeClaims,
    compliancePolicyLoader: { get policy() { return compliancePolicyLoaderRef?.policy; } },
    providerRegions: config.providerRegions,
    failClosedUnknownRegion:
      config.complianceFailClosedUnknownRegion ?? config.appEnv === "production",
    costTracker: budgetService,
    budgetDailyPerTenant: config.budgetDailyPerTenant,
    limitEnforcer: tokenLimitEnforcer,
    byokResolver,
    byokMode: config.byokMode,
    defaultLlm: config.defaultLlm,
    fallbackLlm: config.fallbackLlm,
    fallbackChain: config.fallbackChain,
  });
  _engineResult.setReplayAdmission(executionAdmission);

  // Flow-as-MCP-Server: expose every published flow as an MCP tool.
  // Synced whenever the flow registry reloads (chokidar hot-reload).
  const flowMcpServer = createFlowMcpServer({
    flowRegistry,
    graphEngine,
    ...(inputGuardrail !== undefined ? { inputGuardrail } : {}),
    authorizationEnabled: config.authzEnabled ?? true,
    flowAuthorizer,
    jwtVerifier,
    flowScopeClaims: config.flowScopeClaims,
    admission: executionAdmission,
    serverName: "aiperator",
    serverVersion: "1.0.0",
    logger,
  });
  flowMcpServerRef = flowMcpServer;

  // ── Red-Team / AI Security Posture ────────────────────────────────────────
  // Build the RedTeamEngine and optional scheduler when RED_TEAM_ENABLED=true.
  // The executor wraps the graphEngine + inputGuardrail so attacks go through
  // the exact same pipeline as real user requests.
  let redTeamEngine:
    | import("./security/red-team-engine.js").RedTeamEngine
    | undefined;
  let redTeamScheduler:
    | import("./security/red-team-scheduler.js").RedTeamScheduler
    | undefined;

  if (config.redTeamEnabled === true) {
    // Boot the attack registry (with optional remote hot-updates) BEFORE the engine.
    const { createAttackRegistry } = await import("./security/red-team-attack-registry.js");
    createAttackRegistry({
      remoteUrl: config.redTeamAttacksUrl,
      pollIntervalMs: config.redTeamAttacksPollIntervalMs,
      logger,
    });
    if (config.redTeamAttacksUrl !== undefined) {
      logger.info("Red-team attack library remote updates enabled", {
        url: config.redTeamAttacksUrl,
        pollIntervalMs: config.redTeamAttacksPollIntervalMs,
      });
    }

    const redTeamJudgeModel = config.redTeamJudgeModel;
    const redTeamJudgeLlm =
      redTeamJudgeModel !== undefined
        ? (() => {
            try {
              return createLlmProvider(redTeamJudgeModel, config);
            } catch {
              return undefined;
            }
          })()
        : config.defaultLlm !== undefined
          ? createLlmProvider(config.defaultLlm, config)
          : undefined;

    const { createLlmJudge } = await import("./eval/llm-judge.js");
    redTeamEngine = createRedTeamEngine({
      attacksPerRun: config.redTeamAttacksPerRun,
      ...(redTeamJudgeLlm !== undefined
        ? { judge: createLlmJudge(redTeamJudgeLlm) }
        : {}),
      judgePassThreshold: config.redTeamJudgeThreshold ?? 0.7,
      autoTune: config.redTeamAutoTune ?? false,
      autoTuneBypassCeiling: config.redTeamAutoTuneCeiling ?? 0.1,
      postureAlertThreshold: config.redTeamPostureAlertThreshold ?? 0.7,
      alertWebhookUrl:
        config.redTeamAlertWebhookUrl ?? config.budgetAlertWebhookUrl,
      ...(_engineResult.replayStore !== undefined
        ? { replayStore: _engineResult.replayStore }
        : {}),
      logger,
    });
    logger.info(
      "Red-team / security posture engine enabled at /security/red-team/*",
    );

    // Build the executor: runs an attack through the guardrail + graphEngine.
    const redTeamExecutor = async (
      flowId: string,
      payload: string,
    ): Promise<{ response: string; blocked: boolean; inputScore: number }> => {
      // Heuristic input score.
      const { scoreText } = await import("./graph/input-guardrails.js");
      const scanResult = scoreText(payload, inputGuardrail?.threshold ?? 0.8);
      const inputScore = scanResult.score;

      // Apply guardrail in "block" mode for the red-team (we want to measure blocks).
      if (inputGuardrail !== undefined && scanResult.flagged) {
        return { response: "", blocked: true, inputScore };
      }

      const parts: string[] = [];
      const executionContext = { ssoToken: "red-team", executionId: crypto.randomUUID() };
      await requireExecutionAdmission(executionAdmission, flowId, executionContext);
      await graphEngine.executeFlow(
        flowId,
        [{ role: "user", content: payload }],
        executionContext,
        async (chunk) => {
          const delta = chunk.choices[0]?.delta?.content;
          if (typeof delta === "string") parts.push(delta);
        },
        async () => {},
      );
      return { response: parts.join(""), blocked: false, inputScore };
    };

    // Scheduled runs (opt-in).
    const redTeamScheduleFlows = config.redTeamScheduleFlows;
    if (redTeamScheduleFlows !== undefined && redTeamScheduleFlows.length > 0) {
      redTeamScheduler = createRedTeamScheduler(redTeamEngine, {
        flowIds: redTeamScheduleFlows,
        intervalMs: config.redTeamIntervalMs ?? 6 * 60 * 60_000,
        executor: redTeamExecutor,
        ...(inputGuardrail !== undefined ? { guardrail: inputGuardrail } : {}),
        logger,
      });
      redTeamScheduler.start();
      logger.info("Red-team scheduler started", {
        flows: redTeamScheduleFlows,
        intervalMs: config.redTeamIntervalMs ?? 6 * 60 * 60_000,
      });
    }
  }

  // Pre-validate + cache graphs for all loaded flows
  for (const flow of flowRegistry.list()) {
    try {
      graphEngine.buildGraph(
        flow,
        knownToolIds.size > 0 ? knownToolIds : undefined,
      );
    } catch (err) {
      logger.warn("Flow failed graph validation", {
        flow: flow.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 12b. Flow ↔ MCP-server identity audit.
  // Reports flows that carry personal data through MCP servers which receive no
  // caller identity at all — those servers cannot apply a per-user ACL, so the
  // only separation left is whatever filter the flow itself sends. Reporting
  // only: a public corpus is a legitimate configuration, so this must not block
  // a start. See src/graph/flow-identity-audit.ts.
  {
    const loadedFlows = flowRegistry.list();
    const identityFindings = auditFlowIdentityForwarding(
      loadedFlows,
      config.mcpServers,
    );
    for (const line of formatIdentityAuditWarnings(identityFindings)) {
      logger.warn(`Readiness warning: ${line}`);
    }

    // Report flows that would be retried purely because of the global default.
    // The per-flow carve-out exists precisely so a flow with writing tools can
    // refuse a from-scratch re-run; a flow that never declares silently inherits
    // whatever the deployment set.
    if (config.jobRecoveryEnabled === true) {
      const { undeclared } = partitionFlowsByRecoveryDeclaration(loadedFlows);
      if (undeclared.length > 0) {
        logger.warn(
          `Readiness warning: JOB_RECOVERY_ENABLED is on and ${undeclared.length} flow(s) ` +
            `declare no \`recovery\` policy, so they inherit the deployment-wide retry ` +
            `default: ${undeclared.join(", ")}. A recovery retry re-runs a flow FROM THE ` +
            `BEGINNING (ADR-0023) — declare \`recovery: { retry: false }\` on any of these ` +
            `whose tools write to a foreign system, or \`retry: true\` to state that a ` +
            `re-run is safe.`,
        );
      }
    }
  }

  // 13. Hono app
  const app = new Hono<AuthContext>();

  const allowAnyOrigin = config.corsOrigins.includes("*");
  app.use(
    "*",
    cors({
      origin: allowAnyOrigin
        ? "*"
        : (origin) => (config.corsOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Type", "X-Accel-Buffering", "Cache-Control"],
    }),
  );

  // Allows the capability-token-protected approval HTML pages to be embedded
  // by the explicitly allowlisted Open WebUI parent after secureHeaders() has
  // applied the rest of the response hardening.
  app.use("*", approvalWidgetEmbeddingMiddleware);

  // Security response headers (CSP omitted deliberately — this is a JSON API
  // plus a separately-deployed dashboard, not an HTML-serving origin here, so
  // a restrictive `default-src 'none'` would need per-route tuning to avoid
  // breaking the OIDC callback / approval-widget HTML responses; those set
  // their own minimal inline styles and are reviewed individually). Every
  // other header Hono's `secureHeaders()` sets by default — HSTS,
  // X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  // Cross-Origin-*-Policy, X-DNS-Prefetch-Control, X-Download-Options,
  // X-Permitted-Cross-Domain-Policies — applies with no per-route exceptions.
  app.use("*", secureHeaders());

  // CSRF protection for state-changing requests.
  //
  // `authMiddleware` (src/middleware/auth.ts) accepts a `token` COOKIE as a
  // full credential on `/v1/*` (the Open WebUI OAuth-mode integration). A
  // cookie is attached by the browser to a cross-origin request automatically
  // — including a simple, non-JSON HTML <form> POST that a malicious page can
  // auto-submit — so without this, any state-changing endpoint accepting such
  // a body (form-urlencoded/multipart/text-plain) would execute with the
  // victim's session even though CORS never allowed the origin to read the
  // response. Hono's csrf() middleware closes exactly that vector: it checks
  // `Sec-Fetch-Site`/`Origin` and rejects an unsafe-method request with a
  // form-like content-type that did not originate same-site. JSON requests
  // (application/json — what every /v1/* client actually sends) are
  // unaffected; this only removes the form-submission bypass.
  //
  // Excluded: `/webhooks/*` (GitOps) and `/triggers/*` — these are
  // server-to-server callbacks authenticated by an HMAC signature over the
  // body, never by a browser-held cookie, so CSRF (which exists to protect
  // COOKIE-carrying requests) does not apply to them. Some Git providers also
  // post with a content-type csrf() would otherwise flag, and there is no
  // browser Origin/Sec-Fetch-Site to evaluate for a server-side webhook
  // sender in the first place.
  const csrfProtection = csrf();
  app.use("*", (ctx, next) =>
    ctx.req.path.startsWith("/webhooks/") || ctx.req.path.startsWith("/triggers/")
      ? next()
      : csrfProtection(ctx, next),
  );

  // Request logging + tracing
  app.use("*", async (ctx, next) => {
    const requestId = crypto.randomUUID();
    ctx.header("X-Request-Id", requestId);
    const start = Date.now();
    const routeLabelForSpan = ctx.req.routePath ?? ctx.req.path;
    const inbound = parseTraceparent(ctx.req.header("traceparent"));
    const serverSpan = tracer.startSpan(
      `${ctx.req.method} ${routeLabelForSpan}`,
      {
        kind: "server",
        ...(inbound !== undefined ? { parent: inbound } : {}),
        attributes: {
          "http.method": ctx.req.method,
          "http.route": routeLabelForSpan,
          "aiperator.request_id": requestId,
        },
      },
    );
    if (tracer.enabled) ctx.set(TRACE_CONTEXT_KEY, serverSpan.spanContext());
    await next();
    const durationMs = Date.now() - start;
    logger.info("request", {
      requestId,
      method: ctx.req.method,
      path: ctx.req.path,
      status: ctx.res.status,
      durationMs,
    });
    serverSpan
      .setAttribute("http.status_code", ctx.res.status)
      .setStatus(ctx.res.status >= 500 ? "error" : "ok")
      .end();
    const routeLabel = ctx.req.routePath ?? ctx.req.path;
    const isInternalRoute =
      routeLabel === "/metrics" ||
      routeLabel.startsWith("/monitoring/") ||
      routeLabel.startsWith("/health");
    if (!isInternalRoute)
      metrics.recordRequest(routeLabel, ctx.res.status, durationMs);
  });

  // Auth + rate limiting on /v1/*
  const maxBodyBytes = config.maxRequestBodyBytes ?? 26_214_400;
  const exceptMedia =
    (mw: MiddlewareHandler): MiddlewareHandler =>
    (ctx, next) =>
      ctx.req.path.startsWith("/v1/media/") ? next() : mw(ctx, next);

  const rateLimitPerMinute = config.rateLimitPerMinute ?? 0;
  const rateLimitPerUserPerMinute = config.rateLimitPerUserPerMinute ?? 0;
  const rateLimitPreAuthPerMinute = config.rateLimitPreAuthPerMinute ?? 0;
  const rateLimitPostAuthPerMinute = config.rateLimitPostAuthPerMinute ?? 0;
  const anyRateLimitEnabled =
    rateLimitPerMinute > 0 ||
    rateLimitPerUserPerMinute > 0 ||
    rateLimitPreAuthPerMinute > 0 ||
    rateLimitPostAuthPerMinute > 0;
  // Prefer the true sliding-window Redis limiter when Redis is configured — it
  // weights the previous window and avoids the ~2× burst a fixed-window counter
  // allows at the boundary. Fall back to the StoreFactory-backed (fixed-window)
  // counter when Redis is unavailable or not configured.
  const rateLimitStore =
    anyRateLimitEnabled
      ? (config.redisUrl !== undefined
          ? createRedisRateLimitStore(config.redisUrl, logger)
          : undefined) ??
        createStoreBackedRateLimitStore(
          storeFactory.counter<string>("rate-limit"),
        )
      : undefined;
  if (rateLimitStore !== undefined)
    logger.info("Rate limiting enabled", {
      backing: storeFactory.backing(),
      window:
        config.redisUrl !== undefined ? "sliding (redis)" : "fixed (store)",
    });

  app.use(
    "/v1/*",
    exceptMedia(
      bodyLimit({
        maxSize: maxBodyBytes,
        onError: (ctx) =>
          ctx.json(
            {
              error: {
                message: `Request body exceeds the ${maxBodyBytes}-byte limit.`,
                type: "invalid_request_error",
              },
            },
            413,
          ),
      }),
    ),
  );
  // Additive abuse gate: network identity only, deliberately before auth.
  app.use(
    "/v1/*",
    exceptMedia(
      preAuthRateLimitMiddleware(
        rateLimitPreAuthPerMinute,
        rateLimitStore,
        logger,
        config.rateLimitFailMode ?? "open",
      ),
    ),
  );
  // Legacy token/IP + optional user limiter remains in its historical position
  // and keeps its existing headers/status contract.
  app.use(
    "/v1/*",
    exceptMedia(
      rateLimitMiddleware(
        rateLimitPerMinute,
        rateLimitStore,
        logger,
        config.rateLimitFailMode ?? "open",
        rateLimitPerUserPerMinute,
      ),
    ),
  );
  // Managed API keys (`aip-…`) authenticate the inference plane only when tenant
  // management is on — that is what issues the keys in the first place. Without
  // the resolver the middleware rejects such a key with an explicit "not
  // enabled" message instead of the misleading "invalid token format".
  const apiKeyResolver =
    config.authnMode !== "oidc" &&
    config.authnMode !== "disabled" &&
    config.tenantManagementEnabled === true && tenantStore !== undefined
      ? (rawKey: string) => resolveApiKey(rawKey, tenantStore, logger)
      : undefined;
  if (apiKeyResolver !== undefined) {
    logger.info("API key authentication enabled for /v1/* (aip-… keys)");
  }
  app.use(
    "/v1/*",
    exceptMedia(
      authMiddleware(jwtVerifier, apiKeyResolver, {
        mode: config.authnMode,
        tenantIsolationEnabled: config.tenantIsolationEnabled,
        defaultTenantId: config.defaultTenantId ?? "default",
      }),
    ),
  );
  // Additive authenticated gate: only the verified principal/tenant established
  // above contributes to the key; no client identity header is consulted.
  app.use(
    "/v1/*",
    exceptMedia(
      postAuthRateLimitMiddleware(
        rateLimitPostAuthPerMinute,
        rateLimitStore,
        logger,
        config.rateLimitFailMode ?? "open",
      ),
    ),
  );

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.route(
    "/",
    createAnalysisArtifactsRouter(new AnalysisArtifactService(analysisArtifactStore)),
  );
  let healthRedisClient:
    | import("./routes/health.js").RedisProbeClient
    | undefined;
  if (config.redisUrl !== undefined) {
    const { createRedisClient } = await import("./util/redis-client.js");
    const rc = createRedisClient<{ ping: () => Promise<unknown> }>(
      config.redisUrl,
      "Readiness probe",
      logger,
    );
    if (rc !== undefined && typeof rc.ping === "function") {
      const rcPing = rc.ping.bind(rc);
      healthRedisClient = { ping: () => rcPing() };
    }
  }
  app.route(
    "/",
    createHealthRouter(flowRegistry, {
      database,
      ...(healthRedisClient !== undefined
        ? { redisClient: healthRedisClient }
        : {}),
      redisRequired: config.redisUrl !== undefined,
      probeTimeoutMs: config.healthProbeTimeoutMs,
    }),
  );
  app.route(
    "/",
    createModelsRouter(flowRegistry, {
      jwtVerifier,
      authorizer: flowAuthorizer,
      authzEnabled: config.authzEnabled ?? true,
      flowScopeClaims: config.flowScopeClaims,
      // Lets a user SEE their own assistants in the model picker. Without it the
      // `assistant-<id>` selector exists in the dispatcher and nowhere a person looks.
      ...(assistantsResult !== undefined
        ? { assistants: assistantsResult.runtime.stores.assistants }
        : {}),
    }),
  );
  app.route("/", createMediaRouter(mediaStore));
  // Durable Agent Runtime opt-in for async/batch jobs (JOB_RECOVERY_ENABLED).
  // Requires a job store — recovery has nothing to recover without one.
  const executionContextSecret = process.env.AGENT_TRANSACTION_SECRET;
  const jobRecoveryOptions: { maxAttempts: number; leaseMs: number; contextSecret?: string } | undefined =
    jobStore !== undefined && config.jobRecoveryEnabled === true
      ? {
          maxAttempts: config.jobRecoveryMaxAttempts ?? 3,
          leaseMs: config.jobRecoveryLeaseMs ?? 300_000,
          ...(executionContextSecret !== undefined && executionContextSecret.length > 0
            ? { contextSecret: executionContextSecret }
            : {}),
        }
      : undefined;
  // Shared option set for the OpenAI-compatible inference endpoints. Both the
  // Chat Completions (`/v1/chat/completions`) and Responses (`/v1/responses`)
  // routers wire into the same services, so the options are built once and
  // passed to both — keeping their admission/execution behaviour identical.
  const inferenceRouterOptions = {
    admission: executionAdmission,
    costTracker: budgetService,
    metrics,
    llmStreamFallbackPolicy: config.llmStreamFallbackPolicy,
    budgetDailyPerTenant: config.budgetDailyPerTenant ?? 0,
    limitEnforcer: tokenLimitEnforcer,
    authorizer: flowAuthorizer,
    flowScopeClaims: config.flowScopeClaims,
    ...(canaryManager.enabled ? { canaryManager } : {}),
    ...(replayService !== undefined ? { replayService } : {}),
    ...(canaryJudge !== undefined ? { canaryJudge } : {}),
    modelQuality,
    sloRegistry,
    ...(byokResolver !== undefined ? { byokResolver } : {}),
    ...(idempotencyStore !== undefined ? { idempotencyStore } : {}),
    ...(jobStore !== undefined ? { jobStore } : {}),
    ...(jobRecoveryOptions !== undefined ? { jobRecovery: jobRecoveryOptions } : {}),
    ...(executionContextSecret !== undefined && executionContextSecret.length > 0
      ? { executionContextSecret }
      : {}),
    ...(inputGuardrail !== undefined
      ? {
          inputGuardrail,
          inputGuardrailMode: config.inputGuardrailMode ?? "flag",
          ...(inputGuardrailClassify !== undefined
            ? {
                inputGuardrailClassify,
                inputGuardrailModelMinScore:
                  config.inputGuardrailModelMinScore ?? 0.3,
              }
            : {}),
        }
      : {}),
    guardrailPolicy,
    flowGuardrailResolver,
    clientToolsEnabled: config.clientToolsEnabled ?? true,
    trustedIdentityHeaders: config.trustedIdentityHeaders ?? false,
    strictIdentityHeaders: config.strictIdentityHeaders ?? false,
    ...(memoryStore !== undefined
      ? {
          memoryStore,
          memoryAutoCapture: memoryExtractor !== undefined,
          ...(memoryExtractor !== undefined ? { memoryExtractor } : {}),
        }
      : {}),
    ...(abManager?.enabled ? { abManager } : {}),
    captureRequestTokens: config.debugCaptureRequestTokens,
    shadowModeService,
    // Lazy — the real loader is constructed later (Compliance Policy-as-Code
    // section below); this proxy defers to compliancePolicyLoaderRef so the
    // router only reads it at request time, once bootstrap has finished.
    compliancePolicyLoader: {
      get policy() {
        return compliancePolicyLoaderRef?.policy;
      },
    },
    auditLog,
    ...(config.sseHeartbeatMs !== undefined
      ? { sseHeartbeatMs: config.sseHeartbeatMs }
      : {}),
  };

  app.route(
    "/",
    createChatRouter(
      flowRegistry,
      graphEngine,
      monitoringService,
      jwtVerifier,
      flowDispatcher,
      inferenceRouterOptions,
    ),
  );

  // OpenAI Responses API (`POST /v1/responses`) — same pipeline as chat, with a
  // translation layer for the Responses request/response shapes. Clients like
  // n8n's OpenAI node target this endpoint instead of chat completions.
  app.route(
    "/",
    createResponsesRouter(
      flowRegistry,
      graphEngine,
      monitoringService,
      jwtVerifier,
      flowDispatcher,
      inferenceRouterOptions,
    ),
  );

  if (jobStore !== undefined) {
    app.route("/", createJobsRouter(jobStore));
    logger.info("Async job status API enabled at /v1/jobs/:id");
  }

  // Durable Agent Runtime — recovery sweeper (see job-store.ts /
  // job-recovery-sweeper.ts module doc comments). Only meaningful with a
  // job store AND JOB_RECOVERY_ENABLED; otherwise async jobs keep their
  // pre-existing (non-recoverable) behaviour.
  let jobRecoverySweeper: import("./graph/job-recovery-sweeper.js").JobRecoverySweeper | undefined;
  if (jobStore !== undefined && jobRecoveryOptions !== undefined) {
    const { createJobRecoverySweeper } = await import(
      "./graph/job-recovery-sweeper.js"
    );
    const { createJobRetryRunner } = await import("./routes/chat/metering.js");
    jobRecoverySweeper = createJobRecoverySweeper(
      { intervalMs: config.jobRecoverySweepIntervalMs ?? 60_000 },
      {
        jobStore,
        retry: createJobRetryRunner({
          graphEngine,
          jobStore,
          admission: executionAdmission,
          leaseMs: jobRecoveryOptions.leaseMs,
          ...(jobRecoveryOptions.contextSecret !== undefined
            ? { contextSecret: jobRecoveryOptions.contextSecret }
            : {}),
        }),
        logger,
      },
    );
    jobRecoverySweeper.start();
    logger.info("Durable Agent Runtime enabled — async jobs recover from a crash", {
      maxAttempts: jobRecoveryOptions.maxAttempts,
      leaseMs: jobRecoveryOptions.leaseMs,
      sweepIntervalMs: config.jobRecoverySweepIntervalMs ?? 60_000,
    });
  }

  // Flow-as-MCP-Server: POST/GET/DELETE /mcp. Unlike /v1 routes it is mounted
  // at the root, so it must receive the same verified credential explicitly.
  app.use(
    "/mcp",
    authMiddleware(jwtVerifier, apiKeyResolver, {
      mode: config.authnMode,
      tenantIsolationEnabled: config.tenantIsolationEnabled,
      defaultTenantId: config.defaultTenantId ?? "default",
    }),
  );
  app.route("/", createFlowMcpRouter({ flowMcpServer }));
  logger.info("Flow-as-MCP-Server enabled at /mcp", {
    flows: flowRegistry.list().map((f) => f.id),
  });

  // Red-Team / AI Security Posture: /security/red-team/* + /security/tool-authz + /security/mcp
  // The router is always mounted so the tool-authz and MCP-tools views work
  // even when the red-team engine is disabled; the red-team endpoints return
  // 503 when RED_TEAM_ENABLED is not set.
  {
    const redTeamExecutorForRoute =
      redTeamEngine !== undefined
        ? async (
            flowId: string,
            payload: string,
          ): Promise<{
            response: string;
            blocked: boolean;
            inputScore: number;
          }> => {
            const { scoreText } = await import("./graph/input-guardrails.js");
            const scanResult = scoreText(
              payload,
              inputGuardrail?.threshold ?? 0.8,
            );
            if (inputGuardrail !== undefined && scanResult.flagged) {
              return {
                response: "",
                blocked: true,
                inputScore: scanResult.score,
              };
            }
            const parts: string[] = [];
            const executionContext = { ssoToken: "red-team", executionId: crypto.randomUUID() };
            await requireExecutionAdmission(executionAdmission, flowId, executionContext);
            await graphEngine.executeFlow(
              flowId,
              [{ role: "user", content: payload }],
              executionContext,
              async (chunk) => {
                const delta = chunk.choices[0]?.delta?.content;
                if (typeof delta === "string") parts.push(delta);
              },
              async () => {},
            );
            return {
              response: parts.join(""),
              blocked: false,
              inputScore: scanResult.score,
            };
          }
        : undefined;
    app.route(
      "/",
      createRedTeamRouter({
        ...(redTeamEngine !== undefined ? { engine: redTeamEngine } : {}),
        ...(redTeamExecutorForRoute !== undefined
          ? { executor: redTeamExecutorForRoute }
          : {}),
        ...(inputGuardrail !== undefined ? { guardrail: inputGuardrail } : {}),
        operatorAuth,
        auditLog,
        toolAuthzLoader,
        flowRegistry,
      }),
    );
    logger.info(
      "Security API enabled at /security/* (red-team, tool-authz, mcp-tools)",
      {
        redTeam: redTeamEngine !== undefined,
      },
    );
  }
  if (vectorStore !== undefined && ragEmbedder !== undefined) {
    app.route("/", createRagRouter(vectorStore, ragEmbedder, logger));
    logger.info("RAG ingestion API enabled at /v1/rag/*");
  }
  if (memoryStore !== undefined) {
    app.route(
      "/",
      createMemoryRouter(memoryStore, jwtVerifier, operatorAuth),
    );
    logger.info("Long-term memory API enabled at /v1/memory/*");
  }
  if (assistantsResult !== undefined) {
    // Vectorsearch is optional. The session API stays available without it,
    // while hybrid search returns an explicit 503 rather than falling back to
    // an unscoped local scan.
    const vectorsearchConfigured = config.mcpServers.some((server) => server.name === "vectorsearch");
    const sessionIndex = vectorsearchConfigured
      ? new (await import("./assistants/session-index.js")).McpAssistantSessionIndex(mcpWrapper)
      : undefined;
    assistantsResult.runtime.setSessionIndex(sessionIndex);
    // Mounted on the `/v1` plane so it runs behind the same auth middleware as the
    // chat path: every route scopes itself to the AUTHENTICATED user, which only
    // works if the request has been authenticated.
    app.route(
      "/",
      createAssistantsRouter({
        runtime: assistantsResult.runtime,
        authorizationEnabled: config.authzEnabled ?? true,
        ...(assistantsResult.rocketChat !== undefined
          ? { rocketChat: assistantsResult.rocketChat }
          : {}),
        ...(sessionIndex !== undefined ? { sessionIndex } : {}),
        logger,
      }),
    );
    logger.info("Assistant management API enabled at /v1/assistants/*");

    // Rocket.Chat's webhook is mounted once, after the optional end-user OIDC
    // connect configuration has been resolved below. Mounting a legacy router
    // here as well would consume every matching request before the configured
    // connect router can create and return a self-service link.

    // The operator plane. Separate router because it authenticates differently:
    // an operator role that spans users, versus a user's own identity. It owns the
    // `constraints` soul write class, which no user-plane route can reach.
    const { createAssistantsAdminRouter } = await import(
      "./routes/assistants-admin.js"
    );
    app.route(
      "/",
      createAssistantsAdminRouter({
        runtime: assistantsResult.runtime,
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
        logger,
        auditLog,
      }),
    );
    logger.info("Assistant operator plane enabled at /admin/assistants/*");
  }

  // Compliance router (retention/RTBF + DSAR + compliance dossier) is mounted
  // further down, AFTER the compliance-policy loader and red-team engine are
  // constructed, so /admin/compliance/dossier can cite the active policy and
  // security posture. See the "Compliance Policy-as-Code" section below.

  // ── GitOps Webhook ────────────────────────────────────────────────────────
  if (config.gitopsEnabled === true) {
    const { createGitopsRouter } = await import("./routes/gitops.js");
    app.route(
      "/",
      createGitopsRouter({
        reloadFlows: async () => {
          // Restart the parser service to force a full rescan of FLOWS_DIR.
          // This picks up any new/modified/deleted flow files that arrived
          // via the git push without waiting for chokidar's file-watch debounce.
          await flowParserService.stop();
          await flowParserService.start();
          logger.info("[GitOps] Flow registry rescanned after git push");
        },
        auditLog,
        logger,
        requireSignature: config.gitopsRequireSignature ?? true,
        ...(config.gitopsWebhookSecret !== undefined
          ? { webhookSecret: config.gitopsWebhookSecret }
          : {}),
        ...(config.gitopsBranch !== undefined
          ? { triggerBranches: config.gitopsBranch }
          : {}),
      }),
    );
    logger.info("GitOps webhook endpoint enabled at POST /webhooks/git", {
      branches: config.gitopsBranch ?? "main,master",
      signatureVerification: config.gitopsWebhookSecret !== undefined,
    });
  }
  app.route(
    "/",
    createProviderKeysRouter({
      providerKeyPool,
      authRequired: config.monitoringAuthRequired,
      operatorAuth,
    }),
  );
  app.route(
    "/",
    createGuardrailsRouter({
      guardrailPolicy,
      authRequired: config.monitoringAuthRequired,
      operatorAuth,
    }),
  );
  {
    const { createPiiVaultRouter } = await import("./routes/pii-vault.js");
    app.route(
      "/",
      createPiiVaultRouter({
        enabled: piiVault !== undefined,
        durable: piiVaultStore !== undefined && database !== undefined,
        piiTypes: config.piiVaultTypes ?? [],
        ...(config.piiDetectors !== undefined
          ? { detectors: config.piiDetectors }
          : {}),
        multimodalMode: config.piiVaultMultimodalMode ?? "off",
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
      }),
    );
  }
  app.route(
    "/",
    createEvalRouter({
      store: createEvalCaseStore(),
      authRequired: config.monitoringAuthRequired,
      operatorAuth,
    }),
  );
  if (config.tenantManagementEnabled === true) {
    app.route(
      "/",
      createTenantsRouter({
        tenantStore,
        usageMeter,
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
        auditLog,
        ...(providerKeyStore !== undefined ? { providerKeyStore } : {}),
        ...(byokResolver !== undefined ? { byokResolver } : {}),
      }),
    );
    logger.info("Tenant management enabled at /admin/tenants/*");
  } else if (config.byokEnabled === true) {
    logger.warn(
      "BYOK_ENABLED is set but TENANT_MANAGEMENT_ENABLED is not — BYOK admin endpoints not mounted.",
    );
  }
  if (
    approvalGate !== undefined ||
    replayService !== undefined ||
    canaryManager.enabled
  ) {
    app.route(
      "/",
      createControlRouter({
        ...(approvalGate !== undefined ? { approvalGate } : {}),
        ...(replayService !== undefined ? { replayService } : {}),
        ...(canaryManager.enabled ? { canaryManager } : {}),
        authRequired: config.monitoringAuthRequired,
        approvalFrameAncestors:
          (config.approvalFrameAncestors?.length ?? 0) > 0
            ? config.approvalFrameAncestors
            : config.corsOrigins.filter((origin) => origin !== "*"),
        ...(config.oidcSessionSecret !== undefined
          ? { approvalLinkSecret: config.oidcSessionSecret }
          : {}),
        operatorAuth,
        auditLog,
      }),
    );
  }
  if (config.mcpServers.length > 0) {
    app.route(
      "/",
      createMcpRouter({
        mcpWrapper,
        knownToolIds,
        serverNames: new Set(config.mcpServers.map((s) => s.name)),
        serverConfigs: config.mcpServers,
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
        auditLog,
      }),
    );
  }
  if (flowOptimizer !== undefined) {
    const { createOptimizerRouter } = await import("./routes/optimizer.js");
    app.route(
      "/optimizer",
      createOptimizerRouter({
        optimizer: flowOptimizer,
        operatorAuth,
        auditLog,
        ...(traceAnalyzer !== undefined ? { traceAnalyzer } : {}),
        // Enables GET /optimizer/routing-advice (cost/quality model advice).
        flowRegistry,
        ...(config.defaultLlm !== undefined
          ? { defaultLlm: config.defaultLlm }
          : {}),
        ...(modelQuality !== undefined ? { modelQuality } : {}),
      }),
    );
  }

  // ── Compliance Policy-as-Code ─────────────────────────────────────────────
  // Always mount — the loader returns undefined when no policy file exists, and
  // the route responds gracefully. Hot-reload is wired via onComplianceChange.
  const { createCompliancePolicyLoader } = await import(
    "./compliance/policy-loader.js"
  );
  const { createCompliancePolicyRouter } = await import(
    "./routes/compliance-policy.js"
  );
  const compliancePolicyLoader = createCompliancePolicyLoader(
    config.flowsDir,
    logger,
  );
  compliancePolicyLoaderRef = compliancePolicyLoader;
  graphEngine.setCompliancePolicy?.(compliancePolicyLoader.policy);
  if (compliancePolicyLoader.hasPolicy) {
    logger.info(
      "Compliance policy loaded (compliance-policy.yaml) — policy enforcement active",
    );
    if (
      (compliancePolicyLoader.policy?.approvalRules?.length ?? 0) > 0 &&
      approvalGate === undefined
    ) {
      logger.warn(
        "compliance-policy.yaml declares approvalRules, but the human-in-the-loop " +
          "approval gate is not enabled (APPROVAL_GATE_ENABLED / APPROVAL_REQUIRE_TOOLS " +
          "not set) — these rules have no pause/notify/resolve mechanism to run on and " +
          "are NOT enforced. Enable the approval gate to activate them.",
      );
    }
  } else {
    logger.info(
      "No compliance-policy.yaml found — compliance enforcement inactive (create one in FLOWS_DIR to enable)",
    );
  }
  app.route(
    "/admin/compliance-policy",
    createCompliancePolicyRouter({
      policyLoader: compliancePolicyLoader,
      operatorAuth,
      auditLog,
    }),
  );
  logger.info("Compliance Policy API enabled at /admin/compliance-policy/*");

  // ── Compliance (retention/RTBF + DSAR + auto-generated dossier) ───────────
  // Mounted here (not earlier) so the dossier route can cite the just-loaded
  // compliance policy, and — when RED_TEAM_ENABLED — the security posture
  // engine constructed above. evalRunHistory has a durable home only when a
  // database is configured; otherwise it's a per-replica in-memory ring.
  // evalRunHistory has a durable home only when a database is configured;
  // otherwise it's a per-replica in-memory ring. Shared by the compliance
  // dossier (cites the latest run per dataset) and the /admin/eval/runs API
  // (lets CI or an operator record a completed eval run).
  const { createEvalRunHistory } = await import("./eval/eval-run-history.js");
  const evalRunHistory = createEvalRunHistory(database, logger);
  const { createEvalMatrixRunStore, EvalMatrixService } = await import(
    "./eval/eval-matrix.js"
  );
  const evalMatrix = new EvalMatrixService({
    store: createEvalMatrixRunStore(database, logger),
    graphEngine,
    flowRegistry,
    debugTraceStore,
    monitoring: monitoringService,
    logger,
    admit: async (flowId, context) => {
      await requireExecutionAdmission(executionAdmission, flowId, context);
    },
  });
  try {
    const recoveredEvalMatrices = await evalMatrix.recoverInterruptedRuns();
    if (recoveredEvalMatrices > 0) {
      logger.warn("Marked interrupted eval matrices as failed after runtime restart", {
        count: recoveredEvalMatrices,
      });
    }
  } catch (error) {
    // Recovery is best-effort maintenance. A permission/transient database
    // failure must not take the entire chat/runtime API into a restart loop;
    // matrix endpoints will surface the store problem as 503 until repaired.
    logger.warn("Eval matrix recovery skipped; runtime startup continues", {
      error: error instanceof Error ? error.message : String(error),
      degraded: "eval_matrix_recovery",
    });
  }
  const { createEvalRunsRouter } = await import("./routes/eval-runs.js");
  app.route(
    "/",
    createEvalRunsRouter({
      history: evalRunHistory,
      matrix: evalMatrix,
      authRequired: config.monitoringAuthRequired,
      operatorAuth,
      auditLog,
      logger,
    }),
  );
  logger.info("Eval run history API enabled at /admin/eval/runs");

  if (retentionService !== undefined) {
    app.route(
      "/",
      createComplianceRouter({
        retention: retentionService,
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
        auditLog,
        policyLoader: compliancePolicyLoader,
        evalRunHistory,
        ...(redTeamEngine !== undefined ? { redTeamEngine } : {}),
        ...(auditAnchor !== undefined ? { auditAnchor } : {}),
        flowRegistry,
        ...(config.piiRecallDataset !== undefined
          ? { piiRecallDatasetPath: config.piiRecallDataset }
          : {}),
        ...(config.providerRegions !== undefined
          ? { providerRegions: config.providerRegions }
          : {}),
        ...(config.localProviders !== undefined
          ? { localProviders: config.localProviders }
          : {}),
        piiVaultPosture: {
          enabled: piiVault !== undefined,
          durable: piiVaultStore !== undefined && database !== undefined,
          detectors: config.piiDetectors ?? [],
          piiTypes:
            config.piiVaultTypes !== undefined && config.piiVaultTypes.length > 0
              ? config.piiVaultTypes
              : "all",
          multimodalMode: config.piiVaultMultimodalMode ?? "off",
        },
      }),
    );
    logger.info("Compliance API enabled at /admin/compliance/* (incl. dossier)");
  }

  // ── Continuous Safety & Quality Autopilot ─────────────────────────────────
  // Wires RedTeamEngine + FlowOptimizer + CanaryManager into a closed loop.
  // Extracted to bootstrap/autopilot.ts (ADR-0004 style split) — see that
  // module for the canary registrar, judge-model resolution, the
  // red-team-run hook, the `/autopilot/*` router, and the health-signal
  // poller.
  const { buildAutopilot } = await import("./bootstrap/autopilot.js");
  await buildAutopilot({
    config,
    app,
    logger,
    auditLog,
    database,
    operatorAuth,
    monitoringService,
    modelQuality,
    canaryManager,
    redTeamEngine,
    flowOptimizer,
    flowStore,
  });

  // ── Optimizer Scheduler (autonomous periodic optimization) ────────────────
  let optimizerScheduler:
    | import("./graph/optimizer-scheduler.js").OptimizerScheduler
    | undefined;
  const optimizerScheduleFlows = config.optimizerScheduleFlows;
  const activeReplayStore = replayStore;
  if (
    flowOptimizer !== undefined &&
    config.optimizerScheduleEnabled === true &&
    optimizerScheduleFlows !== undefined &&
    optimizerScheduleFlows.length > 0 &&
    activeReplayStore !== undefined
  ) {
    const { createOptimizerScheduler } = await import(
      "./graph/optimizer-scheduler.js"
    );
    const intervalMs = config.optimizerScheduleIntervalMs ?? 86_400_000;
    optimizerScheduler = createOptimizerScheduler(
      {
        flows: optimizerScheduleFlows,
        intervalMs,
        minNewSamples: config.optimizerScheduleMinNewSamples ?? 50,
        cooldownMs: config.optimizerScheduleCooldownMs ?? intervalMs,
        autoPromote: config.optimizerScheduleAutoPromote ?? true,
        variantCount: config.optimizerScheduleVariantCount ?? 3,
        minScoreImprovement:
          config.optimizerScheduleMinScoreImprovement ?? 0.05,
        ...(config.optimizerScheduleGoal !== undefined
          ? { optimizationGoal: config.optimizerScheduleGoal }
          : {}),
      },
      {
        optimizer: flowOptimizer,
        // SnapshotCounter: count how many snapshots the ReplayStore holds for a flow.
        countSnapshots: async (flowId) => {
          const all = await activeReplayStore.list(10_000);
          return all.filter((s) => s.flowId === flowId).length;
        },
        logger,
        auditLog,
      },
    );
    const started = optimizerScheduler.start();
    if (started) {
      logger.info("Optimizer scheduler started", {
        flows: config.optimizerScheduleFlows,
        intervalMs,
        minNewSamples: config.optimizerScheduleMinNewSamples ?? 50,
        autoPromote: config.optimizerScheduleAutoPromote ?? true,
      });
    }
  }
  app.route(
    "/",
    createFlowsRouter({
      fileRegistry,
      logger,
      ...(flowStore !== undefined ? { store: flowStore } : {}),
      ...(dbFlowSource !== undefined ? { dbSource: dbFlowSource } : {}),
      ...(knownToolIds.size > 0 ? { knownToolIds } : {}),
      authRequired: config.monitoringAuthRequired,
      ...(abManager !== undefined ? { abManager } : {}),
      operatorAuth,
      auditLog,
      appConfig: config,
      getCompliancePolicy: () => compliancePolicyLoaderRef?.policy,
      ...(replayStore !== undefined
        ? {
            simulation: {
              mcpWrapper,
              ...(_engineResult.llmProviderFactory !== undefined
                ? { llmProviderFactory: _engineResult.llmProviderFactory }
                : {}),
              replayStore,
              flowAuthorizer,
              getCompliancePolicy: () => compliancePolicyLoaderRef?.policy,
            },
          }
        : {}),
    }),
  );
  app.route(
    "/",
    createMonitoringRouter(monitoringService, {
      authRequired: config.monitoringAuthRequired,
      operatorAuth,
      auditLog,
      ...(config.monitoringTicketSecret !== undefined
        ? {
            ticketSecret: config.monitoringTicketSecret,
            ticketTtlSeconds: config.monitoringTicketTtlSeconds ?? 60,
          }
        : {}),
    }),
  );
  app.route(
    "/",
    createDebugRouter({
      debugStore: debugTraceStore,
      authRequired: config.monitoringAuthRequired,
      operatorAuth,
    }),
  );
  {
    const { createExplainRouter } = await import("./routes/explain.js");
    // Evidence-bundle signing reuses the audit-anchor secret when no
    // dedicated one is set — see routes/explain.ts's doc comment on why a
    // deployment that already anchors its audit chain should not need a
    // second secret just to sign evidence bundles.
    const evidenceBundleSecret =
      config.evidenceBundleSecret ?? config.auditAnchorSecret;
    app.route(
      "/",
      createExplainRouter({
        history: {
          listRecent: (limit) => monitoringService.getHistory(limit),
          listEvents: (executionId) =>
            monitoringService.getExecutionEvents(executionId),
        },
        debugTraceStore,
        ...(piiVault !== undefined ? { piiVault } : {}),
        auditLog,
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
        ...(auditAnchor !== undefined ? { auditAnchor } : {}),
        ...(evidenceBundleSecret !== undefined ? { evidenceBundleSecret } : {}),
      }),
    );
    logger.info(
      "Decision-Provenance Explainability Card enabled at GET /monitoring/explain/:executionId",
    );
    if (evidenceBundleSecret !== undefined) {
      logger.info(
        "Verifiable Evidence Bundle enabled at GET /monitoring/explain/:executionId/bundle",
      );
    }
  }
  if (config.metricsEnabled ?? true) {
    app.route(
      "/",
      createMetricsRouter(metrics, {
        metricsAuthRequired: metricsAuthRequiredFlag,
        monitoringAuthRequired: config.monitoringAuthRequired,
        costTracker: budgetService,
        usageAnalytics,
        operatorAuth,
        metricsOperatorAuth,
      }),
    );
  }
  app.route(
    "/",
    createLimitsRouter({
      service: tokenLimitService,
      store: tokenLimitStore,
      analytics: usageAnalytics,
      operatorAuth,
      auditLog,
    }),
  );

  // OIDC BFF login for operator plane
  if (
    config.oidcIssuer !== undefined &&
    config.oidcClientId !== undefined &&
    config.oidcClientSecret !== undefined &&
    config.oidcSessionSecret !== undefined
  ) {
    app.route(
      "/",
      createOidcAuthRouter({
        config: {
          issuer: config.oidcIssuer,
          clientId: config.oidcClientId,
          clientSecret: config.oidcClientSecret,
          sessionSecret: config.oidcSessionSecret,
          sessionTtlSeconds: config.oidcSessionTtlSeconds ?? 3600,
          // Was previously omitted, so OIDC_REFRESH_SESSION_TTL_SECONDS was
          // loaded from the environment and then silently dropped — every
          // deployment ran on the 30-day default no matter what it configured.
          ...(config.oidcRefreshSessionTtlSeconds !== undefined
            ? {
                refreshSessionTtlSeconds: config.oidcRefreshSessionTtlSeconds,
              }
            : {}),
          scopes: config.oidcScopes ?? "openid profile email",
          autoLogin: config.oidcAutoLogin ?? false,
          ...(config.oidcAudience !== undefined
            ? { audience: config.oidcAudience }
            : {}),
          ...(config.oidcRedirectUri !== undefined
            ? { redirectUri: config.oidcRedirectUri }
            : {}),
          ...(config.oidcDashboardUrl !== undefined
            ? { dashboardUrl: config.oidcDashboardUrl }
            : {}),
          roleClaim: config.operatorRoleClaim ?? "role",
          ...(config.operatorGroupsClaim !== undefined
            ? { groupsClaim: config.operatorGroupsClaim }
            : {}),
          ...(config.operatorRoleMap !== undefined
            ? { roleMap: config.operatorRoleMap }
            : {}),
          ...(config.operatorDefaultRole !== undefined
            ? { defaultRole: config.operatorDefaultRole }
            : {}),
        },
        sessionStore: createOidcSessionStore(config.redisUrl, logger),
        logger,
      }),
    );
    logger.info("OIDC operator login (BFF) enabled at /monitoring/auth/*", {
      issuer: config.oidcIssuer,
      autoLogin: config.oidcAutoLogin ?? false,
    });
  } else {
    // The dashboard must know that an intentionally open operator plane does
    // not require a synthetic browser token. Keep this endpoint available even
    // when the optional OIDC router is not mounted.
    app.get("/monitoring/auth/config", (ctx) =>
      ctx.json({
        enabled: false,
        autoLogin: false,
        required: config.monitoringAuthRequired || operatorAuth.rbacEnabled,
      }),
    );
  }

  // Rocket.Chat inbound webhook and separate end-user connect-link OIDC flow.
  // These deliberately do not share the operator OIDC session.
  if (assistantsResult?.rocketChat !== undefined) {
    const connectIssuer = process.env.ROCKETCHAT_CONNECT_OIDC_ISSUER;
    const connectClientId = process.env.ROCKETCHAT_CONNECT_OIDC_CLIENT_ID;
    const connectClientSecret = process.env.ROCKETCHAT_CONNECT_OIDC_CLIENT_SECRET;
    const delegationClientSecret = config.assistantDelegationClientSecret;
    const connectSessionSecret = process.env.ROCKETCHAT_CONNECT_SESSION_SECRET;
    const connectPublicUrl = process.env.ROCKETCHAT_CONNECT_PUBLIC_URL;
    const delegation = assistantsResult.rocketChatDelegation;
    const sameIssuer =
      connectIssuer !== undefined &&
      delegation !== undefined &&
      connectIssuer.replace(/\/$/, "") === delegation.issuer.replace(/\/$/, "");
    const sameClient =
      connectClientId !== undefined &&
      delegation !== undefined &&
      connectClientId === delegation.clientId;
    const sameClientSecret =
      connectClientSecret !== undefined &&
      delegationClientSecret !== undefined &&
      connectClientSecret === delegationClientSecret;
    const connectReady =
      database !== undefined &&
      connectIssuer !== undefined &&
      connectClientId !== undefined &&
      connectClientSecret !== undefined &&
      connectSessionSecret !== undefined &&
      connectPublicUrl !== undefined &&
      delegation !== undefined &&
      sameIssuer &&
      sameClient &&
      sameClientSecret;
    app.route(
      "/",
      createRocketChatRouter({
        channel: assistantsResult.rocketChat,
        ...(connectReady
          ? {
              connect: {
                db: database as NonNullable<typeof database>,
                publicUrl: connectPublicUrl as string,
                requestTtlSeconds: Number(
                  process.env.ROCKETCHAT_CONNECT_REQUEST_TTL_SECONDS ?? "900",
                ),
              },
            }
          : {}),
        logger,
      }),
    );
    if (connectReady && delegation !== undefined) {
      app.route(
        "/",
        createRocketChatConnectRouter({
          db: database as NonNullable<typeof database>,
          channel: assistantsResult.rocketChat,
          runtime: assistantsResult.runtime,
          delegation,
          logger,
          config: {
            issuer: connectIssuer as string,
            clientId: connectClientId as string,
            clientSecret: delegationClientSecret as string,
            sessionSecret: connectSessionSecret as string,
            publicUrl: connectPublicUrl as string,
            defaultFlowId:
              process.env.ROCKETCHAT_CONNECT_DEFAULT_FLOW_ID ?? "assistant",
            scopes: config.rocketChatConnectOidcScopes,
            tenantId: process.env.ROCKETCHAT_CONNECT_TENANT_ID,
          },
        }),
      );
      logger.info(
        "Rocket.Chat self-service connect flow enabled at /connect/rocketchat/*",
      );
    } else {
      logger.warn(
        "Rocket.Chat legacy webhook enabled; self-service connect requires an encrypted delegation bridge and identical connect/delegation OIDC issuer, client and secret",
        {
          sameIssuer,
          sameClient,
          sameClientSecret,
          delegation: delegation !== undefined,
        },
      );
    }
  }

  // Cost/quality SLO reporting route
  {
    const { createSloRouter } = await import("./routes/slo.js");
    app.route(
      "/",
      createSloRouter({
        registry: sloRegistry,
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
      }),
    );
    logger.info("SLO reporting enabled at GET /monitoring/slo");
  }

  // FinOps forecasting + CO2/ESG accounting route
  {
    const { createFinopsRouter } = await import("./routes/finops.js");
    app.route(
      "/",
      createFinopsRouter({
        budgetService,
        metrics,
        ...(config.co2GridCarbonIntensity !== undefined
          ? { co2GridCarbonIntensity: config.co2GridCarbonIntensity }
          : {}),
        ...(config.co2EnergyFactors !== undefined
          ? { co2EnergyFactors: config.co2EnergyFactors }
          : {}),
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
      }),
    );
    logger.info(
      "FinOps forecasting + CO2/ESG accounting enabled at /admin/finops/*",
    );
  }

  // Shadow mode monitoring route
  const { createShadowRouter } = await import("./routes/shadow.js");
  app.route(
    "/",
    createShadowRouter({
      shadowService: shadowModeService,
      authRequired: config.monitoringAuthRequired,
      operatorAuth,
    }),
  );

  // ── Webhook + Schedule Triggers ──────────────────────────────────────────
  // The triggers route enables external systems to fire flows via signed HTTP
  // POST. The scheduler starts any `trigger` nodes configured with mode=schedule.
  const { createTriggersRouter } = await import("./routes/triggers.js");
  app.route(
    "/",
    createTriggersRouter({
      flowRegistry,
      graphEngine,
      monitoring: monitoringService,
      requireSignature: config.triggersRequireSignature ?? true,
      authorizationEnabled: config.authzEnabled ?? true,
      flowScopeClaims: config.flowScopeClaims,
      admission: executionAdmission,
    }),
  );
  logger.info("Webhook trigger route enabled at /triggers/:flowId");

  const { createTriggerScheduler } = await import("./graph/trigger-scheduler.js");
  const triggerScheduler = createTriggerScheduler(
    flowRegistry,
    graphEngine,
    monitoringService,
    logger,
    // Supplies credentials for scheduled runs. Without it the scheduler passes a
    // non-credential placeholder and every protected tool call in a fired flow is
    // refused — invisibly, until someone schedules a flow that touches one.
    {
      jwtVerifier,
      flowScopeClaims: config.flowScopeClaims,
      admission: executionAdmission,
      ...(assistantsResult !== undefined
        ? { resolveAuthority: assistantsResult.resolveScheduledAuthority }
        : {}),
    },
  );
  triggerScheduler.start();
  triggerSchedulerRef = triggerScheduler;

  // 14. HTTP Server
  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
    idleTimeout: 0,
  });
  logger.info("Server listening", {
    port: config.port,
    monitoringTransport: config.monitoringTransport,
    flows: flowRegistry.list().map((f) => f.id),
    jwtVerification: jwtVerifier.enabled,
    cors: config.corsOrigins,
    persistence: database !== undefined ? "postgres" : "in-memory",
  });

  // 15. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Shutting down", { signal });
    for (const fn of [
      () => flowParserService.stop(),
      () => {
        budgetService.stop();
      },
      () => {
        retentionService?.stop();
      },
      () => {
        auditAnchor?.stop();
      },
      () => {
        dbFlowSource?.stop();
      },
      () => {
        redTeamScheduler?.stop();
      },
      () => {
        optimizerScheduler?.stop();
      },
      () => {
        triggerScheduler.stop();
      },
      () => {
        // Clears pending learning-pass timers and the delegated-token cache. Before
        // the database closes: the scheduler could otherwise fire a pass that queries
        // a closed connection.
        assistantsResult?.shutdown();
      },
      () => pubsub?.close(),
      // Flush any batched-but-not-yet-written node_events rows BEFORE closing
      // the database connection, so a shutdown during an open batch window
      // does not silently drop the tail of the audit trail.
      () => executionStore?.flush?.(),
      () => database?.close(),
      () => tracer.shutdown(),
    ]) {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    }
    server.stop(true);
    logger.info("Shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}
