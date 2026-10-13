// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * postgres-client methods: PostgresClient collection methods: ingest/search stats, listing, ACL, stats and overview, plus delete/rename/recompute.
 *
 * Extracted verbatim from postgres-client.ts (Requirement 13.6).
 * Shared factory state arrives via PgFactoryCtx; bodies are
 * unchanged.
 */

import type { AccessScope } from "./access-scope.js";
import type { CollectionAcl } from "./collection-access.js";
import { AppError, COLLECTION_TABLE_PREFIX, collectionTableName, ensureCollectionConfigTable, ftsSearchRecomputeSql, loadCollectionMeta, validateFtsLanguage } from "./collection-ddl.js";
import { SqlParams, buildAccessSql } from "./query-builder.js";
import { escapeLikeLiteral, normalizePathPrefix } from "./pg-helpers.js";
import type { CollectionInfo, CollectionOverview, CollectionStats, IngestStats, PostgresResponse, SearchStats } from "./pg-types.js";

import type { PgFactoryCtx } from "./pg-factory-ctx.js";

export function createCollectionsMethods(ctx: PgFactoryCtx) {
  const {
    withClient,
    scopedWhere,
    escapeRegex,
    ensuredCollections,
    ensureCollectionLocks,
  } = ctx;

  return {
    async getIngestStats(
      scope: AccessScope,
      collection?: string,
      limit = 100,
      offset = 0,
    ): Promise<PostgresResponse<IngestStats[]>> {
      return withClient(async (client) => {
        if (!scope.tenantId) throw new Error("TENANT_REQUIRED");
        const { rows } = collection
          ? await client.query(
              "SELECT * FROM vs_ingest_stats WHERE tenant_id = $1 AND collection = $2 ORDER BY timestamp DESC LIMIT $3 OFFSET $4",
              [scope.tenantId, collection, limit, offset],
            )
          : await client.query(
              "SELECT * FROM vs_ingest_stats WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3",
              [scope.tenantId, limit, offset],
            );
        return rows as IngestStats[];
      });
    },

    async getSearchStats(
      scope: AccessScope,
      collection?: string,
      limit = 100,
      offset = 0,
    ): Promise<PostgresResponse<SearchStats[]>> {
      return withClient(async (client) => {
        if (!scope.tenantId) throw new Error("TENANT_REQUIRED");
        const { rows } = collection
          ? await client.query(
              "SELECT * FROM vs_search_stats WHERE tenant_id = $1 AND collection = $2 ORDER BY timestamp DESC LIMIT $3 OFFSET $4",
              [scope.tenantId, collection, limit, offset],
            )
          : await client.query(
              "SELECT * FROM vs_search_stats WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3",
              [scope.tenantId, limit, offset],
            );
        return rows as SearchStats[];
      });
    },

    async listCollections(
      scope: AccessScope,
    ): Promise<PostgresResponse<CollectionInfo[]>> {
      return withClient(async (client) => {
        await ensureCollectionConfigTable(client);
        const { rows } = await client.query<{
          collection_table: string;
          fts_language: string;
          sparse_enabled: boolean;
          sparse_vocab_size: number | null;
          quantization: string;
          vector_size: number | null;
          embedding_model: string | null;
          embedding_model_revision: string | null;
          index_build_version: string | null;
          index_algorithm: string | null;
          index_parameters: Record<string, number> | null;
          allowed_users: string[] | null;
          allowed_groups: string[] | null;
          created: Date;
          updated_at: Date;
        }>(
          `SELECT collection_table, fts_language, sparse_enabled, sparse_vocab_size,
                  quantization, vector_size, embedding_model, embedding_model_revision,
                  index_build_version, index_algorithm, index_parameters, allowed_users, allowed_groups, created, updated_at
           FROM vs_collection_config
           ORDER BY created DESC`,
        );

        if (rows.length === 0) return [];

        // Fetch document and chunk counts for all collections in one dynamic
        // statement. A shared SqlParams accumulator gives every UNION branch
        // globally correct placeholder indexes while buildAccessSql enforces
        // row visibility independently in each collection table.
        const countParams = new SqlParams();
        const countUnions = rows
          .map((r) => {
            const accessSql = buildAccessSql(countParams, scope);
            return (
              `SELECT '${r.collection_table.replace(/'/g, "''")}' AS tbl,` +
              ` COUNT(*) AS total_chunks,` +
              ` COUNT(DISTINCT base_ref) FILTER (WHERE is_latest) AS total_docs` +
              ` FROM "${r.collection_table}" WHERE TRUE${accessSql}`
            );
          })
          .join(" UNION ALL ");

        const countMap = new Map<
          string,
          { totalChunks: number; totalDocs: number }
        >();

        try {
          const countResult = await client.query<{
            tbl: string;
            total_chunks: string;
            total_docs: string;
          }>(countUnions, countParams.values);
          for (const row of countResult.rows) {
            countMap.set(row.tbl, {
              totalChunks: parseInt(row.total_chunks, 10),
              totalDocs: parseInt(row.total_docs, 10),
            });
          }
        } catch {
          // If any collection table has been dropped externally, fall back to
          // zero counts rather than failing the entire list operation.
          for (const r of rows) {
            countMap.set(r.collection_table, { totalChunks: 0, totalDocs: 0 });
          }
        }

        return rows.map((r) => ({
          collection: r.collection_table.startsWith(COLLECTION_TABLE_PREFIX)
            ? r.collection_table.slice(COLLECTION_TABLE_PREFIX.length)
            : r.collection_table,
          table: r.collection_table,
          ftsLanguage: r.fts_language,
          sparseEnabled: r.sparse_enabled,
          sparseVocabSize: r.sparse_vocab_size,
          quantization: (r.quantization === "binary" ? "binary" : "none") as
            | "none"
            | "binary",
          vectorSize: r.vector_size,
          embeddingModel: r.embedding_model,
          embeddingModelRevision: r.embedding_model_revision,
          indexBuildVersion: r.index_build_version,
          indexAlgorithm: r.index_algorithm,
          indexParameters: r.index_parameters,
          created: r.created,
          updatedAt: r.updated_at,
          totalDocs: countMap.get(r.collection_table)?.totalDocs ?? 0,
          totalChunks: countMap.get(r.collection_table)?.totalChunks ?? 0,
          allowedUsers: r.allowed_users ?? [],
          allowedGroups: r.allowed_groups ?? [],
        }));
      });
    },

    async getCollectionAcl(
      collection: string,
    ): Promise<PostgresResponse<CollectionAcl>> {
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
      return withClient(async (client) => {
        await ensureCollectionConfigTable(client);
        const reg = await client.query<{ t: string | null }>(
          `SELECT to_regclass($1) AS t`,
          [`"${table}"`],
        );
        if (!reg.rows[0]?.t) {
          throw new AppError(
            "COLLECTION_NOT_FOUND",
            `Collection "${collection}" not found`,
          );
        }
        const config = await client.query<{
          allowed_users: string[] | null;
          allowed_groups: string[] | null;
        }>(
          `SELECT allowed_users, allowed_groups
             FROM vs_collection_config
            WHERE collection_table = $1`,
          [table],
        );
        const row = config.rows[0];
        if (!row) {
          throw new AppError(
            "COLLECTION_NOT_FOUND",
            `Collection "${collection}" has no configuration`,
          );
        }
        return {
          allowedUsers: row.allowed_users ?? [],
          allowedGroups: row.allowed_groups ?? [],
        };
      });
    },

    async setCollectionAcl(
      collection: string,
      allowedUsers: string[],
      allowedGroups: string[],
    ): Promise<PostgresResponse<{ updated: number }>> {
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
      // De-duplicate + drop blanks so the stored ACL is clean.
      const users = [
        ...new Set(allowedUsers.map((u) => u.trim()).filter(Boolean)),
      ];
      const groups = [
        ...new Set(allowedGroups.map((g) => g.trim()).filter(Boolean)),
      ];
      return withClient(async (client) => {
        await ensureCollectionConfigTable(client);
        const res = await client.query(
          `UPDATE vs_collection_config
              SET allowed_users = $2, allowed_groups = $3, updated_at = NOW()
            WHERE collection_table = $1`,
          [table, users, groups],
        );
        if ((res.rowCount ?? 0) === 0) {
          throw new AppError(
            "COLLECTION_NOT_FOUND",
            `Collection "${collection}" not found`,
          );
        }
        // Bust the cached meta so the next access check sees the new ACL.
        ensuredCollections.delete(table);
        return { updated: res.rowCount ?? 0 };
      });
    },

    async getCollectionStats(
      collection: string,
      scope: AccessScope,
      pathPrefix?: string,
    ): Promise<PostgresResponse<CollectionStats>> {
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
      return withClient(async (client) => {
        const reg = await client.query<{ t: string | null }>(
          `SELECT to_regclass($1) AS t`,
          [`"${table}"`],
        );
        if (!reg.rows[0]?.t) {
          throw new AppError(
            "COLLECTION_NOT_FOUND",
            `Collection "${collection}" not found`,
          );
        }
        const norm = normalizePathPrefix(pathPrefix);
        const where =
          norm === ""
            ? "is_latest"
            : "is_latest AND base_ref LIKE $1 ESCAPE '\\'";
        const params = norm === "" ? [] : [escapeLikeLiteral(norm) + "/%"];
        const access = scopedWhere(scope, params);
        const { rows } = await client.query<{
          chunks: string;
          docs: string;
        }>(
          `SELECT COUNT(*) AS chunks, COUNT(DISTINCT base_ref) AS docs
             FROM "${table}" WHERE ${where}${access.sql}`,
          access.params,
        );
        const row = rows[0]!;
        return {
          collection,
          totalDocs: parseInt(row.docs, 10),
          totalChunks: parseInt(row.chunks, 10),
          pathPrefix: norm === "" ? null : norm,
        };
      });
    },

    async getCollectionOverview(
      collection: string,
      scope: AccessScope,
      pathPrefix?: string,
    ): Promise<PostgresResponse<CollectionOverview>> {
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
      return withClient(async (client) => {
        const reg = await client.query<{ t: string | null }>(
          `SELECT to_regclass($1) AS t`,
          [`"${table}"`],
        );
        if (!reg.rows[0]?.t) {
          throw new AppError(
            "COLLECTION_NOT_FOUND",
            `Collection "${collection}" not found`,
          );
        }
        const norm = normalizePathPrefix(pathPrefix);
        // $1 = LIKE pattern (only when scoped). Reused across the queries below.
        const likeParam = norm === "" ? [] : [escapeLikeLiteral(norm) + "/%"];
        const access = scopedWhere(scope, likeParam);
        const latestWhere =
          (norm === ""
            ? "is_latest"
            : "is_latest AND base_ref LIKE $1 ESCAPE '\\'") + access.sql;
        const anyVersionWhere =
          (norm === "" ? "TRUE" : "base_ref LIKE $1 ESCAPE '\\'") + access.sql;

        const num = (v: string | number | null): number =>
          v === null ? 0 : typeof v === "number" ? v : parseFloat(v);
        const numOrNull = (v: string | number | null): number | null =>
          v === null ? null : typeof v === "number" ? v : parseFloat(v);

        // ── Chunk-level aggregate over latest chunks ──────────────────────
        const chunkAgg = await client.query<{
          chunks: string;
          docs: string;
          avg_chunk: string | null;
          min_chunk: number | null;
          max_chunk: number | null;
          median_chunk: string | null;
          total_chars: string | null;
          earliest: Date | null;
          latest: Date | null;
        }>(
          `SELECT COUNT(*)                                              AS chunks,
                  COUNT(DISTINCT base_ref)                              AS docs,
                  AVG(length(content))                                  AS avg_chunk,
                  MIN(length(content))                                  AS min_chunk,
                  MAX(length(content))                                  AS max_chunk,
                  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY length(content)) AS median_chunk,
                  SUM(length(content))                                  AS total_chars,
                  MIN(modified)                                         AS earliest,
                  MAX(modified)                                         AS latest
             FROM "${table}" WHERE ${latestWhere}`,
          access.params,
        );
        const ca = chunkAgg.rows[0]!;
        const documents = parseInt(ca.docs, 10);
        const chunks = parseInt(ca.chunks, 10);

        // ── All-version chunk row count ───────────────────────────────────
        const versionAgg = await client.query<{ rows: string }>(
          `SELECT COUNT(*) AS rows FROM "${table}" WHERE ${anyVersionWhere}`,
          access.params,
        );

        // ── Per-document aggregate (chunks/doc, chars/doc, summary flags) ──
        const perDoc = await client.query<{
          avg_cpd: string | null;
          min_cpd: number | null;
          max_cpd: number | null;
          median_cpd: string | null;
          avg_dpc: string | null;
          min_dpc: number | null;
          max_dpc: number | null;
          median_dpc: string | null;
          docs_with_summary: string;
          docs_with_prefix: string;
          avg_summary_chars: string | null;
        }>(
          `SELECT AVG(cpd)                                        AS avg_cpd,
                  MIN(cpd)                                        AS min_cpd,
                  MAX(cpd)                                        AS max_cpd,
                  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cpd) AS median_cpd,
                  AVG(chars)                                      AS avg_dpc,
                  MIN(chars)                                      AS min_dpc,
                  MAX(chars)                                      AS max_dpc,
                  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY chars) AS median_dpc,
                  COUNT(*) FILTER (WHERE has_summary)             AS docs_with_summary,
                  COUNT(*) FILTER (WHERE prefix_len > 0)          AS docs_with_prefix,
                  AVG(prefix_len) FILTER (WHERE prefix_len > 0)   AS avg_summary_chars
             FROM (
               SELECT base_ref,
                      COUNT(*)                                    AS cpd,
                      SUM(length(content))                        AS chars,
                      bool_or((chunk->>'summary') = 'true')       AS has_summary,
                      MAX(COALESCE(length(prefix), 0))            AS prefix_len
                 FROM "${table}" WHERE ${latestWhere}
                GROUP BY base_ref
             ) t`,
          access.params,
        );
        const pd = perDoc.rows[0];

        // ── Folder count (derived from document paths, like listFolders) ──
        const refRows = await client.query<{ base_ref: string }>(
          `SELECT DISTINCT base_ref FROM "${table}" WHERE ${latestWhere}`,
          access.params,
        );
        const folderSet = new Set<string>();
        for (const { base_ref } of refRows.rows) {
          if (!base_ref.startsWith(norm)) continue;
          const rest = base_ref.slice(norm.length);
          const parts = rest.split("/").filter((p) => p.length > 0);
          for (let k = 1; k < parts.length; k++) {
            folderSet.add(norm + "/" + parts.slice(0, k).join("/"));
          }
        }

        // ── Index configuration from the collection-config table ──────────
        let config: CollectionOverview["config"] = null;
        try {
          await ensureCollectionConfigTable(client);
          const cfg = await client.query<{
            fts_language: string | null;
            sparse_enabled: boolean | null;
            quantization: string | null;
            vector_size: number | null;
            created: Date | null;
            updated_at: Date | null;
          }>(
            `SELECT fts_language, sparse_enabled, quantization, vector_size, created, updated_at
               FROM vs_collection_config WHERE collection_table = $1`,
            [table],
          );
          if (cfg.rows[0]) {
            const c = cfg.rows[0];
            config = {
              vectorSize: c.vector_size,
              ftsLanguage: c.fts_language,
              sparseEnabled: c.sparse_enabled,
              quantization: c.quantization === "binary" ? "binary" : "none",
              created: c.created,
              updatedAt: c.updated_at,
            };
          }
        } catch {
          config = null;
        }

        const docsWithSummary = pd ? parseInt(pd.docs_with_summary, 10) : 0;
        const docsWithPrefix = pd ? parseInt(pd.docs_with_prefix, 10) : 0;

        const overview: CollectionOverview = {
          collection,
          pathPrefix: norm === "" ? null : norm,
          documents,
          chunks,
          chunkRowsAllVersions: parseInt(versionAgg.rows[0]!.rows, 10),
          folders: folderSet.size,
          chunkChars:
            chunks > 0
              ? {
                  min: num(ca.min_chunk),
                  max: num(ca.max_chunk),
                  avg: Math.round(num(ca.avg_chunk)),
                  median: Math.round(num(ca.median_chunk)),
                }
              : null,
          chunksPerDocument:
            documents > 0 && pd
              ? {
                  min: num(pd.min_cpd),
                  max: num(pd.max_cpd),
                  avg: Math.round(num(pd.avg_cpd) * 10) / 10,
                  median: Math.round(num(pd.median_cpd) * 10) / 10,
                }
              : null,
          documentChars:
            documents > 0 && pd
              ? {
                  min: num(pd.min_dpc),
                  max: num(pd.max_dpc),
                  avg: Math.round(num(pd.avg_dpc)),
                  median: Math.round(num(pd.median_dpc)),
                }
              : null,
          totalContentChars: num(ca.total_chars),
          summaries: {
            documentsWithSummary: docsWithSummary,
            documentsWithPrefix: docsWithPrefix,
            coverage:
              documents > 0
                ? Math.round((docsWithSummary / documents) * 1000) / 1000
                : 0,
            avgSummaryChars: pd
              ? (() => {
                  const v = numOrNull(pd.avg_summary_chars);
                  return v === null ? null : Math.round(v);
                })()
              : null,
          },
          config,
          modified: { earliest: ca.earliest, latest: ca.latest },
        };
        return overview;
      });
    },

    async deleteCollection(
      collection: string,
    ): Promise<PostgresResponse<{ dropped: boolean }>> {
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
      return withClient(async (client) => {
        await client.query("BEGIN");
        try {
          await client.query(`DROP TABLE IF EXISTS "${table}"`);
          await client.query(
            `DELETE FROM vs_collection_config WHERE collection_table = $1`,
            [table],
          );
          await client.query(
            `DELETE FROM vs_document_assets WHERE collection = $1`,
            [collection],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
        ensuredCollections.delete(table);
        ensureCollectionLocks.delete(table);
        return { dropped: true };
      });
    },

    async renameCollection(
      oldName: string,
      newName: string,
    ): Promise<PostgresResponse<void>> {
      let oldTable: string;
      let newTable: string;
      try {
        oldTable = collectionTableName(oldName);
      } catch (cause) {
        return {
          ok: false,
          error: {
            code: "INVALID_COLLECTION_NAME",
            message: `Invalid source collection name: ${(cause as Error).message}`,
            cause,
          },
        };
      }
      try {
        newTable = collectionTableName(newName);
      } catch (cause) {
        return {
          ok: false,
          error: {
            code: "INVALID_COLLECTION_NAME",
            message: `Invalid target collection name: ${(cause as Error).message}`,
            cause,
          },
        };
      }

      return withClient(async (client) => {
        // Check source exists
        const exists = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM vs_collection_config WHERE collection_table = $1
           ) AS exists`,
          [oldTable],
        );
        if (!exists.rows[0]?.exists) {
          // Throw a typed AppError so withClient maps it to COLLECTION_NOT_FOUND
          throw new AppError(
            "COLLECTION_NOT_FOUND",
            `Collection "${oldName}" does not exist`,
          );
        }

        await client.query("BEGIN");
        try {
          // Rename the table
          await client.query(
            `ALTER TABLE "${oldTable}" RENAME TO "${newTable}"`,
          );
          // Rename all associated indexes (they carry the old table prefix)
          const idxRes = await client.query<{ indexname: string }>(
            `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
            [newTable],
          );
          for (const row of idxRes.rows) {
            const oldIdx = row.indexname;
            const newIdx = oldIdx.replace(
              new RegExp(`^${escapeRegex(oldTable)}_`),
              `${newTable}_`,
            );
            if (newIdx !== oldIdx) {
              await client.query(
                `ALTER INDEX "${oldIdx}" RENAME TO "${newIdx}"`,
              );
            }
          }
          // Update collection config
          await client.query(
            `UPDATE vs_collection_config
             SET collection_table = $1, updated_at = NOW()
             WHERE collection_table = $2`,
            [newTable, oldTable],
          );
          await client.query(
            `UPDATE vs_document_assets SET collection = $1, modified = NOW() WHERE collection = $2`,
            [newName, oldName],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }

        // Invalidate in-memory caches
        const meta = ensuredCollections.get(oldTable);
        ensuredCollections.delete(oldTable);
        ensureCollectionLocks.delete(oldTable);
        if (meta) ensuredCollections.set(newTable, meta);
      });
    },

    async recomputeFtsLanguage(
      collection: string,
      language: string,
    ): Promise<PostgresResponse<{ updated: number; unchanged: boolean }>> {
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
      let lang: string;
      try {
        lang = validateFtsLanguage(language);
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
      return withClient(async (client) => {
        await ensureCollectionConfigTable(client);
        const existing = await loadCollectionMeta(client, table);
        if (existing === null) {
          throw new AppError(
            "COLLECTION_NOT_FOUND",
            `Collection "${collection}" does not exist`,
          );
        }
        if (existing.language === lang) {
          return { updated: 0, unchanged: true };
        }
        await client.query("BEGIN");
        try {
          // Re-tokenize every row under the new language. lang is whitelisted
          // by validateFtsLanguage, so interpolation is safe.
          const res = await client.query(
            `UPDATE "${table}" SET ts_search = ${ftsSearchRecomputeSql(lang)}`,
          );
          await client.query(
            `UPDATE vs_collection_config
                SET fts_language = $1, updated_at = NOW()
              WHERE collection_table = $2`,
            [lang, table],
          );
          await client.query("COMMIT");
          // Keep the in-memory cache consistent with the persisted change.
          ensuredCollections.set(table, { ...existing, language: lang });
          return { updated: res.rowCount ?? 0, unchanged: false };
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        }
      });
    },
  };
}
