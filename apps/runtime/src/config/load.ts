// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Configuration loading: env-parsing, merge, and validation.
 *
 * Reads all configuration from environment variables, validates them with Zod
 * (via the EnvSchema from ./schema.ts), and exits with code 1 on any
 * validation failure (listing all invalid/missing variable names on stderr).
 *
 */

import { z } from "zod";
import {
  resolveOperationalProfile,
  UnknownOperationalProfileError,
  type ResolvedOperationalProfile,
} from "@atf/security-kit";
import type { AppConfig, McpServerConfig } from "./schema.js";
import { EnvSchema, McpServerConfigSchema } from "./schema.js";
import { applyProfile, type RawEnv } from "./profiles.js";
import {
  configuredProviderNames,
  isKnownProviderName,
  PROVIDER_PROTOCOLS,
  setProviderRegistry,
} from "./providers.js";
import { parseFlowFile, resolveConfigFile } from "../util/parse-flow-file.js";

/**
 * Collects every provider reference in the parsed environment by walking the
 * value tree for `{ provider, model }` shapes.
 *
 * A deep walk rather than a hand-written list of variables (DEFAULT_LLM,
 * FALLBACK_LLM, FALLBACK_CHAIN, EMBEDDING_MODEL, the judge/optimizer/memory
 * models, …): that list has grown repeatedly, and a reference missed by such a
 * list would fail at first use in production instead of at startup.
 */
function collectProviderRefs(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProviderRefs(item, out);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.provider === "string" && typeof record.model === "string") {
    out.add(record.provider);
  }
  for (const nested of Object.values(record)) collectProviderRefs(nested, out);
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Loads and validates all configuration from environment variables.
 *
 * On validation failure: writes a list of all failing variable names to stderr
 * and calls `process.exit(1)`.
 */
