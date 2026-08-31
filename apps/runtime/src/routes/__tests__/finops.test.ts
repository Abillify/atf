// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the FinOps route (`src/routes/finops.ts`).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createFinopsRouter } from "../finops.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import { BudgetService } from "../../observability/cost.js";
import { createMetrics } from "../../observability/metrics.js";

const viewerAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [{ token: "viewer-tok", role: "viewer" }],
});

describe("GET /admin/finops/forecast/:tenantId", () => {
  it("returns 'unbounded' when the tenant has no cap", async () => {
    const budgetService = new BudgetService(0);
    const app = new Hono();
    app.route(
      "/",
      createFinopsRouter({ budgetService, operatorAuth: viewerAuth }),
    );
    const res = await app.request("/admin/finops/forecast/acme", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forecast: { status: string } };
    expect(body.forecast.status).toBe("unbounded");
  });

  it("returns 'insufficient_data' without a durable store (in-memory tracker has no daily series)", async () => {
    const budgetService = new BudgetService(50);
    const app = new Hono();
    app.route(
      "/",
      createFinopsRouter({ budgetService, operatorAuth: viewerAuth }),
    );
    const res = await app.request("/admin/finops/forecast/acme", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forecast: { status: string } };
    expect(body.forecast.status).toBe("insufficient_data");
  });

  it("returns 503 when budget tracking is not configured", async () => {
    const app = new Hono();
    app.route("/", createFinopsRouter({ operatorAuth: viewerAuth }));
    const res = await app.request("/admin/finops/forecast/acme", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(503);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const budgetService = new BudgetService(50);
    const app = new Hono();
    app.route(
      "/",
      createFinopsRouter({ budgetService, operatorAuth: viewerAuth }),
    );
    const res = await app.request("/admin/finops/forecast/acme");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/finops/co2", () => {
  it("returns an empty report when no metrics are wired", async () => {
    const app = new Hono();
    app.route("/", createFinopsRouter({ operatorAuth: viewerAuth }));
    const res = await app.request("/admin/finops/co2", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { byModel: unknown[]; totalEstimatedKgCo2e: number };
    };
    expect(body.report.byModel).toHaveLength(0);
    expect(body.report.totalEstimatedKgCo2e).toBe(0);
  });

  it("aggregates emissions from the metrics token breakdown", async () => {
    const metrics = createMetrics(true);
    metrics.recordLlmCall("openai", "gpt-4o", "ok", 100_000, 50_000, 1.25);
    const app = new Hono();
    app.route("/", createFinopsRouter({ metrics, operatorAuth: viewerAuth }));
    const res = await app.request("/admin/finops/co2", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { byModel: Array<{ model: string }>; totalEstimatedKgCo2e: number };
    };
    expect(body.report.byModel.length).toBeGreaterThan(0);
    const first = body.report.byModel[0];
    if (first === undefined) throw new Error("expected a model entry");
    expect(first.model).toBe("gpt-4o");
    expect(body.report.totalEstimatedKgCo2e).toBeGreaterThan(0);
  });

  it("honours a custom grid carbon intensity", async () => {
    const metrics = createMetrics(true);
    metrics.recordLlmCall("openai", "gpt-4o", "ok", 100_000, 50_000, 1.25);
    const app = new Hono();
    app.route(
      "/",
      createFinopsRouter({
        metrics,
        co2GridCarbonIntensity: 0.05,
        operatorAuth: viewerAuth,
      }),
    );
    const res = await app.request("/admin/finops/co2", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    const body = (await res.json()) as {
      report: { gridCarbonIntensity: number };
    };
    expect(body.report.gridCarbonIntensity).toBe(0.05);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const app = new Hono();
    app.route("/", createFinopsRouter({ operatorAuth: viewerAuth }));
    const res = await app.request("/admin/finops/co2");
    expect(res.status).toBe(401);
  });
});
