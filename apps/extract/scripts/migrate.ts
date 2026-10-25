// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Standalone schema migration for the Extract database.
 *
 * Applies every pending migration of the `extract` schema under the same
 * session advisory lock the lazy store initialisation uses
 * (`src/persistence/extract-ddl.ts`), so running this while replicas boot is
 * safe — they serialise on the lock and the version check makes the losers a
 * no-op. The canonical production flow is a one-shot migration Job running
 * this command ahead of a rollout, with MIGRATE_ON_START=false on the
 * replicas.
 *
 *   bun run migrate                            # EXTRACT_DATABASE_URL from env
 *   EXTRACT_DATABASE_URL=... bun run migrate   # explicit connection string
 *
 * Only `EXTRACT_DATABASE_URL` is read — no vision model or Search
 * configuration — so a migration Job needs the database secret and nothing
 * else. Exit code 0 on success (including "already up to date"), 1 otherwise.
 */
import { Pool } from "pg";
import pino from "pino";
import { runExtractMigrations } from "../src/persistence/index.js";

const url = (process.env["EXTRACT_DATABASE_URL"] ?? "").trim();
if (url === "") {
  process.stderr.write("migrate: EXTRACT_DATABASE_URL is required\n");
  process.exit(1);
}

const logger = pino({
  level: process.env["LOG_LEVEL"] || "info",
  base: { pid: process.pid },
});

// max 1: the migrator pins a single connection for the advisory lock.
const pool = new Pool({ connectionString: url, max: 1 });
try {
  const version = await runExtractMigrations(pool, logger);
  logger.info({ schemaVersion: version }, "Extract schema migration finished");
} catch (err) {
  logger.error({ err }, "Extract schema migration failed");
  await pool.end().catch(() => undefined);
  process.exit(1);
}
await pool.end();
