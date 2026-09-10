// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * postgres-client.ts
 *
 * Public PostgresClient interface and factory.
 * DDL logic lives in collection-ddl.ts, query builders in query-builder.ts,
 * and the stats write-buffer in stats-buffer.ts.
 */

import type pino from "pino";
import { Pool, type PoolClient } from "pg";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";
import type { Metadata } from "./metadata.js";
import {
  type SparseVector,
  sparseVectorToPg,
} from "./sparse-embedding-client.js";
import { toBinaryString } from "./vector-utils.js";
import {
  validateFtsLanguage,
  collectionTableName,
  COLLECTION_TABLE_PREFIX,
  type CollectionMeta,
  ensureCollectionConfigTable,
  loadCollectionMeta,
  ensureCollectionDDL,
  buildUpsertSqlParts,
  pushExtraParams,
  CURRENT_SCHEMA_VERSION,
  AppError,
} from "./collection-ddl.js";
import {
  buildDenseQuery,
  buildBinaryDenseQuery,
  buildHybridQuery,
  buildFtsQuery,
  buildAccessSql,
  SqlParams,
} from "./query-builder.js";
import type { AccessScope } from "./access-scope.js";
import { createStatsBuffer } from "./stats-buffer.js";
import type { CollectionAcl } from "./collection-access.js";

export { validateFtsLanguage, collectionTableName };

// ─── FTS content preprocessing ────────────────────────────────────────────────

/**
 * Prepare content for full-text search indexing.
 *
 * Applied in order:
 * 1. Fenced code blocks (``` … ```) — remove entirely; code tokens fragment
 *    badly and pollute the index with identifiers like "const", "return", etc.
 * 2. Inline code (`…`) — remove the backtick markers, keep the text so short
 *    identifiers like function names remain searchable.
 * 3. Markdown images (![alt](url)) — keep the alt text, drop the URL.
 * 4. Markdown links ([text](url)) — keep the link text, drop the URL.
 * 5. URLs — remove entirely (short URLs too; they fragment into noise tokens
 *    like "https", "com", "path").
 * 6. Bold / italic markers (* ** _ __) — strip markers, keep text.
 * 7. ATX headings (# … ######) — strip the leading `#` markers.
 * 8. Blockquote markers (> at line start) — strip.
 * 9. Horizontal rules (--- / *** / ___) — remove entire line.
 * 10. Long tokens (> MAX_FTS_TOKEN_LENGTH chars) — remove remaining blobs
 *     (base64, JWTs, hashes, long UUIDs) that survived earlier steps.
 */
const MAX_FTS_TOKEN_LENGTH = 50;

export function prepareFtsContent(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code — keep text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images — keep alt text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links — keep link text
    .replace(/https?:\/\/\S+/gi, " ") // bare URLs
    .replace(/(\*{1,3}|_{1,3})([^*_]+)\1/g, "$2") // bold / italic markers
    .replace(/^#{1,6}\s+/gm, "") // ATX heading markers
    .replace(/^>\s*/gm, "") // blockquote markers
    .replace(/^(\s*[-*_]){3,}\s*$/gm, " ") // horizontal rules
    .replace(/\S{51,}/g, " ") // remaining long tokens
    .trim();
}

/**
 * Build the text fed into the FTS tsvector for a document point.
 *
 * For chunk 0 (or unchunked documents) we prepend:
 *   - `title`    — so title-keyword searches hit the document
 *   - `base_ref` — so reference-keyword searches hit the document
 *   - `prefix`   — the LLM summary or text-slice stored on chunk 0;
 *                  summaries often contain key terms not present in the
 *                  chunk text itself, so excluding them from FTS would
 *                  miss those matches entirely
 *
 * For chunks > 0 we index only the chunk content — adding identity /
 * summary fields to every chunk would over-weight documents with many
 * chunks in FTS ranking.
 */
export function buildFtsText(point: DocumentPoint): string {
  const isFirstChunk =
    point.chunk === undefined || point.chunk.chunk_index === 0;

  let text = point.content;
  if (isFirstChunk) {
    const parts: string[] = [];
    if (point.title) parts.push(point.title);
    // base_ref for unchunked docs equals reference; for chunked docs it's the
    // parent reference without the _chunk_N suffix.
    parts.push(point.baseRef ?? point.reference);
    // prefix holds the LLM summary (or leading text slice) stored on chunk 0.
    // Including it in FTS means summary-only terms are discoverable via keyword search.
    if (point.prefix) parts.push(point.prefix);
    text = `${parts.join("\n")}\n${text}`;
  }
  return prepareFtsContent(text);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PostgresClientConfig {
  connectionString: string;
  logger: pino.Logger;
  /** HNSW ef_search: controls recall vs latency at query time. Default: 100. */
  efSearch?: number;
  /** HNSW ef_construction for new indexes (default: 128). */
  efConstruction?: number;
  /** HNSW m parameter for new indexes (default: 16). */
  hnswM?: number;
  /** Use halfvec (16-bit) instead of vector (32-bit) for new collections. Default: false. */
  halfPrecision?: boolean;
  /** Server-wide default FTS language for new collections. Default: 'simple'. */
  defaultFtsLanguage?: string;
  /** Delete stats rows older than N days. 0 = keep forever. Default: 90. */
  statsRetentionDays?: number;
  /** RRF k parameter for hybrid search scoring. Default: 60. */
  rrfK?: number;
  /** Interval in ms for flushing buffered stats to the database. Default: 30 000. */
  statsFlushIntervalMs?: number;
  /**
   * Binary quantization for new collections.
   * 'binary' adds a bit_vector column and HNSW index for two-stage search.
   * Default: 'none'.
   */
  quantization?: "none" | "binary";
  /** Expected embedding provenance for every searchable/writable collection. */
  embeddingModel?: string;
  embeddingModelRevision?: string;
  /** Maximum connections in the pool. Default: 20. */
  poolMax?: number;
  /**
   * Per-query statement timeout in milliseconds. Prevents runaway queries from
   * holding a pool connection indefinitely. 0 = disabled. Default: 30 000.
   */
  statementTimeoutMs?: number;
  /**
   * Optional list of circuit breaker status getters for external services.
   * When provided, getCircuitBreakerStatuses() delegates to these functions
   * so /metrics and /health can report the state of each downstream service.
   */
  circuitBreakerGetters?: Array<() => CircuitBreakerStatus>;
}

export interface DocumentPoint {
  /** Server-derived tenant; never sourced from document metadata or request headers. */
  tenantId?: string;
  reference: string;
  baseRef?: string;
  version?: string;
  vector: number[];
  sparseVector?: SparseVector;
  content: string;
  /**
   * Context prefix stored for chunk_index = 0 only.
   * Contains the first `prefix_size` characters of the document —
   * effectively a summary/introduction that can be used for brief ranking
   * without fetching the full document.
   */
  prefix?: string;
  metadata: Metadata;
  chunk?: ChunkInfo;
  source?: string;
  link?: string;
  title?: string;
  tags?: string[];
  allowedUsers?: string[];
  allowedGroups?: string[];
  /** Preserve persisted row ACLs when an upsert conflicts; INSERT ACLs still come from this point. */
  preserveExistingAclOnConflict?: boolean;
}

/**
 * Ingest-technical information about a chunk.
 * Stored in the `chunk` JSONB column, never mixed into user metadata.
 */
export interface ChunkInfo {
  /** 0-based index of this chunk within the document. */
  chunk_index: number;
  /** Total number of chunks the document was split into. */
  chunk_total: number;
  /** Target chunk size in characters. */
  chunk_size: number;
  /** Deterministic content/source-coordinate identifier. */
  chunk_id?: string;
  /** Original root-document character span (start inclusive, end exclusive). */
  char_start?: number;
  char_end?: number;
  parent_ref?: string;
  root_document_id?: string;
  section_path?: string[];
  page_start?: number;
  page_end?: number;
  /**
   * Characters by which the chunk start was extended backwards (overlap).
   * Omitted for semantic chunking where overlap is always 0.
   */
  chunk_overlap_start?: number;
  /**
   * Characters by which the chunk end was extended forwards (overlap).
   * Omitted for semantic chunking where overlap is always 0.
   */
  chunk_overlap_end?: number;
  /** Whether semantic (embedding-based) chunking was used. */
  semantic_chunking?: boolean;
  /**
   * Percentile threshold used for semantic breakpoint detection.
   * Only present when semantic_chunking is true.
   */
  breakpoint_percentile?: number;
  /**
   * Max overlap size passed to the text chunker.
   * Omitted for semantic chunking (overlap concept does not apply).
   */
  chunk_overlap?: number;
  /** Late-chunking alpha used when blending chunk and document embeddings. */
  late_chunking_alpha?: number;
  /**
   * Characters of document beginning stored as `prefix` on chunk 0
   * and prepended to the embedding input of subsequent chunks.
   * When set, chunk 0's `prefix` column contains the document summary.
   */
  context_prefix_size?: number;
  /**
   * True when prefix was generated by an LLM summarization model
   * rather than mechanically sliced from the document beginning.
   */
  summary?: boolean;
  summary_source?: "embedded" | "generated";
  modality?: "image";
  figure_id?: string;
  asset_id?: string;
  bbox?: [number, number, number, number];
}

export interface SearchFilter {
  [key: string]: unknown;
}

export interface SearchEvidence {
  chunk_id?: string;
  reference: string;
  root_document_id: string;
  char_start?: number;
  char_end?: number;
  page_start?: number;
  page_end?: number;
  section_path?: string[];
  modality?: "image";
  figure_id?: string;
  asset_id?: string;
  bbox?: [number, number, number, number];
}

export interface SearchResult {
  id: string;
  score: number;
  vector_score?: number;
  text_score?: number;
  sparse_score?: number;
  content: string;
  /** Context prefix of the document (stored on chunk_index = 0). */
  prefix?: string;
  metadata: Metadata;
  /** Ingest-technical chunk info. Present only for chunked documents. */
  chunk?: ChunkInfo;
  /** Additive citation coordinates derived from immutable chunk metadata. */
  evidence?: SearchEvidence;
  reference: string;
  /** Base document reference (without chunk suffix). Equals reference for non-chunked docs. */
  base_ref: string;
  source?: string;
  link?: string;
  title?: string;
  tags?: string[];
  /** Relative authenticated endpoint for an image evidence asset. */
  asset_url?: string;
  created: Date;
  modified: Date;
}

/**
 * Opaque cursor for keyset pagination.
 *
 * The sort key, and therefore the cursor, is **(score DESC, created ASC, id ASC)**
 * for every ranked search mode. `created` is the immutable insert timestamp (not
 * `modified`), so concurrent updates to already-returned rows cannot shift them
 * into or out of a later page; `id` breaks remaining ties.
 *
 * Why `score` is part of the cursor
 * ─────────────────────────────────
 * The previous cursor held only `(created, id)` while the queries ordered by
 * relevance first. Filtering `created > cursor.created` against a
 * relevance-ordered result set silently DROPPED every highly-ranked document
 * older than the last row of the previous page. Paging a ranked search therefore
 * lost top hits without any error — the worst failure mode for a search API.
 *
 * Format (base64url):
 *   v2: "v2|<score>|<iso-timestamp>|<id>"   (current)
 *   v1: "<iso-timestamp>|<id>"              (still decoded, treated as unranked)
 *
 * A v1 cursor is accepted so in-flight pagination survives a deploy, but it
 * carries no score and is therefore only correct for non-ranked ordering.
 */
export interface SearchCursor {
  /** ISO-8601 timestamp of the last result's `created` field. */
  created: string;
  /** Numeric id (as string) of the last result. */
  id: string;
  /**
   * Relevance score of the last result on the previous page. Absent for a
   * legacy v1 cursor; the query builders then fall back to `(created, id)`
   * ordering, which is only sound when the query is not score-ordered.
   */
  score?: number;
}

/** Encode a cursor to an opaque base64url string (v2 format). */
export function encodeCursor(cursor: SearchCursor): string {
  const payload =
    cursor.score !== undefined && Number.isFinite(cursor.score)
      ? `v2|${cursor.score}|${cursor.created}|${cursor.id}`
      : `${cursor.created}|${cursor.id}`;
  return Buffer.from(payload, "utf-8").toString("base64url");
}

/** Decode a cursor string. Returns null if the format is invalid. */
export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");

    if (decoded.startsWith("v2|")) {
      // v2|<score>|<created>|<id> — `created` may itself contain no "|", and id
      // is taken from the end so an id containing "|" cannot corrupt parsing.
      const rest = decoded.slice(3);
      const firstSep = rest.indexOf("|");
      if (firstSep === -1) return null;
      const scoreRaw = rest.slice(0, firstSep);
      const tail = rest.slice(firstSep + 1);
      const lastSep = tail.lastIndexOf("|");
      if (lastSep === -1) return null;
      const created = tail.slice(0, lastSep);
      const id = tail.slice(lastSep + 1);
      const score = Number(scoreRaw);
      if (!created || !id || !Number.isFinite(score)) return null;
      return { created, id, score };
    }

    const sep = decoded.lastIndexOf("|");
    if (sep === -1) return null;
    const created = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!created || !id) return null;
    return { created, id };
  } catch {
    return null;
  }
}

