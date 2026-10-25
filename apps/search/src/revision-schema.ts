// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * revision-schema.ts
 *
 * DDL and typed row shapes for the v2 ingest staging tables and the asset
 * table that replaces `vs_document_assets`.
 *
 * This module is schema-only. The revision API, the batch worker
 * the asset API / AssetStore and the atomic `is_latest`
 * switch build on the tables and row shapes defined here; none of
 * that business logic lives in this file.
 *
 * These are *global* tables (tenant + collection scoped by column, like
 * `vs_document_assets` and the stats tables), not per-collection `vc_*` tables.
 * They are created by a GLOBAL_MIGRATIONS step (see migrations.ts).
 *
 * Vocabulary columns (`status`, `visibility`, `kind`, `variant`, `unit_type`,
 * `figure_kind`) are stored as TEXT rather than PostgreSQL enums on purpose: the
 * authoritative vocabularies live in `@atf/extract-contract` v2
 * (RevisionStatus, Visibility, BatchStatus, AssetRef kind, variants, FigureKind,
 * unit_type). Extending a vocabulary there should be a code change, never a
 * schema migration. The columns are still real + indexed so filtering is
 * indexable.
 */

import type { PoolClient } from "pg";
import { withSchemaDdlLock } from "./collection-ddl.js";
import type {
  BatchStatus,
  RevisionStatus,
  Visibility,
} from "@atf/extract-contract";

// ─── Table names ──────────────────────────────────────────────────────────────

/** Staged revisions per document. */
export const VS_REVISIONS_TABLE = "vs_revisions";
/** Staged NDJSON page batches awaiting the embedding worker. */
export const VS_INGEST_BATCHES_TABLE = "vs_ingest_batches";
/** Committed segment ranges per revision. */
export const VS_SEGMENTS_TABLE = "vs_segments";
/** Per-document pointer to the currently-visible revision. */
export const VS_DOCUMENT_REVISIONS_TABLE = "vs_document_revisions";
/** Asset table that replaces vs_document_assets. */
export const VS_ASSETS_TABLE = "vs_assets";
/** Every ingested source file per document: dedup fingerprints and claims. */
export const VS_DOCUMENT_SOURCES_TABLE = "vs_document_sources";
/** Message-ID → thread index for e-mails ingested independently. */
export const VS_MAIL_MESSAGES_TABLE = "vs_mail_messages";
/** Document → group (an e-mail thread, or the parent of an attachment). */
export const VS_DOCUMENT_GROUPS_TABLE = "vs_document_groups";

// ─── Typed row shapes ───────────────────────────────────────────────────────

/**
 * A staged revision. `is_latest` is NOT stored here — the current-revision
 * pointer lives in {@link DocumentRevisionPointerRow} so the final commit can
 * flip a single row atomically. A revision only *becomes* latest
 * via that pointer.
 */
export interface RevisionRow {
  tenant_id: string;
  collection: string;
  revision_id: string;
  /** Document reference this revision replaces / creates. */
  reference: string;
  status: RevisionStatus;
  visibility: Visibility;
  /** Idempotency-Key from `POST …/revisions` (usually the Extract job id). */
  idempotency_key: string | null;
  /** When an uncommitted revision may be reaped by the TTL cleaner. */
  ttl_expires_at: Date | null;
  /**
   * Declared page count: `document.begin.pageCount`, overridden by the
   * authoritative `document.end.pageCount`. The final commit checks the staged
   * page coverage against `[first page, page_count]` (the first page is in
   * `document_info.firstPage`, 1 without a `pages` window). Null while unknown.
   */
  page_count: number | null;
  /** True once a batch carrying the trailing `document.end` record is staged. */
  has_document_end: boolean;
  /**
   * Final-commit progress (see revision-store.ts `finalizeRevision`):
   *   null        — no final commit requested yet
   *   'requested' — commit accepted (coverage complete), waiting for every
   *                 batch to be processed; the old revision stays visible
   *   'cleanup'   — pointer switched (status='committed'); older revisions'
   *                 rows are still being flipped to is_latest = FALSE
   *   'done'      — switch and flip complete
   */
  commit_state: "requested" | "cleanup" | "done" | null;
  /** The revision the document pointer named right before this one's switch. */
  prior_revision_id: string | null;
  commit_requested_at: Date | null;
  created: Date;
  modified: Date;
}

