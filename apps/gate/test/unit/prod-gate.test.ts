// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Production-readiness gate.
 *
 * The contract being pinned is the same one aiperator enforces: a permissive
 * setting is FATAL in production and a warning everywhere else. The
 * fatal/warning split is the whole point — a gate that only warned is what this
 * replaced, and a gate that was always fatal would make local development
 * miserable and get switched off.
 */

import { describe, expect, test } from "bun:test";
import {
  checkProductionReadiness,
  resolveEnvironment,
} from "../../src/config/prod-gate.ts";
import { AppConfigSchema, type AppConfig } from "../../src/config/schema.ts";

/** A config that passes the gate cleanly, as the baseline to perturb. */
function goodConfig(over: Record<string, unknown> = {}): AppConfig {
  return AppConfigSchema.parse({
    server: {
      allowedHosts: ["mcpgate.internal"],
      metrics: { enabled: true, token: "a".repeat(40) },
      cors: { enabled: false, origins: [] },
    },
    authorization: { enabled: true },
    tenantIsolation: {
      enabled: true,
      defaultTenantId: "default",
      claimNames: ["tenant", "tid", "client_id"],
    },
    auth: {
      mode: "oauth",
      oauth: {
        jwksUri: "https://id.example.com/jwks",
        issuer: "https://id.example.com/",
        audience: "mcpgate",
      },
    },
    monitoring: {
      enabled: true,
      oidc: {
        issuer: "https://id.example.com/",
        clientId: "mcpgate-monitor",
        clientSecret: "c".repeat(40),
        redirectUri: "https://mcpgate.internal/monitor/callback",
        sessionSecret: "s".repeat(40),
      },
    },
    databases: {
      main: { client: "pg", connection: "postgres://app:pw@db/app" },
    },
    tools: [],
    ...over,
  });
}

function fatalsIn(config: AppConfig): string[] {
  return checkProductionReadiness(config, "production").fatal;
}
function warningsIn(config: AppConfig): string[] {
  return checkProductionReadiness(config, "development").warnings;
}

describe("resolveEnvironment", () => {
  test("prefers MCPGATE_ENV over NODE_ENV", () => {
    expect(
      resolveEnvironment({ MCPGATE_ENV: "staging", NODE_ENV: "production" }),
    ).toBe("staging");
  });

  test("falls back to NODE_ENV, which the Dockerfile already sets", () => {
    expect(resolveEnvironment({ NODE_ENV: "production" })).toBe("production");
  });

  test("defaults to development when neither is set", () => {
    expect(resolveEnvironment({})).toBe("development");
  });

  test("normalises case and whitespace", () => {
    expect(resolveEnvironment({ MCPGATE_ENV: "  PRODUCTION " })).toBe("production");
  });
});

describe("a well-configured deployment passes", () => {
  test("no fatal issues in production", () => {
    const report = checkProductionReadiness(goodConfig(), "production");
    expect(report.fatal).toEqual([]);
    expect(report.environment).toBe("production");
  });
});

describe("the fatal/warning split", () => {
  test("the same finding is fatal in production and a warning in development", () => {
    const cfg = goodConfig({
      monitoring: { enabled: true },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("monitoring is enabled without"))).toBe(true);
    expect(warningsIn(cfg).some((m) => m.includes("monitoring is enabled without"))).toBe(true);
    // ...and it is NOT fatal outside production.
    expect(checkProductionReadiness(cfg, "development").fatal).toEqual([]);
  });
});

