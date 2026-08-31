// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * collection-ddl.ts
 *
 * DDL helpers for per-collection tables and the global config/stats tables.
 * Extracted from postgres-client.ts to keep that file focused on query logic.
 */

import type { PoolClient } from "pg";
import type { SparseVector } from "./sparse-embedding-client.js";
import { toBinaryString } from "./vector-utils.js";
import { sparseVectorToPg } from "./sparse-embedding-client.js";

// ─── Typed application error ──────────────────────────────────────────────────

/**
 * AppError is a typed Error subclass that carries an application-level error
 * code.  Using a proper class instead of mutating a plain Error with `.code`
 * makes instanceof checks type-safe and removes the need for NodeJS.ErrnoException
 * casts throughout the codebase.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ─── Collection name validation ───────────────────────────────────────────────

const COLLECTION_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Prefix for user collection tables.
 * Using "vc_" (vector collection) to avoid conflicts with internal "vs_" tables
 * (vs_ingest_stats, vs_search_stats, vs_collection_config).
 */
export const COLLECTION_TABLE_PREFIX = "vc_";

/** Allowed PostgreSQL FTS configuration names. Validated before embedding in SQL. */
const ALLOWED_FTS_LANGUAGES = new Set([
  "simple",
  "english",
  "german",
  "french",
  "spanish",
  "italian",
  "portuguese",
  "dutch",
  "swedish",
  "norwegian",
  "danish",
  "finnish",
  "russian",
  "arabic",
  "turkish",
  "hungarian",
  "romanian",
]);

export function validateFtsLanguage(lang: string): string {
  const lower = lang.trim().toLowerCase();
  if (!ALLOWED_FTS_LANGUAGES.has(lower)) {
    throw new AppError(
      "UNSUPPORTED_FTS_LANGUAGE",
      `Unsupported FTS language "${lang}". Allowed: ${[...ALLOWED_FTS_LANGUAGES].join(", ")}`,
    );
  }
  return lower;
}

export function collectionTableName(collection: string): string {
  if (!COLLECTION_NAME_RE.test(collection)) {
    throw new AppError(
      "INVALID_COLLECTION_NAME",
      `Invalid collection name "${collection}": must start with a letter and contain only letters (a-z, A-Z), digits (0-9), and underscores`,
    );
  }
  return `${COLLECTION_TABLE_PREFIX}${collection}`;
}

// ─── Per-collection config cached in memory ───────────────────────────────────

export interface CollectionMeta {
  language: string;
  sparseEnabled: boolean;
  sparseVocabSize: number | null;
  /** Quantization scheme applied to this collection's vectors. */
  quantization: "none" | "binary";
  /** Embedding dimension; required for binary bit(n) casts. */
  vectorSize: number | null;
  /** Additive provenance fields; null means a legacy collection has no recorded value. */
  embeddingModel?: string | null;
  embeddingModelRevision?: string | null;
  indexBuildVersion?: string | null;
  indexAlgorithm?: string | null;
  indexParameters?: Record<string, number> | null;
  /**
   * Collection-level ACL: users allowed to access this collection. Empty =
   * public (no restriction). Mirrors the per-row allowed_users but gates the
   * whole collection. Managed via setCollectionAcl, never by saveCollectionMeta.
   */
  allowedUsers?: string[];
  /** Collection-level ACL: groups allowed to access this collection. Empty = public. */
  allowedGroups?: string[];
}

// ─── Stats tables DDL ─────────────────────────────────────────────────────────

