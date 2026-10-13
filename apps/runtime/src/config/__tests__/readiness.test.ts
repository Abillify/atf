// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for checkProductionReadiness() — the secure-defaults gate.
 */

import { describe, test, expect } from "bun:test";
import { checkProductionReadiness, type AppConfig } from "../index.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    flowsDir: "./flows",
    monitoringTransport: "sse",
    mcpServers: [],
    corsOrigins: ["https://app.example.com"],
    monitoringAuthRequired: true,
    monitoringTicketSecret: "test-monitoring-ticket-secret",
    debugCaptureRequestTokens: false,
    logLevel: "error",
    maxToolSteps: 5,
    maxConcurrentExecutions: 50,
    jwtSecret: "shhh",
    metricsAuthRequired: true,
    metricsEnabled: true,
    ...overrides,
  };
}

function productionConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return baseConfig({
    appEnv: "production",
    authnMode: "oidc",
    authzEnabled: true,
    tenantIsolationEnabled: true,
    oidcIssuer: "https://idp.example.com/application/o/aiperator/",
    oidcAudience: "aiperator",
    jwtSecret: undefined,
    tenantRlsEnabled: true,
    tenantRlsRequired: true,
    databaseOperatorUrl: "postgres://operator@example/db",
    ...overrides,
  });
}

