// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the metrics route (`src/routes/metrics.ts`), specifically the
 * durable-vs-in-memory cost/token breakdown merge in GET /monitoring/metrics.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createMetricsRouter } from "../metrics.js";
import { createMetrics } from "../../observability/metrics.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type {
  UsageAnalytics,
  TokenUsageTotals,
  UsageSeriesPoint,
  ModelUsageBreakdown,
} from "../../observability/token-limits.js";

const ZERO_TOTALS: TokenUsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cost: 0,
};

class StubUsageAnalytics implements UsageAnalytics {
  constructor(private readonly byModelValue: Record<string, ModelUsageBreakdown>) {}
  async totals(): Promise<TokenUsageTotals> {
    return ZERO_TOTALS;
  }
  async series(): Promise<UsageSeriesPoint[]> {
    return [];
  }
  async distinctModels(): Promise<string[]> {
    return Object.keys(this.byModelValue);
  }
  async byModel(): Promise<Record<string, ModelUsageBreakdown>> {
    return this.byModelValue;
  }
}

function buildApp(usageAnalytics?: UsageAnalytics) {
  const metrics = createMetrics(true);
  // Simulate one in-memory-recorded LLM call (per-replica, would reset on restart).
  metrics.recordLlmCall("openai", "gpt-4o-mini", "ok", 100, 50, 0.0002);
  const app = new Hono();
  app.route(
    "/",
    createMetricsRouter(metrics, {
      monitoringAuthRequired: false,
      ...(usageAnalytics !== undefined ? { usageAnalytics } : {}),
    }),
  );
  return app;
}

describe("GET /monitoring/metrics", () => {
  test("uses the in-memory summary when no usageAnalytics is configured", async () => {
    const app = buildApp();
    const res = await app.request("/monitoring/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      costByModel: Record<string, number>;
      tokensPrompt: number;
    };
    expect(body.costByModel["openai/gpt-4o-mini"]).toBeCloseTo(0.0002, 6);
    expect(body.tokensPrompt).toBe(100);
  });

  test("prefers the durable per-model breakdown over the in-memory one when present", async () => {
    const durable: Record<string, ModelUsageBreakdown> = {
      "bedrock/eu.anthropic.claude-sonnet-5": {
        promptTokens: 5000,
        completionTokens: 2000,
        cost: 0.045,
      },
    };
    const app = buildApp(new StubUsageAnalytics(durable));
    const res = await app.request("/monitoring/metrics");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      costByModel: Record<string, number>;
      tokensByModel: Record<string, { prompt: number; completion: number }>;
      costTotal: number;
      tokensPrompt: number;
      tokensCompletion: number;
    };
    // Durable data replaces the in-memory openai/gpt-4o-mini entry entirely.
    expect(body.costByModel).toEqual({
      "bedrock/eu.anthropic.claude-sonnet-5": 0.045,
    });
    expect(body.tokensByModel["bedrock/eu.anthropic.claude-sonnet-5"]).toEqual({
      prompt: 5000,
      completion: 2000,
    });
    expect(body.costTotal).toBeCloseTo(0.045, 6);
    expect(body.tokensPrompt).toBe(5000);
    expect(body.tokensCompletion).toBe(2000);
  });

  test("falls back to the in-memory summary when the durable breakdown is empty", async () => {
    const app = buildApp(new StubUsageAnalytics({}));
    const res = await app.request("/monitoring/metrics");
    const body = (await res.json()) as { costByModel: Record<string, number> };
    expect(body.costByModel["openai/gpt-4o-mini"]).toBeCloseTo(0.0002, 6);
  });
});

// ---------------------------------------------------------------------------
// Auth regression: a format-only token must NOT authenticate GET /metrics or
// GET /monitoring/metrics when auth is required. This closes the gap where
// `isValidJwtFormat()` (a shape check, not a signature check) alone gated
// these endpoints — `?token=aaa.bbb.ccc` used to be sufficient.
// ---------------------------------------------------------------------------

describe("GET /metrics and /monitoring/metrics — auth (regression)", () => {
  function buildGatedApp() {
    const metrics = createMetrics(true);
    const app = new Hono();
    // No RBAC configured (no tokens, no jwtVerifier) + authRequired: true →
    // the operator authorizer fails closed for ANY token, format-only or not.
    const operatorAuth = createOperatorAuthorizer({ authRequired: true });
    app.route(
      "/",
      createMetricsRouter(metrics, {
        metricsAuthRequired: true,
        monitoringAuthRequired: true,
        operatorAuth,
        metricsOperatorAuth: operatorAuth,
      }),
    );
    return app;
  }

  test("GET /metrics rejects a well-formed but unverified/unknown token", async () => {
    const app = buildGatedApp();
    const res = await app.request("/metrics?token=aaa.bbb.ccc");
    expect(res.status).toBe(401);
  });

  test("GET /metrics rejects a missing token", async () => {
    const app = buildGatedApp();
    const res = await app.request("/metrics");
    expect(res.status).toBe(401);
  });

  test("GET /monitoring/metrics rejects a well-formed but unverified/unknown token", async () => {
    const app = buildGatedApp();
    const res = await app.request("/monitoring/metrics?token=xxx.yyy.zzz");
    expect(res.status).toBe(401);
  });

  test("GET /metrics accepts a known static operator token (any role)", async () => {
    const metrics = createMetrics(true);
    const app = new Hono();
    const operatorAuth = createOperatorAuthorizer({
      authRequired: true,
      tokens: [{ token: "viewer-tok", role: "viewer" }],
    });
    app.route(
      "/",
      createMetricsRouter(metrics, {
        metricsAuthRequired: true,
        operatorAuth,
        metricsOperatorAuth: operatorAuth,
      }),
    );
    const res = await app.request("/metrics?token=viewer-tok");
    expect(res.status).toBe(200);
  });

  test("GET /metrics can require auth independently of /monitoring/metrics (separate authorizers)", async () => {
    const metrics = createMetrics(true);
    const app = new Hono();
    app.route(
      "/",
      createMetricsRouter(metrics, {
        metricsAuthRequired: true,
        monitoringAuthRequired: false,
      }),
    );
    // /metrics is gated and no credential is supplied → 401.
    expect((await app.request("/metrics")).status).toBe(401);
    // /monitoring/metrics has its own (open) authorizer → 200.
    expect((await app.request("/monitoring/metrics")).status).toBe(200);
  });
});
