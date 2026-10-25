// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * asset-store.ts
 *
 * The v2 AssetStore backing the asset API. It owns
 * every query against the `vs_assets` table (defined in revision-schema.ts,
 * task 1.8) and is the swappable storage abstraction Requirement 14.2 asks for:
 *
 *   - `postgres`   — asset bytes live in the `data` BYTEA column (the default).
 *   - `filesystem` — asset bytes live in a volume under a configured root; the
 *                    `vs_assets` row still carries all metadata (kind, page,
 *                    bbox, variant, mime, checksum) and a pointer.
 *
 * Semantics implemented here (Requirements 5.8, 14.1, 14.3, 14.5):
 *   - PUT is idempotent on the SHA-256 checksum: the same bytes for the same
 *     (asset_id, variant) are a no-op (200); different bytes replace them (201
 *     when the row is new). The two derived variants (thumb 512px, preview
 *     1568px edge) are generated eagerly via sharp and stored as their own rows,
 *     so a GET is a pure read.
 *   - HEAD reports existence of a variant without returning bytes.
 *   - GET returns a variant, enforcing the tenant / collection / row ACL of the
 *     asset's revision (14.5) — the read only resolves when the asset's document
 *     is visible to the caller in the collection's row-ACL'd table: a legacy v1
 *     row (chunk.parent_ref) or a v2 unit row of the document's CURRENT revision
 *     (vs_document_revisions pointer). Fail-closed otherwise.
 *   - Assets are bound to a revision via `revision_id`. PUT verifies that the
 *     named revision exists in the same tenant + collection, belongs to the
 *     same document and is not aborted, and never re-binds an asset that is
 *     already bound to another live revision. The cleanup when the revision is
 *     aborted/reaped is owned by the revision store. Legacy figure assets carry
 *     a NULL revision_id and keep resolving.
 *
 * Row-level tenant isolation is enforced in every statement via `tenant_id`.
 * Collection authorization is enforced by the route middleware before any
 * method here runs; the row ACL is enforced here on read.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { AccessScope } from "./access-scope.js";
import { collectionTableName } from "./collection-ddl.js";
import { normalizeReference } from "./postgres-client.js";
import { SqlParams, buildAccessSql } from "./query-builder.js";
import { ensureRevisionSchema } from "./revision-schema.js";
import {
  type AssetVariant,
  generateDerivedVariants,
  probeImageSize,
} from "./asset-variants.js";

const ASSETS = "vs_assets";

/** Asset kinds the store manages (AssetRef vocabulary, Requirement 14.1). */
export type AssetKind = "figure" | "page" | "tile" | "native";

// ─── Result shape (mirrors RevisionStore) ───────────────────────────────────

export interface AssetStoreError {
  status: number;
  code: string;
  message: string;
}

export type AssetStoreResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: AssetStoreError };

function ok<T>(result: T): AssetStoreResult<T> {
  return { ok: true, result };
}

function fail<T>(error: AssetStoreError): AssetStoreResult<T> {
  return { ok: false, error };
}

// ─── Inputs / outputs ───────────────────────────────────────────────────────

export interface AssetScope {
  tenantId: string;
  collection: string;
}

export interface PutAssetInput extends AssetScope {
  assetId: string;
  kind: AssetKind;
  documentReference: string;
  /** Revision this asset is bound to; null for legacy/unbound assets. */
  revisionId: string | null;
  figureId: string | null;
  page: number | null;
  bbox: number[] | null;
  mimeType: string;
  data: Buffer;
}

export interface PutAssetResult {
  assetId: string;
  checksum: string;
  /** false when an identical-checksum row already existed (idempotent no-op). */
  created: boolean;
  /** The derived variants that were (re)generated, e.g. ["thumb","preview"]. */
  variants: AssetVariant[];
}

export interface GetAssetResult {
  assetId: string;
  variant: AssetVariant;
  mimeType: string;
  data: Buffer;
  checksum: string | null;
  width: number | null;
  height: number | null;
}

export interface HeadAssetResult {
  exists: boolean;
  mimeType?: string;
  checksum?: string | null;
  length?: number;
}

