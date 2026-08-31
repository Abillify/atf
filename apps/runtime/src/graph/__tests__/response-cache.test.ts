// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the response cache (`src/graph/response-cache.ts`).
 */

import { describe, it, expect } from "bun:test";
import type { ModelMessage } from "ai";
import {
  computeResponseCacheKey,
  isCacheableRequest,
  InMemoryCacheStore,
  createResponseCache,
  SINGLE_TENANT_SCOPE,
  type CachedResponse,
} from "../response-cache.js";

const msgs = (text: string): ModelMessage[] => [
  { role: "user", content: text },
];
const value = (text: string): CachedResponse => ({
  text,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

describe("computeResponseCacheKey", () => {
  it("is stable for identical inputs", () => {
    const a = computeResponseCacheKey({
      provider: "openai",
      model: "gpt-4o-mini",
      messages: msgs("hi"),
      tenantScope: "tenant-a",
    });
    const b = computeResponseCacheKey({
      provider: "openai",
      model: "gpt-4o-mini",
      messages: msgs("hi"),
      tenantScope: "tenant-a",
    });
    expect(a).toBe(b);
  });

  it("differs when model, params, messages, or tenant scope change", () => {
    const base = {
      provider: "openai",
      model: "gpt-4o-mini",
      messages: msgs("hi"),
      tenantScope: "tenant-a",
    };
    const k = computeResponseCacheKey(base);
    expect(computeResponseCacheKey({ ...base, model: "gpt-4o" })).not.toBe(k);
    expect(computeResponseCacheKey({ ...base, temperature: 0.5 })).not.toBe(k);
    expect(
      computeResponseCacheKey({ ...base, messages: msgs("bye") }),
    ).not.toBe(k);
    // The critical case: identical request, different tenant → different key.
    expect(
      computeResponseCacheKey({ ...base, tenantScope: "tenant-b" }),
    ).not.toBe(k);
    expect(
      computeResponseCacheKey({ ...base, tenantScope: SINGLE_TENANT_SCOPE }),
    ).not.toBe(k);
  });
});

describe("isCacheableRequest", () => {
  it("allows only an explicit temperature of 0, tool-free", () => {
    expect(isCacheableRequest({ hasTools: false, temperature: 0 })).toBe(true);
  });
  it("rejects tools, unset, or non-zero temperature", () => {
    expect(isCacheableRequest({ hasTools: true, temperature: 0 })).toBe(false);
    // Unset temperature is NOT deterministic (provider default is non-zero).
    expect(isCacheableRequest({ hasTools: false })).toBe(false);
    expect(isCacheableRequest({ hasTools: false, temperature: 0.7 })).toBe(
      false,
    );
  });
});

describe("InMemoryCacheStore", () => {
  it("stores and retrieves values", async () => {
    const store = new InMemoryCacheStore(10);
    await store.set("k", value("hello"), 60);
    expect((await store.get("k"))?.text).toBe("hello");
  });

  it("expires entries past their TTL", async () => {
    const store = new InMemoryCacheStore(10);
    await store.set("k", value("x"), 0); // ttl 0 → already expired
    // Tiny delay to cross the expiry boundary deterministically.
    await new Promise((r) => setTimeout(r, 2));
    expect(await store.get("k")).toBeUndefined();
  });

  it("evicts the least-recently-used entry beyond the bound", async () => {
    const store = new InMemoryCacheStore(2);
    await store.set("a", value("a"), 60);
    await store.set("b", value("b"), 60);
    await store.get("a"); // bump a → b is now LRU
    await store.set("c", value("c"), 60); // evicts b
    expect(await store.get("b")).toBeUndefined();
    expect((await store.get("a"))?.text).toBe("a");
    expect((await store.get("c"))?.text).toBe("c");
  });
});

describe("createResponseCache", () => {
  it("returns undefined when disabled", () => {
    expect(createResponseCache({ enabled: false })).toBeUndefined();
  });

  it("round-trips a value through the facade", async () => {
    const cache = createResponseCache({ enabled: true, ttlSeconds: 60 });
    expect(cache).toBeDefined();
    if (cache === undefined) throw new Error("expected the cache to be enabled");
    const input = {
      provider: "openai",
      model: "gpt-4o-mini",
      messages: msgs("ping"),
      tenantScope: "tenant-a",
    };
    expect(await cache.get(input)).toBeUndefined();
    await cache.set(input, value("pong"));
    expect((await cache.get(input))?.text).toBe("pong");
  });

  it("never caches empty output", async () => {
    const cache = createResponseCache({ enabled: true });
    if (cache === undefined) throw new Error("expected the cache to be enabled");
    const input = {
      provider: "openai",
      model: "gpt-4o-mini",
      messages: msgs("x"),
      tenantScope: "tenant-a",
    };
    await cache.set(input, value(""));
    expect(await cache.get(input)).toBeUndefined();
  });

  it("never leaks a cached response across tenants (regression)", async () => {
    const cache = createResponseCache({ enabled: true, ttlSeconds: 60 });
    if (cache === undefined) throw new Error("expected the cache to be enabled");
    const forTenant = (tenantScope: string) => ({
      provider: "openai",
      model: "gpt-4o-mini",
      messages: msgs("what is my account balance?"),
      tenantScope,
    });
    await cache.set(forTenant("tenant-a"), value("Tenant A's balance is €500"));
    // Byte-identical request from a DIFFERENT tenant must be a miss, not a hit
    // on tenant A's cached (and possibly sensitive) response.
    expect(await cache.get(forTenant("tenant-b"))).toBeUndefined();
    expect((await cache.get(forTenant("tenant-a")))?.text).toBe(
      "Tenant A's balance is €500",
    );
  });
});
