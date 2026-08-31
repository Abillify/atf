// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Store abstraction (`src/db/store/store.ts`)
 *
 * Shared interface module for recurring store access logic (rate limit,
 * semaphore, approval log, monitoring history, semantic cache). All existing
 * ad-hoc store call sites are migrated onto this abstraction, so that no
 * duplicated store pattern remains in more than one file (Requirement 1.3).
 *
 * ## Namespacing convention
 *
 * Every store created via `StoreFactory.keyValue(namespace)` or
 * `.counter(namespace)` uses the `namespace` string as key prefix to guarantee
 * logical separation within the same backing store.
 *
 * Format: `<namespace>:<serialized_key>`
 *
 * Examples:
 *   - `rate-limit:tenant:abc:endpoint:/v1/chat`
 *   - `semaphore:flow:my-flow`
 *   - `semantic-cache:hash:sha256-abc123`
 *
 * The namespace is fixed once when the store handle is created and is immutable
 * afterwards. All operations (`get`, `set`, `delete`, `incr`) add the namespace
 * as a prefix automatically — callers work exclusively with the logical key.
 *
 * ## TTL semantics
 *
 * - `opts.ttlMs` in `Store.set()` specifies the time-to-live in milliseconds.
 * - Once the TTL has elapsed the entry is treated as non-existent: `get()`
 *   returns `undefined`, as if the key had never been set.
 * - Without an explicit TTL (`ttlMs` is `undefined`) the entry is stored
 *   **without expiry** — it persists until it is explicitly deleted.
 * - The exact deletion strategy (eager/lazy) is implementation-dependent:
 *   Redis uses native key expiration; Postgres uses an `expires_at` timestamp
 *   and filters expired entries on reads; memory uses `setTimeout`-based
 *   eviction.
 *
 * - `CounterStore.incr(key, by, windowMs)` behaves atomically:
 *   - `windowMs` defines the sliding/fixed window the counter lives in.
 *   - When a counter is incremented for the first time within a window, the
 *     window TTL starts at that point in time.
 *   - Once the window has elapsed the counter is reset to 0 (the key expires).
 *     A subsequent `incr` starts a new window.
 *   - The operation is atomic: concurrent increments on the same key and window
 *     yield consistent, cluster-wide totals.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Generic key-value store with optional TTL support.
 *
 * @typeParam K - Type of the key (serialized internally)
 * @typeParam V - Type of the value (serialized/deserialized internally)
 */
export interface Store<K, V> {
  /**
   * Reads the value for `key`. Returns `undefined` if the key does not exist or
   * its TTL has elapsed.
   */
  get(key: K): Promise<V | undefined>;

  /**
   * Sets the value for `key`. If the key already exists it is overwritten.
   *
   * @param opts.ttlMs - Time-to-live in milliseconds. If omitted, the entry is
   *   stored permanently (no expiry).
   */
  set(key: K, value: V, opts?: { ttlMs?: number }): Promise<void>;

  /**
   * Deletes the entry for `key`. If the key is absent, the operation is a
   * no-op.
   */
  delete(key: K): Promise<void>;
}

/**
 * Atomic counter store with window-based TTL.
 *
 * @typeParam K - Type of the counter key
 */
export interface CounterStore<K> {
  /**
   * Increments the counter for `key` by `by` within a time window of
   * `windowMs` milliseconds. Returns the new total after the increment.
   *
   * The operation is atomic — no increment is lost even under concurrent calls
   * across multiple replicas (cluster-wide consistent).
   *
   * @param key - Logical counter key
   * @param by - Value to increment by (positive)
   * @param windowMs - Time window in ms; the counter is reset once it elapses
   * @returns The new counter value after the increment
   */
  incr(key: K, by: number, windowMs: number): Promise<number>;
}

/**
 * Factory for namespace-isolated store instances. The backing is selected
 * centrally in `bootstrap/persistence.ts` / `bootstrap/cache.ts`.
 */
export interface StoreFactory {
  /**
   * Creates a key-value store under the given namespace.
   * All keys are automatically prefixed with `<namespace>:`.
   */
  keyValue<K, V>(namespace: string): Store<K, V>;

  /**
   * Creates a counter store under the given namespace.
   * All keys are automatically prefixed with `<namespace>:`.
   */
  counter<K>(namespace: string): CounterStore<K>;

  /**
   * Returns the active backing. Checked by the prod gate among others:
   * in production the backing MUST be `"redis"` or `"postgres"`;
   * `"memory"` is only allowed in non-production environments.
   */
  backing(): "redis" | "postgres" | "memory";
}
