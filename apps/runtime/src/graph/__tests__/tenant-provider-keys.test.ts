// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the in-memory tenant BYOK key store and the ByokResolver cache.
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryTenantProviderKeyStore,
  ByokResolver,
  isByokProvider,
  type ByokProvider,
  type TenantProviderKeyStore,
} from "../tenant-provider-keys.js";

describe("isByokProvider", () => {
  it("accepts keyed providers and rejects others", () => {
    expect(isByokProvider("openai")).toBe(true);
    expect(isByokProvider("bedrock")).toBe(true);
    expect(isByokProvider("ollama")).toBe(false);
    expect(isByokProvider("nope")).toBe(false);
  });
});

describe("InMemoryTenantProviderKeyStore", () => {
  it("stores and resolves a tenant's key per provider", async () => {
    const store = new InMemoryTenantProviderKeyStore();
    await store.setKey("acme", "openai", "sk-acme-123456");
    await store.setKey("acme", "google", "g-acme-987654");
    await store.setKey("other", "openai", "sk-other-000000");

    expect(await store.getAll("acme")).toEqual({
      openai: "sk-acme-123456",
      google: "g-acme-987654",
    });
    expect(await store.getAll("other")).toEqual({ openai: "sk-other-000000" });
    expect(await store.getAll("unknown")).toEqual({});
  });

  it("lists configured providers masked (no raw values)", async () => {
    const store = new InMemoryTenantProviderKeyStore();
    await store.setKey("acme", "openai", "sk-acme-123456");
    const list = await store.list("acme");
    expect(list).toHaveLength(1);
    const first = list[0];
    if (first === undefined) throw new Error("expected a listed key");
    expect(first.provider).toBe("openai");
    expect(first.keyMask).toBe("****3456");
    expect(JSON.stringify(list)).not.toContain("sk-acme-123456");
  });

  it("upserts (replaces) an existing key", async () => {
    const store = new InMemoryTenantProviderKeyStore();
    await store.setKey("acme", "openai", "old");
    await store.setKey("acme", "openai", "new-key-1234");
    expect((await store.getAll("acme")).openai).toBe("new-key-1234");
  });

  it("removes a key and reports whether it existed", async () => {
    const store = new InMemoryTenantProviderKeyStore();
    await store.setKey("acme", "openai", "sk-123456");
    expect(await store.removeKey("acme", "openai")).toBe(true);
    expect(await store.removeKey("acme", "openai")).toBe(false);
    expect(await store.getAll("acme")).toEqual({});
  });
});

describe("ByokResolver", () => {
  it("caches a tenant's keys within the TTL and refreshes after expiry", async () => {
    let now = 0;
    let calls = 0;
    const backing: Partial<Record<ByokProvider, string>> = { openai: "sk-1" };
    const store = {
      getAll: async () => {
        calls++;
        return backing;
      },
    } as unknown as TenantProviderKeyStore;

    const resolver = new ByokResolver(store, {
      ttlSeconds: 60,
      clock: () => now,
    });
    expect(await resolver.resolve("acme")).toEqual({ openai: "sk-1" });
    await resolver.resolve("acme");
    expect(calls).toBe(1); // served from cache

    now += 61_000;
    await resolver.resolve("acme");
    expect(calls).toBe(2); // refreshed after TTL
  });

  it("invalidates the cache on demand", async () => {
    let calls = 0;
    const store = {
      getAll: async () => {
        calls++;
        return {};
      },
    } as unknown as TenantProviderKeyStore;
    const resolver = new ByokResolver(store, {
      ttlSeconds: 60,
      clock: () => 0,
    });
    await resolver.resolve("acme");
    resolver.invalidate("acme");
    await resolver.resolve("acme");
    expect(calls).toBe(2);
  });
});
