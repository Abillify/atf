// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * postgres-client methods: The PostgresClient search method.
 *
 * Extracted verbatim from postgres-client.ts (Requirement 13.6).
 * Shared factory state arrives via PgFactoryCtx; bodies are
 * unchanged.
 */

import type { AccessScope } from "./access-scope.js";
import { AppError, collectionTableName } from "./collection-ddl.js";
import { compoundPartsForQuery } from "./compound-split.js";
import { buildIdentifierTsQuery, queryIdentifierValueNorms } from "./identifier.js";
import type { Metadata } from "./metadata.js";
import { BINARY_CANDIDATE_HARD_CAP, HYBRID_CANDIDATE_HARD_CAP, buildBinaryDenseQuery, buildDenseQuery, buildFtsQuery, buildHybridQuery, candidatePoolSize, type LexicalRanker } from "./query-builder.js";
import { sparseVectorToPg, type SparseVector } from "./sparse-embedding-client.js";
import { toBinaryString } from "./vector-utils.js";
import { annotatePartialRevisions, escapeLikeLiteral, lookupIdentifierUnitIds, normalizePathPrefix } from "./pg-helpers.js";
import type { ChunkInfo, PostgresResponse, SearchCursor, SearchExecutionPlan, SearchFilter, SearchOptions, SearchResult } from "./pg-types.js";

import type { PgFactoryCtx } from "./pg-factory-ctx.js";

