// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Route-level tests for the token-limits router: auth gating, CRUD, validation
 * and the time-series range guard. Uses the in-memory limit store and a stub
 * analytics so no database is required.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createLimitsRouter } from "../limits.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import {
  InMemoryTokenLimitStore,
  TokenLimitService,
  type UsageAnalytics,
  type TokenUsageTotals,
  type UsageSeriesPoint,
} from "../../observability/token-limits.js";

class StubAnalytics implements UsageAnalytics {
  async totals(): Promise<TokenUsageTotals> {
    return {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cost: 0.001,
    };
  }
  async series(): Promise<UsageSeriesPoint[]> {
    return [
      {
        bucket: "2026-01-01T00:00:00.000Z",
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        cost: 0,
      },
    ];
  }
  async distinctModels(): Promise<string[]> {
    return ["gpt-4o", "claude-sonnet"];
  }
  async byModel() {
    return {};
  }
}

const authorizer = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "viewer-tok", role: "viewer", name: "vicky" },
    { token: "admin-tok", role: "admin", name: "alice" },
  ],
});

const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

function makeApp() {
  const store = new InMemoryTokenLimitStore();
  const analytics = new StubAnalytics();
  const service = new TokenLimitService(store, analytics);
  const app = new Hono();
  app.route(
    "/",
    createLimitsRouter({ service, store, analytics, operatorAuth: authorizer }),
  );
  return { app, store };
}

describe("token limits routes", () => {
  it("rejects an unauthenticated read", async () => {
    const { app } = makeApp();
    const res = await app.request("/monitoring/limits");
    expect(res.status).toBe(401);
  });

  it("lets a viewer read but forbids a viewer from writing", async () => {
    const { app } = makeApp();
    const read = await app.request("/monitoring/limits", bearer("viewer-tok"));
    expect(read.status).toBe(200);

    const write = await app.request("/monitoring/limits", {
      method: "POST",
      ...bearer("viewer-tok"),
      body: JSON.stringify({
        scopeType: "global",
        period: "day",
        limitTokens: 100,
      }),
    });
    expect(write.status).toBe(401);
  });

  it("creates a limit and returns it with consumption on list", async () => {
    const { app } = makeApp();
    const create = await app.request("/monitoring/limits", {
      method: "POST",
      ...bearer("admin-tok"),
      body: JSON.stringify({
        scopeType: "flow",
        scopeId: "helpdesk",
        period: "week",
        limitTokens: 1000,
      }),
    });
    expect(create.status).toBe(200);

    const list = await app.request("/monitoring/limits", bearer("admin-tok"));
    const body = (await list.json()) as {
      limits: Array<{
        scopeType: string;
        used: { totalTokens: number };
        usedFraction: number;
      }>;
    };
    expect(body.limits).toHaveLength(1);
    const limit0 = body.limits[0];
    if (limit0 === undefined) throw new Error("expected a limit entry");
    expect(limit0.scopeType).toBe("flow");
    expect(limit0.used.totalTokens).toBe(15);
    expect(limit0.usedFraction).toBeCloseTo(0.015, 6);
  });

  it("rejects an invalid limit with 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/monitoring/limits", {
      method: "POST",
      ...bearer("admin-tok"),
      body: JSON.stringify({
        scopeType: "user",
        period: "day",
        limitTokens: 100,
      }), // missing scopeId
    });
    expect(res.status).toBe(400);
  });

  it("deletes a limit by id", async () => {
    const { app } = makeApp();
    const create = await app.request("/monitoring/limits", {
      method: "POST",
      ...bearer("admin-tok"),
      body: JSON.stringify({
        scopeType: "global",
        period: "day",
        limitTokens: 50,
      }),
    });
    const { limit } = (await create.json()) as { limit: { id: string } };
    const del = await app.request(`/monitoring/limits/${limit.id}`, {
      method: "DELETE",
      ...bearer("admin-tok"),
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
  });

  it("serves a time-series and lists models", async () => {
    const { app } = makeApp();
    const ts = await app.request(
      "/monitoring/usage/timeseries?bucket=day&from=2026-01-01&to=2026-01-07",
      bearer("viewer-tok"),
    );
    expect(ts.status).toBe(200);
    const tsBody = (await ts.json()) as { series: unknown[]; bucket: string };
    expect(tsBody.bucket).toBe("day");
    expect(tsBody.series).toHaveLength(1);

    const models = await app.request(
      "/monitoring/usage/models",
      bearer("viewer-tok"),
    );
    expect(((await models.json()) as { models: string[] }).models).toContain(
      "gpt-4o",
    );
  });

  it("guards against an over-fine time-series range", async () => {
    const { app } = makeApp();
    // ~11 years of hourly buckets → far over the point cap.
    const res = await app.request(
      "/monitoring/usage/timeseries?bucket=hour&from=2015-01-01&to=2026-01-01",
      bearer("viewer-tok"),
    );
    expect(res.status).toBe(400);
  });
});
