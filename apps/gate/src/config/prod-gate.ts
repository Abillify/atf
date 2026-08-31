// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Production-readiness gate for Gate.
 *
 * Deliberately mirrors Runtime's `apps/runtime/src/config/prod-gate.ts`,
 * including the fatal/warning split, so an operator running both services meets
 * the same contract in both places: **a permissive setting is a startup failure
 * in production and a loud warning everywhere else.**
 *
 * The distinction matters because Gate's defaults are tuned for the "drop it
 * on a laptop and point an IDE at it" case — no auth beyond a static token, an
 * open dashboard, metrics on. Those are the right defaults for that case and
 * the wrong ones for a shared deployment. Rather than making local development
 * inconvenient, the gate refuses the *combination* of production and permissive.
 *
 * Environment is taken from `MCPGATE_ENV`, falling back to `NODE_ENV`. Both
 * are checked because the Dockerfile already sets `NODE_ENV=production`, so a
 * containerised deployment is gated without any extra configuration — which is
 * precisely the deployment that needs it.
 */

import type { AppConfig } from "./schema.ts";
import {
  diagnoseSqlTenantBinding,
  type SqlTenantDiagnosticStatus,
} from "./sql-tenant-diagnostic.ts";

export interface SqlTenantReadinessFinding {
  tool: string;
  database: string;
  status: Exclude<SqlTenantDiagnosticStatus, "safe">;
  reason: string;
  severity: "warning" | "fatal";
}

export interface ProductionReadinessReport {
  /** Issues that must abort startup in production. */
  fatal: string[];
  /** Issues that are surfaced but do not abort. */
  warnings: string[];
  /** Structured SQL tenant-binding findings for operators and tooling. */
  tenantSqlDiagnostics: SqlTenantReadinessFinding[];
  /** The environment the gate judged against. */
  environment: string;
}

/** Resolve the deployment environment. */
export function resolveEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = (env.MCPGATE_ENV ?? env.NODE_ENV ?? "development").trim().toLowerCase();
  return raw.length > 0 ? raw : "development";
}

/**
 * Evaluate a loaded config against the production contract.
 *
 * Pure: takes the config and the environment, returns findings. Startup wiring
 * decides what to do with them (see `src/index.ts`), which keeps this fully
 * testable without a process exit.
 */