export function createSearchMethods(ctx: PgFactoryCtx) {
  const {
    pool,
    logger,
    withClient,
    getOrLoadCollectionMeta,
    detectBm25Engine,
    effectiveIterativeScan,
    efSearch,
    hnswMaxScanTuples,
    rrfK,
    rrfWeightDense,
    rrfWeightFts,
    rrfWeightIdentifier,
    rrfWeightSparse,
    rrfMissingZero,
    ftsRanker,
    ftsCompoundSplit,
    ftsLexiconCache,
    expectedEmbeddingModel,
    expectedEmbeddingModelRevision,
    vecType,
  } = ctx;

  return {
    async search(
      query: string,
      vector: number[],
      limit: number,
      collection: string,
      scope: AccessScope,
      filter?: SearchFilter,
      hybridSearch = true,
      includeAllVersions = false,
      offset = 0,
      candidateMultiplier = 4,
      sparseVector?: SparseVector,
      tags?: string[],
      cursor?: SearchCursor,
      ftsOnly = false,
      baseRef?: string,
      pathPrefix?: string,
      timeoutMs?: number,
      signal?: AbortSignal,
      onPlan?: (plan: SearchExecutionPlan) => void,
      validAt?: string,
      searchOptions?: SearchOptions,
    ): Promise<PostgresResponse<SearchResult[]>> {
      const table = collectionTableName(collection);
      // Normalise a folder path prefix into a wildcard-escaped LIKE pattern
      // (e.g. "/Unterlagen Teil 1" → "/Unterlagen Teil 1/%"). Empty/root
      // prefixes yield undefined so no filter is applied.
      const normPrefix = normalizePathPrefix(pathPrefix);
      const pathLike =
        normPrefix === "" ? undefined : escapeLikeLiteral(normPrefix) + "/%";
      return withClient(async (client) => {
        const meta = await getOrLoadCollectionMeta(client, table);
        if (
          expectedEmbeddingModel !== undefined &&
          meta.embeddingModel !== expectedEmbeddingModel
        ) {
          // A collection that does not exist has no provenance either; say
          // what is actually wrong instead of reporting a model mismatch.
          const exists = await client.query<{ t: string | null }>(
            `SELECT to_regclass($1) AS t`,
            [`"${table}"`],
          );
          if (!exists.rows[0]?.t) {
            throw new AppError(
              "COLLECTION_NOT_FOUND",
              `Collection "${collection}" not found`,
            );
          }
          throw new AppError(
            "EMBEDDING_PROVENANCE_MISMATCH",
            "EMBEDDING_PROVENANCE_MISMATCH: collection model provenance is unknown or differs; reindex and cut over explicitly",
          );
        }
        if (
          expectedEmbeddingModelRevision !== undefined &&
          meta.embeddingModelRevision !== expectedEmbeddingModelRevision
        ) {
          throw new AppError(
            "EMBEDDING_PROVENANCE_MISMATCH",
            "EMBEDDING_PROVENANCE_MISMATCH: collection model revision is unknown or differs; reindex and cut over explicitly",
          );
        }
        const useSparse = meta.sparseEnabled && sparseVector != null;
        onPlan?.({ sparseApplied: hybridSearch && !ftsOnly && useSparse });

        await client.query("BEGIN");
        let abortListener: (() => void) | undefined;
        try {
          if (timeoutMs !== undefined && timeoutMs > 0) {
            await client.query(
              `SET LOCAL statement_timeout = ${Math.max(1, Math.ceil(timeoutMs))}`,
            );
          }
          if (signal) {
            if (signal.aborted) throw new Error("Search aborted");
            const backend = await client.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            );
            const pid = backend.rows[0]?.pid;
            if (pid !== undefined) {
              abortListener = () => {
                void pool
                  .query("SELECT pg_cancel_backend($1)", [pid])
                  .catch(() => {});
              };
              signal.addEventListener("abort", abortListener, { once: true });
            }
          }
          // HNSW tuning inside this transaction (Req 4.1). Skipped for
          // FTS-only searches, which never touch an HNSW index. The
          // candidate pool mirrors the builder exactly (same
          // candidatePoolSize + hard cap), so `ef_search ≥ candidateLimit`
          // holds for the pool the SQL actually requests; a plain dense
          // search has no multiplier pool — its window is limit + offset.
          if (!ftsOnly) {
            // Mirrors the builder dispatch: hybrid → buildHybridQuery
            // (HYBRID cap), binary quantization on the dense path →
            // buildBinaryDenseQuery (BINARY cap), both with a
            // candidateMultiplier pool; plain dense has no pool — its
            // window is limit + offset.
            const binaryDense =
              meta.quantization === "binary" &&
              !!meta.vectorSize &&
              !hybridSearch;
            const poolHardCap = binaryDense
              ? BINARY_CANDIDATE_HARD_CAP
              : HYBRID_CANDIDATE_HARD_CAP;
            const candidateLimit =
              hybridSearch || binaryDense
                ? candidatePoolSize(
                    limit,
                    offset,
                    candidateMultiplier,
                    poolHardCap,
                  )
                : Math.max(1, limit + Math.max(0, offset));
            const scanMode = await effectiveIterativeScan(client);
            if (scanMode !== "off") {
              // Both values come from validated config (enum / integer),
              // never from request input — safe to interpolate.
              await client.query(`SET LOCAL hnsw.iterative_scan = ${scanMode}`);
              await client.query(
                `SET LOCAL hnsw.max_scan_tuples = ${hnswMaxScanTuples}`,
              );
            }
            await client.query(
              `SET LOCAL hnsw.ef_search = ${Math.max(efSearch, candidateLimit)}`,
            );
          }

          const vectorJson = JSON.stringify(vector);
          const sparseJson = useSparse
            ? sparseVectorToPg(sparseVector!)
            : undefined;
          const binaryStr =
            meta.quantization === "binary" && meta.vectorSize
              ? toBinaryString(vector)
              : undefined;

          // Identifier RRF list (task 3.4, Req 12.1/12.3): OPT-IN per call
          // (searchOptions.identifierList) so v1 /search and the legacy MCP
          // search keep their exact previous ranking (Req 13.7). Only for the
          // hybrid path and only when the query carries (or the caller names)
          // an identifier. Two sources feed the one list: exact vs_identifiers
          // hits (tenant + collection scoped) and lexical ts_ident matches;
          // buildHybridQuery unions them (best rank wins) as the third list.
          // No identifier → no lookup, no third list, unchanged SQL.
          const identifierNorms =
            searchOptions?.identifierList === true && hybridSearch && !ftsOnly
              ? queryIdentifierValueNorms(
                  query,
                  searchOptions.identifiers ?? [],
                )
              : [];
          const identifierUnitIds =
            identifierNorms.length > 0
              ? await lookupIdentifierUnitIds(
                  client,
                  identifierNorms,
                  scope.tenantId,
                  collection,
                  logger,
                )
              : [];
          const identifierTsQuery = buildIdentifierTsQuery(identifierNorms);

          // FTS_RANKER (Req 4.7, task 6.9): only detect the BM25 extension
          // when bm25 was actually configured — the default path never runs
          // the extra catalog query. `bm25Engine: null` (no extension) makes
          // the builders fall back to ts_rank_cd verbatim.
          const lexical: LexicalRanker | undefined =
            ftsRanker === "bm25"
              ? {
                  ranker: "bm25",
                  bm25Engine: await detectBm25Engine(client, table),
                }
              : undefined;

          // FTS_COMPOUND_SPLIT=query: extra OR-only terms from splitting long
          // query compounds against the collection lexicon. The cache read is
          // synchronous: a miss starts the build in the background and yields
          // no terms, so the triggering query runs without splitting.
          const lexicon = ftsCompoundSplit
            ? ftsLexiconCache.get(table)
            : undefined;
          const compoundTerms =
            lexicon !== undefined
              ? compoundPartsForQuery(query, lexicon)
              : undefined;

          const { sql, params } = ftsOnly
            ? buildFtsQuery(
                table,
                meta.language,
                limit,
                filter,
                includeAllVersions,
                offset,
                query,
                scope,
                tags,
                cursor,
                baseRef,
                pathLike,
                validAt,
                collection,
                lexical,
                compoundTerms,
              )
            : hybridSearch
              ? buildHybridQuery(
                  table,
                  vecType,
                  rrfK,
                  meta.language,
                  limit,
                  filter,
                  includeAllVersions,
                  candidateMultiplier,
                  offset,
                  useSparse,
                  meta.sparseVocabSize,
                  vectorJson,
                  query,
                  sparseJson,
                  binaryStr,
                  meta.vectorSize,
                  scope,
                  tags,
                  cursor,
                  pathLike,
                  validAt,
                  collection,
                  {
                    weightDense: rrfWeightDense,
                    weightFts: rrfWeightFts,
                    weightIdentifier: rrfWeightIdentifier,
                    weightSparse: rrfWeightSparse,
                    missingZero: rrfMissingZero,
                    identifierUnitIds,
                    identifierTsQuery,
                  },
                  lexical,
                  compoundTerms,
                )
              : binaryStr && meta.vectorSize
                ? buildBinaryDenseQuery(
                    table,
                    vecType,
                    meta.vectorSize,
                    limit,
                    filter,
                    includeAllVersions,
                    offset,
                    vectorJson,
                    binaryStr,
                    candidateMultiplier,
                    scope,
                    tags,
                    cursor,
                    pathLike,
                    validAt,
                    collection,
                  )
                : buildDenseQuery(
                    table,
                    vecType,
                    limit,
                    filter,
                    includeAllVersions,
                    offset,
                    vectorJson,
                    scope,
                    tags,
                    cursor,
                    pathLike,
                    validAt,
                    collection,
                  );

          const result = await client.query(sql, params);
          await client.query("COMMIT");

          const searchResults: SearchResult[] = result.rows.map((row) => ({
            id: String(row.id),
            score: ftsOnly
              ? parseFloat(row.text_score)
              : hybridSearch
                ? parseFloat(row.rrf_score)
                : parseFloat(row.vector_similarity),
            vector_score: ftsOnly
              ? undefined
              : row.vector_similarity != null
                ? parseFloat(row.vector_similarity)
                : undefined,
            text_score:
              row.text_score != null ? parseFloat(row.text_score) : undefined,
            sparse_score: ftsOnly
              ? undefined
              : row.sparse_score != null
                ? parseFloat(row.sparse_score)
                : undefined,
            content: row.content as string,
            prefix: (row.prefix as string) ?? undefined,
            metadata: row.metadata as Metadata,
            chunk: (row.chunk as ChunkInfo) ?? undefined,
            evidence: (() => {
              const chunk = (row.chunk as ChunkInfo | null) ?? undefined;
              const reference = row.reference as string;
              const baseRef = (row.base_ref as string) ?? reference;
              return {
                ...(chunk?.chunk_id ? { chunk_id: chunk.chunk_id } : {}),
                reference,
                root_document_id: chunk?.root_document_id ?? baseRef,
                ...(chunk?.char_start !== undefined
                  ? { char_start: chunk.char_start }
                  : {}),
                ...(chunk?.char_end !== undefined
                  ? { char_end: chunk.char_end }
                  : {}),
                ...(chunk?.page_start !== undefined
                  ? { page_start: chunk.page_start }
                  : {}),
                ...(chunk?.page_end !== undefined
                  ? { page_end: chunk.page_end }
                  : {}),
                ...(chunk?.section_path
                  ? { section_path: chunk.section_path }
                  : {}),
                ...(chunk?.modality ? { modality: chunk.modality } : {}),
                ...(chunk?.figure_id ? { figure_id: chunk.figure_id } : {}),
                ...(chunk?.asset_id ? { asset_id: chunk.asset_id } : {}),
                ...(chunk?.bbox ? { bbox: chunk.bbox } : {}),
                ...(chunk?.figure_refs?.length
                  ? {
                      figure_refs: chunk.figure_refs,
                      asset_ids: chunk.figure_refs.map((ref) => ref.asset_id),
                    }
                  : {}),
              };
            })(),
            reference: row.reference as string,
            base_ref: (row.base_ref as string) ?? (row.reference as string),
            source: row.source as string | undefined,
            link: row.link as string | undefined,
            title: row.title as string | undefined,
            tags: row.tags as string[] | undefined,
            ...((assetId) =>
              assetId
                ? {
                    asset_url: `/v2/assets/${encodeURIComponent(assetId)}?collection=${encodeURIComponent(collection)}`,
                  }
                : {})((row.chunk as ChunkInfo | null)?.asset_id),
            created: row.created as Date,
            modified: row.modified as Date,
            valid_from: (row.valid_from as Date | null) ?? null,
            effective_valid_from: row.effective_valid_from as Date,
            ...(typeof row.revision_id === "string" && row.revision_id !== ""
              ? { revision_id: row.revision_id as string }
              : {}),
          }));

          // Tag hits that come from a partially-visible `progressive` revision
          // with revision_state=partial + pages_available (Requirement 6.4). The
          // pointer filter already ensured every hit is the document's current
          // revision, so a hit is "partial" iff its revision's status is 'partial'
          // (still ingesting) rather than 'committed'. We resolve status + the
          // committed page span once per distinct revision, not per row.
          const revisionIds = [
            ...new Set(
              result.rows
                .map((r) => (r as { revision_id?: string | null }).revision_id)
                .filter(
                  (id): id is string => typeof id === "string" && id.length > 0,
                ),
            ),
          ];
          if (revisionIds.length > 0) {
            const partial = await annotatePartialRevisions(client, revisionIds);
            if (partial.size > 0) {
              for (let i = 0; i < searchResults.length; i++) {
                const revId = (
                  result.rows[i] as { revision_id?: string | null }
                ).revision_id;
                const info = revId ? partial.get(revId) : undefined;
                const sr = searchResults[i];
                if (!info || !sr) continue;
                sr.revision_state = "partial";
                sr.pages_available = info.pagesAvailable;
                if (sr.evidence) {
                  sr.evidence.revision_state = "partial";
                  sr.evidence.pages_available = info.pagesAvailable;
                }
              }
            }
          }

          return searchResults;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          if (signal && abortListener) {
            signal.removeEventListener("abort", abortListener);
          }
        }
      });
    },
  };
}
