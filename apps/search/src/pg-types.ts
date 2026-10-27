// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pg-types.ts
 *
 * Data types of the PostgresClient API (Requirement 13.6 module split of
 * postgres-client.ts): search results, document/chunk shapes, collection
 * stats and the client interface itself. Pure type declarations only.
 */

import type pino from "pino";
import type { AccessScope } from "./access-scope.js";
import type { CollectionAcl } from "./collection-access.js";
import type { DocumentGroup } from "./document-identity.js";
import type { ExpandMode, ExpansionUnit } from "./expansion.js";
import type { Metadata } from "./metadata.js";
import type { SparseVector } from "./sparse-embedding-client.js";

/**
 * Per-call search options that are NOT part of the v1 positional contract
 * (task 3.4 follow-up, Requirement 13.7). Everything defaults OFF so the v1
 * `/search` handler and the legacy MCP `search` call — which never pass this —
 * keep exactly their previous SQL and ranking.
 */
export interface SearchOptions {
  /**
   * Fuse the identifier list (Requirement 12.3: `vs_identifiers` exact hits ∪
   * `ts_ident` lexical hits) as a third RRF list. Only honoured by the HYBRID
   * path: the dense-only and FTS-only builders do not fuse lists, so a dense or
   * FTS-only search never carries the identifier list (documented behaviour).
   * Default: false.
   */
  identifierList?: boolean;
  /**
   * Identifiers the caller named explicitly (e.g. `/v2/search`
   * `filters.identifier`). Normalized and added to those recognized in the
   * query text; they do not need to match a recognizer class.
   */
  identifiers?: string[];
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Allowed values of the pgvector `hnsw.iterative_scan` GUC (Req 4.1).
 * `relaxed_order` returns results in scan order (cheapest, default);
 * `strict_order` re-visits tuples to preserve exact distance ordering;
 * `off` disables iterative deepening entirely (pre-0.8 behaviour).
 */
export type HnswIterativeScanMode = "relaxed_order" | "strict_order" | "off";

export interface PostgresClientConfig {
  connectionString: string;
  logger: pino.Logger;
  /** HNSW ef_search: controls recall vs latency at query time. Default: 100. */
  efSearch?: number;
  /**
   * pgvector HNSW iterative-scan mode for dense/binary searches (Req 4.1).
   * Forced to `off` automatically when the installed pgvector is < 0.8
   * (Req 4.2, see ensurePgvectorVersion). Default: 'relaxed_order'.
   */
  hnswIterativeScan?: HnswIterativeScanMode;
  /**
   * Cap on tuples visited per iterative-scan round
   * (`hnsw.max_scan_tuples`). Default: 20 000.
   */
  hnswMaxScanTuples?: number;
  /** HNSW ef_construction for new indexes (default: 128). */
  efConstruction?: number;
  /** HNSW m parameter for new indexes (default: 16). */
  hnswM?: number;
  /** Use halfvec (16-bit) instead of vector (32-bit) for new collections. Default: false. */
  halfPrecision?: boolean;
  /** Server-wide default FTS language for new collections. Default: 'simple'. */
  defaultFtsLanguage?: string;
  /**
   * Visibility of rows with an empty ACL (Req 3.2). `allow` (default) keeps
   * them tenant-public; `deny` restricts them to service/bypass principals.
   */
  documentAclDefault?: "allow" | "deny";
  /** Delete stats rows older than N days. 0 = keep forever. Default: 90. */
  statsRetentionDays?: number;
  /**
   * Persist the raw query text in vs_search_stats.query in addition to the
   * hash. Default: false — only query_hash is stored (Requirement 2.6).
   */
  statsStoreRawQuery?: boolean;
  /**
   * Pepper for the HMAC-SHA-256 query hash. null/empty = plain SHA-256.
   * Set STATS_QUERY_PEPPER in production so common queries are not
   * dictionary-reversible from the hash alone.
   */
  statsQueryPepper?: string | null;
  /** RRF k parameter for hybrid search scoring. Default: 60. */
  rrfK?: number;
  /** Per-list RRF weights (task 3.4, Req 12.3; sparse Req 4.3). All default to 1.0. */
  rrfWeightDense?: number;
  rrfWeightFts?: number;
  rrfWeightIdentifier?: number;
  rrfWeightSparse?: number;
  /**
   * Req 4.4: missing lists contribute 0 instead of `1/(k+1000)`. Default true;
   * false restores the legacy pseudo-rank.
   */
  rrfMissingZero?: boolean;
  /**
   * Req 4.7: ranker for the lexical (full-text) list. `ts_rank_cd` (default,
   * normalisation flag 32: rank/(rank+1)); `bm25` only takes effect when ParadeDB
   * `pg_search` is installed — otherwise the client logs a warning once and
   * keeps `ts_rank_cd`.
   */
  ftsRanker?: "ts_rank_cd" | "bm25";
  /**
   * FTS_CONTEXTUAL_HEADER: when true, ingest writes `ts_search` as
   * `setweight(to_tsvector(lang, header), 'D') || to_tsvector(lang, content)`
   * with the header being the document title and section path. Only newly
   * written chunks are affected. Default false.
   */
  ftsContextualHeader?: boolean;
  /**
   * FTS_COMPOUND_SPLIT: when true, long query tokens are split against the
   * collection's own lexicon and the matched lexemes are added to the
   * lexical OR list (see compound-split.ts). The lexicon is built
   * asynchronously on first need, so the first query per collection runs
   * without splitting. Default false.
   */
  ftsCompoundSplit?: boolean;
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
  /** Business-validity start; null/undefined falls back to the immutable created timestamp. */
  validFrom?: string;
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
  /**
   * Figures this chunk's text references via a `[Abbildung <id>: …]` marker
   * (Requirement 2.4). Distinct from `figure_id`/`asset_id`, which identify the
   * figure a figure-chunk *is*; these are the figures a text chunk points at.
   */
  figure_refs?: FigureRef[];
}

/**
 * A figure referenced from within a chunk's text. `asset_id` lets a consumer
 * fetch the referenced figure without a second lookup.
 */
export interface FigureRef {
  figure_id: string;
  asset_id: string;
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
  /** Figures this chunk's text references (Requirement 2.4). */
  figure_refs?: FigureRef[];
  /** Asset ids of the referenced figures, for direct retrieval in the answer. */
  asset_ids?: string[];
  /**
   * Set to `partial` when the hit comes from a v2 revision that is only
   * partially visible — a `progressive` revision whose committed segments are
   * searchable while the rest is still ingesting (Requirement 6.4). Absent for
   * fully-committed and legacy rows.
   */
  revision_state?: "partial";
  /**
   * The committed page range available so far for a partial revision, e.g.
   * "1–2750" (Requirement 6.4). Present only alongside `revision_state=partial`.
   */
  pages_available?: string;
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
  /** Explicit business-validity start, when supplied at ingest. */
  valid_from: Date | null;
  /** COALESCE(valid_from, created), always present. */
  effective_valid_from: Date;
  /**
   * Revision the hit belongs to (v2 revision pipeline). Absent for legacy v1
   * rows, whose version is part of `reference` (`doc_v2_chunk_3`).
   */
  revision_id?: string;
  /**
   * `partial` when the hit comes from a partially-visible `progressive` revision
   * (Requirement 6.4). Mirrors `evidence.revision_state`. Absent otherwise.
   */
  revision_state?: "partial";
  /** Committed page range of a partial revision, e.g. "1–2750" (Requirement 6.4). */
  pages_available?: string;
  /**
   * The group the hit's document belongs to (e-mail thread, attachment parent),
   * resolved when results are grouped by document or expanded to the document.
   */
  document_group?: DocumentGroup;
  /**
   * Set on a result merged from several documents of one group (an e-mail
   * thread): their references in reading order. `reference`/`base_ref` name
   * only the best-scoring one; read the others (or `get_thread`) for the rest.
   */
  group_members?: string[];
  /**
   * Set on a `group_by_document` result whose chunk list was capped: lower-
   * scoring chunks were dropped from the merged content (`omitted_chunks`).
   */
  truncated?: boolean;
  /** How many chunks of this document were dropped when `truncated` is set. */
  omitted_chunks?: number;
}

/**
 * Coordinates of a search hit needed to expand it (task 3.6, Requirement 13.4).
 *
 * These are read off a {@link SearchResult}'s metadata/base_ref by the caller:
 *  - `neighbors` walks `prev_unit_id` / `next_unit_id` from the hit;
 *  - `section` collects every unit sharing `section_id` in the same document;
 *  - `page` collects every unit overlapping the hit's page range in the same
 *    document.
 *
 * The expansion is scoped to the hit's document via `base_ref` (present on every
 * result) so it never crosses into another document, and runs under the SAME
 * temporal/revision-visibility + tenant/ACL predicates the search query used —
 * expansion can never surface a unit the searcher could not have retrieved
 * directly, nor a unit from a non-current revision.
 */
export interface ExpandUnitCoords {
  /** The hit's own unit id, when known (used to dedupe it from its expansion). */
  unitId?: string | null;
  /** Base document reference of the hit; scopes the expansion to one document. */
  baseRef: string;
  /** neighbors: the hit's previous reading-order sibling. */
  prevUnitId?: string | null;
  /** neighbors: the hit's next reading-order sibling. */
  nextUnitId?: string | null;
  /** section: the section the hit belongs to. */
  sectionId?: string | null;
  /** page: first page the hit overlaps. */
  pageStart?: number | null;
  /** page: last page the hit overlaps. */
  pageEnd?: number | null;
}

/** One expansion unit row plus its coordinates, in reading order. */
export interface ExpandUnitRow extends ExpansionUnit {
  page_start: number | null;
  page_end: number | null;
}

/**
 * Resolved metadata for a figure unit, keyed by `figure_id` (task 3.7,
 * Requirement 13.5). Used by the `/v2/search` asset-attach step to enrich the
 * figures a hit REFERENCES (its `figure_refs`, which carry only ids) with the
 * `figure_kind`, `caption`, `page` and `bbox` needed for the response asset
 * object. Resolved through the same tenant/ACL/visibility predicates as a
 * search so it can never surface a figure the searcher could not retrieve.
 */
export interface FigureUnitInfo {
  figure_id: string;
  asset_id: string | null;
  figure_kind: string | null;
  /** First line/sentence of the figure unit content, used as the caption. */
  caption: string | null;
  page: number | null;
  bbox: [number, number, number, number] | null;
}

// ─── v2 navigation tool support ──────────────────────────────────
// The read-only query surface behind the MCP navigation tools (get_outline,
// get_section, get_pages, get_context, list_figures, get_table, find_identifier,
// follow_ref). Every method runs under the SAME tenant/ACL + temporal/
// revision-visibility predicates as {@link PostgresClient.search}
// (buildAccessSql / buildTemporalFilterSql), scoped to one document via
// `document_id` or `base_ref`, so a navigation call can never surface a unit or
// asset the caller could not retrieve directly, nor one from a non-current
// revision.

/** A section entry of a document outline (a `section` unit's heading + coords). */
export interface OutlineEntry {
  unit_id: string;
  section_id: string | null;
  section_path: string[];
  /** Nesting depth (1-based), derived from the section path length. */
  depth: number;
  /** Heading text (the section path's leaf), for a readable table of contents. */
  heading: string;
  page_start: number | null;
  page_end: number | null;
}

/** One navigation unit row (section/page/table/figure/chunk), reading-ordered. */
export interface NavUnitRow {
  unit_id: string | null;
  unit_type: string | null;
  content: string;
  section_id: string | null;
  section_path: string[];
  page_start: number | null;
  page_end: number | null;
  figure_kind: string | null;
  table_id: string | null;
  metadata: Metadata;
}

/** One exact identifier occurrence (a `vs_identifiers` row joined to its unit). */
export interface IdentifierOccurrence {
  value_norm: string;
  unit_id: string;
  page: number | null;
  kind: string | null;
  reference: string;
  base_ref: string;
  section_path: string[];
  /** A short excerpt of the unit's content around the identifier. */
  excerpt: string;
}

/** Common options shared by the navigation reads. */
export interface NavReadOptions {
  includeAllVersions?: boolean;
  validAt?: string;
}

/**
 * One cited chunk as loaded for `POST /v2/citations/check`. `id` is the
 * citation identity the caller knows: the v1 `chunk_id` from the chunk
 * jsonb, or the v2 `unit_id` a search hit carried as evidence.
 */
export interface CitationChunkRow {
  id: string;
  base_ref: string;
  revision_id: string | null;
  content: string;
  /** Start of the row's validity interval (RFC 3339; null = fall back to `created`). */
  valid_from: string | null;
  /** Row insert time (RFC 3339) — the validity interval's fallback start. */
  created: string;
}

/** The revision of one document visible at an instant (citations check). */
export interface CurrentRevisionRow {
  base_ref: string;
  /** The visible revision id; null for unversioned (legacy) content. */
  revision_id: string | null;
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
  /** Raw query text — only present when STATS_STORE_RAW_QUERY=true. */
  query: string | null;
  /** SHA-256 / HMAC-SHA-256 of the query (Requirement 2.6). */
  query_hash: string | null;
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
  /**
   * What the stored data supports, so a caller can decide which tools to offer
   * instead of discovering empty answers. A collection ingested before the v2
   * pipeline has chunk rows but no unit graph: `get_outline`, `get_pages`,
   * `get_section` and `get_context` come back empty for it.
   */
  capabilities: {
    /** Latest-version rows that carry a v2 `unit_id`. */
    unitRows: number;
    /** True when the collection has a v2 unit graph (any unit row). */
    unitGraph: boolean;
    /** `get_outline` / `get_section` have data (rows with a `section_id`). */
    outline: boolean;
    /** `get_pages` has data (rows with a `page_start`). */
    pages: boolean;
  };
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
/** Another part of the same split document, as `get_documents` lists it. */
export interface SplitSibling {
  base_ref: string;
  title: string | null;
  /** `metadata.split_order` as a number, null when absent or not numeric. */
  order: number | null;
}

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
    /** v2: the unit the span comes from, for get_context / follow_ref. */
    unit_id?: string;
    unit_type?: string;
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

export interface PostgresClient {
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
    validAt?: string,
    /** v2-only options (identifier list); omitted by v1 callers → unchanged v1 behaviour. */
    searchOptions?: SearchOptions,
  ): Promise<PostgresResponse<SearchResult[]>>;
  /**
   * Check the installed pgvector version once (Req 4.2): `true` when it
   * supports `hnsw.iterative_scan` (≥ 0.8), `false` when it is older (a
   * warning is logged and iterative scans stay disabled), `null` when the
   * extension is not installed yet — the verdict stays uncached and the
   * next call re-checks. Called at startup after migrations; searches also
   * check lazily, so calling this is an optimisation, not a prerequisite.
   */
  ensurePgvectorVersion(): Promise<boolean | null>;
  /**
   * Resolve the source sha256 of a stored revision SERVER-SIDE (Requirement
   * 14.4/14.5): the `document.begin.source.sha256` the producer staged with the
   * revision's batches. Used by the MCP `get_asset(region)` zoom so the render
   * source is bound to the ACL-checked asset's revision rather than supplied by
   * the caller. Read-only. Returns null when the revision has no staged
   * `document.begin` (e.g. a legacy v1 document) or its digest is not a
   * lowercase hex sha256.
   */
  lookupRevisionSourceSha256(
    collection: string,
    tenantId: string,
    revisionId: string,
  ): Promise<PostgresResponse<string | null>>;

