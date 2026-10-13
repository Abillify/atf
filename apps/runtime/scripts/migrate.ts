// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Standalone schema migration for the Runtime database (requirement 12.4).
 *
 * Applies every pending migration under the same session advisory lock the
 * startup path uses (`src/db/migrator.ts`), so running this while replicas
 * boot is safe — they serialise on the lock and the version check makes the
 * losers a no-op. The canonical production flow is a one-shot migration Job
 * running this command ahead of a rollout, with MIGRATE_ON_START=false on the
 * replicas, instead of DDL on the boot path of every instance.
 *
 *   bun run migrate                     # DATABASE_URL from the environment
 *   DATABASE_URL=... bun run migrate    # explicit connection string
 *
 * Only the database variables are read — no flows, providers, or model
 * configuration — so a migration Job needs the database secret and nothing
 * else. Exit code 0 on success (including "already up to date"), 1 otherwise.
 */
import { createDatabase } from "../src/db/database.js";
import { runMigrations } from "../src/db/migrator.js";
import { createLogger, type LogLevel } from "../src/observability/logger.js";

function parseLogLevel(): LogLevel {
  const raw = (process.env["LOG_LEVEL"] ?? "info").trim();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error"
    ? raw
    : "info";
}

const url = (process.env["DATABASE_URL"] ?? "").trim();
if (url === "") {
  process.stderr.write("migrate: DATABASE_URL is required\n");
  process.exit(1);
}

const logger = createLogger(parseLogLevel());

try {
  // poolMax 1: the migrator pins a single connection for the advisory lock.
  const db = await createDatabase(url, logger, { poolMax: 1 });
  if (db === undefined) {
    process.stderr.write(
      "migrate: Bun's native SQL client is unavailable in this runtime\n",
    );
    process.exit(1);
  }
  try {
    const result = await runMigrations(db, logger);
    logger.info("Runtime schema migration finished", {
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      applied: result.applied,
    });
  } finally {
    await db.close();
  }
} catch (err) {
  logger.error("Runtime schema migration failed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}
