// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * prod-gate.ts
 *
 * Production-readiness gate for vectorsearch.
 *
 * Modelled on aiperator's `src/config/prod-gate.ts` and mcpgate's
 * `src/config/prod-gate.ts` so all three services enforce the same contract:
 * **a permissive setting is a startup failure in production and a loud warning
 * everywhere else.**
 *
 * This service needs it most. Its defaults were built for a single-user local
 * setup: with no `API_TOKEN`, no `MONITOR_TOKEN`, no OIDC and no JWT issuers,
 * the auth middleware waves every request through — which means an unprotected
 * deployment has open ingest, open delete, open search and an open MCP endpoint.
 * That is convenient locally and indefensible anywhere else, and nothing in the
 * process previously said so.
 *
 * The gate is pure: it takes a config and returns findings. `src/index.ts`
 * decides whether to exit, which keeps this fully testable.
 */

import type { OperationalProfile } from "@atf/security-kit";
import type { Config } from "./config.js";

export interface ProductionReadinessReport {
  /** Issues that must abort startup in production. */
  fatal: string[];
  /** Issues that are surfaced but do not abort. */
  warnings: string[];
  /** The operational profile the gate judged against. */
  environment: OperationalProfile;
}

/**
 * True when no credential of any kind is configured, i.e. the auth middleware
 * short-circuits and every endpoint is public.
 */
export function isAuthDisabled(config: Config): boolean {
  return config.authnMode === "disabled";
}

