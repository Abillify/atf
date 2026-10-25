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
 */

import { getFlowLoadFailures } from "./graph/flow-parser/validate.js";
import { loadConfig, checkCompliancePolicyRequirement, checkProductionReadiness } from "./config/index.js";
import { buildOperatorAuthentication } from "./bootstrap/operator-auth.js";
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
  createRedisPubSub,
} from "./monitoring/monitoring-service.js";
import { createLogger } from "./observability/logger.js";
import { createMetrics } from "./observability/metrics.js";
import { createTracer } from "./observability/tracing.js";
import {
  createDbFlowSource,
  createCompositeRegistry,
  createVersionedRegistry,
  findShadowedFlowIds,
  materializeStoredFlow,
} from "./graph/flow-registry-composite.js";
import { createStudioTestRegistry } from "./graph/flow-registry-studio.js";
import { createAbManager, type AbManager } from "./graph/flow-ab.js";
import { createToolAuthzLoader } from "./graph/tool-authz-loader.js";
import { createFlowMcpServer } from "./mcp/flow-mcp-server.js";
import { initRuntimeEgress } from "./security/egress.js";
// ── Bootstrap modules ─────────────────────────────────────────────────────
import { buildPersistence } from "./bootstrap/persistence.js";
import { withPiiVault } from "./graph/pii-vault-engine.js";
import { withDecisionReceipts } from "./receipts/receipts-engine-decorator.js";
import { InMemoryReceiptStore } from "./receipts/receipt-store.js";
import { parseReceiptSigningKey } from "./receipts/signing-key.js";
import { InMemoryTransparencyLog } from "./receipts/transparency-log.js";
import { PostgresReceiptLogSink } from "./receipts/receipt-log-sink.js";
import { createTreeHeadSealer } from "./receipts/tree-head-sealer.js";
import { buildObservability } from "./bootstrap/observability.js";
import { buildCache } from "./bootstrap/cache.js";
import { buildMcp } from "./bootstrap/mcp.js";
import { buildGuardrails } from "./bootstrap/guardrails.js";
import { buildEngine } from "./bootstrap/engine.js";
import { buildAssistants } from "./bootstrap/assistants.js";
import { registerAssistantRunDispatcher } from "./bootstrap/assistant-run-dispatch.js";
import { buildRedTeam } from "./bootstrap/red-team.js";
import { createHttpMiddleware } from "./bootstrap/http-middleware.js";
import { registerInferenceRoutes } from "./bootstrap/routes-inference.js";
import { registerManagementRoutes } from "./bootstrap/routes-management.js";
import {
  buildOpenApiSpec,
  buildOpenApiYaml,
  resolveOpenApiServerUrl,
} from "./openapi.js";
import { ensureBunGlobals } from "./bun-globals.js";
import { createLlmProvider } from "./graph/llm-factory.js";
import { setDefaultCharsPerToken } from "./graph/context-window.js";
import { ExecutionAdmissionService } from "./graph/execution-admission.js";

