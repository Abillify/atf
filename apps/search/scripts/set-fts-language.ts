// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Switches an existing collection's full-text search language and recomputes
 * its stored `ts_search` vectors (Requirement 2.6), e.g. from the old default
 * `simple` (no stemming) to `german`:
 *
 *   bun run fts:language <collection> <language>
 *   bun run fts:language docs german
 *   FTS_EXTRA_LANGUAGES=german_compound bun run fts:language docs german_compound
 *
 * FTS_LANGUAGE only applies to collections created after it was set; this is
 * the path for the ones that already exist. The recompute is one set-based
 * UPDATE, so run it outside peak hours on large collections. An operator
 * configuration (FTS_EXTRA_LANGUAGES) must exist in `pg_ts_config`.
 * Exit code 0 on success (including "already in that language"), 1 otherwise.
 */
import { Pool } from "pg";
import { pino } from "pino";
import { createPostgresClient } from "../src/postgres-client.js";
import { FTS_CONFIG_NAME_RE, registerFtsLanguages } from "../src/collection-ddl.js";

const [collection, language] = process.argv.slice(2);
if (collection === undefined || language === undefined) {
  process.stderr.write("usage: bun run fts:language <collection> <language>\n");
  process.exit(1);
}
const postgresUrl = (process.env["POSTGRES_URL"] ?? "").trim();
if (postgresUrl === "") {
  process.stderr.write("fts:language: POSTGRES_URL is required\n");
  process.exit(1);
}

const logger = pino({ level: process.env["LOG_LEVEL"] || "info" });

const extra = (process.env["FTS_EXTRA_LANGUAGES"] ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);
if (extra.some((name) => !FTS_CONFIG_NAME_RE.test(name))) {
  process.stderr.write("fts:language: FTS_EXTRA_LANGUAGES holds an invalid name\n");
  process.exit(1);
}
if (extra.length > 0) {
  const pool = new Pool({ connectionString: postgresUrl, max: 1 });
  try {
    const { rows } = await pool.query<{ cfgname: string }>(
      "SELECT cfgname FROM pg_ts_config WHERE cfgname = ANY($1::text[])",
      [extra],
    );
    const present = new Set(rows.map((r) => r.cfgname));
    const missing = extra.filter((n) => !present.has(n));
    if (missing.length > 0) {
      process.stderr.write(`fts:language: not installed in PostgreSQL: ${missing.join(", ")}\n`);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
  registerFtsLanguages(extra);
}

const client = createPostgresClient({ connectionString: postgresUrl, logger, poolMax: 1 });
try {
  const result = await client.recomputeFtsLanguage(collection, language);
  if (!result.ok) {
    logger.error({ code: result.error.code }, result.error.message);
    process.exitCode = 1;
  } else if (result.result.unchanged) {
    logger.info({ collection, language }, "Collection already uses this language");
  } else {
    logger.info({ collection, language, updated: result.result.updated }, "FTS language switched");
  }
} finally {
  await client.close();
}
