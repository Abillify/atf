// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * postgres-client methods: PostgresClient document methods: listing, folders, reads, prefix reads and summaries.
 *
 * Extracted verbatim from postgres-client.ts (Requirement 13.6).
 * Shared factory state arrives via PgFactoryCtx; bodies are
 * unchanged.
 */

import type { AccessScope } from "./access-scope.js";
import { AppError, collectionTableName } from "./collection-ddl.js";
import type { Metadata } from "./metadata.js";
import { DOCUMENT_BODY_SQL, DOCUMENT_ORDER_SQL, deriveFolderAggregates, documentBodyText, escapeLikeLiteral, fuzzyScore, mergeChunksWithCoordinates, mergeOrderedChunkContents, normalizePathPrefix, normalizeReference, stripNullBytes } from "./pg-helpers.js";
import type { ChunkInfo, DocumentContent, DocumentSummary, FolderSummary, PostgresResponse, SummaryEntry } from "./pg-types.js";

import type { PgFactoryCtx } from "./pg-factory-ctx.js";

export function createDocsMethods(ctx: PgFactoryCtx) {
  const {
    withClient,
    getOrLoadCollectionMeta,
    scopedWhere,
    versionedWhere,
  } = ctx;

  return {
    async listDocuments(
      collection: string,
      scope: AccessScope,
      options?: {
        pathPrefix?: string;
        limit?: number;
        offset?: number;
        directOnly?: boolean;
      },
    ): Promise<
      PostgresResponse<{ documents: DocumentSummary[]; total: number }>
    > {
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
      const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
      const offset = Math.max(options?.offset ?? 0, 0);
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
        const norm = normalizePathPrefix(options?.pathPrefix);
        let prefixClause = "";
        let prefixParams: string[] = [];
        if (options?.directOnly) {
          // Only documents sitting DIRECTLY under the prefix (no further path
          // segment) — used by the folder browser to separate files at this
          // level from the contents of sub-folders. Works at the root too
          // (norm === "" → LIKE '/%' AND NOT LIKE '/%/%').
          prefixClause =
            " AND base_ref LIKE $1 ESCAPE '\\' AND base_ref NOT LIKE $2 ESCAPE '\\'";
          prefixParams = [
            escapeLikeLiteral(norm) + "/%",
            escapeLikeLiteral(norm) + "/%/%",
          ];
        } else if (norm !== "") {
          prefixClause = " AND base_ref LIKE $1 ESCAPE '\\'";
          prefixParams = [escapeLikeLiteral(norm) + "/%"];
        }

        const access = scopedWhere(scope, prefixParams);
        const totalRes = await client.query<{ total: string }>(
          `SELECT COUNT(DISTINCT base_ref) AS total
             FROM "${table}" WHERE is_latest${prefixClause}${access.sql}`,
          access.params,
        );
        const total = parseInt(totalRes.rows[0]!.total, 10);

        // Representative row per document: title/link/source come from the
        // chunk-0 row (MIN(chunk_index)); chunk count and freshest modified are
        // aggregated. DISTINCT ON keeps one row per base_ref cheaply.
        const { rows } = await client.query<{
          reference: string;
          title: string | null;
          link: string | null;
          source: string | null;
          chunks: string;
          size: string | null;
          modified: Date;
        }>(
          `SELECT base_ref AS reference,
                  (ARRAY_AGG(title      ORDER BY COALESCE((chunk->>'chunk_index')::int, 0)))[1] AS title,
                  (ARRAY_AGG(link       ORDER BY COALESCE((chunk->>'chunk_index')::int, 0)))[1] AS link,
                  (ARRAY_AGG(source     ORDER BY COALESCE((chunk->>'chunk_index')::int, 0)))[1] AS source,
                  COUNT(*)   AS chunks,
                  SUM(octet_length(content)) AS size,
                  MAX(modified) AS modified
             FROM "${table}"
            WHERE is_latest${prefixClause}${access.sql}
            GROUP BY base_ref
            ORDER BY MAX(modified) DESC, base_ref ASC
            LIMIT ${limit} OFFSET ${offset}`,
          access.params,
        );

        const documents: DocumentSummary[] = rows.map((r) => ({
          reference: r.reference,
          title: r.title,
          link: r.link,
          source: r.source,
          chunks: parseInt(r.chunks, 10),
          size: r.size ? parseInt(r.size, 10) : 0,
          modified: r.modified,
        }));
        return { documents, total };
      });
    },

    async listFolders(
      collection: string,
      scope: AccessScope,
      options?: { pathPrefix?: string; depth?: number },
    ): Promise<
      PostgresResponse<{
        prefix: string;
        depth: number | "all";
        folders: FolderSummary[];
        files: number;
      }>
    > {
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
      // depth: 1 = immediate children (default); n>1 = up to n levels;
      // <= 0 = unlimited (whole sub-tree).
      const rawDepth = options?.depth ?? 1;
      const unlimited = rawDepth <= 0;
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
        const norm = normalizePathPrefix(options?.pathPrefix);
        const prefixClause =
          norm === "" ? "" : " AND base_ref LIKE $1 ESCAPE '\\'";
        const prefixParams =
          norm === "" ? [] : [escapeLikeLiteral(norm) + "/%"];
        const access = scopedWhere(scope, prefixParams);

        // One row per document with its chunk count; the folder structure is
        // derived from the paths in application code (portable across the path
        // shapes producers use).
        const { rows } = await client.query<{
          base_ref: string;
          chunks: string;
        }>(
          `SELECT base_ref, COUNT(*) AS chunks
             FROM "${table}" WHERE is_latest${prefixClause}${access.sql}
            GROUP BY base_ref`,
          access.params,
        );

        const { folders: folderAgg, files } = deriveFolderAggregates(
          rows.map((r) => ({
            baseRef: r.base_ref,
            chunks: parseInt(r.chunks, 10),
          })),
          norm,
          rawDepth,
        );

        const folders: FolderSummary[] = Array.from(folderAgg.entries())
          .map(([path, agg]) => ({
            path,
            documents: agg.documents,
            chunks: agg.chunks,
            subfolderCount: agg.subfolders.size,
            subfolders: Array.from(agg.subfolders).sort((a, b) =>
              a.localeCompare(b),
            ),
          }))
          .sort((a, b) => a.path.localeCompare(b.path));

        return {
          prefix: norm === "" ? "/" : norm,
          depth: unlimited ? "all" : rawDepth,
          folders,
          files,
        };
      });
    },

    async findFolders(
      collection: string,
      scope: AccessScope,
      query: string,
      options?: { limit?: number; matchFullPath?: boolean; threshold?: number },
    ): Promise<PostgresResponse<{ query: string; matches: FolderSummary[] }>> {
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
      const needle = query.trim().toLowerCase();
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
      const matchFullPath = options?.matchFullPath ?? false;
      // Minimum fuzzy score (0..1) for a folder to be considered a match.
      // Default 0.4 keeps typos/partial names in while dropping unrelated ones.
      const threshold = Math.min(Math.max(options?.threshold ?? 0.4, 0), 1);
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
        const access = scopedWhere(scope, []);
        const { rows } = await client.query<{
          base_ref: string;
          chunks: string;
        }>(
          `SELECT base_ref, COUNT(*) AS chunks
             FROM "${table}" WHERE is_latest${access.sql}
            GROUP BY base_ref`,
          access.params,
        );

        // Derive every folder in the whole tree with recursive document/chunk
        // counts and its immediate child-folder names.
        const { folders: folderAgg } = deriveFolderAggregates(
          rows.map((r) => ({
            baseRef: r.base_ref,
            chunks: parseInt(r.chunks, 10),
          })),
          "",
          0, // whole sub-tree
        );

        // Score each folder. Empty query → everything (score 1).
        const scored: Array<FolderSummary & { score: number }> = [];
        for (const [path, agg] of folderAgg) {
          let score = 1;
          if (needle !== "") {
            // Score against the whole path or against each segment (default),
            // keeping the best fuzzy score found.
            const candidates = matchFullPath
              ? [path.toLowerCase()]
              : path
                  .split("/")
                  .filter((s) => s.length > 0)
                  .map((s) => s.toLowerCase());
            let best = 0;
            for (const cand of candidates) {
              const s = fuzzyScore(needle, cand);
              if (s > best) best = s;
            }
            if (best < threshold) continue;
            score = best;
          }
          scored.push({
            path,
            documents: agg.documents,
            chunks: agg.chunks,
            subfolderCount: agg.subfolders.size,
            subfolders: Array.from(agg.subfolders).sort((a, b) =>
              a.localeCompare(b),
            ),
            score,
          });
        }

        // Highest fuzzy score first; ties broken by shallower path, then more
        // documents, then alphabetical. All folders above the threshold are
        // returned (bounded by `limit`) — so multiple equally-good candidates
        // all come back for the caller/LLM to choose from.
        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score! - a.score!;
          const depthA = a.path.split("/").length;
          const depthB = b.path.split("/").length;
          if (depthA !== depthB) return depthA - depthB;
          if (b.documents !== a.documents) return b.documents - a.documents;
          return a.path.localeCompare(b.path);
        });

        const matches: FolderSummary[] = scored
          .slice(0, limit)
          .map((f) => ({ ...f, score: Math.round(f.score! * 1000) / 1000 }));

        return { query, matches };
      });
    },

    async getDocument(
      collection: string,
      scope: AccessScope,
      reference: string,
      options?: { maxChars?: number; offset?: number; validAt?: string },
    ): Promise<PostgresResponse<DocumentContent | null>> {
      // Canonicalize so an NFC (precomposed-umlaut) reference matches an
      // NFC-stored key even when the caller copied it from NFD-origin text.
      reference = normalizeReference(reference);
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
      // Window the (potentially very large) document so a single big file can't
      // overflow the model's context when returned as a tool result. Defaults
      // are generous; the caller can page through with offset.
      const maxChars = Math.min(
        Math.max(options?.maxChars ?? 200_000, 1_000),
        2_000_000,
      );
      const offset = Math.max(options?.offset ?? 0, 0);
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
        // Resolve base_ref: accept either the document ref or any chunk ref.
        const resolveAccess = versionedWhere(
          table,
          collection,
          scope,
          [reference],
          options?.validAt,
        );
        const resolve = await client.query<{ base_ref: string }>(
          `SELECT base_ref FROM "${table}"
            WHERE (base_ref = $1 OR reference = $1)${resolveAccess.sql}
            LIMIT 1`,
          resolveAccess.params,
        );
        if (resolve.rows.length === 0) return null;
        const baseRef = resolve.rows[0]!.base_ref;
        const chunkAccess = versionedWhere(
          table,
          collection,
          scope,
          [baseRef],
          options?.validAt,
        );

        const { rows } = await client.query<{
          content: string;
          title: string | null;
          link: string | null;
          source: string | null;
          metadata: Metadata | null;
          tags: string[] | null;
          modified: Date;
          reference: string;
          chunk: ChunkInfo | null;
          overlap_start: number | null;
          overlap_end: number | null;
          unit_id: string | null;
          unit_type: string | null;
          page_start: number | null;
          page_end: number | null;
          section_path: string[] | null;
        }>(
          `SELECT content, title, link, source, metadata, tags, modified, reference, chunk,
                  (chunk->>'chunk_overlap_start')::int AS overlap_start,
                  (chunk->>'chunk_overlap_end')::int   AS overlap_end,
                  unit_id, unit_type, page_start, page_end, section_path
             FROM "${table}"
            WHERE base_ref = $1 AND ${DOCUMENT_BODY_SQL}${chunkAccess.sql}
            ORDER BY ${DOCUMENT_ORDER_SQL}`,
          chunkAccess.params,
        );
        if (rows.length === 0) return null;

        const mergedDocument = mergeChunksWithCoordinates(
          rows.map((r) =>
            r.unit_type != null ? { ...r, content: documentBodyText(r) } : r,
          ),
        );
        const fullContent = mergedDocument.content;
        const totalChars = fullContent.length;
        const content = fullContent.slice(offset, offset + maxChars);
        const truncated = offset > 0 || content.length < totalChars;
        const first = rows[0]!;
        let latestModified = first.modified;
        for (const r of rows)
          if (r.modified > latestModified) latestModified = r.modified;
        const windowEnd = offset + content.length;
        const evidenceSpans = mergedDocument.coordinates.flatMap(
          (coordinate) => {
            const chunk = coordinate.item.chunk;
            const unit = coordinate.item;
            if (
              coordinate.originalStart === undefined ||
              coordinate.originalEnd === undefined
            )
              return [];
            const start = Math.max(coordinate.returnedStart, offset);
            const end = Math.min(coordinate.returnedEnd, windowEnd);
            if (start >= end) return [];
            const deltaStart = start - coordinate.returnedStart;
            const deltaEnd = coordinate.returnedEnd - end;
            return [
              {
                ...(chunk?.chunk_id ? { chunk_id: chunk.chunk_id } : {}),
                reference: coordinate.item.reference,
                window_start: start - offset,
                window_end: end - offset,
                original_start: coordinate.originalStart + deltaStart,
                original_end: coordinate.originalEnd - deltaEnd,
                ...(unit.unit_id ? { unit_id: unit.unit_id } : {}),
                ...(unit.unit_type ? { unit_type: unit.unit_type } : {}),
                ...(chunk?.page_start !== undefined
                  ? { page_start: chunk.page_start }
                  : unit.page_start != null
                    ? { page_start: unit.page_start }
                    : {}),
                ...(chunk?.page_end !== undefined
                  ? { page_end: chunk.page_end }
                  : unit.page_end != null
                    ? { page_end: unit.page_end }
                    : {}),
                ...(chunk?.section_path
                  ? { section_path: chunk.section_path }
                  : unit.section_path && unit.section_path.length > 0
                    ? { section_path: unit.section_path }
                    : {}),
              },
            ];
          },
        );

        return {
          reference: baseRef,
          title: first.title,
          link: first.link,
          source: first.source,
          metadata: first.metadata ?? {},
          tags: first.tags ?? [],
          chunks: rows.length,
          content,
          totalChars,
          truncated,
          offset,
          evidence_spans: evidenceSpans,
          modified: latestModified,
        };
      });
    },

    async getDocumentsByPrefix(
      collection: string,
      scope: AccessScope,
      options?: {
        pathPrefix?: string;
        limit?: number;
        maxChars?: number;
        validAt?: string;
      },
    ): Promise<
      PostgresResponse<{
        documents: DocumentContent[];
        total: number;
        truncated: boolean;
      }>
    > {
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
      const limit = Math.min(Math.max(options?.limit ?? 20, 1), 200);
      const maxChars = Math.min(
        Math.max(options?.maxChars ?? 200_000, 1_000),
        2_000_000,
      );
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
        const norm = normalizePathPrefix(options?.pathPrefix);
        const prefixClause =
          norm === "" ? "" : " AND base_ref LIKE $1 ESCAPE '\\'";
        const prefixParams =
          norm === "" ? [] : [escapeLikeLiteral(norm) + "/%"];

        // Total distinct documents beneath the prefix (for the truncated flag).
        const access = versionedWhere(
          table,
          collection,
          scope,
          prefixParams,
          options?.validAt,
        );
        const totalRes = await client.query<{ total: string }>(
          `SELECT COUNT(DISTINCT base_ref) AS total
             FROM "${table}" WHERE TRUE${prefixClause}${access.sql}`,
          access.params,
        );
        const total = parseInt(totalRes.rows[0]!.total, 10);

        // The base_refs to reassemble, ordered deterministically, capped by limit.
        const refsRes = await client.query<{ base_ref: string }>(
          `SELECT base_ref
             FROM "${table}" WHERE TRUE${prefixClause}${access.sql}
            GROUP BY base_ref
            ORDER BY base_ref ASC
            LIMIT ${limit}`,
          access.params,
        );
        const baseRefs = refsRes.rows.map((r) => r.base_ref);
        if (baseRefs.length === 0) {
          return { documents: [], total, truncated: total > 0 };
        }

        // Fetch all visible chunks for the selected documents in ONE query, then group.
        const chunkAccess = versionedWhere(
          table,
          collection,
          scope,
          [baseRefs],
          options?.validAt,
        );
        const { rows } = await client.query<{
          base_ref: string;
          content: string;
          title: string | null;
          link: string | null;
          source: string | null;
          metadata: Metadata | null;
          tags: string[] | null;
          modified: Date;
          overlap_start: number | null;
          overlap_end: number | null;
          unit_type: string | null;
        }>(
          `SELECT base_ref, content, title, link, source, metadata, tags, modified,
                  (chunk->>'chunk_overlap_start')::int AS overlap_start,
                  (chunk->>'chunk_overlap_end')::int   AS overlap_end,
                  unit_type
             FROM "${table}"
            WHERE base_ref = ANY($1) AND ${DOCUMENT_BODY_SQL}${chunkAccess.sql}
            ORDER BY base_ref ASC, ${DOCUMENT_ORDER_SQL}`,
          chunkAccess.params,
        );

        // Group rows by base_ref, preserving the SQL order.
        const grouped = new Map<string, typeof rows>();
        for (const r of rows) {
          const list = grouped.get(r.base_ref);
          if (list) list.push(r);
          else grouped.set(r.base_ref, [r]);
        }

        const documents: DocumentContent[] = [];
        let truncated = total > baseRefs.length;
        let used = 0;
        // Iterate in the capped base_ref order.
        for (const baseRef of baseRefs) {
          const chunkRows = grouped.get(baseRef);
          if (chunkRows === undefined || chunkRows.length === 0) continue;
          // v2 units are whole block groups without overlap: one paragraph each.
          let content =
            chunkRows[0]?.unit_type != null
              ? chunkRows.map((r) => documentBodyText(r)).join("\n\n")
              : mergeOrderedChunkContents(
                  chunkRows.map((r) => ({
                    content: r.content,
                    overlapStart: r.overlap_start,
                    overlapEnd: r.overlap_end,
                  })),
                );
          // Combined-size guard: stop before exceeding maxChars. Always emit at
          // least the first document (truncated if it alone is too large).
          if (documents.length > 0 && used + content.length > maxChars) {
            truncated = true;
            break;
          }
          if (content.length > maxChars) {
            content = content.slice(0, maxChars);
            truncated = true;
          }
          const first = chunkRows[0]!;
          let latestModified = first.modified;
          for (const r of chunkRows)
            if (r.modified > latestModified) latestModified = r.modified;
          documents.push({
            reference: baseRef,
            title: first.title,
            link: first.link,
            source: first.source,
            metadata: first.metadata ?? {},
            tags: first.tags ?? [],
            chunks: chunkRows.length,
            content,
            modified: latestModified,
          });
          used += content.length;
        }

        return { documents, total, truncated };
      });
    },

    async getSummary(
      collection: string,
      scope: AccessScope,
      reference: string,
      options?: { validAt?: string },
    ): Promise<PostgresResponse<SummaryEntry | null>> {
      // Canonicalize to NFC (see getDocument / normalizeReference).
      reference = normalizeReference(reference);
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
        const resolveAccess = versionedWhere(
          table,
          collection,
          scope,
          [reference],
          options?.validAt,
        );
        const resolve = await client.query<{ base_ref: string }>(
          `SELECT base_ref FROM "${table}"
            WHERE (base_ref = $1 OR reference = $1)${resolveAccess.sql}
            LIMIT 1`,
          resolveAccess.params,
        );
        if (resolve.rows.length === 0) return null;
        const baseRef = resolve.rows[0]!.base_ref;
        const summaryAccess = versionedWhere(
          table,
          collection,
          scope,
          [baseRef],
          options?.validAt,
        );

        // The summary/prefix lives on chunk 0 only.
        const { rows } = await client.query<{
          prefix: string | null;
          title: string | null;
          link: string | null;
          is_summary: boolean | null;
          modified: Date;
        }>(
          // Same resolution as getSummaries: first body row's prefix, else the
          // v2 `document` unit.
          `SELECT COALESCE(
                    NULLIF((ARRAY_AGG(prefix ORDER BY ${DOCUMENT_ORDER_SQL})
                             FILTER (WHERE ${DOCUMENT_BODY_SQL}))[1], ''),
                    (ARRAY_AGG(content ORDER BY id ASC) FILTER (WHERE unit_type = 'document'))[1]
                  ) AS prefix,
                  (ARRAY_AGG(title ORDER BY ${DOCUMENT_ORDER_SQL}) FILTER (WHERE title IS NOT NULL AND title <> ''))[1] AS title,
                  (ARRAY_AGG(link  ORDER BY ${DOCUMENT_ORDER_SQL}) FILTER (WHERE link IS NOT NULL AND link <> ''))[1] AS link,
                  COALESCE(bool_or((chunk->>'summary') = 'true'), FALSE)
                    OR COALESCE(bool_or(unit_type = 'document'), FALSE) AS is_summary,
                  MAX(modified) AS modified
             FROM "${table}"
            WHERE base_ref = $1${summaryAccess.sql}
           HAVING COUNT(*) > 0`,
          summaryAccess.params,
        );
        if (rows.length === 0) return null;
        const r = rows[0]!;
        return {
          reference: baseRef,
          title: r.title,
          link: r.link,
          summary: r.prefix,
          isSummary: r.is_summary === true,
          modified: r.modified,
        };
      });
    },

    async getSummaries(
      collection: string,
      scope: AccessScope,
      options?: {
        pathPrefix?: string;
        limit?: number;
        offset?: number;
        validAt?: string;
      },
    ): Promise<PostgresResponse<{ summaries: SummaryEntry[]; total: number }>> {
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
      const limit = Math.min(Math.max(options?.limit ?? 100, 1), 1000);
      const offset = Math.max(options?.offset ?? 0, 0);
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
        const norm = normalizePathPrefix(options?.pathPrefix);
        const prefixClause =
          norm === "" ? "" : " AND base_ref LIKE $1 ESCAPE '\\'";
        const prefixParams =
          norm === "" ? [] : [escapeLikeLiteral(norm) + "/%"];

        const access = versionedWhere(
          table,
          collection,
          scope,
          prefixParams,
          options?.validAt,
        );
        const totalRes = await client.query<{ total: string }>(
          `SELECT COUNT(DISTINCT base_ref) AS total
             FROM "${table}" WHERE TRUE${prefixClause}${access.sql}`,
          access.params,
        );
        const total = parseInt(totalRes.rows[0]!.total, 10);

        // One row per document. prefix/title/link/summary-flag are taken from
        // the chunk-0 row (MIN chunk_index) via ordered ARRAY_AGG; sorted by
        // path so the overview reads folder-by-folder.
        const { rows } = await client.query<{
          reference: string;
          summary: string | null;
          title: string | null;
          link: string | null;
          is_summary: boolean | null;
          modified: Date;
        }>(
          // The summary is the first body row's prefix (v1, or a v2 document
          // the summary backfill wrote), else the v2 `document` unit — Extract's
          // document summary plus the top of the outline. Title and link are
          // the first non-empty value in reading order.
          `SELECT base_ref AS reference,
                  COALESCE(
                    NULLIF((ARRAY_AGG(prefix ORDER BY ${DOCUMENT_ORDER_SQL})
                             FILTER (WHERE ${DOCUMENT_BODY_SQL}))[1], ''),
                    (ARRAY_AGG(content ORDER BY id ASC) FILTER (WHERE unit_type = 'document'))[1]
                  ) AS summary,
                  (ARRAY_AGG(title ORDER BY ${DOCUMENT_ORDER_SQL}) FILTER (WHERE title IS NOT NULL AND title <> ''))[1] AS title,
                  (ARRAY_AGG(link  ORDER BY ${DOCUMENT_ORDER_SQL}) FILTER (WHERE link IS NOT NULL AND link <> ''))[1] AS link,
                  COALESCE(bool_or((chunk->>'summary') = 'true'), FALSE)
                    OR COALESCE(bool_or(unit_type = 'document'), FALSE) AS is_summary,
                  MAX(modified) AS modified
             FROM "${table}"
            WHERE TRUE${prefixClause}${access.sql}
            GROUP BY base_ref
            ORDER BY base_ref ASC
            LIMIT ${limit} OFFSET ${offset}`,
          access.params,
        );

        const summaries: SummaryEntry[] = rows.map((r) => ({
          reference: r.reference,
          title: r.title,
          link: r.link,
          summary: r.summary,
          isSummary: r.is_summary === true,
          modified: r.modified,
        }));
        return { summaries, total };
      });
    },

    async listDocumentsMissingSummary(
      collection: string,
      scope: AccessScope,
    ): Promise<PostgresResponse<string[]>> {
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
        // The chunk-0 row (unchunked docs have chunk = NULL → index 0) carries
        // the document summary in `prefix`. A NULL/empty prefix means the
        // document/chapter never received a summary.
        const access = scopedWhere(scope, []);
        const { rows } = await client.query<{ base_ref: string }>(
          // One row per document. A v2 document whose Extract document pass
          // produced a summary (its `document` unit) is not missing one.
          `SELECT base_ref
             FROM "${table}"
            WHERE is_latest${access.sql}
            GROUP BY base_ref
           HAVING NOT COALESCE(bool_or(unit_type = 'document'), FALSE)
              AND COALESCE((ARRAY_AGG(prefix ORDER BY ${DOCUMENT_ORDER_SQL})
                             FILTER (WHERE ${DOCUMENT_BODY_SQL}))[1], '') = ''
            ORDER BY base_ref ASC`,
          access.params,
        );
        return rows.map((r) => r.base_ref);
      });
    },

    async getDocumentText(
      collection: string,
      baseRef: string,
      scope: AccessScope,
    ): Promise<PostgresResponse<{ content: string }>> {
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
      const ref = normalizeReference(baseRef);
      return withClient(async (client) => {
        // Reassemble the document/chapter text from its chunks in chunk order.
        const access = scopedWhere(scope, [ref]);
        const { rows } = await client.query<{ content: string | null }>(
          `SELECT string_agg(content, E'\n' ORDER BY ${DOCUMENT_ORDER_SQL}) AS content
             FROM "${table}"
            WHERE is_latest AND base_ref = $1 AND ${DOCUMENT_BODY_SQL}${access.sql}`,
          access.params,
        );
        return { content: rows[0]?.content ?? "" };
      });
    },

    async setDocumentSummary(
      collection: string,
      baseRef: string,
      summary: string,
      scope: AccessScope,
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
      const ref = normalizeReference(baseRef);
      const cleanSummary = stripNullBytes(summary);
      return withClient(async (client) => {
        const meta = await getOrLoadCollectionMeta(client, table);
        // lang comes from validated collection meta (ALLOWED_FTS_LANGUAGES),
        // never user input, so interpolation is safe here.
        const lang = meta.language;
        // Store the summary in chunk-0's prefix, flag it as an LLM summary, and
        // merge its tokens into ts_search so it becomes keyword-searchable —
        // mirroring what buildFtsText does at ingest time.
        const access = scopedWhere(scope, [ref, cleanSummary]);
        const res = await client.query(
          `UPDATE "${table}"
              SET prefix    = $2,
                  chunk     = jsonb_set(COALESCE(chunk, '{}'::jsonb), '{summary}', 'true'::jsonb, true),
                  ts_search = COALESCE(ts_search, ''::tsvector) || to_tsvector('${lang}', $2),
                  modified  = NOW()
            WHERE id = (
                    SELECT id FROM "${table}"
                     WHERE is_latest AND base_ref = $1 AND ${DOCUMENT_BODY_SQL}${access.sql}
                     ORDER BY ${DOCUMENT_ORDER_SQL}
                     LIMIT 1)`,
          access.params,
        );
        return { updated: res.rowCount ?? 0 };
      });
    },
  };
}
