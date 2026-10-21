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
import { UnknownOperationalProfileError } from "@atf/security-kit";
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
      outbound: { allowedHosts: ["api.example.com"] },
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

  test("ATF_PROFILE overrides MCPGATE_ENV and NODE_ENV", () => {
    expect(
      resolveEnvironment({
        ATF_PROFILE: "production",
        MCPGATE_ENV: "development",
        NODE_ENV: "development",
      }),
    ).toBe("production");
    expect(
      resolveEnvironment({ ATF_PROFILE: "staging", NODE_ENV: "production" }),
    ).toBe("staging");
  });

  test("an unknown value fails fast instead of disabling the gate", () => {
    // The bug class this closes: `MCPGATE_ENV=prod` used to fall back to
    // development silently, switching every production gate off.
    expect(() => resolveEnvironment({ MCPGATE_ENV: "prod" })).toThrow(
      UnknownOperationalProfileError,
    );
    expect(() => resolveEnvironment({ ATF_PROFILE: "PRODUCTIVE" })).toThrow(
      UnknownOperationalProfileError,
    );
    try {
      resolveEnvironment({ MCPGATE_ENV: "prod" });
      expect.unreachable();
    } catch (err) {
      const e = err as UnknownOperationalProfileError;
      expect(e.message).toContain("MCPGATE_ENV");
      expect(e.message).toContain("prod");
    }
  });

  test("a blank ATF_PROFILE falls through to the service variables", () => {
    expect(
      resolveEnvironment({ ATF_PROFILE: "", NODE_ENV: "production" }),
    ).toBe("production");
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

  test("oauth without allowedTokenTypes warns that tokens are not type-checked", () => {
    const cfg = goodConfig();
    expect(
      warningsIn(cfg).some((m) => m.includes("allowedTokenTypes is empty")),
    ).toBe(true);
  });

  test("oauth with an allowedTokenTypes allow-list does not warn", () => {
    const cfg = goodConfig({
      auth: {
        mode: "oauth",
        oauth: {
          jwksUri: "https://id.example.com/jwks",
          issuer: "https://id.example.com/",
          audience: "mcpgate",
          allowedTokenTypes: ["at+jwt"],
        },
      },
    });
    expect(
      warningsIn(cfg).some((m) => m.includes("allowedTokenTypes is empty")),
    ).toBe(false);
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
      server: {
        allowedHosts: [],
        metrics: { token: "x".repeat(40) },
        outbound: { allowedHosts: ["api.example.com"] },
      },
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

  test("an empty outbound allow-list is fatal in production even without outbound tools", () => {
    // Req 6.8 is unconditional: a tool added later must not silently inherit an
    // unrestricted egress surface, so "no outbound" has to be declared
    // explicitly (e.g. with a reserved never-resolving host).
    const withoutTools = goodConfig({
      server: {
        allowedHosts: ["mcpgate.internal"],
        metrics: { token: "a".repeat(40) },
        outbound: { allowedHosts: [] },
      },
    });
    expect(
      checkProductionReadiness(withoutTools, "production").fatal.some((m) =>
        m.includes("outbound host allow-list"),
      ),
    ).toBe(true);
    expect(
      checkProductionReadiness(withoutTools, "development").warnings.some((m) =>
        m.includes("outbound.allowedHosts"),
      ),
    ).toBe(true);

    const withHttpTool = goodConfig({
      server: {
        allowedHosts: ["mcpgate.internal"],
        metrics: { token: "a".repeat(40) },
        outbound: { allowedHosts: [] },
      },
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

  test("an enabled playground is fatal in production", () => {
    const cfg = goodConfig({
      monitoring: {
        enabled: true,
        oidc: {
          issuer: "https://id.example.com/",
          clientId: "mcpgate-monitor",
          clientSecret: "c".repeat(40),
          redirectUri: "https://mcpgate.internal/monitor/callback",
          sessionSecret: "s".repeat(40),
        },
        playground: { enabled: true },
      },
    });
    expect(fatalsIn(cfg).some((m) => m.includes("monitoring.playground"))).toBe(
      true,
    );
    // Outside production the operator may keep it on for debugging.
    expect(
      checkProductionReadiness(cfg, "development").fatal.some((m) =>
        m.includes("monitoring.playground"),
      ),
    ).toBe(false);
  });

  test("a plaintext-HTTP server.publicUrl is fatal in production", () => {
    const cfg = goodConfig({
      server: {
        allowedHosts: ["mcpgate.internal"],
        metrics: { enabled: true, token: "a".repeat(40) },
        outbound: { allowedHosts: ["api.example.com"] },
        publicUrl: "http://mcpgate.internal:7500",
      },
    });
    expect(
      fatalsIn(cfg).some(
        (m) => m.includes("server.publicUrl") && m.includes("plaintext HTTP"),
      ),
    ).toBe(true);
  });

  test("an empty monitoring.oidc.requiredGroups warns in production", () => {
    const cfg = goodConfig({
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
    });
    expect(
      checkProductionReadiness(cfg, "production").warnings.some((m) =>
        m.includes("requiredGroups"),
      ),
    ).toBe(true);
  });

  test("a non-empty monitoring.oidc.requiredGroups does not warn", () => {
    const cfg = goodConfig({
      monitoring: {
        enabled: true,
        oidc: {
          issuer: "https://id.example.com/",
          clientId: "mcpgate-monitor",
          clientSecret: "c".repeat(40),
          redirectUri: "https://mcpgate.internal/monitor/callback",
          sessionSecret: "s".repeat(40),
          requiredGroups: ["atf-ops"],
        },
      },
    });
    const report = checkProductionReadiness(cfg, "production");
    expect(report.fatal).toEqual([]);
    expect(
      report.warnings.some((m) => m.includes("requiredGroups")),
    ).toBe(false);
  });

  test("an empty monitoring.oidc.requiredGroups does not warn outside production", () => {
    const cfg = goodConfig({
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
    });
    expect(
      checkProductionReadiness(cfg, "development").warnings.some((m) =>
        m.includes("requiredGroups"),
      ),
    ).toBe(false);
  });

  test("a plaintext-HTTP monitor OIDC redirectUri is fatal in production", () => {
    const cfg = goodConfig({
      monitoring: {
        enabled: true,
        oidc: {
          issuer: "https://id.example.com/",
          clientId: "mcpgate-monitor",
          clientSecret: "c".repeat(40),
          redirectUri: "http://mcpgate.internal:7500/monitor/callback",
          sessionSecret: "s".repeat(40),
        },
      },
    });
    expect(
      fatalsIn(cfg).some(
        (m) =>
          m.includes("monitoring.oidc.redirectUri") &&
          m.includes("plaintext HTTP"),
      ),
    ).toBe(true);
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
    outbound: { allowedHosts: ["api.example.com"] },
    rateLimit: {
      enabled: true,
      store: { type: "redis", redisUrl: "redis://redis:6379" },
    },
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

describe("pagination cursors across replicas", () => {
  const saved = process.env.MCPGATE_REPLICAS;
  const paged = (secret?: string) =>
    goodConfig({
      server: {
        allowedHosts: ["mcpgate.internal"],
        metrics: { enabled: true, token: "a".repeat(40) },
        cors: { enabled: false, origins: [] },
        outbound: { allowedHosts: ["api.example.com"] },
        ...(secret !== undefined ? { pagination: { secret } } : {}),
      },
      tools: [
        {
          name: "orders",
          type: "database",
          database: "main",
          query: "SELECT 1",
          requiredScopes: ["orders:read"],
          pagination: { enabled: true, orderBy: ["id"] },
        },
      ],
    });
  const restore = (): void => {
    if (saved === undefined) delete process.env.MCPGATE_REPLICAS;
    else process.env.MCPGATE_REPLICAS = saved;
  };
  test("warns when several replicas page with a per-process cursor key", () => {
    process.env.MCPGATE_REPLICAS = "2";
    try {
      const report = checkProductionReadiness(paged(), "staging");
      expect(report.warnings.some((m) => m.includes("server.pagination.secret is unset"))).toBe(true);
    } finally {
      restore();
    }
  });
  test("is silent with a stable secret or a single replica", () => {
    try {
      process.env.MCPGATE_REPLICAS = "2";
      const withSecret = checkProductionReadiness(paged("p".repeat(40)), "staging");
      expect(withSecret.warnings.some((m) => m.includes("server.pagination.secret"))).toBe(false);
      process.env.MCPGATE_REPLICAS = "1";
      const single = checkProductionReadiness(paged(), "staging");
      expect(single.warnings.some((m) => m.includes("server.pagination.secret"))).toBe(false);
    } finally {
      restore();
    }
  });
});
describe("approval-store replica gate (Req 6.1)", () => {
  const savedReplicas = process.env.MCPGATE_REPLICAS;
  const savedTransactionRedis = process.env.MCPGATE_TRANSACTION_REDIS_URL;
  const restore = (): void => {
    if (savedReplicas === undefined) delete process.env.MCPGATE_REPLICAS;
    else process.env.MCPGATE_REPLICAS = savedReplicas;
    if (savedTransactionRedis === undefined)
      delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
    else process.env.MCPGATE_TRANSACTION_REDIS_URL = savedTransactionRedis;
  };

  test("more than one replica without Redis is fatal in production", () => {
    process.env.MCPGATE_REPLICAS = "3";
    delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
    try {
      const report = checkProductionReadiness(goodConfig(), "production");
      expect(
        report.fatal.some((message) =>
          message.includes("MCPGATE_REPLICAS=3 without Redis"),
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  test("the same finding is only a warning outside production", () => {
    process.env.MCPGATE_REPLICAS = "3";
    delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
    try {
      const report = checkProductionReadiness(goodConfig(), "development");
      expect(report.fatal).toEqual([]);
      // Not fatal by design — but also not silently ignored: the memory
      // approval map diverging across replicas is surfaced as a warning too.
      expect(
        report.warnings.some((message) =>
          message.includes("MCPGATE_REPLICAS=3 without Redis"),
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  test("a single replica without Redis passes", () => {
    process.env.MCPGATE_REPLICAS = "1";
    delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
    try {
      expect(
        checkProductionReadiness(goodConfig(), "production").fatal,
      ).toEqual([]);
    } finally {
      restore();
    }
  });

  test("multiple replicas with Redis pass", () => {
    process.env.MCPGATE_REPLICAS = "3";
    process.env.MCPGATE_TRANSACTION_REDIS_URL = "redis://redis.internal:6379";
    try {
      expect(
        checkProductionReadiness(goodConfig(), "production").fatal,
      ).toEqual([]);
    } finally {
      restore();
    }
  });

  test("a Redis-backed rate-limit store counts as Redis", () => {
    process.env.MCPGATE_REPLICAS = "2";
    delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
    try {
      const config = goodConfig({
        server: {
          allowedHosts: ["mcpgate.internal"],
          metrics: { enabled: true, token: "a".repeat(40) },
          cors: { enabled: false, origins: [] },
          rateLimit: {
            enabled: true,
            store: { type: "redis", redisUrl: "redis://redis.internal:6379" },
          },
        },
      });
      const report = checkProductionReadiness(config, "production");
      expect(
        report.fatal.some((message) => message.includes("without Redis")),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  test("a non-numeric replica count is ignored with a warning", () => {
    process.env.MCPGATE_REPLICAS = "many";
    delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
    try {
      const report = checkProductionReadiness(goodConfig(), "production");
      expect(report.fatal).toEqual([]);
      expect(
        report.warnings.some((message) =>
          message.includes(
            "MCPGATE_REPLICAS=many is not a positive replica count",
          ),
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("deprecated mcp forwardBearerToken (Req 6.13)", () => {
  const mcpTool = (server: Record<string, unknown>) => ({
    tools: [
      {
        name: "ds",
        type: "mcp",
        server: { url: "https://mcp.example.com", ...server },
        targetTool: "search",
      },
    ],
  });

  test("is fatal in production", () => {
    const fatals = fatalsIn(goodConfig(mcpTool({ forwardBearerToken: true })));
    expect(
      fatals.some(
        (m) =>
          m.includes("deprecated server.forwardBearerToken") &&
          m.includes("server.tokenExchange"),
      ),
    ).toBe(true);
  });

  test("is a warning outside production", () => {
    const warnings = warningsIn(
      goodConfig(mcpTool({ forwardBearerToken: true })),
    );
    expect(
      warnings.some((m) => m.includes("deprecated server.forwardBearerToken")),
    ).toBe(true);
  });

  test("tokenExchange instead does not trip the flag", () => {
    const report = checkProductionReadiness(
      goodConfig(
        mcpTool({
          tokenExchange: {
            tokenEndpoint: "https://idp.example.com/token",
            clientId: "atf-gate",
            clientSecretEnv: "MCP_DS_SECRET",
            audience: "downstream-mcp",
          },
        }),
      ),
      "production",
    );
    expect(report.fatal.some((m) => m.includes("forwardBearerToken"))).toBe(
      false,
    );
  });
});

describe("tenant authority, default-allow governance and rate limiting", () => {
  const warn = (config: AppConfig, env = "production") =>
    checkProductionReadiness(config, env).warnings.join("\n");
  const fatal = (config: AppConfig, env = "production") =>
    checkProductionReadiness(config, env).fatal.join("\n");

  const twoIssuers = {
    auth: {
      mode: "oauth",
      oauth: {
        jwksUri: "https://id.example.com/jwks",
        issuer: "https://id.example.com/",
        audience: "mcpgate",
        additionalIssuers: [
          {
            jwksUri: "https://other.example.com/jwks",
            issuer: "https://other.example.com/",
            audience: "mcpgate",
          },
        ],
      },
    },
  };

  test("client_id as a tenant claim is flagged (an OAuth client is not a tenant)", () => {
    expect(warn(goodConfig())).toContain("'client_id'");
    expect(
      warn(
        goodConfig({
          tenantIsolation: { enabled: true, claimNames: ["tenant_id", "tid"] },
        }),
      ),
    ).not.toContain("'client_id'");
  });

  test("several trusted issuers without issuerTenants are fatal in production", () => {
    expect(fatal(goodConfig(twoIssuers))).toContain("issuerTenants");
  });

  test("a binding for the trusted issuers clears it", () => {
    const bound = goodConfig({
      ...twoIssuers,
      tenantIsolation: {
        enabled: true,
        claimNames: ["tenant_id"],
        issuerTenants: {
          "https://id.example.com/": ["acme"],
          "https://other.example.com/": ["*"],
        },
      },
    });
    expect(fatal(bound)).not.toContain("issuerTenants");
  });

  test("a single issuer needs no binding; staging only warns", () => {
    expect(fatal(goodConfig())).not.toContain("issuerTenants");
    expect(fatal(goodConfig(twoIssuers), "staging")).not.toContain("issuerTenants");
    expect(warn(goodConfig(twoIssuers), "staging")).toContain("issuerTenants");
  });

  test("defaultEffect allow with tools that declare no requiredScopes is called out", () => {
    const config = goodConfig({
      tools: [
        {
          name: "open_tool",
          type: "database",
          access: "read",
          database: "main",
          query: "SELECT 1",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "scoped_tool",
          type: "database",
          access: "read",
          database: "main",
          query: "SELECT 2",
          requiredScopes: ["orders:read"],
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    const w = warn(config);
    expect(w).toContain("governance.defaultEffect is 'allow'");
    expect(w).toContain("open_tool");
    expect(w).not.toContain("scoped_tool");
    // Not fatal: this is an operator decision, not an error.
    expect(fatal(config)).not.toContain("defaultEffect");
  });

  test("defaultEffect deny, or every tool scoped, silences it", () => {
    expect(
      warn(goodConfig({ policies: { defaultEffect: "deny" } })),
    ).not.toContain("governance.defaultEffect");
    expect(warn(goodConfig())).not.toContain("governance.defaultEffect");
  });

  test("trustProxy above 0 with the per-IP limit on warns about X-Forwarded-For", () => {
    expect(warn(goodConfig())).toContain("server.trustProxy is 1");
    expect(
      warn(goodConfig({ server: { trustProxy: false } as never })),
    ).not.toContain("server.trustProxy");
  });

  test("a disabled per-identity limiter is called out", () => {
    expect(warn(goodConfig())).toContain("perIdentity.enabled is false");
  });
});

describe("transaction signing and audience (ADR-0035)", () => {
  const keys = [
    "MCPGATE_TRANSACTION_ENFORCEMENT",
    "MCPGATE_TRANSACTION_HS256_SECRET",
    "MCPGATE_TRANSACTION_ALGORITHMS",
    "MCPGATE_TRANSACTION_JWKS_URI",
    "MCPGATE_TRANSACTION_AUDIENCE",
    "MCPGATE_TRANSACTION_REDIS_URL",
  ] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const withEnv = (env: Partial<Record<(typeof keys)[number], string>>): string[] => {
    for (const key of keys) delete process.env[key];
    process.env.MCPGATE_TRANSACTION_REDIS_URL = "redis://redis.internal:6379";
    Object.assign(process.env, env);
    try {
      return checkProductionReadiness(goodConfig(), "production").warnings;
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  };
  const hs256 = (warnings: string[]): boolean => warnings.some((w) => w.includes("MCPGATE_TRANSACTION_HS256_SECRET"));
  const sharedAudience = (warnings: string[]): boolean => warnings.some((w) => w.includes("MCPGATE_TRANSACTION_AUDIENCE"));

  test("warns that a shared HS256 secret lets every holder mint tokens", () => {
    expect(hs256(withEnv({ MCPGATE_TRANSACTION_ENFORCEMENT: "required", MCPGATE_TRANSACTION_HS256_SECRET: "s".repeat(40) }))).toBe(true);
  });

  test("keeps warning during a rolling migration (HS256 and JWKS both accepted)", () => {
    expect(
      hs256(
        withEnv({
          MCPGATE_TRANSACTION_ENFORCEMENT: "required",
          MCPGATE_TRANSACTION_HS256_SECRET: "s".repeat(40),
          MCPGATE_TRANSACTION_JWKS_URI: "https://runtime.internal/.well-known/atf-transaction-jwks.json",
        }),
      ),
    ).toBe(true);
  });

  test("is quiet once only the asymmetric algorithms are accepted", () => {
    const warnings = withEnv({
      MCPGATE_TRANSACTION_ENFORCEMENT: "required",
      MCPGATE_TRANSACTION_JWKS_URI: "https://runtime.internal/.well-known/atf-transaction-jwks.json",
      MCPGATE_TRANSACTION_ALGORITHMS: "EdDSA",
      MCPGATE_TRANSACTION_AUDIENCE: "mcpgate-taiga",
    });
    expect(hs256(warnings)).toBe(false);
    expect(sharedAudience(warnings)).toBe(false);
  });

  test("an explicit algorithm list wins over the presence of the secret", () => {
    expect(
      hs256(
        withEnv({
          MCPGATE_TRANSACTION_ENFORCEMENT: "required",
          MCPGATE_TRANSACTION_HS256_SECRET: "s".repeat(40),
          MCPGATE_TRANSACTION_JWKS_URI: "https://runtime.internal/jwks",
          MCPGATE_TRANSACTION_ALGORITHMS: "EdDSA,ES256",
        }),
      ),
    ).toBe(false);
  });

  test("warns about the example audience that every Gate would share", () => {
    expect(sharedAudience(withEnv({ MCPGATE_TRANSACTION_ENFORCEMENT: "required", MCPGATE_TRANSACTION_AUDIENCE: "mcpgate" }))).toBe(true);
  });

  test("says nothing while transaction enforcement is off", () => {
    const warnings = withEnv({ MCPGATE_TRANSACTION_HS256_SECRET: "s".repeat(40), MCPGATE_TRANSACTION_AUDIENCE: "mcpgate" });
    expect(hs256(warnings)).toBe(false);
    expect(sharedAudience(warnings)).toBe(false);
  });
});

describe("approver separation gate", () => {
  const approvalPolicies = {
    defaultEffect: "allow",
    rules: [{ effect: "approval", match: { tool: "orders_delete" } }],
    approval: { secret: "a".repeat(32) },
  };

  test("warns in production while approval rules exist and the flag is off", () => {
    const report = checkProductionReadiness(
      goodConfig({ policies: approvalPolicies }),
      "production",
    );
    expect(
      report.warnings.some((message) =>
        message.includes("requireDifferentApprover is off"),
      ),
    ).toBe(true);
  });

  test("warns when defaultEffect itself is approval", () => {
    const report = checkProductionReadiness(
      goodConfig({
        policies: {
          defaultEffect: "approval",
          rules: [],
          approval: { secret: "a".repeat(32) },
        },
      }),
      "production",
    );
    expect(
      report.warnings.some((message) =>
        message.includes("requireDifferentApprover is off"),
      ),
    ).toBe(true);
  });

  test("is silent when the flag is on or no approval rule exists", () => {
    const on = checkProductionReadiness(
      goodConfig({
        policies: {
          ...approvalPolicies,
          approval: { secret: "a".repeat(32), requireDifferentApprover: true },
        },
      }),
      "production",
    );
    expect(
      on.warnings.some((message) =>
        message.includes("requireDifferentApprover is off"),
      ),
    ).toBe(false);
    const noApprovalRules = checkProductionReadiness(
      goodConfig({
        policies: {
          defaultEffect: "allow",
          rules: [],
          approval: { secret: "a".repeat(32) },
        },
      }),
      "production",
    );
    expect(
      noApprovalRules.warnings.some((message) =>
        message.includes("requireDifferentApprover is off"),
      ),
    ).toBe(false);
  });

  test("is silent outside production", () => {
    const report = checkProductionReadiness(
      goodConfig({ policies: approvalPolicies }),
      "development",
    );
    expect(
      report.warnings.some((message) =>
        message.includes("requireDifferentApprover is off"),
      ),
    ).toBe(false);
  });
});

describe("pending-approval replica gate", () => {
  const savedReplicas = process.env.MCPGATE_REPLICAS;
  const savedTransactionRedis = process.env.MCPGATE_TRANSACTION_REDIS_URL;
  const restore = (): void => {
    if (savedReplicas === undefined) delete process.env.MCPGATE_REPLICAS;
    else process.env.MCPGATE_REPLICAS = savedReplicas;
    if (savedTransactionRedis === undefined)
      delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
    else process.env.MCPGATE_TRANSACTION_REDIS_URL = savedTransactionRedis;
  };

  test("warns when replicas > 1 have no shared approval store", () => {
    process.env.MCPGATE_REPLICAS = "3";
    delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
    try {
      const report = checkProductionReadiness(goodConfig(), "production");
      expect(
        report.warnings.some((message) =>
          message.includes(
            "MCPGATE_REPLICAS=3: pending approvals of the 2026 endpoint",
          ),
        ),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  test("is silent with a single replica or a configured Redis", () => {
    try {
      process.env.MCPGATE_REPLICAS = "1";
      delete process.env.MCPGATE_TRANSACTION_REDIS_URL;
      const single = checkProductionReadiness(goodConfig(), "production");
      expect(
        single.warnings.some((message) =>
          message.includes("pending approvals of the 2026 endpoint"),
        ),
      ).toBe(false);

      process.env.MCPGATE_REPLICAS = "3";
      process.env.MCPGATE_TRANSACTION_REDIS_URL =
        "redis://redis.internal:6379";
      const shared = checkProductionReadiness(goodConfig(), "production");
      expect(
        shared.warnings.some((message) =>
          message.includes("pending approvals of the 2026 endpoint"),
        ),
      ).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("injected environment", () => {
  test("MCPGATE_REPLICAS is read from the injected env, not from process.env", () => {
    const before = process.env.MCPGATE_REPLICAS;
    const report = checkProductionReadiness(goodConfig(), "staging", {
      MCPGATE_REPLICAS: "3",
    });
    expect(report.warnings.some((m) => m.includes("MCPGATE_REPLICAS=3 without Redis"))).toBe(true);
    expect(process.env.MCPGATE_REPLICAS).toBe(before);
    const single = checkProductionReadiness(goodConfig(), "staging", {});
    expect(single.warnings.some((m) => m.includes("MCPGATE_REPLICAS=3"))).toBe(false);
  });

  test("the profile is resolved from the injected env when none is given", () => {
    expect(
      checkProductionReadiness(goodConfig(), undefined, { ATF_PROFILE: "staging" }).environment,
    ).toBe("staging");
    expect(
      checkProductionReadiness(goodConfig(), undefined, { MCPGATE_ENV: "production" }).environment,
    ).toBe("production");
  });
});

describe("downgraded production variable", () => {
  test("warns when ATF_PROFILE overrides NODE_ENV=production", () => {
    const report = checkProductionReadiness(goodConfig(), undefined, {
      ATF_PROFILE: "staging",
      NODE_ENV: "production",
    });
    expect(report.environment).toBe("staging");
    expect(report.warnings).toContain(
      "NODE_ENV=production is overridden by ATF_PROFILE=staging; production checks are not enforced.",
    );
  });

  test("an explicit environment argument adds no shadow warning", () => {
    const report = checkProductionReadiness(goodConfig(), "staging", {
      ATF_PROFILE: "staging",
      NODE_ENV: "production",
    });
    expect(report.warnings.some((m) => m.includes("is overridden by"))).toBe(false);
  });
});

describe("mutable identity claims in tool bindings", () => {
  const withQuery = (query: string) =>
    goodConfig({
      tools: [
        {
          name: "mine",
          type: "database",
          database: "main",
          query,
          requiredScopes: ["orders:read"],
        },
      ],
    });

  test("warns for :ctx.claims.email, name and preferred_username", () => {
    for (const claim of ["email", "name", "preferred_username"]) {
      const warnings = checkProductionReadiness(
        withQuery(`SELECT 1 WHERE owner = :ctx.claims.${claim} AND t = :ctx.tenantId`),
        "production",
      ).warnings;
      expect(warnings).toContain(
        `Tool mine binds the mutable identity claim ${claim}; users can often change it. ` +
          "Bind :ctx.subject or a stable id instead.",
      );
    }
  });

  test("is silent for the subject and for claims that merely start with the same letters", () => {
    for (const binding of [":ctx.subject", ":ctx.claims.namespace", ":ctx.claims.email_verified"]) {
      const warnings = checkProductionReadiness(
        withQuery(`SELECT 1 WHERE owner = ${binding} AND t = :ctx.tenantId`),
        "production",
      ).warnings;
      expect(warnings.some((m) => m.includes("mutable identity claim"))).toBe(false);
    }
  });
});