/** A durably-staged NDJSON batch, processed later by the embedding worker. */
export interface IngestBatchRow {
  tenant_id: string;
  collection: string;
  revision_id: string;
  /** Producer-assigned monotonic sequence number within the revision. */
  seq: number;
  status: BatchStatus;
  /** Content-Digest of the batch body; a replay with the same digest is a no-op. */
  digest: string;
  /** Closed page range [page_start, page_end] this batch covers. */
  page_start: number | null;
  page_end: number | null;
  /** Staged NDJSON payload the worker will parse into units. */
  payload: Buffer | null;
  /**
   * Backoff / lease marker. Set to the lease expiry when a worker claims the
   * batch (visibility timeout) and to the backoff when it defers the batch.
   */
  next_attempt_at: Date | null;
  /** Asset ids the batch's page records reference, captured at staging time. */
  asset_ids: string[] | null;
  /** Token of the worker claim currently holding the lease on this batch. */
  lease_token: string | null;
  /** Number of worker claims so far. */
  attempts: number;
  created: Date;
  modified: Date;
}

/** A committed segment: a page range whose units are durably indexed. */
export interface SegmentRow {
  tenant_id: string;
  collection: string;
  revision_id: string;
  /** Producer-assigned segment number within the revision. */
  seq: number;
  page_start: number;
  page_end: number;
  committed_at: Date;
}

/**
 * The per-document revision pointer. Exactly one row per
 * (tenant, collection, reference) names the revision that search filters on, so
 * two revisions of one document are never visible at once. The atomic switch
 *  updates this pointer.
 */
export interface DocumentRevisionPointerRow {
  tenant_id: string;
  collection: string;
  reference: string;
  /** The revision currently visible to search. */
  current_revision_id: string;
  modified: Date;
}

/**
 * An asset bound to a revision. Replaces vs_document_assets;
 * legacy figure assets are backfilled with kind='figure' and a null revision_id.
 */
export interface AssetRow {
  tenant_id: string;
  collection: string;
  asset_id: string;
  /** figure | page | tile | native (AssetRef kind vocabulary). */
  kind: string;
  document_reference: string;
  /** Nullable so v1/legacy assets (no revision) keep resolving. */
  revision_id: string | null;
  /** figure id for figure assets; null for page/tile/native. */
  figure_id: string | null;
  /** 1-based page the asset lives on, when applicable. */
  page: number | null;
  /** [x0,y0,x1,y1] normalized bounding box as JSON, when applicable. */
  bbox: number[] | null;
  width: number | null;
  height: number | null;
  /** thumb | preview | full. */
  variant: string;
  mime_type: string;
  data: Buffer;
  checksum: string | null;
  created: Date;
  modified: Date;
}

// ─── DDL ────────────────────────────────────────────────────────────────────

/**
 * Create the v2 staging tables, the document revision pointer and vs_assets,
 * then backfill vs_assets from the legacy vs_document_assets table.
 *
 * Idempotent (CREATE TABLE / INDEX IF NOT EXISTS + a guarded backfill), so it is
 * safe to run from a migration step and from the lazy ensure path.
 */
export async function ensureRevisionSchema(
  client: PoolClient,
  options: { skipIfCurrent?: boolean } = {},
): Promise<void> {
  // Lazy (runtime) callers skip the DDL entirely when every object already
  // exists: `ALTER TABLE … ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT
  // EXISTS` still take table locks (AccessExclusive / Share) even when they
  // are no-ops, which deadlocks against concurrent revision traffic. The
  // migration path (skipIfCurrent unset) always runs the full idempotent DDL
  // and the legacy backfill.
  if (options.skipIfCurrent && (await revisionSchemaIsCurrent(client))) return;
  // One transaction under the shared schema-DDL advisory lock: parallel
  // replicas / test suites must not race on CREATE TABLE IF NOT EXISTS.
  await withSchemaDdlLock(client, async () => {
    // Re-check under the lock: another replica may have just finished it.
    if (options.skipIfCurrent && (await revisionSchemaIsCurrent(client))) return;
    await ensureRevisionTablesLocked(client);
    await ensureAssetsTableLocked(client);
    await backfillAssetsFromDocumentAssets(client);
  });
}

