// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * In-memory Store implementation (`src/db/store/memory-store.ts`)
 *
 * Simple Map-based implementation with setTimeout for TTL eviction.
 * **Only for non-production use** — counters are per-process, not cluster-wide.
 * The Prod-Gate will reject this backing in production (Requirement 2.2).
 *
 * No `any` at module boundaries.
 */

import type { Store, CounterStore, StoreFactory } from "./store.js";

// ---------------------------------------------------------------------------
// Key serialisation helper
// ---------------------------------------------------------------------------

function serializeKey(key: unknown): string {
  if (typeof key === "string") return key;
  return JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// MemoryStore (key-value)
// ---------------------------------------------------------------------------

interface Entry<V> {
  value: V;
  timer?: ReturnType<typeof setTimeout>;
}

class MemoryStore<K, V> implements Store<K, V> {
  private readonly data = new Map<string, Entry<V>>();

  constructor(private readonly namespace: string) {}

  private fullKey(k: K): string {
    return `${this.namespace}:${serializeKey(k)}`;
  }

  async get(key: K): Promise<V | undefined> {
    const entry = this.data.get(this.fullKey(key));
    return entry?.value;
  }

  async set(key: K, value: V, opts?: { ttlMs?: number }): Promise<void> {
    const fk = this.fullKey(key);
    // Clear previous timer if key already existed
    const existing = this.data.get(fk);
    if (existing?.timer !== undefined) {
      clearTimeout(existing.timer);
    }

    const entry: Entry<V> = { value };
    if (opts?.ttlMs !== undefined && opts.ttlMs > 0) {
      entry.timer = setTimeout(() => {
        this.data.delete(fk);
      }, opts.ttlMs);
      // Prevent timer from keeping the process alive
      if (typeof entry.timer === "object" && "unref" in entry.timer) {
        (entry.timer as { unref(): void }).unref();
      }
    }
    this.data.set(fk, entry);
  }

  async delete(key: K): Promise<void> {
    const fk = this.fullKey(key);
    const entry = this.data.get(fk);
    if (entry?.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    this.data.delete(fk);
  }
}

// ---------------------------------------------------------------------------
// MemoryCounterStore
// ---------------------------------------------------------------------------

interface CounterEntry {
  count: number;
  timer?: ReturnType<typeof setTimeout>;
}

class MemoryCounterStore<K> implements CounterStore<K> {
  private readonly data = new Map<string, CounterEntry>();

  constructor(private readonly namespace: string) {}

  private fullKey(k: K, windowMs: number): string {
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    return `${this.namespace}:${serializeKey(k)}:${windowStart}`;
  }

  async incr(key: K, by: number, windowMs: number): Promise<number> {
    const fk = this.fullKey(key, windowMs);
    const existing = this.data.get(fk);

    if (existing !== undefined) {
      existing.count += Math.max(1, Math.round(by));
      return existing.count;
    }

    const entry: CounterEntry = { count: Math.max(1, Math.round(by)) };
    // Set TTL to evict after the window expires
    entry.timer = setTimeout(() => {
      this.data.delete(fk);
    }, windowMs);
    if (typeof entry.timer === "object" && "unref" in entry.timer) {
      (entry.timer as { unref(): void }).unref();
    }
    this.data.set(fk, entry);
    return entry.count;
  }
}

// ---------------------------------------------------------------------------
// MemoryStoreFactory
// ---------------------------------------------------------------------------

/**
 * Factory producing namespace-isolated in-memory stores.
 * Intended for development and testing only — not production.
 */
export class MemoryStoreFactory implements StoreFactory {
  keyValue<K, V>(namespace: string): Store<K, V> {
    return new MemoryStore<K, V>(namespace);
  }

  counter<K>(namespace: string): CounterStore<K> {
    return new MemoryCounterStore<K>(namespace);
  }

  backing(): "memory" {
    return "memory";
  }
}
