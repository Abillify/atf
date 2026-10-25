// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * migrations.ts
 *
 * Schema migration framework for vectorsearch.
 *
 * Two migration tracks run independently:
 *
 *   Global migrations   — applied once per deployment to the shared system
 *                         tables (vs_migrations, vs_ingest_stats,
 *                         vs_search_stats, vs_collection_config).
 *                         Tracked in vs_migrations by a numeric version.
 *
 *   Collection migrations — applied per collection table when its stored
 *                           schema_version in vs_collection_config is behind
 *                           CURRENT_SCHEMA_VERSION.  Each migration step
 *                           receives the table name and the CollectionMeta
 *                           snapshot at that point so it can issue safe
 *                           ALTER TABLE / CREATE INDEX statements.
 *
 * Safety guarantees
 * ─────────────────
 * - A PostgreSQL advisory lock (pg_advisory_xact_lock) serialises
 *   concurrent migration attempts across multiple app instances.
 *   Only one instance runs migrations at a time; the others skip silently
 *   once they acquire the lock and find the versions are already current.
 *   Each step (and the bootstrap) additionally takes the shared schema-DDL
 *   transaction lock (collection-ddl.ts `lockSchemaDdl`), which every lazy
 *   ensure path also takes, so migrations never race lazy DDL.
 * - Every migration step runs inside its own transaction.  A failed step
 *   rolls back cleanly and throws, aborting startup so the problem is
 *   visible immediately rather than leaving the schema in a partial state.
 * - Adding a new migration: increment CURRENT_SCHEMA_VERSION in
 *   collection-ddl.ts and add a matching entry to COLLECTION_MIGRATIONS
 *   (or GLOBAL_MIGRATIONS for system-table changes).
 *
 * How to add a migration
 * ──────────────────────
 * Global schema change (e.g. new column on vs_search_stats):
 *   1. Bump GLOBAL_SCHEMA_VERSION by 1.
 *   2. Add a MigrationStep to GLOBAL_MIGRATIONS with the new version number.
 *
 * Per-collection change (e.g. new index on every vc_* table):
 *   1. Bump CURRENT_SCHEMA_VERSION in collection-ddl.ts by 1.
 *   2. Add a CollectionMigrationStep to COLLECTION_MIGRATIONS with the new
 *      version number.
 *
 * Example collection migration step:
 *
 *   {
 *     toVersion: 6,
 *     description: "Add version_tag column",
 *     up: async (client, table, _meta) => {
 *       await client.query(`
 *         ALTER TABLE "${table}"
 *           ADD COLUMN IF NOT EXISTS version_tag TEXT
 *       `);
 *     },
 *   }
 */

import type { Pool, PoolClient } from "pg";
import type pino from "pino";
import type { CollectionMeta, CollectionDDLConfig } from "./collection-ddl.js";
import {
  CURRENT_SCHEMA_VERSION,
  ensureCollectionConfigTable,
  ensureIdentifiersTable,
  ensureStatsTables,
  ensureUnitColumns,
  loadCollectionMeta,
  lockSchemaDdl,
  saveCollectionMeta,
  withSchemaDdlLock,
} from "./collection-ddl.js";
import { ensureAssetsTable, ensureRevisionSchema } from "./revision-schema.js";

// ─── Advisory lock key ────────────────────────────────────────────────────────

/**
 * Stable numeric key for the global migration advisory lock.
 * Must not collide with the per-table DDL lock keys used in collection-ddl.ts
 * (those use hashtext('vc_ddl:<table>') which is per-table and ephemeral).
 * We use a fixed well-known value instead.
 */
const MIGRATION_LOCK_KEY = 0x766d6967n; // "vmig" in ASCII, as bigint
const MIGRATION_LOCK_TIMEOUT = "30s";
const MIGRATION_STATEMENT_TIMEOUT = "30min";

// ─── Migration log table ──────────────────────────────────────────────────────

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vs_migrations (
      id           BIGSERIAL    PRIMARY KEY,
      track        TEXT         NOT NULL,
      version      INTEGER      NOT NULL,
      description  TEXT         NOT NULL,
      applied_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      duration_ms  INTEGER      NOT NULL,
      UNIQUE (track, version)
    )
  `);
}

async function getAppliedVersion(
  client: PoolClient,
  track: string,
): Promise<number> {
  const res = await client.query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) AS version
     FROM vs_migrations
     WHERE track = $1`,
    [track],
  );
  return res.rows[0]?.version ?? 0;
}

