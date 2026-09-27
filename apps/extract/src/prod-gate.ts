// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * prod-gate.ts
 *
 * Production-readiness gate for the extraction service.
 *
 * Same contract as `apps/search/src/prod-gate.ts` and the equivalents in Gate
 * and Runtime: **a permissive setting is a startup failure in production and a
 * loud warning everywhere else.**
 *
 * This service needs the gate for a reason specific to what it does. Its
 * defaults are built for a laptop: with no `API_TOKEN`, no OIDC and no JWT
 * issuers, the auth middleware waves everything through — and "everything" here
 * means an endpoint that accepts an arbitrary file upload, spawns LibreOffice on
 * it, and spends model tokens per page. An unauthenticated deployment is
 * therefore not only a data-exfiltration path via `/v1/ingest` but an
 * unmetered bill and a remote-code-execution surface through a document parser.
 * Nothing in the process said so before this file existed.
 *
 * The gate is pure: it takes a config and returns findings. `src/index.ts`
 * decides whether to exit, which keeps this fully testable.
 */

import type { Config } from "./config.js";

export interface ProductionReadinessReport {
  /** Issues that must abort startup in production. */
  fatal: string[];
  /** Issues that are surfaced but do not abort. */
  warnings: string[];
  /** The environment the gate judged against. */
  environment: string;
}

/** True when no credential is configured and every endpoint is public. */
export function isAuthDisabled(config: Config): boolean {
  return config.authnMode === "disabled";
}