export interface SearchPage {
  results: SearchResult[];
  /**
   * Cursor for the next page. Absent when there are no more results
   * (i.e. the returned results count is less than the requested limit).
   */
  nextCursor?: string;
}

export interface PostgresError {
  code:
    | "POSTGRES_UNREACHABLE"
    | "POSTGRES_SQL_ERROR"
    | "POSTGRES_INVALID_RESPONSE"
    | "INVALID_COLLECTION_NAME"
    | "COLLECTION_NOT_FOUND";
  message: string;
  cause?: unknown;
}

export type PostgresResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error: PostgresError };

export interface IngestStats {
  tenant_id: string;
  collection: string;
  operation: "insert" | "update" | "version";
  reference: string;
  timestamp: Date;
  duration_ms: number;
  chunks_processed: number;
}

export interface SearchStats {
  tenant_id: string;
  collection: string;
  query: string;
  timestamp: Date;
  duration_ms: number;
  results_count: number;
  hybrid_search: boolean;
  reranked: boolean;
}

export interface CollectionInfo {
  collection: string;
  table: string;
  ftsLanguage: string;
  sparseEnabled: boolean;
  sparseVocabSize: number | null;
  quantization: "none" | "binary";
  vectorSize: number | null;
  /** Optional build provenance; absent on collections created before this additive schema update. */
  embeddingModel: string | null;
  embeddingModelRevision: string | null;
  indexBuildVersion: string | null;
  indexAlgorithm: string | null;
  indexParameters: Record<string, number> | null;
  created: Date;
  updatedAt: Date;
  /** Number of unique base documents (is_latest = TRUE, distinct base_ref). */
  totalDocs: number;
  /** Total row count (all chunks, all versions). */
  totalChunks: number;
  /** Collection-level ACL: users allowed to access it (empty = public). */
  allowedUsers: string[];
  /** Collection-level ACL: groups allowed to access it (empty = public). */
  allowedGroups: string[];
}

/** Aggregate counts for a collection, optionally scoped to a folder prefix. */
export interface CollectionStats {
  collection: string;
  /** Distinct base documents (is_latest) in scope. */
  totalDocs: number;
  /** Latest-version chunk rows in scope. */
  totalChunks: number;
  /** The path prefix the stats were scoped to, or null for the whole collection. */
  pathPrefix: string | null;
}

/** Min/max/avg/median numeric distribution (all in the same unit). */
export interface NumberStats {
  min: number;
  max: number;
  avg: number;
  median: number;
}

/**
 * Rich, human-oriented overview of a collection (or a folder within it):
 * counts, chunk/document size distributions, summary coverage and the
 * collection's index configuration. Produced by `getCollectionOverview`.
 */
export interface CollectionOverview {
  collection: string;
  /** The path prefix the overview was scoped to, or null for the whole collection. */
  pathPrefix: string | null;
  /** Distinct base documents (is_latest) in scope. */
  documents: number;
  /** Latest-version chunk rows in scope. */
  chunks: number;
  /** All chunk rows in scope, including superseded versions. */
  chunkRowsAllVersions: number;
  /** Distinct folders (derived from document paths) within the scope. */
  folders: number;
  /** Chunk content length in characters, across all latest chunks. */
  chunkChars: NumberStats | null;
  /** Number of chunks per document. */
  chunksPerDocument: NumberStats | null;
  /** Total content length in characters per document (sum of its chunks). */
  documentChars: NumberStats | null;
  /** Total content characters across all documents in scope. */
  totalContentChars: number;
  /** Summary/prefix coverage across documents. */
  summaries: {
    /** Documents that carry a real LLM-generated summary on chunk 0. */
    documentsWithSummary: number;
    /** Documents that carry any chunk-0 prefix (LLM summary OR leading slice). */
    documentsWithPrefix: number;
    /** documentsWithSummary / documents, 0..1 (0 when there are no documents). */
    coverage: number;
    /** Average character length of stored prefixes/summaries, or null when none. */
    avgSummaryChars: number | null;
  };
  /** Index configuration for the collection (null if not recorded). */
  config: {
    vectorSize: number | null;
    ftsLanguage: string | null;
    sparseEnabled: boolean | null;
    quantization: "none" | "binary" | null;
    created: Date | null;
    updatedAt: Date | null;
  } | null;
  /** Oldest and newest `modified` timestamps in scope. */
  modified: { earliest: Date | null; latest: Date | null };
}