async function recordMigration(
  client: PoolClient,
  track: string,
  version: number,
  description: string,
  durationMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO vs_migrations (track, version, description, duration_ms)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (track, version) DO NOTHING`,
    [track, version, description, durationMs],
  );
}

// ─── Global migration track ───────────────────────────────────────────────────

/**
 * Current version of the global (system-table) schema.
 * Increment when adding a step to GLOBAL_MIGRATIONS.
 */
export const GLOBAL_SCHEMA_VERSION = 9;

interface MigrationStep {
  toVersion: number;
  description: string;
  up: (client: PoolClient) => Promise<void>;
}

/**
 * Global migration steps — applied once to the whole database.
 * Each step is responsible for exactly one schema change.
 * Steps are applied in ascending toVersion order.
 *
 * ── Add new global steps here ──────────────────────────────────────────────
 */
export const GLOBAL_MIGRATIONS: MigrationStep[] = [
  {
    toVersion: 1,
    description: "Baseline: create vs_migrations tracking table",
    up: async (_client) => {
      // The table is already created by ensureMigrationsTable() before
      // migrations run — this step just records the baseline in the log.
    },
  },
  {
    toVersion: 2,
    description: "Add collection group ACL and index provenance columns",
    up: async (client) => {
      await client.query(`
        ALTER TABLE vs_collection_config
          ADD COLUMN IF NOT EXISTS allowed_groups TEXT[] NOT NULL DEFAULT '{}',
          ADD COLUMN IF NOT EXISTS embedding_model TEXT,
          ADD COLUMN IF NOT EXISTS embedding_model_revision TEXT,
          ADD COLUMN IF NOT EXISTS index_build_version TEXT,
          ADD COLUMN IF NOT EXISTS index_algorithm TEXT,
          ADD COLUMN IF NOT EXISTS index_parameters JSONB
      `);
    },
  },
  {
    toVersion: 3,
    description: "Add fail-closed tenant isolation to statistics tables",
    up: async (client) => {
      // Stats reads are available immediately after startup, before the lazy
      // buffer performs its first flush. Harden the tables synchronously so a
      // tenant-filtered /ui/admin/stats request can never race legacy DDL.
      await ensureStatsTables(client);
    },
  },
  {
    toVersion: 4,
    description: "Add tenant-isolated original document assets",
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS vs_document_assets (
          tenant_id TEXT NOT NULL,
          collection TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          document_reference TEXT NOT NULL,
          figure_id TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          data BYTEA NOT NULL,
          checksum TEXT,
          created TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (tenant_id, collection, asset_id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_vs_document_assets_document ON vs_document_assets(tenant_id, collection, document_reference)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_vs_document_assets_figure ON vs_document_assets(tenant_id, collection, document_reference, figure_id)`,
      );
    },
  },
  {
    toVersion: 5,
    description:
      "Add v2 ingest staging (vs_revisions, vs_ingest_batches, vs_segments, vs_document_revisions) and vs_assets with a vs_document_assets backfill",
    up: async (client) => {
      // Creates the revision/staging/pointer tables and vs_assets, then copies
      // existing vs_document_assets rows over (kind='figure', null revision_id)
      // so figure assets keep resolving after the cutover. All additive and
      // idempotent; the backfill is a no-op on fresh deployments.
      await ensureRevisionSchema(client);
    },
  },
  {
    toVersion: 6,
    description:
      "Add shared identifier occurrence index (vs_identifiers) for the third RRF list",
    up: async (client) => {
      // A GLOBAL system table like vs_document_assets: one table holds every
      // collection's identifiers, keyed by (tenant_id, collection, value_norm,
      // unit_id, page). Additive and idempotent; a no-op on redeploy.
      await ensureIdentifiersTable(client);
    },
  },
  {
    toVersion: 7,
    description:
      "Reconcile v2 system tables (vs_revisions, vs_ingest_batches, vs_segments, vs_document_revisions, vs_assets, vs_identifiers) eagerly at startup",
    up: async (client) => {
      // The search read path (buildTemporalFilterSql's current-revision
      // pointer) references vs_document_revisions for every collection query,
      // so the v2 system tables must exist before the first request — not only
      // after the revision store lazily created them. Deployments that ran v5
      // before later columns/indexes were added are brought current here too.
      // Runs inside the step transaction that already holds the schema-DDL
      // lock (the ensure helpers join it re-entrantly); every statement is
      // idempotent, so this is a no-op on redeploy.
      await ensureRevisionSchema(client);
      await ensureAssetsTable(client);
      await ensureIdentifiersTable(client);
    },
  },
  {
    toVersion: 8,
    description:
      "Add document identity tables (vs_document_sources, vs_mail_messages, vs_document_groups) and vs_revisions.source_id/document_info for dedup, version order and e-mail threads",
    up: async (client) => {
      // All additive (CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) and a
      // no-op on redeploy; the same DDL runs from the revision schema's lazy
      // ensure, so a deployment that skips this step is still brought current.
      await ensureRevisionSchema(client);
    },
  },
  {
    toVersion: 9,
    description:
      "Add vs_search_stats.query_hash (HMAC/SHA-256) and minimise the legacy query column: backfill already-hashed rows, drop the NOT NULL constraint, and clear remaining legacy rows that may still carry raw query text",
    up: async (client) => {
      // Requirement 2.6: query statistics are keyed by query_hash from now on;
      // the raw query column is only written when STATS_STORE_RAW_QUERY=true
      // and is therefore nullable. Rows written by older versions already
      // stored a plain SHA-256 in `query` — those move to query_hash and have
      // their query nulled. Any row whose `query` is NOT a 64-char hex digest
      // predates the hashing and may contain raw personal data, so it is
      // deleted outright (data minimisation: legacy rows are cleared).
      await client.query(`
        ALTER TABLE vs_search_stats
          ADD COLUMN IF NOT EXISTS query_hash TEXT
      `);
      // Raw storage is opt-in from now on, so the column must accept NULL.
      // DROP NOT NULL must come BEFORE the backfill: the UPDATE below nulls
      // `query`, which a legacy NOT NULL column would reject.
      await client.query(`
        ALTER TABLE vs_search_stats ALTER COLUMN query DROP NOT NULL
      `);
      await client.query(`
        UPDATE vs_search_stats
          SET query_hash = query, query = NULL
        WHERE query_hash IS NULL AND query ~ '^[0-9a-f]{64}$'
      `);
      await client.query(`
        DELETE FROM vs_search_stats WHERE query_hash IS NULL
      `);
    },
  },

  // Example of a future global migration:
  //
  // {
  //   toVersion: 2,
  //   description: "Add executor column to vs_migrations",
  //   up: async (client) => {
  //     await client.query(`
  //       ALTER TABLE vs_migrations
  //         ADD COLUMN IF NOT EXISTS executor TEXT
  //     `);
  //   },
  // },
];

