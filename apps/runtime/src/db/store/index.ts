// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Store-Abstraktion — Barrel Export
 *
 * Re-exports all store interfaces and backing implementations so consumers can
 * import from `@/db/store` (or the relative path) without reaching into sub-files.
 */
export type { Store, CounterStore, StoreFactory } from "./store.js";
export {
  RedisStoreFactory,
  type RedisStoreFactoryOptions,
} from "./redis-store.js";
export {
  PostgresStoreFactory,
  type PostgresStoreFactoryOptions,
  resetPostgresStoreInit,
} from "./postgres-store.js";
export { MemoryStoreFactory } from "./memory-store.js";
