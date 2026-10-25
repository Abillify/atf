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
// Circular with revision-schema.ts (which imports withSchemaDdlLock from here).
// Safe: both modules only reference each other's bindings inside function
// bodies, never during module evaluation.
import { ensureRevisionSchemaUnderLock } from "./revision-schema.js";

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

// ─── Schema DDL serialization ─────────────────────────────────────────────────

/**
 * Advisory-lock key that serializes EVERY schema DDL path of this service:
 * the global migrations, the lazy ensure paths (collection tables, unit
 * columns, config/stats/identifier tables, the v2 revision + asset tables).
 *
 * Concurrent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` of the
 * same object is NOT race-free in PostgreSQL: two sessions can both pass the
 * existence check and one then fails with `duplicate key value violates unique
 * constraint "pg_type_typname_nsp_index"` (or `pg_class_relname_nsp_index`).
 * Several replicas starting at once, parallel test suites, or a lazy ensure
 * running next to a migration all hit that. One transaction-scoped advisory
 * lock taken by every DDL path makes them strictly sequential. Advisory locks
 * are scoped to the current database, so separate databases do not contend.
 */
export const SCHEMA_DDL_LOCK_NAME = "atf:search:schema-ddl";

/** Minimal client surface the DDL lock needs (a pg PoolClient in production). */
interface DdlClient {
  query: PoolClient["query"];
  getTransactionStatus?: () => string | null;
}

/**
 * True when the client is inside an open transaction block. node-postgres
 * tracks the backend's ReadyForQuery status (`I` idle, `T` in transaction,
 * `E` failed transaction). Test doubles without that method count as idle.
 */
function inTransaction(client: DdlClient): boolean {
  const status =
    typeof client.getTransactionStatus === "function" ? client.getTransactionStatus() : null;
  return status === "T" || status === "E";
}

/**
 * Take the schema-DDL advisory lock for the CURRENT transaction. The caller
 * must already be inside a transaction block; the lock is released at COMMIT /
 * ROLLBACK. Re-entrant within one session, so nested ensure calls are safe.
 */
export async function lockSchemaDdl(client: DdlClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
    SCHEMA_DDL_LOCK_NAME,
  ]);
}

/**
 * Run `fn` serialized under the schema-DDL advisory lock.
 *
 * When the client is already inside a transaction (a migration step, or an
 * outer ensure), the lock is taken in that transaction and `fn` joins it — no
 * nested BEGIN/COMMIT, so the caller keeps atomicity. Otherwise a dedicated
 * transaction is opened, the lock taken, `fn` run and committed (rolled back on
 * error), which also makes the DDL batch itself atomic.
 */