export function checkProductionReadiness(
  config: Config,
  environment: string = config.nodeEnv,
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
      "No authentication is configured (AUTHN_MODE=disabled) — document conversion, " +
        "Search ingest and the async callback are open to anyone who can reach the port.",
    );
  }
  if (isProd && config.authnMode !== "oidc") {
    fatal.push("Production requires AUTHN_MODE=oidc.");
  }
  if (isProd && (config.apiToken !== null || config.monitorToken !== null)) {
    fatal.push("API_TOKEN and MONITOR_TOKEN must be unset in the OIDC-only production profile.");
  }

  const tokenEnabled = config.authnMode === "token" || config.authnMode === "token_or_oidc";
  if (tokenEnabled && config.apiToken !== null && config.apiToken.length < 32) {
    flag(
      "API_TOKEN is shorter than 32 characters — it is a single shared secret granting " +
        "conversion and ingest. Use a high-entropy value.",
    );
  }
  if (config.monitorToken !== null && config.monitorToken.length < 32) {
    flag("MONITOR_TOKEN is shorter than 32 characters — use a high-entropy value.");
  }
  if (
    config.apiToken !== null &&
    config.monitorToken !== null &&
    config.apiToken === config.monitorToken
  ) {
    flag(
      "API_TOKEN and MONITOR_TOKEN are identical — the UI credential and the programmatic " +
        "credential cannot then be rotated or revoked independently.",
    );
  }
  if (config.authzEnabled !== true) {
    flag("AUTHZ_ENABLED must be true in production.");
  }
  if (config.tenantIsolationEnabled !== true) {
    flag("TENANT_ISOLATION_ENABLED must be true in production.");
  }
  if (!config.defaultTenantId.trim()) {
    flag("DEFAULT_TENANT_ID must be non-empty.");
  }
  if (tokenEnabled) {
    const required = ["extract.convert", "extract.ingest"];
    const missing = required.filter((scope) => !config.apiServiceScopes.includes(scope));
    if (missing.length > 0) {
      flag(`API_SERVICE_SCOPES is missing required static-service scopes: ${missing.join(", ")}.`);
    }
  }

  // ── JWT issuer pinning ────────────────────────────────────────────────────
  // Without `audience`, a token the same IdP minted for a DIFFERENT service
  // verifies here and is accepted.
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
        `API_OIDC_ISSUERS[${i}] ("${issuer.issuer}") is not https — discovery and JWKS would be ` +
          "fetched over an unauthenticated channel.",
      );
    }
    if (config.authzEnabled && !issuer.scopesClaim) {
      flag(`API_OIDC_ISSUERS[${i}] must configure scopesClaim when AUTHZ_ENABLED=true.`);
    }
    if (config.tenantIsolationEnabled && !issuer.tenantClaim) {
      flag(
        `API_OIDC_ISSUERS[${i}] must configure tenantClaim when TENANT_ISOLATION_ENABLED=true.`,
      );
    }
  }

  // ── Outbound credentials ──────────────────────────────────────────────────

  if (config.search !== null) {
    if (config.search.token === null) {
      flag(
        "SEARCH_URL is configured without SEARCH_TOKEN — ingest would be attempted " +
          "unauthenticated, which either fails or means Search itself is open.",
      );
    }
    if (isProd && !config.search.url.startsWith("https://")) {
      fatal.push("SEARCH_URL must be https in production; ingest carries document content.");
    }
  }
  if (isProd && config.visionApiKey === null && !config.visionUrl.startsWith("http://")) {
    // A public HTTPS endpoint with no key is almost certainly a misconfiguration;
    // an in-cluster plain-HTTP vLLM legitimately has none.
    warnings.push(
      "VISION_API_KEY is unset for a non-local VISION_URL — confirm the endpoint really is " +
        "unauthenticated rather than silently rejecting every page.",
    );
  }

  // ── Error disclosure ──────────────────────────────────────────────────────

  if (config.exposeErrorDetail) {
    flag(
      "EXPOSE_ERROR_DETAIL is enabled — internal error messages, including converter " +
        "command lines and temporary file paths, are returned to clients.",
    );
  }

  // ── Throttling / proxy / resource limits ──────────────────────────────────

  if (config.rateLimit === 0) {
    flag(
      "RATE_LIMIT is 0 — request throttling is disabled entirely on an endpoint where each " +
        "request spawns a document converter and spends model tokens.",
    );
  }
  if (!config.trustProxy) {
    warnings.push(
      "TRUST_PROXY is disabled — behind a reverse proxy every request appears to come from " +
        "the proxy's IP, so the per-IP rate limit is shared by all clients.",
    );
  }
  if (config.maxPages === 0) {
    flag(
      "MAX_PAGES is 0 — a single upload can occupy the converter and spend model tokens " +
        "without bound. Set a ceiling that matches your document corpus.",
    );
  }
  if (config.visionTimeoutMs === 0) {
    flag(
      "VISION_TIMEOUT_MS is 0 — a stalled model connection holds a conversion slot forever.",
    );
  }

  // ── Server-side request forgery ───────────────────────────────────────────
  // X-Callback-URL makes this service issue a request to an address the caller
  // chose. Link-local and metadata addresses are always refused, but everything
  // else the container can reach is fair game without an allowlist.
  if (config.callbackAllowedHosts.length === 0) {
    flag(
      "CALLBACK_ALLOWED_HOSTS is empty — X-Callback-URL may target any public host, which is " +
        "a blind server-side request forgery primitive towards the internet, and internal " +
        "receivers are refused. List the hosts your orchestrator actually uses.",
    );
  }
  // The `source_url` pull is the same SSRF primitive, and is only reachable when
  // the v2 upload routes are mounted (i.e. a database is configured). With the
  // routes live, an empty allowlist fails closed in production.
  if (config.database !== null && config.sourceUrl.allowedHosts.length === 0) {
    flag(
      "SOURCE_URL_ALLOWED_HOSTS is empty — a v2 upload's source_url may target any host this " +
        "container can reach, which is a server-side request forgery primitive. List the hosts " +
        "your sources actually come from.",
    );
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  // Without a database the service runs the v1 synchronous paths only: no
  // persistent, resumable v2 jobs, no resumable uploads and no source_url
  // pulls. A legitimate deployment shape, so a warning rather than a failure.
  if (isProd && config.database === null) {
    warnings.push(
      "EXTRACT_DATABASE_URL is unset — v2 jobs, resumable uploads and source_url pulls are " +
        "disabled, and an interrupted conversion cannot resume. Configure it for large documents.",
    );
  }

  return { fatal, warnings, environment };
}