/**
 * {@link ensureRevisionSchema} for a caller that ALREADY holds the schema-DDL
 * advisory lock inside its own open transaction (e.g. ensureCollectionDDL).
 * Does the catalog-only currency check first so the no-op DDL — which takes
 * table locks on live revision tables — only runs when something is missing.
 * Takes no lock and opens no transaction itself.
 */
export async function ensureRevisionSchemaUnderLock(client: PoolClient): Promise<void> {
  if (await revisionSchemaIsCurrent(client)) return;
  await ensureRevisionTablesLocked(client);
  await ensureAssetsTableLocked(client);
  await backfillAssetsFromDocumentAssets(client);
}

/** Columns added after the v5 migration that the runtime code depends on. */
const REQUIRED_REVISION_COLUMNS = [
  "page_count",
  "has_document_end",
  "commit_state",
  "prior_revision_id",
  "commit_requested_at",
  // document.begin provenance (contract / pipelineVersion / promptHash) that
  // the batch worker copies into every unit's metadata (Requirement 18.2).
  "extract_provenance",
  // The source claim (vs_document_sources.source_id) the revision indexes, and
  // the document.begin version / e-mail / parent the final switch acts on.
  "source_id",
  "document_info",
  // The row ACL the batch worker writes onto every unit of the revision.
  "allowed_users",
  "allowed_groups",
];
const REQUIRED_BATCH_COLUMNS = ["asset_ids", "lease_token", "attempts"];

/**
 * True when every table, the late-added columns and the commit-pending index
 * exist. A catalog read only — it takes no table lock.
 */
export async function revisionSchemaIsCurrent(client: PoolClient): Promise<boolean> {
  const res = await client.query<{ current: boolean | null }>(
    `SELECT
       (SELECT count(*) FROM pg_attribute
         WHERE attrelid = to_regclass($1) AND attname = ANY($2::text[]) AND NOT attisdropped)
         = cardinality($2::text[])
       AND (SELECT count(*) FROM pg_attribute
         WHERE attrelid = to_regclass($3) AND attname = ANY($4::text[]) AND NOT attisdropped)
         = cardinality($4::text[])
       AND to_regclass($5) IS NOT NULL
       AND to_regclass($6) IS NOT NULL
       AND to_regclass($7) IS NOT NULL
       AND to_regclass($8) IS NOT NULL
       AND to_regclass($9) IS NOT NULL
       AND to_regclass($10) IS NOT NULL
       AND to_regclass('idx_vs_revisions_commit_pending') IS NOT NULL
       AS current`,
    [
      VS_REVISIONS_TABLE,
      REQUIRED_REVISION_COLUMNS,
      VS_INGEST_BATCHES_TABLE,
      REQUIRED_BATCH_COLUMNS,
      VS_SEGMENTS_TABLE,
      VS_DOCUMENT_REVISIONS_TABLE,
      VS_ASSETS_TABLE,
      VS_DOCUMENT_SOURCES_TABLE,
      VS_MAIL_MESSAGES_TABLE,
      VS_DOCUMENT_GROUPS_TABLE,
    ],
  );
  return res.rows[0]?.current === true;
}

/**
 * Revisions, batches, segments and the document revision pointer. A lazy
 * ensure: skips all DDL (and its table locks) when the catalog shows the
 * schema is current, otherwise runs it under the schema-DDL lock.
 */
export async function ensureRevisionTables(client: PoolClient): Promise<void> {
  if (await revisionSchemaIsCurrent(client)) return;
  await withSchemaDdlLock(client, async () => {
    if (await revisionSchemaIsCurrent(client)) return;
    await ensureRevisionTablesLocked(client);
  });
}