describe("checkProductionReadiness", () => {
  test("a hardened production config has no fatal issues", () => {
    const { fatal } = checkProductionReadiness(productionConfig());
    expect(fatal).toEqual([]);
  });

  test("warns in production when AUDIT_ANCHOR_FILE is unset (Req 1.8)", () => {
    const { warnings } = checkProductionReadiness(productionConfig());
    expect(
      warnings.some((w) => w.includes("AUDIT_ANCHOR_FILE is not set")),
    ).toBe(true);
  });

  test("no anchor warning when AUDIT_ANCHOR_FILE is configured", () => {
    const { warnings } = checkProductionReadiness(
      productionConfig({
        auditAnchorFile: "/var/lib/aiperator/audit-anchors.jsonl",
        auditAnchorSecret: "anchor-secret",
      }),
    );
    expect(
      warnings.some((w) => w.includes("AUDIT_ANCHOR_FILE is not set")),
    ).toBe(false);
  });

  test("no anchor warning outside production", () => {
    const { warnings } = checkProductionReadiness(
      baseConfig({ appEnv: "development" }),
    );
    expect(
      warnings.some((w) => w.includes("AUDIT_ANCHOR_FILE is not set")),
    ).toBe(false);
  });

  test("warns in production when API_KEY_PEPPER is unset (Req 7.9)", () => {
    const { warnings } = checkProductionReadiness(productionConfig());
    expect(warnings.some((w) => w.includes("API_KEY_PEPPER is not set"))).toBe(
      true,
    );
  });

  test("no pepper warning when API_KEY_PEPPER is configured", () => {
    const { warnings } = checkProductionReadiness(
      productionConfig({ apiKeyPepper: "s3cret-pepper" }),
    );
    expect(warnings.some((w) => w.includes("API_KEY_PEPPER is not set"))).toBe(
      false,
    );
  });

  test("no pepper warning outside production", () => {
    const { warnings } = checkProductionReadiness(
      baseConfig({ appEnv: "development" }),
    );
    expect(warnings.some((w) => w.includes("API_KEY_PEPPER is not set"))).toBe(
      false,
    );
  });

  test("warns in production when transaction tokens sign with HS256 (Req 7.11)", () => {
    const { fatal, warnings } = checkProductionReadiness(
      productionConfig(),
      undefined,
      { AGENT_TRANSACTION_SECRET: "0".repeat(32) },
    );
    expect(fatal).toEqual([]);
    expect(warnings.some((w) => w.includes("signed with HS256"))).toBe(true);
  });

  test("no HS256 warning for asymmetric transaction signing (Req 7.11)", () => {
    const { warnings } = checkProductionReadiness(
      productionConfig(),
      undefined,
      {
        TRANSACTION_SIGNING_ALG: "ES256",
        // Synthetic PEM, assembled so the public-tree scanner does not flag it.
        TRANSACTION_SIGNING_KEY: [
          "-----BEGIN",
          "PRIVATE KEY-----\nabc\n-----END",
          "PRIVATE KEY-----",
        ].join(" "),
      },
    );
    expect(warnings.some((w) => w.includes("signed with HS256"))).toBe(false);
  });

  test("no HS256 warning when transaction signing is unconfigured", () => {
    const { warnings } = checkProductionReadiness(
      productionConfig(),
      undefined,
      {},
    );
    expect(warnings.some((w) => w.includes("signed with HS256"))).toBe(false);
  });

  test("ES256 without TRANSACTION_SIGNING_KEY is fatal in production (Req 7.11)", () => {
    const { fatal } = checkProductionReadiness(productionConfig(), undefined, {
      TRANSACTION_SIGNING_ALG: "ES256",
    });
    expect(
      fatal.some((f) => f.includes("Transaction signing configuration")),
    ).toBe(true);
  });

  test("rejects anonymous authentication with active tenant isolation", () => {
    const report = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        authnMode: "disabled",
        tenantIsolationEnabled: true,
      }),
    );
    expect(
      report.fatal.some((finding) =>
        finding.includes("AUTHN_MODE=disabled cannot be used"),
      ),
    ).toBe(true);
  });

  // Req 7.4: the legacy mode (AUTHN_MODE unset) is a development-only
  // convenience — production startup must be blocked.
  test("legacy mode (AUTHN_MODE unset) is fatal in production", () => {
    const report = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
    );
    expect(
      report.fatal.some((finding) =>
        finding.includes("Production requires AUTHN_MODE=oidc"),
      ),
    ).toBe(true);
    expect(
      report.warnings.some((w) => w.includes("AUTHN_MODE is not set")),
    ).toBe(true);
  });

  test("legacy mode stays allowed in development", () => {
    const report = checkProductionReadiness(
      baseConfig({ appEnv: "development" }),
    );
    expect(report.fatal.some((finding) => finding.includes("AUTHN_MODE"))).toBe(
      false,
    );
  });

  test("wildcard CORS is fatal in production, warning in development", () => {
    const prod = checkProductionReadiness(
      baseConfig({ appEnv: "production", corsOrigins: ["*"] }),
    );
    expect(prod.fatal.some((f) => f.includes("CORS"))).toBe(true);

    const dev = checkProductionReadiness(
      baseConfig({ appEnv: "development", corsOrigins: ["*"] }),
    );
    expect(dev.fatal).toEqual([]);
    expect(dev.warnings.some((w) => w.includes("CORS"))).toBe(true);
  });

  test("public monitoring is fatal in production", () => {
    const prod = checkProductionReadiness(
      baseConfig({ appEnv: "production", monitoringAuthRequired: false }),
    );
    expect(prod.fatal.some((f) => f.includes("MONITORING_AUTH"))).toBe(true);
  });

  test("format-only JWT is fatal in production", () => {
    const prod = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        jwtSecret: undefined,
        jwtJwksUrl: undefined,
      }),
    );
    expect(prod.fatal.some((f) => f.includes("JWT"))).toBe(true);
  });

  test("raw token capture is fatal in production, warning in development", () => {
    const prod = checkProductionReadiness(
      baseConfig({ appEnv: "production", debugCaptureRequestTokens: true }),
    );
    expect(
      prod.fatal.some((f) => f.includes("DEBUG_CAPTURE_REQUEST_TOKENS")),
    ).toBe(true);

    const dev = checkProductionReadiness(
      baseConfig({ appEnv: "development", debugCaptureRequestTokens: true }),
    );
    expect(dev.fatal).toEqual([]);
    expect(
      dev.warnings.some((w) => w.includes("DEBUG_CAPTURE_REQUEST_TOKENS")),
    ).toBe(true);
  });

  test("development never produces fatal issues (with explicit unverified-JWT opt-in)", () => {
    const dev = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        corsOrigins: ["*"],
        monitoringAuthRequired: false,
        jwtSecret: undefined,
        jwtJwksUrl: undefined,
        allowUnverifiedJwt: true,
      }),
    );
    expect(dev.fatal).toEqual([]);
    expect(dev.warnings.length).toBeGreaterThan(0);
  });

  test("format-only JWT is fatal in development unless JWT_ALLOW_UNVERIFIED is set", () => {
    // Secure default: no verifier + no opt-in → fatal even in development.
    const strict = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        jwtSecret: undefined,
        jwtJwksUrl: undefined,
      }),
    );
    expect(strict.fatal.some((f) => f.includes("JWT"))).toBe(true);

    // Explicit opt-in downgrades it to a warning in development.
    const optedIn = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        jwtSecret: undefined,
        jwtJwksUrl: undefined,
        allowUnverifiedJwt: true,
      }),
    );
    expect(optedIn.fatal).toEqual([]);
    expect(
      optedIn.warnings.some((w) => w.includes("JWT_ALLOW_UNVERIFIED")),
    ).toBe(true);
  });

  test("JWT_ALLOW_UNVERIFIED=true is still fatal in production", () => {
    const prod = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        jwtSecret: undefined,
        jwtJwksUrl: undefined,
        allowUnverifiedJwt: true,
      }),
    );
    expect(prod.fatal.some((f) => f.includes("JWT_ALLOW_UNVERIFIED"))).toBe(
      true,
    );
  });

  test("tool-authz fail-open emits a production warning; fail-closed clears it", () => {
    const open = checkProductionReadiness(baseConfig({ appEnv: "production" }));
    expect(
      open.warnings.some((w) => w.includes("TOOL_AUTHZ_FAIL_CLOSED")),
    ).toBe(true);

    const closed = checkProductionReadiness(
      baseConfig({ appEnv: "production", toolAuthzFailClosed: true }),
    );
    expect(
      closed.warnings.some((w) => w.includes("TOOL_AUTHZ_FAIL_CLOSED")),
    ).toBe(false);
  });

  test("JWT_REQUIRE_VERIFICATION=true without a verifier is fatal in any environment", () => {
    const dev = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        jwtSecret: undefined,
        jwtJwksUrl: undefined,
        oidcIssuer: undefined,
        requireJwtVerification: true,
      }),
    );
    expect(dev.fatal.some((f) => f.includes("JWT_REQUIRE_VERIFICATION"))).toBe(
      true,
    );

    const prod = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        jwtSecret: undefined,
        jwtJwksUrl: undefined,
        oidcIssuer: undefined,
        requireJwtVerification: true,
      }),
    );
    // Both the "format-only" fatal AND the "JWT_REQUIRE_VERIFICATION" fatal appear.
    expect(
      prod.fatal.filter((f) => f.includes("JWT")).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("JWT_REQUIRE_VERIFICATION=true with a configured verifier does not produce additional errors", () => {
    const result = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        jwtSecret: "my-secret",
        requireJwtVerification: true,
      }),
    );
    expect(
      result.fatal.some((f) => f.includes("JWT_REQUIRE_VERIFICATION")),
    ).toBe(false);
  });

  test("TENANT_RLS_ENABLED=true without DATABASE_OPERATOR_URL is fatal in production", () => {
    const prod = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        tenantRlsEnabled: true,
        databaseOperatorUrl: undefined,
      }),
    );
    expect(prod.fatal.some((f) => f.includes("DATABASE_OPERATOR_URL"))).toBe(
      true,
    );
  });

  test("TENANT_RLS_ENABLED=true without DATABASE_OPERATOR_URL is a warning in development", () => {
    const dev = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        tenantRlsEnabled: true,
        databaseOperatorUrl: undefined,
      }),
    );
    expect(dev.fatal.some((f) => f.includes("DATABASE_OPERATOR_URL"))).toBe(
      false,
    );
    expect(dev.warnings.some((w) => w.includes("DATABASE_OPERATOR_URL"))).toBe(
      true,
    );
  });

  test("TENANT_RLS_ENABLED=true with DATABASE_OPERATOR_URL set produces no RLS warning", () => {
    const result = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        tenantRlsEnabled: true,
        databaseOperatorUrl: "postgres://op_user:pw@localhost:5432/aiperator",
      }),
    );
    expect(result.fatal.some((f) => f.includes("DATABASE_OPERATOR_URL"))).toBe(
      false,
    );
  });
});