/**
 * The identity + coordinate metadata of an asset's `full` variant.
 * Used by the MCP `get_asset` tool to (a) fail closed on a document/figure
 * mismatch before returning bytes, and (b) build the render-cache binding /
 * target for a `region` zoom (page + bbox + revision). ACL-enforced like
 * {@link AssetStore.get}.
 */
export interface AssetMeta {
  assetId: string;
  kind: AssetKind;
  documentReference: string;
  revisionId: string | null;
  figureId: string | null;
  page: number | null;
  bbox: number[] | null;
  mimeType: string;
}

export interface AssetStore {
  ensureSchema(): Promise<void>;
  /** Store an asset (full + derived variants), idempotent on the checksum. */
  put(input: PutAssetInput, scope: AccessScope): Promise<AssetStoreResult<PutAssetResult>>;
  /** Read a variant, enforcing the revision's row ACL (Requirement 14.5). */
  get(
    assetScope: AssetScope,
    assetId: string,
    variant: AssetVariant,
    scope: AccessScope,
  ): Promise<AssetStoreResult<GetAssetResult | null>>;
  /** Existence check for a variant, enforcing the same row ACL as get. */
  head(
    assetScope: AssetScope,
    assetId: string,
    variant: AssetVariant,
    scope: AccessScope,
  ): Promise<AssetStoreResult<HeadAssetResult>>;
  /**
   * Read an asset's identity + coordinate metadata (kind, document, revision,
   * figure id, page, bbox) without its bytes, enforcing the same row ACL as
   * {@link AssetStore.get}. Returns null when the asset does not exist or is not
   * visible to the caller. (task 3.9 — `get_asset` fail-closed + region zoom.)
   */
  getMeta(
    assetScope: AssetScope,
    assetId: string,
    scope: AccessScope,
  ): Promise<AssetStoreResult<AssetMeta | null>>;
}

// ─── Byte backend abstraction ───────────────────────────────────────────────

/**
 * Where the raw variant bytes live. `postgres` keeps them in the row; the
 * filesystem backend writes them to a volume and the row's `data` column holds
 * a small UTF-8 pointer (the relative path) instead of the image.
 */
interface ByteBackend {
  /** Serialize what goes into the `data` column for this variant. */
  write(key: AssetKey, variant: AssetVariant, bytes: Buffer): Promise<Buffer>;
  /** Resolve the actual bytes from what the `data` column holds. */
  read(key: AssetKey, variant: AssetVariant, column: Buffer): Promise<Buffer>;
  /** Best-effort removal of any external bytes for a variant (filesystem). */
  remove(key: AssetKey, variant: AssetVariant, column: Buffer): Promise<void>;
}

interface AssetKey {
  tenantId: string;
  collection: string;
  assetId: string;
}

/** The default backend: bytes ARE the `data` column. */
const postgresBackend: ByteBackend = {
  async write(_key, _variant, bytes) {
    return bytes;
  },
  async read(_key, _variant, column) {
    return column;
  },
  async remove() {
    /* nothing external to remove */
  },
};

/**
 * Encode a value as ONE collision-free, traversal-safe path segment: the
 * lowercase hex of its UTF-8 bytes, or `sha256-<hex digest>` when that would
 * exceed {@link MAX_SEGMENT_CHARS} (filesystem name limits). Both forms only
 * use [0-9a-f-] and cannot collide with each other (hex never contains '-').
 * Replacing unsafe characters with '_' (the previous scheme) mapped distinct
 * tenants / collections / ids like `a/b` and `a_b` onto the same file.
 */