export function checkProductionReadiness(
  config: AppConfig,
  environment: string = resolveEnvironment(),
): ProductionReadinessReport {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const tenantSqlDiagnostics: SqlTenantReadinessFinding[] = [];
  const isProd = environment === "production";
  const flag = (msg: string): void => {
    if (isProd) fatal.push(msg);
    else warnings.push(msg);
  };

  // ── Authentication ────────────────────────────────────────────────────────

  if (isProd && config.auth.mode !== "oauth") {
    fatal.push(
      `Production requires auth.mode 'oauth'; '${config.auth.mode}' is not allowed. ` +
        "Static tokens and anonymous authentication are forbidden in production.",
    );
  }
  if (isProd && !config.authorization.enabled) {
    fatal.push("Production requires authorization.enabled: true.");
  }
  if (isProd && !config.tenantIsolation.enabled) {
    fatal.push("Production requires tenantIsolation.enabled: true.");
  }

  if (config.auth.mode === "disabled") {
    flag("auth.mode is 'disabled': every request receives an anonymous AuthContext.");
  }

  if (config.auth.mode === "static") {
    const tokens = config.auth.static?.tokens ?? [];
    if (tokens.length === 0) {
      fatal.push(
        "auth.mode is 'static' but auth.static.tokens is empty — every request would be rejected. " +
          "Configure a token or switch auth.mode to 'oauth'.",
      );
    }
    // A shared static token cannot express *who* is calling, so identity-aware
    // bind parameters (`:ctx.username`) degrade to a single service identity.
    flag(
      "auth.mode is 'static': all callers share one token, so per-user identity " +
        "(`:ctx.username`, per-tool scopes, per-identity rate limits) cannot be enforced. " +
        "Use auth.mode 'oauth' (or 'both') for multi-user deployments.",
    );
  }

  for (const t of config.auth.static?.tokens ?? []) {
    if (t.token.length < 32) {
      flag(
        `auth.static token for '${t.username ?? t.subject ?? "(unnamed)"}' is shorter than 32 characters — ` +
          "use a high-entropy secret, since this single value grants the full tool surface.",
      );
    }
  }

  if (config.auth.mode === "oauth" || config.auth.mode === "both") {
    const oauth = config.auth.oauth;
    if (oauth?.allowAnyIssuer === true) {
      flag(
        "auth.oauth.allowAnyIssuer is enabled — the token issuer is not pinned, so the JWKS URI " +
          "is the only trust anchor. Set auth.oauth.issuer.",
      );
    }
    if (oauth?.allowAnyAudience === true) {
      flag(
        "auth.oauth.allowAnyAudience is enabled — a token minted by the same IdP for a DIFFERENT " +
          "service will authenticate here (audience confusion). Set auth.oauth.audience.",
      );
    }
    for (const [i, extra] of (oauth?.additionalIssuers ?? []).entries()) {
      if (extra.allowAnyIssuer) {
        flag(`auth.oauth.additionalIssuers[${i}].allowAnyIssuer is enabled — pin its issuer.`);
      }
      if (extra.allowAnyAudience) {
        flag(
          `auth.oauth.additionalIssuers[${i}].allowAnyAudience is enabled — pin its audience.`,
        );
      }
    }
  }

  // ── Transport exposure ────────────────────────────────────────────────────

  if (config.server.cors.enabled && config.server.cors.origins.includes("*")) {
    flag(
      "server.cors.origins includes '*' with credentials enabled — set an explicit origin allow-list.",
    );
  }

  if (config.server.allowedHosts.length === 0) {
    warnings.push(
      "server.allowedHosts is empty — DNS-rebinding protection is off. Set the hostnames this " +
        "server is reachable under when it is exposed beyond localhost.",
    );
  }

  if (!config.server.rateLimit.enabled) {
    flag("server.rateLimit.enabled is false — the MCP and auth endpoints are unthrottled.");
  }

  if (config.server.outbound.allowedHosts.length === 0) {
    const hasOutboundTool = config.tools.some((t) => t.type === "http" || t.type === "mcp" || t.type === "taigaApi");
    if (hasOutboundTool) {
      if (isProd) fatal.push(
        "server.outbound.allowedHosts is empty while http/mcp tools are configured — " +
          "a non-empty outbound host allow-list is mandatory in production.",
      );
      else warnings.push(
        "server.outbound.allowedHosts is empty while http/mcp tools are configured — " +
          "outbound requests are unrestricted by hostname. Set an allow-list before production.",
      );
    }
  }

  // ── Inbound webhooks ──────────────────────────────────────────────────────

  for (const tool of config.tools) {
    if (tool.type !== "webhook" || !tool.enabled) continue;
    if (tool.authentication.type !== "hmac" || !tool.authentication.secret) {
      flag(
        `webhook tool '${tool.name}' does not use HMAC authentication with a secret — ` +
          "production webhooks must authenticate every delivery with HMAC.",
      );
    }
    if (!tool.tenantId) {
      flag(
        `webhook tool '${tool.name}' has no tenantId — configure a trusted static tenant; ` +
          "the receiver never accepts a tenant from an untrusted request header.",
      );
    }
    if (tool.ttlSeconds === undefined) {
      flag(
        `webhook tool '${tool.name}' has no ttlSeconds — cached webhook payloads must expire in production.`,
      );
    }
    const replay = tool.replayProtection;
    if (
      !replay.timestampHeader || !replay.nonceHeader || replay.maxAgeSeconds <= 0 ||
      replay.cacheTtlSeconds < replay.maxAgeSeconds + replay.clockSkewSeconds
    ) {
      flag(
        `webhook tool '${tool.name}' has invalid replayProtection — HMAC webhooks require ` +
          "mandatory timestamp/nonce headers and a bounded cache TTL covering the acceptance window.",
      );
    }
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  if (config.server.metrics.enabled && config.server.metrics.allowUnauthenticated) {
    flag(
      "server.metrics.allowUnauthenticated is enabled — the Prometheus endpoint exposes the tool " +
        "inventory and per-tool call/error counts to anyone who can reach it. Set " +
        "server.metrics.token, or rely on the loopback-only default.",
    );
  }

  // ── Monitoring dashboard ──────────────────────────────────────────────────

  if (config.monitoring.enabled && !config.monitoring.token && !config.monitoring.oidc) {
    flag(
      "monitoring is enabled without monitoring.token or monitoring.oidc — the dashboard (live " +
        "tool calls, arguments, results) is open to anyone who can reach the server.",
    );
  }
  if (isProd && config.monitoring.enabled && config.monitoring.token) {
    fatal.push(
      "Production monitoring must not configure monitoring.token; use external OIDC exclusively.",
    );
  }
  if (isProd && config.monitoring.enabled && !config.monitoring.oidc) {
    fatal.push(
      "Production monitoring requires monitoring.oidc; static-token-only dashboard authentication is forbidden.",
    );
  }

  if (config.monitoring.enabled && config.monitoring.playground.allowWrite) {
    flag(
      "monitoring.playground.allowWrite is enabled — write-access tools can be executed straight " +
        "from the dashboard, bypassing the calling application entirely.",
    );
  }

  if (!config.monitoring.redact.enabled) {
    flag(
      "monitoring.redact.enabled is false — tool arguments, tool results and full token claims are " +
        "written verbatim to the dashboard buffer, the audit log and (if configured) the Redis " +
        "cluster channel.",
    );
  }

  // ── Databases ─────────────────────────────────────────────────────────────

  for (const tool of config.tools) {
    if (
      config.tenantIsolation.enabled &&
      tool.type === "database" &&
      !config.tenantIsolation.isolatedDatabases.includes(tool.database)
    ) {
      // Preserve the original minimum presence contract. The loader rejects
      // this before startup; the readiness gate keeps the same behavior for
      // callers that construct AppConfig directly.
      if (!tool.query?.includes(":ctx.tenantId")) {
        const reason = ":ctx.tenantId is absent from the SQL text";
        const severity =
          config.tenantIsolation.sqlValidationMode === "strict" || isProd
            ? "fatal"
            : "warning";
        const message =
          `database tool '${tool.name}' has no :ctx.tenantId binding and database ` +
          `'${tool.database}' is not declared as a tenant-dedicated boundary.`;
        tenantSqlDiagnostics.push({
          tool: tool.name,
          database: tool.database,
          status: "unsafe",
          reason,
          severity,
        });
        if (severity === "fatal") fatal.push(message);
        else warnings.push(message);
      } else {
        const diagnostic = diagnoseSqlTenantBinding(tool.query);
        if (diagnostic.status !== "safe") {
          const severity = config.tenantIsolation.sqlValidationMode === "strict" ? "fatal" : "warning";
          const message =
            `database tool '${tool.name}' tenant SQL diagnostic ` +
            `[${diagnostic.status}]: ${diagnostic.reason}.`;
          tenantSqlDiagnostics.push({
            tool: tool.name,
            database: tool.database,
            status: diagnostic.status,
            reason: diagnostic.reason,
            severity,
          });
          if (severity === "fatal") fatal.push(message);
          else warnings.push(message);
        }
      }
    }
  }

  for (const [name, db] of Object.entries(config.databases)) {
    if (db.statementTimeoutMs === 0) {
      flag(
        `databases.${name}.statementTimeoutMs is 0 — one pathological tool query can hold a pool ` +
          "slot indefinitely. Set a cap (default 30000).",
      );
    }
    if (typeof db.connection === "string" && /(^|[:@/])(postgres|root|sa)(:|@)/i.test(db.connection)) {
      warnings.push(
        `databases.${name} appears to connect as a superuser/administrative role — use a ` +
          "least-privilege role scoped to the tables the tools actually need.",
      );
    }
  }

  // ── Router / LLM ──────────────────────────────────────────────────────────

  if (config.router?.enabled && config.router.llm?.forwardBearerToken) {
    flag(
      "router.llm.forwardBearerToken is enabled — the caller's bearer token is sent to the LLM " +
        "endpoint. Only acceptable when the LLM host is inside the same trust boundary.",
    );
  }

  // ── Cluster / HA ──────────────────────────────────────────────────────────

  if (
    config.server.rateLimit.enabled &&
    config.server.rateLimit.store.type === "memory"
  ) {
    warnings.push(
      "server.rateLimit.store.type is 'memory' — the limit is per replica, so N replicas allow " +
        "N times the configured rate. Use the redis store for multi-replica deployments.",
    );
  }

  if (config.server.sessions.max === 0) {
    flag(
      "server.sessions.max is 0 — the concurrent MCP session count is unbounded, so repeated " +
        "`initialize` calls grow memory without limit.",
    );
  }

  if (config.server.sessions.idleTimeoutMs === 0) {
    flag(
      "server.sessions.idleTimeoutMs is 0 — abandoned MCP sessions are never reclaimed (a client " +
        "that neither sends DELETE nor drops its socket leaks its session for the process lifetime).",
    );
  }

  const transactionEnforcement = process.env.MCPGATE_TRANSACTION_ENFORCEMENT ?? "off";
  const transactionRedis = process.env.MCPGATE_TRANSACTION_REDIS_URL
    ?? (config.server.rateLimit.store.type === "redis" ? config.server.rateLimit.store.redisUrl : undefined)
    ?? config.monitoring.cluster.redisUrl;
  if (isProd && config.tools.some((tool) => tool.type === "webhook" && tool.enabled) && !transactionRedis) {
    fatal.push(
      "Production webhooks require Redis-backed atomic replay protection; configure " +
        "MCPGATE_TRANSACTION_REDIS_URL or an existing Redis-backed server store.",
    );
  }
  if (transactionEnforcement !== "off" && !transactionRedis) {
    const message =
      `MCPGATE_TRANSACTION_ENFORCEMENT=${transactionEnforcement} uses the single-process in-memory invocation ledger. ` +
      "Replay/conflict decisions will diverge across replicas and disappear on restart; configure " +
      "MCPGATE_TRANSACTION_REDIS_URL or an existing Redis-backed server store.";
    if (isProd && transactionEnforcement === "required") fatal.push(message);
    else warnings.push(message);
  }

  return { fatal, warnings, tenantSqlDiagnostics, environment };
}
