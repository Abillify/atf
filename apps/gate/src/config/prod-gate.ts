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
 * The operational profile is resolved through the shared
 * `@atf/security-kit` resolver: the explicit platform-wide `ATF_PROFILE` wins
 * over `MCPGATE_ENV`, which falls back to `NODE_ENV` — the Dockerfile already
 * sets `NODE_ENV=production`, so a containerised deployment is gated without
 * any extra configuration. Values are normalized (trim + lowercase) and an
 * unknown value fails fast: a typo like `prod` must not silently disable the
 * gate.
 */

import {
  profileShadowWarning,
  resolveOperationalProfile,
  type OperationalProfile,
} from "@atf/security-kit";
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

/**
 * Resolve the deployment operational profile.
 *
 * `ATF_PROFILE` (explicit, platform-wide) beats `MCPGATE_ENV`, which beats
 * `NODE_ENV`; unset/blank falls through to `development`. A non-blank unknown
 * value throws {@link UnknownOperationalProfileError} rather than silently
 * downgrading to warn-mode.
 */
export function resolveEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): OperationalProfile {
  return resolveOperationalProfile(env, ["MCPGATE_ENV", "NODE_ENV"]).profile;
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
  environmentOverride?: OperationalProfile,
  /** Environment the MCPGATE_* checks read; injectable so tests need not touch `process.env`. */
  env: NodeJS.ProcessEnv = process.env,
): ProductionReadinessReport {
  const environment = environmentOverride ?? resolveEnvironment(env);
  const fatal: string[] = [];
  const warnings: string[] = [];
  if (environmentOverride === undefined) {
    const shadowed = profileShadowWarning(
      resolveOperationalProfile(env, ["MCPGATE_ENV", "NODE_ENV"]),
    );
    if (shadowed !== undefined) warnings.push(shadowed);
  }
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
    flag(
      "auth.mode is 'disabled': every request receives an anonymous AuthContext.",
    );
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
    const deprecated = (path: string, target: { allowAnyIssuer?: boolean; allowAnyAudience?: boolean } | undefined): void => {
      for (const flagName of ["allowAnyIssuer", "allowAnyAudience"] as const) {
        if (target?.[flagName] === true) {
          warnings.push(`${path}.${flagName} has no effect and will be removed.`);
        }
      }
    };
    deprecated("auth.oauth", oauth);
    for (const [i, extra] of (oauth?.additionalIssuers ?? []).entries()) {
      deprecated(`auth.oauth.additionalIssuers[${i}]`, extra);
    }
    for (const [i, extra] of (oauth?.additionalIssuers ?? []).entries()) {
      if (extra.allowAnyIssuer) {
        flag(
          `auth.oauth.additionalIssuers[${i}].allowAnyIssuer is enabled — pin its issuer.`,
        );
      }
      if (extra.allowAnyAudience) {
        flag(
          `auth.oauth.additionalIssuers[${i}].allowAnyAudience is enabled — pin its audience.`,
        );
      }
    }
    if (oauth && oauth.allowedTokenTypes.length === 0) {
      warnings.push(
        "auth.oauth.allowedTokenTypes is empty: access tokens are not type-checked " +
          '(RFC 9068 recommends typ "at+jwt"). Set it once your identity provider issues ' +
          "at+jwt tokens.",
      );
    }
  }

  // ── Transport exposure ────────────────────────────────────────────────────

  if (config.server.cors.enabled && config.server.cors.origins.includes("*")) {
    flag(
      "server.cors.origins includes '*' (any origin may call the Gate) — set an explicit origin allow-list.",
    );
  }

  if (config.server.allowedHosts.length === 0) {
    warnings.push(
      "server.allowedHosts is empty — DNS-rebinding protection is off. Set the hostnames this " +
        "server is reachable under when it is exposed beyond localhost.",
    );
  }

  if (!config.server.rateLimit.enabled) {
    flag(
      "server.rateLimit.enabled is false — the MCP and auth endpoints are unthrottled.",
    );
  }

  // Req 6.8: an empty outbound allow-list is a production-gate error — not
  // conditional on http/mcp tools being configured right now, because a tool
  // added later would silently inherit an unrestricted egress surface.
  // Database-only deployments name a reserved, never-resolving host (e.g.
  // "outbound-disabled.invalid") to declare "no egress" explicitly.
  if (config.server.outbound.allowedHosts.length === 0) {
    if (isProd)
      fatal.push(
        "server.outbound.allowedHosts is empty — a non-empty outbound host " +
          "allow-list is mandatory in production. List the hosts http/mcp tools " +
          "may reach, or a reserved placeholder (e.g. outbound-disabled.invalid) " +
          "if this deployment needs no outbound tools at all.",
      );
    else
      warnings.push(
        "server.outbound.allowedHosts is empty — outbound requests are " +
          "unrestricted by hostname. Set an allow-list before production.",
      );
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
      !replay.timestampHeader ||
      !replay.nonceHeader ||
      replay.maxAgeSeconds <= 0 ||
      replay.cacheTtlSeconds < replay.maxAgeSeconds + replay.clockSkewSeconds
    ) {
      flag(
        `webhook tool '${tool.name}' has invalid replayProtection — HMAC webhooks require ` +
          "mandatory timestamp/nonce headers and a bounded cache TTL covering the acceptance window.",
      );
    }
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  if (
    config.server.metrics.enabled &&
    config.server.metrics.allowUnauthenticated
  ) {
    flag(
      "server.metrics.allowUnauthenticated is enabled — the Prometheus endpoint exposes the tool " +
        "inventory and per-tool call/error counts to anyone who can reach it. Set " +
        "server.metrics.token, or rely on the loopback-only default.",
    );
  }

  // ── Monitoring dashboard ──────────────────────────────────────────────────

  if (
    config.monitoring.enabled &&
    !config.monitoring.token &&
    !config.monitoring.oidc
  ) {
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
  if (
    isProd &&
    config.monitoring.enabled &&
    config.monitoring.oidc &&
    config.monitoring.oidc.requiredGroups.length === 0
  ) {
    warnings.push(
      "monitoring.oidc.requiredGroups is empty: every user of the identity " +
        "provider can sign in to the monitor, which shows tool arguments and " +
        "results. List the groups that may monitor.",
    );
  }

  // The playground executes tools out-of-band from any application session.
  // Even though runs now go through the full MCP dispatch pipeline, a
  // dashboard-driven tool call is not what a production attack surface should
  // offer: disable it in production.
  if (
    isProd &&
    config.monitoring.enabled &&
    config.monitoring.playground.enabled
  ) {
    fatal.push(
      "Production must not enable monitoring.playground — tool execution from the " +
        "dashboard is forbidden in production. Set monitoring.playground.enabled: false.",
    );
  }

  if (config.monitoring.enabled && config.monitoring.playground.allowWrite) {
    flag(
      "monitoring.playground.allowWrite is enabled — write-access tools can be executed straight " +
        "from the dashboard, bypassing the calling application entirely.",
    );
  }

  // ── TLS / transport security ──────────────────────────────────────────────
  //
  // Every security-relevant URL and cookie this server issues hangs off the
  // public URL: OAuth metadata, the OIDC monitor redirect URI, and the
  // monitor session cookies (which carry `Secure` only when the request is
  // recognised as https). An http:// public URL in production means bearer
  // tokens, authorization codes and session cookies travel in cleartext.

  if (isProd && config.server.publicUrl?.startsWith("http://")) {
    fatal.push(
      `server.publicUrl is plaintext HTTP (${config.server.publicUrl}) — production must terminate ` +
        "TLS and publish an https:// URL, or bearer tokens, OAuth metadata and monitor session " +
        "cookies (Secure flag) are exposed on the wire.",
    );
  }

  if (isProd && config.monitoring.oidc?.redirectUri.startsWith("http://")) {
    fatal.push(
      `monitoring.oidc.redirectUri is plaintext HTTP (${config.monitoring.oidc.redirectUri}) — the ` +
        "OIDC authorization code and the resulting monitor session cookie would cross an " +
        "unencrypted connection. Terminate TLS and use an https:// redirect URI.",
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
          const severity =
            config.tenantIsolation.sqlValidationMode === "strict"
              ? "fatal"
              : "warning";
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

  // A "hash" redaction without a secret is an unkeyed SHA-256: for low-entropy
  // values (emails, phone numbers) it can be reversed by hashing candidates.
  if (!env.MCPGATE_REDACTION_HASH_SECRET) {
    for (const tool of config.tools) {
      if (tool.type === "database" && tool.redact.some((rule) => rule.strategy === "hash")) {
        warnings.push(
          `database tool '${tool.name}' uses redact strategy 'hash' without MCPGATE_REDACTION_HASH_SECRET — ` +
            "the digest is unkeyed and can be reversed for low-entropy values. Set a secret to use HMAC-SHA256.",
        );
      }
    }
  }

  // The name, email and preferred_username claims are editable by the user at
  // many identity providers; a tool binding on them lets users impersonate each
  // other. Bind the subject or a stable id instead.
  const mutableClaim = /:ctx\.claims\.(name|email|preferred_username)\b/;
  for (const tool of config.tools) {
    const claim = mutableClaim.exec(JSON.stringify(tool))?.[1];
    if (claim !== undefined) {
      warnings.push(
        `Tool ${tool.name} binds the mutable identity claim ${claim}; users can often change it. ` +
          "Bind :ctx.subject or a stable id instead.",
      );
    }
  }

  for (const [name, db] of Object.entries(config.databases)) {
    if (db.statementTimeoutMs === 0) {
      flag(
        `databases.${name}.statementTimeoutMs is 0 — one pathological tool query can hold a pool ` +
          "slot indefinitely. Set a cap (default 30000).",
      );
    }
    if (
      typeof db.connection === "string" &&
      /(^|[:@/])(postgres|root|sa)(:|@)/i.test(db.connection)
    ) {
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

  // ── MCP downstream auth (Req 6.13) ────────────────────────────────────────

  for (const tool of config.tools) {
    if (tool.type === "mcp" && tool.server.forwardBearerToken) {
      flag(
        `mcp tool '${tool.name}' uses the deprecated server.forwardBearerToken — the caller's ` +
          "login token is forwarded to the downstream MCP server verbatim, which exposes the " +
          "gateway's own audience (confused deputy). Migrate to server.tokenExchange " +
          "(RFC 8693), which sends an audience-bound exchanged token instead.",
      );
    }
  }

  // ── Tenant authority ──────────────────────────────────────────────
  if (config.tenantIsolation.enabled) {
    if (config.tenantIsolation.claimNames.includes("client_id")) {
      warnings.push(
        "tenantIsolation.claimNames includes 'client_id' — an OAuth client id names an " +
          "application, not a tenant, and several tenants may share one client. Use a " +
          "dedicated tenant claim ('tenant_id', 'tenant', 'tid') issued by your IdP.",
      );
    }
    const trustedIssuers =
      config.auth.mode === "oauth" || config.auth.mode === "both"
        ? 1 + (config.auth.oauth?.additionalIssuers.length ?? 0)
        : 0;
    if (
      trustedIssuers > 1 &&
      Object.keys(config.tenantIsolation.issuerTenants).length === 0
    ) {
      flag(
        `${trustedIssuers} OAuth issuers are trusted and tenantIsolation.issuerTenants is empty — ` +
          "any trusted issuer can assert any tenant through the tenant claim. Bind each issuer " +
          'to the tenants it may act for (issuer → [tenant…], "*" for all).',
      );
    }
  }
  // ── Default-allow governance ──────────────────────────────────────
  if (config.authorization.enabled && config.policies.defaultEffect === "allow") {
    const unscoped = config.tools
      .filter((tool) => (tool.requiredScopes ?? []).length === 0)
      .map((tool) => tool.name);
    if (unscoped.length > 0) {
      warnings.push(
        `governance.defaultEffect is 'allow' and ${unscoped.length} tool(s) declare no ` +
          `requiredScopes (${unscoped.slice(0, 8).join(", ")}${unscoped.length > 8 ? ", …" : ""}) — ` +
          "every authenticated caller may call them. The access level adds no scope " +
          "automatically; declare requiredScopes per tool or set governance.defaultEffect: deny.",
      );
    }
  }
  // ── Approver separation ───────────────────────────────────────
  if (
    isProd &&
    config.policies.approval.requireDifferentApprover !== true &&
    (config.policies.defaultEffect === "approval" ||
      config.policies.rules.some((rule) => rule.effect === "approval"))
  ) {
    warnings.push(
      "policies.approval.requireDifferentApprover is off: the principal that " +
        "requested an approval may resolve it itself, so approvals do not " +
        "separate duties. Enable it once approvers hold the approverScope.",
    );
  }
  // ── Rate limiting ─────────────────────────────────────────────────
  if (
    config.server.rateLimit.enabled &&
    config.server.trustProxy !== false &&
    config.server.trustProxy !== 0
  ) {
    warnings.push(
      `server.trustProxy is ${String(config.server.trustProxy)} — the per-IP limit keys on the ` +
        "X-Forwarded-For address. Without exactly that many trusted proxy hops in front of the " +
        "Gate, a client can send its own X-Forwarded-For and get a fresh budget for every " +
        "request. Set server.trustProxy to the real hop count, or false when the Gate is " +
        "reachable directly.",
    );
  }
  if (!config.server.rateLimit.perIdentity.enabled) {
    warnings.push(
      "server.rateLimit.perIdentity.enabled is false — only the per-IP limit protects the tools; " +
        "one authenticated identity can use the whole budget of every address it controls. " +
        "Enable the per-identity limiter (it is keyed on the verified subject).",
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

  const transactionEnforcement =
    env.MCPGATE_TRANSACTION_ENFORCEMENT ?? "off";
  const transactionRedis =
    env.MCPGATE_TRANSACTION_REDIS_URL ??
    (config.server.rateLimit.store.type === "redis"
      ? config.server.rateLimit.store.redisUrl
      : undefined) ??
    config.monitoring.cluster.redisUrl;
  // Redeemed approval-token JTIs live in Redis when one is configured; the
  // memory fallback is per-process, so more than one replica would let the
  // same approval token be redeemed once per replica (Req 6.1).
  const replicasRaw = env.MCPGATE_REPLICAS ?? "1";
  const replicas = Number.parseInt(replicasRaw, 10);
  if (Number.isNaN(replicas) || replicas < 1) {
    warnings.push(
      `MCPGATE_REPLICAS=${replicasRaw} is not a positive replica count — the value is ` +
        "ignored for the approval-store check; set it to the actual replica count.",
    );
  }
  if (!Number.isNaN(replicas) && replicas > 1 && !transactionRedis) {
    const message =
      `MCPGATE_REPLICAS=${replicas} without Redis: redeemed approval tokens are tracked in the ` +
      "per-process memory map, so each replica would accept the same approval token once. " +
      "Configure MCPGATE_TRANSACTION_REDIS_URL or an existing Redis-backed server store.";
    if (isProd) fatal.push(message);
    else warnings.push(message);
  }
  // Pending approvals of the 2026 endpoint are Redis-backed as soon as a Redis
  // URL is configured; without one they stay in the process memory store, so
  // with more than one replica `approvals/resolve` can hit a replica that
  // never saw the request.
  if (!Number.isNaN(replicas) && replicas > 1 && !transactionRedis) {
    warnings.push(
      `MCPGATE_REPLICAS=${replicas}: pending approvals of the 2026 endpoint are ` +
        "kept per process, so approvals/resolve can reach another replica and " +
        "fail. Configure MCPGATE_TRANSACTION_REDIS_URL (or server.rateLimit." +
        "store redis) to share them.",
    );
  }
  // Pagination cursors are HMAC-signed with a per-process random key unless
  // server.pagination.secret is set: behind a load balancer a cursor minted by
  // one replica is rejected by the next ("Invalid pagination cursor").
  if (
    !Number.isNaN(replicas) &&
    replicas > 1 &&
    config.server.pagination.secret === undefined &&
    config.tools.some(
      (tool) => tool.type === "database" && tool.enabled && tool.pagination?.enabled === true,
    )
  ) {
    warnings.push(
      `MCPGATE_REPLICAS=${replicas} and a database tool has pagination enabled, but ` +
        "server.pagination.secret is unset: every replica signs cursors with its own random key, " +
        "so a page request that lands on another replica fails. Set a stable secret.",
    );
  }
  if (
    isProd &&
    config.tools.some((tool) => tool.type === "webhook" && tool.enabled) &&
    !transactionRedis
  ) {
    fatal.push(
      "Production webhooks require Redis-backed atomic replay protection; configure " +
        "MCPGATE_TRANSACTION_REDIS_URL or an existing Redis-backed server store.",
    );
  }
  if (transactionEnforcement !== "off") {
    // Signing: HS256 puts the same secret in the hands of every party that
    // issues OR verifies tokens, so any Gate holding it could mint a token for
    // any other Gate. A JWKS (EdDSA/ES256) lets the Gate verify with public
    // keys only; the audience then keeps a token minted for one Gate from being
    // accepted by another (ADR-0035).
    const secretSet = (env.MCPGATE_TRANSACTION_HS256_SECRET ?? "") !== "";
    const algorithmsRaw = (env.MCPGATE_TRANSACTION_ALGORITHMS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const acceptsHs256 = algorithmsRaw.length > 0 ? algorithmsRaw.includes("HS256") : secretSet;
    if (acceptsHs256) {
      warnings.push(
        "Transaction tokens are verified with the shared MCPGATE_TRANSACTION_HS256_SECRET: every party holding it can " +
          "mint tokens this Gate accepts. Verify with the issuer's public key instead " +
          "(MCPGATE_TRANSACTION_JWKS_URI, EdDSA/ES256; the runtime publishes /.well-known/atf-transaction-jwks.json) " +
          "and drop HS256 once every issuer has switched (docs/adr/0035-asymmetric-transaction-tokens-audience-per-service.md).",
      );
    }
    if (env.MCPGATE_TRANSACTION_AUDIENCE === "mcpgate") {
      warnings.push(
        'MCPGATE_TRANSACTION_AUDIENCE is "mcpgate", the audience the examples use for every Gate: a token minted for one ' +
          "Gate is then valid at all of them. Give each Gate its own audience and map it on the runtime with " +
          "AGENT_TRANSACTION_AUDIENCES (server name → audience).",
      );
    }
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