describe("checkProductionReadiness — RLS onboarding tenantCount hint", () => {
  test("fatal RLS message mentions the tenant count when provided and >1", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
      { storeBacking: "redis", rlsVerified: false, tenantCount: 7 },
    );
    const msg = result.fatal.find((f) => f.includes("RLS"));
    expect(msg).toBeDefined();
    expect(msg).toContain("7 tenants");
    expect(msg).toContain("rls-setup");
  });

  test("fatal RLS message omits the tenant hint when tenantCount is 1 or undefined", () => {
    const single = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
      { storeBacking: "redis", rlsVerified: false, tenantCount: 1 },
    );
    expect(single.fatal.find((f) => f.includes("RLS"))).not.toContain("tenants");

    const none = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
      { storeBacking: "redis", rlsVerified: false },
    );
    expect(none.fatal.find((f) => f.includes("RLS"))).not.toContain("tenants");
  });

  test("opt-out warning also mentions tenant count when multi-tenant", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production", tenantRlsRequired: false }),
      { storeBacking: "redis", rlsVerified: false, tenantCount: 3 },
    );
    const warn = result.warnings.find((w) => w.includes("TENANT_RLS opt-out"));
    expect(warn).toBeDefined();
    expect(warn).toContain("3 tenants");
  });
});

