// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the cluster-wide (VectorStore-backed) semantic cache. Uses the
 * in-memory RAG store as the backing VectorStore — it shares the exact
 * interface and ranking semantics with the pgvector backend.
 */

import { describe, it, expect } from "bun:test";
import {
  createVectorStoreSemanticCache,
  type Embedder,
} from "../semantic-cache.js";
import { InMemoryRagStore } from "../vector-store.js";
import type { CachedResponse } from "../response-cache.js";
import type { SemanticCacheKeyInput } from "../semantic-cache.js";

/** `createVectorStoreSemanticCache` for args known to produce a cache. */
function mustCreateSemanticCache(
  ...args: Parameters<typeof createVectorStoreSemanticCache>
): NonNullable<ReturnType<typeof createVectorStoreSemanticCache>> {
  const cache = createVectorStoreSemanticCache(...args);
  if (cache === undefined) throw new Error("expected the semantic cache to be enabled");
  return cache;
}

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

/** Fake embedder: maps known phrases to vectors so similarity is deterministic. */
class FakeEmbedder implements Embedder {
  constructor(private readonly map: Record<string, number[]>) {}
  async embed(text: string): Promise<number[]> {
    return this.map[text] ?? [0, 0, 1];
  }
}

const value = (text: string): CachedResponse => ({
  text,
  usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
});

const key = (
  text: string,
  over: Partial<SemanticCacheKeyInput> = {},
): SemanticCacheKeyInput => ({
  provider: "openai",
  model: "gpt-4o",
  temperature: 0,
  text,
  tenantScope: "tenant-a",
  userScope: "user-a",
  contextHash: "ctx-identical",
  ...over,
});

