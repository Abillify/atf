// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Inference-plane HTTP routes (`src/bootstrap/routes-inference.ts`)
 *
 * Extracted verbatim from `index.ts` (Req 13.6 composition-root split): the
 * analysis-artifacts, health/readiness, transaction JWKS, models, media,
 * OpenAI-compatible Chat Completions + Responses, async job status, and the
 * durable-job recovery sweeper. Mounted FIRST so route precedence matches the
 * original single-file order exactly.
 *
 * The compliance-policy loader is constructed later in bootstrap (management
 * plane); `getCompliancePolicy` is read lazily at request time, mirroring the
 * original `compliancePolicyLoaderRef` proxy. The recovery sweeper is
 * deliberately never stopped — same (pre-existing) lifecycle as before.
 *
 * No `any` at module boundaries.
 */

import type { Hono as HonoApp } from "hono";
import { getFlowLoadFailures } from "../graph/flow-parser/validate.js";
import { AnalysisArtifactService } from "../artifacts/analysis-artifacts.js";
import type { CompliancePolicy } from "../compliance/policy-schema.js";
import type { AppConfig } from "../config/index.js";
import type { CanaryManager } from "../graph/canary.js";
import type { ExecutionAdmissionService } from "../graph/execution-admission.js";
import type { AbManager } from "../graph/flow-ab.js";
import type { FlowAuthorizer } from "../graph/flow-authorizer.js";
import type { FlowDispatcher } from "../graph/flow-dispatcher.js";
import type { FlowRegistry } from "../graph/flow-parser/loader.js";
import type { GuardrailPolicyService } from "../graph/guardrail-policy.js";
import type { GraphEngineService } from "../graph/graph-engine.js";
import type { SloRegistry } from "../graph/slo.js";
import type { ShadowModeService } from "../graph/shadow-mode.js";
import type { ToolAuthzLoader } from "../graph/tool-authz-loader.js";
import type { AuthContext } from "../middleware/auth.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import { createAnalysisArtifactsRouter } from "../routes/analysis-artifacts.js";
import { createChatRouter } from "../routes/chat.js";
import { createHealthRouter } from "../routes/health.js";
import { createJobsRouter } from "../routes/jobs.js";
import { createMediaRouter } from "../routes/media.js";
import { aiDisclosureMiddleware } from "../middleware/ai-disclosure.js";
import { createModelsRouter } from "../routes/models.js";
import { createReceiptJwksRouter } from "../routes/receipt-jwks.js";
import { createEvidenceJwksRouter } from "../routes/evidence-jwks.js";
import {
  parseEvidenceSigningKey,
  type Ed25519EvidenceKey,
} from "../observability/evidence-key.js";
import { createReceiptsRouter } from "../routes/receipts.js";
import { createResponsesRouter } from "../routes/responses.js";
import { createTransactionJwksRouter } from "../routes/transaction-jwks.js";
import type { ReceiptSigningKey } from "../receipts/signing-key.js";
import type { ReceiptStore } from "../receipts/receipt-store.js";
import type { TransparencyLog } from "../receipts/transparency-log.js";
import type { AssistantsResult } from "./assistants.js";
import type { CacheResult } from "./cache.js";
import type { EngineResult } from "./engine.js";
import type { GuardrailsResult } from "./guardrails.js";
import type { ObservabilityResult } from "./observability.js";
import type { PersistenceResult } from "./persistence.js";