async function ensureRevisionTablesLocked(client: PoolClient): Promise<void> {
  // ── vs_revisions ──────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${VS_REVISIONS_TABLE} (
      tenant_id       TEXT NOT NULL,
      collection      TEXT NOT NULL,
      revision_id     TEXT NOT NULL,
      reference       TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'staging',
      visibility      TEXT NOT NULL DEFAULT 'on_commit',
      idempotency_key TEXT,
      ttl_expires_at  TIMESTAMPTZ,
      created         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      modified        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, revision_id)
    )
  `);
  // A repeated POST with the same Idempotency-Key must return the same revision.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vs_revisions_idempotency
      ON ${VS_REVISIONS_TABLE}(tenant_id, collection, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_revisions_reference
      ON ${VS_REVISIONS_TABLE}(tenant_id, collection, reference)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_revisions_status
      ON ${VS_REVISIONS_TABLE}(status)
  `);
  // TTL cleaner scans for uncommitted, expired revisions.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_revisions_ttl
      ON ${VS_REVISIONS_TABLE}(ttl_expires_at)
      WHERE ttl_expires_at IS NOT NULL
  `);
  // Commit-completeness and deferred-finalize bookkeeping (additive; existing
  // deployments that ran migration v5 pick these up via the lazy ensure path).
  await client.query(`
    ALTER TABLE ${VS_REVISIONS_TABLE}
      ADD COLUMN IF NOT EXISTS page_count          INTEGER,
      ADD COLUMN IF NOT EXISTS has_document_end    BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS commit_state        TEXT,
      ADD COLUMN IF NOT EXISTS prior_revision_id   TEXT,
      ADD COLUMN IF NOT EXISTS commit_requested_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS extract_provenance  JSONB,
      ADD COLUMN IF NOT EXISTS source_id           TEXT,
      ADD COLUMN IF NOT EXISTS document_info       JSONB,
      ADD COLUMN IF NOT EXISTS allowed_users       TEXT[],
      ADD COLUMN IF NOT EXISTS allowed_groups      TEXT[]
  `);
  // The worker / finalize sweep looks up revisions with an unfinished commit.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_revisions_commit_pending
      ON ${VS_REVISIONS_TABLE}(commit_state)
      WHERE commit_state IN ('requested', 'cleanup')
  `);

  // ── vs_ingest_batches ───────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${VS_INGEST_BATCHES_TABLE} (
      tenant_id       TEXT NOT NULL,
      collection      TEXT NOT NULL,
      revision_id     TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'received',
      digest          TEXT NOT NULL,
      page_start      INTEGER,
      page_end        INTEGER,
      payload         BYTEA,
      next_attempt_at TIMESTAMPTZ,
      created         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      modified        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, revision_id, seq)
    )
  `);
  // Asset references captured at staging (so GET state never decodes
  // payloads) and the worker lease (claim token + attempt counter).
  await client.query(`
    ALTER TABLE ${VS_INGEST_BATCHES_TABLE}
      ADD COLUMN IF NOT EXISTS asset_ids   TEXT[],
      ADD COLUMN IF NOT EXISTS lease_token TEXT,
      ADD COLUMN IF NOT EXISTS attempts    INTEGER NOT NULL DEFAULT 0
  `);
  // The SKIP LOCKED worker claims batches by status, oldest first.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_ingest_batches_worker
      ON ${VS_INGEST_BATCHES_TABLE}(status, next_attempt_at, created)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_ingest_batches_revision
      ON ${VS_INGEST_BATCHES_TABLE}(tenant_id, collection, revision_id)
  `);

  // ── vs_segments ─────────────────────────────────────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${VS_SEGMENTS_TABLE} (
      tenant_id    TEXT NOT NULL,
      collection   TEXT NOT NULL,
      revision_id  TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      page_start   INTEGER NOT NULL,
      page_end     INTEGER NOT NULL,
      committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, revision_id, seq)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_segments_revision
      ON ${VS_SEGMENTS_TABLE}(tenant_id, collection, revision_id)
  `);

  // ── vs_document_revisions (per-document pointer) ───────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${VS_DOCUMENT_REVISIONS_TABLE} (
      tenant_id           TEXT NOT NULL,
      collection          TEXT NOT NULL,
      reference           TEXT NOT NULL,
      current_revision_id TEXT NOT NULL,
      modified            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, reference)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_document_revisions_current
      ON ${VS_DOCUMENT_REVISIONS_TABLE}(tenant_id, collection, current_revision_id)
  `);

  await ensureDocumentIdentityTablesLocked(client);
}