// ─── Collection migration track ───────────────────────────────────────────────

interface CollectionMigrationStep {
  toVersion: number;
  description: string;
  /**
   * Apply the migration to a single collection table.
   * Runs inside a transaction — throw to trigger rollback.
   *
   * @param client  - Active pool client (transaction already open)
   * @param table   - Quoted-safe table name, e.g. "vc_documents"
   * @param meta    - CollectionMeta at the time this step runs
   * @param ddlConfig - Server-level DDL config (vecType, hnswM, …)
   */
  up: (
    client: PoolClient,
    table: string,
    meta: CollectionMeta,
    ddlConfig: CollectionDDLConfig,
  ) => Promise<void>;
}

function legacyTenantId(): string {
  return (
    process.env["DEFAULT_TENANT_ID"]?.trim() ||
    process.env["API_SERVICE_TENANT_ID"]?.trim() ||
    process.env["API_OIDC_DEFAULT_TENANT_ID"]?.trim() ||
    "default"
  );
}

/** Idempotently enforces the physical tenant invariant on a collection table. */
async function ensureCollectionTenantIsolation(
  client: PoolClient,
  table: string,
): Promise<void> {
  await client.query(
    `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS tenant_id TEXT`,
  );
  await client.query(
    `UPDATE "${table}" SET tenant_id = $1 WHERE tenant_id IS NULL`,
    [legacyTenantId()],
  );
  const unmapped = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM "${table}"
      WHERE tenant_id IS NULL OR btrim(tenant_id) = ''`,
  );
  if (unmapped.rows[0]?.count !== "0") {
    throw new Error(`Tenant migration left unmapped rows in ${table}`);
  }
  await client.query(
    `ALTER TABLE "${table}" ALTER COLUMN tenant_id SET NOT NULL`,
  );
  // Never retain a database default: every future write must carry the tenant
  // selected by the authenticated AccessScope.
  await client.query(
    `ALTER TABLE "${table}" ALTER COLUMN tenant_id DROP DEFAULT`,
  );
  await client.query(
    `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${table}_reference_key"`,
  );
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${table}_tenant_reference_key" ON "${table}"(tenant_id, reference)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS "${table}_tenant_idx" ON "${table}"(tenant_id)`,
  );
}

