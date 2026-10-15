// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Zod schemas and TypeScript interfaces for the platform configuration.
 *
 * This module defines the canonical shapes (McpServerConfig, AppConfig,
 * EmbeddingConfig) and the raw-environment Zod schema (EnvSchema) used by
 * config/load.ts to validate process.env at startup.
 *
 * DOCUMENTED EXCEPTION: This file exceeds 800 lines because the EnvSchema is a
 * single monolithic Zod z.object() that maps every environment variable. The
 * schema cannot be meaningfully split without introducing fragile cross-file
 * composition that would hurt readability and maintainability.
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 10.5, 11.5
 */

import { z } from "zod";
import type { ProviderKeys } from "../graph/provider-key-pool.js";
import type {
  OperatorRole,
  OperatorTokenEntry,
} from "../middleware/operator-rbac.js";
import type { LlmConfig } from "../types/flow.js";
import type { LlmStreamFallbackPolicy } from "../llm-stream-fallback-policy.js";
import { parseCurrency, type Currency } from "../util/currency.js";
import type { ErasureTargetConfig } from "../compliance/erasure-targets.js";
import { SECURE_DEFAULTS } from "./defaults.js";

import type { ProviderInstance } from "./providers.js";
import { ProviderInstancesSchema } from "./providers.js";

// ---------------------------------------------------------------------------
// McpServerConfig
// ---------------------------------------------------------------------------

/**
 * Actor credential for an on-behalf-of (delegation) token exchange. When present
 * on a {@link TokenExchangeConfig}, the exchange additionally sends an
 * `actor_token` so the IdP records aiperator as the acting party in the issued
 * token's RFC 8693 `act` claim. Only the `client_credentials` grant is
 * implemented; the discriminated shape leaves room for `private_key_jwt` later.
 *
 * `clientSecretEnv` is the NAME of the environment variable holding the secret,
 * never the secret itself — a secret must not live in flow YAML or MCP_SERVERS.
 * The loader resolves it to `clientSecret` at startup.
 */
export interface TokenExchangeActorConfig {
  grant: "client_credentials";
  /** Token endpoint issuing the actor token. Defaults to the exchange endpoint. */
  tokenEndpoint?: string;
  clientId: string;
  /** Environment variable name holding the actor client secret. */
  clientSecretEnv: string;
  clientAuth?: "client_secret_post" | "client_secret_basic";
  scope?: string;
  audience?: string;
  /** Resolved from `clientSecretEnv` by the loader. Never set in config files. */
  clientSecret?: string;
}

/**
 * OAuth 2.0 Token Exchange (RFC 8693) target for one MCP server. When set on a
 * `forwardAuthToken` server, the wrapper exchanges the caller's verified bearer
 * for a token minted for THIS server (bound to {@link audience}, optionally
 * scope-reduced) instead of forwarding the raw login token. See
 * `src/auth/token-exchange.ts` for the rationale.
 */
export interface TokenExchangeConfig {
  /** Token endpoint of the exchanging provider. Required unless `issuer` is set for discovery. */
  tokenEndpoint?: string;
  /** OIDC issuer whose discovery document yields the token endpoint (alternative to `tokenEndpoint`). */
  issuer?: string;
  /** `client_id` of the confidential client performing the exchange. */
  clientId: string;
  /** Environment variable name holding the exchange client secret. Never the secret itself. */
  clientSecretEnv: string;
  clientAuth?: "client_secret_post" | "client_secret_basic";
  /** Target provider's `client_id` — the RFC 8693 `audience`. */
  audience: string;
  /** Space-delimited scopes to request. Some IdPs (Authentik) mint no scope when omitted. */
  scope?: string;
  /** `requested_token_type`. Optional; defaults to access_token at the IdP. */
  requestedTokenType?: string;
  timeoutMs?: number;
  /** Actor for a delegation (OBO) exchange. Absent → impersonation (`sub` = user, no `act`). */
  actor?: TokenExchangeActorConfig;
  /** Resolved from `clientSecretEnv` by the loader. Never set in config files. */
  clientSecret?: string;
}

export interface McpServerConfig {
  name: string;
  url: string;
  transport: "http" | "stdio" | "sse";
  /** Explicit wire profile for HTTP. Omitted/"2025" keeps the existing SDK transport. */
  profile?: "2025" | "2026-07-28";
  /** Alias for profile, accepted for configuration compatibility. */
  protocolVersion?: "2025" | "2026-07-28";
  /**
   * Per-request wall-clock timeout for a single MCP tool call attempt (ms).
   * Overrides the wrapper-wide default (5 s), which is too tight for
   * embedding-backed searches (hybrid + HyDE + rerank) that legitimately take
   * longer under concurrent load. Bounds one attempt; retries still follow
   * the tool's retryability annotations (unless `retryAttempts` overrides).
   */
  requestTimeoutMs?: number;
  /**
   * Bound for the MCP initialize handshake of this server (ms): startup
   * connect, on-demand connect after a failed startup/recovery, transport
   * recovery and periodic reconnect. Overrides the wrapper default (4 s).
   */
  connectTimeoutMs?: number;
  /**
   * Total call attempts for retryable tools on this server (default 3, from
   * the readOnlyHint/idempotentHint gate). Set higher when a server is known
   * to be slow-but-recoverable; set 1 to disable retries entirely.
   */
  retryAttempts?: number;
  /** Delay between MCP 2026 task status requests. */
  taskPollingIntervalMs?: number;
  /** Hard limit on MCP 2026 task status requests. */
  taskPollingMaxAttempts?: number;
  /** Wall-clock task polling budget. */
  taskPollingDeadlineMs?: number;
  /** Return durable MCP task handles to the caller instead of polling them inline. */
  taskMode?: "poll" | "handle";
  /** Protected parameter names injected by the MCP wrapper. Default: ["user_token","user_email","client_id"] */
  protectedParams?: string[];
  /**
   * Parameters that are removed from the tool schema shown to the LLM and
   * always injected with a fixed value on every tool call (the model can
   * neither see nor override them). Values may contain `{{...}}` placeholders
   * resolved per-request from the {@link RequestContext} and the current clock:
   *   {{ctx.userId}} {{ctx.userName}} {{ctx.userEmail}} {{ctx.clientId}}
   *   {{ctx.role}} {{ctx.language}} {{ctx.plan}} {{ctx.executionId}}
   *   {{now.date}} {{now.timestamp}} {{now.weekday}}
   * A string consisting of a single placeholder that resolves to nothing
   * becomes `null` (preserving the field). Placeholders inside larger strings
   * resolve to the empty string when unset.
   */
  injectedParams?: Record<string, unknown>;
  /** Optional HTTP headers sent with every request (e.g. Authorization). */
  headers?: Record<string, string>;
  /**
   * Allow calls without a caller credential. This is accepted only when the
   * runtime itself uses AUTHN_MODE=disabled and cannot be combined with
   * forwardAuthToken. Opt-in; protected caller-supplied arguments are still
   * stripped and no synthetic credential is forwarded.
   */
  allowAnonymous?: boolean;
  /**
   * Forward the caller's own SSO/OAuth token (the bearer with which the request
   * authenticated against aiperator) to this MCP server as the
   * `Authorization: Bearer <token>` header, instead of injecting it as the
   * `user_token` tool argument. Enables per-user authentication against servers
   * that verify a JWT from the HTTP header (e.g. an mcpgate instance in OAuth
   * mode). The wrapper keeps one MCP session per distinct caller token so each
   * call runs under that caller's identity. The static `headers` (if any) are
   * used only for the startup tool-listing connection (a bootstrap token).
   * Opt-in; default false leaves the existing argument-injection behaviour.
   */
  forwardAuthToken?: boolean;
  /**
   * OAuth 2.0 Token Exchange (RFC 8693). When set, the wrapper exchanges the
   * caller's verified bearer for a token minted for THIS server (bound to
   * `tokenExchange.audience`) and forwards THAT as `Authorization: Bearer`,
   * instead of the raw login token. Requires `forwardAuthToken: true` (the
   * exchanged token, like a forwarded one, travels in the header, not as a tool
   * argument). Adding an `actor` upgrades the exchange to on-behalf-of
   * delegation with an RFC 8693 `act` claim. Opt-in; absent leaves plain
   * passthrough forwarding.
   */
  tokenExchange?: TokenExchangeConfig;
}

// ---------------------------------------------------------------------------
// EmbeddingConfig
// ---------------------------------------------------------------------------

/**
 * Provider + model for text embeddings (semantic cache / future RAG).
 *
 * `provider` is a named instance from `PROVIDERS` or a bare protocol name; only
 * the openai-compatible, google and ollama protocols are embedding-capable.
 */
export interface EmbeddingConfig {
  provider: string;
  model: string;
}

// ---------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------