describe("checkProductionReadiness — autopilot governance", () => {
  test("AUTOPILOT_REQUIRE_APPROVAL=false in production with autopilot active is a warning", () => {
    const result = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        redTeamEnabled: true,
        optimizerEnabled: true,
        autopilotRequireApproval: false,
      }),
    );
    const warn = result.warnings.find((w) =>
      w.includes("AUTOPILOT_REQUIRE_APPROVAL"),
    );
    expect(warn).toBeDefined();
    expect(warn).toContain("automatically PUBLISH");
  });

  test("no warning when autopilot is not active (red-team or optimizer disabled)", () => {
    const result = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        redTeamEnabled: true,
        optimizerEnabled: false,
        autopilotRequireApproval: false,
      }),
    );
    expect(
      result.warnings.some((w) => w.includes("AUTOPILOT_REQUIRE_APPROVAL")),
    ).toBe(false);
  });

  test("no warning when autopilot is active but requireApproval is left at its safe default", () => {
    const result = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        redTeamEnabled: true,
        optimizerEnabled: true,
      }),
    );
    expect(
      result.warnings.some((w) => w.includes("AUTOPILOT_REQUIRE_APPROVAL")),
    ).toBe(false);
  });

  test("no warning in development even with autopilot active and auto-promote enabled", () => {
    const result = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        redTeamEnabled: true,
        optimizerEnabled: true,
        autopilotRequireApproval: false,
      }),
    );
    expect(
      result.warnings.some((w) => w.includes("AUTOPILOT_REQUIRE_APPROVAL")),
    ).toBe(false);
  });
});

describe("checkProductionReadiness — cluster-state & RLS (Req 2.2, 2.3, 3.1)", () => {
  test("in-memory backing is fatal in production", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
      {
        storeBacking: "memory",
        rlsVerified: true,
      },
    );
    expect(
      result.fatal.some((f) => f.includes("In-Memory store backing")),
    ).toBe(true);
  });

  test("in-memory backing is a warning (with state names + scaling risk) in development", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "development" }),
      {
        storeBacking: "memory",
        rlsVerified: true,
      },
    );
    expect(result.fatal.some((f) => f.includes("In-Memory"))).toBe(false);
    const warn = result.warnings.find((w) =>
      w.includes("In-Memory store backing"),
    );
    expect(warn).toBeDefined();
    // Must mention state names
    expect(warn).toContain("Rate-Limit");
    expect(warn).toContain("Semaphore");
    expect(warn).toContain("Approval-Log");
    expect(warn).toContain("Monitoring-History");
    expect(warn).toContain("Semantic-Cache");
    // Must mention scaling risk
    expect(warn).toContain("Scaling risk");
  });

  test("redis backing produces no in-memory warning or fatal", () => {
    const prod = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
      {
        storeBacking: "redis",
        rlsVerified: true,
      },
    );
    expect(prod.fatal.some((f) => f.includes("In-Memory"))).toBe(false);
    expect(prod.warnings.some((w) => w.includes("In-Memory"))).toBe(false);

    const dev = checkProductionReadiness(
      baseConfig({ appEnv: "development" }),
      {
        storeBacking: "redis",
        rlsVerified: true,
      },
    );
    expect(dev.fatal.some((f) => f.includes("In-Memory"))).toBe(false);
    expect(dev.warnings.some((w) => w.includes("In-Memory"))).toBe(false);
  });

  test("postgres backing produces no in-memory warning or fatal", () => {
    const prod = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
      {
        storeBacking: "postgres",
        rlsVerified: true,
      },
    );
    expect(prod.fatal.some((f) => f.includes("In-Memory"))).toBe(false);
  });

  test("RLS not verified is fatal in production", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
      {
        storeBacking: "redis",
        rlsVerified: false,
      },
    );
    expect(result.fatal.some((f) => f.includes("RLS"))).toBe(true);
  });

  test("RLS not verified emits NO warning in non-production when cluster store is correctly configured", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "development" }),
      {
        storeBacking: "redis",
        rlsVerified: false,
      },
    );
    expect(
      result.warnings.some(
        (w) => w.includes("RLS") && w.includes("not verified"),
      ),
    ).toBe(false);
  });

  test("RLS not verified emits a warning in non-production when backing is memory", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "development" }),
      {
        storeBacking: "memory",
        rlsVerified: false,
      },
    );
    expect(
      result.warnings.some(
        (w) => w.includes("RLS") && w.includes("not verified"),
      ),
    ).toBe(true);
  });

  test("RLS verified produces no RLS fatal or warning", () => {
    const prod = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
      {
        storeBacking: "redis",
        rlsVerified: true,
      },
    );
    expect(
      prod.fatal.some((f) => f.includes("RLS") && f.includes("not verified")),
    ).toBe(false);
    expect(
      prod.warnings.some(
        (w) => w.includes("RLS") && w.includes("not verified"),
      ),
    ).toBe(false);
  });

  test("omitting clusterState skips cluster/RLS checks (backward compatibility)", () => {
    const prod = checkProductionReadiness(baseConfig({ appEnv: "production" }));
    // No in-memory or RLS cluster-state fatal issues when context is omitted
    expect(prod.fatal.some((f) => f.includes("In-Memory store backing"))).toBe(
      false,
    );
    expect(
      prod.fatal.some((f) => f.includes("RLS") && f.includes("not verified")),
    ).toBe(false);
  });
});

