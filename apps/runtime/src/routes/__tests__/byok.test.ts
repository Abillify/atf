// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the BYOK provider-key admin routes (tenants router).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createTenantsRouter } from "../tenants.js";
import { InMemoryTenantStore } from "../../graph/tenant-manager.js";
import { InMemoryUsageMeter } from "../../observability/billing.js";
import { InMemoryAuditLog } from "../../observability/audit-log.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import {
  InMemoryTenantProviderKeyStore,
  ByokResolver,
} from "../../graph/tenant-provider-keys.js";

const adminAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "admin-tok", role: "admin", name: "alice" },
    { token: "viewer-tok", role: "viewer" },
  ],
});

async function buildApp(withByok = true) {
  const tenantStore = new InMemoryTenantStore();
  const tenant = await tenantStore.createTenant({ name: "Acme" });
  const usageMeter = new InMemoryUsageMeter();
  const auditLog = new InMemoryAuditLog();
  const providerKeyStore = new InMemoryTenantProviderKeyStore();
  const byokResolver = new ByokResolver(providerKeyStore, { ttlSeconds: 60 });
  const app = new Hono();
  app.route(
    "/",
    createTenantsRouter({
      tenantStore,
      usageMeter,
      operatorAuth: adminAuth,
      auditLog,
      ...(withByok ? { providerKeyStore, byokResolver } : {}),
    }),
  );
  return { app, tenantId: tenant.id, providerKeyStore, byokResolver, auditLog };
}

const put = (key: string) => ({
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer admin-tok",
  },
  body: JSON.stringify({ key }),
});

describe("BYOK provider-key routes", () => {
  it("sets, lists (masked) and resolves a tenant key", async () => {
    const { app, tenantId, providerKeyStore } = await buildApp();

    const setRes = await app.request(
      `/admin/tenants/${tenantId}/provider-keys/openai`,
      put("sk-acme-123456"),
    );
    expect(setRes.status).toBe(200);

    const listRes = await app.request(
      `/admin/tenants/${tenantId}/provider-keys`,
      {
        headers: { Authorization: "Bearer admin-tok" },
      },
    );
    const body = (await listRes.json()) as {
      providerKeys: Array<{ provider: string; keyMask: string }>;
    };
    expect(body.providerKeys[0]).toMatchObject({
      provider: "openai",
      keyMask: "****3456",
    });
    expect(JSON.stringify(body)).not.toContain("sk-acme-123456");

    expect(await providerKeyStore.getAll(tenantId)).toEqual({
      openai: "sk-acme-123456",
    });
  });

  it("invalidates the resolver cache on a key change", async () => {
    const { app, tenantId, byokResolver } = await buildApp();
    expect(await byokResolver.resolve(tenantId)).toEqual({}); // cache empty
    await app.request(
      `/admin/tenants/${tenantId}/provider-keys/google`,
      put("g-key-7890"),
    );
    // Without invalidation this would still be the cached {}.
    expect(await byokResolver.resolve(tenantId)).toEqual({
      google: "g-key-7890",
    });
  });

  it("removes a key", async () => {
    const { app, tenantId } = await buildApp();
    await app.request(
      `/admin/tenants/${tenantId}/provider-keys/openai`,
      put("sk-123456"),
    );
    const del = await app.request(
      `/admin/tenants/${tenantId}/provider-keys/openai`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-tok" },
      },
    );
    expect(del.status).toBe(200);
    const delAgain = await app.request(
      `/admin/tenants/${tenantId}/provider-keys/openai`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-tok" },
      },
    );
    expect(delAgain.status).toBe(404);
  });

  it("rejects an unsupported provider with 400", async () => {
    const { app, tenantId } = await buildApp();
    const res = await app.request(
      `/admin/tenants/${tenantId}/provider-keys/ollama`,
      put("x"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an empty key with 400", async () => {
    const { app, tenantId } = await buildApp();
    const res = await app.request(
      `/admin/tenants/${tenantId}/provider-keys/openai`,
      put("   "),
    );
    expect(res.status).toBe(400);
  });

  it("404s for an unknown tenant", async () => {
    const { app } = await buildApp();
    const res = await app.request(
      `/admin/tenants/nope/provider-keys/openai`,
      put("sk-123456"),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a non-admin (viewer) with 401", async () => {
    const { app, tenantId } = await buildApp();
    const res = await app.request(
      `/admin/tenants/${tenantId}/provider-keys/openai`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer viewer-tok",
        },
        body: JSON.stringify({ key: "sk-123456" }),
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 when BYOK is not enabled on the deployment", async () => {
    const { app, tenantId } = await buildApp(false);
    const res = await app.request(
      `/admin/tenants/${tenantId}/provider-keys/openai`,
      put("sk-123456"),
    );
    expect(res.status).toBe(404);
  });
});
