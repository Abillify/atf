// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Standalone schema migration for the Search database (requirement 12.4).
 *
 * Applies every pending global and per-collection migration under the same
 * session advisory lock the startup path uses (`src/migrations.ts`), so
 * running this while replicas boot is safe — they serialise on the lock. The
 * canonical production flow is a one-shot migration Job running this command
 * ahead of a rollout, with MIGRATE_ON_START=false on the replicas.
 *
 *   bun run migrate                     # POSTGRES_URL from the environment
 *   POSTGRES_URL=... bun run migrate    # explicit connection string
 *
 * Only the DDL-relevant variables are read — `POSTGRES_URL` plus the index
 * shaping knobs that collection migrations embed into their DDL
 * (`VECTOR_HALF_PRECISION`, `HNSW_M`, `HNSW_EF_CONSTRUCTION`, with the same
 * defaults as `src/config.ts`) — so a migration Job needs the database secret
 * and nothing else; no embedding endpoint or auth configuration is required.
 * Exit code 0 on success (including "already up to date"), 1 otherwise.
 */
import { Pool } from "pg";
import { pino } from "pino";
import { runMigrations } from "../src/migrations.js";

function parseBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    process.stderr.write(`migrate: ${name} must be a positive integer\n`);
    process.exit(1);
  }
  return parsed;
}

const postgresUrl = (process.env["POSTGRES_URL"] ?? "").trim();
if (postgresUrl === "") {
  process.stderr.write("migrate: POSTGRES_URL is required\n");
  process.exit(1);
}

const logger = pino({
  level: process.env["LOG_LEVEL"] || "info",
  base: { pid: process.pid },
});

const halfPrecision = parseBool("VECTOR_HALF_PRECISION", false);

// max 1: the migrator pins a single connection for the advisory lock.
const pool = new Pool({ connectionString: postgresUrl, max: 1 });
try {
  await runMigrations(pool, logger, {
    ddlConfig: {
      vecType: halfPrecision ? "halfvec" : "vector",
      cosineOps: halfPrecision ? "halfvec_cosine_ops" : "vector_cosine_ops",
      hnswM: parseIntEnv("HNSW_M", 16),
      efConstruction: parseIntEnv("HNSW_EF_CONSTRUCTION", 128),
    },
  });
  logger.info("Search schema migration finished");
} catch (err) {
  logger.error({ err }, "Search schema migration failed");
  await pool.end().catch(() => undefined);
  process.exit(1);
}
await pool.end();
