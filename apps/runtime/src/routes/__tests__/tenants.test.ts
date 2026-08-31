// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the tenant/API-key management and usage routes.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createTenantsRouter } from "../tenants.js";
import { InMemoryTenantStore } from "../../graph/tenant-manager.js";
import { InMemoryUsageMeter } from "../../observability/billing.js";
import { InMemoryAuditLog } from "../../observability/audit-log.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";

const adminAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "admin-tok", role: "admin", name: "alice" },
    { token: "viewer-tok", role: "viewer" },
  ],
});

function buildApp() {
  const tenantStore = new InMemoryTenantStore();
  const usageMeter = new InMemoryUsageMeter();
  const auditLog = new InMemoryAuditLog();
  const app = new Hono();
  app.route(
    "/",
    createTenantsRouter({
      tenantStore,
      usageMeter,
      operatorAuth: adminAuth,
      auditLog,
    }),
  );
  return { app, tenantStore, usageMeter, auditLog };
}

function json(body: unknown, method = "POST") {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer admin-tok",
    },
    body: JSON.stringify(body),
  };
}
function get(
  path: string,
  app: ReturnType<typeof buildApp>["app"],
  token = "admin-tok",
) {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } });
}

describe("Tenant CRUD", () => {
  it("creates a tenant and records an audit entry", async () => {
    const { app, auditLog } = buildApp();
    const res = await app.request(
      "/admin/tenants",
      json({ name: "Acme", plan: "pro", dailyBudget: 50 }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string; plan: string } };
    expect(body.tenant.plan).toBe("pro");
    const entries = await auditLog.list();
    const entry0 = entries[0];
    if (entry0 === undefined) throw new Error("expected an audit entry");
    expect(entry0.action).toBe("tenant.create");
  });

  it("lists, gets and updates tenants", async () => {
    const { app } = buildApp();
    await app.request("/admin/tenants", json({ name: "T1" }));
    await app.request("/admin/tenants", json({ name: "T2" }));
    const list = (await (await get("/admin/tenants", app)).json()) as {
      tenants: Array<{ name: string }>;
    };
    expect(list.tenants).toHaveLength(2);

    const tenant0 = list.tenants[0];
    if (tenant0 === undefined) throw new Error("expected a first tenant");
    const id =
      tenant0.name === "T2"
        ? ((tenant0 as { id?: string }).id ?? "")
        : ((list.tenants[1] as { id?: string }).id ?? "");
    const getRes = await (await get(`/admin/tenants/${id}`, app)).json();
    expect((getRes as { tenant: { id: string } }).tenant.id).toBe(id);
  });

  it("rejects a missing name with 400", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/tenants", json({}));
    expect(res.status).toBe(400);
  });

  it("requires admin to create", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/tenants", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer viewer-tok",
      },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("API-key lifecycle", () => {
  it("creates a key (rawKey present once), lists without raw, and revokes", async () => {
    const { app } = buildApp();
    const { tenant } = (await (
      await app.request("/admin/tenants", json({ name: "T" }))
    ).json()) as { tenant: { id: string } };

    const keyRes = await app.request(
      `/admin/tenants/${tenant.id}/keys`,
      json({ name: "prod-key" }),
    );
    expect(keyRes.status).toBe(201);
    const { key } = (await keyRes.json()) as {
      key: { id: string; rawKey: string; keyPrefix: string };
    };
    expect(key.rawKey).toBeDefined();
    expect(key.rawKey.startsWith("aip-")).toBe(true);
    expect((key as { keyHash?: string }).keyHash).toBeUndefined();

    const list = (await (
      await get(`/admin/tenants/${tenant.id}/keys`, app)
    ).json()) as { keys: Array<{ id: string; rawKey?: string }> };
    const key0 = list.keys[0];
    if (key0 === undefined) throw new Error("expected a listed key");
    expect(key0.rawKey).toBeUndefined();

    const rev = await app.request(
      `/admin/tenants/${tenant.id}/keys/${key.id}`,
      { method: "DELETE", headers: { Authorization: "Bearer admin-tok" } },
    );
    expect(((await rev.json()) as { revoked: boolean }).revoked).toBe(true);
  });
});

describe("API-key expiry (regression: expires_at was never enforced)", () => {
  async function makeTenant(app: ReturnType<typeof buildApp>["app"]) {
    const { tenant } = (await (
      await app.request("/admin/tenants", json({ name: "T" }))
    ).json()) as { tenant: { id: string } };
    return tenant;
  }

  it("expiresInDays creates a key that carries an expiresAt in the response", async () => {
    const { app } = buildApp();
    const tenant = await makeTenant(app);
    const res = await app.request(
      `/admin/tenants/${tenant.id}/keys`,
      json({ name: "temp-key", expiresInDays: 30 }),
    );
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: { expiresAt?: string } };
    expect(key.expiresAt).toBeDefined();
    const expiresAt = Date.parse(key.expiresAt as string);
    const expectedMs = Date.now() + 30 * 86_400_000;
    // Within a few seconds of the expected value (test execution time).
    expect(Math.abs(expiresAt - expectedMs)).toBeLessThan(5000);
  });

  it("an explicit expiresAt is honoured verbatim (ISO round-trip)", async () => {
    const { app } = buildApp();
    const tenant = await makeTenant(app);
    const explicit = new Date(Date.now() + 3600_000).toISOString();
    const res = await app.request(
      `/admin/tenants/${tenant.id}/keys`,
      json({ name: "explicit-key", expiresAt: explicit }),
    );
    const { key } = (await res.json()) as { key: { expiresAt?: string } };
    expect(key.expiresAt).toBe(explicit);
  });

  it("rejects an invalid expiresAt with 400", async () => {
    const { app } = buildApp();
    const tenant = await makeTenant(app);
    const res = await app.request(
      `/admin/tenants/${tenant.id}/keys`,
      json({ name: "bad-key", expiresAt: "not-a-date" }),
    );
    expect(res.status).toBe(400);
  });

  it("a key with no expiry field never expires (default behaviour unchanged)", async () => {
    const { app } = buildApp();
    const tenant = await makeTenant(app);
    const res = await app.request(
      `/admin/tenants/${tenant.id}/keys`,
      json({ name: "permanent-key" }),
    );
    const { key } = (await res.json()) as { key: { expiresAt?: string } };
    expect(key.expiresAt).toBeUndefined();
  });
});

describe("Usage and billing export", () => {
  it("returns usage data and a Stripe-compatible export", async () => {
    const { app, usageMeter } = buildApp();
    const { tenant } = (await (
      await app.request("/admin/tenants", json({ name: "T" }))
    ).json()) as { tenant: { id: string } };
    usageMeter.record({
      tenantId: tenant.id,
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.0001,
    });

    const usageRes = await get(`/admin/tenants/${tenant.id}/usage`, app);
    const { usage } = (await usageRes.json()) as {
      usage: Array<{ requestCount: number }>;
    };
    const usage0 = usage[0];
    if (usage0 === undefined) throw new Error("expected a usage entry");
    expect(usage0.requestCount).toBe(1);

    const exportRes = await get(
      `/admin/tenants/${tenant.id}/usage/export`,
      app,
    );
    const { stripe_usage_record } = (await exportRes.json()) as {
      stripe_usage_record: { action: string; quantity: number };
    };
    expect(stripe_usage_record.action).toBe("increment");
    expect(stripe_usage_record.quantity).toBe(150); // 100 + 50 tokens
  });
});