export interface InferenceRouteDeps {
  app: HonoApp<AuthContext>;
  config: AppConfig;
  logger: Logger;
  flowRegistry: FlowRegistry;
  database: PersistenceResult["database"];
  analysisArtifactStore: PersistenceResult["analysisArtifactStore"];
  auditLog: ObservabilityResult["auditLog"];
  toolAuthzLoader: ToolAuthzLoader;
  jwtVerifier: JwtVerifier;
  flowAuthorizer: FlowAuthorizer;
  assistantsResult: AssistantsResult | undefined;
  mediaStore: EngineResult["mediaStore"];
  jobStore: PersistenceResult["jobStore"];
  executionAdmission: ExecutionAdmissionService;
  budgetService: ObservabilityResult["budgetService"];
  metrics: Metrics;
  tokenLimitEnforcer: ObservabilityResult["tokenLimitEnforcer"];
  canaryManager: CanaryManager;
  replayService: EngineResult["replayService"];
  canaryJudge: EngineResult["canaryJudge"];
  modelQuality: EngineResult["modelQuality"];
  sloRegistry: SloRegistry;
  byokResolver: PersistenceResult["byokResolver"];
  idempotencyStore: PersistenceResult["idempotencyStore"];
  inputGuardrail: GuardrailsResult["inputGuardrail"];
  inputGuardrailClassify: GuardrailsResult["inputGuardrailClassify"];
  guardrailPolicy: GuardrailPolicyService;
  flowGuardrailResolver: GuardrailsResult["flowGuardrailResolver"];
  memoryStore: CacheResult["memoryStore"];
  memoryExtractor: CacheResult["memoryExtractor"];
  abManager: AbManager | undefined;
  shadowModeService: ShadowModeService;
  graphEngine: GraphEngineService;
  monitoringService: MonitoringServiceInterface;
  flowDispatcher: FlowDispatcher;
  /** Lazy read of the compliance policy — the loader is built in the management plane. */
  getCompliancePolicy: () => CompliancePolicy | undefined;
  /** Lazy read of the loader's `enforcementBlocked` (invalid policy, none loaded). */
  isCompliancePolicyBlocked?: () => boolean;
  /** Decision_Receipts wiring (Req 15.4) — all three present only when enabled. */
  receiptStore?: ReceiptStore;
  transparencyLog?: TransparencyLog;
  receiptSigningKey?: ReceiptSigningKey;
  /**
   * Ed25519 evidence key (ADR 0030) — when present, its public half is
   * published at `/.well-known/atf-evidence-jwks.json` for offline
   * third-party verification of audit anchors, Evidence Bundles, and
   * Erasure Receipts.
   */
  evidenceKey?: Ed25519EvidenceKey;
}

/**
 * Mounts every inference-plane router on `app`, in the original bootstrap order.
 */
