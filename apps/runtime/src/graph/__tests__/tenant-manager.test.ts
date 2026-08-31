// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for tenant/API-key management (`src/graph/tenant-manager.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryTenantStore,
  generateApiKey,
  hashApiKey,
  TenantNotFoundError,
} from "../tenant-manager.js";

describe("generateApiKey", () => {
  it("produces the aip- prefix and a 40-char key", () => {
    const { rawKey, keyPrefix, keyHash } = generateApiKey();
    expect(rawKey.startsWith("aip-")).toBe(true);
    expect(rawKey).toHaveLength(40);
    expect(keyPrefix).toBe(rawKey.slice(0, 8));
    expect(keyHash).toHaveLength(64); // sha-256 hex
  });

  it("generates unique keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.rawKey).not.toBe(b.rawKey);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it("hash matches hashApiKey round-trip", () => {
    const { rawKey, keyHash } = generateApiKey();
    expect(hashApiKey(rawKey)).toBe(keyHash);
  });
});

describe("InMemoryTenantStore", () => {
  async function seeded() {
    const store = new InMemoryTenantStore();
    const tenant = await store.createTenant({
      name: "Acme",
      plan: "pro",
      dailyBudget: 50,
    });
    return { store, tenant };
  }

  it("creates, gets, lists and updates tenants", async () => {
    const { store, tenant } = await seeded();
    expect(tenant.plan).toBe("pro");
    expect(tenant.dailyBudget).toBe(50);

    const got = await store.getTenant(tenant.id);
    expect(got?.name).toBe("Acme");

    const updated = await store.updateTenant(tenant.id, { plan: "enterprise" });
    expect(updated?.plan).toBe("enterprise");

    const list = await store.listTenants();
    expect(list).toHaveLength(1);
  });

  it("deletes a tenant and cascades keys", async () => {
    const { store, tenant } = await seeded();
    const { rawKey } = await store.createApiKey(tenant.id, "k1");
    expect(rawKey.startsWith("aip-")).toBe(true);
    await store.deleteTenant(tenant.id);
    expect(await store.getTenant(tenant.id)).toBeUndefined();
    expect(await store.listApiKeys(tenant.id)).toEqual([]);
  });

  it("throws TenantNotFoundError when creating a key for an unknown tenant", async () => {
    const store = new InMemoryTenantStore();
    await expect(store.createApiKey("unknown", "k")).rejects.toBeInstanceOf(
      TenantNotFoundError,
    );
  });

  it("creates a key, returns rawKey once, and resolves the tenant on lookup", async () => {
    const { store, tenant } = await seeded();
    const created = await store.createApiKey(tenant.id, "my-key");
    expect(created.rawKey.startsWith("aip-")).toBe(true);
    expect(created.keyPrefix).toBe(created.rawKey.slice(0, 8));
    expect((created as { keyHash?: unknown }).keyHash).toBeUndefined(); // not exposed

    const found = await store.lookupByApiKey(created.rawKey);
    expect(found?.id).toBe(tenant.id);

    // Wrong key → undefined
    expect(
      await store.lookupByApiKey("aip-xxxxwrong1234567890"),
    ).toBeUndefined();
  });

  it("revokes a key so it no longer resolves", async () => {
    const { store, tenant } = await seeded();
    const { rawKey, id } = await store.createApiKey(tenant.id, "k");
    await store.revokeApiKey(id);
    expect(await store.lookupByApiKey(rawKey)).toBeUndefined();
    const keys = await store.listApiKeys(tenant.id);
    const key0 = keys[0];
    if (key0 === undefined) throw new Error("expected a listed key");
    expect(key0.status).toBe("revoked");
    expect(key0.revokedAt).toBeDefined();
  });

  describe("expiry (regression: expires_at was never enforced)", () => {
    it("a key created without an expiry never expires", async () => {
      const { store, tenant } = await seeded();
      const { rawKey } = await store.createApiKey(tenant.id, "no-expiry");
      expect((await store.lookupByApiKey(rawKey))?.id).toBe(tenant.id);
    });

    it("a key created with a FUTURE expiry still resolves", async () => {
      const { store, tenant } = await seeded();
      const future = new Date(Date.now() + 60_000).toISOString();
      const { rawKey } = await store.createApiKey(
        tenant.id,
        "future-expiry",
        future,
      );
      expect((await store.lookupByApiKey(rawKey))?.id).toBe(tenant.id);
    });

    it("a key created with a PAST expiry never resolves, even though status stays 'active'", async () => {
      const { store, tenant } = await seeded();
      const past = new Date(Date.now() - 60_000).toISOString();
      const created = await store.createApiKey(
        tenant.id,
        "expired-key",
        past,
      );
      expect(await store.lookupByApiKey(created.rawKey)).toBeUndefined();

      // The lifecycle axes are independent: expiry is not the same as
      // revocation. listApiKeys must still show the key as active (it lapsed
      // on schedule; nobody revoked it) with its expiresAt visible.
      const keys = await store.listApiKeys(tenant.id);
      const key0 = keys[0];
      if (key0 === undefined) throw new Error("expected a listed key");
      expect(key0.status).toBe("active");
      expect(key0.expiresAt).toBe(past);
    });

    it("a key that expires DURING its lifetime stops resolving once past expiry (injectable clock semantics via Date)", async () => {
      const { store, tenant } = await seeded();
      const soon = new Date(Date.now() + 10).toISOString();
      const created = await store.createApiKey(tenant.id, "soon", soon);
      // Still valid immediately after creation.
      expect((await store.lookupByApiKey(created.rawKey))?.id).toBe(
        tenant.id,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(await store.lookupByApiKey(created.rawKey)).toBeUndefined();
    });
  });
});
