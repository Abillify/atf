// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Production-readiness gate: validates that a loaded config is safe for
 * production deployment.
 *
 */

import { profileShadowWarning, resolveOperationalProfile } from "@atf/security-kit";
import type { AppConfig } from "./schema.js";
import { transactionTokenConfigFromEnv } from "../transaction/token.js";

// ---------------------------------------------------------------------------
// ClusterStateContext
// ---------------------------------------------------------------------------

/**
 * Optional cluster-state and RLS verification context passed to the prod-gate
 * after the persistence layer is initialised. When omitted, cluster-state and
 * RLS checks are skipped (backward-compatible).
 */
export interface ClusterStateContext {
  /**
   * The active store backing (from `StoreFactory.backing()`). When `"memory"`,
   * the prod-gate flags it as fatal in production and as a warning (with the
   * affected state names + scaling risk) in non-production.
   */
  storeBacking: "redis" | "postgres" | "memory";
  /**
   * Whether RLS has been verified as active for tenant tables. When `false`,
   * the prod-gate flags it as fatal in production.
   */
  rlsVerified: boolean;
  /**
   * Number of rows in the `tenants` table, when determinable (see
   * `checkRlsOnboarding` in `src/db/rls-onboarding.ts`). Used purely to make
   * the RLS-not-verified message concrete ("this deployment has N tenants")
   * instead of abstract — it does not change whether the check is fatal.
   * `undefined` when tenant management is not in use or the count could not
   * be read.
   */
  tenantCount?: number;
  /**
   * Whether a valid `compliance-policy.yaml` is loaded. Only known once the
   * policy loader exists (later than persistence); when given together with
   * `COMPLIANCE_POLICY_REQUIRED`, a missing policy is judged like any other
   * readiness finding. `undefined` = not known yet, the check is skipped.
   */
  compliancePolicyLoaded?: boolean;
}

/**
 * `COMPLIANCE_POLICY_REQUIRED`: residency and data-class rules only exist when
 * `compliance-policy.yaml` loaded. Production without one is fatal; elsewhere
 * the same gap is a warning, so the configuration surfaces it early.
 */
export function checkCompliancePolicyRequirement(
  config: Pick<AppConfig, "compliancePolicyRequired" | "appEnv">,
  policyLoaded: boolean,
): { fatal: string[]; warnings: string[] } {
  if (config.compliancePolicyRequired !== true || policyLoaded) {
    return { fatal: [], warnings: [] };
  }
  const message =
    "COMPLIANCE_POLICY_REQUIRED is set but no valid compliance-policy.yaml is loaded: " +
    "data-class residency and provider rules are not enforced. Add the policy to the " +
    "flows directory (see compliance-policy.example.yaml).";
  return config.appEnv === "production"
    ? { fatal: [message], warnings: [] }
    : { fatal: [], warnings: [message] };
}

// ---------------------------------------------------------------------------
// checkProductionReadiness
// ---------------------------------------------------------------------------

/**
 * Validates production-readiness of a loaded config. Returns a list of fatal
 * issues (which should abort startup in production) and non-fatal warnings.
 */
