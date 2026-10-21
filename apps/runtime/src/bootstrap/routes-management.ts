// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Management-plane HTTP routes (`src/bootstrap/routes-management.ts`)
 *
 * Extracted verbatim from `index.ts` (Req 13.6 composition-root split): the
 * Flow-as-MCP-Server mount, red-team security API, RAG/memory, assistants
 * (user + operator planes + Rocket.Chat), GitOps webhook, provider/guardrail/
 * PII-vault/eval/tenant/control/MCP/optimizer admin APIs, the compliance
 * Policy-as-Code loader + routers, eval-run history/matrix, the DSAR
 * compliance router, the Autopilot wiring, the optimizer scheduler, flows/
 * monitoring/debug/explain/metrics/limits, the operator OIDC BFF, SLO/FinOps/
 * shadow routes, and the webhook-trigger router + scheduler.
 *
 * Mounted after the inference plane so route precedence matches the original
 * single-file order. The compliance-policy loader is created here and handed
 * back through `onCompliancePolicyLoader` so the composition root keeps its
 * lazy reference (hot-reload + admission proxies); the optimizer and trigger
 * schedulers are returned for graceful shutdown.
 *
 * No `any` at module boundaries.
 */

import type { Hono as HonoApp } from "hono";
import type { CanaryManager } from "../graph/canary.js";
import { createErasureOrchestrator } from "../compliance/erasure-orchestrator.js";
import type { CompliancePolicyLoader } from "../compliance/policy-loader.js";
import type { CompliancePolicy } from "../compliance/policy-schema.js";
import {
  ed25519ReceiptKey,
  hmacReceiptKey,
} from "../compliance/erasure-receipt.js";
import type { AppConfig } from "../config/index.js";
import { createEvalCaseStore } from "../eval/eval-case-store.js";
import type { ExecutionAdmissionService } from "../graph/execution-admission.js";
import { requireExecutionAdmission } from "../graph/execution-admission.js";
import type { AbManager } from "../graph/flow-ab.js";
import type { FlowAuthorizer } from "../graph/flow-authorizer.js";
import type { createFlowParserService } from "../graph/flow-parser.js";
import type { FlowRegistry } from "../graph/flow-parser/loader.js";
import { findShadowedFlowIds } from "../graph/flow-registry-composite.js";
import type { DbFlowSource } from "../graph/flow-registry-composite.js";
import type { StudioTestRegistry } from "../graph/flow-registry-studio.js";
import type { GuardrailPolicyService } from "../graph/guardrail-policy.js";
import type { GraphEngineService } from "../graph/graph-engine.js";
import type { OptimizerScheduler } from "../graph/optimizer-scheduler.js";
import type { SloRegistry } from "../graph/slo.js";
import type { ShadowModeService } from "../graph/shadow-mode.js";
import type { ToolAuthzLoader } from "../graph/tool-authz-loader.js";
import type { TriggerScheduler } from "../graph/trigger-scheduler.js";
import type { FlowMcpServer } from "../mcp/flow-mcp-server.js";
import {
  authMiddleware,
  type ApiKeyResolver,
  type AuthContext,
} from "../middleware/auth.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import type { OperatorAuthorizer } from "../middleware/operator-rbac.js";
import { createMonitoringRouter } from "../monitoring/monitoring-service.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import type {
  RedTeamEngine,
  RedTeamExecutor,
} from "../security/red-team-engine.js";
import { createAssistantsRouter } from "../routes/assistants.js";
import { createOidcAuthRouter } from "../routes/auth-oidc.js";
import { createComplianceRouter } from "../routes/compliance.js";
import { createControlRouter } from "../routes/control.js";
import { createDebugRouter } from "../routes/debug.js";
import { createEvalRouter } from "../routes/eval.js";
import { createFlowMcpRouter } from "../routes/flow-mcp.js";
import { createFlowsRouter } from "../routes/flows.js";
import { createGuardrailsRouter } from "../routes/guardrails.js";
import { createLimitsRouter } from "../routes/limits.js";
import { createMcpRouter } from "../routes/mcp.js";
import { createMemoryRouter } from "../routes/memory.js";
import { createMetricsRouter } from "../routes/metrics.js";
import { createOidcSessionStore } from "../routes/oidc-session-store.js";
import { createProviderKeysRouter } from "../routes/provider-keys.js";
import { createProviderMonitoringRouter } from "../routes/provider-monitoring.js";
import { createProviderTestingRouter } from "../routes/provider-testing.js";
import { createRagRouter } from "../routes/rag.js";
import { createRedTeamRouter } from "../routes/red-team.js";
import { createRocketChatRouter } from "../routes/rocketchat.js";
import { createRocketChatConnectRouter } from "../routes/rocketchat-connect.js";
import { createTenantsRouter } from "../routes/tenants.js";
import type { AssistantsResult } from "./assistants.js";
import type { CacheResult } from "./cache.js";
import type { EngineResult } from "./engine.js";
import type { GuardrailsResult } from "./guardrails.js";
import type { McpResult } from "./mcp.js";
import type { ObservabilityResult } from "./observability.js";
import type { PersistenceResult } from "./persistence.js";
import type { RateLimitStore } from "../middleware/rate-limit.js";