export async function registerInferenceRoutes(
  deps: InferenceRouteDeps,
): Promise<void> {
  const {
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
    getCompliancePolicy,
    receiptStore,
    transparencyLog,
    receiptSigningKey,
    evidenceKey,
  } = deps;
  // Decision_Receipts (Req 15.4): routes + public JWKS only exist when the
  // feature is fully wired (store, log, and signing key all present).
  const receiptsEnabled =
    receiptStore !== undefined && receiptSigningKey !== undefined;

  app.route(
    "/",
    createAnalysisArtifactsRouter(
      new AnalysisArtifactService(analysisArtifactStore),
    ),
  );
  let healthRedisClient:
    | import("../routes/health.js").RedisProbeClient
    | undefined;
  if (config.redisUrl !== undefined) {
    const { createRedisClient } = await import("../util/redis-client.js");
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
      // Req 1.9: surface failed durable audit writes as a degraded (never 503)
      // readiness hint.
      audit: auditLog,
      // Req 7.7: a failed tool-authz.json reload surfaces as a degraded
      // (never 503) policy_stale hint — the last-known-good policy still holds.
      toolAuthz: toolAuthzLoader,
      // Flow files that fail to load are an informational readiness
      // hint, and the aiperator_flow_load_failures gauge reads the same ledger.
      flowLoad: getFlowLoadFailures,
      // COMPLIANCE_POLICY_REQUIRED: a missing (or no longer loadable) policy is
      // an informational readiness hint, read lazily so hot-reloads count.
      compliancePolicy: {
        required: config.compliancePolicyRequired === true,
        loaded: () => getCompliancePolicy() !== undefined,
      },
      // An instance without authentication says so on /health.
      authDisabled: config.authnMode === "disabled",
    }),
  );
  // Req 7.11: public JWKS for asymmetrically signed transaction tokens
  // (TRANSACTION_SIGNING_ALG=ES256|EdDSA). Unauthenticated by design — it only
  // ever serves public key material; HS256 mode returns an empty key set.
  app.route("/", createTransactionJwksRouter());
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
  const jobRecoveryOptions:
    | { maxAttempts: number; leaseMs: number; contextSecret?: string }
    | undefined =
    jobStore !== undefined && config.jobRecoveryEnabled === true
      ? {
          maxAttempts: config.jobRecoveryMaxAttempts ?? 3,
          leaseMs: config.jobRecoveryLeaseMs ?? 300_000,
          ...(executionContextSecret !== undefined &&
          executionContextSecret.length > 0
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
    ...(jobRecoveryOptions !== undefined
      ? { jobRecovery: jobRecoveryOptions }
      : {}),
    ...(executionContextSecret !== undefined &&
    executionContextSecret.length > 0
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
        return getCompliancePolicy();
      },
      get enforcementBlocked() {
        return deps.isCompliancePolicyBlocked?.() ?? false;
      },
    },
    auditLog,
    ...(config.sseHeartbeatMs !== undefined
      ? { sseHeartbeatMs: config.sseHeartbeatMs }
      : {}),
    ...(receiptsEnabled ? { decisionReceiptsEnabled: true } : {}),
  };

  // Art. 50 AI Act: opt-in machine-readable marker on successful completions.
  if (config.aiDisclosure !== undefined && config.aiDisclosure !== "off") {
    const disclosure = aiDisclosureMiddleware(config.aiDisclosure);
    app.use("/v1/chat/completions", disclosure);
    app.use("/v1/responses", disclosure);
    app.use("/v1/responses/*", disclosure);
  }
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

  // Decision_Receipts (Req 15.4): tenant-scoped receipt lookup, Merkle
  // inclusion proofs, and the public verification JWKS.
  if (receiptsEnabled && receiptStore !== undefined) {
    app.route(
      "/",
      createReceiptsRouter({
        receiptStore,
        ...(transparencyLog !== undefined ? { transparencyLog } : {}),
      }),
    );
    app.route("/", createReceiptJwksRouter(receiptSigningKey));
    logger.info("Decision receipts API enabled at /v1/receipts/:id");
  }

  // Evidence-chain JWKS (ADR 0030): the public half of EVIDENCE_SIGNING_KEY
  // plus, when set, the public half of ERASURE_RECEIPT_SIGNING_KEY, so
  // auditors can verify audit anchors / Evidence Bundles / Erasure Receipts
  // offline without any shared secret. A malformed erasure key fails the
  // start loudly, like the evidence key.
  const erasureJwksKey = parseEvidenceSigningKey(config.erasureReceiptSigningKey);
  if (evidenceKey !== undefined || erasureJwksKey !== undefined) {
    app.route(
      "/",
      createEvidenceJwksRouter(
        evidenceKey,
        erasureJwksKey !== undefined ? [erasureJwksKey] : [],
      ),
    );
    logger.info(
      "Evidence-chain JWKS enabled at /.well-known/atf-evidence-jwks.json",
    );
  }

  // Durable Agent Runtime — recovery sweeper (see job-store.ts /
  // job-recovery-sweeper.ts module doc comments). Only meaningful with a
  // job store AND JOB_RECOVERY_ENABLED; otherwise async jobs keep their
  // pre-existing (non-recoverable) behaviour.
  let jobRecoverySweeper:
    | import("../graph/job-recovery-sweeper.js").JobRecoverySweeper
    | undefined;
  if (jobStore !== undefined && jobRecoveryOptions !== undefined) {
    const { createJobRecoverySweeper } =
      await import("../graph/job-recovery-sweeper.js");
    const { createJobRetryRunner } = await import("../routes/chat/metering.js");
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
    logger.info(
      "Durable Agent Runtime enabled — async jobs recover from a crash",
      {
        maxAttempts: jobRecoveryOptions.maxAttempts,
        leaseMs: jobRecoveryOptions.leaseMs,
        sweepIntervalMs: config.jobRecoverySweepIntervalMs ?? 60_000,
      },
    );
  }
}