describe("authentication findings", () => {
  test("static mode with no tokens is fatal in EVERY environment", () => {
    // This one is not a policy choice — the server would reject every request,
    // so it is a misconfiguration regardless of environment.
    const cfg = goodConfig({ auth: { mode: "static", static: { tokens: [] } } });
    expect(checkProductionReadiness(cfg, "development").fatal.length).toBeGreaterThan(0);
    expect(checkProductionReadiness(cfg, "production").fatal.length).toBeGreaterThan(0);
  });

  test("static mode flags the loss of per-user identity", () => {
    const cfg = goodConfig({
      auth: { mode: "static", static: { tokens: [{ token: "t".repeat(40) }] } },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("all callers share one token"))).toBe(true);
  });

  test("a short static token is flagged", () => {
    const cfg = goodConfig({
      auth: { mode: "static", static: { tokens: [{ token: "short", username: "svc" }] } },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("shorter than 32 characters"))).toBe(true);
  });

  test("allowAnyAudience is flagged as audience confusion", () => {
    const cfg = goodConfig({
      auth: {
        mode: "oauth",
        oauth: {
          jwksUri: "https://id.example.com/jwks",
          issuer: "https://id.example.com/",
          audience: "mcpgate",
          allowAnyAudience: true,
        },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("audience confusion"))).toBe(true);
  });

  test("allowAnyIssuer is flagged", () => {
    const cfg = goodConfig({
      auth: {
        mode: "oauth",
        oauth: {
          jwksUri: "https://id.example.com/jwks",
          issuer: "https://id.example.com/",
          audience: "mcpgate",
          allowAnyIssuer: true,
        },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("issuer is not pinned"))).toBe(true);
  });

  test("an additionalIssuer opt-out is flagged with its index", () => {
    const cfg = goodConfig({
      auth: {
        mode: "oauth",
        oauth: {
          jwksUri: "https://id.example.com/jwks",
          issuer: "https://id.example.com/",
          audience: "mcpgate",
          additionalIssuers: [
            {
              jwksUri: "https://id2.example.com/jwks",
              issuer: "https://id2.example.com/",
              audience: "mcpgate-secondary",
              allowAnyAudience: true,
            },
          ],
        },
      },
    });
    expect(
      fatalsIn(cfg).some((m) => m.includes("additionalIssuers[0].allowAnyAudience")),
    ).toBe(true);
  });
});

describe("exposure findings", () => {
  test("wildcard CORS is flagged", () => {
    const cfg = goodConfig({
      server: {
        allowedHosts: ["h"],
        metrics: { token: "x".repeat(40) },
        cors: { enabled: true, origins: ["*"] },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("cors.origins includes '*'"))).toBe(true);
  });

  test("an empty allowedHosts list is a warning, never fatal", () => {
    // DNS-rebinding protection is meaningless behind a reverse proxy that
    // already pins Host, so forcing it in production would be wrong.
    const cfg = goodConfig({
      server: { allowedHosts: [], metrics: { token: "x".repeat(40) } },
    });
    const report = checkProductionReadiness(cfg, "production");
    expect(report.fatal.some((m) => m.includes("allowedHosts"))).toBe(false);
    expect(report.warnings.some((m) => m.includes("allowedHosts"))).toBe(true);
  });

  test("disabled rate limiting is flagged", () => {
    const cfg = goodConfig({
      server: {
        allowedHosts: ["h"],
        metrics: { token: "x".repeat(40) },
        rateLimit: { enabled: false },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("rateLimit.enabled is false"))).toBe(true);
  });

  test("an empty outbound allow-list is fatal in production when an outbound tool exists", () => {
    const withoutTools = goodConfig();
    expect(
      checkProductionReadiness(withoutTools, "production").warnings.some((m) =>
        m.includes("outbound.allowedHosts"),
      ),
    ).toBe(false);

    const withHttpTool = goodConfig({
      tools: [
        {
          name: "fetch_thing",
          type: "http",
          description: "d",
          request: { method: "GET", url: "https://api.example.com/x" },
        },
      ],
    });
    expect(
      checkProductionReadiness(withHttpTool, "production").fatal.some((m) =>
        m.includes("outbound host allow-list"),
      ),
    ).toBe(true);
  });

  test("unauthenticated metrics are flagged", () => {
    const cfg = goodConfig({
      server: {
        allowedHosts: ["h"],
        metrics: { enabled: true, allowUnauthenticated: true },
      },
    });
    expect(
      fatalsIn(cfg).some((m) => m.includes("metrics.allowUnauthenticated")),
    ).toBe(true);
  });
});

describe("monitoring findings", () => {
  test("production requires monitoring OIDC and rejects static dashboard tokens", () => {
    const staticOnly = goodConfig({
      monitoring: { enabled: true, token: "b".repeat(40) },
    });
    const findings = fatalsIn(staticOnly);
    expect(findings.some((message) => message.includes("monitoring.token"))).toBe(true);
    expect(findings.some((message) => message.includes("monitoring.oidc"))).toBe(true);
  });

  test("playground allowWrite is flagged", () => {
    const cfg = goodConfig({
      monitoring: {
        enabled: true,
        token: "b".repeat(40),
        playground: { enabled: true, allowWrite: true },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("playground.allowWrite"))).toBe(true);
  });

  test("disabling redaction is flagged", () => {
    const cfg = goodConfig({
      monitoring: {
        enabled: true,
        token: "b".repeat(40),
        redact: { enabled: false },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("redact.enabled is false"))).toBe(true);
  });
});

describe("database findings", () => {
  test("a disabled statement timeout is flagged", () => {
    const cfg = goodConfig({
      databases: {
        main: { client: "pg", connection: "postgres://app:pw@db/app", statementTimeoutMs: 0 },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("statementTimeoutMs is 0"))).toBe(true);
  });

  test("a superuser-looking connection string warns", () => {
    const cfg = goodConfig({
      databases: { main: { client: "pg", connection: "postgres://postgres:pw@db/app" } },
    });
    expect(
      checkProductionReadiness(cfg, "production").warnings.some((m) =>
        m.includes("superuser/administrative role"),
      ),
    ).toBe(true);
  });
});

describe("session bound findings", () => {
  test("an unbounded session count is flagged", () => {
    const cfg = goodConfig({
      server: { allowedHosts: ["h"], metrics: { token: "x".repeat(40) }, sessions: { max: 0 } },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("sessions.max is 0"))).toBe(true);
  });

  test("a disabled idle timeout is flagged", () => {
    const cfg = goodConfig({
      server: {
        allowedHosts: ["h"],
        metrics: { token: "x".repeat(40) },
        sessions: { idleTimeoutMs: 0 },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("sessions.idleTimeoutMs is 0"))).toBe(true);
  });
});

describe("cluster findings", () => {
  test("a memory rate-limit store warns about per-replica limits", () => {
    const cfg = goodConfig();
    expect(
      checkProductionReadiness(cfg, "production").warnings.some((m) =>
        m.includes("rateLimit.store.type is 'memory'"),
      ),
    ).toBe(true);
  });

  test("the redis store removes that warning", () => {
    const cfg = goodConfig({
      server: {
        allowedHosts: ["h"],
        metrics: { token: "x".repeat(40) },
        rateLimit: {
          enabled: true,
          store: { type: "redis", redisUrl: "redis://localhost:6379" },
        },
      },
    });
    expect(
      checkProductionReadiness(cfg, "production").warnings.some((m) =>
        m.includes("rateLimit.store.type is 'memory'"),
      ),
    ).toBe(false);
  });
});


describe("webhook production contract", () => {
  const secureWebhook = {
    name: "events",
    type: "webhook",
    path: "/webhooks/events",
    tenantId: "acme",
    ttlSeconds: 300,
    authentication: { type: "hmac", secret: "s".repeat(32) },
  };

  const webhookServer = {
    allowedHosts: ["mcpgate.internal"],
    metrics: { enabled: true, token: "a".repeat(40) },
    rateLimit: { enabled: true, store: { type: "redis", redisUrl: "redis://redis:6379" } },
  };

  test("accepts a bounded HMAC webhook with a trusted tenant", () => {
    expect(fatalsIn(goodConfig({ server: webhookServer, tools: [secureWebhook] }))).toEqual([]);
  });

  test("rejects permissive, unpartitioned or unbounded webhook configuration in production", () => {
    const report = checkProductionReadiness(goodConfig({
      server: webhookServer,
      tools: [{ name: "unsafe", type: "webhook", path: "/webhooks/unsafe", tenantId: "acme", authentication: { type: "none" } }],
    }), "production");
    expect(report.fatal.some((message) => message.includes("HMAC authentication"))).toBe(true);
    expect(report.fatal.some((message) => message.includes("no ttlSeconds"))).toBe(true);
    expect(() => goodConfig({
      tools: [{ name: "unpartitioned", type: "webhook", path: "/webhooks/unpartitioned" }],
    })).toThrow("tenantId");
  });

  test("reports the same webhook findings as development warnings", () => {
    const config = goodConfig({ tools: [{ name: "unsafe", type: "webhook", path: "/webhooks/unsafe", tenantId: "acme" }] });
    expect(warningsIn(config).some((message) => message.includes("HMAC authentication"))).toBe(true);
    expect(checkProductionReadiness(config, "development").fatal).toEqual([]);
  });
});

describe("tenant SQL diagnostics", () => {
  const databaseTool = (query: string) => ({
    name: "orders",
    type: "database" as const,
    database: "main",
    query,
  });

  test("report mode emits a structured warning without making production fatal", () => {
    const config = goodConfig({
      tools: [databaseTool("SELECT ':ctx.tenantId' FROM orders")],
    });
    const report = checkProductionReadiness(config, "production");

    expect(report.fatal).toEqual([]);
    expect(report.warnings.some((message) => message.includes("[unsafe]"))).toBe(true);
    expect(report.tenantSqlDiagnostics).toEqual([
      expect.objectContaining({
        tool: "orders",
        database: "main",
        status: "unsafe",
        severity: "warning",
      }),
    ]);
  });

  test.each(["unsafe", "unknown", "parse-error"] as const)(
    "strict mode makes %s SQL diagnostics fatal",
    (expectedStatus) => {
      const query = {
        unsafe: "SELECT :ctx.tenantId FROM orders",
        unknown: "MERGE INTO orders USING staged ON orders.tenant_id = :ctx.tenantId",
        "parse-error": "SELECT * FROM orders WHERE tenant_id = :ctx.tenantId /*",
      }[expectedStatus];
      const config = goodConfig({
        tenantIsolation: {
          enabled: true,
          defaultTenantId: "default",
          claimNames: ["tenant"],
          sqlValidationMode: "strict",
        },
        tools: [databaseTool(query)],
      });
      const report = checkProductionReadiness(config, "development");

      expect(report.fatal.some((message) => message.includes(`[${expectedStatus}]`))).toBe(true);
      expect(report.tenantSqlDiagnostics[0]).toMatchObject({
        status: expectedStatus,
        severity: "fatal",
      });
    },
  );

  test("keeps the original missing-marker readiness behavior", () => {
    const config = goodConfig({ tools: [databaseTool("SELECT * FROM orders")] });
    expect(checkProductionReadiness(config, "production").fatal.some((message) =>
      message.includes("has no :ctx.tenantId binding"),
    )).toBe(true);
    expect(checkProductionReadiness(config, "development").warnings.some((message) =>
      message.includes("has no :ctx.tenantId binding"),
    )).toBe(true);
    expect(checkProductionReadiness(config, "development").tenantSqlDiagnostics[0])
      .toMatchObject({ status: "unsafe", severity: "warning" });
  });

  test("strict mode makes a missing marker fatal outside production too", () => {
    const config = goodConfig({
      tenantIsolation: {
        enabled: true,
        defaultTenantId: "default",
        claimNames: ["tenant"],
        sqlValidationMode: "strict",
      },
      tools: [databaseTool("SELECT * FROM orders")],
    });
    expect(checkProductionReadiness(config, "development").tenantSqlDiagnostics[0])
      .toMatchObject({ status: "unsafe", severity: "fatal" });
  });

  test("skips semantic diagnostics for tenant-dedicated databases", () => {
    const config = goodConfig({
      tenantIsolation: {
        enabled: true,
        defaultTenantId: "default",
        claimNames: ["tenant"],
        isolatedDatabases: ["main"],
        sqlValidationMode: "strict",
      },
      tools: [databaseTool("SELECT ':ctx.tenantId' FROM orders")],
    });
    expect(checkProductionReadiness(config, "production").tenantSqlDiagnostics).toEqual([]);
  });
});