if (import.meta.main) {
  // 0. Bun globals (SQL / RedisClient on globalThis).
  ensureBunGlobals();

  // 1. Config
  const config = loadConfig();
  // Seed the coarse token estimator with the configured chars-per-token ratio
  // (per-model `charsPerToken` still overrides this default per node).
  setDefaultCharsPerToken(config.charsPerToken ?? 4);

  // 1b. Egress_Guard (Req 7.1, 7.2): every outbound HTTP call goes through
  // this guard. Private/loopback targets need an explicit host exception in
  // EGRESS_ALLOW_PRIVATE_HOSTS; loopback exceptions only apply in development.
  initRuntimeEgress({
    allowedPrivateHosts: config.egressAllowPrivateHosts ?? [],
    allowedHosts: config.egressAllowedHosts ?? [],
    maxResponseBytes: config.egressMaxResponseBytes,
    timeoutMs: config.egressTimeoutMs,
    allowLoopback: (config.appEnv ?? "development") !== "production",
  });

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
        "Fix the issues above or set ATF_PROFILE=development (or APP_ENV=development).",
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
        "Fix the issues above or set ATF_PROFILE=development (or APP_ENV=development).",
    );
    process.exit(1);
  }

  // 5. Cache (embedder must be ready before guardrails + engine)
  // Metrics are created up front (before the cache) because the memory
  // extractor built there reports its fail-open degradations through them
  // (Req 7.8); buildObservability below receives this same instance.
  const metrics = createMetrics(config.metricsEnabled ?? true);
  // Flow files that fail to load are a gauge, not just a line on stderr.
  metrics.setFlowLoadFailureProbe?.(() => getFlowLoadFailures().length);
  const cacheResult = await buildCache(
    config,
    logger,
    database,
    storeFactory,
    metrics,
  );
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
    semanticCache,
    metrics,
  });
  const {
    budgetService,
    spendRecorder,
    tokenLimitService,
    tokenLimitEnforcer,
    tokenLimitStore,
    usageAnalytics,
    auditLog,
    retentionService,
    auditAnchor,
    evidenceKey,
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
      flowLookup: (flowId: string) =>
        guardrailPolicy.resolve(flowId)?.detectors,
      flowTypesLookup: (flowId: string) =>
        guardrailPolicy.resolve(flowId)?.piiTypes,
      generation: () => guardrailPolicy.generation(),
    });
    piiVault.setDetectorResolver(detectorResolver);
    piiVault.setMetrics(metrics);
    logger.info(
      "PII detector resolver wired (per-flow detector selection active)",
      {
        globalDetectors: config.piiDetectors ?? ["regex (legacy sync)"],
      },
    );
  }

  const toolAuthzLoader = createToolAuthzLoader(config.flowsDir, logger, {
    failClosed: config.toolAuthzFailClosed === true,
    // Req 7.7: a failed policy reload increments aiperator_policy_stale_total
    // and flips the loader's policyStale flag (surfaced in /health/ready).
    metrics,
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
    dbFlowSource = createDbFlowSource(flowStoreForAb, logger, config.flowsDir);
    await dbFlowSource.refresh();
    dbFlowSource.startPolling(10_000);
    flowRegistry = createCompositeRegistry(fileRegistry, dbFlowSource);
    // A DB-published flow overrides a same-id file flow — a git push to that
    // file has no runtime effect. Name the shadowed flows at startup so the
    // override is visible in the logs, not just in the Studio (ADR 0034).
    const shadowedFlowIds = findShadowedFlowIds(fileRegistry, dbFlowSource);
    if (shadowedFlowIds.length > 0) {
      logger.warn(
        "Online (DB) flows override same-id file flows — git changes to these files have no runtime effect until the online flow is deleted",
        { flows: shadowedFlowIds, count: shadowedFlowIds.length },
      );
    }

    abManager = createAbManager(
      config.flowsDir,
      async (flow, version) => {
        const versions = await flowStoreForAb.listVersions(flow);
        const def = versions.find((v) => v.version === version)?.definition;
        return def !== undefined
          ? materializeStoredFlow(def, config.flowsDir, logger)
          : undefined;
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
  // Outermost layer: throwaway definitions registered by the Studio's
  // "Run & Trace" so it executes the canvas, not the live version.
  const studioTests = createStudioTestRegistry(flowRegistry);
  flowRegistry = studioTests;

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
    const { createLearningPassRunner } =
      await import("./assistants/learning-pass.js");
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
    const { createRemoteImageRedactor, createLlmImageDescriber } =
      await import("./graph/pii-image-scanner.js");
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
    } else if (
      piiMultimodalMode === "describe" &&
      imageDescriber === undefined
    ) {
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

  // Decision_Receipts (Req 15): the receipt decorator wraps the RAW engine
  // (INSIDE the PII vault), so it reads the sealed Debug_Trace while the
  // vault's per-execution action summary is still readable and the trace
  // content already carries vault placeholders instead of raw PII.
  if (
    config.decisionReceiptsEnabled === true &&
    config.receiptSigningKey === undefined
  ) {
    throw new Error(
      "DECISION_RECEIPTS_ENABLED=true requires RECEIPT_SIGNING_KEY (Ed25519 PEM or base64 32-byte seed)",
    );
  }
  const receiptStore = new InMemoryReceiptStore();
  // RFC-6962 transparency log (Req 15.3): the in-memory tree answers
  // inclusion proofs; with a database the Postgres sink mirrors every append
  // and sealed tree head into the append-only `receipt_log` tables.
  const receiptSigningKey =
    config.decisionReceiptsEnabled === true &&
    config.receiptSigningKey !== undefined
      ? await parseReceiptSigningKey(config.receiptSigningKey)
      : undefined;
  const transparencyLog =
    receiptSigningKey !== undefined
      ? new InMemoryTransparencyLog(
          receiptSigningKey.privateKey,
          receiptSigningKey.kid,
          ...(database !== undefined
            ? [new PostgresReceiptLogSink(database)]
            : []),
        )
      : undefined;
  // Continue the durable log after a restart instead of starting a new tree
  // at position 0 (Req 15.3); a no-op without a database.
  if (transparencyLog !== undefined && database !== undefined) {
    const hydrated = await transparencyLog.hydrate();
    logger.info("Decision-receipt transparency log hydrated", {
      entries: hydrated,
    });
  }
  // Periodic signed tree heads (Req 15.3): sealed on the audit-anchor
  // interval while audit anchoring is active; persisted in receipt_tree_heads.
  const treeHeadSealer =
    transparencyLog !== undefined && auditAnchor !== undefined
      ? createTreeHeadSealer(
          transparencyLog,
          config.auditAnchorIntervalMs ?? 6 * 60 * 60_000,
          logger.child({ component: "decision-receipts" }),
        )
      : undefined;
  treeHeadSealer?.start();
  const receiptEngine =
    receiptSigningKey !== undefined
      ? withDecisionReceipts(rawGraphEngine, {
          debugTraceStore,
          receiptStore,
          signingKey: receiptSigningKey,
          logger: logger.child({ component: "decision-receipts" }),
          getToolAuthzHash: () => toolAuthzLoader.engine.policyHash(),
          getCompliancePolicy: () => compliancePolicyLoaderRef?.policy,
          getFlowDefinition: (id) => flowRegistry.get(id),
          ...(piiVault !== undefined ? { vault: piiVault } : {}),
          ...(approvalGate !== undefined ? { approvalGate } : {}),
          transparencyLog,
        })
      : rawGraphEngine;

  const graphEngine =
    piiVault !== undefined
      ? withPiiVault(receiptEngine, piiVault, piiMultimodalOptions)
      : receiptEngine;

  // Durable assistant work uses the same public engine entry point as triggers.
  // Bootstrap is built before the engine, so this deliberately closes that cycle
  // only after the final (PII-decorated) engine exists.
  if (assistantsResult !== undefined) {
    registerAssistantRunDispatcher({
      assistantsResult,
      graphEngine,
      monitoringService,
      jwtVerifier,
      getExecutionAdmission: () => executionAdmission,
      logger,
    });
  }

  // Wire tool authorization policy engine (hot-reload).
  graphEngine.setToolAuthzEngine?.(toolAuthzLoader.engine);

  // ── Shadow Mode — Continuous Quality Monitoring ────────────────────────────
  // Lazy-load shadow config (shadow.yaml / shadow.json in flows dir), build the
  // service with the canary judge (reused — same model, already configured), and
  // store the ref for hot-reload wiring above.
  const {
    parseFlowFile: _parseFlowFileFn,
    resolveConfigFile: _resolveConfigFileFn,
  } = await import("./util/parse-flow-file.js");
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
    compliancePolicyLoader: {
      get policy() {
        return compliancePolicyLoaderRef?.policy;
      },
      get enforcementBlocked() {
        return compliancePolicyLoaderRef?.enforcementBlocked ?? false;
      },
    },
    providerRegions: config.providerRegions,
    failClosedUnknownRegion:
      config.complianceFailClosedUnknownRegion ??
      config.appEnv === "production",
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
    ...(config.aiDisclosure !== undefined ? { aiDisclosure: config.aiDisclosure } : {}),
    logger,
  });
  flowMcpServerRef = flowMcpServer;

  // ── Red-Team / AI Security Posture ───────────────────────────────────────────
  const {
    engine: redTeamEngine,
    scheduler: redTeamScheduler,
    executor: redTeamExecutorShared,
  } = await buildRedTeam({
    config,
    logger,
    graphEngine,
    inputGuardrail,
    replayStore,
    executionAdmission,
  });

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

  // 13. Hono app + middleware stack (CORS, security headers, CSRF, request
  // logging/tracing, body limit, rate limits, auth) — see bootstrap/http-middleware.ts.
  const { app, apiKeyResolver, rateLimitStore } = createHttpMiddleware({
    config,
    logger,
    tracer,
    metrics,
    storeFactory,
    jwtVerifier,
    tenantStore,
  });

  // OpenAPI documents — unauthenticated (auth middleware only guards /v1/*),
  // so tooling (Swagger UI, codegen, compat checks) can fetch them without a
  // credential. The inventory is parsed from the real router tree at request
  // time, so the document cannot drift from the mounted routes.
  app.get("/openapi.json", (c) =>
    c.json(buildOpenApiSpec(resolveOpenApiServerUrl(c.req.url))),
  );
  app.get("/openapi.yaml", (c) =>
    c.text(buildOpenApiYaml(resolveOpenApiServerUrl(c.req.url)), 200, {
      "Content-Type": "text/yaml; charset=utf-8",
    }),
  );

  // ── Routes ─────────────────────────────────────────────────────────────────
  // All HTTP routers are registered by two focused bootstrap modules, mounted
  // in the original single-file order: inference plane first, management
  // plane second (see bootstrap/routes-inference.ts / routes-management.ts).
  await registerInferenceRoutes({
    app,
    config,
    logger,
    flowRegistry,
    database,
    analysisArtifactStore,
    auditLog,
    toolAuthzLoader,
    jwtVerifier,
    flowAuthorizer,
    assistantsResult,
    mediaStore,
    jobStore,
    executionAdmission,
    budgetService,
    metrics,
    tokenLimitEnforcer,
    canaryManager,
    replayService,
    canaryJudge,
    modelQuality,
    sloRegistry,
    byokResolver,
    idempotencyStore,
    inputGuardrail,
    inputGuardrailClassify,
    guardrailPolicy,
    flowGuardrailResolver,
    memoryStore,
    memoryExtractor,
    abManager,
    shadowModeService,
    graphEngine,
    monitoringService,
    flowDispatcher,
    getCompliancePolicy: () => compliancePolicyLoaderRef?.policy,
    isCompliancePolicyBlocked: () =>
      compliancePolicyLoaderRef?.enforcementBlocked ?? false,
    // Decision_Receipts (Req 15.4): receipt lookup, inclusion proofs, JWKS.
    ...(receiptSigningKey !== undefined
      ? {
          receiptStore,
          ...(transparencyLog !== undefined ? { transparencyLog } : {}),
          receiptSigningKey,
        }
      : {}),
    // Evidence-chain JWKS (ADR 0030).
    ...(evidenceKey !== undefined ? { evidenceKey } : {}),
  });
  const { optimizerScheduler, triggerScheduler } =
    await registerManagementRoutes({
      app,
      config,
      logger,
      auditLog,
      database,
      flowRegistry,
      fileRegistry,
      studioTests,
      graphEngine,
      monitoringService,
      jwtVerifier,
      apiKeyResolver,
      rateLimitStore,
      operatorAuth,
      metricsOperatorAuth,
      metricsAuthRequiredFlag,
      toolAuthzLoader,
      flowAuthorizer,
      flowMcpServer,
      redTeamEngine,
      redTeamExecutorShared,
      inputGuardrail,
      vectorStore,
      ragEmbedder,
      memoryStore,
      assistantsResult,
      mcpWrapper,
      knownToolIds,
      flowParserService,
      providerKeyPool,
      providerCircuitBreaker: _engineResult.providerCircuitBreaker,
      llmProviderFactory: _engineResult.llmProviderFactory,
      piiVault,
      piiVaultStore,
      guardrailPolicy,
      tenantStore,
      usageMeter,
      providerKeyStore,
      byokResolver,
      approvalGate,
      replayService,
      replayStore,
      canaryManager,
      flowOptimizer,
      traceAnalyzer,
      debugTraceStore,
      executionAdmission,
      modelQuality,
      getCompliancePolicy: () => compliancePolicyLoaderRef?.policy,
      onCompliancePolicyLoader: (loader) => {
        compliancePolicyLoaderRef = loader;
      },
      retentionService,
      auditAnchor,
      ...(evidenceKey !== undefined ? { evidenceKey } : {}),
      budgetService,
      metrics,
      usageAnalytics,
      tokenLimitService,
      tokenLimitStore,
      sloRegistry,
      shadowModeService,
      abManager,
      flowStore,
      dbFlowSource,
    });
  triggerSchedulerRef = triggerScheduler;

  // COMPLIANCE_POLICY_REQUIRED: residency and data-class rules only exist when
  // compliance-policy.yaml loaded. Production without one refuses to start;
  // elsewhere it is a warning, so the same configuration surfaces the gap early.
  const complianceReadiness = checkCompliancePolicyRequirement(
    config,
    compliancePolicyLoaderRef?.policy !== undefined,
  );
  for (const w of complianceReadiness.warnings) logger.warn(`Readiness warning: ${w}`);
  if (complianceReadiness.fatal.length > 0) {
    for (const f of complianceReadiness.fatal) logger.error(`Readiness failure: ${f}`);
    process.exit(1);
  }
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
        treeHeadSealer?.stop();
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
      // Req 1.6 (platform-hardening): drain the audit write queue BEFORE the
      // database closes. Best-effort `record()` entries are persisted in order;
      // if the queue has not settled within the grace period, the still
      // unpersisted count is reported through the write-failure metric and an
      // error log — never dropped silently without a trace.
      async () => {
        const flush = auditLog.flush?.();
        if (flush === undefined) return;
        const graceMs = 5_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          flush.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), graceMs);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (timedOut) {
          const pending = auditLog.pendingWrites?.() ?? 0;
          if (pending > 0) {
            metrics.recordCounter(
              "aiperator_audit_write_failures_total",
              {},
              pending,
            );
          }
          logger.error(
            "Audit write queue did not drain before shutdown grace expired",
            { graceMs, pending },
          );
        }
      },
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
