// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Automatic schema migrator (`src/db/migrator.ts`)
 *
 * On startup the migrator:
 *   1. Ensures the bookkeeping table `schema_migrations` exists.
 *   2. Reads the highest applied version (the "deployed schema version").
 *   3. Applies every migration with a greater version, in ascending order.
 *   4. Records each applied version so the step is idempotent across restarts
 *      and safe to run from every replica (a Postgres advisory lock serialises
 *      concurrent migrators so only one applies a given version).
 *
 * Migrations use idempotent DDL (`IF NOT EXISTS`), so a crash mid-migration is
 * recoverable by simply re-running.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "./database.js";
import type { Logger } from "./../observability/logger.js";
import {
  MIGRATIONS,
  LATEST_SCHEMA_VERSION,
  type Migration,
} from "./migrations.js";

/** Advisory lock key (arbitrary constant) so only one replica migrates at once. */
const MIGRATION_LOCK_KEY = 778_201_143;

export interface MigrationResult {
  /** Schema version before this run. */
  fromVersion: number;
  /** Schema version after this run. */
  toVersion: number;
  /** Versions applied during this run (empty when already up to date). */
  applied: number[];
}

async function ensureMigrationsTable(db: Database): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

async function getCurrentVersion(db: Database): Promise<number> {
  const rows = await db.query<{ version: number | string | null }>(
    "SELECT max(version) AS version FROM schema_migrations",
  );
  const raw = rows[0]?.version;
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

async function applyMigration(
  db: Database,
  migration: Migration,
): Promise<void> {
  await db.query("BEGIN");
  try {
    for (const statement of migration.statements) {
      await db.query(statement);
    }
    await db.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
      [migration.version, migration.name],
    );
    await db.query("COMMIT");
  } catch (err) {
    try {
      await db.query("ROLLBACK");
    } catch {
      /* ignore rollback error if connection lost/failed */
    }
    throw err;
  }
}

/**
 * Brings the database schema up to {@link LATEST_SCHEMA_VERSION}. Returns a
 * summary of what was applied. Safe to call on every boot and from every
 * replica concurrently.
 */
export async function runMigrations(
  db: Database,
  logger?: Logger,
): Promise<MigrationResult> {
  const withConnection = db.withConnection?.bind(db) ?? ((cb) => cb(db));
  return withConnection(async (connection) => {
    // Serialise concurrent migrators across replicas with a session advisory lock.
    await connection.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      await ensureMigrationsTable(connection);
      const fromVersion = await getCurrentVersion(connection);

      const pending = [...MIGRATIONS]
        .filter((m) => m.version > fromVersion)
        .sort((a, b) => a.version - b.version);

      const applied: number[] = [];
      for (const migration of pending) {
        logger?.info("Applying schema migration", {
          version: migration.version,
          name: migration.name,
        });
        await applyMigration(connection, migration);
        applied.push(migration.version);
      }

      const toVersion = await getCurrentVersion(connection);
      if (applied.length === 0) {
        logger?.info("Database schema up to date", { version: toVersion });
      } else {
        logger?.info("Database schema migrated", {
          fromVersion,
          toVersion,
          applied,
        });
      }
      return { fromVersion, toVersion, applied };
    } finally {
      try {
        await connection.query("SELECT pg_advisory_unlock($1)", [
          MIGRATION_LOCK_KEY,
        ]);
      } catch {
        /* best-effort unlock — the session lock is released on disconnect anyway */
      }
    }
  });
}

export { LATEST_SCHEMA_VERSION };