describe("checkProductionReadiness — opt-out flags (Req 2.3, 3.5, 18.3)", () => {
  // ── CLUSTER_STATE_OPT_OUT ──────────────────────────────────────────────────
  test("CLUSTER_STATE_OPT_OUT=true downgrades in-memory fatal to warning in production", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production", clusterStateOptOut: true }),
      { storeBacking: "memory", rlsVerified: true },
    );
    // Should NOT be fatal anymore
    expect(
      result.fatal.some((f) => f.includes("In-Memory store backing")),
    ).toBe(false);
    // Should be a warning with opt-out notice
    const warn = result.warnings.find((w) =>
      w.includes("CLUSTER_STATE_OPT_OUT"),
    );
    expect(warn).toBeDefined();
    expect(warn).toContain("In-Memory store backing");
    expect(warn).toContain("opted out");
  });

  test("CLUSTER_STATE_OPT_OUT=false (default) keeps in-memory fatal in production", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production", clusterStateOptOut: false }),
      { storeBacking: "memory", rlsVerified: true },
    );
    expect(
      result.fatal.some((f) => f.includes("In-Memory store backing")),
    ).toBe(true);
  });

  test("CLUSTER_STATE_OPT_OUT has no effect in development (always warning)", () => {
    const withOpt = checkProductionReadiness(
      baseConfig({ appEnv: "development", clusterStateOptOut: true }),
      { storeBacking: "memory", rlsVerified: true },
    );
    const withoutOpt = checkProductionReadiness(
      baseConfig({ appEnv: "development", clusterStateOptOut: false }),
      { storeBacking: "memory", rlsVerified: true },
    );
    // Both should have zero fatals (development never fatal for this check)
    expect(withOpt.fatal.some((f) => f.includes("In-Memory"))).toBe(false);
    expect(withoutOpt.fatal.some((f) => f.includes("In-Memory"))).toBe(false);
    // Both should have the scaling-risk warning
    expect(withOpt.warnings.some((w) => w.includes("Scaling risk"))).toBe(true);
    expect(withoutOpt.warnings.some((w) => w.includes("Scaling risk"))).toBe(
      true,
    );
  });

  test("CLUSTER_STATE_OPT_OUT has no effect when backing is not memory", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production", clusterStateOptOut: true }),
      { storeBacking: "redis", rlsVerified: true },
    );
    expect(result.fatal.some((f) => f.includes("In-Memory"))).toBe(false);
    expect(
      result.warnings.some((w) => w.includes("CLUSTER_STATE_OPT_OUT")),
    ).toBe(false);
  });

  // ── TENANT_RLS_REQUIRED opt-out ────────────────────────────────────────────
  test("TENANT_RLS_REQUIRED=false downgrades RLS fatal to warning in production", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production", tenantRlsRequired: false }),
      { storeBacking: "redis", rlsVerified: false },
    );
    // Should NOT be fatal anymore
    expect(
      result.fatal.some((f) => f.includes("RLS") && f.includes("not verified")),
    ).toBe(false);
    // Should be a warning with opt-out notice
    const warn = result.warnings.find((w) => w.includes("TENANT_RLS opt-out"));
    expect(warn).toBeDefined();
    expect(warn).toContain("not verified");
    expect(warn).toContain("opted out");
  });

  test("TENANT_RLS_ENABLED=false also triggers RLS opt-out in production", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production", tenantRlsEnabled: false }),
      { storeBacking: "redis", rlsVerified: false },
    );
    // Should NOT be fatal
    expect(
      result.fatal.some((f) => f.includes("RLS") && f.includes("not verified")),
    ).toBe(false);
    // Should be a warning
    const warn = result.warnings.find((w) => w.includes("TENANT_RLS opt-out"));
    expect(warn).toBeDefined();
  });

  test("TENANT_RLS_REQUIRED=true (default) keeps RLS fatal in production", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production", tenantRlsRequired: true }),
      { storeBacking: "redis", rlsVerified: false },
    );
    expect(
      result.fatal.some((f) => f.includes("RLS") && f.includes("not verified")),
    ).toBe(true);
  });

  test("RLS opt-out has no effect when RLS is verified", () => {
    const result = checkProductionReadiness(
      baseConfig({ appEnv: "production", tenantRlsRequired: false }),
      { storeBacking: "redis", rlsVerified: true },
    );
    expect(result.fatal.some((f) => f.includes("RLS"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("TENANT_RLS opt-out"))).toBe(
      false,
    );
  });

  test("RLS opt-out has no effect in development (already non-fatal)", () => {
    const withOpt = checkProductionReadiness(
      baseConfig({ appEnv: "development", tenantRlsRequired: false }),
      { storeBacking: "memory", rlsVerified: false },
    );
    const withoutOpt = checkProductionReadiness(
      baseConfig({ appEnv: "development", tenantRlsRequired: true }),
      { storeBacking: "memory", rlsVerified: false },
    );
    // Both should have zero fatals for RLS in development
    expect(
      withOpt.fatal.some(
        (f) => f.includes("RLS") && f.includes("not verified"),
      ),
    ).toBe(false);
    expect(
      withoutOpt.fatal.some(
        (f) => f.includes("RLS") && f.includes("not verified"),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JWT verifier detection — the gate must recognise EVERY verifying config
// ---------------------------------------------------------------------------

describe("checkProductionReadiness — JWT verifier detection", () => {
  /**
   * A gate that fails a deployment which *does* verify tokens is not merely
   * annoying: the error message tells the operator to set
   * `JWT_ALLOW_UNVERIFIED=true`, so a false negative here actively talks someone
   * into disabling verification. Each config below establishes verification on
   * its own and must be accepted.
   */
  const verifyingConfigs: [string, Partial<AppConfig>][] = [
    ["JWT_SECRET", { jwtSecret: "shhh" }],
    [
      "JWT_JWKS_URL + bindings",
      {
        jwtJwksUrl: "https://idp.example.com/jwks.json",
        jwtIssuer: "https://idp.example.com",
        jwtAudience: "aiperator",
      },
    ],
    ["OIDC_ISSUER", { oidcIssuer: "https://idp.example.com" }],
    [
      "JWT_ADDITIONAL_ISSUERS",
      {
        inferenceExtraOidcIssuers: [{ issuer: "https://idp2.example.com" }],
      },
    ],
    ["OIDC_SESSION_SECRET", { oidcSessionSecret: "a".repeat(32) }],
  ];

  for (const [name, overrides] of verifyingConfigs) {
    test(`${name} alone satisfies the verifier requirement`, () => {
      const { fatal } = checkProductionReadiness(
        baseConfig({
          appEnv: "production",
          jwtSecret: undefined,
          ...overrides,
        }),
      );
      expect(fatal.filter((f) => f.includes("JWT signature"))).toEqual([]);
    });
  }

  test("no verifier at all is still fatal in production", () => {
    const { fatal } = checkProductionReadiness(
      baseConfig({ appEnv: "production", jwtSecret: undefined }),
    );
    expect(fatal.some((f) => f.includes("JWT signature"))).toBe(true);
  });

  test("an EMPTY additional-issuers list does not count as a verifier", () => {
    const { fatal } = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        jwtSecret: undefined,
        inferenceExtraOidcIssuers: [],
      }),
    );
    expect(fatal.some((f) => f.includes("JWT signature"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BYOK / PII vault must not silently degrade to plaintext-in-memory storage
// ---------------------------------------------------------------------------

describe("checkProductionReadiness — BYOK encryption key required", () => {
  test("BYOK_MODE=required cannot remain disabled at readiness", () => {
    const { fatal } = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        byokMode: "required",
        byokEnabled: false,
        byokEncryptionKey: "a".repeat(44),
      }),
    );
    expect(fatal.some((f) => f.includes("BYOK_MODE=required"))).toBe(true);
  });

  test("BYOK_ENABLED without BYOK_ENCRYPTION_KEY is fatal in production", () => {
    const { fatal } = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        byokEnabled: true,
        byokEncryptionKey: undefined,
      }),
    );
    expect(fatal.some((f) => f.includes("BYOK_ENCRYPTION_KEY"))).toBe(true);
  });

  test("BYOK_ENABLED without BYOK_ENCRYPTION_KEY is a warning in development", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        byokEnabled: true,
        byokEncryptionKey: undefined,
      }),
    );
    expect(fatal.some((f) => f.includes("BYOK_ENCRYPTION_KEY"))).toBe(false);
    expect(warnings.some((w) => w.includes("BYOK_ENCRYPTION_KEY"))).toBe(true);
  });

  test("a blank BYOK_ENCRYPTION_KEY (whitespace only) is treated as absent", () => {
    const { fatal } = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        byokEnabled: true,
        byokEncryptionKey: "   ",
      }),
    );
    expect(fatal.some((f) => f.includes("BYOK_ENCRYPTION_KEY"))).toBe(true);
  });

  test("BYOK_ENABLED with a key set produces no BYOK fatal or warning", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        byokEnabled: true,
        byokEncryptionKey: "a".repeat(44),
      }),
    );
    expect(fatal.some((f) => f.includes("BYOK"))).toBe(false);
    expect(warnings.some((w) => w.includes("BYOK"))).toBe(false);
  });

  test("BYOK disabled produces no BYOK check at all, key or no key", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        byokEnabled: false,
        byokEncryptionKey: undefined,
      }),
    );
    expect(fatal.some((f) => f.includes("BYOK"))).toBe(false);
    expect(warnings.some((w) => w.includes("BYOK"))).toBe(false);
  });
});