describe("createVectorStoreSemanticCache", () => {
  it("returns undefined when disabled or missing deps", () => {
    const store = new InMemoryRagStore();
    expect(
      createVectorStoreSemanticCache(
        { enabled: false },
        new FakeEmbedder({}),
        store,
      ),
    ).toBeUndefined();
    expect(
      createVectorStoreSemanticCache({ enabled: true }, undefined, store),
    ).toBeUndefined();
    expect(
      createVectorStoreSemanticCache(
        { enabled: true },
        new FakeEmbedder({}),
        undefined,
      ),
    ).toBeUndefined();
  });

  it("purges expired entries from the shared store on a later set", async () => {
    let now = 0;
    const store = new InMemoryRagStore();
    const embedder = new FakeEmbedder({ a: [1, 0, 0], b: [0, 1, 0] });
    const cache = mustCreateSemanticCache(
      { enabled: true, ttlSeconds: 10, maxEntries: 100 },
      embedder,
      store,
      undefined,
      () => now,
    );
    await cache.set(key("a"), value("A")); // expiresAt = 10_000
    // Advance past both the TTL and the 60s purge throttle.
    now = 70_000;
    await cache.set(key("b"), value("B")); // triggers the opportunistic purge
    // Let the fire-and-forget purge settle.
    await new Promise((r) => setTimeout(r, 5));
    const collections = await store.listCollections();
    let total = 0;
    for (const c of collections) total += await store.count(c);
    // "a" expired and was purged; only "b" remains.
    expect(total).toBe(1);
    expect(await cache.get(key("a"))).toBeUndefined();
  });

  it("returns a near-duplicate hit above the threshold", async () => {
    const embedder = new FakeEmbedder({
      "what is the capital of france": [1, 0, 0],
      "france capital what is it": [0.99, 0.01, 0],
    });
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.9 },
      embedder,
      new InMemoryRagStore(),
    );
    await cache.set(key("what is the capital of france"), value("Paris"));
    const hit = await cache.get(key("france capital what is it"));
    expect(hit?.text).toBe("Paris");
  });

  it("misses below the threshold", async () => {
    const embedder = new FakeEmbedder({ a: [1, 0, 0], b: [0, 1, 0] });
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.9 },
      embedder,
      new InMemoryRagStore(),
    );
    await cache.set(key("a"), value("A"));
    expect(await cache.get(key("b"))).toBeUndefined();
  });

  it("never crosses model/param namespaces", async () => {
    const embedder = new FakeEmbedder({ q: [1, 0, 0] });
    const store = new InMemoryRagStore();
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.5 },
      embedder,
      store,
    );
    await cache.set(key("q", { model: "gpt-4o" }), value("A"));
    // Same text, different model → different collection → miss.
    expect(await cache.get(key("q", { model: "gpt-4o-mini" }))).toBeUndefined();
    expect((await cache.get(key("q", { model: "gpt-4o" })))?.text).toBe("A");
  });

  it("never leaks a near-duplicate hit across tenants (regression)", async () => {
    const embedder = new FakeEmbedder({
      "what is my account balance": [1, 0, 0],
      "tell me my account balance": [0.99, 0.01, 0],
    });
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.9 },
      embedder,
      new InMemoryRagStore(),
    );
    await cache.set(
      key("what is my account balance", { tenantScope: "tenant-a" }),
      value("Tenant A's balance is €500"),
    );
    const crossTenantHit = await cache.get(
      key("tell me my account balance", { tenantScope: "tenant-b" }),
    );
    expect(crossTenantHit).toBeUndefined();
    const sameTenantHit = await cache.get(
      key("tell me my account balance", { tenantScope: "tenant-a" }),
    );
    expect(sameTenantHit?.text).toBe("Tenant A's balance is €500");
  });

  it("never crosses user scopes or contexts inside one tenant (regression)", async () => {
    const embedder = new FakeEmbedder({
      "what is my account balance": [1, 0, 0],
      "tell me my account balance": [0.99, 0.01, 0],
    });
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.9 },
      embedder,
      new InMemoryRagStore(),
    );
    await cache.set(
      key("what is my account balance", { userScope: "user-a" }),
      value("User A's balance is €500"),
    );
    expect(
      await cache.get(
        key("tell me my account balance", { userScope: "user-b" }),
      ),
    ).toBeUndefined();
    expect(
      await cache.get(
        key("tell me my account balance", { contextHash: "ctx-other" }),
      ),
    ).toBeUndefined();
    const hit = await cache.get(key("tell me my account balance"));
    expect(hit?.text).toBe("User A's balance is €500");
  });

  it("skips expired entries (TTL honoured at read time)", async () => {
    let now = 1_000_000;
    const embedder = new FakeEmbedder({ q: [1, 0, 0] });
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.5, ttlSeconds: 10 },
      embedder,
      new InMemoryRagStore(),
      undefined,
      () => now,
    );
    await cache.set(key("q"), value("A"));
    expect((await cache.get(key("q")))?.text).toBe("A");
    now += 11_000;
    expect(await cache.get(key("q"))).toBeUndefined();
  });

  it("upserts the same prompt in place (no duplicate accumulation)", async () => {
    const embedder = new FakeEmbedder({ q: [1, 0, 0] });
    const store = new InMemoryRagStore();
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.5 },
      embedder,
      store,
    );
    await cache.set(key("q"), value("first"));
    await cache.set(key("q"), value("second"));
    const collections = await store.listCollections();
    expect(collections).toHaveLength(1);
    expect(await store.count(at(collections, 0))).toBe(1);
    expect((await cache.get(key("q")))?.text).toBe("second");
  });

  it("erases exactly the entries of one user", async () => {
    const embedder = new FakeEmbedder({
      "a one": [1, 0, 0],
      "a two": [0.9, 0.1, 0],
      "b one": [0, 1, 0],
      "b two": [0.1, 0.9, 0],
    });
    const store = new InMemoryRagStore();
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.9, ttlSeconds: 300 },
      embedder,
      store,
    );
    await cache.set(key("a one", { userScope: "user-a" }), value("A1"));
    await cache.set(key("a two", { userScope: "user-a" }), value("A2"));
    await cache.set(key("b one", { userScope: "user-b" }), value("B1"));
    await cache.set(key("b two", { userScope: "user-b" }), value("B2"));

    expect(await cache.eraseUser("tenant-a", "user-a")).toBe(2);

    expect(await cache.get(key("a one", { userScope: "user-a" }))).toBeUndefined();
    expect(await cache.get(key("a two", { userScope: "user-a" }))).toBeUndefined();
    expect((await cache.get(key("b one", { userScope: "user-b" })))?.text).toBe(
      "B1",
    );
    expect((await cache.get(key("b two", { userScope: "user-b" })))?.text).toBe(
      "B2",
    );
    // The backing store no longer holds the erased user's documents.
    const collections = await store.listCollections();
    const remaining = await Promise.all(collections.map((c) => store.count(c)));
    expect(remaining.reduce((a, b) => a + b, 0)).toBe(2);
    // Erasing the same user again removes nothing.
    expect(await cache.eraseUser("tenant-a", "user-a")).toBe(0);
  });

  it("reports erasure as unsupported when the store cannot delete", async () => {
    const storeWithoutDelete = {
      upsert: async () => {},
      query: async () => [],
      deleteCollection: async () => 0,
      count: async () => 0,
      listCollections: async () => [],
      listDocuments: async () => [],
    } as unknown as InMemoryRagStore;
    const cache = mustCreateSemanticCache(
      { enabled: true },
      new FakeEmbedder({}),
      storeWithoutDelete,
    );
    expect(cache.erasureSupported).toBe(false);
    expect(await cache.eraseUser("tenant-a", "user-a")).toBe(0);
  });

  it("is only cacheable for deterministic, tool-free requests", () => {
    const cache = mustCreateSemanticCache(
      { enabled: true },
      new FakeEmbedder({}),
      new InMemoryRagStore(),
    );
    expect(cache.isCacheable({ hasTools: false, temperature: 0 })).toBe(true);
    expect(cache.isCacheable({ hasTools: true, temperature: 0 })).toBe(false);
    expect(cache.isCacheable({ hasTools: false, temperature: 0.7 })).toBe(
      false,
    );
  });
});
