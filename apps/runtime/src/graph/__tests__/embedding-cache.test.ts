// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for CachingEmbedder — LRU + TTL + in-flight de-duplication.
 */

import { describe, it, expect } from "bun:test";
import { CachingEmbedder, maybeCacheEmbedder } from "../embedding-cache.js";
import type { Embedder } from "../semantic-cache.js";

/** A counting fake embedder: returns a deterministic vector per text. */
class CountingEmbedder implements Embedder {
  calls = 0;
  constructor(
    private readonly resolver: (text: string) => number[] = (t) => [
      t.length,
      1,
      2,
    ],
  ) {}
  async embed(text: string): Promise<number[]> {
    this.calls++;
    return this.resolver(text);
  }
}

/** A controllable embedder whose resolution is deferred until released. */
class DeferredEmbedder implements Embedder {
  calls = 0;
  private resolvers: Array<(v: number[]) => void> = [];
  async embed(_text: string): Promise<number[]> {
    this.calls++;
    return new Promise<number[]>((resolve) => this.resolvers.push(resolve));
  }
  releaseAll(vector: number[]): void {
    for (const r of this.resolvers) r(vector);
    this.resolvers = [];
  }
}

describe("CachingEmbedder", () => {
  it("serves a repeated input from cache without hitting the inner embedder", async () => {
    const inner = new CountingEmbedder();
    const cache = new CachingEmbedder(inner);

    const a = await cache.embed("hello");
    const b = await cache.embed("hello");

    expect(a).toEqual(b);
    expect(inner.calls).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("treats distinct inputs as separate entries", async () => {
    const inner = new CountingEmbedder();
    const cache = new CachingEmbedder(inner);

    await cache.embed("one");
    await cache.embed("two");

    expect(inner.calls).toBe(2);
    expect(cache.stats().size).toBe(2);
  });

  it("returns a defensive copy so callers cannot corrupt the cached vector", async () => {
    const inner = new CountingEmbedder(() => [1, 2, 3]);
    const cache = new CachingEmbedder(inner);

    const first = await cache.embed("x");
    first[0] = 999; // mutate the returned array
    const second = await cache.embed("x");

    expect(second).toEqual([1, 2, 3]);
  });

  it("expires entries after the TTL and re-embeds", async () => {
    let now = 1_000_000;
    const inner = new CountingEmbedder();
    const cache = new CachingEmbedder(inner, {
      ttlSeconds: 10,
      clock: () => now,
    });

    await cache.embed("hello");
    now += 9_000; // within TTL
    await cache.embed("hello");
    expect(inner.calls).toBe(1);

    now += 2_000; // now past the 10s TTL
    await cache.embed("hello");
    expect(inner.calls).toBe(2);
  });

  it("evicts the least-recently-used entry when over the bound", async () => {
    const inner = new CountingEmbedder();
    const cache = new CachingEmbedder(inner, { maxEntries: 2 });

    await cache.embed("a");
    await cache.embed("b");
    await cache.embed("a"); // touch "a" so "b" becomes LRU
    await cache.embed("c"); // inserts "c", evicts "b"

    expect(cache.stats().size).toBe(2);

    const callsBefore = inner.calls;
    await cache.embed("b"); // "b" was evicted → miss
    expect(inner.calls).toBe(callsBefore + 1);
  });

  it("collapses concurrent identical lookups onto a single provider call", async () => {
    const inner = new DeferredEmbedder();
    const cache = new CachingEmbedder(inner);

    const p1 = cache.embed("same");
    const p2 = cache.embed("same");
    expect(inner.calls).toBe(1); // de-duplicated while in flight

    inner.releaseAll([7, 8, 9]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual([7, 8, 9]);
    expect(r2).toEqual([7, 8, 9]);
  });

  it("does not cache a failed embedding so the next call retries", async () => {
    let shouldFail = true;
    const inner: Embedder = {
      embed: async () => {
        if (shouldFail) throw new Error("boom");
        return [1, 1];
      },
    };
    const cache = new CachingEmbedder(inner);

    await expect(cache.embed("q")).rejects.toThrow("boom");
    shouldFail = false;
    expect(await cache.embed("q")).toEqual([1, 1]);
  });
});

describe("maybeCacheEmbedder", () => {
  it("returns undefined when the embedder is absent", () => {
    expect(maybeCacheEmbedder(undefined, { enabled: true })).toBeUndefined();
  });

  it("returns the original embedder unchanged when disabled", () => {
    const inner = new CountingEmbedder();
    expect(maybeCacheEmbedder(inner, { enabled: false })).toBe(inner);
  });

  it("wraps the embedder when enabled", async () => {
    const inner = new CountingEmbedder();
    const wrapped = maybeCacheEmbedder(inner, { enabled: true });
    expect(wrapped).toBeInstanceOf(CachingEmbedder);
    if (wrapped === undefined) throw new Error("expected a wrapped embedder");
    await wrapped.embed("x");
    await wrapped.embed("x");
    expect(inner.calls).toBe(1);
  });
});