  /**
   * Small-to-big expansion (task 3.6, Requirement 13.4): fetch the expansion set
   * for a single search hit in reading order, honouring the SAME
   * temporal/revision-visibility + tenant/ACL predicates as {@link search}.
   *
   * `mode`:
   *  - `neighbors` — the hit plus its prev/next reading-order siblings;
   *  - `section`   — every unit sharing the hit's `section_id` in the document;
   *  - `page`      — every unit overlapping the hit's page range in the document;
   *  - `document`  — every unit of the document; for an e-mail every unit of
   *                  every message in its thread, chronologically.
   *
   * Returns the units ordered for reading (by page then id); the pure assembler
   * (`assembleExpansion`) then bounds them by `budget_chars` and reports
   * `truncated`. Returns `[]` (never an error) when the hit carries no usable
   * coordinates for the requested mode, so a caller can always attempt expansion
   * without pre-checking.
   */
  expandUnit(
    collection: string,
    scope: AccessScope,
    mode: ExpandMode,
    coords: ExpandUnitCoords,
    options?: {
      includeAllVersions?: boolean;
      validAt?: string;
    },
  ): Promise<PostgresResponse<ExpandUnitRow[]>>;

  /**
   * The group (e-mail thread, attachment parent) of each document reference;
   * references without a group are absent. Optional so test doubles without
   * it keep working — callers then group by document as before.
   */
  resolveDocumentGroups?(
    collection: string,
    scope: AccessScope,
    references: string[],
  ): Promise<PostgresResponse<Map<string, DocumentGroup>>>;

