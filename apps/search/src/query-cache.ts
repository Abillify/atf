// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LRU (Least Recently Used) cache for search-query embeddings.
 *
 * Search queries repeat frequently (same phrase from multiple users, RAG loops,
 * etc.) while ingest texts are generally unique. Caching only the search path
 * avoids storing embeddings that will never be re-used.
 *
 * The cache is keyed by the exact query string — callers should normalise
 * (trim, lowercase, …) if case-insensitive deduplication is desired.
 *
 * Set maxSize = 0 to disable caching entirely (createQueryEmbeddingCache
 * returns a pass-through implementation in that case).
 */

class LRUCache<K, V> {
  private readonly store = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const val = this.store.get(key);
    if (val === undefined) return undefined;
    // Re-insert to mark as most-recently used.
    this.store.delete(key);
    this.store.set(key, val);
    return val;
  }

  set(key: K, val: V): void {
    if (this.store.has(key)) this.store.delete(key);
    else if (this.store.size >= this.maxSize) {
      // Evict the oldest entry (Map preserves insertion order).
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, val);
  }

  get size(): number {
    return this.store.size;
  }
}

export interface QueryEmbeddingCache {
  /**
   * Return the cached vector for `text`, or call `embed()` to compute it,
   * cache the result, and return it.
   */
  getOrEmbed(text: string, embed: () => Promise<number[]>): Promise<number[]>;
  get size(): number;
}

/** No-op implementation used when caching is disabled (maxSize = 0). */
const noopCache: QueryEmbeddingCache = {
  getOrEmbed: (_text, embed) => embed(),
  get size() {
    return 0;
  },
};

export function createQueryEmbeddingCache(
  maxSize: number,
): QueryEmbeddingCache {
  if (maxSize <= 0) return noopCache;

  const cache = new LRUCache<string, number[]>(maxSize);
  // Coalesce concurrent requests for the same query: the second caller joins
  // the first caller's in-flight embed() rather than issuing a duplicate call.
  const pending = new Map<string, Promise<number[]>>();

  return {
    getOrEmbed(
      text: string,
      embed: () => Promise<number[]>,
    ): Promise<number[]> {
      const cached = cache.get(text);
      if (cached) return Promise.resolve(cached);

      const inflight = pending.get(text);
      if (inflight) return inflight;

      const promise = embed()
        .then((vector) => {
          cache.set(text, vector);
          return vector;
        })
        .finally(() => {
          pending.delete(text);
        });

      pending.set(text, promise);
      return promise;
    },
    get size(): number {
      return cache.size;
    },
  };
}