export interface AppConfig {
  /** The applied configuration preset name (see `src/config/profiles.ts`), if any. */
  profile?: string;
  port: number;
  flowsDir: string;
  pluginsDir?: string;
  pluginsAllowlist?: string[];
  pluginsManifestPath?: string;
  pluginsSandbox?: boolean;
  pluginsSandboxTimeoutMs?: number;
  defaultLlm?: LlmConfig;
  appEnv?: "development" | "production";
  monitoringTransport: "sse" | "websocket";
  mcpServers: McpServerConfig[];
  /** Controls whether breaking MCP schema drift is reported or rejected. */
  mcpSchemaCompatibilityMode?: "report" | "strict";
  /**
   * Named inference endpoints from `PROVIDERS`. An LlmConfig `provider` should
   * use one of these names; many instances may share a protocol. Bare protocol
   * names remain SDK-default compatibility references, but no legacy
   * per-protocol endpoint or credential environment variables are loaded.
   */
  providers?: ProviderInstance[];
  anthropicPromptCacheEnabled?: boolean;
  rerankEnabled?: boolean;
  /** Optional TEI HTTP endpoint. When set, TEI is the primary reranker. */
  rerankUrl?: string;
  rerankModel?: string;
  /** Name of the bedrock-protocol `PROVIDERS` entry used by legacy Bedrock-only mode. */
  rerankProvider?: string;
  rerankRegion?: string;
  /** Bedrock runtime fallback used only when the TEI primary returns no hits. */
  rerankFallbackModel?: string;
  rerankFallbackProvider?: string;
  rerankFallbackRegion?: string;
  /** Max texts per TEI `/rerank` request (`RERANK_BATCH_SIZE`, default 32). */
  rerankBatchSize?: number;
  corsOrigins: string[];
  monitoringAuthRequired: boolean;
  debugCaptureRequestTokens?: boolean;
  monitoringTicketSecret?: string;
  monitoringTicketTtlSeconds?: number;
  /** HMAC secret for signed external audit-chain anchors (tamper-evidence). */
  auditAnchorSecret?: string;
  /** Interval between automatic audit anchors (ms). Default 6h. */
  auditAnchorIntervalMs?: number;
  /** Optional append-only JSONL file to persist anchors outside the audit DB. */
  auditAnchorFile?: string;
  /**
   * Remote `POST /v1/erasure` endpoints the DSAR orchestrator fans out to
   * (Req 2.9). Parsed from the `ERASURE_TARGETS` JSON env variable.
   */
  erasureTargets?: ErasureTargetConfig[];
  /**
   * Ed25519 private key (PEM or raw 32-byte base64) used to sign
   * Erasure_Receipts (Req 2.11). Falls back to an audit-anchor HMAC when
   * unset — the algorithm is recorded in the receipt envelope either way.
   */
  erasureReceiptSigningKey?: string;
  /**
   * Master switch for Decision_Receipts (Req 15.1). When true, every chat
   * completion and every tool call yields a signed COSE_Sign1 receipt.
   * Requires `receiptSigningKey` — enabling without a key fails at startup.
   */
  decisionReceiptsEnabled?: boolean;
  /**
   * Ed25519 private key (PEM or raw 32-byte base64 seed) signing
   * Decision_Receipts (Req 15.3). No HMAC fallback: receipts must be
   * verifiable offline via JWKS, so the key must be asymmetric.
   */
  receiptSigningKey?: string;
  /**
   * HMAC secret for signing Verifiable Evidence Bundles
   * (`GET /monitoring/explain/:executionId/bundle`). Falls back to
   * `auditAnchorSecret` when unset — see `routes/explain.ts`.
   */
  evidenceBundleSecret?: string;
  /** Optional path to a labeled PII-recall dataset — cited as DLP effectiveness evidence in the dossier. */
  piiRecallDataset?: string;
  /** Webhook fired when a flow's cost/quality SLO transitions to breached. */
  sloAlertWebhookUrl?: string;
  /** Provider→region map (JSON) used by the RoPA residency assessment. */
  providerRegions?: Record<string, string>;
  /** Providers treated as local/on-prem in the RoPA (data never leaves). */
  localProviders?: string[];
  /** kg CO2e emitted per kWh of grid electricity, for the FinOps CO2 report. Default 0.4. */
  co2GridCarbonIntensity?: number;
  /** Per-provider/model energy-factor overrides (JSON array) for the FinOps CO2 report. */
  co2EnergyFactors?: import("../observability/finops.js").EnergyFactor[];
  /** Unified request authentication mode. When omitted, legacy verifier settings are inferred. */
  authnMode?: "disabled" | "token" | "oidc" | "token_or_oidc";
  /** Global switch for business authorization (policy/RBAC/ACL/approval), not integrity checks. */
  authzEnabled?: boolean;
  /** Whether tenant identity must be present in verified credentials. */
  tenantIsolationEnabled?: boolean;
  /** Canonical tenant used when tenant isolation is disabled. */
  defaultTenantId?: string;
  jwtSecret?: string;
  jwtJwksUrl?: string;
  /** Expected issuer/audience for a directly configured JWKS verifier. */
  jwtIssuer?: string;
  jwtAudience?: string;
  oidcIssuer?: string;
  oidcAudience?: string;
  /** JWT claim names containing flow authorization scopes. Default: scope, scp. */
  flowScopeClaims?: string[];
  inferenceExtraOidcIssuers?: { issuer: string; audience?: string }[];
  /**
   * Issuer → tenant binding (`JWT_ISSUER_TENANTS`): which tenants a token from
   * each issuer may claim. When set, a verified token whose `iss` is not listed,
   * or whose tenant claim is not in its issuer's list, is rejected. `"*"`
   * allows every tenant for that issuer; tokens without `iss` use the key `""`.
   */
  jwtIssuerTenants?: Record<string, string[]>;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcSessionSecret?: string;
  oidcSessionTtlSeconds?: number;
  oidcScopes?: string;
  oidcRefreshSessionTtlSeconds?: number;
  oidcRedirectUri?: string;
  oidcDashboardUrl?: string;
  oidcAutoLogin?: boolean;
  redisUrl?: string;
  databaseUrl?: string;
  databasePoolMax?: number;
  /**
   * Effective value of MIGRATE_ON_START — `loadConfig()` always fills it
   * (requirement 12.4: true outside production, false in production unless
   * set explicitly). Optional like the other database fields so hand-built
   * test configs stay valid; boot code treats it through `loadConfig()`.
   */
  migrateOnStart?: boolean;
  tenantRlsEnabled?: boolean;
  tenantRlsRequired?: boolean;
  clusterStateOptOut?: boolean;
  databaseOperatorUrl?: string;
  monitoringMaxConnections?: number;
  responseCacheEnabled?: boolean;
  responseCacheTtlSeconds?: number;
  responseCacheMaxEntries?: number;
  semanticCacheEnabled?: boolean;
  semanticCacheThreshold?: number;
  semanticCacheMaxEntries?: number;
  semanticCacheTtlSeconds?: number;
  embeddingCacheEnabled?: boolean;
  embeddingCacheMaxEntries?: number;
  embeddingCacheTtlSeconds?: number;
  routerQualityHalfLifeMs?: number;
  retentionEnabled?: boolean;
  retentionSweepIntervalMs?: number;
  retentionDefaultMaxAgeDays?: number;
  retentionMaxAgeDays?: Record<string, number>;
  byokEnabled?: boolean;
  /** Whether tenant BYOK credentials are optional, disabled, or mandatory for every execution. */
  byokMode?: "disabled" | "optional" | "required";
  /** Deny residency-constrained flows when the provider region cannot be established. */
  complianceFailClosedUnknownRegion?: boolean;
  byokEncryptionKey?: string;
  byokCacheTtlSeconds?: number;
  piiVaultEnabled?: boolean;
  piiVaultEncryptionKey?: string;
  piiVaultTypes?: string[];
  /** Comma-separated list of PII detector backends to enable: "regex", "ner", "remote". Default: "regex". */
  piiDetectors?: string[];
  /** BERT-NER model identifier (HuggingFace hub ID or local path). */
  piiNerModel?: string;
  /** BERT-NER minimum confidence threshold (0–1). Default: 0.75. */
  piiNerConfidence?: number;
  /** Local cache directory for downloaded NER models. */
  piiNerCacheDir?: string;
  /** Base URL of the remote PII detection service. */
  piiRemoteEndpoint?: string;
  /** API key / bearer token for the remote PII detection service. */
  piiRemoteApiKey?: string;
  /** Per-request timeout for the remote PII detector in ms. Default: 3000. */
  piiRemoteTimeoutMs?: number;
  /** Language hint for the remote PII detector. Default: "de". */
  piiRemoteLanguage?: string;
  /** Detector pipeline fail mode: "open" (skip failed detectors) or "closed" (fail entire detection). Default: "open". */
  piiDetectorFailMode?: "open" | "closed";
  /** Per-detector timeout in ms for the registry. Default: 5000. */
  piiDetectorTimeoutMs?: number;
  /**
   * Multimodal (image/file) PII handling for the vault (ADR-0016): "off"
   * (pass attachments through, default), "block" (strip attachments before the
   * prompt reaches the provider), or "redact" (send each attachment to the
   * configured image redactor). Attachments cannot be reversibly tokenized like
   * text, so this is a one-way control.
   */
  piiVaultMultimodalMode?: "off" | "block" | "redact" | "describe";
  /** Behaviour when the image redactor/describer fails: "open" (strip the attachment) or "closed" (reject the request). Default: "open". */
  piiVaultMultimodalFailMode?: "open" | "closed";
  /** Endpoint of an external image-redaction service (e.g. presidio-image-redactor) for `redact` mode. */
  piiImageRemoteEndpoint?: string;
  /** API key / bearer token for the image-redaction service. */
  piiImageRemoteApiKey?: string;
  /** Per-request timeout for the image-redaction service in ms. Default: 5000. */
  piiImageRemoteTimeoutMs?: number;
  /**
   * Vision model used by `describe` mode to convert an attachment into text
   * (which is then tokenized like normal content). Should be a LOCAL/on-prem
   * model so the raw image never leaves your infrastructure.
   */
  piiImageDescribeModel?: LlmConfig;
  /** Optional system-prompt override steering the image description. */
  piiImageDescribePrompt?: string;
  idempotencyEnabled?: boolean;
  idempotencyTtlSeconds?: number;
  idempotencyMaxEntries?: number;
  embeddingModel?: EmbeddingConfig;
  embeddingFallbackModel?: EmbeddingConfig;
  embeddingExpectedDimension?: number;
  checkpointingEnabled?: boolean;
  maxConcurrentExecutions: number;
  maxGlobalConcurrentExecutions?: number;
  logLevel: "debug" | "info" | "warn" | "error";
  maxToolSteps: number;
  executionTimeoutMs?: number;
  /**
   * Interval (ms) between SSE keepalive frames on a streaming response. When no
   * chunk has been written for this long, the streaming path emits a
   * lightweight SSE comment frame so proxies/clients keep the connection open
   * during long silent LLM phases (e.g. a slow agent-harness planner/worker
   * call). 0 disables the heartbeat. Default 15000.
   */
  sseHeartbeatMs?: number;
  healthProbeTimeoutMs?: number;
  requireJwtVerification?: boolean;
  allowUnverifiedJwt?: boolean;
  toolAuthzFailClosed?: boolean;
  maxRequestBodyBytes?: number;
  rateLimitPerMinute?: number;
  rateLimitPerUserPerMinute?: number;
  /** Additive IP-based gate executed before authentication. Default 0 (disabled). */
  rateLimitPreAuthPerMinute?: number;
  /** Additive verified-principal/tenant gate executed after authentication. Default 0 (disabled). */
  rateLimitPostAuthPerMinute?: number;
  rateLimitFailMode?: "open" | "closed";
  metricsEnabled?: boolean;
  metricsAuthRequired?: boolean;
  llmMaxAttempts?: number;
  llmRetryBackoffMs?: number;
  /** Hard deadline for one provider request/stream attempt. */
  llmRequestTimeoutMs?: number;
  /**
   * Reuse sockets (HTTP keep-alive) for `openai`/`ollama` provider requests.
   * Default true; `false` opens a fresh connection per request. Overridable
   * per provider via `PROVIDERS[].keepAlive`.
   */
  llmHttpKeepAlive?: boolean;
  /** Absolute generated-text ceiling per provider attempt. */
  llmMaxOutputChars?: number;
  /** Controls semantic response fallbacks while preserving transport retries. */
  llmStreamFallbackPolicy?: LlmStreamFallbackPolicy;
  fallbackLlm?: LlmConfig;
  fallbackChain?: LlmConfig[];
  maxQueueDepth?: number;
  budgetDailyPerTenant?: number;
  /**
   * Display currency for every cost figure in the system (default EUR).
   * Purely a label — cost values are never converted between currencies;
   * the pricing table is interpreted as denominated in this currency.
   */
  currency?: Currency;
  llmPricing?: Record<string, { prompt: number; completion: number }>;
  tracingEnabled?: boolean;
  otelExporterOtlpEndpoint?: string;
  otelServiceName?: string;
  outputGuardrailsEnabled?: boolean;
  guardrailRedactPii?: boolean;
  guardrailPiiTypes?: string[];
  guardrailBlockedPatterns?: string[];
  guardrailMode?: "redact" | "block";
  toolEgressGuardrailEnabled?: boolean;
  toolEgressMode?: "redact" | "block";
  /** Egress_Guard: split-DNS host exceptions allowed to reach private ranges. */
  egressAllowPrivateHosts?: string[];
  /** Egress_Guard: optional destination allow-list (empty = any public host). */
  egressAllowedHosts?: string[];
  /** Egress_Guard: maximum response body size in bytes (0 = unlimited). */
  egressMaxResponseBytes?: number;
  /** Egress_Guard: default timeout in ms for calls without a caller signal. */
  egressTimeoutMs?: number;
  toolOutputValidatorEnabled?: boolean;
  toolOutputValidatorMode?: "flag" | "redact";
  toolOutputValidatorThreshold?: number;
  approvalGateEnabled?: boolean;
  approvalRequireTools?: string[];
  approvalTimeoutMs?: number;
  approvalBaseUrl?: string;
  /** Explicit browser origins permitted to embed in-chat approval widgets. */
  approvalFrameAncestors?: string[];
  mediaBaseUrl?: string;
  groundednessEnabled?: boolean;
  groundednessMode?: "annotate" | "block";
  groundednessPassThreshold?: number;
  groundednessType?: "lexical" | "semantic" | "llm";
  groundednessSemanticThreshold?: number;
  groundednessMaxSourceChunks?: number;
  groundednessEmbeddingModel?: EmbeddingConfig;
  groundednessJudgeModel?: LlmConfig;
  canaryJudgeModel?: LlmConfig;
  replayEnabled?: boolean;
  optimizerEnabled?: boolean;
  optimizerGeneratorModel?: LlmConfig;
  optimizerJudgeModel?: LlmConfig;
  optimizerScheduleEnabled?: boolean;
  optimizerScheduleFlows?: string[];
  optimizerScheduleIntervalMs?: number;
  optimizerScheduleMinNewSamples?: number;
  optimizerScheduleCooldownMs?: number;
  optimizerScheduleAutoPromote?: boolean;
  optimizerScheduleVariantCount?: number;
  optimizerScheduleMinScoreImprovement?: number;
  optimizerScheduleGoal?: string;
  /**
   * When true (the safe default), the Continuous Safety & Quality Autopilot
   * never auto-promotes an optimized variant — it runs the full cycle and
   * surfaces the recommendation, but a human must call the optimizer's
   * `promote()` explicitly. Set to false to let the autopilot promote
   * automatically (subject to the judge≠candidate self-grading guard and the
   * drift-guard promotion cap). The production-readiness gate treats an
   * active autopilot with this unset as fatal in `production`.
   */
  autopilotRequireApproval?: boolean;
  /** Max automatic promotions per flow within `autopilotDriftWindowMs`. Default 3. */
  autopilotMaxAutoPromotionsPerWindow?: number;
  /** Rolling window (ms) the drift-guard promotion count is measured over. Default 86400000 (24h). */
  autopilotDriftWindowMs?: number;
  redTeamEnabled?: boolean;
  redTeamScheduleFlows?: string[];
  redTeamIntervalMs?: number;
  redTeamAttacksPerRun?: number;
  redTeamJudgeModel?: LlmConfig;
  redTeamJudgeThreshold?: number;
  redTeamPostureAlertThreshold?: number;
  redTeamAlertWebhookUrl?: string;
  redTeamAutoTune?: boolean;
  redTeamAutoTuneCeiling?: number;
  /** URL of a JSON endpoint serving `{ templates: SerializableAttackTemplate[] }` for hot-updates. */
  redTeamAttacksUrl?: string;
  /** Interval (ms) between remote attack-library polls. Default 6 hours. */
  redTeamAttacksPollIntervalMs?: number;
  flowEditorEnabled?: boolean;
  providerKeys?: ProviderKeys;
  budgetAlertThresholds?: number[];
  budgetAlertWebhookUrl?: string;
  costAnomalyEnabled?: boolean;
  costAnomalyWindowMs?: number;
  costAnomalyBaselineDays?: number;
  costAnomalyMinBaselineDays?: number;
  costAnomalySpikeMultiplier?: number;
  costAnomalyMinAbsolute?: number;
  costAnomalyCooldownMs?: number;
  inputGuardrailsEnabled?: boolean;
  inputGuardrailMode?: "flag" | "block";
  inputGuardrailThreshold?: number;
  inputGuardrailModel?: LlmConfig;
  inputGuardrailModelMinScore?: number;
  /**
   * Fail mode of the model-based input guardrail (Requirement 7.5). Resolved
   * in load.ts: `open` in Development, `closed` in Production when unset.
   */
  inputGuardrailModelFailMode?: "open" | "closed";
  /** Per-call character budget for chunked classification (Requirement 7.6). */
  inputGuardrailMaxChars?: number;
  jobsEnabled?: boolean;
  jobsTtlSeconds?: number;
  jobsMaxEntries?: number;
  /**
   * Durable Agent Runtime — crash-resilient async jobs (see
   * `job-store.ts`/`job-recovery-sweeper.ts`'s module doc comments).
   */
  jobRecoveryEnabled?: boolean;
  jobRecoveryMaxAttempts?: number;
  jobRecoveryLeaseMs?: number;
  jobRecoverySweepIntervalMs?: number;
  ragEnabled?: boolean;
  ragMaxDocuments?: number;
  clientToolsEnabled?: boolean;
  /** Refuse webhook triggers without a per-flow HMAC secret. Default true. */
  triggersRequireSignature?: boolean;
  /** Refuse the GitOps webhook without a configured secret. Default true. */
  gitopsRequireSignature?: boolean;
  /**
   * Allow the `X-OpenWebUI-User-*` headers / request-body metadata to supply
   * `role`/`clientId`/`plan` when the verified token carries no such claim.
   * Default false — see `TRUSTED_IDENTITY_HEADERS` in the env schema.
   */
  trustedIdentityHeaders?: boolean;
  /**
   * When enabled, profile fields (`email`, `userId`, `userName`) come only from
   * a verified principal/JWT. OWUI headers and request metadata are rejected.
   * Default false preserves the historical fallback chain exactly.
   */
  strictIdentityHeaders?: boolean;
  memoryEnabled?: boolean;
  memoryTopK?: number;
  memoryAutoCapture?: boolean;
  memoryExtractionModel?: LlmConfig;
  // -------------------------------------------------------------------------
  // Per-user assistants
  // -------------------------------------------------------------------------
  /**
   * Enables the per-user assistant subsystem: souls, learned procedures, private
   * workspaces, delegated credentials and peer messaging.
   *
   * Off by default. It is additive — the `assistant-context` and `assistant-learn`
   * nodes pass their turn through unchanged when it is off, so a flow using them
   * still answers on a deployment that has not enabled it.
   */
  assistantsEnabled?: boolean;
  /** Root directory under which per-assistant workspaces are created. */
  assistantWorkspaceRoot?: string;
  /**
   * Whether the post-turn learning pass runs. Requires `assistantsEnabled`.
   *
   * Separate from the master switch because learning is the part with a per-turn
   * model cost, and an operator may reasonably want assistants without it.
   */
  assistantLearningEnabled?: boolean;
  /**
   * OIDC issuer that delegation grants are held against.
   *
   * Defaults to `oidcIssuer` so a deployment with the operator-plane login already
   * configured needs no second setting. Without an issuer, background runs resolve
   * to no authority with a stated reason rather than failing.
   */
  assistantDelegationIssuer?: string;
  /** Confidential OIDC client used both to obtain and refresh delegated grants. */
  assistantDelegationClientId?: string;
  assistantDelegationClientSecret?: string;
  /** OIDC scopes requested by the Rocket.Chat connect flow. */
  rocketChatConnectOidcScopes?: string;
  /**
   * Base64 32-byte key encrypting delegated refresh tokens at rest.
   *
   * Falls back to `byokEncryptionKey`, because both protect recoverable
   * third-party credentials and requiring a second key would make delegation
   * unavailable on every deployment that already configured the first. A dedicated
   * key is still preferable: it lets an operator rotate assistant delegations
   * without invalidating tenant provider keys.
   */
  assistantEncryptionKey?: string;
  /** Enables the bidirectional Rocket.Chat assistant channel. */
  rocketChatEnabled?: boolean;
  /** Canonical HTTPS origin of the single trusted Rocket.Chat server. */
  rocketChatBaseUrl?: string;
  /** Rocket.Chat user id owning the bot personal access token. */
  rocketChatBotUserId?: string;
  /** Bot personal access token; held only in process configuration. */
  rocketChatBotAuthToken?: string;
  /** Shared secret supplied by the Rocket.Chat outgoing integration. */
  rocketChatWebhookToken?: string;
  /** Timeout for one Rocket.Chat REST delivery. */
  rocketChatTimeoutMs?: number;
  /** Durable outbox polling interval. */
  rocketChatSweepIntervalMs?: number;
  // -------------------------------------------------------------------------
  // Assistant code sandbox
  // -------------------------------------------------------------------------
  /** Enables container-backed script execution for assistants. */
  sandboxEnabled?: boolean;
  /** Container binary, `docker` or `podman`. */
  sandboxRuntime?: string;
  /** Image scripts run in. Operator-supplied and fixed; never model-selected. */
  sandboxImage?: string;
  /** `uid:gid` inside the container. Non-root. */
  sandboxUser?: string;
  /** Wall-clock ceiling for one script run, in milliseconds. */
  sandboxTimeoutMs?: number;
  /** Container memory ceiling, in MB. */
  sandboxMemoryMb?: number;
  /** CPU share, in cores. */
  sandboxCpus?: number;
  /**
   * Whether sandboxed scripts may reach the network.
   *
   * Default false, and deliberately an operator setting rather than something an
   * assistant can request: a script with network access can exfiltrate the
   * workspace it was given to analyse.
   */
  sandboxNetworkEnabled?: boolean;
  operatorTokens?: OperatorTokenEntry[];
  operatorRoleClaim?: string;
  operatorGroupsClaim?: string;
  operatorRoleMap?: Record<string, OperatorRole>;
  operatorDefaultRole?: OperatorRole;
  tenantManagementEnabled?: boolean;
  /**
   * Server-side pepper for API-key hashing (`API_KEY_PEPPER`). When set, new
   * API keys are stored as HMAC-SHA-256(pepper, rawKey) instead of unsalted
   * SHA-256, so a database dump alone cannot be brute-forced offline. Legacy
   * SHA-256 hashes migrate lazily on the next successful lookup.
   */
  apiKeyPepper?: string;
  /**
   * Transaction-token signing algorithm (`TRANSACTION_SIGNING_ALG`, Req 7.11).
   * Defaults to HS256; ES256/EdDSA sign with the PKCS8 PEM in
   * `transactionSigningKey` and publish the public key under
   * `/.well-known/atf-transaction-jwks.json` so verifiers (Gate) never need
   * the shared secret.
   */
  transactionSigningAlg?: "HS256" | "ES256" | "EdDSA";
  /** PKCS8 PEM private signing key for asymmetric transaction tokens. */
  transactionSigningKey?: string;
  gitopsEnabled?: boolean;
  gitopsWebhookSecret?: string;
  gitopsBranch?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const TokenExchangeActorConfigSchema = z.object({
  grant: z.literal("client_credentials"),
  tokenEndpoint: z.string().url().optional(),
  clientId: z.string().min(1),
  clientSecretEnv: z.string().min(1),
  clientAuth: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
  scope: z.string().min(1).optional(),
  audience: z.string().min(1).optional(),
});

export const TokenExchangeConfigSchema = z
  .object({
    tokenEndpoint: z.string().url().optional(),
    issuer: z.string().url().optional(),
    clientId: z.string().min(1),
    clientSecretEnv: z.string().min(1),
    clientAuth: z.enum(["client_secret_post", "client_secret_basic"]).optional(),
    audience: z.string().min(1),
    scope: z.string().min(1).optional(),
    requestedTokenType: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
    actor: TokenExchangeActorConfigSchema.optional(),
  })
  .refine((cfg) => cfg.tokenEndpoint !== undefined || cfg.issuer !== undefined, {
    message: "tokenExchange requires either tokenEndpoint or issuer",
  });

export const McpServerConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  transport: z.enum(["http", "stdio", "sse"]),
  profile: z.enum(["2025", "2026-07-28"]).optional(),
  protocolVersion: z.enum(["2025", "2026-07-28"]).optional(),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  connectTimeoutMs: z.number().int().min(500).max(120_000).optional(),
  retryAttempts: z.number().int().min(1).max(10).optional(),
  taskPollingIntervalMs: z.number().int().min(0).max(60_000).optional(),
  taskPollingMaxAttempts: z.number().int().min(1).max(10_000).optional(),
  taskPollingDeadlineMs: z.number().int().min(1).max(3_600_000).optional(),
  taskMode: z.enum(["poll", "handle"]).optional(),
  protectedParams: z.array(z.string()).optional(),
  injectedParams: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowAnonymous: z.boolean().optional(),
  forwardAuthToken: z.boolean().optional(),
  tokenExchange: TokenExchangeConfigSchema.optional(),
});