const MAX_SEGMENT_CHARS = 200;
export function encodePathSegment(value: string): string {
  const hex = Buffer.from(value, "utf8").toString("hex");
  if (hex.length > 0 && hex.length <= MAX_SEGMENT_CHARS) return hex;
  return `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Filesystem backend: writes bytes under `<root>/<tenant>/<collection>/
 * <assetId>/<variant>` (each segment hex-encoded, see {@link encodePathSegment})
 * and stores that relative path in the `data` column. Rows written by the
 * previous layout keep resolving: reads use the path stored in the row.
 */
function createFilesystemBackend(root: string): ByteBackend {
  const absRoot = resolve(root);
  function relPath(key: AssetKey, variant: AssetVariant): string {
    return join(
      encodePathSegment(key.tenantId),
      encodePathSegment(key.collection),
      encodePathSegment(key.assetId),
      encodePathSegment(variant),
    );
  }
  function absPath(rel: string): string {
    const abs = resolve(absRoot, rel);
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) {
      throw new Error("asset path escapes the store root");
    }
    return abs;
  }
  return {
    async write(key, variant, bytes) {
      const rel = relPath(key, variant);
      const abs = absPath(rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      return Buffer.from(rel, "utf8");
    },
    async read(_key, _variant, column) {
      const rel = column.toString("utf8");
      return readFile(absPath(rel));
    },
    async remove(_key, _variant, column) {
      const rel = column.toString("utf8");
      try {
        await rm(absPath(rel), { force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface AssetStoreConfig {
  backend: "postgres" | "filesystem";
  /** Filesystem root; required when backend === "filesystem". */
  dir?: string | null;
}

export function createAssetStore(pool: Pool, config: AssetStoreConfig): AssetStore {
  const backend: ByteBackend =
    config.backend === "filesystem"
      ? createFilesystemBackend(
          config.dir ??
            (() => {
              throw new Error("ASSET_STORE_DIR is required for the filesystem backend");
            })(),
        )
      : postgresBackend;

  async function withClient<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<AssetStoreResult<T>> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (cause) {
      return fail({
        status: 503,
        code: "POSTGRES_UNREACHABLE",
        message: cause instanceof Error ? cause.message : "database unreachable",
      });
    }
    try {
      return ok(await fn(client));
    } catch (cause) {
      if (cause instanceof AssetStoreThrow) return fail(cause.error);
      return fail({
        status: 502,
        code: "ASSET_STORE_ERROR",
        message: cause instanceof Error ? cause.message : "asset store error",
      });
    } finally {
      client.release();
    }
  }

  /**
   * Enforce the row ACL of the asset's revision (Requirement 14.5). The read
   * only resolves when the asset's document is visible to the caller in the
   * collection's row-ACL'd table — the same EXISTS-against-the-collection-table
   * check the v1 asset path uses, so v1 legacy figure assets keep resolving.
   *
   * Service / bypass principals skip the row check (they already passed the
   * collection ACL); buildAccessSql emits only the tenant predicate for them.
   */
  function aclExistsClause(
    scope: AccessScope,
    p: SqlParams,
    collection: string,
  ): string {
    // authorizationBypass / service: buildAccessSql restricts to tenant only,
    // and these principals are trusted to read any row in the collection.
    if (scope.authorizationBypass || scope.service) return "";
    const table = collectionTableName(collection);
    const access = buildAccessSql(p, scope, "d");
    const collectionPh = p.add(collection);
    // Two ways a document row can grant the read:
    //   - a legacy v1 row (revision_id IS NULL), keyed by chunk.parent_ref;
    //   - a v2 unit row (which has no `chunk`), keyed by document_id, that
    //     belongs to the document's CURRENT revision per the pointer — the same
    //     visibility rule search applies. An asset bound to a revision must be
    //     read through that document's rows; unbound (legacy) assets may be
    //     read through either shape of the same document.
    // Anything else (no visible row, or a row the caller's ACL excludes) finds
    // no match, so the read fails closed.
    return ` AND EXISTS (
      SELECT 1 FROM "${table}" d
       WHERE d.is_latest = TRUE
         AND d.tenant_id = a.tenant_id
         AND (
           (d.revision_id IS NULL AND d.chunk->>'parent_ref' = a.document_reference)
           OR (
             d.revision_id IS NOT NULL
             AND d.document_id = a.document_reference
             AND d.revision_id = (
               SELECT dr.current_revision_id FROM vs_document_revisions dr
                WHERE dr.tenant_id = d.tenant_id AND dr.collection = ${collectionPh}
                  AND dr.reference = d.document_id)
           )
         )
         ${access}
    )`;
  }


  /**
   * The body of {@link AssetStore.put}, inside a transaction. The revision row
   * (when one is named) is held FOR SHARE until COMMIT, so an abort — which
   * takes FOR UPDATE before cascading the revision's assets — either sees this
   * asset and deletes it, or makes this PUT fail with REVISION_CLOSED; an asset
   * is never left bound to an aborted revision.
   */
  async function putLocked(
    client: PoolClient,
    input: PutAssetInput,
    documentReference: string,
    key: AssetKey,
    checksum: string,
  ): Promise<PutAssetResult> {
    const { tenantId, collection } = input;
    if (input.revisionId !== null) {
      const revision = await client.query<{ reference: string; status: string }>(
        `SELECT reference, status FROM vs_revisions
          WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3
          FOR SHARE`,
        [tenantId, collection, input.revisionId],
      );
      const rev = revision.rows[0];
      if (!rev) {
        throw new AssetStoreThrow({
          status: 404,
          code: "REVISION_NOT_FOUND",
          message: "the revision does not exist in this tenant and collection",
        });
      }
      if (rev.status === "aborted") {
        throw new AssetStoreThrow({
          status: 409,
          code: "REVISION_CLOSED",
          message: "the revision was aborted and no longer accepts assets",
        });
      }
      if (normalizeReference(rev.reference) !== documentReference) {
        throw new AssetStoreThrow({
          status: 409,
          code: "REVISION_DOCUMENT_MISMATCH",
          message: "the revision belongs to a different document",
        });
      }
    }

    // Lock the existing `full` row (if any) so concurrent PUTs of the same
    // asset serialize on it.
    const existing = await client.query<{
      checksum: string | null;
      document_reference: string;
      revision_id: string | null;
      bound_status: string | null;
    }>(
      `SELECT a.checksum, a.document_reference, a.revision_id, r.status AS bound_status
         FROM ${ASSETS} a
         LEFT JOIN vs_revisions r
           ON r.tenant_id = a.tenant_id AND r.collection = a.collection
          AND r.revision_id = a.revision_id
        WHERE a.tenant_id = $1 AND a.collection = $2 AND a.asset_id = $3 AND a.variant = 'full'
        FOR UPDATE OF a`,
      [tenantId, collection, input.assetId],
    );
    const prior = existing.rows[0];
    if (prior && prior.document_reference !== documentReference) {
      // Asset ids are derived from the document reference; the same id under
      // another document is a forged / foreign id. Never re-home it.
      throw new AssetStoreThrow({
        status: 409,
        code: "ASSET_DOCUMENT_CONFLICT",
        message: "the asset id is already bound to a different document",
      });
    }
    // Never move an asset onto another revision while its current binding is
    // live: keep the existing binding (an unbound legacy asset stays unbound).
    // Only a binding whose revision is gone or aborted is replaced.
    const bindingLive =
      prior !== undefined &&
      (prior.revision_id === null || (prior.bound_status !== null && prior.bound_status !== "aborted"));
    const revisionId = prior !== undefined && bindingLive ? prior.revision_id : input.revisionId;

    const priorChecksum = prior?.checksum ?? null;
    if (prior && priorChecksum === checksum) {
      // Same bytes already stored — no rewrite, no re-generation (5.8). The
      // metadata the PUT carries is still backfilled: a re-emit after a
      // metadata fix (figure id / page / bbox were once dropped on ingest) has
      // identical bytes but must not leave the stale NULL metadata in place.
      // COALESCE keeps existing values when the PUT omits them.
      const bboxJson = input.bbox === null || input.bbox === undefined ? null : JSON.stringify(input.bbox);
      await client.query(
        `UPDATE ${ASSETS} SET
           revision_id = CASE WHEN $4::text IS NOT NULL THEN $4::text ELSE revision_id END,
           figure_id = COALESCE($5::text, figure_id),
           page = COALESCE($6::int, page),
           bbox = COALESCE($7::jsonb, bbox),
           modified = NOW()
         WHERE tenant_id = $1 AND collection = $2 AND asset_id = $3
           AND (($4::text IS NOT NULL AND revision_id IS DISTINCT FROM $4::text)
             OR ($5::text IS NOT NULL AND figure_id IS DISTINCT FROM $5::text)
             OR ($6::int IS NOT NULL AND page IS DISTINCT FROM $6::int)
             OR ($7::jsonb IS NOT NULL AND bbox IS DISTINCT FROM $7::jsonb))`,
        [
          tenantId,
          collection,
          input.assetId,
          bindingLive ? null : revisionId,
          input.figureId ?? null,
          input.page ?? null,
          bboxJson,
        ],
      );
      return {
        assetId: input.assetId,
        checksum,
        created: false,
        variants: [],
      };
    }

    // Probe dimensions and derive thumb/preview. A non-image body fails
    // closed rather than storing an un-derivable asset.
    const fullSize = await probeImageSize(input.data);
    let derived: Awaited<ReturnType<typeof generateDerivedVariants>>;
    try {
      derived = await generateDerivedVariants(input.data, input.mimeType);
    } catch (cause) {
      throw new AssetStoreThrow({
        status: 400,
        code: "ASSET_NOT_DECODABLE",
        message: cause instanceof Error ? cause.message : "asset bytes are not a decodable image",
      });
    }

    // Rows to write: the full original plus the two derived variants.
    const rows: Array<{
      variant: AssetVariant;
      mimeType: string;
      bytes: Buffer;
      width: number | null;
      height: number | null;
    }> = [
      {
        variant: "full",
        mimeType: input.mimeType,
        bytes: input.data,
        width: fullSize?.width ?? null,
        height: fullSize?.height ?? null,
      },
      ...derived.map((d) => ({
        variant: d.variant as AssetVariant,
        mimeType: d.mimeType,
        bytes: d.data,
        width: d.width,
        height: d.height,
      })),
    ];

    for (const row of rows) {
      const rowChecksum = createHash("sha256").update(row.bytes).digest("hex");
      const column = await backend.write(key, row.variant, row.bytes);
      await client.query(
        `INSERT INTO ${ASSETS}
           (tenant_id, collection, asset_id, kind, document_reference, revision_id,
            figure_id, page, bbox, width, height, variant, mime_type, data, checksum)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (tenant_id, collection, asset_id, variant) DO UPDATE SET
           kind = EXCLUDED.kind,
           document_reference = EXCLUDED.document_reference,
           revision_id = EXCLUDED.revision_id,
           figure_id = EXCLUDED.figure_id,
           page = EXCLUDED.page,
           bbox = EXCLUDED.bbox,
           width = EXCLUDED.width,
           height = EXCLUDED.height,
           mime_type = EXCLUDED.mime_type,
           data = EXCLUDED.data,
           checksum = EXCLUDED.checksum,
           modified = NOW()`,
        [
          tenantId,
          collection,
          input.assetId,
          input.kind,
          documentReference,
          revisionId,
          input.figureId,
          input.page,
          input.bbox === null ? null : JSON.stringify(input.bbox),
          row.width,
          row.height,
          row.variant,
          row.mimeType,
          column,
          rowChecksum,
        ],
      );
    }

    return {
      assetId: input.assetId,
      checksum,
      created: priorChecksum === null,
      variants: derived.map((d) => d.variant as AssetVariant),
    };
  }

  return {
    async ensureSchema(): Promise<void> {
      const client = await pool.connect();
      try {
        // vs_assets plus vs_revisions (PUT validates the bound revision), in one
        // transaction under the shared schema-DDL advisory lock.
        await ensureRevisionSchema(client, { skipIfCurrent: true });
      } finally {
        client.release();
      }
    },

    async put(input, scope): Promise<AssetStoreResult<PutAssetResult>> {
      const { tenantId, collection } = input;
      if (!tenantId.trim() || tenantId !== scope.tenantId) {
        return fail({ status: 403, code: "TENANT_REQUIRED", message: "tenant context is required" });
      }
      const documentReference = normalizeReference(input.documentReference);
      const key: AssetKey = { tenantId, collection, assetId: input.assetId };
      const checksum = createHash("sha256").update(input.data).digest("hex");

      return withClient(async (client) => {
        await client.query("BEGIN");
        try {
          const result = await putLocked(client, input, documentReference, key, checksum);
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
      });
    },

    async get(assetScope, assetId, variant, scope): Promise<AssetStoreResult<GetAssetResult | null>> {
      const { tenantId, collection } = assetScope;
      if (!tenantId.trim() || tenantId !== scope.tenantId) {
        return fail({ status: 403, code: "TENANT_REQUIRED", message: "tenant context is required" });
      }
      return withClient(async (client) => {
        const p = new SqlParams();
        const assetIdPh = p.add(assetId);
        const collectionPh = p.add(collection);
        const tenantPh = p.add(tenantId);
        const variantPh = p.add(variant);
        const acl = aclExistsClause(scope, p, collection);
        const result = await client.query<{
          asset_id: string;
          variant: string;
          mime_type: string;
          data: Buffer;
          checksum: string | null;
          width: number | null;
          height: number | null;
        }>(
          `SELECT a.asset_id, a.variant, a.mime_type, a.data, a.checksum, a.width, a.height
             FROM ${ASSETS} a
            WHERE a.asset_id = ${assetIdPh} AND a.collection = ${collectionPh}
              AND a.tenant_id = ${tenantPh} AND a.variant = ${variantPh}${acl}`,
          p.values,
        );
        const row = result.rows[0];
        if (!row) return null;
        const bytes = await backend.read(
          { tenantId, collection, assetId },
          row.variant as AssetVariant,
          row.data,
        );
        return {
          assetId: row.asset_id,
          variant: row.variant as AssetVariant,
          mimeType: row.mime_type,
          data: bytes,
          checksum: row.checksum,
          width: row.width,
          height: row.height,
        };
      });
    },

    async head(assetScope, assetId, variant, scope): Promise<AssetStoreResult<HeadAssetResult>> {
      const { tenantId, collection } = assetScope;
      if (!tenantId.trim() || tenantId !== scope.tenantId) {
        return fail({ status: 403, code: "TENANT_REQUIRED", message: "tenant context is required" });
      }
      return withClient(async (client) => {
        const p = new SqlParams();
        const assetIdPh = p.add(assetId);
        const collectionPh = p.add(collection);
        const tenantPh = p.add(tenantId);
        const variantPh = p.add(variant);
        const acl = aclExistsClause(scope, p, collection);
        const result = await client.query<{
          mime_type: string;
          checksum: string | null;
          length: string | number;
        }>(
          `SELECT a.mime_type, a.checksum, octet_length(a.data) AS length
             FROM ${ASSETS} a
            WHERE a.asset_id = ${assetIdPh} AND a.collection = ${collectionPh}
              AND a.tenant_id = ${tenantPh} AND a.variant = ${variantPh}${acl}`,
          p.values,
        );
        const row = result.rows[0];
        if (!row) return { exists: false };
        // For the filesystem backend the `data` column holds a pointer, not the
        // bytes, so its octet_length is the pointer length — HEAD reports the
        // stored checksum instead, which is authoritative for both backends.
        return {
          exists: true,
          mimeType: row.mime_type,
          checksum: row.checksum,
          ...(config.backend === "postgres" ? { length: Number(row.length) } : {}),
        };
      });
    },

    async getMeta(assetScope, assetId, scope): Promise<AssetStoreResult<AssetMeta | null>> {
      const { tenantId, collection } = assetScope;
      if (!tenantId.trim() || tenantId !== scope.tenantId) {
        return fail({ status: 403, code: "TENANT_REQUIRED", message: "tenant context is required" });
      }
      return withClient(async (client) => {
        const p = new SqlParams();
        const assetIdPh = p.add(assetId);
        const collectionPh = p.add(collection);
        const tenantPh = p.add(tenantId);
        const acl = aclExistsClause(scope, p, collection);
        const result = await client.query<{
          asset_id: string;
          kind: string;
          document_reference: string;
          revision_id: string | null;
          figure_id: string | null;
          page: number | null;
          bbox: unknown;
          mime_type: string;
        }>(
          `SELECT a.asset_id, a.kind, a.document_reference, a.revision_id,
                  a.figure_id, a.page, a.bbox, a.mime_type
             FROM ${ASSETS} a
            WHERE a.asset_id = ${assetIdPh} AND a.collection = ${collectionPh}
              AND a.tenant_id = ${tenantPh} AND a.variant = 'full'${acl}`,
          p.values,
        );
        const row = result.rows[0];
        if (!row) return null;
        const bbox =
          Array.isArray(row.bbox) && row.bbox.every((n) => typeof n === "number")
            ? (row.bbox as number[])
            : null;
        return {
          assetId: row.asset_id,
          kind: row.kind as AssetKind,
          documentReference: row.document_reference,
          revisionId: row.revision_id,
          figureId: row.figure_id,
          page: row.page,
          bbox,
          mimeType: row.mime_type,
        };
      });
    },
  };
}

// ─── Internal ────────────────────────────────────────────────────────────────

class AssetStoreThrow extends Error {
  constructor(readonly error: AssetStoreError) {
    super(error.message);
    this.name = "AssetStoreThrow";
  }
}