/** One document (grouped by base_ref) in a listing. */
export interface DocumentSummary {
  /** Base document reference — for file-backed collections this is the path. */
  reference: string;
  title: string | null;
  link: string | null;
  source: string | null;
  /** Number of latest-version chunks the document is split into. */
  chunks: number;
  /** Total content size in bytes (sum of octet_length over latest chunks). */
  size: number;
  modified: Date;
}

/** One sub-folder derived from document reference paths. */
export interface FolderSummary {
  /** Full folder path (e.g. "/Unterlagen Teil 1"). */
  path: string;
  /** Number of documents (files) anywhere beneath this folder. */
  documents: number;
  /** Number of chunks anywhere beneath this folder (latest versions). */
  chunks: number;
  /** Number of immediate child folders directly under this folder. */
  subfolderCount: number;
  /** Names of the immediate child folders (sorted), for quick navigation. */
  subfolders: string[];
  /**
   * Fuzzy match score (0..1) against the search query — only set by
   * `findFolders`, higher is a better match. Absent for plain folder listings.
   */
  score?: number;
}

/** The stored summary/prefix of one document (chunk-0 `prefix` column). */
export interface SummaryEntry {
  reference: string;
  title: string | null;
  link: string | null;
  /**
   * The document's context prefix from chunk 0: the LLM summary when the
   * document was ingested with X-Summarize, otherwise the leading text-slice,
   * or null when no prefix was stored.
   */
  summary: string | null;
  /** true when `summary` is a real LLM-generated summary (not a text-slice). */
  isSummary: boolean;
  modified: Date;
}

/** A whole document reassembled from its (latest) chunks. */
export interface DocumentContent {
  reference: string;
  title: string | null;
  link: string | null;
  source: string | null;
  metadata: Metadata;
  tags: string[];
  /** Number of chunks that were merged. */
  chunks: number;
  /** Document text, reassembled in chunk order with overlaps trimmed. May be a window (see truncated/totalChars). */
  content: string;
  modified: Date;
  /** Total character length of the full document before windowing (get_document only). */
  totalChars?: number;
  /** True when `content` is a window of a larger document (get_document only). */
  truncated?: boolean;
  /** Start of the returned window in reassembled-document coordinates. */
  offset?: number;
  /** Evidence spans intersecting the returned window, in both window and original coordinates. */
  evidence_spans?: Array<{
    chunk_id?: string;
    reference: string;
    window_start: number;
    window_end: number;
    original_start: number;
    original_end: number;
    page_start?: number;
    page_end?: number;
    section_path?: string[];
  }>;
}

// ─── Client interface ─────────────────────────────────────────────────────────

export interface CircuitBreakerStatus {
  name: string;
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  failures: number;
}

export interface SearchExecutionPlan {
  sparseApplied: boolean;
}

export interface DocumentAsset {
  assetId: string;
  documentReference: string;
  figureId: string;
  mimeType: string;
  data: Buffer;
  checksum?: string;
  created: Date;
  modified: Date;
}

export interface DocumentAssetUpsert {
  tenantId: string;
  collection: string;
  assetId: string;
  documentReference: string;
  figureId: string;
  mimeType: string;
  data: Buffer;
  checksum?: string;
}

export interface PostgresClient {
  upsertDocumentAsset(
    asset: DocumentAssetUpsert,
    scope: AccessScope,
  ): Promise<PostgresResponse<{ created: boolean } | null>>;

  getDocumentAsset(
    collection: string,
    assetId: string,
    scope: AccessScope,
  ): Promise<PostgresResponse<DocumentAsset | null>>;

  upsert(
    point: DocumentPoint,
    collection: string,
    versionMode?: "replace" | "version",
  ): Promise<PostgresResponse<{ id: string }>>;

  search(
    query: string,
    vector: number[],
    limit: number,
    collection: string,
    scope: AccessScope,
    filter?: SearchFilter,
    hybridSearch?: boolean,
    includeAllVersions?: boolean,
    offset?: number,
    candidateMultiplier?: number,
    sparseVector?: SparseVector,
    tags?: string[],
    cursor?: SearchCursor,
    ftsOnly?: boolean,
    baseRef?: string,
    pathPrefix?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    onPlan?: (plan: SearchExecutionPlan) => void,
  ): Promise<PostgresResponse<SearchResult[]>>;

  delete(
    filter: SearchFilter,
    collection: string,
    scope: AccessScope,
    reference?: string,
  ): Promise<PostgresResponse<{ deleted: number }>>;

  ensureCollection(
    collection: string,
    vectorSize: number,
    options?: {
      language?: string;
      sparseVocabSize?: number;
      quantization?: "none" | "binary";
      embeddingModel?: string;
      embeddingModelRevision?: string;
    },
  ): Promise<PostgresResponse<void>>;

  batchUpsert(
    points: DocumentPoint[],
    collection: string,
    versionMode?: "replace" | "version",
  ): Promise<
    PostgresResponse<{
      ids: string[];
      operations: Array<"insert" | "update" | "version">;
    }>
  >;

  ping(): Promise<PostgresResponse<void>>;

  getIngestStats(
    scope: AccessScope,
    collection?: string,
    limit?: number,
    offset?: number,
  ): Promise<PostgresResponse<IngestStats[]>>;

  getSearchStats(
    scope: AccessScope,
    collection?: string,
    limit?: number,
    offset?: number,
  ): Promise<PostgresResponse<SearchStats[]>>;

  listCollections(
    scope: AccessScope,
  ): Promise<PostgresResponse<CollectionInfo[]>>;

  /**
   * Load the collection-level ACL (allowed_users / allowed_groups).
   * Returns COLLECTION_NOT_FOUND unless both the collection table and its
   * configuration row exist; unknown state must never be interpreted as public.
   */
  getCollectionAcl(
    collection: string,
  ): Promise<PostgresResponse<CollectionAcl>>;

  /**
   * Replace the collection-level ACL. Empty arrays make the collection public.
   * Returns COLLECTION_NOT_FOUND when the collection has no config row yet.
   */
  setCollectionAcl(
    collection: string,
    allowedUsers: string[],
    allowedGroups: string[],
  ): Promise<PostgresResponse<{ updated: number }>>;

  /**
   * Aggregate document/chunk counts for a collection, optionally scoped to a
   * folder path prefix (matched against `base_ref`). Answers "how many
   * documents are in the akte / in this folder".
   */
  getCollectionStats(
    collection: string,
    scope: AccessScope,
    pathPrefix?: string,
  ): Promise<PostgresResponse<CollectionStats>>;

  /**
   * A rich statistical overview of a collection (or a folder within it):
   * document/chunk/folder counts, chunk- and document-size distributions,
   * summary coverage, index configuration and the modified-time span. Answers
   * "give me the key numbers / a health snapshot of this collection".
   */
  getCollectionOverview(
    collection: string,
    scope: AccessScope,
    pathPrefix?: string,
  ): Promise<PostgresResponse<CollectionOverview>>;

  /**
   * List the documents (grouped by base_ref) in a collection, newest first,
   * optionally restricted to those beneath a folder path prefix. Paginated.
   */
  listDocuments(
    collection: string,
    scope: AccessScope,
    options?: {
      pathPrefix?: string;
      limit?: number;
      offset?: number;
      /** List only documents directly under the prefix (folder-browser view). */
      directOnly?: boolean;
    },
  ): Promise<
    PostgresResponse<{ documents: DocumentSummary[]; total: number }>
  >;

