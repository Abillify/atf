// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Postgres-backed Store implementation (`src/db/store/postgres-store.ts`)
 *
 * Uses the project's `Database` interface (Bun's native SQL client). Key-value
 * operations use INSERT ON CONFLICT UPDATE with an `expires_at` column for TTL.
 * Counter uses an atomic UPSERT that increments within a fixed time window and
 * auto-expires stale entries (Requirement 2.4).
 *
 * The store automatically creates its backing tables on first use (idempotent
 * via `IF NOT EXISTS`). Expired entries are filtered at read time (lazy
 * eviction).
 *
 * No `any` at module boundaries.
 */

import type { Store, CounterStore, StoreFactory } from "./store.js";
import type { Database } from "../database.js";
import { safeSqlIdentifier } from "../sql-identifier.js";
import type { Logger } from "../../observability/logger.js";

// ---------------------------------------------------------------------------
// Key serialisation helper
// ---------------------------------------------------------------------------

function serializeKey(key: unknown): string {
  if (typeof key === "string") return key;
  return JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// Table initialisation (idempotent)
// ---------------------------------------------------------------------------

// Both names are internal constants interpolated into DDL/DML; they are
// validated through the central identifier whitelist (Req 7.10) so a future
// edit can never introduce an unsafe identifier. Fails fast at module load.
const KV_TABLE = safeSqlIdentifier("store_kv", "store KV table name");
const COUNTER_TABLE = safeSqlIdentifier(
  "store_counters",
  "store counter table name",
);

const CREATE_KV_TABLE = `
CREATE TABLE IF NOT EXISTS ${KV_TABLE} (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (namespace, key)
)`;

const CREATE_COUNTER_TABLE = `
CREATE TABLE IF NOT EXISTS ${COUNTER_TABLE} (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  count BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (namespace, key, window_start)
)`;

let tablesInitialized = false;

async function ensureTables(db: Database): Promise<void> {
  if (tablesInitialized) return;
  await db.query(CREATE_KV_TABLE);
  await db.query(CREATE_COUNTER_TABLE);
  tablesInitialized = true;
}

/** Reset the initialization flag (useful for tests). */
export function resetPostgresStoreInit(): void {
  tablesInitialized = false;
}

// ---------------------------------------------------------------------------
// PostgresStore (key-value)
// ---------------------------------------------------------------------------

class PostgresStore<K, V> implements Store<K, V> {
  constructor(
    private readonly db: Database,
    private readonly namespace: string,
  ) {}

  private fullKey(k: K): string {
    return `${this.namespace}:${serializeKey(k)}`;
  }

  async get(key: K): Promise<V | undefined> {
    const rows = await this.db.query<{ value: string }>(
      `SELECT value FROM ${KV_TABLE}
       WHERE namespace = $1 AND key = $2
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [this.namespace, this.fullKey(key)],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.value) as V;
    } catch {
      return undefined;
    }
  }

  async set(key: K, value: V, opts?: { ttlMs?: number }): Promise<void> {
    const serialized = JSON.stringify(value);
    const expiresAt =
      opts?.ttlMs !== undefined && opts.ttlMs > 0
        ? new Date(Date.now() + opts.ttlMs).toISOString()
        : null;
    await this.db.query(
      `INSERT INTO ${KV_TABLE} (namespace, key, value, expires_at)
       VALUES ($1, $2, $3, $4::timestamptz)
       ON CONFLICT (namespace, key)
       DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [this.namespace, this.fullKey(key), serialized, expiresAt],
    );
  }

  async delete(key: K): Promise<void> {
    await this.db.query(
      `DELETE FROM ${KV_TABLE} WHERE namespace = $1 AND key = $2`,
      [this.namespace, this.fullKey(key)],
    );
  }
}

// ---------------------------------------------------------------------------
// PostgresCounterStore
// ---------------------------------------------------------------------------

class PostgresCounterStore<K> implements CounterStore<K> {
  constructor(
    private readonly db: Database,
    private readonly namespace: string,
  ) {}

  private fullKey(k: K): string {
    return `${this.namespace}:${serializeKey(k)}`;
  }

  async incr(key: K, by: number, windowMs: number): Promise<number> {
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const expiresAt = new Date(windowStart + windowMs).toISOString();
    const fk = this.fullKey(key);

    // Atomic UPSERT: INSERT the counter or increment if the window bucket
    // already exists. Uses advisory lock on a hash of (namespace, key,
    // window_start) to serialise concurrent writers to the same bucket.
    const lockKey = hashForAdvisoryLock(this.namespace, fk, windowStart);

    const rows = await this.db.query<{ count: string | number }>(
      `SELECT pg_advisory_xact_lock($1);
       INSERT INTO ${COUNTER_TABLE} (namespace, key, window_start, count, expires_at)
       VALUES ($2, $3, $4, $5, $6::timestamptz)
       ON CONFLICT (namespace, key, window_start)
       DO UPDATE SET count = ${COUNTER_TABLE}.count + EXCLUDED.count
       RETURNING count`,
      [
        lockKey,
        this.namespace,
        fk,
        windowStart,
        Math.max(1, Math.round(by)),
        expiresAt,
      ],
    );

    if (rows.length === 0) return 0;
    const row = rows[0];
    if (row === undefined) return 0;
    const value = typeof row.count === "number" ? row.count : Number(row.count);
    return Number.isFinite(value) ? value : 0;
  }
}

/**
 * Produces a deterministic 32-bit integer for use as a Postgres advisory lock
 * key. Collisions are benign (they just serialise unrelated counters).
 */
function hashForAdvisoryLock(
  namespace: string,
  key: string,
  window: number,
): number {
  const str = `${namespace}:${key}:${window}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// PostgresStoreFactory
// ---------------------------------------------------------------------------

export interface PostgresStoreFactoryOptions {
  /** Database connection (project's `Database` interface). */
  db: Database;
  /** Optional logger. */
  logger?: Logger;
}

/**
 * Factory producing namespace-isolated Postgres-backed stores.
 * Automatically creates backing tables on first use (idempotent).
 */
export class PostgresStoreFactory implements StoreFactory {
  private readonly db: Database;
  private readonly logger?: Logger;
  private initPromise: Promise<void> | undefined;

  constructor(options: PostgresStoreFactoryOptions) {
    this.db = options.db;
    this.logger = options.logger;
  }

  private async init(): Promise<void> {
    if (this.initPromise === undefined) {
      this.initPromise = ensureTables(this.db).catch((err) => {
        this.logger?.warn(
          "PostgresStoreFactory: failed to create backing tables",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        // Allow retry on next access
        this.initPromise = undefined;
        throw err;
      });
    }
    return this.initPromise;
  }

  keyValue<K, V>(namespace: string): Store<K, V> {
    // Trigger table creation lazily but don't block construction.
    void this.init();
    return new PostgresStore<K, V>(this.db, namespace);
  }

  counter<K>(namespace: string): CounterStore<K> {
    void this.init();
    return new PostgresCounterStore<K>(this.db, namespace);
  }

  backing(): "postgres" {
    return "postgres";
  }
}
