// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Query-embedding cache tenant binding: entries are keyed by tenant and query
 * (scopedCacheKey), so a cache hit — or a shared in-flight embed — is never
 * observable across tenants. Within one tenant (or without a scope key) the
 * usual caching and coalescing behaviour is unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createQueryEmbeddingCache,
  scopedCacheKey,
} from "../src/query-cache.js";

describe("createQueryEmbeddingCache · tenant-scoped keys", () => {
  it("same tenant and identical query: one embed call", async () => {
    const cache = createQueryEmbeddingCache(16);
    const embed = vi.fn(async () => [1, 2, 3]);
    const first = await cache.getOrEmbed("frage", embed, "tenant-a");
    const second = await cache.getOrEmbed("frage", embed, "tenant-a");
    expect(second).toEqual(first);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("different tenants asking the same query: two embed calls", async () => {
    const cache = createQueryEmbeddingCache(16);
    const embed = vi.fn(async () => [1, 2, 3]);
    await cache.getOrEmbed("frage", embed, "tenant-a");
    await cache.getOrEmbed("frage", embed, "tenant-b");
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("without a scope key caching stays effective", async () => {
    const cache = createQueryEmbeddingCache(16);
    const embed = vi.fn(async () => [1, 2, 3]);
    await cache.getOrEmbed("frage", embed);
    await cache.getOrEmbed("frage", embed);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("concurrent identical queries in one tenant share one embed call", async () => {
    const cache = createQueryEmbeddingCache(16);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embed = vi.fn(async () => {
      await gate;
      return [1, 2, 3];
    });
    const a = cache.getOrEmbed("frage", embed, "tenant-a");
    const b = cache.getOrEmbed("frage", embed, "tenant-a");
    release();
    expect(await a).toEqual(await b);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("scopedCacheKey separates scope and text and is stable", async () => {
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update("tenant-a")
      .update("\u0000")
      .update("frage")
      .digest("hex");
    expect(scopedCacheKey("tenant-a", "frage")).toBe(expected);
    // An undefined scope hashes like the empty scope, and the NUL separator
    // keeps ("a", "b") distinct from ("ab", "")-style concatenations.
    expect(scopedCacheKey(undefined, "frage")).toBe(
      createHash("sha256").update("").update("\u0000").update("frage").digest("hex"),
    );
    expect(scopedCacheKey("a", "b")).not.toBe(scopedCacheKey("ab", ""));
  });
});