  /**
   * The e-mails of a thread in chronological order (their references). The
   * caller reads each with {@link getDocument}, which applies the row ACL, so a
   * member the caller may not see is simply not returned.
   */
  listThreadMembers?(
    collection: string,
    scope: AccessScope,
    threadId: string,
  ): Promise<PostgresResponse<string[]>>;

  /**
   * Resolve figure-unit metadata by `figure_id` within one document (task 3.7,
   * Requirement 13.5), for the `/v2/search` asset-attach step. Scoped to
   * `baseRef` and run under the SAME temporal/revision-visibility + tenant/ACL
   * predicates as {@link search}, so it never surfaces a figure the searcher
   * could not retrieve. Returns one {@link FigureUnitInfo} per resolvable
   * figure id; unknown ids are simply absent. `[]` (never an error) when there
   * are no ids or no base ref.
   */
  lookupFigureUnits(
    collection: string,
    scope: AccessScope,
    baseRef: string,
    figureIds: string[],
    options?: {
      includeAllVersions?: boolean;
      validAt?: string;
    },
  ): Promise<PostgresResponse<FigureUnitInfo[]>>;

  /**
   * The table of contents of one document (task 3.9, Requirement 15.1): its
   * `section` units' heading path + page range + section id, depth-limited and
   * paginated (a single huge document's outline). `reference` is
   * the document base_ref. Ordered by page then section path.
   */
  getOutline(
    collection: string,
    scope: AccessScope,
    reference: string,
    options?: NavReadOptions & {
      depth?: number;
      limit?: number;
      offset?: number;
    },
  ): Promise<PostgresResponse<{ entries: OutlineEntry[]; total: number }>>;