/**
 * Source registry, mail thread index and document groups. Global tables scoped
 * by (tenant, collection) like the rest of the v2 system tables.
 *
 *   vs_document_sources  one row per ingest (the Extract job id is the
 *                        source_id): the canonical reference it resolved to,
 *                        the file hash, the normalised-text hash and MinHash,
 *                        the version, the row ACL it was ingested under, and
 *                        whether it was indexed or skipped as a duplicate. A pending row is a claim that makes a
 *                        concurrent ingest of the same file a duplicate.
 *   vs_mail_messages     every Message-ID seen (as a message or only as a
 *                        reference) → its thread. Placeholders (reference IS
 *                        NULL) let a reply that arrives first join the thread
 *                        its parent later lands in.
 *   vs_document_groups   document → group id. E-mails carry their thread id;
 *                        an attachment carries its parent and inherits the
 *                        parent's group at read time.
 */
async function ensureDocumentIdentityTablesLocked(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${VS_DOCUMENT_SOURCES_TABLE} (
      tenant_id           TEXT NOT NULL,
      collection          TEXT NOT NULL,
      source_id           TEXT NOT NULL,
      reference           TEXT NOT NULL,
      requested_reference TEXT NOT NULL,
      document_key        TEXT NOT NULL,
      filename            TEXT,
      mime_type           TEXT,
      source_sha256       TEXT NOT NULL,
      text_hash           TEXT,
      minhash             INTEGER[],
      message_id          TEXT,
      version             JSONB,
      allowed_users       TEXT[] NOT NULL DEFAULT '{}',
      allowed_groups      TEXT[] NOT NULL DEFAULT '{}',
      status              TEXT NOT NULL DEFAULT 'pending',
      revision_id         TEXT,
      duplicate_of        JSONB,
      claim_expires_at    TIMESTAMPTZ,
      created             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      modified            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, source_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_document_sources_sha
      ON ${VS_DOCUMENT_SOURCES_TABLE}(tenant_id, collection, source_sha256)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_document_sources_text
      ON ${VS_DOCUMENT_SOURCES_TABLE}(tenant_id, collection, text_hash)
      WHERE text_hash IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_document_sources_key
      ON ${VS_DOCUMENT_SOURCES_TABLE}(tenant_id, collection, document_key)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_document_sources_reference
      ON ${VS_DOCUMENT_SOURCES_TABLE}(tenant_id, collection, reference)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_document_sources_message
      ON ${VS_DOCUMENT_SOURCES_TABLE}(tenant_id, collection, message_id)
      WHERE message_id IS NOT NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${VS_MAIL_MESSAGES_TABLE} (
      tenant_id    TEXT NOT NULL,
      collection   TEXT NOT NULL,
      message_id   TEXT NOT NULL,
      thread_id    TEXT NOT NULL,
      reference    TEXT,
      subject_norm TEXT,
      participants TEXT[],
      sent_at      TIMESTAMPTZ,
      created      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, message_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_mail_messages_thread
      ON ${VS_MAIL_MESSAGES_TABLE}(tenant_id, collection, thread_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_mail_messages_subject
      ON ${VS_MAIL_MESSAGES_TABLE}(tenant_id, collection, subject_norm)
      WHERE reference IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_mail_messages_reference
      ON ${VS_MAIL_MESSAGES_TABLE}(tenant_id, collection, reference)
      WHERE reference IS NOT NULL
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${VS_DOCUMENT_GROUPS_TABLE} (
      tenant_id        TEXT NOT NULL,
      collection       TEXT NOT NULL,
      reference        TEXT NOT NULL,
      group_id         TEXT,
      parent_reference TEXT,
      kind             TEXT NOT NULL,
      sort_at          TIMESTAMPTZ,
      title            TEXT,
      modified         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, reference)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_document_groups_group
      ON ${VS_DOCUMENT_GROUPS_TABLE}(tenant_id, collection, group_id)
      WHERE group_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_document_groups_parent
      ON ${VS_DOCUMENT_GROUPS_TABLE}(tenant_id, collection, parent_reference)
      WHERE parent_reference IS NOT NULL
  `);
}

/** vs_assets: the revision-bound asset table that replaces vs_document_assets. */
export async function ensureAssetsTable(client: PoolClient): Promise<void> {
  // Lazy ensure: a catalog check first, so the no-op DDL never takes table
  // locks on a live vs_assets.
  if (await assetsTableIsCurrent(client)) return;
  await withSchemaDdlLock(client, async () => {
    if (await assetsTableIsCurrent(client)) return;
    await ensureAssetsTableLocked(client);
  });
}

async function assetsTableIsCurrent(client: PoolClient): Promise<boolean> {
  const res = await client.query<{ current: boolean | null }>(
    `SELECT to_regclass($1) IS NOT NULL
        AND to_regclass('idx_vs_assets_revision') IS NOT NULL
        AND to_regclass('idx_vs_assets_kind') IS NOT NULL AS current`,
    [VS_ASSETS_TABLE],
  );
  return res.rows[0]?.current === true;
}

async function ensureAssetsTableLocked(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${VS_ASSETS_TABLE} (
      tenant_id          TEXT NOT NULL,
      collection         TEXT NOT NULL,
      asset_id           TEXT NOT NULL,
      kind               TEXT NOT NULL DEFAULT 'figure',
      document_reference TEXT NOT NULL,
      revision_id        TEXT,
      figure_id          TEXT,
      page               INTEGER,
      bbox               JSONB,
      width              INTEGER,
      height             INTEGER,
      variant            TEXT NOT NULL DEFAULT 'full',
      mime_type          TEXT NOT NULL,
      data               BYTEA NOT NULL,
      checksum           TEXT,
      created            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      modified           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, collection, asset_id, variant)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_assets_document
      ON ${VS_ASSETS_TABLE}(tenant_id, collection, document_reference)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_assets_figure
      ON ${VS_ASSETS_TABLE}(tenant_id, collection, document_reference, figure_id)
  `);
  // Assets are bound to a revision and cleaned with it (Requirement 14.3).
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_assets_revision
      ON ${VS_ASSETS_TABLE}(tenant_id, collection, revision_id)
      WHERE revision_id IS NOT NULL
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vs_assets_kind
      ON ${VS_ASSETS_TABLE}(kind)
  `);
}

/**
 * Copy legacy rows from vs_document_assets into vs_assets so existing assets
 * keep resolving after the cutover. Additive and idempotent: legacy rows land
 * as kind='figure', variant='full' with a NULL revision_id (v1 ingest wrote no
 * revision), and ON CONFLICT DO NOTHING skips anything already migrated.
 *
 * The whole thing is guarded on the legacy table's existence so a fresh
 * deployment (which never created vs_document_assets) is a clean no-op.
 */
export async function backfillAssetsFromDocumentAssets(
  client: PoolClient,
): Promise<void> {
  const legacy = await client.query<{ t: string | null }>(
    `SELECT to_regclass($1) AS t`,
    ["vs_document_assets"],
  );
  if (legacy.rows[0]?.t == null) return;

  await client.query(`
    INSERT INTO ${VS_ASSETS_TABLE}
      (tenant_id, collection, asset_id, kind, document_reference, revision_id,
       figure_id, page, bbox, width, height, variant, mime_type, data, checksum,
       created, modified)
    SELECT
      a.tenant_id, a.collection, a.asset_id, 'figure', a.document_reference, NULL,
      a.figure_id, NULL, NULL, NULL, NULL, 'full', a.mime_type, a.data, a.checksum,
      a.created, a.modified
    FROM vs_document_assets a
    ON CONFLICT (tenant_id, collection, asset_id, variant) DO NOTHING
  `);
}
