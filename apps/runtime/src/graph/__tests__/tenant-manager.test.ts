// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for tenant/API-key management (`src/graph/tenant-manager.ts`).
 */

import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";
import type { Database } from "../../db/database.js";
import {
  hmacApiKeyHash,
  InMemoryTenantStore,
  PostgresTenantStore,
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

  it("without a pepper uses unsalted SHA-256 (hash_alg 'sha256')", () => {
    const { rawKey, keyHash, hashAlg } = generateApiKey();
    expect(hashAlg).toBe("sha256");
    expect(keyHash).toBe(hashApiKey(rawKey));
  });

  it("with a pepper uses HMAC-SHA-256 (hash_alg 'hmac-sha256') (Req 7.9)", () => {
    const pepper = "p3pper-value";
    const { rawKey, keyHash, hashAlg } = generateApiKey(pepper);
    expect(hashAlg).toBe("hmac-sha256");
    expect(keyHash).toBe(
      crypto.createHmac("sha256", pepper).update(rawKey).digest("hex"),
    );
    // The peppered hash must differ from the unsalted one.
    expect(keyHash).not.toBe(hashApiKey(rawKey));
  });

  it("hmacApiKeyHash is deterministic and pepper-dependent", () => {
    const a = hmacApiKeyHash("aip-key", "pepper-a");
    expect(a).toBe(hmacApiKeyHash("aip-key", "pepper-a"));
    expect(a).not.toBe(hmacApiKeyHash("aip-key", "pepper-b"));
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

// ---------------------------------------------------------------------------
// API-key pepper — HMAC-SHA-256 with API_KEY_PEPPER + lazy migration (Req 7.9)
// ---------------------------------------------------------------------------

describe("API-key pepper (Req 7.9)", () => {
  /** Minimal in-memory fake of the `api_keys`/`tenants` tables, matching the
   * exact SQL shapes `PostgresTenantStore` issues (hash_alg-aware). */
  function fakeDb() {
    const apiKeys: Array<Record<string, unknown>> = [];
    const tenants: Array<Record<string, unknown>> = [];
    const db: Database = {
      query: async <T,>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<T[]> => {
        const p = params as unknown[];
        if (sql.includes("INSERT INTO api_keys")) {
          apiKeys.push({
            id: p[0],
            tenant_id: p[1],
            name: p[2],
            key_prefix: p[3],
            key_hash: p[4],
            hash_alg: p[5],
            expires_at: p[6] ?? null,
            status: "active",
            last_used_at: null,
            created_at: new Date(),
            revoked_at: null,
          });
          return [];
        }
        if (sql.includes("INSERT INTO tenants")) {
          tenants.push({
            id: p[0],
            name: p[1],
            plan: p[2],
            daily_budget: p[3],
            metadata: p[4],
            created_at: new Date(),
            updated_at: new Date(),
          });
          return [];
        }
        if (sql.includes("FROM api_keys k")) {
          const [hash, alg] = p as [string, string];
          const now = Date.now();
          return apiKeys.filter(
            (k) =>
              k.key_hash === hash &&
              k.hash_alg === alg &&
              k.status === "active" &&
              (k.expires_at === null ||
                Date.parse(String(k.expires_at)) > now),
          ) as T[];
        }
        if (sql.includes("UPDATE api_keys SET key_hash")) {
          const [id, hash] = p as [string, string];
          const row = apiKeys.find(
            (k) => k.id === id && k.hash_alg === "sha256",
          );
          if (row !== undefined) {
            row.key_hash = hash;
            row.hash_alg = "hmac-sha256";
          }
          return [];
        }
        if (sql.includes("UPDATE api_keys SET last_used_at")) {
          const row = apiKeys.find((k) => k.id === p[0]);
          if (row !== undefined) row.last_used_at = new Date();
          return [];
        }
        if (sql.includes("FROM api_keys WHERE id=$1")) {
          return apiKeys.filter((k) => k.id === p[0]) as T[];
        }
        if (sql.includes("FROM tenants WHERE id=$1")) {
          return tenants.filter((t) => t.id === p[0]) as T[];
        }
        throw new Error(`fakeDb: unexpected SQL: ${sql}`);
      },
      close: async () => {},
      withOperator: async <T,>(cb: (db: Database) => Promise<T>) => cb(db),
    };
    return { db, apiKeys, tenants };
  }

  it("InMemory: with a pepper, new keys resolve via HMAC", async () => {
    const store = new InMemoryTenantStore({ pepper: "p3pper" });
    const tenant = await store.createTenant({ name: "Acme" });
    const created = await store.createApiKey(tenant.id, "k");
    expect((await store.lookupByApiKey(created.rawKey))?.id).toBe(tenant.id);
  });

  it("InMemory: without a pepper, keys stay on the sha256 form", async () => {
    const store = new InMemoryTenantStore();
    const tenant = await store.createTenant({ name: "Acme" });
    const created = await store.createApiKey(tenant.id, "k");
    const keys = (
      store as unknown as {
        keys: Map<string, { keyHash: string; hashAlg: string }>;
      }
    ).keys;
    const row = [...keys.values()][0];
    if (row === undefined) throw new Error("expected a stored key");
    expect(row.hashAlg).toBe("sha256");
    expect(row.keyHash).toBe(hashApiKey(created.rawKey));
  });

  it("InMemory: a legacy sha256 row migrates to HMAC on the next successful lookup", async () => {
    const pepper = "p3pper";
    const store = new InMemoryTenantStore({ pepper });
    const tenant = await store.createTenant({ name: "Acme" });
    const rawKey = `aip-${"x".repeat(36)}`;
    // Seed a pre-pepper row directly (simulates a row written before the
    // pepper was configured).
    const keys = (
      store as unknown as {
        keys: Map<
          string,
          {
            id: string;
            tenantId: string;
            name: string;
            keyPrefix: string;
            keyHash: string;
            hashAlg: string;
            status: "active" | "revoked";
            createdAt: string;
          }
        >;
      }
    ).keys;
    keys.set("legacy", {
      id: "legacy",
      tenantId: tenant.id,
      name: "legacy",
      keyPrefix: rawKey.slice(0, 8),
      keyHash: hashApiKey(rawKey),
      hashAlg: "sha256",
      status: "active",
      createdAt: new Date().toISOString(),
    });

    // First lookup: resolves through the SHA-256 fallback and migrates.
    expect((await store.lookupByApiKey(rawKey))?.id).toBe(tenant.id);
    const row = keys.get("legacy");
    if (row === undefined) throw new Error("expected the seeded row");
    expect(row.hashAlg).toBe("hmac-sha256");
    expect(row.keyHash).toBe(hmacApiKeyHash(rawKey, pepper));

    // Second lookup: now resolves via the HMAC form only.
    expect((await store.lookupByApiKey(rawKey))?.id).toBe(tenant.id);
  });

  it("Postgres: createApiKey stores hash_alg per pepper setting", async () => {
    const { db, apiKeys } = fakeDb();
    const withPepper = new PostgresTenantStore(db, undefined, {
      pepper: "p3pper",
    });
    const without = new PostgresTenantStore(db);
    const tenant = await withPepper.createTenant({ name: "Acme" });

    const a = await withPepper.createApiKey(tenant.id, "peppered");
    const b = await without.createApiKey(tenant.id, "plain");

    const rowA = apiKeys.find((k) => k.id === a.id);
    const rowB = apiKeys.find((k) => k.id === b.id);
    expect(rowA?.hash_alg).toBe("hmac-sha256");
    expect(rowA?.key_hash).toBe(hmacApiKeyHash(a.rawKey, "p3pper"));
    expect(rowB?.hash_alg).toBe("sha256");
    expect(rowB?.key_hash).toBe(hashApiKey(b.rawKey));

    // Both resolve on their own store.
    expect((await withPepper.lookupByApiKey(a.rawKey))?.id).toBe(tenant.id);
    expect((await without.lookupByApiKey(b.rawKey))?.id).toBe(tenant.id);
  });

  it("Postgres: a legacy sha256 row migrates lazily on the next successful lookup", async () => {
    const pepper = "p3pper";
    const { db, apiKeys } = fakeDb();
    const legacy = new PostgresTenantStore(db);
    const tenant = await legacy.createTenant({ name: "Acme" });
    const created = await legacy.createApiKey(tenant.id, "legacy");
    const row = apiKeys.find((k) => k.id === created.id);
    if (row === undefined) throw new Error("expected the stored row");
    expect(row.hash_alg).toBe("sha256");

    // The peppered store (e.g. after a deploy that set API_KEY_PEPPER) still
    // resolves the old key via the SHA-256 fallback — and migrates it.
    const peppered = new PostgresTenantStore(db, undefined, { pepper });
    expect((await peppered.lookupByApiKey(created.rawKey))?.id).toBe(tenant.id);
    expect(row.hash_alg).toBe("hmac-sha256");
    expect(row.key_hash).toBe(hmacApiKeyHash(created.rawKey, pepper));

    // Subsequent lookups resolve via HMAC; the stale SHA-256 hash is gone.
    expect((await peppered.lookupByApiKey(created.rawKey))?.id).toBe(tenant.id);
    const legacyStore = new PostgresTenantStore(db);
    expect(await legacyStore.lookupByApiKey(created.rawKey)).toBeUndefined();
  });

  it("Postgres: an unknown key resolves to undefined on both forms", async () => {
    const { db } = fakeDb();
    const store = new PostgresTenantStore(db, undefined, { pepper: "p" });
    expect(await store.lookupByApiKey("aip-not-a-real-key-123456")).toBeUndefined();
  });
});