  /**
   * The units of one section (task 3.9, Requirement 15.1), selected by
   * `section_id` or by `section_path` prefix, in reading order. Used to render a
   * section as Markdown v2. Bounded by `maxChars`, reporting `truncated`.
   */
  getSectionUnits(
    collection: string,
    scope: AccessScope,
    reference: string,
    selector: { sectionId?: string; sectionPath?: string[] },
    options?: NavReadOptions,
  ): Promise<PostgresResponse<NavUnitRow[]>>;

  /**
   * Every unit of one document visible under `scope` (and `validAt`), in
   * reading order, in a single read. At most `limit` units (default and cap:
   * the navigation unit cap); `truncated` reports that more exist.
   */
  getDocumentUnits(
    collection: string,
    scope: AccessScope,
    reference: string,
    options?: NavReadOptions & { limit?: number },
  ): Promise<PostgresResponse<{ units: NavUnitRow[]; truncated: boolean }>>;

  /**
   * The units overlapping a page range of one document, in reading
   * order — used to render pages as Markdown v2 or a summary.
   */
  getPageUnits(
    collection: string,
    scope: AccessScope,
    reference: string,
    from: number,
    to: number,
    options?: NavReadOptions,
  ): Promise<PostgresResponse<NavUnitRow[]>>;