/**
 * Per-collection migration steps.
 * Applied to every collection whose stored schema_version is below toVersion.
 * Steps run in ascending toVersion order.
 *
 * ── Add new collection steps here ──────────────────────────────────────────
 */
export const COLLECTION_MIGRATIONS: CollectionMigrationStep[] = [
  // The initial schema (versions 1–5) was created by ensureCollectionDDL()
  // directly — no migration steps needed for existing tables at that baseline.
  {
    toVersion: 6,
    description:
      "Canonicalize reference/base_ref to Unicode NFC (fix NFD macOS keys)",
    up: async (client, table, _meta, _ddlConfig) => {
      // Documents ingested from a macOS filesystem carry NFD-decomposed keys
      // (e.g. "ä" as "a" + U+0308). Exact/prefix lookups now normalize their
      // args to NFC (see normalizeReference / normalizePathPrefix), so existing
      // rows must be rewritten to the same canonical form to match. NFC is
      // idempotent, so this is a no-op for rows already composed / ASCII-only.
      // The UNIQUE(reference) constraint could in theory reject a normalization
      // that collides two distinct rows onto one key — vanishingly unlikely
      // (a document is ingested in a single form), and a collision correctly
      // fails the migration loudly rather than silently corrupting data.
      await client.query(`
        UPDATE "${table}"
           SET reference = normalize(reference, NFC),
               base_ref  = normalize(base_ref, NFC)
         WHERE reference <> normalize(reference, NFC)
            OR base_ref  <> normalize(base_ref, NFC)
      `);
    },
  },
  {
    toVersion: 7,
    description: "Add fail-closed tenant isolation and migrate confirmed legacy tenant default",
    up: async (client, table) => {
      // Pre-existing rows are assigned once to the deployment owner's explicit
      // legacy tenant. New rows always carry the authenticated AccessScope.
      await ensureCollectionTenantIsolation(client, table);
    },
  },
  {
    toVersion: 8,
    description: "Add group ACL storage and safely replace the sparse HNSW index",
    up: async (client, table, meta, _ddlConfig) => {
      await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS allowed_groups TEXT[] NOT NULL DEFAULT '{}'`);
      await client.query(`CREATE INDEX IF NOT EXISTS "${table}_allowed_groups_gin_idx" ON "${table}" USING gin(allowed_groups)`);
      if (meta.sparseEnabled && meta.sparseVocabSize) {
        await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS sparse_vector sparsevec(${meta.sparseVocabSize})`);
        // Transactional replacement means readers see either the old complete
        // index or the corrected complete index, never a half-cut-over state.
        // Operators must still schedule this blocking rebuild for a maintenance window.
        await client.query(`DROP INDEX IF EXISTS "${table}_sparse_vector_idx"`);
        await client.query(`CREATE INDEX "${table}_sparse_vector_idx" ON "${table}" USING hnsw (sparse_vector sparsevec_ip_ops)`);
      }
      // This step rebuilds only the sparse index. Preserve global/dense index
      // provenance exactly as loaded; legacy unknown values must remain null.
    },
  },
  {
    toVersion: 9,
    description: "Reconcile physical tenant isolation for registered legacy collections",
    up: async (client, table) => {
      // Some deployments recorded schema v8 before their physical table had
      // received v7. Re-run the idempotent invariant instead of trusting only
      // the metadata version.
      await ensureCollectionTenantIsolation(client, table);
    },
  },
  {
    toVersion: 10,
    description: "Ensure safe canonical metadata JSONB indexing",
    up: async (client, table) => {
      // The migrator is deliberately transactional. A regular idempotent GIN
      // index is safe here; expression/concurrent indexes would either lock in
      // field-specific assumptions or be illegal inside this transaction.
      await client.query(`CREATE INDEX IF NOT EXISTS "${table}_metadata_gin_idx" ON "${table}" USING gin(metadata)`);
    },
  },
  {
    toVersion: 11,
    description: "Add temporal document-version validity",
    up: async (client, table) => {
      await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ`);
      await client.query(`CREATE INDEX IF NOT EXISTS "${table}_temporal_version_idx" ON "${table}"(tenant_id, base_ref, (COALESCE(valid_from, created)) DESC, created DESC, id DESC)`);
    },
  },
  {
    toVersion: 12,
    description: "Add v2 index-unit columns as real indexed columns",
    up: async (client, table) => {
      // Filter-relevant unit fields become real, indexed columns. All columns
      // are nullable/additive: legacy v1 rows — which carry no revision and no
      // unit shape — migrate forward untouched and keep matching existing
      // queries. Shared with ensureCollectionDDL so new and migrated tables
      // stay identical.
      await ensureUnitColumns(client, table);
    },
  },
  {
    toVersion: 13,
    description:
      "Add multi-level unit relationship columns (parent/prev/next, block_ids, figure_refs, table_id)",
    up: async (client, table) => {
      // The full multi-level unit builder links units into a graph:
      // parent_unit_id / prev_unit_id / next_unit_id let small-to-big expansion
      // walk parents and reading-order siblings; block_ids records provenance;
      // figure_refs attaches figures to a text hit; table_id groups a table's
      // row-group units. ensureUnitColumns adds these idempotently (and re-adds
      // the schema-12 columns as no-ops), so new and migrated tables stay
      // identical. All nullable/additive — legacy and schema-12 rows migrate
      // forward untouched.
      await ensureUnitColumns(client, table);
    },
  },
  {
    toVersion: 14,
    description: "Add identifier FTS vector (ts_ident) and its GIN index",
    up: async (client, table) => {
      // task 3.4 "Lexik und Bezeichner": ts_ident is a second FTS vector built
      // with the `simple` config so codes (WE-01/A, DIN EN 1090-2) tokenise
      // verbatim rather than German-stemmed (Requirement 12.1). ensureUnitColumns
      // adds it and its GIN index idempotently (and re-adds the earlier columns
      // as no-ops), so new and migrated tables stay identical. Nullable/additive:
      // legacy and schema-13 rows migrate forward untouched and search unchanged.
      await ensureUnitColumns(client, table);
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

export interface MigrationRunnerConfig {
  /** Server-level DDL config forwarded to collection migration steps. */
  ddlConfig: CollectionDDLConfig;
}

/**
 * Run all pending global and per-collection migrations.
 *
 * Called once at startup, after the database is reachable, before the HTTP
 * server accepts traffic.  Safe to call concurrently from multiple instances —
 * the advisory lock ensures only one instance executes migrations at a time.
 */
export async function runMigrations(
  pool: Pool,
  logger: pino.Logger,
  config: MigrationRunnerConfig,
): Promise<void> {
  const client = await pool.connect();
  try {
    // A blocked legacy table must fail the rollout with a clear error instead
    // of keeping every instance indefinitely behind the advisory lock.
    await client.query(`SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
    await client.query(
      `SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`,
    );

    // Acquire a session-level advisory lock so concurrent instances wait
    // rather than race.  pg_advisory_lock is released when the session ends
    // (i.e. when we call client.release()).
    await client.query(`SELECT pg_advisory_lock($1)`, [
      MIGRATION_LOCK_KEY.toString(),
    ]);
    logger.debug("Migration advisory lock acquired");

    try {
      // Bootstrap: ensure the migration log table and collection config table
      // exist before we do anything else. Runs under the shared schema-DDL
      // advisory lock (one transaction) so it cannot race a lazy ensure path
      // of another replica creating the same tables.
      await withSchemaDdlLock(client, async () => {
        await ensureMigrationsTable(client);
        await ensureCollectionConfigTable(client);
      });

      await runGlobalMigrations(client, logger);
      await runCollectionMigrations(client, logger, config.ddlConfig);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [
        MIGRATION_LOCK_KEY.toString(),
      ]);
      logger.debug("Migration advisory lock released");
    }
  } finally {
    client.release();
  }
}

