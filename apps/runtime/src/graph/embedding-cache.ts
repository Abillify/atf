// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Embedding cache (`src/graph/embedding-cache.ts`)
 *
 * Every embedding round-trip is a billable provider call with real latency.
 * The semantic response cache, the RAG retrieval node and agent long-term
 * memory all embed text constantly — and frequently the *same* text (an agent
 * retry, a paraphrase that already hit the semantic cache on a previous turn, a
 * recall query repeated across turns). This decorator wraps any {@link Embedder}
 * and serves identical inputs from a bounded in-memory LRU with TTL, so a
 * repeated embedding never reaches the provider twice.
 *
 * Design notes:
 *   - It is a transparent drop-in: it implements {@link Embedder}, so callers
 *     (semantic cache / RAG / memory) need no change beyond construction.
 *   - In-flight de-duplication: concurrent embeds of the same text share a
 *     single provider promise (a thundering herd of identical lookups collapses
 *     to one call). A rejected promise is not cached.
 *   - Bounded LRU + per-entry TTL, like the other caches, so memory is capped
 *     and stale vectors expire. Per-replica, in-memory — no external state.
 *   - The cache key is a SHA-256 of the exact text, so any change misses safely.
 *
 * Pure aside from the injected clock; fully unit-testable with a fake embedder.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { Embedder } from "./semantic-cache.js";
import type { Logger } from "../observability/logger.js";

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

interface CacheEntry {
  vector: number[];
  expiresAt: number;
  /** Recency marker for LRU eviction. */
  touched: number;
}

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  size: number;
}

export interface CachingEmbedderOptions {
  /** Max distinct texts held before LRU eviction. Default 2000. */
  maxEntries?: number;
  /** Per-entry time-to-live in seconds. Default 3600 (1h). */
  ttlSeconds?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  clock?: Clock;
  logger?: Logger;
}

/**
 * Wraps an {@link Embedder} with a bounded LRU + TTL cache and in-flight
 * de-duplication. Identical inputs are served from memory; distinct inputs fall
 * through to the wrapped embedder exactly once.
 */
export class CachingEmbedder implements Embedder {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<number[]>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private seq = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly inner: Embedder,
    options: CachingEmbedderOptions = {},
  ) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 2000);
    this.ttlMs = Math.max(1, options.ttlSeconds ?? 3600) * 1000;
    this.clock = options.clock ?? Date.now;
  }

  async embed(text: string): Promise<number[]> {
    const key = crypto.createHash("sha256").update(text).digest("hex");
    const now = this.clock();

    const entry = this.cache.get(key);
    if (entry !== undefined) {
      if (now <= entry.expiresAt) {
        entry.touched = ++this.seq; // LRU bump
        this.hits++;
        // Return a copy so a caller mutating the array cannot corrupt the cache.
        return entry.vector.slice();
      }
      this.cache.delete(key);
    }

    // Collapse concurrent identical lookups onto one provider call.
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      this.hits++;
      return (await existing).slice();
    }

    this.misses++;
    const promise = this.inner.embed(text);
    this.inflight.set(key, promise);
    let vector: number[];
    try {
      vector = await promise;
    } finally {
      this.inflight.delete(key);
    }

    this.cache.set(key, {
      vector: vector.slice(),
      expiresAt: this.clock() + this.ttlMs,
      touched: ++this.seq,
    });
    this.evictIfNeeded();
    return vector.slice();
  }

  /** Hit/miss/size snapshot for diagnostics and metrics. */
  stats(): EmbeddingCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }

  private evictIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      let lruKey: string | undefined;
      let lruTouched = Infinity;
      for (const [k, e] of this.cache) {
        if (e.touched < lruTouched) {
          lruTouched = e.touched;
          lruKey = k;
        }
      }
      if (lruKey === undefined) break;
      this.cache.delete(lruKey);
    }
  }
}

/**
 * Wraps an embedder in a {@link CachingEmbedder} when caching is enabled.
 * Returns the original embedder unchanged when disabled or absent, so the
 * feature is strictly additive and off by default.
 */
export function maybeCacheEmbedder(
  embedder: Embedder | undefined,
  options: CachingEmbedderOptions & { enabled?: boolean },
): Embedder | undefined {
  if (embedder === undefined) return undefined;
  if (options.enabled !== true) return embedder;
  options.logger?.info("Embedding cache enabled", {
    maxEntries: options.maxEntries ?? 2000,
    ttlSeconds: options.ttlSeconds ?? 3600,
  });
  return new CachingEmbedder(embedder, options);
}