type FlowParserService = ReturnType<typeof createFlowParserService>;

export interface ManagementRouteDeps {
  app: HonoApp<AuthContext>;
  config: AppConfig;
  logger: Logger;
  auditLog: ObservabilityResult["auditLog"];
  database: PersistenceResult["database"];
  flowRegistry: FlowRegistry;
  fileRegistry: FlowRegistry;
  studioTests: StudioTestRegistry;
  graphEngine: GraphEngineService;
  monitoringService: MonitoringServiceInterface;
  jwtVerifier: JwtVerifier;
  apiKeyResolver: ApiKeyResolver | undefined;
  operatorAuth: OperatorAuthorizer;
  metricsOperatorAuth: OperatorAuthorizer;
  metricsAuthRequiredFlag: boolean;
  toolAuthzLoader: ToolAuthzLoader;
  flowAuthorizer: FlowAuthorizer;
  flowMcpServer: FlowMcpServer;
  redTeamEngine: RedTeamEngine | undefined;
  redTeamExecutorShared: RedTeamExecutor | undefined;
  inputGuardrail: GuardrailsResult["inputGuardrail"];
  vectorStore: CacheResult["vectorStore"];
  ragEmbedder: CacheResult["embedder"];
  memoryStore: CacheResult["memoryStore"];
  assistantsResult: AssistantsResult | undefined;
  mcpWrapper: McpResult["mcpWrapper"];
  knownToolIds: Set<string>;
  flowParserService: FlowParserService;
  providerKeyPool: EngineResult["providerKeyPool"];
  providerCircuitBreaker: EngineResult["providerCircuitBreaker"];
  llmProviderFactory: EngineResult["llmProviderFactory"];
  piiVault: PersistenceResult["piiVault"];
  piiVaultStore: PersistenceResult["piiVaultStore"];
  guardrailPolicy: GuardrailPolicyService;
  tenantStore: PersistenceResult["tenantStore"];
  usageMeter: PersistenceResult["usageMeter"];
  providerKeyStore: PersistenceResult["providerKeyStore"];
  byokResolver: PersistenceResult["byokResolver"];
  approvalGate: GuardrailsResult["approvalGate"];
  replayService: EngineResult["replayService"];
  replayStore: EngineResult["replayStore"];
  canaryManager: CanaryManager;
  flowOptimizer: EngineResult["flowOptimizer"];
  traceAnalyzer: EngineResult["traceAnalyzer"];
  debugTraceStore: EngineResult["debugTraceStore"];
  executionAdmission: ExecutionAdmissionService;
  modelQuality: EngineResult["modelQuality"];
  /** Lazy read of the compliance policy for the flows router + simulation. */
  getCompliancePolicy: () => CompliancePolicy | undefined;
  /** Hands the constructed policy loader back to the composition root. */
  onCompliancePolicyLoader: (loader: CompliancePolicyLoader) => void;
  retentionService: ObservabilityResult["retentionService"];
  auditAnchor: ObservabilityResult["auditAnchor"];
  /** Ed25519 evidence key (ADR 0030) — preferred for bundle/receipt signing. */
  evidenceKey?: ObservabilityResult["evidenceKey"];
  budgetService: ObservabilityResult["budgetService"];
  metrics: Metrics;
  usageAnalytics: ObservabilityResult["usageAnalytics"];
  tokenLimitService: ObservabilityResult["tokenLimitService"];
  tokenLimitStore: ObservabilityResult["tokenLimitStore"];
  sloRegistry: SloRegistry;
  shadowModeService: ShadowModeService;
  abManager: AbManager | undefined;
  flowStore: PersistenceResult["flowStore"];
  dbFlowSource: DbFlowSource | undefined;
  /**
   * Shared rate limit store from `createHttpMiddleware` (Redis-backed when
   * REDIS_URL is set). Forwarded to the GitOps webhook router so its per-IP
   * budget is shared across replicas instead of one counter per process.
   */
  rateLimitStore?: RateLimitStore;
}

