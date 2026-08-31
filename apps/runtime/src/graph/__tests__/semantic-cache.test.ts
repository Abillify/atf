// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the semantic cache (`src/graph/semantic-cache.ts`).
 *
 * A deterministic fake embedder maps known phrases to fixed vectors so we can
 * test similarity, namespacing, TTL and LRU eviction without any network.
 */

import { describe, it, expect } from "bun:test";
import {
  cosineSimilarity,
  InMemoryVectorStore,
  createSemanticCache,
  type Embedder,
  type SemanticCacheKeyInput,
} from "../semantic-cache.js";
import type { CachedResponse } from "../response-cache.js";

/** `createSemanticCache` for args known to produce a cache. */
function mustCreateSemanticCache(
  ...args: Parameters<typeof createSemanticCache>
): NonNullable<ReturnType<typeof createSemanticCache>> {
  const cache = createSemanticCache(...args);
  if (cache === undefined) throw new Error("expected the semantic cache to be enabled");
  return cache;
}

const value = (text: string): CachedResponse => ({
  text,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

/** Embeds by a small lookup; near-duplicates share almost-identical vectors. */
class FakeEmbedder implements Embedder {
  constructor(private readonly table: Record<string, number[]>) {}
  async embed(text: string): Promise<number[]> {
    return this.table[text] ?? [0, 0, 0];
  }
}

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("returns 0 for mismatched length or zero vector", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("InMemoryVectorStore", () => {
  it("returns a match only at or above the threshold within a namespace", () => {
    const store = new InMemoryVectorStore(10);
    store.insert("ns1", "a", [1, 0, 0], value("hit"), 300);
    // Very similar vector → hit.
    expect(store.search("ns1", [0.99, 0.01, 0], 0.9)?.text).toBe("hit");
    // Orthogonal vector → miss.
    expect(store.search("ns1", [0, 1, 0], 0.9)).toBeUndefined();
    // Same vector, different namespace → miss (no cross-namespace bleed).
    expect(store.search("ns2", [1, 0, 0], 0.9)).toBeUndefined();
  });

  it("evicts the least-recently-used entry beyond the bound", () => {
    const store = new InMemoryVectorStore(2);
    store.insert("ns", "a", [1, 0, 0], value("a"), 300);
    store.insert("ns", "b", [0, 1, 0], value("b"), 300);
    // Touch "a" so "b" becomes LRU.
    expect(store.search("ns", [1, 0, 0], 0.9)?.text).toBe("a");
    store.insert("ns", "c", [0, 0, 1], value("c"), 300);
    expect(store.size()).toBe(2);
    // "b" should have been evicted.
    expect(store.search("ns", [0, 1, 0], 0.99)).toBeUndefined();
    expect(store.search("ns", [1, 0, 0], 0.99)?.text).toBe("a");
  });

  it("treats expired entries as misses", async () => {
    const store = new InMemoryVectorStore(10);
    store.insert("ns", "a", [1, 0, 0], value("a"), 0); // already expired
    await new Promise((r) => setTimeout(r, 5));
    expect(store.search("ns", [1, 0, 0], 0.5)).toBeUndefined();
  });
});

describe("createSemanticCache", () => {
  const key = (
    text: string,
    over: Partial<SemanticCacheKeyInput> = {},
  ): SemanticCacheKeyInput => ({
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0,
    text,
    tenantScope: "tenant-a",
    ...over,
  });

  it("returns undefined when disabled or no embedder", () => {
    expect(
      createSemanticCache({ enabled: false }, new FakeEmbedder({})),
    ).toBeUndefined();
    expect(createSemanticCache({ enabled: true }, undefined)).toBeUndefined();
  });

  it("reuses a stored response for a near-duplicate prompt", async () => {
    const embedder = new FakeEmbedder({
      "what is the capital of france": [1, 0, 0],
      "tell me france's capital": [0.98, 0.02, 0],
      "what is the capital of spain": [0, 1, 0],
    });
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.9, ttlSeconds: 300, maxEntries: 100 },
      embedder,
    );

    await cache.set(key("what is the capital of france"), value("Paris"));

    // Paraphrase → semantic hit.
    expect((await cache.get(key("tell me france's capital")))?.text).toBe(
      "Paris",
    );
    // Unrelated → miss.
    expect(
      await cache.get(key("what is the capital of spain")),
    ).toBeUndefined();
  });

  it("never crosses model/param namespaces", async () => {
    const embedder = new FakeEmbedder({ q: [1, 0, 0] });
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.5 },
      embedder,
    );
    await cache.set(key("q", { model: "gpt-4o" }), value("A"));
    // Same text, different model → miss.
    const miss = await cache.get(key("q", { model: "gpt-4o-mini" }));
    expect(miss).toBeUndefined();
  });

  it("never leaks a near-duplicate hit across tenants (regression)", async () => {
    const embedder = new FakeEmbedder({
      "what is my account balance": [1, 0, 0],
      "tell me my account balance": [0.99, 0.01, 0],
    });
    const cache = mustCreateSemanticCache(
      { enabled: true, threshold: 0.9 },
      embedder,
    );
    await cache.set(
      key("what is my account balance", { tenantScope: "tenant-a" }),
      value("Tenant A's balance is €500"),
    );
    // A near-duplicate question from a DIFFERENT tenant must miss even though
    // the embeddings are highly similar — tenant is part of the namespace.
    const crossTenantHit = await cache.get(
      key("tell me my account balance", { tenantScope: "tenant-b" }),
    );
    expect(crossTenantHit).toBeUndefined();
    // The same tenant still gets its semantic hit.
    const sameTenantHit = await cache.get(
      key("tell me my account balance", { tenantScope: "tenant-a" }),
    );
    expect(sameTenantHit?.text).toBe("Tenant A's balance is €500");
  });

  it("is only cacheable for deterministic, tool-free requests", () => {
    const cache = mustCreateSemanticCache({ enabled: true }, new FakeEmbedder({}));
    expect(cache.isCacheable({ hasTools: false, temperature: 0 })).toBe(true);
    expect(cache.isCacheable({ hasTools: true, temperature: 0 })).toBe(false);
    expect(cache.isCacheable({ hasTools: false, temperature: 0.7 })).toBe(
      false,
    );
  });
});