export const LlmParametersSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(32768).optional(),
  })
  .passthrough();

/**
 * `provider` is a free-form reference: either a name from `PROVIDERS` or a bare
 * protocol name. It is NOT validated against an enum here, because the set of
 * valid names depends on `PROVIDERS` in the same environment — a cross-field
 * check. `loadConfig` resolves every reference after parsing and exits with a
 * clear message on an unknown one, so a typo still fails loudly at startup.
 */
export const LlmConfigSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(256),
  parameters: LlmParametersSchema.optional(),
});

export const EmbeddingConfigSchema = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(256),
});

/**
 * Raw environment variable schema.
 * All values come in as strings; coerce/transform as needed.
 */
export const EnvSchema = z.object({
  /**
   * Optional configuration preset. Fills a curated bundle of defaults for unset
   * variables (explicit env vars always win). See `src/config/profiles.ts` for
   * the valid names (`dev`, `secure`, `regulated`, `regulated-multitenant`,
   * `performance`). Applied before parsing, so it is validated there, not here.
   */
  PROFILE: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FLOWS_DIR: z.string().default("./flows"),
  PLUGINS_DIR: z.string().optional(),
  /** Comma-separated node-type plugins that may be loaded from PLUGINS_DIR (`*` allows all). */
  PLUGINS_ALLOWLIST: z
    .string()
    .optional()
    .transform((raw): string[] | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      if (raw.trim() === "*") return ["*"];
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }),
  PLUGINS_MANIFEST_PATH: z.string().optional(),
  /** `true` runs node-type plugins in isolated Bun Workers without environment/secret access; otherwise plugin code runs in-process with full privileges. */
  PLUGINS_SANDBOX: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** Maximum run time of one sandboxed plugin call (PLUGINS_SANDBOX=true) before the worker is terminated, 1–300 s. */
  PLUGINS_SANDBOX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300_000)
    .default(30_000),
  APP_ENV: z.enum(["development", "production"]).default("development"),
  MONITORING_TRANSPORT: z.enum(["sse", "websocket"]).default("sse"),
  MCP_SCHEMA_COMPATIBILITY_MODE: z.enum(["report", "strict"]).default("report"),
  MCP_SERVERS: z
    .string()
    .optional()
    .transform((raw, ctx): McpServerConfig[] => {
      if (raw === undefined || raw.trim() === "") return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MCP_SERVERS must be a valid JSON array",
        });
        return z.NEVER;
      }
      const result = z.array(McpServerConfigSchema).safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({ ...issue, path: ["MCP_SERVERS", ...issue.path] });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  /**
   * Named inference endpoints, e.g.
   * `[{"name":"gpuvllm","protocol":"openai","url":"http://10.0.0.2:8000/v1"}]`.
   * Any number of instances may share a protocol, which is what makes two vLLM
   * servers (or vLLM next to LM Studio) expressible. See `./providers.ts`.
   */
  PROVIDERS: z
    .string()
    .optional()
    .transform((raw, ctx): ProviderInstance[] => {
      if (raw === undefined || raw.trim() === "") return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "PROVIDERS must be a valid JSON array of provider objects",
        });
        return z.NEVER;
      }
      const result = ProviderInstancesSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({ ...issue, path: ["PROVIDERS", ...issue.path] });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  /**
   * Prompt-cache breakpoints for the Anthropic/Bedrock message shape. A
   * PROMPT-CONSTRUCTION switch, not an endpoint setting — which is why it stays
   * an environment variable while endpoints and credentials moved to `PROVIDERS`.
   */
  ANTHROPIC_PROMPT_CACHE: z
    .string()
    .optional()
    .transform(
      (raw): boolean =>
        raw === undefined || raw === "" || raw === "true" || raw === "1",
    ),
  RERANK_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  RERANK_URL: z
    .union([z.literal(""), z.string().url()])
    .optional()
    .transform((raw): string | undefined =>
      raw === undefined || raw === "" ? undefined : raw,
    ),
  RERANK_MODEL: z.string().optional(),
  /**
   * Name of the `PROVIDERS` entry (bedrock protocol) whose region/credentials the
   * Cohere Rerank client uses.
   */
  RERANK_PROVIDER: z.string().min(1).max(64).optional(),
  /** Overrides the provider's region; Rerank is not offered in every region. */
  RERANK_REGION: z.string().optional(),
  RERANK_FALLBACK_MODEL: z.string().optional(),
  RERANK_FALLBACK_PROVIDER: z.string().min(1).max(64).optional(),
  RERANK_FALLBACK_REGION: z.string().optional(),
  /**
   * Max texts per TEI /rerank request (TEI max_client_batch_size). Larger
   * inputs are split client-side into sequential batches. Default 32.
   */
  RERANK_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).optional(),
  /** Comma-separated origins allowed for cross-origin browser requests. Empty (default) allows none. */
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((raw): string[] => {
      if (raw === undefined || raw.trim() === "")
        return SECURE_DEFAULTS.corsOrigins;
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }),
  /** Require operator authentication for the monitoring/operator plane (`/monitoring/*`, `/admin/*`, flow management). Default `true` (secure default). */
  MONITORING_AUTH: z
    .string()
    .optional()
    .transform((raw): boolean =>
      raw === undefined || raw === ""
        ? SECURE_DEFAULTS.monitoringAuthRequired
        : raw === "true" || raw === "1",
    ),
  /** SECURITY: `true` records request credentials in debug traces. Default `false`; never enable in production. */
  DEBUG_CAPTURE_REQUEST_TOKENS: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** SECRET (≥ 16 characters). Signs short-lived tickets that authenticate the monitoring SSE stream without putting the operator token in the URL. */
  MONITORING_TICKET_SECRET: z.string().min(16).optional(),
  AUDIT_ANCHOR_SECRET: z.string().min(16).optional(),
  /**
   * Interval between automatic audit-chain anchors (default 6 h). While
   * anchoring is active it also drives periodic signed Decision_Receipt tree
   * heads, persisted in `receipt_tree_heads`.
   */
  AUDIT_ANCHOR_INTERVAL_MS: z.coerce.number().int().min(60_000).optional(),
  AUDIT_ANCHOR_FILE: z.string().optional(),
  // Remote erasure targets for the DSAR orchestrator (Req 2.9): a JSON array
  // of `{service, url, tokenEnv}` entries pointing at the `POST /v1/erasure`
  // endpoints of Search/Extract/Gate. `tokenEnv` names an environment variable
  // holding the service token, so secrets never live in this list.
  ERASURE_TARGETS: z
    .string()
    .optional()
    .transform((raw): ErasureTargetConfig[] | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return undefined;
        const out: ErasureTargetConfig[] = [];
        for (const item of parsed) {
          if (item === null || typeof item !== "object") continue;
          const rec = item as Record<string, unknown>;
          if (
            typeof rec.service === "string" &&
            rec.service.length > 0 &&
            typeof rec.url === "string" &&
            rec.url.length > 0 &&
            typeof rec.tokenEnv === "string" &&
            rec.tokenEnv.length > 0
          ) {
            out.push({
              service: rec.service,
              url: rec.url,
              tokenEnv: rec.tokenEnv,
            });
          }
        }
        return out.length > 0 ? out : undefined;
      } catch {
        return undefined;
      }
    }),
  // Ed25519 private key (PEM or raw 32-byte base64) signing Erasure_Receipts
  // (Req 2.11). When absent the orchestrator falls back to an audit-anchor
  // HMAC and records the algorithm in the receipt envelope.
  ERASURE_RECEIPT_SIGNING_KEY: z.string().min(16).optional(),
  // Decision_Receipts (Req 15): master switch + Ed25519 signing key. When the
  // switch is on but the key is missing, startup fails — receipts without a
  // verifiable signature would be worse than no receipts at all.
  DECISION_RECEIPTS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  RECEIPT_SIGNING_KEY: z.string().min(16).optional(),
  EVIDENCE_BUNDLE_SECRET: z.string().min(16).optional(),
  PII_RECALL_DATASET: z.string().optional(),
  SLO_ALERT_WEBHOOK_URL: z.string().url().optional(),
  PROVIDER_REGIONS: z
    .string()
    .optional()
    .transform((raw): Record<string, string> | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(
          parsed as Record<string, unknown>,
        )) {
          if (typeof v === "string") out[k] = v;
        }
        return Object.keys(out).length > 0 ? out : undefined;
      } catch {
        return undefined;
      }
    }),
  LOCAL_PROVIDERS: z
    .string()
    .optional()
    .transform((raw): string[] | undefined =>
      raw === undefined || raw.trim() === ""
        ? undefined
        : raw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
    ),
  CO2_GRID_CARBON_INTENSITY: z.coerce.number().min(0).max(2).optional(),
  CO2_ENERGY_FACTORS: z
    .string()
    .optional()
    .transform(
      (
        raw,
        ctx,
      ): import("../observability/finops.js").EnergyFactor[] | undefined => {
        if (raw === undefined || raw.trim() === "") return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "CO2_ENERGY_FACTORS must be a valid JSON array",
          });
          return z.NEVER;
        }
        const schema = z.array(
          z.object({
            provider: z.string().min(1),
            modelPattern: z.string().min(1).optional(),
            kwhPer1kTokens: z.number().min(0),
          }),
        );
        const result = schema.safeParse(parsed);
        if (!result.success) {
          result.error.issues.forEach((issue) => {
            ctx.addIssue({
              ...issue,
              path: ["CO2_ENERGY_FACTORS", ...issue.path],
            });
          });
          return z.NEVER;
        }
        return result.data;
      },
    ),
  MONITORING_TICKET_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(5)
    .max(3600)
    .default(60),
  AUTHN_MODE: z.enum(["disabled", "token", "oidc", "token_or_oidc"]).optional(),
  AUTHZ_ENABLED: z
    .string()
    .optional()
    .transform(
      (raw): boolean =>
        raw === undefined || raw === "" || raw === "true" || raw === "1",
    ),
  TENANT_ISOLATION_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  DEFAULT_TENANT_ID: z.string().min(1).default("default"),
  /** HS256 secret for verifying inbound end-user JWTs on `/v1/*`. One of JWT_SECRET, JWT_JWKS_URL or OIDC_ISSUER must be set for cryptographic verification; without any, the production gate refuses to start unless JWT_ALLOW_UNVERIFIED=true (development only). */
  JWT_SECRET: z.string().optional(),
  /** JWKS endpoint for verifying inbound end-user JWTs (RS/ES algorithms). Alternative to JWT_SECRET. */
  JWT_JWKS_URL: z.string().url().optional(),
  JWT_ISSUER: z.string().url().optional(),
  /** Expected `aud` claim of inbound end-user JWTs; tokens for another audience are rejected. */
  JWT_AUDIENCE: z.string().min(1).optional(),
  /** OIDC issuer URL. Enables JWT verification via the issuer's discovery/JWKS and, with OIDC_CLIENT_ID/SECRET, the operator SSO login of the dashboard. */
  OIDC_ISSUER: z.string().url().optional(),
  /** Expected `aud` claim of tokens verified against OIDC_ISSUER. */
  OIDC_AUDIENCE: z.string().min(1).optional(),
  FLOW_SCOPE_CLAIMS: z
    .string()
    .default("scope,scp")
    .transform((raw) => {
      const claims = raw
        .split(",")
        .map((claim) => claim.trim())
        .filter((claim) => claim !== "");
      return [...new Set(claims.length > 0 ? claims : ["scope", "scp"])];
    }),
  /** JSON array of further trusted token issuers, `[{"issuer": "…", "audience": "…"}]`, verified via their OIDC discovery/JWKS in addition to the primary issuer. The list is platform-wide (operator-managed, not per tenant): every listed issuer is trusted for the whole runtime, so bind each one to its tenants with JWT_ISSUER_TENANTS. */
  JWT_ADDITIONAL_ISSUERS: z
    .string()
    .optional()
    .transform(
      (raw, ctx): { issuer: string; audience?: string }[] | undefined => {
        if (raw === undefined || raw.trim() === "") return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "JWT_ADDITIONAL_ISSUERS must be valid JSON",
          });
          return z.NEVER;
        }
        const schema = z.array(
          z.object({
            issuer: z.string().url(),
            audience: z.string().min(1).optional(),
          }),
        );
        const result = schema.safeParse(parsed);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "JWT_ADDITIONAL_ISSUERS must be a JSON array of {issuer:url, audience?:string}",
          });
          return z.NEVER;
        }
        return result.data;
      },
    ),
  /**
   * SECURITY. Binds each trusted token issuer to the tenants it may assert,
   * e.g. {"https://idp.example/app-a/":["acme"],"https://idp.example/app-b/":["*"]}.
   * Without it, any trusted issuer (JWT_ADDITIONAL_ISSUERS, token_or_oidc) can
   * claim any tenant. Required in production when tenant isolation is on and
   * more than one issuer is trusted.
   */
  JWT_ISSUER_TENANTS: z
    .string()
    .optional()
    .transform((raw, ctx): Record<string, string[]> | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "JWT_ISSUER_TENANTS must be valid JSON",
        });
        return z.NEVER;
      }
      const result = z
        .record(z.string(), z.array(z.string().min(1)).min(1))
        .safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "JWT_ISSUER_TENANTS must be a JSON object mapping issuer to a non-empty array of tenant ids (or [\"*\"])",
        });
        return z.NEVER;
      }
      return result.data;
    }),
  /** OIDC client id for the operator dashboard SSO login (authorization-code flow). */
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  /** SECRET. OIDC client secret for the operator dashboard SSO login. */
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  /** SECRET (≥ 32 characters). Signs the operator SSO state and refresh-session cookies; rotating it ends all dashboard sessions. */
  OIDC_SESSION_SECRET: z.string().min(32).optional(),
  /** Lifetime of the operator session token minted after SSO login (60–86400 s). */
  OIDC_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .default(3600),
  /** Scopes requested in the operator SSO login (space-separated). */
  OIDC_SCOPES: z.string().min(1).optional(),
  /** Lifetime of the server-side refresh session (HttpOnly cookie) used for silent renewal (300 s – 1 year). */
  OIDC_REFRESH_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(31_536_000)
    .default(2_592_000),
  /** Callback URL registered at the IdP for the operator SSO login (`…/monitoring/auth/callback`). */
  OIDC_REDIRECT_URI: z.string().url().optional(),
  /** Dashboard URL the SSO callback may redirect back to with the session hand-off; redirects elsewhere are refused. */
  OIDC_DASHBOARD_URL: z.string().url().optional(),
  /** `true` sends unauthenticated dashboard visitors straight into the SSO login instead of showing the token form. */
  OIDC_AUTO_LOGIN: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  REDIS_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(1000).default(10),
  /**
   * Apply schema migrations during boot. Unset means: true outside
   * production, false when APP_ENV=production (requirement 12.4) — a
   * production rollout runs the standalone `bun run migrate` command as a
   * one-shot Job instead of doing DDL on the boot path of every replica.
   * The effective default is computed in `load.ts` from APP_ENV.
   */
  MIGRATE_ON_START: z
    .string()
    .optional()
    .transform((raw): boolean | undefined =>
      raw === undefined || raw === ""
        ? undefined
        : raw === "true" || raw === "1",
    ),
  /** Enforce PostgreSQL row-level security per tenant on tenant-scoped tables. Default `true`. */
  TENANT_RLS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean =>
      raw === undefined || raw === ""
        ? SECURE_DEFAULTS.tenantRlsEnabled
        : raw === "true" || raw === "1",
    ),
  /** Fail startup when RLS cannot be enforced (default `true`). `false` is an explicit opt-out the production gate rejects for tenant-isolated deployments. */
  TENANT_RLS_REQUIRED: z
    .string()
    .optional()
    .transform((raw): boolean =>
      raw === undefined || raw === "" ? true : raw !== "false" && raw !== "0",
    ),
  CLUSTER_STATE_OPT_OUT: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  DATABASE_OPERATOR_URL: z.string().optional(),
  MONITORING_MAX_CONNECTIONS: z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(100),
  RESPONSE_CACHE_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  RESPONSE_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86400)
    .default(300),
  RESPONSE_CACHE_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000000)
    .default(1000),
  SEMANTIC_CACHE_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  SEMANTIC_CACHE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  SEMANTIC_CACHE_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000000)
    .default(500),
  SEMANTIC_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86400)
    .default(300),
  EMBEDDING_CACHE_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  EMBEDDING_CACHE_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000000)
    .default(2000),
  EMBEDDING_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(604800)
    .default(3600),
  ROUTER_QUALITY_HALF_LIFE_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(2_592_000_000)
    .optional(),
  /** Enable the retention sweep and the DSAR erasure endpoints (`DELETE /v1/me/data`, `/admin/compliance/forget`). */
  RETENTION_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** Interval of the background retention sweep (1 min – 7 days). */
  RETENTION_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(604_800_000)
    .default(21_600_000),
  /** Maximum age in days for retention targets that RETENTION_MAX_AGE_DAYS does not list; unset means no age purge for them. */
  RETENTION_DEFAULT_MAX_AGE_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(36_500)
    .optional(),
  /** JSON map of retention target → maximum age in days, e.g. `{"execution_history": 90}`; target names are listed in docs/CAPABILITIES.md. */
  RETENTION_MAX_AGE_DAYS: z
    .string()
    .optional()
    .transform((raw, ctx): Record<string, number> | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "RETENTION_MAX_AGE_DAYS must be valid JSON",
        });
        return z.NEVER;
      }
      const result = z
        .record(z.string(), z.number().int().min(1).max(36_500))
        .safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["RETENTION_MAX_AGE_DAYS", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  /** Enable tenant-supplied provider keys (bring your own key). */
  BYOK_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  BYOK_MODE: z.enum(["disabled", "optional", "required"]).default("optional"),
  COMPLIANCE_FAIL_CLOSED_UNKNOWN_REGION: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** SECRET (base64, 32 bytes — `openssl rand -base64 32`). Encrypts tenant provider keys at rest. Without it BYOK keys stay in process memory unencrypted; the production gate refuses that. */
  BYOK_ENCRYPTION_KEY: z.string().optional(),
  BYOK_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(86_400)
    .default(60),
  // ── Reversible PII tokenization vault ─────────────────────────────────────
  /** Enable the reversible PII vault (tokenize PII before provider calls, restore it in the response). */
  PII_VAULT_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** SECRET (base64, 32 bytes). Encrypts PII vault entries at rest. Without it the vault is in-memory and unencrypted; the production gate refuses that. */
  PII_VAULT_ENCRYPTION_KEY: z.string().optional(),
  /** Comma-separated PiiType subset, e.g. "email,phone,iban". Empty = all types. */
  PII_VAULT_TYPES: z.string().optional(),
  /** Comma-separated PII detector backends: "regex", "ner", "remote". Default: "regex". */
  PII_DETECTORS: z.string().optional(),
  /** BERT-NER model identifier (ONNX build; HuggingFace hub or local path). Default: Xenova/bert-base-multilingual-cased-ner-hrl */
  PII_NER_MODEL: z.string().optional(),
  /** BERT-NER minimum confidence threshold (0–1). Default: 0.75. */
  PII_NER_CONFIDENCE: z.coerce.number().min(0).max(1).optional(),
  /** Local cache directory for downloaded NER models. */
  PII_NER_CACHE_DIR: z.string().optional(),
  /** Base URL of the external remote PII detection service. */
  PII_REMOTE_ENDPOINT: z.string().url().optional(),
  /** API key / bearer token for the remote PII detection service. */
  PII_REMOTE_API_KEY: z.string().optional(),
  /** Per-request timeout for the remote PII detector in ms. Default: 3000. */
  PII_REMOTE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .optional(),
  /** Language hint for the remote PII detector. Default: "de". */
  PII_REMOTE_LANGUAGE: z.string().optional(),
  /** Detector pipeline fail mode: "open" or "closed". Default: "open". */
  PII_DETECTOR_FAIL_MODE: z.enum(["open", "closed"]).optional(),
  /** Per-detector timeout in ms. Default: 5000. */
  PII_DETECTOR_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .optional(),
  /** Multimodal (image/file) PII handling: "off" (default), "block", "redact", or "describe". */
  PII_VAULT_MULTIMODAL_MODE: z
    .enum(["off", "block", "redact", "describe"])
    .optional(),
  /** Image-redactor/describer fail mode: "open" (strip on failure) or "closed" (reject). Default: "open". */
  PII_VAULT_MULTIMODAL_FAIL_MODE: z.enum(["open", "closed"]).optional(),
  /** Endpoint of an external image-redaction service for `redact` mode. */
  PII_IMAGE_REMOTE_ENDPOINT: z.string().url().optional(),
  /** API key / bearer token for the image-redaction service. */
  PII_IMAGE_REMOTE_API_KEY: z.string().optional(),
  /** Per-request timeout for the image-redaction service in ms. Default: 5000. */
  PII_IMAGE_REMOTE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .optional(),
  /** Vision model (JSON LlmConfig) used by `describe` mode. Prefer a local/on-prem model. */
  PII_IMAGE_DESCRIBE_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "PII_IMAGE_DESCRIBE_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["PII_IMAGE_DESCRIBE_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  /** Optional system-prompt override for `describe` mode. */
  PII_IMAGE_DESCRIBE_PROMPT: z.string().optional(),
  IDEMPOTENCY_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  IDEMPOTENCY_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(604_800)
    .default(86_400),
  IDEMPOTENCY_MAX_ENTRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .default(10_000),
  EMBEDDING_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): EmbeddingConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "EMBEDDING_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = EmbeddingConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["EMBEDDING_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  EMBEDDING_FALLBACK_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): EmbeddingConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "EMBEDDING_FALLBACK_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = EmbeddingConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["EMBEDDING_FALLBACK_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  EMBEDDING_EXPECTED_DIMENSION: z.coerce.number().int().min(1).optional(),
  CHECKPOINTING_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_TOOL_STEPS: z.coerce.number().int().min(1).max(50).default(5),
  MAX_CONCURRENT_EXECUTIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50),
  MAX_GLOBAL_CONCURRENT_EXECUTIONS: z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(0),
  EXECUTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    // Completeness-critical deep-research flows may run for up to six hours.
    // Keep a hard ceiling so a typo cannot create an effectively unbounded run.
    .max(21_600_000)
    .default(120000),
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(0).max(120000).default(15000),
  HEALTH_PROBE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10000)
    .default(2000),
  /** `true` makes startup fail unless a JWT verifier (JWT_SECRET, JWT_JWKS_URL or OIDC_ISSUER) is configured. */
  JWT_REQUIRE_VERIFICATION: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** SECURITY: `true` accepts JWTs without signature verification (format-only) and lets any JWT-shaped bearer act as an admin operator when no verifier is configured. Development only — the production gate rejects it. */
  JWT_ALLOW_UNVERIFIED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** An unreadable or invalid tool-authorization policy denies every tool call (default `true`); `false` falls back to allowing them. */
  TOOL_AUTHZ_FAIL_CLOSED: z
    .string()
    .optional()
    .transform((raw): boolean =>
      raw === undefined || raw === ""
        ? SECURE_DEFAULTS.toolAuthzFailClosed
        : raw === "true" || raw === "1",
    ),
  MAX_REQUEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(104857600)
    .default(26214400),
  /** Requests per minute per client on the inference API; `0` disables the limit. */
  RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(120),
  /** Requests per minute per end user on the inference API; `0` (default) disables the per-user limit. */
  RATE_LIMIT_PER_USER_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(0),
  RATE_LIMIT_PRE_AUTH_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(0),
  RATE_LIMIT_POST_AUTH_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(0)
    .max(100000)
    .default(0),
  RATE_LIMIT_FAIL_MODE: z
    .enum(["open", "closed"])
    .default(SECURE_DEFAULTS.rateLimitFailMode),
  METRICS_ENABLED: z
    .string()
    .optional()
    .transform(
      (raw): boolean =>
        raw === undefined || raw === "" || raw === "true" || raw === "1",
    ),
  /** Require authentication for `/metrics`. Default `true` (secure default); `false` exposes Prometheus metrics unauthenticated. */
  METRICS_AUTH: z
    .string()
    .optional()
    .transform((raw): boolean =>
      raw === undefined || raw === ""
        ? SECURE_DEFAULTS.metricsAuthRequired
        : raw === "true" || raw === "1",
    ),
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  LLM_RETRY_BACKOFF_MS: z.coerce.number().int().min(0).max(60000).default(500),
  LLM_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(600_000),
  // HTTP keep-alive for LLM provider requests (openai/ollama protocols only).
  // Default true (socket reuse); "false"/"0" opens a fresh connection per
  // request. Other egress traffic (MCP, OIDC, reranker, ...) is unaffected.
  LLM_HTTP_KEEP_ALIVE: z
    .string()
    .optional()
    .transform((raw): boolean =>
      raw === undefined || raw === "" ? true : raw !== "false" && raw !== "0",
    ),
  LLM_MAX_OUTPUT_CHARS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_000_000)
    .default(64_000),
  LLM_STREAM_FALLBACK_POLICY: z
    .enum(["legacy", "report", "explicit", "disabled"])
    .default("legacy"),
  MAX_QUEUE_DEPTH: z.coerce.number().int().min(0).max(100000).default(100),
  BUDGET_DAILY_PER_TENANT: z.coerce.number().min(0).max(1_000_000).default(0),
  // Display currency for every cost figure in the system. Purely a label:
  // values are never converted; the pricing table is interpreted as
  // denominated in this currency. Unknown codes fall back to EUR.
  CURRENCY: z
    .string()
    .optional()
    .transform((raw): Currency => parseCurrency(raw)),
  TRACING_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  OUTPUT_GUARDRAILS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  GUARDRAIL_REDACT_PII: z
    .string()
    .optional()
    .transform(
      (raw): boolean =>
        raw === undefined || raw === "" || raw === "true" || raw === "1",
    ),
  GUARDRAIL_PII_TYPES: z
    .string()
    .optional()
    .transform((raw): string[] => {
      if (raw === undefined || raw.trim() === "") return [];
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }),
  GUARDRAIL_BLOCKED_PATTERNS: z
    .string()
    .optional()
    .transform((raw, ctx): string[] => {
      if (raw === undefined || raw.trim() === "") return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "GUARDRAIL_BLOCKED_PATTERNS must be a valid JSON array of regex strings",
        });
        return z.NEVER;
      }
      const result = z.array(z.string()).safeParse(parsed);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "GUARDRAIL_BLOCKED_PATTERNS must be a JSON array of strings",
          path: ["GUARDRAIL_BLOCKED_PATTERNS"],
        });
        return z.NEVER;
      }
      return result.data;
    }),
  GUARDRAIL_MODE: z.enum(["redact", "block"]).default("redact"),
  /** `true` scans tool-call arguments for PII before they leave the runtime (DLP) and redacts according to GUARDRAIL_REDACT_PII/GUARDRAIL_PII_TYPES. Default off. */
  TOOL_EGRESS_GUARDRAIL: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  TOOL_EGRESS_MODE: z.enum(["redact", "block"]).default("redact"),
  // Egress_Guard (Req 7.1, 7.2): exact hostnames (split-DNS exceptions) that
  // may resolve to RFC1918/ULA — and in development, loopback — addresses.
  EGRESS_ALLOW_PRIVATE_HOSTS: z
    .string()
    .optional()
    .transform((raw): string[] => {
      if (raw === undefined || raw.trim() === "") return [];
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }),
  // Optional destination allow-list for every guarded outbound call; empty
  // means "any public host". Entries may be exact hosts or `.suffix` domains.
  EGRESS_ALLOWED_HOSTS: z
    .string()
    .optional()
    .transform((raw): string[] => {
      if (raw === undefined || raw.trim() === "") return [];
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }),
  EGRESS_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .default(64 * 1024 * 1024),
  // Default timeout for guarded calls without a caller-provided signal.
  // 0 disables it so long-lived streaming calls are unaffected.
  EGRESS_TIMEOUT_MS: z.coerce.number().int().min(0).default(0),
  /**
   * SECURITY. Scan MCP tool results and retrieved RAG chunks for indirect
   * prompt injection before the model sees them. Unset = on in production
   * (APP_ENV=production), off elsewhere; "false" switches it off explicitly.
   */
  TOOL_OUTPUT_VALIDATOR_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean | undefined =>
      raw === undefined || raw.trim() === ""
        ? undefined
        : raw === "true" || raw === "1",
    ),
  TOOL_OUTPUT_VALIDATOR_MODE: z.enum(["flag", "redact"]).default("redact"),
  TOOL_OUTPUT_VALIDATOR_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  /** Enable human-in-the-loop approval for tool calls matching APPROVAL_REQUIRE_TOOLS or a node's own list. */
  APPROVAL_GATE_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** Comma-separated tool patterns (`server/tool`, wildcards allowed) that always need human approval. */
  APPROVAL_REQUIRE_TOOLS: z
    .string()
    .optional()
    .transform((raw): string[] => {
      if (raw === undefined || raw.trim() === "") return [];
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }),
  /** Time a pending approval waits before it is auto-denied (fail closed), 1 s – 1 h. */
  APPROVAL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(3_600_000)
    .default(30_000),
  APPROVAL_BASE_URL: z.string().url().optional(),
  APPROVAL_FRAME_ANCESTORS: z
    .string()
    .optional()
    .transform((raw, ctx): string[] => {
      if (raw === undefined || raw.trim() === "") return [];
      const origins: string[] = [];
      for (const value of raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)) {
        try {
          const url = new URL(value);
          if (
            (url.protocol !== "http:" && url.protocol !== "https:") ||
            url.origin !== value
          ) {
            throw new Error("not an HTTP(S) origin");
          }
          origins.push(url.origin);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "APPROVAL_FRAME_ANCESTORS must be a comma-separated list of HTTP(S) origins without paths",
          });
          return z.NEVER;
        }
      }
      return [...new Set(origins)];
    }),
  MEDIA_BASE_URL: z.string().url().optional(),
  GROUNDEDNESS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  GROUNDEDNESS_MODE: z.enum(["annotate", "block"]).default("annotate"),
  GROUNDEDNESS_PASS_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  GROUNDEDNESS_TYPE: z.enum(["lexical", "semantic", "llm"]).default("lexical"),
  GROUNDEDNESS_SEMANTIC_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  GROUNDEDNESS_MAX_SOURCE_CHUNKS: z.coerce
    .number()
    .int()
    .min(1)
    .max(2000)
    .default(200),
  GROUNDEDNESS_EMBEDDING_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): EmbeddingConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "GROUNDEDNESS_EMBEDDING_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = EmbeddingConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["GROUNDEDNESS_EMBEDDING_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  GROUNDEDNESS_JUDGE_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "GROUNDEDNESS_JUDGE_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["GROUNDEDNESS_JUDGE_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  REPLAY_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  FLOW_EDITOR_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  OPTIMIZER_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  OPTIMIZER_GENERATOR_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPTIMIZER_GENERATOR_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["OPTIMIZER_GENERATOR_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  OPTIMIZER_JUDGE_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPTIMIZER_JUDGE_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["OPTIMIZER_JUDGE_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  OPTIMIZER_SCHEDULE_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  OPTIMIZER_SCHEDULE_FLOWS: z
    .string()
    .optional()
    .transform((raw): string[] =>
      raw === undefined
        ? []
        : raw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
    ),
  OPTIMIZER_SCHEDULE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(2_592_000_000)
    .default(86_400_000),
  OPTIMIZER_SCHEDULE_MIN_NEW_SAMPLES: z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(50),
  OPTIMIZER_SCHEDULE_COOLDOWN_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(2_592_000_000)
    .optional(),
  OPTIMIZER_SCHEDULE_AUTO_PROMOTE: z
    .string()
    .optional()
    .transform((raw): boolean =>
      raw === undefined || raw === "" ? true : raw === "true" || raw === "1",
    ),
  OPTIMIZER_SCHEDULE_VARIANT_COUNT: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3),
  OPTIMIZER_SCHEDULE_MIN_SCORE_IMPROVEMENT: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.05),
  OPTIMIZER_SCHEDULE_GOAL: z.string().optional(),
  AUTOPILOT_REQUIRE_APPROVAL: z
    .string()
    .optional()
    .transform((raw): boolean =>
      raw === undefined || raw === "" ? true : raw === "true" || raw === "1",
    ),
  AUTOPILOT_MAX_AUTO_PROMOTIONS_PER_WINDOW: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(3),
  AUTOPILOT_DRIFT_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(2_592_000_000)
    .default(86_400_000),
  RED_TEAM_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  RED_TEAM_SCHEDULE_FLOWS: z
    .string()
    .optional()
    .transform((raw): string[] | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }),
  RED_TEAM_INTERVAL_MS: z.coerce.number().int().min(60_000).optional(),
  RED_TEAM_ATTACKS_PER_RUN: z.coerce.number().int().min(1).optional(),
  RED_TEAM_JUDGE_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "RED_TEAM_JUDGE_MODEL must be valid JSON",
        });
        return z.NEVER;
      }
      const r = LlmConfigSchema.safeParse(parsed);
      if (!r.success) {
        r.error.issues.forEach((i) => {
          ctx.addIssue({ ...i, path: ["RED_TEAM_JUDGE_MODEL", ...i.path] });
        });
        return z.NEVER;
      }
      return r.data;
    }),
  RED_TEAM_JUDGE_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
  RED_TEAM_POSTURE_ALERT_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
  RED_TEAM_ALERT_WEBHOOK_URL: z.string().url().optional(),
  RED_TEAM_AUTO_TUNE: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  RED_TEAM_AUTO_TUNE_CEILING: z.coerce.number().min(0).max(1).optional(),
  RED_TEAM_ATTACKS_URL: z.string().url().optional(),
  RED_TEAM_ATTACKS_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(6 * 60 * 60_000),
  /** SECRET. JSON map of provider → API key(s) for the deployment's own LLM provider accounts. */
  PROVIDER_KEYS: z
    .string()
    .optional()
    .transform((raw, ctx): ProviderKeys | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "PROVIDER_KEYS must be valid JSON",
        });
        return z.NEVER;
      }
      const result = z
        .object({
          openai: z.array(z.string()).optional(),
          google: z.array(z.string()).optional(),
          azure: z.array(z.string()).optional(),
          bedrock: z.array(z.string()).optional(),
          anthropic: z.array(z.string()).optional(),
        })
        .safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({ ...issue, path: ["PROVIDER_KEYS", ...issue.path] });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  BUDGET_ALERT_THRESHOLDS: z
    .string()
    .optional()
    .transform((raw, ctx): number[] => {
      if (raw === undefined || raw.trim() === "") return [];
      const out: number[] = [];
      for (const part of raw.split(",")) {
        const t = part.trim();
        if (t === "") continue;
        const n = Number(t);
        if (!Number.isFinite(n) || n <= 0 || n > 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "BUDGET_ALERT_THRESHOLDS must be comma-separated fractions in (0,1]",
          });
          return z.NEVER;
        }
        out.push(n);
      }
      return out;
    }),
  BUDGET_ALERT_WEBHOOK_URL: z.string().url().optional(),
  COST_ANOMALY_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  COST_ANOMALY_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  COST_ANOMALY_BASELINE_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(7),
  COST_ANOMALY_MIN_BASELINE_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(30)
    .default(3),
  COST_ANOMALY_SPIKE_MULTIPLIER: z.coerce
    .number()
    .min(1)
    .max(1000)
    .default(3.0),
  COST_ANOMALY_MIN_ABSOLUTE: z.coerce.number().min(0).max(1000).default(0.1),
  COST_ANOMALY_COOLDOWN_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  INPUT_GUARDRAILS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  INPUT_GUARDRAIL_MODE: z.enum(["flag", "block"]).default("flag"),
  INPUT_GUARDRAIL_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  INPUT_GUARDRAIL_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "INPUT_GUARDRAIL_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["INPUT_GUARDRAIL_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  INPUT_GUARDRAIL_MODEL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.3),
  /**
   * Fail mode of the model-based input classifier. No Zod default: the
   * effective default is environment-conditional and resolved in load.ts —
   * `open` in Development, `closed` in Production (Requirement 7.5).
   */
  INPUT_GUARDRAIL_MODEL_FAIL_MODE: z.enum(["open", "closed"]).optional(),
  /**
   * Character budget per classifier call; longer texts are classified
   * chunk-wise with overlap instead of risking a timeout (Requirement 7.6).
   */
  INPUT_GUARDRAIL_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(500)
    .max(200_000)
    .default(8000),
  JOBS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  JOBS_TTL_SECONDS: z.coerce.number().int().min(30).max(604_800).default(3600),
  JOBS_MAX_ENTRIES: z.coerce.number().int().min(1).max(1_000_000).default(1000),
  // Durable Agent Runtime — see job-store.ts / job-recovery-sweeper.ts.
  JOB_RECOVERY_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  JOB_RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // Comfortably above a typical EXECUTION_TIMEOUT_MS so a legitimately slow
  // (but alive) job is never mistaken for an orphan — mirrors the same
  // reasoning distributed-semaphore.ts's ttlMs documents for its own lease.
  JOB_RECOVERY_LEASE_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(3_600_000)
    .default(300_000),
  JOB_RECOVERY_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .default(60_000),
  RAG_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  RAG_MAX_DOCUMENTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .default(10_000),
  // Forward caller-supplied (OpenAI function-calling) tools from the request
  // `tools` field to the model as passthrough client tools. This is how a
  // client like Open WebUI injects its per-user "Knowledge" tools
  // (e.g. view_knowledge_file / grep_knowledge_files). Enabled by default to
  // preserve function-calling behaviour; set to "false"/"0" to make aiperator
  // ignore client-supplied tools entirely (flows then only use their own
  // declared tools).
  CLIENT_TOOLS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw !== "false" && raw !== "0"),
  // Refuse a webhook trigger whose node declares no `config.webhookSecret`
  // (default true). `POST /triggers/:flowId` is mounted outside the /v1/* auth
  // middleware, so that per-flow HMAC secret is the route's ONLY authentication —
  // treating its absence as "no verification needed" made an unsigned webhook
  // flow a public flow-execution endpoint billed to the operator.
  TRIGGERS_REQUIRE_SIGNATURE: z
    .string()
    .optional()
    .transform((raw): boolean => raw !== "false" && raw !== "0"),
  // Whether client-supplied identity ATTRIBUTES may contribute to the security-
  // relevant fields of the RequestContext (`role`, `clientId`, `plan`).
  //
  // These three fields are consumed by authorization decisions:
  //   - `role`      → flows/access.yaml `allowRoles`, tool-authz `match.role`
  //   - `clientId` → `allowTenants`, BYOK key resolution, cost/budget attribution
  //   - `plan`      → `allowPlans`
  //
  // A verified JWT claim is ALWAYS authoritative and always wins (that
  // precedence is not configurable). This flag only decides whether the
  // untrusted sources — the `X-OpenWebUI-User-*` headers and
  // `metadata.clientId`/`metadata.plan` in the request body — may supply a
  // value when the token carries no such claim.
  //
  // Default FALSE (fail-closed): otherwise any caller holding a valid user
  // token could send `X-OpenWebUI-User-Role: admin` to satisfy an
  // `allowRoles: ["admin"]` rule, or `metadata.clientId: "other-tenant"` to
  // run on another tenant's BYOK key and budget. Enable it ONLY when aiperator
  // sits behind a trusted reverse proxy that strips these headers from inbound
  // client requests and sets them itself.
  TRUSTED_IDENTITY_HEADERS: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  // Harden profile identity independently from role/clientId/plan trust.
  // Default false is deliberately backward-compatible with OWUI deployments.
  STRICT_IDENTITY_HEADERS: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  MEMORY_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  MEMORY_TOP_K: z.coerce.number().int().min(1).max(100).default(5),
  MEMORY_AUTO_CAPTURE: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  // -------------------------------------------------------------------------
  // Per-user assistants
  // -------------------------------------------------------------------------
  ASSISTANTS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  ASSISTANT_WORKSPACE_ROOT: z.string().min(1).default("./data/assistants"),
  // Defaults to true so enabling assistants gives the self-improving behaviour
  // that is the point of them; an operator who wants assistants without the
  // per-turn learning cost sets this to false explicitly.
  ASSISTANT_LEARNING_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw !== "false" && raw !== "0"),
  ASSISTANT_DELEGATION_ISSUER: z.string().url().optional(),
  ASSISTANT_DELEGATION_CLIENT_ID: z.string().min(1).optional(),
  /** SECRET. OAuth client secret the assistants' identity broker uses for delegated (on-behalf-of) token exchange. */
  ASSISTANT_DELEGATION_CLIENT_SECRET: z.string().min(1).optional(),
  ROCKETCHAT_CONNECT_OIDC_SCOPES: z
    .string()
    .min(1)
    .default("openid profile email offline_access"),
  ASSISTANT_ENCRYPTION_KEY: z.string().min(1).optional(),
  ROCKETCHAT_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  ROCKETCHAT_BASE_URL: z.string().url().optional(),
  ROCKETCHAT_BOT_USER_ID: z.string().min(1).max(256).optional(),
  ROCKETCHAT_BOT_AUTH_TOKEN: z.string().min(1).optional(),
  ROCKETCHAT_WEBHOOK_TOKEN: z.string().min(16).optional(),
  ROCKETCHAT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(10_000),
  ROCKETCHAT_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(10_000),
  // -------------------------------------------------------------------------
  // Assistant code sandbox
  // -------------------------------------------------------------------------
  SANDBOX_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  SANDBOX_RUNTIME: z.enum(["docker", "podman"]).default("docker"),
  SANDBOX_IMAGE: z.string().min(1).default("aiperator/sandbox:1"),
  SANDBOX_USER: z
    .string()
    // `uid:gid`, both numeric. A name would have to exist inside the image, and a
    // mismatch there silently falls back to root on some runtimes.
    .regex(/^\d+:\d+$/, "SANDBOX_USER must be numeric uid:gid, e.g. 1000:1000")
    .default("1000:1000"),
  SANDBOX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(60_000),
  SANDBOX_MEMORY_MB: z.coerce.number().int().min(64).max(16_384).default(512),
  SANDBOX_CPUS: z.coerce.number().min(0.1).max(16).default(1),
  SANDBOX_NETWORK_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  MEMORY_EXTRACTION_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "MEMORY_EXTRACTION_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["MEMORY_EXTRACTION_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  OPERATOR_TOKENS: z
    .string()
    .optional()
    .transform((raw, ctx): OperatorTokenEntry[] | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPERATOR_TOKENS must be valid JSON",
        });
        return z.NEVER;
      }
      const result = z
        .array(
          z.object({
            token: z.string().min(1),
            role: z.enum(["viewer", "operator", "admin"]),
            name: z.string().optional(),
          }),
        )
        .safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({ ...issue, path: ["OPERATOR_TOKENS", ...issue.path] });
        });
        return z.NEVER;
      }
      return result.data as OperatorTokenEntry[];
    }),
  /** JWT claim that carries the operator role (`viewer`, `operator`, `admin`) for the operator plane. */
  OPERATOR_ROLE_CLAIM: z.string().min(1).max(128).default("role"),
  OPERATOR_GROUPS_CLAIM: z.string().min(1).max(128).optional(),
  OPERATOR_ROLE_MAP: z
    .string()
    .optional()
    .transform((raw, ctx): Record<string, OperatorRole> | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OPERATOR_ROLE_MAP must be valid JSON",
        });
        return z.NEVER;
      }
      const schema = z.record(
        z.string().min(1),
        z.enum(["viewer", "operator", "admin"]),
      );
      const result = schema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["OPERATOR_ROLE_MAP", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  OPERATOR_DEFAULT_ROLE: z.enum(["viewer", "operator", "admin"]).optional(),
  /** Enable the tenant management API (`/admin/tenants`: tenants, API keys, provider keys). */
  TENANT_MANAGEMENT_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  // Server-side pepper for API-key hashing (Req 7.9). Empty/unset keeps the
  // legacy unsalted SHA-256 form; when set, new keys hash as
  // HMAC-SHA-256(pepper, rawKey) and legacy rows migrate lazily on lookup.
  API_KEY_PEPPER: z
    .string()
    .optional()
    .transform((raw): string | undefined =>
      raw !== undefined && raw.trim().length > 0 ? raw : undefined,
    ),
  // Transaction-token signing (Req 7.11). HS256 stays the default; ES256/EdDSA
  // require TRANSACTION_SIGNING_KEY (PKCS8 PEM) and expose the public key via
  // /.well-known/atf-transaction-jwks.json. Actual key/alg combination checks
  // happen in transactionTokenConfigFromEnv() when tokens are issued.
  TRANSACTION_SIGNING_ALG: z.enum(["HS256", "ES256", "EdDSA"]).optional(),
  TRANSACTION_SIGNING_KEY: z
    .string()
    .optional()
    .transform((raw): string | undefined =>
      raw !== undefined && raw.trim().length > 0 ? raw : undefined,
    ),
  GITOPS_ENABLED: z
    .string()
    .optional()
    .transform((raw): boolean => raw === "true" || raw === "1"),
  /** SECRET. Verifies the signature of GitOps webhook deliveries; without it signatures are not verified. */
  GITOPS_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Refuse the GitOps webhook when no secret is configured (default true).
  // `POST /webhooks/git` replaces flow definitions, so an unsigned variant is
  // an unauthenticated deployment-mutation endpoint.
  GITOPS_REQUIRE_SIGNATURE: z
    .string()
    .optional()
    .transform((raw): boolean => raw !== "false" && raw !== "0"),
  GITOPS_BRANCH: z.string().optional(),
  CANARY_JUDGE_MODEL: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "CANARY_JUDGE_MODEL must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({
            ...issue,
            path: ["CANARY_JUDGE_MODEL", ...issue.path],
          });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  FALLBACK_LLM: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "FALLBACK_LLM must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({ ...issue, path: ["FALLBACK_LLM", ...issue.path] });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  FALLBACK_CHAIN: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig[] => {
      if (raw === undefined || raw.trim() === "") return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "FALLBACK_CHAIN must be a valid JSON array of LlmConfig objects",
        });
        return z.NEVER;
      }
      const result = z.array(LlmConfigSchema).safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({ ...issue, path: ["FALLBACK_CHAIN", ...issue.path] });
        });
        return z.NEVER;
      }
      return result.data;
    }),
  LLM_PRICING: z
    .string()
    .optional()
    .transform(
      (
        raw,
        ctx,
      ): Record<string, { prompt: number; completion: number }> | undefined => {
        if (raw === undefined || raw.trim() === "") return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "LLM_PRICING must be valid JSON",
          });
          return z.NEVER;
        }
        const result = z
          .record(
            z.string(),
            z.object({
              prompt: z.number().min(0),
              completion: z.number().min(0),
            }),
          )
          .safeParse(parsed);
        if (!result.success) {
          result.error.issues.forEach((issue) => {
            ctx.addIssue({ ...issue, path: ["LLM_PRICING", ...issue.path] });
          });
          return z.NEVER;
        }
        return result.data;
      },
    ),
  DEFAULT_LLM: z
    .string()
    .optional()
    .transform((raw, ctx): LlmConfig | undefined => {
      if (raw === undefined || raw.trim() === "") return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "DEFAULT_LLM must be a valid JSON object",
        });
        return z.NEVER;
      }
      const result = LlmConfigSchema.safeParse(parsed);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          ctx.addIssue({ ...issue, path: ["DEFAULT_LLM", ...issue.path] });
        });
        return z.NEVER;
      }
      return result.data;
    }),
});