  /**
   * List the sub-folders beneath a folder path prefix, derived from document
   * reference paths, with a recursive document count per folder plus the number
   * of documents that live directly at the prefix.
   *
   * `depth` controls how many folder levels below the prefix are returned:
   *   1 (default) → only the immediate children
   *   n > 1       → up to n levels deep
   *   <= 0        → the entire sub-tree (unlimited depth)
   */
  listFolders(
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
  >;

  /**
   * Find folders anywhere in the collection whose name matches a query,
   * regardless of how deeply they are nested. Folder paths are derived from
   * document reference paths. Matching is case-insensitive; by default a match
   * occurs when any single path segment contains the query, so a bare folder
   * name (e.g. "ExampleRecords") resolves to its full path (e.g. "/ExampleRecords")
   * without the caller having to know where it sits in the tree.
   *
   * Results are ordered shallowest-first, then by descending document count.
   */
  findFolders(
    collection: string,
    scope: AccessScope,
    query: string,
    options?: { limit?: number; matchFullPath?: boolean; threshold?: number },
  ): Promise<
    PostgresResponse<{ query: string; matches: FolderSummary[] }>
  >;

  /**
   * Reassemble a whole document from its latest chunks (ordered by chunk
   * index, overlaps trimmed). `reference` may be the document's base_ref or any
   * of its chunk references. Returns null when no such document exists.
   */
  getDocument(
    collection: string,
    scope: AccessScope,
    reference: string,
    options?: { maxChars?: number; offset?: number },
  ): Promise<PostgresResponse<DocumentContent | null>>;

  /**
   * Reassemble every document beneath a folder path prefix at once (each in
   * chunk order, overlaps trimmed). Bounded by `limit` (document count) and
   * `maxChars` (combined content length) so the result cannot overflow a model
   * context. `truncated` is true when more documents exist than were returned
   * or when content was cut by `maxChars`.
   */
  getDocumentsByPrefix(
    collection: string,
    scope: AccessScope,
    options?: { pathPrefix?: string; limit?: number; maxChars?: number },
  ): Promise<
    PostgresResponse<{
      documents: DocumentContent[];
      total: number;
      truncated: boolean;
    }>
  >;

  /**
   * Fetch the stored summary/prefix of a single document (chunk-0 `prefix`).
   * `reference` may be the document's base_ref or any of its chunk references.
   * Returns null when no such document exists.
   */
  getSummary(
    collection: string,
    scope: AccessScope,
    reference: string,
  ): Promise<PostgresResponse<SummaryEntry | null>>;

  /**
   * List the stored summaries (chunk-0 `prefix`) of the documents in a
   * collection — one entry per document — optionally restricted to a folder
   * path prefix, paginated. This is the cheap "whole-akte overview" backbone
   * for a case dossier and coverage tracking.
   */
  getSummaries(
    collection: string,
    scope: AccessScope,
    options?: { pathPrefix?: string; limit?: number; offset?: number },
  ): Promise<
    PostgresResponse<{ summaries: SummaryEntry[]; total: number }>
  >;

  /**
   * List the `base_ref`s of documents whose chunk-0 row has no `prefix`
   * (NULL or empty) — i.e. documents/chapters that never received a summary.
   * Used by the summary-backfill admin action. Ordered by base_ref.
   */
  listDocumentsMissingSummary(
    collection: string,
    scope: AccessScope,
  ): Promise<PostgresResponse<string[]>>;

  /**
   * Reassemble the full text of a document/chapter (identified by base_ref) by
   * concatenating all of its is_latest chunks in chunk-order. Used to feed the
   * summary model when backfilling a missing summary.
   */
  getDocumentText(
    collection: string,
    baseRef: string,
    scope: AccessScope,
  ): Promise<PostgresResponse<{ content: string }>>;

  /**
   * Store a generated summary in the `prefix` column of a document's chunk-0
   * row, mark chunk.summary = true, and merge the summary tokens into that
   * row's ts_search vector so the summary is FTS-discoverable. Returns the
   * number of rows updated (0 = base_ref not found / already had a chunk-0).
   */
  setDocumentSummary(
    collection: string,
    baseRef: string,
    summary: string,
    scope: AccessScope,
  ): Promise<PostgresResponse<{ updated: number }>>;

  deleteCollection(
    collection: string,
  ): Promise<PostgresResponse<{ dropped: boolean }>>;

  /**
   * Rename a collection.
   * Renames the underlying table and updates vs_collection_config in a single
   * transaction. Returns COLLECTION_NOT_FOUND (404) when the source does not
   * exist, INVALID_COLLECTION_NAME (400) when either name is invalid.
   */
  renameCollection(
    oldName: string,
    newName: string,
  ): Promise<PostgresResponse<void>>;

  /**
   * Record a completed search operation in the stats buffer.
   * Called by the search handler after reranking (if any) completes so that
   * the `reranked` flag in vs_search_stats is accurate.
   * `search()` itself does NOT write stats — the handler is responsible.
   */
  recordSearchStat(stat: {
    tenantId: string;
    collection: string;
    query: string;
    durationMs: number;
    resultsCount: number;
    hybridSearch: boolean;
    reranked: boolean;
  }): void;

  /** Running totals for the Prometheus /metrics endpoint. */
  getStatsCounters(): {
    ingestTotal: number;
    searchTotal: number;
    flushErrors: number;
  };

  /**
   * Current state of all circuit breakers managed by this client.
   * Exposed for the /metrics endpoint and structured health checks.
   */
  getCircuitBreakerStatuses(): CircuitBreakerStatus[];

  /** Execute the fixed SQL used by PostgresInvocationLedger on this client's pool. */
  queryInvocationLedger(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;

  close(): Promise<void>;
}

// ─── Path / folder helpers (structural queries) ───────────────────────────────

/**
 * Escape LIKE wildcards (`\`, `%`, `_`) in a literal so a reference path that
 * legitimately contains them is matched literally. Used with `ESCAPE '\'`.
 */
export function escapeLikeLiteral(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

/**
 * Canonicalize a reference/path to Unicode NFC (composed) form.
 *
 * Document keys ingested from a macOS filesystem arrive NFD-decomposed (e.g.
 * "ä" as "a" + U+0308), while callers — especially LLMs copying a path out of
 * injected text — emit the visually identical precomposed NFC form (U+00E4). A
 * byte-exact `reference =`/`base_ref LIKE` comparison then misses. Normalizing
 * both the stored keys (ingest + one-time migration) and the incoming
 * reference/prefix args to NFC makes the comparison deterministic. NFC is
 * idempotent and meaning-preserving, so this is a no-op for ASCII paths.
 */
export function normalizeReference(reference: string): string {
  return reference.normalize("NFC");
}

/**
 * Strip NUL bytes (U+0000) from a string bound for a PostgreSQL text column.
 *
 * PostgreSQL rejects 0x00 in text/varchar values with
 * `invalid byte sequence for encoding "UTF8": 0x00`, and because chunks are
 * written in a single multi-row INSERT, ONE offending value aborts the whole
 * statement — so an entire (large) document silently fails to index. NUL bytes
 * routinely appear in text extracted from PDFs and other binary formats.
 * Removing them is meaning-preserving (NUL carries no textual content).
 *
 * Fast path: only allocate a new string when a NUL is actually present.
 */
export function stripNullBytes(text: string): string {
  return text.indexOf("\u0000") === -1 ? text : text.replace(/\u0000/g, "");
}

/**
 * Sanitize every free-text column of a point so a stray NUL byte (typically
 * from PDF extraction) can never abort the INSERT. JSON columns (metadata,
 * chunk, vector) are safe because JSON.stringify escapes U+0000 as "\u0000".
 */
function sanitizePointText(point: DocumentPoint): DocumentPoint {
  return {
    ...point,
    content: stripNullBytes(point.content),
    prefix: point.prefix != null ? stripNullBytes(point.prefix) : point.prefix,
    source: point.source != null ? stripNullBytes(point.source) : point.source,
    link: point.link != null ? stripNullBytes(point.link) : point.link,
    title: point.title != null ? stripNullBytes(point.title) : point.title,
    tags: point.tags?.map(stripNullBytes),
    allowedUsers: point.allowedUsers?.map(stripNullBytes),
    allowedGroups: point.allowedGroups?.map(stripNullBytes),
  };
}

/**
 * Normalise a folder path prefix for reference-path matching:
 *   - undefined / "" / "/"      → "" (collection root)
 *   - "/a/b/" or "a/b"          → "/a/b" (leading slash, no trailing slash)
 * Document references are absolute-style paths beginning with "/", so the
 * normalised prefix is compared as `base_ref LIKE prefix || '/%'`.
 */
export function normalizePathPrefix(prefix: string | undefined): string {
  if (prefix === undefined) return "";
  // NFC-normalize so a precomposed-umlaut prefix matches NFC-stored base_ref
  // keys (see normalizeReference). Covers list_documents, list_folders,
  // find_folders, get_documents (prefix), get_summaries, collection_stats.
  let p = prefix.normalize("NFC").trim();
  if (p === "" || p === "/") return "";
  if (!p.startsWith("/")) p = "/" + p;
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Mutable accumulator used while deriving the folder tree from paths. */
interface FolderAgg {
  documents: number;
  chunks: number;
  subfolders: Set<string>;
}

/**
 * Derive the folder tree from a set of documents (each a `base_ref` path plus
 * its chunk count), relative to a normalised prefix `norm` ("" = whole tree).
 *
 * For every document, each ancestor folder up to `depthLimit` levels below the
 * prefix accumulates the document and its chunks (recursive counts), and learns
 * the name of the immediate child folder on that path. `files` counts documents
 * that live directly at the prefix level (no intervening folder).
 *
 * `depthLimit <= 0` means unlimited depth (the entire sub-tree).
 */
function deriveFolderAggregates(
  docs: Array<{ baseRef: string; chunks: number }>,
  norm: string,
  depthLimit: number,
): { folders: Map<string, FolderAgg>; files: number } {
  const folders = new Map<string, FolderAgg>();
  const unlimited = depthLimit <= 0;
  let files = 0;
  for (const { baseRef, chunks } of docs) {
    if (!baseRef.startsWith(norm)) continue;
    const rest = baseRef.slice(norm.length); // e.g. "/Teil 1/sub/doc"
    const parts = rest.split("/").filter((p) => p.length > 0);
    if (parts.length <= 1) {
      files++; // document lives directly at the prefix level
      continue;
    }
    const maxLevel = parts.length - 1; // last segment is the document itself
    const limitLevel = unlimited ? maxLevel : Math.min(depthLimit, maxLevel);
    for (let k = 1; k <= limitLevel; k++) {
      const folderPath = norm + "/" + parts.slice(0, k).join("/");
      let agg = folders.get(folderPath);
      if (!agg) {
        agg = { documents: 0, chunks: 0, subfolders: new Set<string>() };
        folders.set(folderPath, agg);
      }
      agg.documents++;
      agg.chunks += chunks;
      // parts[k] is the next path segment; it is a *folder* (not the document)
      // when there are still deeper segments before the document.
      if (k < parts.length - 1) agg.subfolders.add(parts[k]!);
    }
  }
  return { folders, files };
}

/**
 * Levenshtein edit distance between two strings (iterative, single-row DP).
 * Used by the fuzzy folder matcher.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * Fuzzy match score in [0..1] of how well `needle` matches `haystack`
 * (both expected lowercased). Combines several signals so it is robust to
 * partial names, typos, and word-order:
 *
 *   • exact equality            → 1
 *   • haystack contains needle  → 0.9 .. 1 (longer coverage scores higher)
 *   • needle is a subsequence   → up to ~0.75 (contiguity-weighted)
 *   • Levenshtein similarity    → 1 - dist/maxLen (catches typos)
 *
 * The best of these signals is returned, so "examplerecord" still matches
 * "ExampleRecords" and "records 3" matches "Records Part 3".
 */
export function fuzzyScore(needle: string, haystack: string): number {
  if (needle === "" || haystack === "") return 0;
  if (needle === haystack) return 1;

  // Substring containment — strong signal. Coverage ratio biases toward
  // folder names that are mostly the needle over ones that merely contain it.
  if (haystack.includes(needle)) {
    return 0.9 + 0.1 * (needle.length / haystack.length);
  }

  // Subsequence match (characters appear in order, possibly with gaps).
  const subseq = subsequenceScore(needle, haystack);

  // Levenshtein-based similarity (typo tolerance).
  const dist = levenshtein(needle, haystack);
  const lev = 1 - dist / Math.max(needle.length, haystack.length);

  return Math.max(subseq, lev);
}

/**
 * Score `needle` as an in-order subsequence of `haystack` (both lowercased).
 * Returns 0 when not a subsequence; otherwise a value in (0, ~0.85] that
 * rewards matching a large fraction of the haystack contiguously.
 */
function subsequenceScore(needle: string, haystack: string): number {
  let i = 0;
  let matched = 0;
  let runs = 0;
  let prevMatchedIdx = -2;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) {
      matched++;
      if (j !== prevMatchedIdx + 1) runs++;
      prevMatchedIdx = j;
      i++;
    }
  }
  if (i < needle.length) return 0; // not a full subsequence
  const coverage = matched / haystack.length; // how much of the name is used
  const contiguity = 1 / runs; // fewer gaps → closer to 1
  return 0.5 * coverage + 0.35 * contiguity;
}

/**
 * Merge ordered chunk contents into one string, trimming the overlap between
 * adjacent chunks. Mirrors the overlap resolution in handlers/search.ts
 * (explicit chunk_overlap metadata first, then a longest-common-suffix probe).
 */
export function mergeOrderedChunkContents(
  chunks: Array<{
    content: string;
    overlapStart?: number | null;
    overlapEnd?: number | null;
  }>,
): string {
  if (chunks.length === 0) return "";
  let merged = chunks[0]!.content;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const curr = chunks[i]!;
    const next = curr.content;

    // The chunker (chunker.ts) adjusts BOTH sides of a shared boundary
    // independently: `prev.overlapEnd` extends prev's end forward and
    // `curr.overlapStart` extends curr's start backward across the SAME
    // boundary. The duplicated region at the head of `curr` is therefore the
    // SUM of the two — using only one of them under-trims and leaves
    // duplicated text. We verify the computed length against the actual text
    // (endsWith) and fall back to a longest-common-suffix probe when the
    // metadata is absent (e.g. semantic chunking) or imprecise.
    const explicit = (prev.overlapEnd ?? 0) + (curr.overlapStart ?? 0);
    let overlap = 0;
    if (explicit > 0 && merged.endsWith(next.slice(0, explicit))) {
      overlap = explicit;
    } else {
      const MAX_PROBE = 2048;
      const probe = Math.min(MAX_PROBE, merged.length, next.length);
      for (let len = probe; len >= 8; len--) {
        if (merged.endsWith(next.slice(0, len))) {
          overlap = len;
          break;
        }
      }
    }

    // Adjacent chunks (overlap 0 = hard cut) are concatenated WITHOUT a
    // separator so the reassembly is a faithful, lossless reconstruction of
    // the original document text.
    merged += overlap > 0 ? next.slice(overlap) : next;
  }
  return merged;
}

interface MergedChunkCoordinate<T> {
  item: T;
  returnedStart: number;
  returnedEnd: number;
  originalStart?: number;
  originalEnd?: number;
}

/** Reassemble chunks and retain a separate mapping for compacted/output coordinates. */
function mergeChunksWithCoordinates<T extends {
  content: string;
  overlap_start: number | null;
  overlap_end: number | null;
  chunk: ChunkInfo | null;
}>(chunks: T[]): { content: string; coordinates: Array<MergedChunkCoordinate<T>> } {
  if (chunks.length === 0) return { content: "", coordinates: [] };
  let merged = "";
  const coordinates: Array<MergedChunkCoordinate<T>> = [];
  for (let index = 0; index < chunks.length; index++) {
    const item = chunks[index]!;
    let trim = 0;
    if (index > 0) {
      const previous = chunks[index - 1]!;
      const explicit = (previous.overlap_end ?? 0) + (item.overlap_start ?? 0);
      if (explicit > 0 && merged.endsWith(item.content.slice(0, explicit))) {
        trim = explicit;
      } else {
        const probe = Math.min(2048, merged.length, item.content.length);
        for (let length = probe; length >= 8; length--) {
          if (merged.endsWith(item.content.slice(0, length))) {
            trim = length;
            break;
          }
        }
      }
    }
    const appended = item.content.slice(trim);
    const returnedStart = merged.length;
    merged += appended;
    coordinates.push({
      item,
      returnedStart,
      returnedEnd: merged.length,
      ...(item.chunk?.char_start !== undefined ? { originalStart: item.chunk.char_start + trim } : {}),
      ...(item.chunk?.char_end !== undefined ? { originalEnd: item.chunk.char_end } : {}),
    });
  }
  return { content: merged, coordinates };
}

// ─── Client factory ───────────────────────────────────────────────────────────

export function createPostgresClient(
  config: PostgresClientConfig,
): PostgresClient {
  const scopedWhere = (
    scope: AccessScope,
    params: unknown[],
    alias = "",
  ): { sql: string; params: unknown[] } => {
    const p = new SqlParams();
    p.values.push(...params);
    return { sql: buildAccessSql(p, scope, alias), params: p.values };
  };
  const {
    connectionString,
    logger,
    efSearch = 100,
    efConstruction = 128,
    hnswM = 16,
    halfPrecision = false,
    defaultFtsLanguage = "simple",
    statsRetentionDays = 90,
    rrfK = 60,
    statsFlushIntervalMs = 30_000,
    quantization: quantizationConfig = "none",
    embeddingModel: expectedEmbeddingModel,
    embeddingModelRevision: expectedEmbeddingModelRevision,
    poolMax = 20,
    circuitBreakerGetters = [],
    statementTimeoutMs = 30_000,
  } = config;

  const vecType = halfPrecision ? "halfvec" : "vector";
  const cosineOps = halfPrecision ? "halfvec_cosine_ops" : "vector_cosine_ops";
  const ddlConfig = { vecType, cosineOps, hnswM, efConstruction };

  const pool = new Pool({
    connectionString,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  pool.on("error", (err) => {
    logger.error({ err }, "Unexpected idle PostgreSQL client error");
  });

  /** Escape special regex characters in a string for use in `new RegExp(...)`. */
  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Collection meta cache: table → CollectionMeta
  const ensuredCollections = new Map<string, CollectionMeta>();
  const ensureCollectionLocks = new Map<
    string,
    Promise<PostgresResponse<void>>
  >();

  const statsBuffer = createStatsBuffer(
    pool,
    logger,
    statsRetentionDays,
    statsFlushIntervalMs,
  );

  // ── Helper: run an operation with a pooled client ─────────────────────────
  async function withClient<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<PostgresResponse<T>> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (cause) {
      logger.error({ cause }, "PostgreSQL connection failed");
      return {
        ok: false,
        error: {
          code: "POSTGRES_UNREACHABLE",
          message:
            cause instanceof Error
              ? cause.message
              : "Failed to acquire database connection",
          cause,
        },
      };
    }
    try {
      // Set a per-query statement timeout to prevent runaway queries from
      // blocking a pool connection indefinitely (e.g. a slow ANN query on a
      // cold index). statementTimeoutMs=0 disables this safety net.
      if (statementTimeoutMs > 0) {
        await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
      }
      const result = await operation(client);
      return { ok: true, result };
    } catch (cause) {
      if (
        cause instanceof AppError &&
        cause.code === "INVALID_COLLECTION_NAME"
      ) {
        return {
          ok: false,
          error: {
            code: "INVALID_COLLECTION_NAME",
            message: cause.message,
            cause,
          },
        };
      }
      if (cause instanceof AppError && cause.code === "COLLECTION_NOT_FOUND") {
        return {
          ok: false,
          error: {
            code: "COLLECTION_NOT_FOUND",
            message: cause.message,
            cause,
          },
        };
      }
      if (cause instanceof AppError && cause.code === "EMBEDDING_PROVENANCE_MISMATCH") {
        return {
          ok: false,
          error: {
            code: "POSTGRES_INVALID_RESPONSE",
            message: cause.message,
            cause,
          },
        };
      }
      logger.error({ cause }, "PostgreSQL operation failed");
      return {
        ok: false,
        error: {
          code: "POSTGRES_SQL_ERROR",
          message:
            cause instanceof Error ? cause.message : "Unknown database error",
          cause,
        },
      };
    } finally {
      client.release();
    }
  }

  // ── Helper: get collection meta (cache-first, then DB) ───────────────────
  async function getOrLoadCollectionMeta(
    client: PoolClient,
    table: string,
  ): Promise<CollectionMeta> {
    const cached = ensuredCollections.get(table);
    if (cached) return cached;

    await ensureCollectionConfigTable(client);
    const meta = await loadCollectionMeta(client, table);
    if (meta) {
      ensuredCollections.set(table, meta);
      return meta;
    }
    // No config row found — return a sensible fallback but do NOT cache it.
    // Caching a fallback would permanently hide any collection that gets
    // created later (or whose config row arrives after this process started).
    return {
      language: defaultFtsLanguage,
      sparseEnabled: false,
      sparseVocabSize: null,
      quantization: "none",
      vectorSize: null,
    };
  }

  // ── Public client ─────────────────────────────────────────────────────────
  return {
    async upsertDocumentAsset(
      asset: DocumentAssetUpsert,
      scope: AccessScope,
    ): Promise<PostgresResponse<{ created: boolean } | null>> {
      if (!asset.tenantId.trim() || asset.tenantId !== scope.tenantId) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const table = collectionTableName(asset.collection);
      return withClient(async (client) => {
        const params: unknown[] = [
          asset.tenantId,
          asset.collection,
          asset.assetId,
          normalizeReference(asset.documentReference),
          asset.figureId,
          asset.mimeType,
          asset.data,
          asset.checksum ?? null,
        ];
        const access = scopedWhere(scope, params, "d");
        const result = await client.query<{ inserted: boolean }>(
          `INSERT INTO vs_document_assets
             (tenant_id, collection, asset_id, document_reference, figure_id, mime_type, data, checksum)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8
           WHERE EXISTS (
             SELECT 1 FROM "${table}" d
              WHERE d.tenant_id = $1 AND d.is_latest = TRUE
                AND d.chunk->>'asset_id' = $3
                AND d.chunk->>'parent_ref' = $4
                ${access.sql}
           )
           ON CONFLICT (tenant_id, collection, asset_id) DO UPDATE SET
             document_reference = EXCLUDED.document_reference,
             figure_id = EXCLUDED.figure_id,
             mime_type = EXCLUDED.mime_type,
             data = EXCLUDED.data,
             checksum = EXCLUDED.checksum,
             modified = NOW()
           RETURNING (xmax = 0) AS inserted`,
          access.params,
        );
        const row = result.rows[0];
        return row ? { created: row.inserted === true } : null;
      });
    },

    async getDocumentAsset(
      collection: string,
      assetId: string,
      scope: AccessScope,
    ): Promise<PostgresResponse<DocumentAsset | null>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      return withClient(async (client) => {
        const access = scopedWhere(scope, [assetId, collection, scope.tenantId], "d");
        const result = await client.query<{
          asset_id: string;
          document_reference: string;
          figure_id: string;
          mime_type: string;
          data: Buffer;
          checksum: string | null;
          created: Date;
          modified: Date;
        }>(
          `SELECT a.asset_id, a.document_reference, a.figure_id, a.mime_type,
                  a.data, a.checksum, a.created, a.modified
             FROM vs_document_assets a
            WHERE a.asset_id = $1 AND a.collection = $2 AND a.tenant_id = $3
              AND EXISTS (
                SELECT 1 FROM "${table}" d
                 WHERE d.is_latest = TRUE
                   AND d.chunk->>'asset_id' = a.asset_id
                   AND d.chunk->>'parent_ref' = a.document_reference
                   ${access.sql}
              )`,
          access.params,
        );
        const row = result.rows[0];
        return row ? {
          assetId: row.asset_id,
          documentReference: row.document_reference,
          figureId: row.figure_id,
          mimeType: row.mime_type,
          data: row.data,
          ...(row.checksum ? { checksum: row.checksum } : {}),
          created: row.created,
          modified: row.modified,
        } : null;
      });
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
      if (!response.ok) throw new Error(response.error.message, { cause: response.error.cause });
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
      statsBuffer.recordSearch({
        tenant_id: stat.tenantId,
        collection: stat.collection,
        // Query text may carry personal or confidential data. Keep the stable
        // hash needed for aggregation/correlation, never the raw term.
        query: createHash("sha256").update(stat.query).digest("hex"),
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
        const modelMismatch = options?.embeddingModel !== undefined &&
          cachedMeta.embeddingModel !== options.embeddingModel;
        const revisionMismatch = options?.embeddingModelRevision !== undefined &&
          cachedMeta.embeddingModelRevision !== options.embeddingModelRevision;
        if (modelMismatch || revisionMismatch) {
          return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "EMBEDDING_PROVENANCE_MISMATCH: provenance is unknown or differs; reindex into a new collection and cut over explicitly" } };
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
          const modelMismatch = existing !== null && meta.embeddingModel !== null &&
            existing.embeddingModel !== meta.embeddingModel;
          const revisionMismatch = existing !== null && meta.embeddingModelRevision !== null &&
            existing.embeddingModelRevision !== meta.embeddingModelRevision;
          if (modelMismatch || revisionMismatch) {
            throw new AppError("EMBEDDING_PROVENANCE_MISMATCH", "EMBEDDING_PROVENANCE_MISMATCH: provenance is unknown or differs; create a new collection, fully reindex, validate it, then use renameCollection for an explicit cutover");
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
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
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
        const aclConflictUpdate = point.preserveExistingAclOnConflict === true
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
          ];
          const extraBase = params.length; // 13
          pushExtraParams(params, point, meta);
          const sparseValSql = sql.sparseVal(extraBase);
          const binaryValSql = sql.binaryVal(
            extraBase + (meta.sparseEnabled ? 1 : 0),
          );
          // Append FTS-preprocessed content as the last parameter
          params.push(buildFtsText(point));
          const ftsParam = params.length; // e.g. $14, $15, $16 depending on extras
          params.push(point.tenantId);
          const tenantParam = params.length;

          const result = await client.query<{
            id: string;
            was_insert: boolean;
          }>(
            `INSERT INTO "${table}"
               (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                prefix, source, link, title, tags, allowed_users, allowed_groups, modified${sql.sparseCol}${sql.binaryCol}, tenant_id)
             VALUES ($1, $2, TRUE, $3, $4::${vecType}, to_tsvector('${lang}', $${ftsParam}), $5, $6,
                     $7, $8, $9, $10, $11, $12, $13, NOW()${sparseValSql}${binaryValSql}, $${tenantParam})
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
            params.push(point.tenantId);
            const tenantParam = params.length;

            const result = await client.query<{ id: string }>(
              `INSERT INTO "${table}"
                 (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                  prefix, source, link, title, tags, allowed_users, allowed_groups${sql.sparseCol}${sql.binaryCol}, tenant_id)
               VALUES ($1, $2, TRUE, $3, $4::${vecType}, to_tsvector('${lang}', $${ftsParam}), $5, $6,
                       $7, $8, $9, $10, $11, $12, $13${sparseValSql}${binaryValSql}, $${tenantParam})
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
        if (expectedEmbeddingModel !== undefined && meta.embeddingModel !== expectedEmbeddingModel) {
          throw new AppError(
            "EMBEDDING_PROVENANCE_MISMATCH",
            "EMBEDDING_PROVENANCE_MISMATCH: collection model provenance is unknown or differs; reindex and cut over explicitly",
          );
        }
        if (expectedEmbeddingModelRevision !== undefined &&
            meta.embeddingModelRevision !== expectedEmbeddingModelRevision) {
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
            await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.ceil(timeoutMs))}`);
          }
          if (signal) {
            if (signal.aborted) throw new Error("Search aborted");
            const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const pid = backend.rows[0]?.pid;
            if (pid !== undefined) {
              abortListener = () => {
                void pool.query("SELECT pg_cancel_backend($1)", [pid]).catch(() => {});
              };
              signal.addEventListener("abort", abortListener, { once: true });
            }
          }
          await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);

          const vectorJson = JSON.stringify(vector);
          const sparseJson = useSparse
            ? sparseVectorToPg(sparseVector!)
            : undefined;
          const binaryStr =
            meta.quantization === "binary" && meta.vectorSize
              ? toBinaryString(vector)
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
                tags,
                scope,
                undefined,
                cursor,
                baseRef,
                pathLike,
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
                  tags,
                  scope,
                  undefined,
                  cursor,
                  pathLike,
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
                    tags,
                    scope,
                    undefined,
                    cursor,
                    pathLike,
                  )
                : buildDenseQuery(
                    table,
                    vecType,
                    limit,
                    filter,
                    includeAllVersions,
                    offset,
                    vectorJson,
                    tags,
                    scope,
                    undefined,
                    cursor,
                    pathLike,
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
                ...(chunk?.char_start !== undefined ? { char_start: chunk.char_start } : {}),
                ...(chunk?.char_end !== undefined ? { char_end: chunk.char_end } : {}),
                ...(chunk?.page_start !== undefined ? { page_start: chunk.page_start } : {}),
                ...(chunk?.page_end !== undefined ? { page_end: chunk.page_end } : {}),
                ...(chunk?.section_path ? { section_path: chunk.section_path } : {}),
                ...(chunk?.modality ? { modality: chunk.modality } : {}),
                ...(chunk?.figure_id ? { figure_id: chunk.figure_id } : {}),
                ...(chunk?.asset_id ? { asset_id: chunk.asset_id } : {}),
                ...(chunk?.bbox ? { bbox: chunk.bbox } : {}),
              };
            })(),
            reference: row.reference as string,
            base_ref: (row.base_ref as string) ?? (row.reference as string),
            source: row.source as string | undefined,
            link: row.link as string | undefined,
            title: row.title as string | undefined,
            tags: row.tags as string[] | undefined,
            ...((row.chunk as ChunkInfo | null)?.asset_id
              ? { asset_url: `/document-assets/${encodeURIComponent((row.chunk as ChunkInfo).asset_id!)}?collection=${encodeURIComponent(collection)}` }
              : {}),
            created: row.created as Date,
            modified: row.modified as Date,
          }));

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

    async delete(
      filter: SearchFilter,
      collection: string,
      scope: AccessScope,
      reference?: string,
    ): Promise<PostgresResponse<{ deleted: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
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
          const result = await client.query<{ root_ref: string }>(
            `DELETE FROM "${table}" WHERE ${target}${access.sql}
             RETURNING COALESCE(chunk->>'parent_ref', base_ref) AS root_ref`,
            access.params,
          );
          const rootRefs = [...new Set(result.rows.map((row) => row.root_ref))];
          if (rootRefs.length > 0) {
            await client.query(
              `DELETE FROM vs_document_assets
               WHERE tenant_id = $1 AND collection = $2
                 AND document_reference = ANY($3)`,
              [scope.tenantId, collection, rootRefs],
            );
          }
          await client.query("COMMIT");
          return { deleted: result.rowCount ?? 0 };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      });
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
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const batchTenants = new Set(points.map((point) => point.tenantId!.trim()));
      if (batchTenants.size !== 1) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "A batch must contain exactly one tenant" } };
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
                );
                const extraBase = params.length; // 13 fixed params pushed
                pushExtraParams(params, point, meta);
                // Append FTS-preprocessed content as the last param for this row
                params.push(buildFtsText(point));
                const ftsIdx = params.length; // 1-based absolute index
                params.push(point.tenantId);
                const tenantIdx = params.length;
                const n = base + 1;
                const sparsePh = sql.sparseVal(extraBase);
                const binaryPh = sql.binaryVal(
                  extraBase + (meta.sparseEnabled ? 1 : 0),
                );
                return `($${n}, $${n + 1}, TRUE, $${n + 2}, $${n + 3}::${vecType}, to_tsvector('${lang}', $${ftsIdx}), $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, $${n + 9}, $${n + 10}, $${n + 11}, $${n + 12}, NOW()${sparsePh}${binaryPh}, $${tenantIdx})`;
              });

              const result = await client.query<{
                id: string;
                reference: string;
                was_insert: boolean;
              }>(
                `INSERT INTO "${table}"
                   (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                    prefix, source, link, title, tags, allowed_users, allowed_groups, modified${sql.sparseCol}${sql.binaryCol}, tenant_id)
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
                points.map((point) =>
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
            // Version mode
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
                );
                const extraBase = params.length;
                pushExtraParams(params, point, meta);
                // Append FTS-preprocessed content as the last param for this row
                params.push(buildFtsText(point));
                const ftsIdx = params.length; // 1-based absolute index
                params.push(point.tenantId);
                const tenantIdx = params.length;
                const n = base + 1;
                const sparsePh = sql.sparseVal(extraBase);
                const binaryPh = sql.binaryVal(
                  extraBase + (meta.sparseEnabled ? 1 : 0),
                );
                return `($${n}, $${n + 1}, TRUE, $${n + 2}, $${n + 3}::${vecType}, to_tsvector('${lang}', $${ftsIdx}), $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, $${n + 9}, $${n + 10}, $${n + 11}, $${n + 12}${sparsePh}${binaryPh}, $${tenantIdx})`;
              });

              const result = await client.query<{ id: string }>(
                `INSERT INTO "${table}"
                   (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                    prefix, source, link, title, tags, allowed_users, allowed_groups${sql.sparseCol}${sql.binaryCol}, tenant_id)
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
                `WITH ranked AS (
                   SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id, base_ref ORDER BY id DESC) AS rn
                   FROM "${table}"
                   WHERE base_ref = ANY($1) AND tenant_id = $2 AND is_latest = TRUE
                 )
                 UPDATE "${table}" SET is_latest = FALSE WHERE id IN (SELECT id FROM ranked WHERE rn > 1)`,
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
      const users = [...new Set(allowedUsers.map((u) => u.trim()).filter(Boolean))];
      const groups = [...new Set(allowedGroups.map((g) => g.trim()).filter(Boolean))];
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
        const where = norm === "" ? "is_latest" : "is_latest AND base_ref LIKE $1 ESCAPE '\\'";
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
        const prefixParams = norm === "" ? [] : [escapeLikeLiteral(norm) + "/%"];
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
    ): Promise<
      PostgresResponse<{ query: string; matches: FolderSummary[] }>
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
      const needle = query.trim().toLowerCase();
      const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
      const matchFullPath = options?.matchFullPath ?? false;
      // Minimum fuzzy score (0..1) for a folder to be considered a match.
      // Default 0.4 keeps typos/partial names in while dropping unrelated ones.
      const threshold = Math.min(
        Math.max(options?.threshold ?? 0.4, 0),
        1,
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
      options?: { maxChars?: number; offset?: number },
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
        const resolveAccess = scopedWhere(scope, [reference]);
        const resolve = await client.query<{ base_ref: string }>(
          `SELECT base_ref FROM "${table}"
            WHERE (base_ref = $1 OR reference = $1) AND is_latest${resolveAccess.sql}
            LIMIT 1`,
          resolveAccess.params,
        );
        if (resolve.rows.length === 0) return null;
        const baseRef = resolve.rows[0]!.base_ref;
        const chunkAccess = scopedWhere(scope, [baseRef]);

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
        }>(
          `SELECT content, title, link, source, metadata, tags, modified, reference, chunk,
                  (chunk->>'chunk_overlap_start')::int AS overlap_start,
                  (chunk->>'chunk_overlap_end')::int   AS overlap_end
             FROM "${table}"
            WHERE base_ref = $1 AND is_latest${chunkAccess.sql}
            ORDER BY COALESCE((chunk->>'chunk_index')::int, 0) ASC, id ASC`,
          chunkAccess.params,
        );
        if (rows.length === 0) return null;

        const mergedDocument = mergeChunksWithCoordinates(rows);
        const fullContent = mergedDocument.content;
        const totalChars = fullContent.length;
        const content = fullContent.slice(offset, offset + maxChars);
        const truncated = offset > 0 || content.length < totalChars;
        const first = rows[0]!;
        let latestModified = first.modified;
        for (const r of rows) if (r.modified > latestModified) latestModified = r.modified;
        const windowEnd = offset + content.length;
        const evidenceSpans = mergedDocument.coordinates.flatMap((coordinate) => {
          const chunk = coordinate.item.chunk;
          if (coordinate.originalStart === undefined || coordinate.originalEnd === undefined) return [];
          const start = Math.max(coordinate.returnedStart, offset);
          const end = Math.min(coordinate.returnedEnd, windowEnd);
          if (start >= end) return [];
          const deltaStart = start - coordinate.returnedStart;
          const deltaEnd = coordinate.returnedEnd - end;
          return [{
            ...(chunk?.chunk_id ? { chunk_id: chunk.chunk_id } : {}),
            reference: coordinate.item.reference,
            window_start: start - offset,
            window_end: end - offset,
            original_start: coordinate.originalStart + deltaStart,
            original_end: coordinate.originalEnd - deltaEnd,
            ...(chunk?.page_start !== undefined ? { page_start: chunk.page_start } : {}),
            ...(chunk?.page_end !== undefined ? { page_end: chunk.page_end } : {}),
            ...(chunk?.section_path ? { section_path: chunk.section_path } : {}),
          }];
        });

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
      options?: { pathPrefix?: string; limit?: number; maxChars?: number },
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
        const prefixParams = norm === "" ? [] : [escapeLikeLiteral(norm) + "/%"];

        // Total distinct documents beneath the prefix (for the truncated flag).
        const access = scopedWhere(scope, prefixParams);
        const totalRes = await client.query<{ total: string }>(
          `SELECT COUNT(DISTINCT base_ref) AS total
             FROM "${table}" WHERE is_latest${prefixClause}${access.sql}`,
          access.params,
        );
        const total = parseInt(totalRes.rows[0]!.total, 10);

        // The base_refs to reassemble, ordered deterministically, capped by limit.
        const refsRes = await client.query<{ base_ref: string }>(
          `SELECT base_ref
             FROM "${table}" WHERE is_latest${prefixClause}${access.sql}
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
        const chunkAccess = scopedWhere(scope, [baseRefs]);
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
        }>(
          `SELECT base_ref, content, title, link, source, metadata, tags, modified,
                  (chunk->>'chunk_overlap_start')::int AS overlap_start,
                  (chunk->>'chunk_overlap_end')::int   AS overlap_end
             FROM "${table}"
            WHERE is_latest AND base_ref = ANY($1)${chunkAccess.sql}
            ORDER BY base_ref ASC,
                     COALESCE((chunk->>'chunk_index')::int, 0) ASC, id ASC`,
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
          let content = mergeOrderedChunkContents(
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
        const resolveAccess = scopedWhere(scope, [reference]);
        const resolve = await client.query<{ base_ref: string }>(
          `SELECT base_ref FROM "${table}"
            WHERE (base_ref = $1 OR reference = $1) AND is_latest${resolveAccess.sql}
            LIMIT 1`,
          resolveAccess.params,
        );
        if (resolve.rows.length === 0) return null;
        const baseRef = resolve.rows[0]!.base_ref;
        const summaryAccess = scopedWhere(scope, [baseRef]);

        // The summary/prefix lives on chunk 0 only.
        const { rows } = await client.query<{
          prefix: string | null;
          title: string | null;
          link: string | null;
          is_summary: boolean | null;
          modified: Date;
        }>(
          `SELECT prefix, title, link,
                  (chunk->>'summary') = 'true' AS is_summary,
                  modified
             FROM "${table}"
            WHERE base_ref = $1 AND is_latest${summaryAccess.sql}
            ORDER BY COALESCE((chunk->>'chunk_index')::int, 0) ASC, id ASC
            LIMIT 1`,
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
      options?: { pathPrefix?: string; limit?: number; offset?: number },
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
        const prefixParams = norm === "" ? [] : [escapeLikeLiteral(norm) + "/%"];

        const access = scopedWhere(scope, prefixParams);
        const totalRes = await client.query<{ total: string }>(
          `SELECT COUNT(DISTINCT base_ref) AS total
             FROM "${table}" WHERE is_latest${prefixClause}${access.sql}`,
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
          `SELECT base_ref AS reference,
                  (ARRAY_AGG(prefix ORDER BY COALESCE((chunk->>'chunk_index')::int, 0) ASC, id ASC))[1] AS summary,
                  (ARRAY_AGG(title  ORDER BY COALESCE((chunk->>'chunk_index')::int, 0) ASC, id ASC))[1] AS title,
                  (ARRAY_AGG(link   ORDER BY COALESCE((chunk->>'chunk_index')::int, 0) ASC, id ASC))[1] AS link,
                  bool_or((chunk->>'summary') = 'true') AS is_summary,
                  MAX(modified) AS modified
             FROM "${table}"
            WHERE is_latest${prefixClause}${access.sql}
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
          `SELECT base_ref
             FROM "${table}"
            WHERE is_latest
              AND COALESCE((chunk->>'chunk_index')::int, 0) = 0
              AND (prefix IS NULL OR prefix = '')${access.sql}
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
          `SELECT string_agg(content, E'\n'
                    ORDER BY COALESCE((chunk->>'chunk_index')::int, 0) ASC, id ASC) AS content
             FROM "${table}"
            WHERE is_latest AND base_ref = $1${access.sql}`,
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
            WHERE is_latest AND base_ref = $1
              AND COALESCE((chunk->>'chunk_index')::int, 0) = 0${access.sql}`,
          access.params,
        );
        return { updated: res.rowCount ?? 0 };
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

    async close(): Promise<void> {
      await statsBuffer.close();
      await pool.end();
    },
  };
}

/**
 * Wait for the PostgreSQL pool to accept a connection, retrying with
 * exponential backoff.  Intended for use at startup in container environments
 * where the database may not be ready immediately.
 *
 * @param client   - An already-created PostgresClient instance.
 * @param logger   - pino logger for progress messages.
 * @param maxWaitMs - Total time budget in milliseconds (default: 60 000).
 * @param baseDelayMs - Initial retry delay in milliseconds (default: 500).
 */
export async function waitForDatabase(
  client: PostgresClient,
  logger: pino.Logger,
  maxWaitMs = 60_000,
  baseDelayMs = 500,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;

  while (true) {
    const result = await client.ping();
    if (result.ok) {
      if (attempt > 0) {
        logger.info({ attempt }, "Database connection established");
      }
      return;
    }

    attempt++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Database not reachable after ${maxWaitMs}ms: ${result.error.message}`,
      );
    }

    // Exponential backoff with a cap of 10 s, capped to remaining budget.
    const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 10_000, remaining);
    logger.warn(
      { attempt, delayMs: Math.round(delay), error: result.error.message },
      "Database not ready, retrying…",
    );
    await new Promise<void>((r) => setTimeout(r, delay));
  }
}