export interface ManagementRoutesResult {
  /** Defined only when the autonomous optimizer schedule is configured. */
  optimizerScheduler: OptimizerScheduler | undefined;
  /** Always started — the composition root stops it on shutdown. */
  triggerScheduler: TriggerScheduler;
}

/**
 * Mounts every management-plane router on `app`, in the original bootstrap
 * order, and returns the schedulers the composition root must shut down.
 */
export async function registerManagementRoutes(
  deps: ManagementRouteDeps,
): Promise<ManagementRoutesResult> {
  const {
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
    providerCircuitBreaker,
    llmProviderFactory,
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
    getCompliancePolicy,
    onCompliancePolicyLoader,
    retentionService,
    auditAnchor,
    evidenceKey,
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
  } = deps;

  // Flow-as-MCP-Server: POST/GET/DELETE /mcp. Unlike /v1 routes it is mounted
  // at the root, so it must receive the same verified credential explicitly.
  app.use(
    "/mcp",
    authMiddleware(jwtVerifier, apiKeyResolver, {
      mode: config.authnMode,
      tenantIsolationEnabled: config.tenantIsolationEnabled,
      ...(config.jwtIssuerTenants !== undefined
        ? { issuerTenants: config.jwtIssuerTenants }
        : {}),
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
  app.route(
    "/",
    createRedTeamRouter({
      ...(redTeamEngine !== undefined ? { engine: redTeamEngine } : {}),
      ...(redTeamExecutorShared !== undefined
        ? { executor: redTeamExecutorShared }
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
  if (vectorStore !== undefined && ragEmbedder !== undefined) {
    app.route("/", createRagRouter(vectorStore, ragEmbedder, logger));
    logger.info("RAG ingestion API enabled at /v1/rag/*");
  }
  if (memoryStore !== undefined) {
    app.route("/", createMemoryRouter(memoryStore, jwtVerifier, operatorAuth));
    logger.info("Long-term memory API enabled at /v1/memory/*");
  }
  if (assistantsResult !== undefined) {
    // Vectorsearch is optional. The session API stays available without it,
    // while hybrid search returns an explicit 503 rather than falling back to
    // an unscoped local scan.
    const vectorsearchConfigured = config.mcpServers.some(
      (server) => server.name === "vectorsearch",
    );
    const sessionIndex = vectorsearchConfigured
      ? new (
          await import("../assistants/session-index.js")
        ).McpAssistantSessionIndex(mcpWrapper)
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
    const { createAssistantsAdminRouter } =
      await import("../routes/assistants-admin.js");
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
    const { createGitopsRouter } = await import("../routes/gitops.js");
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
        // After a rescan, report which file flows are overridden by an online
        // (DB) flow with the same id — the push has no runtime effect for them
        // (composite registry precedence, ADR 0034).
        ...(dbFlowSource !== undefined
          ? {
              shadowedFlowIds: () =>
                findShadowedFlowIds(fileRegistry, dbFlowSource),
            }
          : {}),
        ...(deps.rateLimitStore !== undefined
          ? { rateLimitStore: deps.rateLimitStore }
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
    createProviderMonitoringRouter({
      metrics,
      config,
      providerCircuitBreaker: providerCircuitBreaker,
      authRequired: config.monitoringAuthRequired,
      operatorAuth,
    }),
  );
  app.route(
    "/",
    createProviderTestingRouter({
      config,
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
    const { createPiiVaultRouter } = await import("../routes/pii-vault.js");
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
  // Always mounted: routing advice (Studio "Optimize") and trace analysis don't
  // need the self-optimizing loop; its own endpoints answer 501 without it.
  {
    const { createOptimizerRouter } = await import("../routes/optimizer.js");
    app.route(
      "/optimizer",
      createOptimizerRouter({
        ...(flowOptimizer !== undefined ? { optimizer: flowOptimizer } : {}),
        operatorAuth,
        auditLog,
        ...(traceAnalyzer !== undefined ? { traceAnalyzer } : {}),
        // Enables GET /optimizer/routing-advice (cost/quality model advice).
        flowRegistry,
        // POST /optimizer/routing-advice resolves a canvas definition like a flow file.
        flowsDir: config.flowsDir,
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
  const { createCompliancePolicyLoader } =
    await import("../compliance/policy-loader.js");
  const { createCompliancePolicyRouter } =
    await import("../routes/compliance-policy.js");
  const compliancePolicyLoader = createCompliancePolicyLoader(
    config.flowsDir,
    logger,
  );
  onCompliancePolicyLoader(compliancePolicyLoader);
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

  // ── Policy-Replay-Simulator (Req 16, Task 22.1) ───────────────────────────
  // Dry-run candidate policies against stored executions. The replay source is
  // a read-only adapter over the monitoring service, so the simulator can
  // never mutate history (Property 17).
  const { createPolicyReplayRouter, replaySourceFromMonitoringService } =
    await import("../routes/policy-replay.js");
  app.route(
    "/admin/policy-replay",
    createPolicyReplayRouter({
      executionSource: replaySourceFromMonitoringService(monitoringService),
      policyLoader: compliancePolicyLoader,
      toolAuthzLoader,
      operatorAuth,
      auditLog,
      ...(inputGuardrail !== undefined ? { inputGuardrail } : {}),
    }),
  );
  logger.info("Policy replay API enabled at /admin/policy-replay/*");

  // ── Compliance (retention/RTBF + DSAR + auto-generated dossier) ───────────
  // Mounted here (not earlier) so the dossier route can cite the just-loaded
  // compliance policy, and — when RED_TEAM_ENABLED — the security posture
  // engine constructed above. evalRunHistory has a durable home only when a
  // database is configured; otherwise it's a per-replica in-memory ring.
  // evalRunHistory has a durable home only when a database is configured;
  // otherwise it's a per-replica in-memory ring. Shared by the compliance
  // dossier (cites the latest run per dataset) and the /admin/eval/runs API
  // (lets CI or an operator record a completed eval run).
  const { createEvalRunHistory } = await import("../eval/eval-run-history.js");
  const evalRunHistory = createEvalRunHistory(database, logger);
  const { createEvalMatrixRunStore, EvalMatrixService } =
    await import("../eval/eval-matrix.js");
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
      logger.warn(
        "Marked interrupted eval matrices as failed after runtime restart",
        {
          count: recoveredEvalMatrices,
        },
      );
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
  const { createEvalRunsRouter } = await import("../routes/eval-runs.js");
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
    // DSAR erasure orchestrator (Req 2.9): fans erasures out to the local
    // retention targets plus the remote ERASURE_TARGETS services and
    // persists every operation in erasure_requests (idempotent, retryable).
    // Erasure_Receipt signing (Req 2.11): Ed25519 via
    // ERASURE_RECEIPT_SIGNING_KEY, then the shared evidence key
    // (EVIDENCE_SIGNING_KEY, ADR 0030 — one key for the whole chain), and
    // only then the legacy audit-anchor HMAC fallback. The algorithm is
    // recorded in the envelope's `alg` either way.
    const receiptKey =
      ed25519ReceiptKey(config.erasureReceiptSigningKey) ??
      (evidenceKey !== undefined
        ? ({ alg: "Ed25519", key: evidenceKey.privateKey } as const)
        : undefined) ??
      hmacReceiptKey(config.auditAnchorSecret);
    const erasureOrchestrator = createErasureOrchestrator({
      retention: retentionService,
      ...(config.erasureTargets !== undefined
        ? { targets: config.erasureTargets }
        : {}),
      ...(database !== undefined ? { database } : {}),
      ...(logger !== undefined ? { logger } : {}),
      ...(receiptKey !== undefined ? { receiptKey } : {}),
    });
    app.route(
      "/",
      createComplianceRouter({
        retention: retentionService,
        erasureOrchestrator,
        authRequired: config.monitoringAuthRequired,
        operatorAuth,
        auditLog,
        ...(config.auditPseudonymPepper !== undefined
          ? { auditPseudonymPepper: config.auditPseudonymPepper }
          : {}),
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
            config.piiVaultTypes !== undefined &&
            config.piiVaultTypes.length > 0
              ? config.piiVaultTypes
              : "all",
          multimodalMode: config.piiVaultMultimodalMode ?? "off",
        },
      }),
    );
    logger.info(
      "Compliance API enabled at /admin/compliance/* (incl. dossier)",
    );
  }

  // ── Continuous Safety & Quality Autopilot ─────────────────────────────────
  // Wires RedTeamEngine + FlowOptimizer + CanaryManager into a closed loop.
  // Extracted to bootstrap/autopilot.ts (ADR-0004 style split) — see that
  // module for the canary registrar, judge-model resolution, the
  // red-team-run hook, the `/autopilot/*` router, and the health-signal
  // poller.
  const { buildAutopilot } = await import("../bootstrap/autopilot.js");
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
    | import("../graph/optimizer-scheduler.js").OptimizerScheduler
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
    const { createOptimizerScheduler } =
      await import("../graph/optimizer-scheduler.js");
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
      sourceDir: config.flowsDir,
      studioTests,
      // Enables POST /flows/write (Studio "Write to file"): writes go back into
      // the flow's own file under FLOWS_DIR (comment-preserving, source form)
      // and are picked up by the hot-reload watcher. Guarded by flows:write.
      flowsDir: config.flowsDir,
      ...(flowStore !== undefined ? { store: flowStore } : {}),
      ...(dbFlowSource !== undefined ? { dbSource: dbFlowSource } : {}),
      ...(knownToolIds.size > 0 ? { knownToolIds } : {}),
      authRequired: config.monitoringAuthRequired,
      ...(abManager !== undefined ? { abManager } : {}),
      operatorAuth,
      auditLog,
      appConfig: config,
      getCompliancePolicy,
      ...(replayStore !== undefined
        ? {
            simulation: {
              mcpWrapper,
              ...(llmProviderFactory !== undefined
                ? { llmProviderFactory: llmProviderFactory }
                : {}),
              replayStore,
              flowAuthorizer,
              getCompliancePolicy,
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
    const { createExplainRouter } = await import("../routes/explain.js");
    // Evidence-bundle signing prefers the Ed25519 evidence key (ADR 0030,
    // third-party verifiable via the published JWKS); otherwise it reuses the
    // audit-anchor secret when no dedicated one is set — see routes/explain.ts's
    // doc comment on why a deployment that already anchors its audit chain
    // should not need a second secret just to sign evidence bundles.
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
        ...(evidenceKey !== undefined
          ? { evidenceBundleKey: evidenceKey }
          : {}),
        ...(evidenceBundleSecret !== undefined ? { evidenceBundleSecret } : {}),
      }),
    );
    logger.info(
      "Decision-Provenance Explainability Card enabled at GET /monitoring/explain/:executionId",
    );
    if (evidenceKey !== undefined || evidenceBundleSecret !== undefined) {
      logger.info(
        "Verifiable Evidence Bundle enabled at GET /monitoring/explain/:executionId/bundle",
        { algorithm: evidenceKey !== undefined ? "ed25519" : "hmac-sha256" },
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
    const connectClientSecret =
      process.env.ROCKETCHAT_CONNECT_OIDC_CLIENT_SECRET;
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
    const { createSloRouter } = await import("../routes/slo.js");
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
    const { createFinopsRouter } = await import("../routes/finops.js");
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
  const { createShadowRouter } = await import("../routes/shadow.js");
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
  const { createTriggersRouter } = await import("../routes/triggers.js");
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

  const { createTriggerScheduler } =
    await import("../graph/trigger-scheduler.js");
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
  return { optimizerScheduler, triggerScheduler };
}