export async function withSchemaDdlLock<T>(
  client: DdlClient,
  fn: () => Promise<T>,
): Promise<T> {
  if (inTransaction(client)) {
    await lockSchemaDdl(client);
    return fn();
  }
  await client.query("BEGIN");
  try {
    await lockSchemaDdl(client);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
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

/** Shape of an operator-provided text search configuration name. */
export const FTS_CONFIG_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Text search configurations the operator installed in PostgreSQL in addition
 * to the built-in ones — typically a Hunspell-based `german_compound` that
 * splits compounds ("Mietvertrag" → "miet", "vertrag"), which no built-in
 * Snowball configuration does. Registered from FTS_EXTRA_LANGUAGES at startup
 * only after `pg_ts_config` confirmed they exist (see index.ts).
 */
const extraFtsLanguages = new Set<string>();

export function registerFtsLanguages(names: readonly string[]): void {
  for (const name of names) {
    if (!FTS_CONFIG_NAME_RE.test(name)) {
      throw new AppError(
        "UNSUPPORTED_FTS_LANGUAGE",
        `Invalid text search configuration name "${name}"`,
      );
    }
    extraFtsLanguages.add(name);
  }
}

/** True when `lang` is a built-in or registered configuration (no throw). */
export function isAllowedFtsLanguage(lang: string): boolean {
  const lower = lang.trim().toLowerCase();
  return ALLOWED_FTS_LANGUAGES.has(lower) || extraFtsLanguages.has(lower);
}

export function validateFtsLanguage(lang: string): string {
  const lower = lang.trim().toLowerCase();
  if (!ALLOWED_FTS_LANGUAGES.has(lower) && !extraFtsLanguages.has(lower)) {
    throw new AppError(
      "UNSUPPORTED_FTS_LANGUAGE",
      `Unsupported FTS language "${lang}". Allowed: ${[...ALLOWED_FTS_LANGUAGES, ...extraFtsLanguages].join(", ")}`,
    );
  }
  return lower;
}

/**
 * SQL fragment that reconstructs, per row, the same text `buildFtsText` feeds
 * into `to_tsvector` at ingest time, then wraps it in `to_tsvector(lang, …)`.
 *
 * It is used to recompute the `ts_search` column of an existing collection when
 * its FTS language changes (Requirement 2.6). Re-stemming under the new language
 * is the whole point of the migration, so the reconstruction mirrors
 * `buildFtsText`/`prepareFtsContent`:
 *   - chunk-0 (or unchunked) rows are prefixed with title, base_ref and prefix;
 *   - the Markdown/URL/long-token cleanups are reproduced with `regexp_replace`.
 *
 * `lang` MUST be a value returned by {@link validateFtsLanguage} (whitelisted
 * against ALLOWED_FTS_LANGUAGES). PostgreSQL cannot bind a regconfig as a
 * parameter, so the language is interpolated — validation makes that safe.
 *
 * The reconstruction stays in SQL on purpose: a collection can hold millions of
 * rows (documents up to 10 000 pages), so a single set-based UPDATE keeps the
 * migration memory-bounded instead of streaming every row through Node.
 */
export function ftsSearchRecomputeSql(lang: string): string {
  // Mirror buildFtsText: for chunk 0 (or unchunked) prepend title, base_ref and
  // prefix; other chunks index content only so many-chunk documents are not
  // over-weighted in FTS ranking.
  const rawText = `(
    CASE
      WHEN COALESCE((chunk->>'chunk_index')::int, 0) = 0 THEN
        concat_ws(
          E'\\n',
          NULLIF(title, ''),
          base_ref,
          NULLIF(prefix, ''),
          content
        )
      ELSE content
    END
  )`;

  // Mirror prepareFtsContent's cleanup chain (see buildFtsText in
  // postgres-client.ts). Order matters and matches the JS implementation.
  const cleaned = [
    // 1. fenced code blocks ``` … ```
    (t: string) => `regexp_replace(${t}, E'\`\`\`[\\s\\S]*?\`\`\`', ' ', 'g')`,
    // 2. inline code `…` — keep the text
    (t: string) => `regexp_replace(${t}, E'\`([^\`]+)\`', E'\\\\1', 'g')`,
    // 3. images ![alt](url) — keep alt text
    (t: string) =>
      `regexp_replace(${t}, E'!\\\\[([^\\\\]]*)\\\\]\\\\([^)]*\\\\)', E'\\\\1', 'g')`,
    // 4. links [text](url) — keep link text
    (t: string) =>
      `regexp_replace(${t}, E'\\\\[([^\\\\]]+)\\\\]\\\\([^)]+\\\\)', E'\\\\1', 'g')`,
    // 5. bare URLs
    (t: string) => `regexp_replace(${t}, E'https?://\\\\S+', ' ', 'gi')`,
    // 6. bold / italic markers (keep text; simplified single-pass)
    (t: string) => `regexp_replace(${t}, E'[*_]{1,3}', '', 'g')`,
    // 7. ATX heading markers at line start
    (t: string) => `regexp_replace(${t}, E'(?m)^#{1,6}\\\\s+', '', 'g')`,
    // 8. blockquote markers at line start
    (t: string) => `regexp_replace(${t}, E'(?m)^>\\\\s*', '', 'g')`,
    // 9. horizontal rules
    (t: string) => `regexp_replace(${t}, E'(?m)^\\\\s*([-*_]\\\\s*){3,}$', ' ', 'g')`,
    // 10. remaining long tokens (> 50 chars): base64, hashes, long UUIDs
    (t: string) => `regexp_replace(${t}, E'\\\\S{51,}', ' ', 'g')`,
  ].reduce((expr, step) => step(expr), rawText);

  return `to_tsvector('${lang}', btrim(${cleaned}))`;
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
  await withSchemaDdlLock(client, () => ensureStatsTablesLocked(client));
}

async function ensureStatsTablesLocked(client: PoolClient): Promise<void> {
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
      query         TEXT,
      query_hash    TEXT,
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
  await client.query(
    `ALTER TABLE vs_ingest_stats ADD COLUMN IF NOT EXISTS tenant_id TEXT`,
  );
  await client.query(
    `ALTER TABLE vs_search_stats ADD COLUMN IF NOT EXISTS tenant_id TEXT`,
  );
  // Requirement 2.6: statistics are keyed by query_hash (SHA-256/HMAC); the
  // raw query column is nullable and written only when STATS_STORE_RAW_QUERY
  // is enabled. Global migration 9 backfills/clears legacy rows; this ALTER
  // keeps lazily created or pre-migration databases schema-current.
  await client.query(
    `ALTER TABLE vs_search_stats ADD COLUMN IF NOT EXISTS query_hash TEXT`,
  );
  await client.query(
    `ALTER TABLE vs_search_stats ALTER COLUMN query DROP NOT NULL`,
  );
  await client.query(
    `DELETE FROM vs_ingest_stats WHERE tenant_id IS NULL OR btrim(tenant_id) = ''`,
  );
  await client.query(
    `DELETE FROM vs_search_stats WHERE tenant_id IS NULL OR btrim(tenant_id) = ''`,
  );
  await client.query(
    `ALTER TABLE vs_ingest_stats ALTER COLUMN tenant_id SET NOT NULL`,
  );
  await client.query(
    `ALTER TABLE vs_search_stats ALTER COLUMN tenant_id SET NOT NULL`,
  );
  // Future writes must always supply the authenticated tenant explicitly. A
  // legacy database default would silently collapse omitted tenants together.
  await client.query(
    `ALTER TABLE vs_ingest_stats ALTER COLUMN tenant_id DROP DEFAULT`,
  );
  await client.query(
    `ALTER TABLE vs_search_stats ALTER COLUMN tenant_id DROP DEFAULT`,
  );
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_ingest_stats_tenant_ts
      ON vs_ingest_stats(tenant_id, timestamp DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_search_stats_tenant_ts
      ON vs_search_stats(tenant_id, timestamp DESC)
  `);
}

// ─── Identifier index table DDL ───────────────

/**
 * The shared identifier occurrence index.
 *
 * When a query recognises an identifier, Search looks its `value_norm` up here,
 * scoped by tenant + collection, to get the unit ids that carry it verbatim, and
 * feeds those as the THIRD RRF list (Requirement 12.3). Extract already finds
 * identifiers per document (`document.end.identifiers`); the batch worker maps
 * each occurrence's block to the unit that contains it and records one row per
 * (identifier, unit, page).
 *
 * Like `vs_document_assets` this is a GLOBAL system table, not per-collection —
 * one table holds every collection's identifiers, partitioned by the
 * (tenant_id, collection) columns. `value_norm` is the canonical form produced
 * by {@link normalizeIdentifier} on BOTH the ingest and query sides, so exact
 * lookups compare equal regardless of casing/separators. `unit_id` is the v2
 * unit the occurrence resolved to; `page` and `kind` are carried for provenance
 * and future filters. The primary key dedupes a repeated occurrence of the same
 * identifier in the same unit on the same page (idempotent reprocessing).
 */
export async function ensureIdentifiersTable(client: PoolClient): Promise<void> {
  await withSchemaDdlLock(client, () => ensureIdentifiersTableLocked(client));
}

/**
 * Catalog-only check (no table lock) that vs_identifiers and both of its
 * indexes exist, so lazy callers can skip the idempotent-but-locking DDL.
 */
async function identifiersTableIsCurrent(client: PoolClient): Promise<boolean> {
  const res = await client.query<{ current: boolean | null }>(
    `SELECT to_regclass('vs_identifiers') IS NOT NULL
        AND to_regclass('idx_vs_identifiers_lookup') IS NOT NULL
        AND to_regclass('idx_vs_identifiers_unit') IS NOT NULL AS current`,
  );
  return res.rows[0]?.current === true;
}

async function ensureIdentifiersTableLocked(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vs_identifiers (
      tenant_id   TEXT    NOT NULL,
      collection  TEXT    NOT NULL,
      value_norm  TEXT    NOT NULL,
      unit_id     TEXT    NOT NULL,
      page        INTEGER NOT NULL DEFAULT 0,
      kind        TEXT,
      created     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, value_norm, unit_id, page)
    )
  `);
  // Exact lookup at query time: (tenant, collection, value_norm) → unit ids.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_identifiers_lookup
      ON vs_identifiers(tenant_id, collection, value_norm)
  `);
  // Per-unit cleanup path: delete a unit's identifier rows when it is re-indexed.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_identifiers_unit
      ON vs_identifiers(tenant_id, collection, unit_id)
  `);
}

// ─── Collection config table DDL ──────────────────────────────────────────────

export async function ensureCollectionConfigTable(
  client: PoolClient,
): Promise<void> {
  await withSchemaDdlLock(client, () => ensureCollectionConfigTableLocked(client));
}

async function ensureCollectionConfigTableLocked(client: PoolClient): Promise<void> {
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
  const row = res.rows[0];
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

export const CURRENT_SCHEMA_VERSION = 14;

/**
 * Add the v2 index-unit columns and their indexes to a per-collection table
 * These are the *filter-relevant* fields kept
 * as real, indexed columns rather than buried in `metadata` JSONB, so search
 * can filter on them with an index.
 *
 * All columns are nullable and additive: v1/legacy rows written before this
 * migration simply carry NULLs (v1 ingest writes no revision, no unit shape), so
 * existing collections migrate forward without a rewrite and legacy queries keep
 * working. `unit_type`/`figure_kind` are stored as TEXT — the vocabularies are
 * owned by @atf/extract-contract, not the schema.
 *
 * Shared by {@link ensureCollectionDDL} (new tables) and the schema-12/13
 * collection migration steps (existing tables), so both stay in lockstep.
 *
 * Schema 13 (task 3.2, the full multi-level unit builder) adds the columns the
 * `chunk`/`table`/`figure`/`section`/`page`/`document` units need for the graph
 * of relationships small-to-big expansion (task 4.x) walks: `parent_unit_id`,
 * `prev_unit_id`, `next_unit_id` link a unit to its parent and its reading-order
 * siblings; `block_ids` records the source v2 block ids (provenance +
 * determinism); `figure_refs` holds the figure ids referenced within a text
 * unit's span (so a text hit can attach its figures); `table_id` groups a
 * table's row-group units. All are filter-/traversal-relevant so they are real
 * indexed columns, not JSONB (Requirement 11.1/11.5). `block_ids`/`figure_refs`
 * are TEXT[] — the refs on a unit are just ids; the richer {@link Ref} shape
 * lives in the block payload, not on the index row.
 *
 * Schema 14 (task 3.4, "lexicon and identifiers") adds `ts_ident`: a SECOND FTS
 * vector built with the `simple` config so codes like `WE-01/A` or
 * `DIN EN 1090-2` are tokenised verbatim rather than German-stemmed
 * (Requirement 12.1). The existing `ts_search` column stays the prose vector
 * (`ts_de` when the collection's `fts_language='german'`); `ts_ident` is
 * additive and nullable, so a legacy/v1 row (which carries none) searches
 * exactly as before. It gets its own GIN index for `@@` matching.
 */
export async function ensureUnitColumns(
  client: PoolClient,
  table: string,
): Promise<void> {
  await withSchemaDdlLock(client, () => ensureUnitColumnsLocked(client, table));
}

async function ensureUnitColumnsLocked(client: PoolClient, table: string): Promise<void> {
  await client.query(`
    ALTER TABLE "${table}"
      ADD COLUMN IF NOT EXISTS unit_id        TEXT,
      ADD COLUMN IF NOT EXISTS unit_type      TEXT,
      ADD COLUMN IF NOT EXISTS revision_id    TEXT,
      ADD COLUMN IF NOT EXISTS section_id     TEXT,
      ADD COLUMN IF NOT EXISTS section_path   TEXT[],
      ADD COLUMN IF NOT EXISTS page_start     INTEGER,
      ADD COLUMN IF NOT EXISTS page_end       INTEGER,
      ADD COLUMN IF NOT EXISTS figure_kind    TEXT,
      ADD COLUMN IF NOT EXISTS document_id    TEXT,
      ADD COLUMN IF NOT EXISTS parent_unit_id TEXT,
      ADD COLUMN IF NOT EXISTS prev_unit_id   TEXT,
      ADD COLUMN IF NOT EXISTS next_unit_id   TEXT,
      ADD COLUMN IF NOT EXISTS block_ids      TEXT[],
      ADD COLUMN IF NOT EXISTS figure_refs    TEXT[],
      ADD COLUMN IF NOT EXISTS table_id       TEXT,
      ADD COLUMN IF NOT EXISTS ts_ident       tsvector
  `);
  // Identifier FTS vector (task 3.4, Requirement 12.1). GIN index for `@@`.
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_ts_ident_gin_idx"
      ON "${table}" USING gin(ts_ident)
  `);
  // A unit id is unique per tenant within a collection; the partial unique index
  // lets legacy rows (unit_id IS NULL) coexist while still enforcing determinism
  // for v2 units (Requirement 5.5). Upserts target this key.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "${table}_unit_id_key"
      ON "${table}"(tenant_id, unit_id)
      WHERE unit_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_unit_type_idx"
      ON "${table}"(unit_type)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_revision_id_idx"
      ON "${table}"(revision_id)
      WHERE revision_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_section_id_idx"
      ON "${table}"(section_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_section_path_gin_idx"
      ON "${table}" USING gin(section_path)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_page_range_idx"
      ON "${table}"(page_start, page_end)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_figure_kind_idx"
      ON "${table}"(figure_kind)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_document_id_idx"
      ON "${table}"(document_id)
  `);
  // Relationship-graph columns. parent/prev/next are looked up by id
  // when small-to-big expansion walks the unit graph; table_id groups a table's
  // row-group units. figure_refs is a GIN index so a lookup can find the text
  // units that reference a given figure id.
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_parent_unit_id_idx"
      ON "${table}"(parent_unit_id)
      WHERE parent_unit_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_prev_unit_id_idx"
      ON "${table}"(prev_unit_id)
      WHERE prev_unit_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_next_unit_id_idx"
      ON "${table}"(next_unit_id)
      WHERE next_unit_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_table_id_idx"
      ON "${table}"(table_id)
      WHERE table_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "${table}_figure_refs_gin_idx"
      ON "${table}" USING gin(figure_refs)
  `);
}

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

  // Serialize concurrent DDL across instances AND across every other schema
  // DDL path (migrations, config/identifier/revision tables) via the shared
  // schema-DDL advisory lock. The extension and the config table are created
  // under the same lock: running them before it let two replicas race on
  // `CREATE ... IF NOT EXISTS` (pg_type_typname_nsp_index violations).
  // pg_advisory_xact_lock is automatically released at transaction end.
  const ownsTransaction = !inTransaction(client);
  if (ownsTransaction) await client.query("BEGIN");

  try {
    await lockSchemaDdl(client);
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await ensureCollectionConfigTableLocked(client);
    // Every collection read joins the current-revision pointer
    // (vs_document_revisions, see query-builder buildTemporalFilterSql), so a
    // collection must never exist without the v2 revision schema — otherwise a
    // search on a fresh database fails until the revision store happens to run
    // its lazy ensure. A catalog-only check runs first, so the no-op DDL
    // (which would take AccessExclusive/Share table locks on live revision
    // tables) only runs when something is actually missing; it then runs in
    // this transaction under the schema-DDL lock taken above.
    await ensureRevisionSchemaUnderLock(client);
    // Same for the shared identifier index the search path reads as its third
    // RRF list (and the batch worker writes): catalog check, then DDL only
    // when missing.
    if (!(await identifiersTableIsCurrent(client))) {
      await ensureIdentifiersTableLocked(client);
    }

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
        valid_from     TIMESTAMPTZ,
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
      CREATE INDEX IF NOT EXISTS "${table}_temporal_version_idx"
        ON "${table}"(tenant_id, base_ref, (COALESCE(valid_from, created)) DESC, created DESC, id DESC)
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

    // v2 index-unit columns as real, indexed columns.
    // Nullable + additive so v1 rows are unaffected.
    await ensureUnitColumnsLocked(client, table);

    if (isGenuinelyNewCollection) {
      meta.indexBuildVersion = `schema-${CURRENT_SCHEMA_VERSION}`;
      meta.indexAlgorithm = "hnsw";
      meta.indexParameters = { m: hnswM, ef_construction: efConstruction };
    } else {
      meta.indexBuildVersion = existingMeta?.indexBuildVersion ?? null;
      meta.indexAlgorithm = existingMeta?.indexAlgorithm ?? null;
      meta.indexParameters = existingMeta?.indexParameters ?? null;
    }

    // FTS-language migration (Requirement 2.6): when an existing collection's
    // FTS language changes (e.g. a deployment switching to 'german'), the
    // ts_search vectors were built with the old language and would no longer
    // match queries stemmed under the new one. Recompute them in-place from the
    // stored content so the change takes effect for all existing rows, not just
    // future upserts. meta.language is validated against ALLOWED_FTS_LANGUAGES.
    if (
      !isGenuinelyNewCollection &&
      existingMeta !== null &&
      existingMeta.language !== meta.language
    ) {
      await client.query(
        `UPDATE "${table}" SET ts_search = ${ftsSearchRecomputeSql(meta.language)}`,
      );
    }

    await saveCollectionMeta(client, table, meta, CURRENT_SCHEMA_VERSION);
    if (ownsTransaction) await client.query("COMMIT");
  } catch (err) {
    if (ownsTransaction) await client.query("ROLLBACK").catch(() => {});
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
  _vecType: string,
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