export function checkProductionReadiness(
  config: AppConfig,
  clusterState?: ClusterStateContext,
  env: Record<string, string | undefined> = process.env,
): {
  fatal: string[];
  warnings: string[];
} {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const shadowed = profileShadowWarning(resolveOperationalProfile(env, ["APP_ENV"]));
  if (shadowed !== undefined) warnings.push(shadowed);

  const isProd = config.appEnv === "production";
  // The regulated presets promise a hardened posture: in the production
  // operational profile their three core controls (durable audit anchor, pinned
  // egress, asymmetric evidence key) are fatal instead of warnings.
  const regulatedPreset =
    config.profile === "regulated" ||
    config.profile === "regulated-multitenant";
  const presetPrefix = regulatedPreset
    ? `Preset "${config.profile}" in production: `
    : "";

  if (
    config.authnMode === "disabled" &&
    config.tenantIsolationEnabled === true
  ) {
    fatal.push(
      "AUTHN_MODE=disabled cannot be used with TENANT_ISOLATION_ENABLED=true; tenant isolation requires an authenticated tenant principal.",
    );
  }

  // Unified security model. Legacy variables remain accepted when AUTHN_MODE is
  // absent, but production must be explicit and OIDC-only.
  if (config.authnMode === undefined) {
    warnings.push(
      "AUTHN_MODE is not set; legacy JWT/OIDC precedence is active. Set disabled|token|oidc|token_or_oidc explicitly.",
    );
  }
  if (!isProd && config.authnMode === "disabled") {
    warnings.push(
      "AUTHN_MODE=disabled: every endpoint answers without a credential. /health and " +
        "/health/ready report auth: disabled. Fine for local development; production " +
        "refuses it.",
    );
  }
  if (isProd && config.authnMode !== "oidc") {
    fatal.push(
      "Production requires AUTHN_MODE=oidc; local token/API-key primary credentials are not permitted.",
    );
  }
  if (isProd && config.authzEnabled !== true) {
    fatal.push("Production requires AUTHZ_ENABLED=true.");
  }
  if (isProd && config.tenantIsolationEnabled !== true) {
    fatal.push("Production requires TENANT_ISOLATION_ENABLED=true.");
  }
  if (config.authnMode === "oidc") {
    if (config.oidcIssuer === undefined || config.oidcAudience === undefined) {
      const msg =
        "AUTHN_MODE=oidc requires both OIDC_ISSUER and OIDC_AUDIENCE.";
      if (isProd) fatal.push(msg);
      else warnings.push(msg);
    }
    if (isProd && (config.operatorTokens?.length ?? 0) > 0) {
      fatal.push(
        "AUTHN_MODE=oidc production must not configure OPERATOR_TOKENS; operator identity must derive from external OIDC.",
      );
    }
    if (config.jwtSecret !== undefined || config.jwtJwksUrl !== undefined) {
      const msg =
        "AUTHN_MODE=oidc ignores JWT_SECRET and JWT_JWKS_URL; remove local or raw token-primary credentials. JWT_ADDITIONAL_ISSUERS remains allowed only for issuer/audience-pinned external OIDC providers.";
      if (isProd) fatal.push(msg);
      else warnings.push(msg);
    }
    for (const [index, issuer] of (
      config.inferenceExtraOidcIssuers ?? []
    ).entries()) {
      if (issuer.audience === undefined) {
        const msg = `JWT_ADDITIONAL_ISSUERS[${index}] must configure audience in OIDC-only mode.`;
        if (isProd) fatal.push(msg);
        else warnings.push(msg);
      }
    }
  }
  if (
    config.jwtJwksUrl !== undefined &&
    (config.jwtIssuer === undefined || config.jwtAudience === undefined)
  ) {
    const msg =
      "JWT_JWKS_URL must be bound to both JWT_ISSUER and JWT_AUDIENCE; signature-only JWKS verification is unsafe.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }
  if (
    isProd &&
    config.tenantIsolationEnabled === true &&
    (config.tenantRlsEnabled !== true || config.tenantRlsRequired !== true)
  ) {
    fatal.push(
      "Tenant-isolated production requires TENANT_RLS_ENABLED=true and TENANT_RLS_REQUIRED=true (no RLS opt-out).",
    );
  }

  // Several trusted issuers + tenant isolation: without an issuer→tenant
  // binding, any of them can assert any tenant.
  const trustedIssuerCount =
    (config.inferenceExtraOidcIssuers?.length ?? 0) +
    (config.oidcIssuer !== undefined ? 1 : 0) +
    (config.jwtIssuer !== undefined || config.jwtSecret !== undefined ? 1 : 0);
  if (
    config.tenantIsolationEnabled === true &&
    trustedIssuerCount > 1 &&
    config.jwtIssuerTenants === undefined
  ) {
    const msg =
      "Tenant isolation with more than one trusted token issuer requires JWT_ISSUER_TENANTS; otherwise every issuer may claim every tenant.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  if (isProd && config.toolOutputValidatorEnabled === false) {
    warnings.push(
      "TOOL_OUTPUT_VALIDATOR_ENABLED=false: MCP tool results and retrieved RAG chunks reach the model without an indirect prompt-injection scan.",
    );
  }

  if (isProd && config.taintWriteToolsRequireApproval === false) {
    warnings.push(
      "TAINT_WRITE_TOOLS_REQUIRE_APPROVAL=false: after the injection scan flags retrieved or tool text, write tools still run without human approval.",
    );
  }
  if (isProd && config.retrievalContextMode === "legacy") {
    warnings.push(
      "RETRIEVAL_CONTEXT_MODE=legacy: retrieved chunks are handed to the model as a plain list, not as a delimited untrusted-data block.",
    );
  }

  if (config.corsOrigins.includes("*")) {
    const msg =
      "CORS_ORIGINS is set to '*' (any origin). Set an explicit allow-list of origins.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  if (!config.monitoringAuthRequired) {
    const msg =
      "MONITORING_AUTH is disabled — the monitoring stream (node IDs, latencies, errors) is public. Set MONITORING_AUTH=true.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  if (config.debugCaptureRequestTokens) {
    const msg =
      "DEBUG_CAPTURE_REQUEST_TOKENS is enabled — raw bearer tokens and credential headers are written into the persisted monitoring/execution store. Disable it (mask credentials) outside short-lived debugging.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  if (config.metricsEnabled && !config.metricsAuthRequired) {
    const msg =
      "METRICS_AUTH is disabled — /metrics is publicly scrapeable. Set METRICS_AUTH=true or restrict network access.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  if (isProd && config.redisUrl === undefined) {
    warnings.push(
      "REDIS_URL is not set — rate limiting, concurrency limits, thread locks, idempotency and approvals use per-replica in-memory state. This is safe for a SINGLE replica only; set REDIS_URL before running more than one replica.",
    );
  }

  // REPLICAS documents the intended replica count so the gate can flag state
  // that would multiply or diverge per process even with REDIS_URL set.
  if ((config.replicas ?? 1) > 1 && config.redisUrl === undefined) {
    warnings.push(
      `REPLICAS is ${config.replicas} but REDIS_URL is unset — the GitOps webhook rate limit (and any other store not backed by DATABASE_URL) is per replica, so clients get up to ${config.replicas}× the webhook budget and per-replica throttles diverge. Set REDIS_URL to share the throttle across replicas.`,
    );
  }
  // Process-local state that REDIS_URL does not share (roadmap: docs/UPGRADE.md,
  // "Not yet shared between replicas"). Warn, don't fail: single-replica and
  // sticky-session deployments are legitimate.
  if ((config.replicas ?? 1) > 1) {
    if (config.embedSearchFigures === true && config.mediaBaseUrl !== undefined) {
      warnings.push(
        `REPLICAS is ${config.replicas} and show_figure is enabled (EMBED_SEARCH_FIGURES, MEDIA_BASE_URL) — figures are held in a per-process media store, so a link opened on another replica is a 404. Route /v1/media/* to the replica that served the answer (sticky routing) or keep one replica for figure-embedding flows.`,
      );
    }
    if (config.decisionReceiptsEnabled === true) {
      warnings.push(
        `REPLICAS is ${config.replicas} and DECISION_RECEIPTS_ENABLED is set — the receipt transparency log numbers its leaves and builds its tree per process, so replicas produce diverging logs. Run receipt-issuing flows on one replica until the log is shared.`,
      );
    }
  }
  if (
    (config.replicas ?? 1) > 1 &&
    config.redTeamScheduleFlows !== undefined &&
    config.redTeamScheduleFlows.length > 0
  ) {
    warnings.push(
      `REPLICAS is ${config.replicas} and RED_TEAM_SCHEDULE_FLOWS is set — every replica runs its own red-team schedule, so each scheduled test executes ${config.replicas}× per interval. Run the schedule on a single replica (dedicated service without RED_TEAM_SCHEDULE_FLOWS elsewhere) or move it to an external scheduler.`,
    );
  }

  // Production does not accept raw operator credentials in URL query strings.
  // A ticket secret is therefore required for browser transports that cannot
  // attach Authorization headers (SSE/WebSocket).
  if (
    isProd &&
    config.monitoringAuthRequired &&
    config.monitoringTicketSecret === undefined
  ) {
    fatal.push(
      "MONITORING_AUTH=true but MONITORING_TICKET_SECRET is not set. Production disables raw URL-token fallback; set a random 32+ character ticket secret for SSE/WebSocket authentication.",
    );
  }

  // RLS not configured in production without explicit opt-out → warn so operators
  // don't accidentally run multi-tenant production without defense-in-depth.
  if (
    isProd &&
    config.databaseUrl !== undefined &&
    config.tenantRlsEnabled !== true
  ) {
    const rlsOptedOut = config.tenantRlsRequired === false;
    if (!rlsOptedOut) {
      warnings.push(
        "TENANT_RLS_ENABLED is not set — Postgres Row-Level Security (defense-in-depth " +
          "tenant isolation) is disabled. For multi-tenant production deployments, run " +
          "`bun run scripts/cli.ts rls-setup --confirm` and set " +
          "TENANT_RLS_ENABLED=true + TENANT_RLS_REQUIRED=true. " +
          "Set TENANT_RLS_REQUIRED=false to silence this warning when RLS is intentionally omitted.",
      );
    }
  }

  if (
    config.tenantRlsEnabled === true &&
    config.databaseOperatorUrl === undefined
  ) {
    const msg =
      "TENANT_RLS_ENABLED is true but DATABASE_OPERATOR_URL is not set. " +
      "Cross-tenant operator-plane reads (execution history, cost dashboards, audit log) " +
      "will return empty results under FORCE ROW LEVEL SECURITY. " +
      "Set DATABASE_OPERATOR_URL to a BYPASSRLS role URL.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  // JWT verification.
  //
  // Must list EVERY configuration that actually produces a verifier, otherwise
  // the gate rejects a deployment that verifies correctly and pushes the
  // operator toward `JWT_ALLOW_UNVERIFIED=true` — i.e. a gate bug that talks
  // someone into a genuinely insecure setup. `JWT_ADDITIONAL_ISSUERS` (JWKS per
  // issuer) and `OIDC_SESSION_SECRET` (HS256 secret for backend-minted operator
  // sessions) both establish verification on their own.
  const hasJwtVerifier =
    config.jwtSecret !== undefined ||
    (config.jwtJwksUrl !== undefined &&
      config.jwtIssuer !== undefined &&
      config.jwtAudience !== undefined) ||
    config.oidcIssuer !== undefined ||
    (config.inferenceExtraOidcIssuers !== undefined &&
      config.inferenceExtraOidcIssuers.length > 0) ||
    config.oidcSessionSecret !== undefined;

  if (!hasJwtVerifier && config.authnMode !== "disabled") {
    if (config.allowUnverifiedJwt === true) {
      const msg =
        "JWT_ALLOW_UNVERIFIED=true — cryptographic JWT verification is DISABLED " +
        "(any well-formed 3-segment token is accepted). Never use this in production. " +
        "For safer local development, set JWT_SECRET to a random value instead.";
      if (isProd) fatal.push(msg);
      else warnings.push(msg);
    } else {
      fatal.push(
        "JWT signature verification is not configured (format-only). Any token with a " +
          "valid 3-segment Base64URL format would be accepted. Set JWT_SECRET, JWT_JWKS_URL " +
          "or OIDC_ISSUER to enable cryptographic verification. For local development only, " +
          "set JWT_ALLOW_UNVERIFIED=true to consciously accept format-only auth. " +
          "Quick dev setup: JWT_SECRET=$(openssl rand -hex 32)",
      );
    }
  }

  if (config.requireJwtVerification === true && !hasJwtVerifier) {
    fatal.push(
      "JWT_REQUIRE_VERIFICATION=true but no JWT_SECRET, JWT_JWKS_URL or OIDC_ISSUER is set. " +
        "Either configure a verifier or remove JWT_REQUIRE_VERIFICATION.",
    );
  }

  // Plugin sandboxing reminder
  if (config.pluginsDir !== undefined) {
    const pluginMsg =
      "PLUGINS_DIR is set — loaded plugin modules run IN-PROCESS with full application " +
      "privileges (arbitrary code execution). Ensure every file in PLUGINS_DIR is reviewed, " +
      "trusted, and ideally protected by a PLUGINS_MANIFEST_PATH SHA-256 manifest. " +
      "Never point PLUGINS_DIR at a user-writable or externally-sourced directory.";
    if (isProd) warnings.push(pluginMsg);
    else warnings.push(pluginMsg);
  }

  // Trusted identity headers — only sound behind a header-stripping proxy.
  if (config.trustedIdentityHeaders === true) {
    const msg =
      "TRUSTED_IDENTITY_HEADERS=true — the X-OpenWebUI-User-Role header and " +
      "metadata.clientId/plan may supply role/tenant/plan when the token carries no such claim. " +
      "This is ONLY safe when a reverse proxy strips these headers from inbound client requests and " +
      "sets them itself; otherwise any caller with a valid user token can assert a role reserved by " +
      "flows/access.yaml allowRoles, or run on another tenant's BYOK key and budget. " +
      "Prefer emitting role/client_id/tid as verified JWT claims instead.";
    if (isProd) warnings.push(msg);
    else warnings.push(msg);
  }

  // BYOK / PII vault must never silently degrade to plaintext-in-memory
  // storage of what is, by definition, a secret. `bootstrap/persistence.ts`
  // catches an invalid/missing encryption key and falls back to
  // InMemoryTenantProviderKeyStore / InMemoryPiiVaultStore — those keep raw
  // secrets in process heap, per-replica, forever (until restart). That
  // degradation is appropriate for local development but must be a conscious,
  // gated choice in production, not something a missing env var falls into.
  // BYOK_MODE=required is a cross-field invariant: without an enabled
  // resolver/store, otherwise-valid external-provider flows would fail only
  // at request time with no actionable startup diagnosis.
  if (config.byokMode === "required" && config.byokEnabled !== true) {
    fatal.push(
      "BYOK_MODE=required requires BYOK_ENABLED=true so tenant provider keys can be resolved.",
    );
  }

  if (
    config.byokEnabled === true &&
    (config.byokEncryptionKey === undefined ||
      config.byokEncryptionKey.trim().length === 0)
  ) {
    const msg =
      "BYOK_ENABLED=true but BYOK_ENCRYPTION_KEY is not set — tenant provider keys " +
      "fall back to an IN-MEMORY, UNENCRYPTED store (raw keys held in process memory, " +
      "per-replica, until restart). Set BYOK_ENCRYPTION_KEY (base64, 32 bytes — " +
      "`openssl rand -base64 32`) so BYOK keys are durable and encrypted at rest.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }
  if (
    config.piiVaultEnabled === true &&
    (config.piiVaultEncryptionKey === undefined ||
      config.piiVaultEncryptionKey.trim().length === 0)
  ) {
    const msg =
      "PII_VAULT_ENABLED=true but PII_VAULT_ENCRYPTION_KEY is not set — tokenized PII " +
      "mappings fall back to an IN-MEMORY, UNENCRYPTED store. Set PII_VAULT_ENCRYPTION_KEY " +
      "(base64, 32 bytes — `openssl rand -base64 32`) for durable, encrypted-at-rest storage.";
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  }

  if (isProd && config.toolAuthzFailClosed !== true) {
    warnings.push(
      "TOOL_AUTHZ_FAIL_CLOSED is disabled — a malformed tool-authz.json at startup fails OPEN " +
        "(all tool calls allowed). Set TOOL_AUTHZ_FAIL_CLOSED=true so a broken policy denies all tool calls. " +
        "This is especially important in access-control deployments. The secure default (SECURE_DEFAULTS) has this as true.",
    );
  }

  // API-key hashing (Req 7.9): without API_KEY_PEPPER, keys are stored as
  // unsalted SHA-256 — a database dump can then be brute-forced offline at
  // the attacker's leisure. With a pepper, keys hash as HMAC-SHA-256 and a
  // dump alone is not enough. Existing SHA-256 rows migrate lazily on the
  // next successful lookup once the pepper is set.
  if (
    isProd &&
    (config.apiKeyPepper === undefined ||
      config.apiKeyPepper.trim().length === 0)
  ) {
    warnings.push(
      "API_KEY_PEPPER is not set — API keys are stored as unsalted SHA-256, so a " +
        "database dump alone can be brute-forced offline. Set API_KEY_PEPPER " +
        "(e.g. `openssl rand -base64 32`) so keys hash as HMAC-SHA-256 with a " +
        "server-side pepper; existing SHA-256 hashes migrate automatically on " +
        "their next successful lookup.",
    );
  }

  // Transaction-token signing (Req 7.11): HS256 requires every verifier (e.g.
  // the Gate) to hold the SAME shared secret — a leak anywhere can mint valid
  // tokens. Asymmetric modes (ES256/EdDSA) publish only the public key via
  // /.well-known/atf-transaction-jwks.json. Per the design config table,
  // HS256 in production is a warning, not a blocker (it stays supported).
  if (isProd) {
    try {
      const txConfig = transactionTokenConfigFromEnv(env);
      if (txConfig !== undefined && (txConfig.alg ?? "HS256") === "HS256") {
        warnings.push(
          "Transaction tokens are signed with HS256 — every verifier must hold the " +
            "shared AGENT_TRANSACTION_SECRET. Prefer TRANSACTION_SIGNING_ALG=ES256 " +
            "(or EdDSA) with a PKCS8 key in TRANSACTION_SIGNING_KEY: the runtime then " +
            "publishes the public key under /.well-known/atf-transaction-jwks.json and " +
            "verifiers (Gate: MCPGATE_TRANSACTION_JWKS_URI) never need the secret.",
        );
      }
    } catch (error) {
      fatal.push(
        `Transaction signing configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Autopilot governance: the Continuous Safety & Quality Autopilot loop
  // (red-team → optimizer → canary) is only wired up when both RED_TEAM_ENABLED
  // and OPTIMIZER_ENABLED are set. When active in production without an
  // explicit AUTOPILOT_REQUIRE_APPROVAL decision, it defaults to requiring
  // human approval (safe) — but an operator who set AUTOPILOT_REQUIRE_APPROVAL=false
  // without also reviewing the drift-guard settings is flagged here so the
  // decision to let the loop rewrite live prompts unattended is a conscious one.
  const autopilotActive =
    config.redTeamEnabled === true && config.optimizerEnabled === true;
  if (isProd && autopilotActive && config.autopilotRequireApproval === false) {
    warnings.push(
      "AUTOPILOT_REQUIRE_APPROVAL=false in production — the Continuous Safety & Quality " +
        "Autopilot may automatically PUBLISH new flow versions (prompt/model changes) without " +
        "human review, subject only to the judge≠candidate self-grading guard and the " +
        `drift-guard cap (${config.autopilotMaxAutoPromotionsPerWindow ?? 3} promotions / ` +
        `${Math.round((config.autopilotDriftWindowMs ?? 86_400_000) / 3_600_000)}h). ` +
        "Confirm this is intentional; the safer default is to leave AUTOPILOT_REQUIRE_APPROVAL unset " +
        "(or true) and promote manually via POST /optimizer/runs/:id/promote after reviewing each recommendation.",
    );
  }

  // ── Cluster-State & RLS checks (Req 2.2, 2.3, 3.1) ────────────────────────
  if (clusterState?.compliancePolicyLoaded !== undefined) {
    const compliance = checkCompliancePolicyRequirement(config, clusterState.compliancePolicyLoaded);
    fatal.push(...compliance.fatal);
    warnings.push(...compliance.warnings);
  }

  if (clusterState !== undefined) {
    if (clusterState.storeBacking === "memory") {
      const states =
        "Rate-Limit, Semaphore, Approval-Log, Monitoring-History, Semantic-Cache";
      const msg =
        `In-Memory store backing is active for cluster-wide states (${states}). ` +
        "These states are per-replica only and will diverge across multiple instances. " +
        "Configure REDIS_URL or DATABASE_URL for a cluster-wide store.";
      if (isProd) {
        if (config.clusterStateOptOut === true) {
          warnings.push(
            `[CLUSTER_STATE_OPT_OUT active] ${msg} ` +
              "The operator has explicitly opted out of the cluster-state production gate.",
          );
        } else {
          fatal.push(msg);
        }
      } else {
        warnings.push(
          `${msg} Scaling risk: running more than one replica will silently break ` +
            "rate limiting, concurrency limits, approval tracking, monitoring history, and semantic caching.",
        );
      }
    }

    if (!clusterState.rlsVerified) {
      if (isProd) {
        const rlsOptedOut =
          config.tenantIsolationEnabled !== true &&
          (config.tenantRlsRequired === false ||
            config.tenantRlsEnabled === false);
        const tenantNote =
          clusterState.tenantCount !== undefined && clusterState.tenantCount > 1
            ? ` This deployment currently has ${clusterState.tenantCount} tenants — ` +
              "cross-tenant isolation relies solely on application-level query predicates until RLS is enforced."
            : "";
        if (rlsOptedOut) {
          warnings.push(
            "[TENANT_RLS opt-out active] RLS (Row Level Security) is not verified as active " +
              "for tenant tables. The operator has explicitly opted out of the RLS production gate " +
              "(TENANT_RLS_REQUIRED=false or TENANT_RLS_ENABLED=false). " +
              `Tenant data isolation is NOT enforced.${tenantNote}`,
          );
        } else {
          fatal.push(
            "RLS (Row Level Security) is not verified as active for tenant tables. " +
              "Tenant data isolation cannot be guaranteed. " +
              "Run `bun run scripts/cli.ts rls-setup --confirm` " +
              "so the database reports relrowsecurity/relforcerowsecurity as enabled for all tenant-scoped " +
              `tables.${tenantNote}`,
          );
        }
      } else if (clusterState.storeBacking === "memory") {
        warnings.push(
          "RLS (Row Level Security) is not verified as active for tenant tables. " +
            "Tenant data isolation is not enforced.",
        );
      }
    }
  }

  // Req 1.8 (platform-hardening): in production the audit chain must be
  // externally anchored so a wholesale internally-consistent rebuild is
  // detectable. Without AUDIT_ANCHOR_FILE the signed checkpoints live only in
  // process memory and are lost on restart — warn (non-fatal, so existing
  // deployments are not broken) when anchoring has no durable file target.
  // Under a regulated preset the same finding is fatal.
  if (isProd && config.auditAnchorFile === undefined) {
    const msg =
      "AUDIT_ANCHOR_FILE is not set: signed audit-chain checkpoints are kept " +
      "in memory only and lost on restart. Configure AUDIT_ANCHOR_FILE (with " +
      "EVIDENCE_SIGNING_KEY, Ed25519; AUDIT_ANCHOR_SECRET only for legacy HMAC " +
      "anchors) so external anchors survive restarts and a tampered chain " +
      "rebuild stays detectable.";
    if (regulatedPreset) fatal.push(`${presetPrefix}${msg}`);
    else warnings.push(msg);
  }

  // Egress_Guard: an empty EGRESS_ALLOWED_HOSTS means "any public host". The
  // guard still blocks private and metadata ranges, but a flow, tool or MCP
  // server can reach every public destination — which is not what a record of
  // processing that names its recipients assumes. Under a regulated preset
  // the same finding is fatal.
  if (isProd && (config.egressAllowedHosts ?? []).length === 0) {
    const msg =
      "EGRESS_ALLOWED_HOSTS is empty: every public host is a permitted destination for " +
      "guarded outbound calls (tools, MCP, providers). Set the destinations you actually " +
      "use (exact hosts or `.suffix` domains) so the recipients named in the record of " +
      "processing are the only ones reachable.";
    if (regulatedPreset) fatal.push(`${presetPrefix}${msg}`);
    else warnings.push(msg);
  }
  // ADR 0030: HMAC-signed anchors/bundles/receipts can only be verified by
  // someone holding the shared secret — auditors, regulators, and customers
  // cannot check them independently. Warn (non-fatal: legacy HMAC deployments
  // keep working) when the evidence chain is active without the asymmetric
  // EVIDENCE_SIGNING_KEY. Under a regulated preset a missing key is fatal
  // regardless of whether HMAC secrets are set.
  if (regulatedPreset) {
    if (isProd && config.evidenceSigningKey === undefined) {
      fatal.push(
        `${presetPrefix}EVIDENCE_SIGNING_KEY is not set. The evidence chain ` +
          "(audit anchors / Evidence Bundles) needs the Ed25519 key (ADR 0030) " +
          "so anchors, bundles, and Erasure Receipts carry signatures verifiable " +
          "offline via /.well-known/atf-evidence-jwks.json, without sharing any " +
          "secret.",
      );
    }
  } else if (
    isProd &&
    config.evidenceSigningKey === undefined &&
    (config.auditAnchorSecret !== undefined ||
      config.evidenceBundleSecret !== undefined)
  ) {
    warnings.push(
      "The evidence chain (audit anchors / Evidence Bundles) is signed with an " +
        "HMAC shared secret, so third parties cannot verify it independently. " +
        "Configure EVIDENCE_SIGNING_KEY (Ed25519, ADR 0030) — anchors, bundles, " +
        "and Erasure Receipts then carry Ed25519 signatures verifiable offline " +
        "via /.well-known/atf-evidence-jwks.json, without sharing any secret.",
    );
  }

  // Audit pseudonyms of erasure subjects are keyed with AUDIT_PSEUDONYM_PEPPER.
  // Without a pepper they degrade to unkeyed SHA-256 values, which an attacker
  // who guesses a subject identifier can recompute and match against entries.
  if (isProd && config.auditPseudonymPepper === undefined) {
    warnings.push(
      "AUDIT_PSEUDONYM_PEPPER is not set: audit pseudonyms of erasure subjects are unkeyed SHA-256 values that anyone who knows an identifier can recompute. Set a random secret of at least 32 characters.",
    );
  }

  return { fatal, warnings };
}