// ─── Global migration runner ──────────────────────────────────────────────────

async function runGlobalMigrations(
  client: PoolClient,
  logger: pino.Logger,
): Promise<void> {
  const applied = await getAppliedVersion(client, "global");

  if (applied >= GLOBAL_SCHEMA_VERSION) {
    logger.debug(
      { version: applied },
      "Global schema up to date; no migrations needed",
    );
    return;
  }

  const pending = GLOBAL_MIGRATIONS.filter((m) => m.toVersion > applied).sort(
    (a, b) => a.toVersion - b.toVersion,
  );

  logger.info(
    { from: applied, to: GLOBAL_SCHEMA_VERSION, steps: pending.length },
    "Running global migrations",
  );

  for (const step of pending) {
    const start = Date.now();
    logger.info(
      { toVersion: step.toVersion, description: step.description },
      "Applying global migration",
    );

    await client.query("BEGIN");
    try {
      // Serialize against every lazy DDL path (collection-ddl.ts,
      // revision-schema.ts). Taken first in the step so the lock order is
      // always "schema-DDL lock, then table locks" and cannot deadlock.
      await lockSchemaDdl(client);
      await step.up(client);
      await recordMigration(
        client,
        "global",
        step.toVersion,
        step.description,
        Date.now() - start,
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(
        { err, toVersion: step.toVersion },
        "Global migration failed; aborting",
      );
      throw err;
    }

    logger.info(
      { toVersion: step.toVersion, durationMs: Date.now() - start },
      "Global migration applied",
    );
  }
}

// ─── Collection migration runner ──────────────────────────────────────────────

async function runCollectionMigrations(
  client: PoolClient,
  logger: pino.Logger,
  ddlConfig: CollectionDDLConfig,
): Promise<void> {
  if (COLLECTION_MIGRATIONS.length === 0) {
    logger.debug("No collection migration steps defined; skipping");
    return;
  }

  // Find all collections that are below the current schema version.
  const res = await client.query<{
    collection_table: string;
    schema_version: number;
  }>(
    `SELECT collection_table, schema_version
     FROM vs_collection_config
     WHERE schema_version < $1
     ORDER BY collection_table`,
    [CURRENT_SCHEMA_VERSION],
  );

  if (res.rows.length === 0) {
    logger.debug(
      { targetVersion: CURRENT_SCHEMA_VERSION },
      "All collections up to date; no collection migrations needed",
    );
    return;
  }

  logger.info(
    { collections: res.rows.length, targetVersion: CURRENT_SCHEMA_VERSION },
    "Running collection migrations",
  );

  for (const row of res.rows) {
    const table = row.collection_table;
    const fromVersion = row.schema_version;

    const pending = COLLECTION_MIGRATIONS.filter(
      (m) => m.toVersion > fromVersion,
    ).sort((a, b) => a.toVersion - b.toVersion);

    if (pending.length === 0) continue;

    logger.info(
      { table, from: fromVersion, to: CURRENT_SCHEMA_VERSION },
      "Migrating collection",
    );

    // Load current meta snapshot once per collection.
    const meta = await loadCollectionMeta(client, table);
    if (!meta) {
      logger.warn(
        { table },
        "Collection config row disappeared during migration; skipping",
      );
      continue;
    }

    for (const step of pending) {
      const start = Date.now();
      const track = `collection:${table}`;

      logger.info(
        { table, toVersion: step.toVersion, description: step.description },
        "Applying collection migration step",
      );

      await client.query("BEGIN");
      try {
        await lockSchemaDdl(client);
        await step.up(client, table, meta, ddlConfig);
        await saveCollectionMeta(client, table, meta, step.toVersion);
        await recordMigration(
          client,
          track,
          step.toVersion,
          step.description,
          Date.now() - start,
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        logger.error(
          { err, table, toVersion: step.toVersion },
          "Collection migration step failed; aborting",
        );
        throw err;
      }

      logger.info(
        {
          table,
          toVersion: step.toVersion,
          durationMs: Date.now() - start,
        },
        "Collection migration step applied",
      );
    }
  }

  logger.info(
    { collections: res.rows.length },
    "Collection migrations complete",
  );
}