  /**
   * The reading-order neighbours of a unit: the unit itself plus up
   * to `before`/`after` units walked through the `prev_unit_id`/`next_unit_id`
   * graph within the same document.
   */
  getContextUnits(
    collection: string,
    scope: AccessScope,
    unitId: string,
    before: number,
    after: number,
    options?: NavReadOptions,
  ): Promise<
    PostgresResponse<{
      before: NavUnitRow[];
      unit: NavUnitRow | null;
      after: NavUnitRow[];
    }>
  >;

  /**
   * The figure units of a document, optionally restricted to a page range
   * and/or a figure kind (task 3.9, Requirement 15.1), paginated.
   */
  listFigureUnits(
    collection: string,
    scope: AccessScope,
    reference: string,
    options?: NavReadOptions & {
      fromPage?: number;
      toPage?: number;
      kind?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<PostgresResponse<{ figures: FigureUnitInfo[]; total: number }>>;

  /**
   * The row-group units of a logical table, reassembled across page boundaries
   * by `table_id`, in reading order. Bounded by `rows` (row-group
   * count) and reporting `truncated`.
   */
  getTableUnits(
    collection: string,
    scope: AccessScope,
    tableId: string,
    options?: NavReadOptions & { limit?: number },
  ): Promise<PostgresResponse<{ units: NavUnitRow[]; total: number }>>;

  /**
   * Resolve a unit and the figure units it references (task 3.9,
   * `follow_ref`): the unit's `figure_refs` (figure ids referenced within its
   * span) resolved to their figure units, in the same document, under the same
   * gates as search. Returns null when the unit is not visible.
   */
  getUnitById(
    collection: string,
    scope: AccessScope,
    unitId: string,
    options?: NavReadOptions,
  ): Promise<PostgresResponse<NavUnitRow | null>>;

  /**
   * Exact identifier occurrences across the whole collection (task 3.9,
   * Requirement 15.1): every `vs_identifiers` row whose `value_norm` matches the
   * normalized query value, joined to its visible unit, paginated. ACL/temporal
   * gated per unit so an occurrence is only returned when its unit is visible.
   */
  findIdentifierOccurrences(
    collection: string,
    scope: AccessScope,
    valueNorm: string,
    options?: NavReadOptions & {
      limit?: number;
      offset?: number;
      pathPrefix?: string;
    },
  ): Promise<
    PostgresResponse<{ occurrences: IdentifierOccurrence[]; total: number }>
  >;

  /**
   * Cited chunks by id (`POST /v2/citations/check`): the v1 `chunk_id` or the
   * v2 `unit_id`, under the caller's ACL, WITHOUT a temporal filter so a chunk
   * in a superseded revision still resolves. Ids the caller cannot see are
   * absent from the result.
   */
  getChunksByIds(
    collection: string,
    scope: AccessScope,
    chunkIds: string[],
  ): Promise<PostgresResponse<CitationChunkRow[]>>;

  /**
   * The revision of each listed document visible at `validAt` (the temporal
   * rule of `document_diff`), in one query. A base ref with no visible row is
   * absent — the document has no revision visible at that instant.
   */
  getCurrentRevisionsAt(
    collection: string,
    scope: AccessScope,
    baseRefs: string[],
    validAt: string,
  ): Promise<PostgresResponse<CurrentRevisionRow[]>>;

  /**
   * The content of every unit of one document's revision visible at `validAt`
   * (citations-check content-hash comparison), bounded by the navigation unit
   * cap; `truncated` says the document holds more units than were returned.
   */
  getCurrentRevisionContents(
    collection: string,
    scope: AccessScope,
    baseRef: string,
    validAt: string,
  ): Promise<PostgresResponse<{ contents: string[]; truncated: boolean }>>;

  delete(
    filter: SearchFilter,
    collection: string,
    scope: AccessScope,
    reference?: string,
  ): Promise<PostgresResponse<{ deleted: number }>>;

  /**
   * Register the post-delete cache-invalidation hook (task 4.2, Requirement
   * 2.4). Invoked after a document cascade COMMITS with the affected root
   * references, so the server can drop in-process caches derived from them.
   * A hook failure is logged, never propagated — the delete already committed.
   */
  setOnDocumentsDeleted?(
    hook: (collection: string, rootRefs: string[]) => void,
  ): void;

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
  ): Promise<PostgresResponse<{ documents: DocumentSummary[]; total: number }>>;

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
  ): Promise<PostgresResponse<{ query: string; matches: FolderSummary[] }>>;