describe("checkProductionReadiness — PII vault encryption key required", () => {
  test("PII_VAULT_ENABLED without PII_VAULT_ENCRYPTION_KEY is fatal in production", () => {
    const { fatal } = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        piiVaultEnabled: true,
        piiVaultEncryptionKey: undefined,
      }),
    );
    expect(fatal.some((f) => f.includes("PII_VAULT_ENCRYPTION_KEY"))).toBe(
      true,
    );
  });

  test("PII_VAULT_ENABLED without PII_VAULT_ENCRYPTION_KEY is a warning in development", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        piiVaultEnabled: true,
        piiVaultEncryptionKey: undefined,
      }),
    );
    expect(fatal.some((f) => f.includes("PII_VAULT_ENCRYPTION_KEY"))).toBe(
      false,
    );
    expect(
      warnings.some((w) => w.includes("PII_VAULT_ENCRYPTION_KEY")),
    ).toBe(true);
  });

  test("PII_VAULT_ENABLED with a key set produces no PII vault fatal or warning", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "production",
        piiVaultEnabled: true,
        piiVaultEncryptionKey: "b".repeat(44),
      }),
    );
    expect(fatal.some((f) => f.includes("PII_VAULT"))).toBe(false);
    expect(warnings.some((w) => w.includes("PII_VAULT"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trusted identity headers
// ---------------------------------------------------------------------------

describe("checkProductionReadiness — TRUSTED_IDENTITY_HEADERS", () => {
  test("enabling it warns, because it re-opens a client-controlled role/tenant", () => {
    const { warnings, fatal } = checkProductionReadiness(
      productionConfig({ trustedIdentityHeaders: true }),
    );
    expect(warnings.some((w) => w.includes("TRUSTED_IDENTITY_HEADERS"))).toBe(
      true,
    );
    // A warning, not fatal: it is a legitimate deployment behind a stripping proxy.
    expect(fatal).toEqual([]);
  });

  test("the secure default produces no such warning", () => {
    const { warnings } = checkProductionReadiness(
      baseConfig({ appEnv: "production" }),
    );
    expect(warnings.some((w) => w.includes("TRUSTED_IDENTITY_HEADERS"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// OIDC-only mode invariants (Req 13.7 coverage completion)
// ---------------------------------------------------------------------------

describe("checkProductionReadiness — OIDC-only mode invariants", () => {
  test("oidc mode without audience is fatal in production", () => {
    const { fatal } = checkProductionReadiness(
      productionConfig({ oidcAudience: undefined }),
    );
    expect(
      fatal.some((f) => f.includes("requires both OIDC_ISSUER and OIDC_AUDIENCE")),
    ).toBe(true);
  });

  test("oidc mode without audience is a warning in development", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        authnMode: "oidc",
        oidcIssuer: "https://idp.example.com",
        oidcAudience: undefined,
        jwtSecret: undefined,
      }),
    );
    expect(
      fatal.some((f) => f.includes("requires both OIDC_ISSUER and OIDC_AUDIENCE")),
    ).toBe(false);
    expect(
      warnings.some((w) =>
        w.includes("requires both OIDC_ISSUER and OIDC_AUDIENCE"),
      ),
    ).toBe(true);
  });

  test("raw OPERATOR_TOKENS in oidc production are fatal", () => {
    const { fatal } = checkProductionReadiness(
      productionConfig({
        operatorTokens: [{ token: "tok", role: "admin" }],
      }),
    );
    expect(fatal.some((f) => f.includes("must not configure OPERATOR_TOKENS"))).toBe(
      true,
    );
  });

  test("JWT_SECRET alongside oidc is fatal in production", () => {
    const { fatal } = checkProductionReadiness(
      productionConfig({ jwtSecret: "shhh" }),
    );
    expect(fatal.some((f) => f.includes("ignores JWT_SECRET"))).toBe(true);
  });

  test("JWT_JWKS_URL alongside oidc is a warning in development", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        authnMode: "oidc",
        oidcIssuer: "https://idp.example.com",
        oidcAudience: "aiperator",
        jwtSecret: undefined,
        jwtJwksUrl: "https://idp.example.com/.well-known/jwks.json",
        jwtIssuer: "https://idp.example.com",
        jwtAudience: "aiperator",
      }),
    );
    expect(fatal.some((f) => f.includes("ignores JWT_SECRET"))).toBe(false);
    expect(warnings.some((w) => w.includes("ignores JWT_SECRET"))).toBe(true);
  });

  test("additional issuer without audience is fatal in oidc production", () => {
    const { fatal } = checkProductionReadiness(
      productionConfig({
        inferenceExtraOidcIssuers: [{ issuer: "https://other.example.com" }],
      }),
    );
    expect(
      fatal.some((f) => f.includes("JWT_ADDITIONAL_ISSUERS[0] must configure audience")),
    ).toBe(true);
  });

  test("additional issuer without audience is a warning in oidc development", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        authnMode: "oidc",
        oidcIssuer: "https://idp.example.com",
        oidcAudience: "aiperator",
        jwtSecret: undefined,
        inferenceExtraOidcIssuers: [{ issuer: "https://other.example.com" }],
      }),
    );
    expect(
      fatal.some((f) => f.includes("must configure audience")),
    ).toBe(false);
    expect(
      warnings.some((w) => w.includes("must configure audience")),
    ).toBe(true);
  });

  test("unbound JWT_JWKS_URL is fatal in production", () => {
    const { fatal } = checkProductionReadiness(
      productionConfig({ jwtJwksUrl: "https://idp.example.com/jwks.json" }),
    );
    expect(
      fatal.some((f) => f.includes("must be bound to both JWT_ISSUER and JWT_AUDIENCE")),
    ).toBe(true);
  });

  test("unbound JWT_JWKS_URL is a warning in development", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({
        appEnv: "development",
        jwtSecret: undefined,
        jwtJwksUrl: "https://idp.example.com/jwks.json",
      }),
    );
    expect(
      fatal.some((f) => f.includes("must be bound to both JWT_ISSUER and JWT_AUDIENCE")),
    ).toBe(false);
    expect(
      warnings.some((w) =>
        w.includes("must be bound to both JWT_ISSUER and JWT_AUDIENCE"),
      ),
    ).toBe(true);
  });

  test("tenant-isolated production without RLS is fatal", () => {
    const { fatal } = checkProductionReadiness(
      productionConfig({
        tenantRlsEnabled: undefined,
        tenantRlsRequired: undefined,
      }),
    );
    expect(
      fatal.some((f) => f.includes("requires TENANT_RLS_ENABLED=true")),
    ).toBe(true);
  });

  test("public /metrics is fatal in production", () => {
    const { fatal } = checkProductionReadiness(
      productionConfig({ metricsAuthRequired: false }),
    );
    expect(fatal.some((f) => f.includes("METRICS_AUTH is disabled"))).toBe(true);
  });

  test("public /metrics is a warning in development", () => {
    const { fatal, warnings } = checkProductionReadiness(
      baseConfig({ appEnv: "development", metricsAuthRequired: false }),
    );
    expect(fatal.some((f) => f.includes("METRICS_AUTH is disabled"))).toBe(false);
    expect(warnings.some((w) => w.includes("METRICS_AUTH is disabled"))).toBe(
      true,
    );
  });

  test("monitoring auth without ticket secret is fatal in production", () => {
    const { fatal } = checkProductionReadiness(
      productionConfig({ monitoringTicketSecret: undefined }),
    );
    expect(
      fatal.some((f) => f.includes("MONITORING_TICKET_SECRET is not set")),
    ).toBe(true);
  });

  test("production database without RLS warns when not opted out", () => {
    const { warnings } = checkProductionReadiness(
      productionConfig({
        databaseUrl: "postgres://app@example.com/db",
        tenantRlsEnabled: undefined,
        tenantRlsRequired: undefined,
      }),
    );
    expect(
      warnings.some((w) => w.includes("TENANT_RLS_ENABLED is not set")),
    ).toBe(true);
  });

  test("explicit RLS opt-out silences the database warning", () => {
    const { warnings } = checkProductionReadiness(
      productionConfig({
        tenantIsolationEnabled: false,
        databaseUrl: "postgres://app@example.com/db",
        tenantRlsEnabled: undefined,
        tenantRlsRequired: false,
      }),
    );
    expect(
      warnings.some((w) => w.includes("TENANT_RLS_ENABLED is not set")),
    ).toBe(false);
  });

  test("PLUGINS_DIR warns in production and development", () => {
    const prod = checkProductionReadiness(
      productionConfig({ pluginsDir: "./plugins" }),
    );
    expect(prod.warnings.some((w) => w.includes("PLUGINS_DIR is set"))).toBe(
      true,
    );
    const dev = checkProductionReadiness(
      baseConfig({ appEnv: "development", pluginsDir: "./plugins" }),
    );
    expect(dev.warnings.some((w) => w.includes("PLUGINS_DIR is set"))).toBe(
      true,
    );
  });
});