export function checkProductionReadiness(
  config: Config,
  environment: OperationalProfile = config.nodeEnv,
): ProductionReadinessReport {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const isProd = environment === "production";
  const flag = (msg: string): void => {
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  };

  // ── Authentication ────────────────────────────────────────────────────────

  if (isAuthDisabled(config)) {
    flag(
      "No authentication is configured (AUTHN_MODE=disabled) — ingest, delete, search and the MCP endpoint are open.",
    );
  }
  if (isProd && config.authnMode !== "oidc") {
    fatal.push("Production requires AUTHN_MODE=oidc.");
  }
  if (
    isProd &&
    (config.apiToken !== null ||
      config.monitorToken !== null ||
      config.apiTokenNext != null)
  ) {
    fatal.push(
      "API_TOKEN, API_TOKEN_NEXT and MONITOR_TOKEN must be unset in the OIDC-only production profile.",
    );
  }

  const tokenEnabled =
    config.authnMode === "token" || config.authnMode === "token_or_oidc";
  if (tokenEnabled && config.apiToken !== null && config.apiToken.length < 32) {
    flag(
      "API_TOKEN is shorter than 32 characters — it is a single shared secret " +
        "granting full read and write access. Use a high-entropy value.",
    );
  }

  if (
    tokenEnabled &&
    config.apiTokenNext != null &&
    config.apiTokenNext.length < 32
  ) {
    flag(
      "API_TOKEN_NEXT is shorter than 32 characters — the rotation token grants " +
        "the same access as API_TOKEN. Use a high-entropy value.",
    );
  }

  if (config.monitorToken !== null && config.monitorToken.length < 32) {
    flag(
      "MONITOR_TOKEN is shorter than 32 characters — use a high-entropy value.",
    );
  }

  if (
    config.apiToken !== null &&
    config.monitorToken !== null &&
    config.apiToken === config.monitorToken
  ) {
    flag(
      "API_TOKEN and MONITOR_TOKEN are identical — the admin UI credential and the " +
        "programmatic credential cannot then be rotated or revoked independently.",
    );
  }

  if (
    config.apiToken !== null &&
    config.apiTokenNext != null &&
    config.apiToken === config.apiTokenNext
  ) {
    flag(
      "API_TOKEN and API_TOKEN_NEXT are identical — a rotation token must differ " +
        "from the token it replaces, otherwise the rotation has no effect.",
    );
  }

  if (config.authzEnabled !== true) {
    flag("AUTHZ_ENABLED must be true in production.");
  }
  if (config.tenantIsolationEnabled !== true) {
    flag("TENANT_ISOLATION_ENABLED must be true in production.");
  }
  if (!config.defaultTenantId?.trim()) {
    flag("DEFAULT_TENANT_ID must be non-empty.");
  }

  const staticCredentialConfigured = tokenEnabled;
  if (staticCredentialConfigured) {
    if (!config.defaultTenantId?.trim()) {
      flag(
        "DEFAULT_TENANT_ID is required when token authentication is enabled.",
      );
    }
    const requiredServiceScopes = [
      "vectorsearch.read",
      "vectorsearch.write",
      "vectorsearch.delete",
      "vectorsearch.admin",
      "vectorsearch.acl.manage",
      "vectorsearch.metrics",
    ];
    const missing = requiredServiceScopes.filter(
      (scope) => !config.apiServiceScopes?.includes(scope),
    );
    if (missing.length > 0) {
      flag(
        `API_SERVICE_SCOPES is missing required static-service scopes: ${missing.join(", ")}.`,
      );
    }
  }

  if (config.transactionEnforcement !== "required") {
    flag("TRANSACTION_ENFORCEMENT must be required in production.");
  }
  const transactionAlgorithms = config.transactionAlgorithms ?? ["HS256"];
  const acceptsHs256 = transactionAlgorithms.includes("HS256");
  const acceptsAsymmetric = transactionAlgorithms.some((alg) => alg !== "HS256");
  if (acceptsHs256 && (!config.transactionSecret || config.transactionSecret.length < 32)) {
    flag(
      "TRANSACTION_HS256_SECRET must be a high-entropy value of at least 32 characters.",
    );
  }
  if (acceptsAsymmetric) {
    try {
      if (new URL(config.transactionJwksUri ?? "").protocol !== "https:") {
        flag("TRANSACTION_JWKS_URI must be an https URL in production: the keys that verify transaction tokens must not travel in clear text.");
      }
    } catch {
      flag("TRANSACTION_JWKS_URI must be set to the issuer's JWKS URL when ES256 or EdDSA is accepted.");
    }
  }
  if (acceptsHs256) {
    warnings.push(
      "TRANSACTION_ALGORITHMS accepts HS256: every holder of TRANSACTION_HS256_SECRET can mint transaction tokens this service accepts. " +
        "Verify with the issuer's public key instead (TRANSACTION_JWKS_URI, ES256/EdDSA; docs/adr/0035-asymmetric-transaction-tokens-audience-per-service.md) " +
        "and drop HS256 once every issuer has switched.",
    );
  }
  if (!config.transactionIssuer?.trim())
    flag("TRANSACTION_ISSUER must be non-empty.");
  if (!config.transactionAudience?.trim())
    flag("TRANSACTION_AUDIENCE must be non-empty.");
  if (
    !Number.isInteger(config.transactionMaxTtlSeconds) ||
    config.transactionMaxTtlSeconds < 1 ||
    config.transactionMaxTtlSeconds > 900
  ) {
    flag("TRANSACTION_MAX_TTL_SECONDS must be between 1 and 900 seconds.");
  }
  const issuerMissingScopesClaim = config.apiOidcIssuers.some(
    (issuer) => config.authzEnabled && !issuer.scopesClaim,
  );
  if (isProd && issuerMissingScopesClaim) {
    fatal.push(
      "Every production API_OIDC_ISSUERS entry must configure scopesClaim.",
    );
  }
  const issuerMissingTenantClaim = config.apiOidcIssuers.some(
    (issuer) => config.tenantIsolationEnabled && !issuer.tenantClaim,
  );
  if (issuerMissingTenantClaim) {
    flag(
      "Every API_OIDC_ISSUERS entry must configure tenantClaim when TENANT_ISOLATION_ENABLED=true.",
    );
  }

  // ── JWT issuer pinning ────────────────────────────────────────────────────
  // Same reasoning as mcpgate: without `audience`, a token the same IdP minted
  // for a DIFFERENT service verifies here and is accepted.
  for (const [i, issuer] of config.apiOidcIssuers.entries()) {
    if (issuer.audience === undefined || issuer.audience.trim().length === 0) {
      flag(
        `API_OIDC_ISSUERS[${i}] ("${issuer.issuer}") has no "audience" — a token minted by ` +
          "the same issuer for a different service would authenticate here " +
          "(audience confusion). Set the expected aud/client_id.",
      );
    }
    if (!issuer.issuer.startsWith("https://")) {
      flag(
        `API_OIDC_ISSUERS[${i}] ("${issuer.issuer}") is not https — discovery and JWKS ` +
          "would be fetched over an unauthenticated channel.",
      );
    }
  }

  // ── Access control ────────────────────────────────────────────────────────

  if (!config.aclRequireIdentity) {
    // Req 3.3: in production a disabled identity requirement is fatal unless
    // the operator records an explicit, documented exception via
    // ACL_REQUIRE_IDENTITY_WAIVER — which downgrades the finding to a warning.
    // Outside production it stays a warning: a service-to-service ingest
    // legitimately has no end user.
    const waiver = config.aclRequireIdentityWaiver?.trim();
    const base =
      "ACL_REQUIRE_IDENTITY is disabled — a request that establishes no end-user " +
      "identity is treated as a service context and bypasses row- and " +
      "collection-level ACLs. Enable it if every read must be attributable.";
    if (isProd && !waiver) {
      fatal.push(
        base +
          " In production this is refused: set ACL_REQUIRE_IDENTITY=true or " +
          "record a documented exception in ACL_REQUIRE_IDENTITY_WAIVER.",
      );
    } else if (isProd) {
      warnings.push(base + ` Waiver recorded: "${waiver}".`);
    } else {
      warnings.push(base);
    }
  }

  // Req 3.2 / design: DOCUMENT_ACL_DEFAULT=allow keeps documents with an empty
  // ACL readable by every principal of the tenant. Warn in production so the
  // switch to `deny` is a deliberate deployment decision.
  if (isProd && config.documentAclDefault !== "deny") {
    warnings.push(
      "DOCUMENT_ACL_DEFAULT=allow — documents with empty allowed_users and " +
        "allowed_groups are readable by every principal of the tenant. Set " +
        "DOCUMENT_ACL_DEFAULT=deny to restrict them to service principals.",
    );
  }

  // ── Document converter ────────────────────────────────────────────────────
  // POST /ingest-file forwards the raw document to another service, so the hop
  // carries the full document content and needs the same protection the ingest
  // body itself gets.
  // Truthiness rather than `!== null`: the gate is called with hand-built config
  // objects in tests and by callers that predate this field, where the property is
  // absent rather than explicitly null.
  if (config.converter) {
    if (isProd && !config.converter.url.startsWith("https://")) {
      fatal.push(
        "CONVERTER_URL must be https in production; the request body is the complete document.",
      );
    }
    if (config.converter.token === null) {
      flag(
        "CONVERTER_URL is configured without CONVERTER_TOKEN — uploads would be sent to the " +
          "converter unauthenticated, which either fails or means the converter is open to " +
          "anyone who can reach it.",
      );
    }
  }

  // ── Error disclosure ──────────────────────────────────────────────────────

  if (config.exposeErrorDetail) {
    flag(
      "EXPOSE_ERROR_DETAIL is enabled — internal error messages (failing SQL, " +
        "constraint and column names) are returned to clients.",
    );
  }

  // ── Throttling / proxy ────────────────────────────────────────────────────

  if (config.rateLimit === 0) {
    flag("RATE_LIMIT is 0 — request throttling is disabled entirely.");
  }

  // Declaring REPLICAS > 1 without a shared store means every replica keeps
  // its own GCRA budget: the effective service-wide limit is REPLICAS ×
  // RATE_LIMIT. REPLICAS defaults to 1, so existing single-replica
  // deployments are unaffected — only an explicit multi-replica declaration
  // without RATE_LIMIT_REDIS_URL trips this.
  if (config.replicas > 1 && !config.rateLimitRedisUrl) {
    flag(
      `REPLICAS is ${config.replicas} but RATE_LIMIT_REDIS_URL is unset — the rate ` +
        `limit is per replica, so clients get up to ${config.replicas}× the budget. ` +
        "Set RATE_LIMIT_REDIS_URL to share the throttle across replicas.",
    );
  }

  if (!config.trustProxy) {
    warnings.push(
      "TRUST_PROXY is disabled — behind a reverse proxy every request appears to come " +
        "from the proxy's IP, so the per-IP rate limit is shared by all clients.",
    );
  }

  return { fatal, warnings, environment };
}