  /**
   * Reassemble a whole document from its latest chunks (ordered by chunk
   * index, overlaps trimmed). `reference` may be the document's base_ref or any
   * of its chunk references. Returns null when no such document exists.
   */
  getDocument(
    collection: string,
    scope: AccessScope,
    reference: string,
    options?: { maxChars?: number; offset?: number; validAt?: string },
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
  >;

  /**
   * The other parts of each given split document: documents of the same folder
   * (everything before the last `/` of `base_ref`) that carry the same
   * `metadata.split_of`, ordered by `metadata.split_order`. Only documents the
   * caller may read are listed. A reference without siblings is absent from the
   * result.
   */
  getSplitSiblings(
    collection: string,
    scope: AccessScope,
    documents: ReadonlyArray<{ reference: string; splitOf: string }>,
    options?: { validAt?: string },
  ): Promise<PostgresResponse<Record<string, SplitSibling[]>>>;

  /**
   * Fetch the stored summary/prefix of a single document (chunk-0 `prefix`).
   * `reference` may be the document's base_ref or any of its chunk references.
   * Returns null when no such document exists.
   */
  getSummary(
    collection: string,
    scope: AccessScope,
    reference: string,
    options?: { validAt?: string },
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
    options?: {
      pathPrefix?: string;
      limit?: number;
      offset?: number;
      validAt?: string;
    },
  ): Promise<PostgresResponse<{ summaries: SummaryEntry[]; total: number }>>;

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
   * Change a collection's full-text-search language and recompute its
   * `ts_search` vectors in place (Requirement 2.6).
   *
   * When the language changes, existing vectors were stemmed under the old
   * language and would no longer match queries stemmed under the new one, so
   * every row is re-tokenized from its stored content in a single set-based
   * UPDATE. The config row is updated atomically in the same transaction.
   *
   * No-op (updated = 0, unchanged = true) when the collection already uses the
   * requested language. Returns COLLECTION_NOT_FOUND when the collection does
   * not exist, UNSUPPORTED_FTS_LANGUAGE when the language is not whitelisted.
   */
  recomputeFtsLanguage(
    collection: string,
    language: string,
  ): Promise<PostgresResponse<{ updated: number; unchanged: boolean }>>;

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
