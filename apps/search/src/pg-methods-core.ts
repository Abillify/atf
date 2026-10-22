// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * postgres-client methods: Core PostgresClient methods: pgvector version gate, invocation ledger, stats counters, collection bootstrap, upsert, delete and close.
 *
 * Extracted verbatim from postgres-client.ts (Requirement 13.6).
 * Shared factory state arrives via PgFactoryCtx; bodies are
 * unchanged.
 */

import type { AccessScope } from "./access-scope.js";
import { AppError, buildUpsertSqlParts, collectionTableName, ensureCollectionConfigTable, ensureCollectionDDL, loadCollectionMeta, pushExtraParams, validateFtsLanguage, type CollectionMeta } from "./collection-ddl.js";
import { deleteDocumentCascade } from "./revision-store.js";
import { createHash, createHmac } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  buildFtsContextHeader,
  buildFtsText,
  normalizeReference,
  sanitizePointText,
} from "./pg-helpers.js";
import type { CircuitBreakerStatus, DocumentPoint, PostgresResponse, SearchFilter } from "./pg-types.js";

import type { PgFactoryCtx } from "./pg-factory-ctx.js";

export function createCoreMethods(ctx: PgFactoryCtx) {
  /**
   * Push the FTS_CONTEXTUAL_HEADER parameter (document title + section path)
   * after the FTS content parameter and return its 1-based index, or null
   * when the option is off or the point carries no header. The caller must
   * push the tenant id AFTER this so the indices stay consistent.
   */
  const pushFtsContextHeader = (
    params: unknown[],
    point: DocumentPoint,
  ): number | null => {
    if (!ftsContextualHeader) return null;
    const header = buildFtsContextHeader(point);
    if (!header) return null;
    params.push(header);
    return params.length;
  };

  /**
   * tsvector SQL for the `ts_search` column. With a header parameter index
   * the header is weighted 'D' and concatenated with the content tsvector;
   * otherwise the expression is the plain content tsvector.
   */
  const tsSearchSql = (
    lang: string,
    ftsParam: number,
    headerParam: number | null,
  ): string =>
    headerParam === null
      ? `to_tsvector('${lang}', $${ftsParam})`
      : `setweight(to_tsvector('${lang}', $${headerParam}), 'D') || to_tsvector('${lang}', $${ftsParam})`;

  const {
    pool,
    logger,
    withClient,
    getOrLoadCollectionMeta,
    scopedWhere,
    ensuredCollections,
    ensureCollectionLocks,
    statsBuffer,
    checkPgvectorVersion,
    defaultFtsLanguage,
    ftsContextualHeader,
    statsStoreRawQuery,
    statsQueryPepper,
    quantizationConfig,
    circuitBreakerGetters,
    vecType,
    ddlConfig,
  } = ctx;

    // Post-delete cache-invalidation hook (task 4.2, Requirement 2.4). Set via
    // setOnDocumentsDeleted() after construction — the caches live in createApp,
    // which runs after the client. Invoked post-COMMIT with the affected refs.
    let onDocumentsDeleted:
      | ((collection: string, rootRefs: string[]) => void)
      | undefined;

  return {
    async ensurePgvectorVersion(): Promise<boolean | null> {
      return checkPgvectorVersion();
    },

    async queryInvocationLedger(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
      const response = await withClient(async (client) => {
        const result = await client.query(sql, [...params]);
        return {
          rows: result.rows as Array<Record<string, unknown>>,
          rowCount: result.rowCount ?? 0,
        };
      });
      if (!response.ok)
        throw new Error(response.error.message, {
          cause: response.error.cause,
        });
      return response.result;
    },

    getStatsCounters() {
      return statsBuffer.getCounters();
    },

    getCircuitBreakerStatuses(): CircuitBreakerStatus[] {
      return circuitBreakerGetters.map((get) => get());
    },

    recordSearchStat(stat: {
      tenantId: string;
      collection: string;
      query: string;
      durationMs: number;
      resultsCount: number;
      hybridSearch: boolean;
      reranked: boolean;
    }): void {
      // Query text may carry personal or confidential data. The stable hash
      // (HMAC when STATS_QUERY_PEPPER is set, plain SHA-256 otherwise) is
      // always stored; the raw term lands in the database only on explicit
      // opt-in via STATS_STORE_RAW_QUERY (Requirement 2.6).
      const queryHash = statsQueryPepper
        ? createHmac("sha256", statsQueryPepper)
            .update(stat.query)
            .digest("hex")
        : createHash("sha256").update(stat.query).digest("hex");
      statsBuffer.recordSearch({
        tenant_id: stat.tenantId,
        collection: stat.collection,
        query: statsStoreRawQuery ? stat.query : null,
        query_hash: queryHash,
        duration_ms: stat.durationMs,
        results_count: stat.resultsCount,
        hybrid_search: stat.hybridSearch,
        reranked: stat.reranked,
      });
    },

    async ensureCollection(
      collection: string,
      vectorSize: number,
      options?: {
        language?: string;
        sparseVocabSize?: number;
        quantization?: "none" | "binary";
        embeddingModel?: string;
        embeddingModelRevision?: string;
      },
    ): Promise<PostgresResponse<void>> {
      let table: string;
      try {
        table = collectionTableName(collection);
      } catch (cause) {
        return {
          ok: false,
          error: {
            code: "INVALID_COLLECTION_NAME",
            message: (cause as Error).message,
            cause,
          },
        };
      }

      const cachedMeta = ensuredCollections.get(table);
      if (cachedMeta) {
        const modelMismatch =
          options?.embeddingModel !== undefined &&
          cachedMeta.embeddingModel !== options.embeddingModel;
        const revisionMismatch =
          options?.embeddingModelRevision !== undefined &&
          cachedMeta.embeddingModelRevision !== options.embeddingModelRevision;
        if (modelMismatch || revisionMismatch) {
          return {
            ok: false,
            error: {
              code: "POSTGRES_INVALID_RESPONSE",
              message:
                "EMBEDDING_PROVENANCE_MISMATCH: provenance is unknown or differs; reindex into a new collection and cut over explicitly",
            },
          };
        }
        return { ok: true, result: undefined };
      }

      const pending = ensureCollectionLocks.get(table);
      if (pending) return pending;

      let language = defaultFtsLanguage;
      if (options?.language) {
        try {
          language = validateFtsLanguage(options.language);
        } catch (cause) {
          return {
            ok: false,
            error: {
              code: "POSTGRES_SQL_ERROR",
              message: (cause as Error).message,
              cause,
            },
          };
        }
      }
      const sparseVocabSize = options?.sparseVocabSize ?? null;
      const meta: CollectionMeta = {
        language,
        sparseEnabled: sparseVocabSize !== null,
        sparseVocabSize,
        quantization: options?.quantization ?? quantizationConfig,
        vectorSize,
        embeddingModel: options?.embeddingModel ?? null,
        embeddingModelRevision: options?.embeddingModelRevision ?? null,
      };

      const p = (async (): Promise<PostgresResponse<void>> => {
        const result = await withClient(async (client) => {
          // The first collection has no metadata table yet. Initialize it before
          // reading its row; ensureCollectionDDL is idempotent and repeats this
          // setup inside its own DDL path.
          await ensureCollectionConfigTable(client);
          const existing = await loadCollectionMeta(client, table);
          const modelMismatch =
            existing !== null &&
            meta.embeddingModel !== null &&
            existing.embeddingModel !== meta.embeddingModel;
          const revisionMismatch =
            existing !== null &&
            meta.embeddingModelRevision !== null &&
            existing.embeddingModelRevision !== meta.embeddingModelRevision;
          if (modelMismatch || revisionMismatch) {
            throw new AppError(
              "EMBEDDING_PROVENANCE_MISMATCH",
              "EMBEDDING_PROVENANCE_MISMATCH: provenance is unknown or differs; create a new collection, fully reindex, validate it, then use renameCollection for an explicit cutover",
            );
          }
          await ensureCollectionDDL(client, table, vectorSize, meta, ddlConfig);
          // Re-read from DB after DDL so the cache always reflects the
          // persisted state (handles the case where the table already existed
          // with different settings, e.g. fts_language changed externally).
          const persisted = await loadCollectionMeta(client, table);
          ensuredCollections.set(table, persisted ?? meta);
        });
        ensureCollectionLocks.delete(table);
        return result;
      })();

      ensureCollectionLocks.set(table, p);
      return p;
    },

    async upsert(
      point: DocumentPoint,
      collection: string,
      versionMode: "replace" | "version" = "replace",
    ): Promise<PostgresResponse<{ id: string }>> {
      if (!point.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      // Store keys in canonical NFC form so later exact/prefix lookups (which
      // normalize their args to NFC) match regardless of the source filesystem's
      // Unicode normalization. See normalizeReference.
      point = {
        ...sanitizePointText(point),
        reference: normalizeReference(point.reference),
        baseRef: normalizeReference(point.baseRef ?? point.reference),
      };
      const table = collectionTableName(collection);
      return withClient(async (client) => {
        const startTime = Date.now();
        const meta = await getOrLoadCollectionMeta(client, table);
        const lang = meta.language;
        const sql = buildUpsertSqlParts(meta, vecType);
        const aclConflictUpdate =
          point.preserveExistingAclOnConflict === true
            ? ""
            : "allowed_users = EXCLUDED.allowed_users, allowed_groups = EXCLUDED.allowed_groups,";

        if (versionMode === "replace") {
          // Fixed params: $1–$13 (reference, base_ref, content, vector, metadata, chunk,
          //   prefix, source, link, title, tags, allowed_users, allowed_groups)
          const params: unknown[] = [
            point.reference,
            point.baseRef ?? point.reference,
            point.content,
            JSON.stringify(point.vector),
            JSON.stringify(point.metadata),
            point.chunk ? JSON.stringify(point.chunk) : null,
            point.prefix ?? null,
            point.source ?? null,
            point.link ?? null,
            point.title ?? null,
            point.tags ?? [],
            point.allowedUsers ?? [],
            point.allowedGroups ?? [],
            point.validFrom ?? null,
          ];
          const extraBase = params.length; // 14
          pushExtraParams(params, point, meta);
          const sparseValSql = sql.sparseVal(extraBase);
          const binaryValSql = sql.binaryVal(
            extraBase + (meta.sparseEnabled ? 1 : 0),
          );
          // Append FTS-preprocessed content as the last parameter
          params.push(buildFtsText(point));
          const ftsParam = params.length; // e.g. $14, $15, $16 depending on extras
          const headerParam = pushFtsContextHeader(params, point);
          params.push(point.tenantId);
          const tenantParam = params.length;

          const result = await client.query<{
            id: string;
            was_insert: boolean;
          }>(
            `INSERT INTO "${table}"
               (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                prefix, source, link, title, tags, allowed_users, allowed_groups, valid_from, modified${sql.sparseCol}${sql.binaryCol}, tenant_id)
             VALUES ($1, $2, TRUE, $3, $4::${vecType}, ${tsSearchSql(lang, ftsParam, headerParam)}, $5, $6,
                     $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, NOW()${sparseValSql}${binaryValSql}, $${tenantParam})
             ON CONFLICT (tenant_id, reference) DO UPDATE SET
               content        = EXCLUDED.content,
               vector         = EXCLUDED.vector,
               ts_search      = EXCLUDED.ts_search,
               metadata       = EXCLUDED.metadata,
               chunk     = EXCLUDED.chunk,
               prefix = EXCLUDED.prefix,
               source         = EXCLUDED.source,
               link           = EXCLUDED.link,
               title          = EXCLUDED.title,
               tags           = EXCLUDED.tags,
               valid_from      = EXCLUDED.valid_from,
               ${aclConflictUpdate}
               is_latest      = TRUE,
               modified       = NOW()${sql.sparseUpdate}${sql.binaryUpdate}
             RETURNING id::text, (xmax = 0) AS was_insert`,
            params,
          );
          const row = result.rows[0]!;
          statsBuffer.recordIngest({
            tenant_id: point.tenantId!,
            collection,
            operation: row.was_insert ? "insert" : "update",
            reference: point.reference,
            duration_ms: Date.now() - startTime,
            chunks_processed: 1,
          });
          return { id: row.id };
        } else {
          // Version mode
          point = {
            ...point,
            metadata: {
              ...point.metadata,
              _atf_version_group:
                typeof point.metadata["_atf_version_group"] === "string"
                  ? point.metadata["_atf_version_group"]
                  : uuidv4(),
            },
          };
          await client.query("BEGIN");
          try {
            const baseRef = point.baseRef ?? point.reference;
            const versionedRef = point.version
              ? `${baseRef}_v${point.version}`
              : `${baseRef}_v${uuidv4()}`;

            if (point.version) {
              await client.query(
                `UPDATE "${table}" SET is_latest = FALSE
                 WHERE base_ref = $1 AND reference != $2 AND tenant_id = $3 AND is_latest = TRUE`,
                [baseRef, versionedRef, point.tenantId],
              );
            } else {
              await client.query(
                `UPDATE "${table}" SET is_latest = FALSE WHERE base_ref = $1 AND tenant_id = $2 AND is_latest = TRUE`,
                [baseRef, point.tenantId],
              );
            }

            const params: unknown[] = [
              versionedRef,
              baseRef,
              point.content,
              JSON.stringify(point.vector),
              JSON.stringify(point.metadata),
              point.chunk ? JSON.stringify(point.chunk) : null,
              point.prefix ?? null,
              point.source ?? null,
              point.link ?? null,
              point.title ?? null,
              point.tags ?? [],
              point.allowedUsers ?? [],
              point.allowedGroups ?? [],
              point.validFrom ?? null,
            ];
            const extraBase = params.length;
            pushExtraParams(params, point, meta);
            const sparseValSql = sql.sparseVal(extraBase);
            const binaryValSql = sql.binaryVal(
              extraBase + (meta.sparseEnabled ? 1 : 0),
            );
            // Append FTS-preprocessed content as the last parameter
            params.push(buildFtsText(point));
            const ftsParam = params.length;
            const headerParam = pushFtsContextHeader(params, point);
            params.push(point.tenantId);
            const tenantParam = params.length;

            const result = await client.query<{ id: string }>(
              `INSERT INTO "${table}"
                 (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                  prefix, source, link, title, tags, allowed_users, allowed_groups, valid_from${sql.sparseCol}${sql.binaryCol}, tenant_id)
               VALUES ($1, $2, TRUE, $3, $4::${vecType}, ${tsSearchSql(lang, ftsParam, headerParam)}, $5, $6,
                       $7, $8, $9, $10, $11, $12, $13, $14::timestamptz${sparseValSql}${binaryValSql}, $${tenantParam})
               ON CONFLICT (tenant_id, reference) DO UPDATE SET
                 content        = EXCLUDED.content,
                 vector         = EXCLUDED.vector,
                 ts_search      = EXCLUDED.ts_search,
                 metadata       = EXCLUDED.metadata,
                 chunk     = EXCLUDED.chunk,
                 prefix = EXCLUDED.prefix,
                 source         = EXCLUDED.source,
                 link           = EXCLUDED.link,
                 title          = EXCLUDED.title,
                 tags           = EXCLUDED.tags,
                 valid_from      = EXCLUDED.valid_from,
                 ${aclConflictUpdate}
                 is_latest      = TRUE,
                 modified       = NOW()${sql.sparseUpdate}${sql.binaryUpdate}
               RETURNING id::text`,
              params,
            );
            await client.query("COMMIT");
            statsBuffer.recordIngest({
              tenant_id: point.tenantId!,
              collection,
              operation: "version",
              reference: point.reference,
              duration_ms: Date.now() - startTime,
              chunks_processed: 1,
            });
            return { id: result.rows[0]!.id };
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
          }
        }
      });
    },

    async delete(
      filter: SearchFilter,
      collection: string,
      scope: AccessScope,
      reference?: string,
    ): Promise<PostgresResponse<{ deleted: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const tenantId = scope.tenantId;
      return withClient(async (client) => {
        const baseParams: unknown[] = reference
          ? [normalizeReference(reference)]
          : [JSON.stringify(filter)];
        const access = scopedWhere(scope, baseParams);
        const target = reference
          ? `(base_ref = $1 OR reference = $1 OR chunk->>'parent_ref' = $1)`
          : `metadata @> $1`;
        await client.query("BEGIN");
        try {
          // Task 4.2 (Requirements 2.3/2.4): the access-scoped DELETE names the
          // root references the caller may delete; the document cascade then
          // removes EVERYTHING for those references — every revision's units,
          // staged batches, identifiers, segments, assets (including derived
          // render-cache variants), legacy vs_document_assets rows, and the
          // identity rows (sources, groups, thread references, pointer) —
          // instead of leaving superseded revisions and identity rows behind.
          const result = await client.query<{
            root_ref: string;
            unit_id: string | null;
          }>(
            `DELETE FROM "${table}" WHERE ${target}${access.sql}
             RETURNING unit_id, COALESCE(chunk->>'parent_ref', base_ref) AS root_ref`,
            access.params,
          );
          const deleted = result.rowCount ?? 0;
          const rootRefs = [...new Set(result.rows.map((row) => row.root_ref))];
          const deletedUnitIds = [
            ...new Set(
              result.rows
                .map((row) => row.unit_id)
                .filter((u): u is string => u !== null),
            ),
          ];
          if (reference !== undefined) {
            // The named reference cascades even when no unit row matched — its
            // pointer, sources, or group rows must go too (old forgetDocument
            // behaviour, now part of the cascade).
            const named = normalizeReference(reference);
            if (!rootRefs.includes(named)) rootRefs.push(named);
          }
          if (rootRefs.length > 0) {
            await deleteDocumentCascade(client, {
              tenantId,
              collection,
              rootRefs,
              deletedUnitIds,
            });
          }
          await client.query("COMMIT");
          if (rootRefs.length > 0 && onDocumentsDeleted !== undefined) {
            try {
              onDocumentsDeleted(collection, rootRefs);
            } catch (error) {
              logger.error(
                { err: error, collection },
                "post-delete cache invalidation hook failed",
              );
            }
          }
          return { deleted };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      });
    },

    setOnDocumentsDeleted(
      hook: (collection: string, rootRefs: string[]) => void,
    ): void {
      onDocumentsDeleted = hook;
    },

    async batchUpsert(
      points: DocumentPoint[],
      collection: string,
      versionMode: "replace" | "version" = "replace",
    ): Promise<
      PostgresResponse<{
        ids: string[];
        operations: Array<"insert" | "update" | "version">;
      }>
    > {
      if (points.length === 0)
        return { ok: true, result: { ids: [], operations: [] } };

      if (points.some((point) => !point.tenantId?.trim())) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "TENANT_REQUIRED",
          },
        };
      }
      const batchTenants = new Set(
        points.map((point) => point.tenantId!.trim()),
      );
      if (batchTenants.size !== 1) {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: "A batch must contain exactly one tenant",
          },
        };
      }
      const batchTenantId = [...batchTenants][0]!;

      // Store keys in canonical NFC form
      // strip NUL bytes from text columns (see stripNullBytes) so a single
      // PDF-extracted 0x00 can't abort the whole multi-row INSERT.
      points = points.map((p) => ({
        ...sanitizePointText(p),
        reference: normalizeReference(p.reference),
        baseRef: normalizeReference(p.baseRef ?? p.reference),
      }));

      // Split large batches into sub-batches to keep the number of bind
      // parameters per statement well below PostgreSQL's 65 535 limit.
      // With ~16 params per row, 250 rows ≈ 4 000 params — a safe ceiling.
      const UPSERT_SUB_BATCH_SIZE = 250;

      const table = collectionTableName(collection);
      return withClient(async (client) => {
        const startTime = Date.now();
        const meta = await getOrLoadCollectionMeta(client, table);
        const lang = meta.language;
        const sql = buildUpsertSqlParts(meta, vecType);
        const preserveExistingAclOnConflict =
          points[0]?.preserveExistingAclOnConflict === true;
        if (
          points.some(
            (point) =>
              (point.preserveExistingAclOnConflict === true) !==
              preserveExistingAclOnConflict,
          )
        ) {
          throw new Error("A batch must use one ACL conflict policy");
        }
        const aclConflictUpdate = preserveExistingAclOnConflict
          ? ""
          : "allowed_users = EXCLUDED.allowed_users, allowed_groups = EXCLUDED.allowed_groups,";

        await client.query("BEGIN");
        try {
          let ids: string[];
          let operations: Array<"insert" | "update" | "version">;

          if (versionMode === "replace") {
            const resultMap = new Map<
              string,
              { id: string; was_insert: boolean }
            >();

            // Process in sub-batches to stay within PostgreSQL's 65 535 bind-
            // parameter limit. All sub-batches run within the same transaction.
            for (
              let offset = 0;
              offset < points.length;
              offset += UPSERT_SUB_BATCH_SIZE
            ) {
              const batch = points.slice(
                offset,
                offset + UPSERT_SUB_BATCH_SIZE,
              );
              const params: unknown[] = [];
              const rows = batch.map((point) => {
                const base = params.length;
                params.push(
                  point.reference,
                  point.baseRef ?? point.reference,
                  point.content,
                  JSON.stringify(point.vector),
                  JSON.stringify(point.metadata),
                  point.chunk ? JSON.stringify(point.chunk) : null,
                  point.prefix ?? null,
                  point.source ?? null,
                  point.link ?? null,
                  point.title ?? null,
                  point.tags ?? [],
                  point.allowedUsers ?? [],
                  point.allowedGroups ?? [],
                  point.validFrom ?? null,
                );
                const extraBase = params.length; // 14 fixed params pushed
                pushExtraParams(params, point, meta);
                // Append FTS-preprocessed content as the last param for this row
                params.push(buildFtsText(point));
                const ftsIdx = params.length; // 1-based absolute index
                const headerIdx = pushFtsContextHeader(params, point);
                params.push(point.tenantId);
                const tenantIdx = params.length;
                const n = base + 1;
                const sparsePh = sql.sparseVal(extraBase);
                const binaryPh = sql.binaryVal(
                  extraBase + (meta.sparseEnabled ? 1 : 0),
                );
                return `($${n}, $${n + 1}, TRUE, $${n + 2}, $${n + 3}::${vecType}, ${tsSearchSql(lang, ftsIdx, headerIdx)}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, $${n + 9}, $${n + 10}, $${n + 11}, $${n + 12}, $${n + 13}::timestamptz, NOW()${sparsePh}${binaryPh}, $${tenantIdx})`;
              });

              const result = await client.query<{
                id: string;
                reference: string;
                was_insert: boolean;
              }>(
                `INSERT INTO "${table}"
                   (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                    prefix, source, link, title, tags, allowed_users, allowed_groups, valid_from, modified${sql.sparseCol}${sql.binaryCol}, tenant_id)
                 VALUES ${rows.join(", ")}
                 ON CONFLICT (tenant_id, reference) DO UPDATE SET
                   content        = EXCLUDED.content,
                   vector         = EXCLUDED.vector,
                   ts_search      = EXCLUDED.ts_search,
                   metadata       = EXCLUDED.metadata,
                   chunk          = EXCLUDED.chunk,
                   prefix         = EXCLUDED.prefix,
                   source         = EXCLUDED.source,
                   link           = EXCLUDED.link,
                   title          = EXCLUDED.title,
                   tags           = EXCLUDED.tags,
                   valid_from      = EXCLUDED.valid_from,
                   ${aclConflictUpdate}
                   is_latest      = TRUE,
                   modified       = NOW()${sql.sparseUpdate}${sql.binaryUpdate}
                 RETURNING id::text, reference, (xmax = 0) AS was_insert`,
                params,
              );

              for (const r of result.rows) {
                resultMap.set(r.reference, r);
              }
            }

            ids = points.map((p) => resultMap.get(p.reference)?.id ?? "");
            operations = points.map(
              (p) =>
                (resultMap.get(p.reference)?.was_insert
                  ? "insert"
                  : "update") as "insert" | "update",
            );

            // Delete stale chunks and removed chapter/figure units belonging to
            // any root document represented in this replacement batch.
            const rootRefsInBatch = [
              ...new Set(
                points.map(
                  (point) =>
                    point.chunk?.parent_ref ?? point.baseRef ?? point.reference,
                ),
              ),
            ];
            const refsInBatch = points.map((point) => point.reference);
            await client.query(
              `DELETE FROM "${table}"
               WHERE (base_ref = ANY($1) OR chunk->>'parent_ref' = ANY($1))
                 AND reference != ALL($2)
                 AND tenant_id = $3`,
              [rootRefsInBatch, refsInBatch, batchTenantId],
            );
            const assetIdsInBatch = points.flatMap((point) =>
              point.chunk?.asset_id ? [point.chunk.asset_id] : [],
            );
            await client.query(
              `DELETE FROM vs_document_assets
               WHERE tenant_id = $1 AND collection = $2
                 AND document_reference = ANY($3)
                 AND asset_id != ALL($4)`,
              [batchTenantId, collection, rootRefsInBatch, assetIdsInBatch],
            );
          } else {
            // Version mode. A private group id binds every chunk/chapter row of
            // one ingest revision, so as-of selection never returns half a version
            // and equal valid_from values can still be broken by created/id.
            const versionGroups = new Map<string, string>();
            points = points.map((point) => {
              const root =
                point.chunk?.root_document_id ??
                point.baseRef ??
                point.reference;
              let group = versionGroups.get(root);
              if (!group) {
                group = uuidv4();
                versionGroups.set(root, group);
              }
              return {
                ...point,
                metadata: { ...point.metadata, _atf_version_group: group },
              };
            });
            const versionedRefs = points.map((p) => {
              const baseRef = p.baseRef ?? p.reference;
              return p.version
                ? `${baseRef}_v${p.version}`
                : `${baseRef}_v${uuidv4()}`;
            });

            const baseRefsAll = [
              ...new Set(points.map((p) => p.baseRef ?? p.reference)),
            ];
            const explicitRefs = versionedRefs.filter(
              (_, i) => !!points[i]!.version,
            );
            if (explicitRefs.length > 0) {
              await client.query(
                `UPDATE "${table}" SET is_latest = FALSE
                 WHERE base_ref = ANY($1) AND reference != ALL($2) AND tenant_id = $3 AND is_latest = TRUE`,
                [baseRefsAll, explicitRefs, batchTenantId],
              );
            } else {
              await client.query(
                `UPDATE "${table}" SET is_latest = FALSE WHERE base_ref = ANY($1) AND tenant_id = $2 AND is_latest = TRUE`,
                [baseRefsAll, batchTenantId],
              );
            }

            const allInsertedIds: string[] = [];
            // Process version inserts in sub-batches.
            for (
              let offset = 0;
              offset < points.length;
              offset += UPSERT_SUB_BATCH_SIZE
            ) {
              const batchSlice = points.slice(
                offset,
                offset + UPSERT_SUB_BATCH_SIZE,
              );
              const params: unknown[] = [];
              const rows = batchSlice.map((point, batchIdx) => {
                const globalIdx = offset + batchIdx;
                const base = params.length;
                params.push(
                  versionedRefs[globalIdx]!,
                  point.baseRef ?? point.reference,
                  point.content,
                  JSON.stringify(point.vector),
                  JSON.stringify(point.metadata),
                  point.chunk ? JSON.stringify(point.chunk) : null,
                  point.prefix ?? null,
                  point.source ?? null,
                  point.link ?? null,
                  point.title ?? null,
                  point.tags ?? [],
                  point.allowedUsers ?? [],
                  point.allowedGroups ?? [],
                  point.validFrom ?? null,
                );
                const extraBase = params.length;
                pushExtraParams(params, point, meta);
                // Append FTS-preprocessed content as the last param for this row
                params.push(buildFtsText(point));
                const ftsIdx = params.length; // 1-based absolute index
                const headerIdx = pushFtsContextHeader(params, point);
                params.push(point.tenantId);
                const tenantIdx = params.length;
                const n = base + 1;
                const sparsePh = sql.sparseVal(extraBase);
                const binaryPh = sql.binaryVal(
                  extraBase + (meta.sparseEnabled ? 1 : 0),
                );
                return `($${n}, $${n + 1}, TRUE, $${n + 2}, $${n + 3}::${vecType}, ${tsSearchSql(lang, ftsIdx, headerIdx)}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, $${n + 9}, $${n + 10}, $${n + 11}, $${n + 12}, $${n + 13}::timestamptz${sparsePh}${binaryPh}, $${tenantIdx})`;
              });

              const result = await client.query<{ id: string }>(
                `INSERT INTO "${table}"
                   (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                    prefix, source, link, title, tags, allowed_users, allowed_groups, valid_from${sql.sparseCol}${sql.binaryCol}, tenant_id)
                 VALUES ${rows.join(", ")}
                 ON CONFLICT (tenant_id, reference) DO UPDATE SET
                   content        = EXCLUDED.content,
                   vector         = EXCLUDED.vector,
                   ts_search      = EXCLUDED.ts_search,
                   metadata       = EXCLUDED.metadata,
                   chunk          = EXCLUDED.chunk,
                   prefix         = EXCLUDED.prefix,
                   source         = EXCLUDED.source,
                   link           = EXCLUDED.link,
                   title          = EXCLUDED.title,
                   tags           = EXCLUDED.tags,
                   valid_from      = EXCLUDED.valid_from,
                   ${aclConflictUpdate}
                   is_latest      = TRUE,
                   modified       = NOW()${sql.sparseUpdate}${sql.binaryUpdate}
                 RETURNING id::text`,
                params,
              );
              allInsertedIds.push(...result.rows.map((r) => r.id));
            } // end sub-batch loop

            ids = allInsertedIds;
            operations = ids.map(() => "version" as const);

            // Keep only the most recently inserted row as is_latest for duplicate base_refs.
            const autoBaseRefs = [
              ...new Set(
                points
                  .filter((p) => !p.version)
                  .map((p) => p.baseRef ?? p.reference),
              ),
            ];
            if (
              autoBaseRefs.length > 0 &&
              autoBaseRefs.length < points.filter((p) => !p.version).length
            ) {
              await client.query(
                `WITH winners AS (
                   SELECT DISTINCT ON (tenant_id, base_ref)
                          tenant_id, base_ref, metadata->>'_atf_version_group' AS version_group
                   FROM "${table}"
                   WHERE base_ref = ANY($1) AND tenant_id = $2 AND is_latest = TRUE
                   ORDER BY tenant_id, base_ref, created DESC, id DESC
                 )
                 UPDATE "${table}" d SET is_latest = FALSE
                 FROM winners w
                 WHERE d.tenant_id = w.tenant_id
                   AND d.base_ref = w.base_ref
                   AND d.is_latest = TRUE
                   AND d.metadata->>'_atf_version_group' IS DISTINCT FROM w.version_group`,
                [autoBaseRefs, batchTenantId],
              );
            }
          }

          await client.query("COMMIT");

          // Record stats per unique base reference
          const baseRefs = new Map<
            string,
            { op: "insert" | "update" | "version"; count: number }
          >();
          for (let i = 0; i < points.length; i++) {
            const baseRef = points[i]!.reference.replace(/_chunk_\d+$/, "");
            const op = operations[i]!;
            const existing = baseRefs.get(baseRef);
            if (!existing) {
              baseRefs.set(baseRef, { op, count: 1 });
            } else {
              existing.count++;
              if (op === "update") existing.op = "update";
            }
          }
          const duration = Date.now() - startTime;
          for (const [ref, { op, count }] of baseRefs) {
            statsBuffer.recordIngest({
              tenant_id: batchTenantId,
              collection,
              operation: op,
              reference: ref,
              duration_ms: duration,
              chunks_processed: count,
            });
          }

          return { ids, operations };
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
      });
    },

    async ping(): Promise<PostgresResponse<void>> {
      return withClient(async (client) => {
        await client.query("SELECT 1");
      });
    },

    async close(): Promise<void> {
      await statsBuffer.close();
      await pool.end();
    },
  };
}