export function loadConfig(): AppConfig {
  // Apply an ATF_PRESET preset (if any) BEFORE parsing, so its defaults fill
  // only unset variables and Zod coercion/validation sees the effective
  // values. Explicit env vars always win over the preset (see ./profiles.ts).
  // PROFILE is a deprecated alias of ATF_PRESET.
  const {
    env: mergedEnv,
    profile,
    applied,
    deprecatedAlias,
    error: profileError,
  } = applyProfile(process.env as RawEnv);
  if (profileError !== undefined) {
    process.stderr.write(`[Config] ${profileError}\n`);
    process.exit(1);
  }
  if (deprecatedAlias) {
    process.stderr.write(
      "[Config] PROFILE is deprecated; use ATF_PRESET (same values). PROFILE still works in this release.\n",
    );
  }

  // Resolve the effective operational profile: the explicit,
  // platform-wide ATF_PROFILE wins over the service variable APP_ENV. Unknown
  // values fail startup — a typo like `prod` must never silently disable the
  // production-readiness gates. This runs BEFORE the Zod parse so the error
  // names the offending variable and value (and the valid set), instead of
  // the generic enum-validation list a typo'd APP_ENV would produce.
  let operationalProfile: ResolvedOperationalProfile;
  try {
    operationalProfile = resolveOperationalProfile(
      mergedEnv as Record<string, string | undefined>,
      ["APP_ENV"],
    );
  } catch (err) {
    if (err instanceof UnknownOperationalProfileError) {
      process.stderr.write(`[Config] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const appEnv = operationalProfile.profile;

  const result = EnvSchema.safeParse(mergedEnv);

  if (!result.success) {
    const failingVars = new Set<string>();
    for (const issue of result.error.issues) {
      if (issue.path.length > 0) {
        failingVars.add(String(issue.path[0]));
      } else {
        failingVars.add(issue.message);
      }
    }
    process.stderr.write(
      `[Config] Validation failed. Invalid or missing environment variables: ${[...failingVars].join(", ")}\n`,
    );
    process.exit(1);
  }

  const env = result.data;

  // Publish the named endpoints BEFORE anything resolves a provider reference,
  // then verify every reference actually resolves. Provider names are validated
  // here (not in EnvSchema) because their valid set is PROVIDERS in this same
  // environment — a cross-field condition Zod cannot express per variable.
  setProviderRegistry(env.PROVIDERS);
  const referenced = new Set<string>();
  collectProviderRefs(env, referenced);
  const unknown = [...referenced].filter((name) => !isKnownProviderName(name));
  if (unknown.length > 0) {
    process.stderr.write(
      `[Config] Unknown LLM provider(s): ${unknown.join(", ")}. ` +
        `Configured PROVIDERS names: ${configuredProviderNames().join(", ") || "(none)"}; ` +
        `built-in protocols: ${PROVIDER_PROTOCOLS.join(", ")}.\n`,
    );
    process.exit(1);
  }

  if (profile !== undefined) {
    process.stderr.write(
      `[Config] Profile "${profile}" applied defaults for ${applied.length} unset variable(s): ` +
        `${applied.join(", ") || "(none — all overridden explicitly)"} ` +
        `(explicit environment variables always take precedence).\n`,
    );
  }

  const mcpFileServers = loadMcpYamlConfig(env.FLOWS_DIR);
  const mcpServers = mergeMcpServers(mcpFileServers, env.MCP_SERVERS);
  const anonymousServers = mcpServers.filter(
    (server) => server.allowAnonymous === true,
  );
  const anonymousForwardAuthServers = anonymousServers.filter(
    (server) => server.forwardAuthToken === true,
  );

  if (anonymousForwardAuthServers.length > 0) {
    process.stderr.write(
      `[Config] MCP server(s) ${anonymousForwardAuthServers.map((server) => server.name).join(", ")} ` +
        `cannot combine allowAnonymous=true with forwardAuthToken=true.\n`,
    );
    process.exit(1);
  }
  if (anonymousServers.length > 0 && env.AUTHN_MODE !== "disabled") {
    process.stderr.write(
      `[Config] MCP server(s) ${anonymousServers.map((server) => server.name).join(", ")} ` +
        `use allowAnonymous=true, which requires AUTHN_MODE=disabled.\n`,
    );
    process.exit(1);
  }

  // Token exchange (RFC 8693): validate wiring and resolve secrets from their
  // env references. A misconfigured exchange must fail loudly at startup, never
  // silently fall back to forwarding the un-exchanged (wrong-audience) token.
  resolveTokenExchangeSecrets(mcpServers);

  return {
    ...(profile !== undefined ? { profile } : {}),
    port: env.PORT,
    flowsDir: env.FLOWS_DIR,
    ...(env.PLUGINS_DIR !== undefined ? { pluginsDir: env.PLUGINS_DIR } : {}),
    ...(env.PLUGINS_ALLOWLIST !== undefined
      ? { pluginsAllowlist: env.PLUGINS_ALLOWLIST }
      : {}),
    ...(env.PLUGINS_MANIFEST_PATH !== undefined
      ? { pluginsManifestPath: env.PLUGINS_MANIFEST_PATH }
      : {}),
    pluginsSandbox: env.PLUGINS_SANDBOX,
    pluginsSandboxTimeoutMs: env.PLUGINS_SANDBOX_TIMEOUT_MS,
    appEnv,
    monitoringTransport: env.MONITORING_TRANSPORT,
    mcpServers,
    mcpSchemaCompatibilityMode: env.MCP_SCHEMA_COMPATIBILITY_MODE,
    ...(env.PROVIDERS.length > 0 ? { providers: env.PROVIDERS } : {}),
    anthropicPromptCacheEnabled: env.ANTHROPIC_PROMPT_CACHE,
    rerankEnabled: env.RERANK_ENABLED,
    rerankUrl: env.RERANK_URL,
    rerankModel: env.RERANK_MODEL,
    rerankProvider: env.RERANK_PROVIDER,
    rerankRegion: env.RERANK_REGION,
    rerankFallbackModel: env.RERANK_FALLBACK_MODEL,
    rerankFallbackProvider: env.RERANK_FALLBACK_PROVIDER,
    rerankFallbackRegion: env.RERANK_FALLBACK_REGION,
    rerankBatchSize: env.RERANK_BATCH_SIZE,
    defaultLlm: env.DEFAULT_LLM,
    corsOrigins: env.CORS_ORIGINS,
    monitoringAuthRequired: env.MONITORING_AUTH,
    debugCaptureRequestTokens: env.DEBUG_CAPTURE_REQUEST_TOKENS,
    monitoringTicketSecret: env.MONITORING_TICKET_SECRET,
    auditAnchorSecret: env.AUDIT_ANCHOR_SECRET,
    auditAnchorIntervalMs: env.AUDIT_ANCHOR_INTERVAL_MS,
    auditAnchorFile: env.AUDIT_ANCHOR_FILE,
    auditPseudonymPepper: env.AUDIT_PSEUDONYM_PEPPER,
    ...(env.ERASURE_TARGETS !== undefined
      ? { erasureTargets: env.ERASURE_TARGETS }
      : {}),
    ...(env.ERASURE_RECEIPT_SIGNING_KEY !== undefined
      ? { erasureReceiptSigningKey: env.ERASURE_RECEIPT_SIGNING_KEY }
      : {}),
    decisionReceiptsEnabled: env.DECISION_RECEIPTS_ENABLED,
    ...(env.RECEIPT_SIGNING_KEY !== undefined
      ? { receiptSigningKey: env.RECEIPT_SIGNING_KEY }
      : {}),
    evidenceBundleSecret: env.EVIDENCE_BUNDLE_SECRET,
    ...(env.EVIDENCE_SIGNING_KEY !== undefined
      ? { evidenceSigningKey: env.EVIDENCE_SIGNING_KEY }
      : {}),
    piiRecallDataset: env.PII_RECALL_DATASET,
    sloAlertWebhookUrl: env.SLO_ALERT_WEBHOOK_URL,
    providerRegions: env.PROVIDER_REGIONS,
    localProviders: env.LOCAL_PROVIDERS,
    co2GridCarbonIntensity: env.CO2_GRID_CARBON_INTENSITY,
    co2EnergyFactors: env.CO2_ENERGY_FACTORS,
    monitoringTicketTtlSeconds: env.MONITORING_TICKET_TTL_SECONDS,
    authnMode: env.AUTHN_MODE,
    authzEnabled: env.AUTHZ_ENABLED,
    tenantIsolationEnabled: env.TENANT_ISOLATION_ENABLED,
    defaultTenantId: env.DEFAULT_TENANT_ID,
    jwtSecret: env.JWT_SECRET,
    jwtJwksUrl: env.JWT_JWKS_URL,
    jwtIssuer: env.JWT_ISSUER,
    jwtAudience: env.JWT_AUDIENCE,
    oidcIssuer: env.OIDC_ISSUER,
    oidcAudience: env.OIDC_AUDIENCE,
    flowScopeClaims: env.FLOW_SCOPE_CLAIMS,
    inferenceExtraOidcIssuers: env.JWT_ADDITIONAL_ISSUERS,
    jwtIssuerTenants: env.JWT_ISSUER_TENANTS,
    oidcClientId: env.OIDC_CLIENT_ID,
    oidcClientSecret: env.OIDC_CLIENT_SECRET,
    oidcSessionSecret: env.OIDC_SESSION_SECRET,
    oidcSessionTtlSeconds: env.OIDC_SESSION_TTL_SECONDS,
    oidcScopes: env.OIDC_SCOPES,
    oidcRefreshSessionTtlSeconds: env.OIDC_REFRESH_SESSION_TTL_SECONDS,
    oidcRedirectUri: env.OIDC_REDIRECT_URI,
    oidcDashboardUrl: env.OIDC_DASHBOARD_URL,
    oidcAutoLogin: env.OIDC_AUTO_LOGIN,
    redisUrl: env.REDIS_URL,
    replicas: env.REPLICAS,
    databaseUrl: env.DATABASE_URL,
    databasePoolMax: env.DATABASE_POOL_MAX,
    // Requirement 12.4: dev keeps the convenient migrate-on-boot, production
    // defaults to dedicated migration Jobs (`bun run migrate`) instead.
    migrateOnStart: env.MIGRATE_ON_START ?? appEnv !== "production",
    tenantRlsEnabled: env.TENANT_RLS_ENABLED,
    tenantRlsRequired: env.TENANT_RLS_REQUIRED,
    clusterStateOptOut: env.CLUSTER_STATE_OPT_OUT,
    databaseOperatorUrl: env.DATABASE_OPERATOR_URL,
    monitoringMaxConnections: env.MONITORING_MAX_CONNECTIONS,
    responseCacheEnabled: env.RESPONSE_CACHE_ENABLED,
    responseCacheTtlSeconds: env.RESPONSE_CACHE_TTL_SECONDS,
    responseCacheMaxEntries: env.RESPONSE_CACHE_MAX_ENTRIES,
    semanticCacheEnabled: env.SEMANTIC_CACHE_ENABLED,
    semanticCacheThreshold: env.SEMANTIC_CACHE_THRESHOLD,
    semanticCacheMaxEntries: env.SEMANTIC_CACHE_MAX_ENTRIES,
    semanticCacheTtlSeconds: env.SEMANTIC_CACHE_TTL_SECONDS,
    embeddingCacheEnabled: env.EMBEDDING_CACHE_ENABLED,
    embeddingCacheMaxEntries: env.EMBEDDING_CACHE_MAX_ENTRIES,
    embeddingCacheTtlSeconds: env.EMBEDDING_CACHE_TTL_SECONDS,
    routerQualityHalfLifeMs: env.ROUTER_QUALITY_HALF_LIFE_MS,
    collectionCapabilityTtlMs: env.COLLECTION_CAPABILITY_TTL_MS,
    retentionEnabled: env.RETENTION_ENABLED,
    retentionSweepIntervalMs: env.RETENTION_SWEEP_INTERVAL_MS,
    retentionDefaultMaxAgeDays: env.RETENTION_DEFAULT_MAX_AGE_DAYS,
    retentionMaxAgeDays: env.RETENTION_MAX_AGE_DAYS,
    // Mandatory BYOK necessarily activates the resolver/store bootstrap.
    byokEnabled: env.BYOK_ENABLED || env.BYOK_MODE === "required",
    byokMode: env.BYOK_MODE,
    complianceFailClosedUnknownRegion:
      env.COMPLIANCE_FAIL_CLOSED_UNKNOWN_REGION,
    byokEncryptionKey: env.BYOK_ENCRYPTION_KEY,
    byokCacheTtlSeconds: env.BYOK_CACHE_TTL_SECONDS,
    piiVaultEnabled: env.PII_VAULT_ENABLED,
    piiVaultEncryptionKey: env.PII_VAULT_ENCRYPTION_KEY,
    piiVaultTypes: env.PII_VAULT_TYPES
      ? env.PII_VAULT_TYPES.split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : undefined,
    piiDetectors: env.PII_DETECTORS
      ? env.PII_DETECTORS.split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : undefined,
    piiNerModel: env.PII_NER_MODEL,
    piiNerConfidence: env.PII_NER_CONFIDENCE,
    piiNerCacheDir: env.PII_NER_CACHE_DIR,
    piiRemoteEndpoint: env.PII_REMOTE_ENDPOINT,
    piiRemoteApiKey: env.PII_REMOTE_API_KEY,
    piiRemoteTimeoutMs: env.PII_REMOTE_TIMEOUT_MS,
    piiRemoteLanguage: env.PII_REMOTE_LANGUAGE,
    piiDetectorFailMode: env.PII_DETECTOR_FAIL_MODE,
    piiDetectorTimeoutMs: env.PII_DETECTOR_TIMEOUT_MS,
    piiVaultMultimodalMode: env.PII_VAULT_MULTIMODAL_MODE,
    piiVaultMultimodalFailMode: env.PII_VAULT_MULTIMODAL_FAIL_MODE,
    piiImageRemoteEndpoint: env.PII_IMAGE_REMOTE_ENDPOINT,
    piiImageRemoteApiKey: env.PII_IMAGE_REMOTE_API_KEY,
    piiImageRemoteTimeoutMs: env.PII_IMAGE_REMOTE_TIMEOUT_MS,
    piiImageDescribeModel: env.PII_IMAGE_DESCRIBE_MODEL,
    piiImageDescribePrompt: env.PII_IMAGE_DESCRIBE_PROMPT,
    idempotencyEnabled: env.IDEMPOTENCY_ENABLED,
    idempotencyTtlSeconds: env.IDEMPOTENCY_TTL_SECONDS,
    idempotencyMaxEntries: env.IDEMPOTENCY_MAX_ENTRIES,
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingFallbackModel: env.EMBEDDING_FALLBACK_MODEL,
    embeddingExpectedDimension: env.EMBEDDING_EXPECTED_DIMENSION,
    checkpointingEnabled: env.CHECKPOINTING_ENABLED,
    logLevel: env.LOG_LEVEL,
    maxToolSteps: env.MAX_TOOL_STEPS,
    maxConcurrentExecutions: env.MAX_CONCURRENT_EXECUTIONS,
    maxGlobalConcurrentExecutions: env.MAX_GLOBAL_CONCURRENT_EXECUTIONS,
    executionTimeoutMs: env.EXECUTION_TIMEOUT_MS,
    sseHeartbeatMs: env.SSE_HEARTBEAT_MS,
    healthProbeTimeoutMs: env.HEALTH_PROBE_TIMEOUT_MS,
    requireJwtVerification: env.JWT_REQUIRE_VERIFICATION,
    allowUnverifiedJwt: env.JWT_ALLOW_UNVERIFIED,
    toolAuthzFailClosed: env.TOOL_AUTHZ_FAIL_CLOSED,
    maxRequestBodyBytes: env.MAX_REQUEST_BODY_BYTES,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    rateLimitPerUserPerMinute: env.RATE_LIMIT_PER_USER_PER_MINUTE,
    rateLimitPreAuthPerMinute: env.RATE_LIMIT_PRE_AUTH_PER_MINUTE,
    rateLimitPostAuthPerMinute: env.RATE_LIMIT_POST_AUTH_PER_MINUTE,
    rateLimitFailMode: env.RATE_LIMIT_FAIL_MODE,
    metricsEnabled: env.METRICS_ENABLED,
    metricsAuthRequired: env.METRICS_AUTH,
    llmMaxAttempts: env.LLM_MAX_ATTEMPTS,
    llmRetryBackoffMs: env.LLM_RETRY_BACKOFF_MS,
    llmRequestTimeoutMs: env.LLM_REQUEST_TIMEOUT_MS,
    llmHttpKeepAlive: env.LLM_HTTP_KEEP_ALIVE,
    llmMaxOutputChars: env.LLM_MAX_OUTPUT_CHARS,
    llmStreamFallbackPolicy: env.LLM_STREAM_FALLBACK_POLICY,
    charsPerToken: env.CHARS_PER_TOKEN,
    fallbackLlm: env.FALLBACK_LLM,
    fallbackChain:
      env.FALLBACK_CHAIN.length > 0 ? env.FALLBACK_CHAIN : undefined,
    maxQueueDepth: env.MAX_QUEUE_DEPTH,
    budgetDailyPerTenant: env.BUDGET_DAILY_PER_TENANT,
    currency: env.CURRENCY,
    llmPricing: env.LLM_PRICING,
    tracingEnabled: env.TRACING_ENABLED,
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelServiceName: env.OTEL_SERVICE_NAME,
    outputGuardrailsEnabled: env.OUTPUT_GUARDRAILS_ENABLED,
    guardrailRedactPii: env.GUARDRAIL_REDACT_PII,
    guardrailPiiTypes: env.GUARDRAIL_PII_TYPES,
    guardrailBlockedPatterns: env.GUARDRAIL_BLOCKED_PATTERNS,
    guardrailMode: env.GUARDRAIL_MODE,
    toolEgressGuardrailEnabled: env.TOOL_EGRESS_GUARDRAIL,
    toolEgressMode: env.TOOL_EGRESS_MODE,
    egressAllowPrivateHosts: env.EGRESS_ALLOW_PRIVATE_HOSTS,
    egressAllowedHosts: env.EGRESS_ALLOWED_HOSTS,
    compliancePolicyRequired: env.COMPLIANCE_POLICY_REQUIRED,
    egressMaxResponseBytes: env.EGRESS_MAX_RESPONSE_BYTES,
    egressTimeoutMs: env.EGRESS_TIMEOUT_MS,
    toolOutputValidatorEnabled: env.TOOL_OUTPUT_VALIDATOR_ENABLED,
    toolOutputValidatorMode: env.TOOL_OUTPUT_VALIDATOR_MODE,
    toolOutputValidatorThreshold: env.TOOL_OUTPUT_VALIDATOR_THRESHOLD,
    retrievalContextMode: env.RETRIEVAL_CONTEXT_MODE,
    taintWriteToolsRequireApproval: env.TAINT_WRITE_TOOLS_REQUIRE_APPROVAL,
    taintMode: env.TAINT_MODE,
    aiDisclosure: env.AI_DISCLOSURE,
    approvalGateEnabled: env.APPROVAL_GATE_ENABLED,
    approvalRequireTools: env.APPROVAL_REQUIRE_TOOLS,
    approvalTimeoutMs: env.APPROVAL_TIMEOUT_MS,
    approvalBaseUrl: env.APPROVAL_BASE_URL,
    approvalFrameAncestors: env.APPROVAL_FRAME_ANCESTORS,
    mediaBaseUrl: env.MEDIA_BASE_URL ?? env.APPROVAL_BASE_URL,
    embedSearchFigures: env.EMBED_SEARCH_FIGURES,
    groundednessEnabled: env.GROUNDEDNESS_ENABLED,
    groundednessMode: env.GROUNDEDNESS_MODE,
    groundednessPassThreshold: env.GROUNDEDNESS_PASS_THRESHOLD,
    groundednessType: env.GROUNDEDNESS_TYPE,
    groundednessSemanticThreshold: env.GROUNDEDNESS_SEMANTIC_THRESHOLD,
    groundednessMaxSourceChunks: env.GROUNDEDNESS_MAX_SOURCE_CHUNKS,
    groundednessEmbeddingModel: env.GROUNDEDNESS_EMBEDDING_MODEL,
    groundednessJudgeModel: env.GROUNDEDNESS_JUDGE_MODEL,
    canaryJudgeModel: env.CANARY_JUDGE_MODEL,
    replayEnabled: env.REPLAY_ENABLED,
    flowEditorEnabled: env.FLOW_EDITOR_ENABLED,
    optimizerEnabled: env.OPTIMIZER_ENABLED,
    optimizerGeneratorModel: env.OPTIMIZER_GENERATOR_MODEL,
    optimizerJudgeModel: env.OPTIMIZER_JUDGE_MODEL,
    optimizerScheduleEnabled: env.OPTIMIZER_SCHEDULE_ENABLED,
    optimizerScheduleFlows: env.OPTIMIZER_SCHEDULE_FLOWS,
    optimizerScheduleIntervalMs: env.OPTIMIZER_SCHEDULE_INTERVAL_MS,
    optimizerScheduleMinNewSamples: env.OPTIMIZER_SCHEDULE_MIN_NEW_SAMPLES,
    optimizerScheduleCooldownMs: env.OPTIMIZER_SCHEDULE_COOLDOWN_MS,
    optimizerScheduleAutoPromote: env.OPTIMIZER_SCHEDULE_AUTO_PROMOTE,
    optimizerScheduleVariantCount: env.OPTIMIZER_SCHEDULE_VARIANT_COUNT,
    optimizerScheduleMinScoreImprovement:
      env.OPTIMIZER_SCHEDULE_MIN_SCORE_IMPROVEMENT,
    optimizerScheduleGoal: env.OPTIMIZER_SCHEDULE_GOAL,
    autopilotRequireApproval: env.AUTOPILOT_REQUIRE_APPROVAL,
    autopilotMaxAutoPromotionsPerWindow:
      env.AUTOPILOT_MAX_AUTO_PROMOTIONS_PER_WINDOW,
    autopilotDriftWindowMs: env.AUTOPILOT_DRIFT_WINDOW_MS,
    redTeamEnabled: env.RED_TEAM_ENABLED || false,
    redTeamScheduleFlows: env.RED_TEAM_SCHEDULE_FLOWS,
    redTeamIntervalMs: env.RED_TEAM_INTERVAL_MS,
    redTeamAttacksPerRun: env.RED_TEAM_ATTACKS_PER_RUN,
    redTeamJudgeModel: env.RED_TEAM_JUDGE_MODEL,
    redTeamJudgeThreshold: env.RED_TEAM_JUDGE_THRESHOLD,
    redTeamPostureAlertThreshold: env.RED_TEAM_POSTURE_ALERT_THRESHOLD,
    redTeamAlertWebhookUrl: env.RED_TEAM_ALERT_WEBHOOK_URL,
    redTeamAutoTune: env.RED_TEAM_AUTO_TUNE || false,
    redTeamAutoTuneCeiling: env.RED_TEAM_AUTO_TUNE_CEILING,
    redTeamAttacksUrl: env.RED_TEAM_ATTACKS_URL,
    redTeamAttacksPollIntervalMs: env.RED_TEAM_ATTACKS_POLL_INTERVAL_MS,
    providerKeys: env.PROVIDER_KEYS,
    budgetAlertThresholds: env.BUDGET_ALERT_THRESHOLDS,
    budgetAlertWebhookUrl: env.BUDGET_ALERT_WEBHOOK_URL,
    costAnomalyEnabled: env.COST_ANOMALY_ENABLED,
    costAnomalyWindowMs: env.COST_ANOMALY_WINDOW_MS,
    costAnomalyBaselineDays: env.COST_ANOMALY_BASELINE_DAYS,
    costAnomalyMinBaselineDays: env.COST_ANOMALY_MIN_BASELINE_DAYS,
    costAnomalySpikeMultiplier: env.COST_ANOMALY_SPIKE_MULTIPLIER,
    costAnomalyMinAbsolute: env.COST_ANOMALY_MIN_ABSOLUTE,
    costAnomalyCooldownMs: env.COST_ANOMALY_COOLDOWN_MS,
    inputGuardrailsEnabled: env.INPUT_GUARDRAILS_ENABLED,
    inputGuardrailMode: env.INPUT_GUARDRAIL_MODE,
    inputGuardrailThreshold: env.INPUT_GUARDRAIL_THRESHOLD,
    inputGuardrailModel: env.INPUT_GUARDRAIL_MODEL,
    inputGuardrailModelMinScore: env.INPUT_GUARDRAIL_MODEL_MIN_SCORE,
    // Requirement 7.5: environment-conditional default — fail-open in
    // Development (availability), fail-closed in Production (protection).
    inputGuardrailModelFailMode:
      env.INPUT_GUARDRAIL_MODEL_FAIL_MODE ??
      (appEnv === "production" ? "closed" : "open"),
    inputGuardrailMaxChars: env.INPUT_GUARDRAIL_MAX_CHARS,
    jobsEnabled: env.JOBS_ENABLED,
    jobsTtlSeconds: env.JOBS_TTL_SECONDS,
    jobsMaxEntries: env.JOBS_MAX_ENTRIES,
    jobRecoveryEnabled: env.JOB_RECOVERY_ENABLED,
    jobRecoveryMaxAttempts: env.JOB_RECOVERY_MAX_ATTEMPTS,
    jobRecoveryLeaseMs: env.JOB_RECOVERY_LEASE_MS,
    jobRecoverySweepIntervalMs: env.JOB_RECOVERY_SWEEP_INTERVAL_MS,
    ragEnabled: env.RAG_ENABLED,
    ragMaxDocuments: env.RAG_MAX_DOCUMENTS,
    clientToolsEnabled: env.CLIENT_TOOLS_ENABLED,
    trustedIdentityHeaders: env.TRUSTED_IDENTITY_HEADERS,
    strictIdentityHeaders: env.STRICT_IDENTITY_HEADERS,
    triggersRequireSignature: env.TRIGGERS_REQUIRE_SIGNATURE,
    gitopsRequireSignature: env.GITOPS_REQUIRE_SIGNATURE,
    memoryEnabled: env.MEMORY_ENABLED,
    memoryTopK: env.MEMORY_TOP_K,
    memoryAutoCapture: env.MEMORY_AUTO_CAPTURE,
    memoryExtractionModel: env.MEMORY_EXTRACTION_MODEL,
    assistantsEnabled: env.ASSISTANTS_ENABLED,
    assistantWorkspaceRoot: env.ASSISTANT_WORKSPACE_ROOT,
    assistantLearningEnabled: env.ASSISTANT_LEARNING_ENABLED,
    // Falls back to the operator-plane issuer: a deployment that already has OIDC
    // configured for the dashboard needs no second setting for delegation.
    assistantDelegationIssuer:
      env.ASSISTANT_DELEGATION_ISSUER ?? env.OIDC_ISSUER,
    assistantDelegationClientId:
      env.ASSISTANT_DELEGATION_CLIENT_ID ?? env.OIDC_CLIENT_ID,
    assistantDelegationClientSecret:
      env.ASSISTANT_DELEGATION_CLIENT_SECRET ?? env.OIDC_CLIENT_SECRET,
    rocketChatConnectOidcScopes: env.ROCKETCHAT_CONNECT_OIDC_SCOPES,
    // Falls back to the BYOK key: both protect recoverable third-party credentials,
    // and demanding a second key would leave delegation unavailable on every
    // deployment that already configured the first.
    assistantEncryptionKey:
      env.ASSISTANT_ENCRYPTION_KEY ?? env.BYOK_ENCRYPTION_KEY,
    rocketChatEnabled: env.ROCKETCHAT_ENABLED,
    rocketChatBaseUrl: env.ROCKETCHAT_BASE_URL,
    rocketChatBotUserId: env.ROCKETCHAT_BOT_USER_ID,
    rocketChatBotAuthToken: env.ROCKETCHAT_BOT_AUTH_TOKEN,
    rocketChatWebhookToken: env.ROCKETCHAT_WEBHOOK_TOKEN,
    rocketChatTimeoutMs: env.ROCKETCHAT_TIMEOUT_MS,
    rocketChatSweepIntervalMs: env.ROCKETCHAT_SWEEP_INTERVAL_MS,
    sandboxEnabled: env.SANDBOX_ENABLED,
    sandboxRuntime: env.SANDBOX_RUNTIME,
    sandboxImage: env.SANDBOX_IMAGE,
    sandboxUser: env.SANDBOX_USER,
    sandboxTimeoutMs: env.SANDBOX_TIMEOUT_MS,
    sandboxMemoryMb: env.SANDBOX_MEMORY_MB,
    sandboxCpus: env.SANDBOX_CPUS,
    sandboxNetworkEnabled: env.SANDBOX_NETWORK_ENABLED,
    operatorTokens: env.OPERATOR_TOKENS,
    operatorRoleClaim: env.OPERATOR_ROLE_CLAIM,
    operatorGroupsClaim: env.OPERATOR_GROUPS_CLAIM,
    operatorRoleMap: env.OPERATOR_ROLE_MAP,
    operatorDefaultRole: env.OPERATOR_DEFAULT_ROLE,
    tenantManagementEnabled: env.TENANT_MANAGEMENT_ENABLED,
    apiKeyPepper: env.API_KEY_PEPPER,
    transactionSigningAlg: env.TRANSACTION_SIGNING_ALG,
    transactionSigningKey: env.TRANSACTION_SIGNING_KEY,
    gitopsEnabled: env.GITOPS_ENABLED,
    gitopsWebhookSecret: env.GITOPS_WEBHOOK_SECRET,
    gitopsBranch: env.GITOPS_BRANCH,
  };
}

// ---------------------------------------------------------------------------
// YAML-based MCP server config loader
// ---------------------------------------------------------------------------

function loadMcpYamlConfig(flowsDir: string): McpServerConfig[] {
  const filePath = resolveConfigFile(flowsDir, "mcp");
  if (filePath === null) return [];

  let raw: unknown;
  try {
    raw = parseFlowFile(filePath);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "config",
        reason:
          "Failed to read/parse MCP config file — file-based MCP servers ignored",
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
    return [];
  }

  const payload =
    typeof raw === "object" && raw !== null && "servers" in raw
      ? (raw as Record<string, unknown>).servers
      : raw;

  const result = z.array(McpServerConfigSchema).safeParse(payload);
  if (!result.success) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "config",
        reason:
          "MCP config file failed schema validation — file-based MCP servers ignored",
        file: filePath,
        issues: result.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      })}\n`,
    );
    return [];
  }
  return result.data;
}

/**
 * Merges MCP server configs from the YAML file and the environment variable.
 * Environment variable entries take precedence over file entries with the same
 * name.
 */
function mergeMcpServers(
  fileServers: McpServerConfig[],
  envServers: McpServerConfig[],
): McpServerConfig[] {
  if (fileServers.length === 0) return envServers;
  if (envServers.length === 0) return fileServers;

  const envNames = new Set(envServers.map((s) => s.name));
  const filtered = fileServers.filter((s) => !envNames.has(s.name));
  return [...filtered, ...envServers];
}

// ---------------------------------------------------------------------------
// Token exchange (RFC 8693)
// ---------------------------------------------------------------------------

/**
 * Validates every `tokenExchange` block and resolves its `clientSecretEnv` (and
 * any actor `clientSecretEnv`) to the concrete secret. Mutates the passed
 * configs in place, so downstream consumers read a ready-to-use `clientSecret`
 * without re-touching `process.env`.
 *
 * Fails closed via `process.exit(1)` on any wiring problem: a token exchange
 * that is enabled but broken must not degrade to forwarding the caller's
 * un-exchanged token (wrong audience) — that would reintroduce exactly the
 * confused-deputy exposure the exchange exists to remove.
 */
function resolveTokenExchangeSecrets(servers: McpServerConfig[]): void {
  const fail = (message: string): never => {
    process.stderr.write(`[Config] ${message}\n`);
    process.exit(1);
  };

  for (const server of servers) {
    const exchange = server.tokenExchange;
    if (exchange === undefined) continue;

    // The exchanged token, like a forwarded one, is presented in the HTTP
    // Authorization header — which is only wired for forwardAuthToken servers.
    if (server.forwardAuthToken !== true) {
      fail(
        `MCP server ${server.name} configures tokenExchange but not forwardAuthToken=true; ` +
          `the exchanged token is forwarded in the Authorization header, so both are required.`,
      );
    }
    if (server.allowAnonymous === true) {
      fail(
        `MCP server ${server.name} cannot combine allowAnonymous=true with tokenExchange.`,
      );
    }

    const secret = process.env[exchange.clientSecretEnv];
    if (secret === undefined || secret.trim() === "") {
      fail(
        `MCP server ${server.name} tokenExchange.clientSecretEnv references ` +
          `${exchange.clientSecretEnv}, which is unset or empty.`,
      );
    }
    exchange.clientSecret = secret;

    if (exchange.actor !== undefined) {
      const actorSecret = process.env[exchange.actor.clientSecretEnv];
      if (actorSecret === undefined || actorSecret.trim() === "") {
        fail(
          `MCP server ${server.name} tokenExchange.actor.clientSecretEnv references ` +
            `${exchange.actor.clientSecretEnv}, which is unset or empty.`,
        );
      }
      exchange.actor.clientSecret = actorSecret;
    }
  }
}