export async function ensureStatsTables(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vs_ingest_stats (
      id               BIGSERIAL PRIMARY KEY,
      tenant_id        TEXT NOT NULL,
      collection       TEXT NOT NULL,
      operation        TEXT NOT NULL,
      reference        TEXT NOT NULL,
      timestamp        TIMESTAMPTZ DEFAULT NOW(),
      duration_ms      INTEGER NOT NULL,
      chunks_processed INTEGER NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_ingest_stats_col_ts
      ON vs_ingest_stats(collection, timestamp DESC)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS vs_search_stats (
      id            BIGSERIAL PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      collection    TEXT NOT NULL,
      query         TEXT NOT NULL,
      timestamp     TIMESTAMPTZ DEFAULT NOW(),
      duration_ms   INTEGER NOT NULL,
      results_count INTEGER NOT NULL,
      hybrid_search BOOLEAN NOT NULL,
      reranked      BOOLEAN NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_search_stats_col_ts
      ON vs_search_stats(collection, timestamp DESC)
  `);
  // Legacy statistics cannot be assigned to a tenant safely. They are
  // best-effort telemetry, so discard only unmapped rows before hardening both
  // schemas rather than exposing them through DEFAULT_TENANT_ID.
  await client.query(`ALTER TABLE vs_ingest_stats ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
  await client.query(`ALTER TABLE vs_search_stats ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
  await client.query(`DELETE FROM vs_ingest_stats WHERE tenant_id IS NULL OR btrim(tenant_id) = ''`);
  await client.query(`DELETE FROM vs_search_stats WHERE tenant_id IS NULL OR btrim(tenant_id) = ''`);
  await client.query(`ALTER TABLE vs_ingest_stats ALTER COLUMN tenant_id SET NOT NULL`);
  await client.query(`ALTER TABLE vs_search_stats ALTER COLUMN tenant_id SET NOT NULL`);
  // Future writes must always supply the authenticated tenant explicitly. A
  // legacy database default would silently collapse omitted tenants together.
  await client.query(`ALTER TABLE vs_ingest_stats ALTER COLUMN tenant_id DROP DEFAULT`);
  await client.query(`ALTER TABLE vs_search_stats ALTER COLUMN tenant_id DROP DEFAULT`);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_ingest_stats_tenant_ts
      ON vs_ingest_stats(tenant_id, timestamp DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_search_stats_tenant_ts
      ON vs_search_stats(tenant_id, timestamp DESC)
  `);
}

// ─── Collection config table DDL ──────────────────────────────────────────────

export async function ensureCollectionConfigTable(
  client: PoolClient,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vs_collection_config (
      collection_table  TEXT PRIMARY KEY,
      schema_version    INTEGER NOT NULL DEFAULT 0,
      fts_language      TEXT    NOT NULL DEFAULT 'simple',
      sparse_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
      sparse_vocab_size INTEGER,
      quantization      TEXT    NOT NULL DEFAULT 'none',
      vector_size       INTEGER,
      allowed_users     TEXT[]  NOT NULL DEFAULT '{}',
      allowed_groups    TEXT[]  NOT NULL DEFAULT '{}',
      created           TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      embedding_model   TEXT,
      embedding_model_revision TEXT,
      index_build_version TEXT,
      index_algorithm   TEXT,
      index_parameters  JSONB
    )
  `);
  // Backfill columns for deployments whose config table predates collection-level ACLs.
  await client.query(
    `ALTER TABLE vs_collection_config
       ADD COLUMN IF NOT EXISTS allowed_users TEXT[] NOT NULL DEFAULT '{}'`,
  );
  await client.query(
    `ALTER TABLE vs_collection_config
       ADD COLUMN IF NOT EXISTS allowed_groups TEXT[] NOT NULL DEFAULT '{}'`,
  );
  await client.query(
    `ALTER TABLE vs_collection_config ADD COLUMN IF NOT EXISTS embedding_model TEXT, ADD COLUMN IF NOT EXISTS embedding_model_revision TEXT, ADD COLUMN IF NOT EXISTS index_build_version TEXT, ADD COLUMN IF NOT EXISTS index_algorithm TEXT, ADD COLUMN IF NOT EXISTS index_parameters JSONB`,
  );
}

export async function loadCollectionMeta(
  client: PoolClient,
  table: string,
): Promise<CollectionMeta | null> {
  const res = await client.query<{
    fts_language: string;
    sparse_enabled: boolean;
    sparse_vocab_size: number | null;
    quantization: string;
    vector_size: number | null;
    allowed_users: string[] | null;
    allowed_groups: string[] | null;
    embedding_model: string | null;
    embedding_model_revision: string | null;
    index_build_version: string | null;
    index_algorithm: string | null;
    index_parameters: Record<string, number> | null;
  }>(
    `SELECT fts_language, sparse_enabled, sparse_vocab_size, quantization, vector_size,
            allowed_users, allowed_groups, embedding_model, embedding_model_revision,
            index_build_version, index_algorithm, index_parameters
     FROM vs_collection_config WHERE collection_table = $1`,
    [table],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0]!;
  return {
    language: row.fts_language,
    sparseEnabled: row.sparse_enabled,
    sparseVocabSize: row.sparse_vocab_size,
    quantization: row.quantization === "binary" ? "binary" : "none",
    vectorSize: row.vector_size,
    allowedUsers: row.allowed_users ?? [],
    allowedGroups: row.allowed_groups ?? [],
    embeddingModel: row.embedding_model,
    embeddingModelRevision: row.embedding_model_revision,
    indexBuildVersion: row.index_build_version,
    indexAlgorithm: row.index_algorithm,
    indexParameters: row.index_parameters,
  };
}

export async function saveCollectionMeta(
  client: PoolClient,
  table: string,
  meta: CollectionMeta,
  schemaVersion: number,
): Promise<void> {
  await client.query(
    `INSERT INTO vs_collection_config
       (collection_table, schema_version, fts_language, sparse_enabled, sparse_vocab_size, quantization, vector_size,
        embedding_model, embedding_model_revision, index_build_version, index_algorithm, index_parameters)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (collection_table) DO UPDATE SET
       schema_version    = EXCLUDED.schema_version,
       fts_language      = EXCLUDED.fts_language,
       sparse_enabled    = EXCLUDED.sparse_enabled,
       sparse_vocab_size = EXCLUDED.sparse_vocab_size,
       quantization      = EXCLUDED.quantization,
       vector_size       = EXCLUDED.vector_size,
       embedding_model   = COALESCE(vs_collection_config.embedding_model, EXCLUDED.embedding_model),
       embedding_model_revision = COALESCE(vs_collection_config.embedding_model_revision, EXCLUDED.embedding_model_revision),
       updated_at        = NOW()`,
    [
      table,
      schemaVersion,
      meta.language,
      meta.sparseEnabled,
      meta.sparseVocabSize,
      meta.quantization,
      meta.vectorSize,
      meta.embeddingModel ?? null,
      meta.embeddingModelRevision ?? null,
      meta.indexBuildVersion ?? null,
      meta.indexAlgorithm ?? null,
      meta.indexParameters ? JSON.stringify(meta.indexParameters) : null,
    ],
  );
}

// ─── Collection table DDL ─────────────────────────────────────────────────────

export const CURRENT_SCHEMA_VERSION = 10;

export interface CollectionDDLConfig {
  vecType: string;
  cosineOps: string;
  hnswM: number;
  efConstruction: number;
}

export async function ensureCollectionDDL(
  client: PoolClient,
  table: string,
  vectorSize: number,
  meta: CollectionMeta,
  ddlConfig: CollectionDDLConfig,
): Promise<void> {
  const { vecType, cosineOps, hnswM, efConstruction } = ddlConfig;

  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  await ensureCollectionConfigTable(client);

  // Serialize concurrent DDL across instances via advisory lock.
  // pg_advisory_xact_lock is automatically released at transaction end.
  await client.query("BEGIN");
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
    `vc_ddl:${table}`,
  ]);

  try {
    // Re-check both metadata and physical-table state under the cross-instance
    // DDL lock. Provenance describes indexes created by this transaction, so
    // an existing row (including explicit nulls) or an orphaned table must not
    // be relabelled when CREATE INDEX IF NOT EXISTS is a no-op.
    const existingMeta = await loadCollectionMeta(client, table);
    const tableLookup = await client.query<{ table_name: string | null }>(
      "SELECT to_regclass($1) AS table_name",
      [table],
    );
    const isGenuinelyNewCollection =
      existingMeta === null && tableLookup.rows[0]?.table_name == null;

    // table   = validated collection name prefixed with vc_ (letters/digits/underscores only)
    // vecType, hnswM, efConstruction, cosineOps = trusted server config, not user input
    // meta.language = validated against ALLOWED_FTS_LANGUAGES whitelist before this call;
    //   PostgreSQL does not support regconfig as a bind parameter, so interpolation is intentional.
    const sparseColDef =
      meta.sparseEnabled && meta.sparseVocabSize
        ? `\n        sparse_vector  sparsevec(${meta.sparseVocabSize}),`
        : "";
    const binaryColDef =
      meta.quantization === "binary"
        ? `\n        bit_vector     bit(${vectorSize}),`
        : "";

    await client.query(`
      CREATE TABLE IF NOT EXISTS "${table}" (
        tenant_id      TEXT NOT NULL,
        id             BIGSERIAL PRIMARY KEY,
        reference      TEXT NOT NULL,
        base_ref       TEXT NOT NULL,
        is_latest      BOOLEAN NOT NULL DEFAULT TRUE,
        created        TIMESTAMPTZ DEFAULT NOW(),
        modified       TIMESTAMPTZ DEFAULT NOW(),
        source         TEXT,
        link           TEXT,
        title          TEXT,
        content        TEXT NOT NULL,
        metadata       JSONB DEFAULT '{}'::jsonb,
        tags           TEXT[] NOT NULL DEFAULT '{}',
        allowed_users  TEXT[] NOT NULL DEFAULT '{}',
        allowed_groups TEXT[] NOT NULL DEFAULT '{}',${sparseColDef}${binaryColDef}
        chunk          JSONB,
        prefix         TEXT,
        ts_search      tsvector,
        vector         ${vecType}(${vectorSize}) NOT NULL
      )
    `);

    await client.query(`ALTER TABLE "${table}" ALTER COLUMN tenant_id DROP DEFAULT`);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "${table}_tenant_reference_key"
        ON "${table}"(tenant_id, reference)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_tenant_idx"
        ON "${table}"(tenant_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_vector_hnsw_idx"
        ON "${table}" USING hnsw (vector ${cosineOps})
        WITH (m = ${hnswM}, ef_construction = ${efConstruction})
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_vector_latest_hnsw_idx"
        ON "${table}" USING hnsw (vector ${cosineOps})
        WITH (m = ${hnswM}, ef_construction = ${efConstruction})
        WHERE (is_latest = TRUE)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_ts_search_gin_idx"
        ON "${table}" USING gin(ts_search)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_reference_idx"
        ON "${table}"(reference)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_base_ref_idx"
        ON "${table}"(base_ref)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_metadata_gin_idx"
        ON "${table}" USING gin(metadata)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_modified_idx"
        ON "${table}"(modified DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_is_latest_idx"
        ON "${table}"(is_latest)
        WHERE (is_latest = TRUE)
    `);

    if (meta.sparseEnabled && meta.sparseVocabSize) {
      await client.query(`
        CREATE INDEX IF NOT EXISTS "${table}_sparse_vector_idx"
          ON "${table}" USING hnsw (sparse_vector sparsevec_ip_ops)
      `);
    }

    if (meta.quantization === "binary") {
      await client.query(`
        CREATE INDEX IF NOT EXISTS "${table}_bit_vector_hnsw_idx"
          ON "${table}" USING hnsw (bit_vector bit_hamming_ops)
          WITH (m = ${hnswM}, ef_construction = ${efConstruction})
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS "${table}_bit_vector_latest_hnsw_idx"
          ON "${table}" USING hnsw (bit_vector bit_hamming_ops)
          WITH (m = ${hnswM}, ef_construction = ${efConstruction})
          WHERE (is_latest = TRUE)
      `);
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_tags_gin_idx"
        ON "${table}" USING gin(tags)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_allowed_users_gin_idx"
        ON "${table}" USING gin(allowed_users)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS "${table}_allowed_groups_gin_idx"
        ON "${table}" USING gin(allowed_groups)
    `);

    if (isGenuinelyNewCollection) {
      meta.indexBuildVersion = `schema-${CURRENT_SCHEMA_VERSION}`;
      meta.indexAlgorithm = "hnsw";
      meta.indexParameters = { m: hnswM, ef_construction: efConstruction };
    } else {
      meta.indexBuildVersion = existingMeta?.indexBuildVersion ?? null;
      meta.indexAlgorithm = existingMeta?.indexAlgorithm ?? null;
      meta.indexParameters = existingMeta?.indexParameters ?? null;
    }
    await saveCollectionMeta(client, table, meta, CURRENT_SCHEMA_VERSION);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

// ─── Upsert SQL helpers (shared between upsert and batchUpsert) ───────────────

export interface UpsertSqlParts {
  sparseCol: string;
  sparseVal: (paramBase: number) => string;
  sparseUpdate: string;
  binaryCol: string;
  binaryVal: (paramBase: number) => string;
  binaryUpdate: string;
  /** Number of extra params per row (sparse + binary). */
  extraParamCount: number;
}

export function buildUpsertSqlParts(
  meta: CollectionMeta,
  vecType: string,
): UpsertSqlParts {
  const sparseEnabled = meta.sparseEnabled && meta.sparseVocabSize !== null;
  const binaryEnabled =
    meta.quantization === "binary" && meta.vectorSize !== null;

  const sparseCol = sparseEnabled ? ", sparse_vector" : "";
  const sparseUpdate = sparseEnabled
    ? ", sparse_vector = EXCLUDED.sparse_vector"
    : "";
  const binaryCol = binaryEnabled ? ", bit_vector" : "";
  const binaryUpdate = binaryEnabled
    ? ", bit_vector = EXCLUDED.bit_vector"
    : "";

  // paramBase is the index of the last fixed param (0-based count before extras)
  const sparseVal = (paramBase: number): string =>
    sparseEnabled
      ? `, $${paramBase + 1}::sparsevec(${meta.sparseVocabSize})`
      : "";
  const binaryVal = (paramBase: number): string =>
    binaryEnabled ? `, $${paramBase + 1}::bit(${meta.vectorSize})` : "";

  const extraParamCount = (sparseEnabled ? 1 : 0) + (binaryEnabled ? 1 : 0);

  return {
    sparseCol,
    sparseVal,
    sparseUpdate,
    binaryCol,
    binaryVal,
    binaryUpdate,
    extraParamCount,
  };
}

/**
 * Push the extra (sparse + binary) params for one point onto the params array.
 * Returns the updated param count.
 */
export function pushExtraParams(
  params: unknown[],
  point: { vector: number[]; sparseVector?: SparseVector },
  meta: CollectionMeta,
): void {
  const sparseEnabled = meta.sparseEnabled && meta.sparseVocabSize !== null;
  const binaryEnabled =
    meta.quantization === "binary" && meta.vectorSize !== null;

  if (sparseEnabled) {
    params.push(
      point.sparseVector ? sparseVectorToPg(point.sparseVector) : null,
    );
  }
  if (binaryEnabled) {
    params.push(toBinaryString(point.vector));
  }
}
