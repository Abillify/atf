// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * postgres-client.ts
 *
 * Public PostgresClient interface and factory.
 * DDL logic lives in collection-ddl.ts, query builders in query-builder.ts,
 * and the stats write-buffer in stats-buffer.ts.
 */

import { resolveFigureKinds } from "./figure-kinds.js";
import {
  forgetDocument,
  groupMemberReferences,
  resolveDocumentGroups,
  type DocumentGroup,
} from "./document-identity.js";
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
  ftsSearchRecomputeSql,
  AppError,
} from "./collection-ddl.js";
import {
  buildDenseQuery,
  buildBinaryDenseQuery,
  buildHybridQuery,
  buildFtsQuery,
  buildAccessSql,
  buildTemporalFilterSql,
  SqlParams,
} from "./query-builder.js";
import type { ExpandMode, ExpansionUnit } from "./expansion.js";
import { buildIdentifierTsQuery, queryIdentifierValueNorms } from "./identifier.js";
import type { AccessScope } from "./access-scope.js";
import { createStatsBuffer } from "./stats-buffer.js";
import type { CollectionAcl } from "./collection-access.js";

export { validateFtsLanguage, collectionTableName };

/**
 * Derive a figure caption from a figure unit's stored content (task 3.7). A
 * figure unit's content is `caption\ndescription\ntranscription…` (see
 * batch-unit-builder `renderFigureText`), so the first non-empty line is the
 * caption. Trimmed and length-bounded so a runaway description cannot bloat the
 * response asset object. Returns null for empty content.
 */
function figureCaption(content: string | null | undefined): string | null {
  if (!content) return null;
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine === "") return null;
  return firstLine.length > 300 ? firstLine.slice(0, 300) : firstLine;
}

// ─── v2 navigation query helpers (task 3.9) ─────────────────────────────────

/** Clamp an optional integer to `[min, max]`, falling back to `fallback`. */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** A short, single-line excerpt of a unit's content (for identifier hits). */
function navExcerpt(content: string | null | undefined): string {
  if (!content) return "";
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** The shared column set every navigation unit row selects. */
const NAV_ROW_SELECT =
  `SELECT unit_id, unit_type, content, section_id, section_path,
          page_start, page_end, figure_kind, table_id, metadata`;

/** The raw row shape {@link NAV_ROW_SELECT} returns. */
interface NavRowShape {
  unit_id: string | null;
  unit_type: string | null;
  content: string | null;
  section_id: string | null;
  section_path: string[] | null;
  page_start: number | null;
  page_end: number | null;
  figure_kind: string | null;
  table_id: string | null;
  metadata: Metadata | null;
}

/** Normalize a raw navigation row into a {@link NavUnitRow}. */
function navRow(row: NavRowShape): NavUnitRow {
  return {
    unit_id: row.unit_id,
    unit_type: row.unit_type,
    content: row.content ?? "",
    section_id: row.section_id,
    section_path: Array.isArray(row.section_path) ? row.section_path : [],
    // Section units carry a page sentinel of 0; expose null for a clean range.
    page_start: row.page_start && row.page_start > 0 ? row.page_start : null,
    page_end: row.page_end && row.page_end > 0 ? row.page_end : null,
    figure_kind: row.figure_kind,
    table_id: row.table_id,
    metadata: row.metadata ?? {},
  };
}

/** Drop the internal prev/next link fields from a loaded context row. */
function stripLinks(row: NavUnitRow & { prev_unit_id?: string | null; next_unit_id?: string | null }): NavUnitRow {
  return {
    unit_id: row.unit_id,
    unit_type: row.unit_type,
    content: row.content,
    section_id: row.section_id,
    section_path: row.section_path,
    page_start: row.page_start,
    page_end: row.page_end,
    figure_kind: row.figure_kind,
    table_id: row.table_id,
    metadata: row.metadata,
  };
}

/**
 * Look up the unit ids a query's identifiers resolve to (task 3.4, Req 12.3).
 *
 * Recognise identifier-shaped tokens in the query text (article numbers, mask/
 * transaction codes, drawing numbers, standards, requirement ids), normalise
 * each to its `value_norm`, and select the matching unit ids from the shared
 * `vs_identifiers` index scoped by tenant + collection. Returns them ordered by
 * how many distinct query identifiers a unit matched (best first) so the caller
 * can use array order as the exact-match rank of the third RRF list.
 *
 * Returns `[]` when the query carries no identifier, the tenant is unknown, or
 * the identifier index is empty — in which case the identifier RRF list simply
 * does not participate and hybrid search is exactly the dense+fts(+sparse) fusion
 * it was before. Guards against a missing `vs_identifiers` table (a deployment
 * mid-migration) by treating a lookup error as "no identifier hits" — but the
 * failure is LOGGED (warn) so a broken identifier index is visible, and the
 * lookup runs under a SAVEPOINT so the error does not abort the surrounding
 * search transaction (the caller runs this after `BEGIN`).
 */
export async function lookupIdentifierUnitIds(
  client: PoolClient,
  valueNorms: readonly string[],
  tenantId: string | undefined,
  collection: string,
  logger: pino.Logger,
): Promise<string[]> {
  const tenant = tenantId?.trim();
  if (!tenant) return [];
  if (valueNorms.length === 0) return [];
  await client.query("SAVEPOINT identifier_lookup");
  try {
    const res = await client.query<{ unit_id: string }>(
      `SELECT unit_id
         FROM vs_identifiers
        WHERE tenant_id = $1 AND collection = $2 AND value_norm = ANY($3::text[])
        GROUP BY unit_id
        ORDER BY COUNT(DISTINCT value_norm) DESC, unit_id ASC
        LIMIT ${IDENTIFIER_LOOKUP_MAX_UNITS}`,
      [tenant, collection, [...valueNorms]],
    );
    await client.query("RELEASE SAVEPOINT identifier_lookup");
    return res.rows.map((r) => r.unit_id);
  } catch (err) {
    // A missing table or transient error must never fail an otherwise-valid
    // search; degrade to no exact identifier list, but make it visible.
    await client.query("ROLLBACK TO SAVEPOINT identifier_lookup").catch(() => {});
    logger.warn(
      { err, collection, identifiers: valueNorms.length },
      "Identifier lookup (vs_identifiers) failed; searching without the exact identifier list",
    );
    return [];
  }
}

/**
 * Hard row cap for the section/page navigation reads (get_section, get_pages,
 * Requirement 15.3). Their OUTPUT is already bounded by `max_chars`; this bounds
 * the DB fetch too, so a whole-document page range cannot pull every unit.
 */
const NAV_MAX_UNITS = 5000;

/** Upper bound on exact identifier hits fed into the identifier RRF list. */
const IDENTIFIER_LOOKUP_MAX_UNITS = 1000;

/** Bytes of each staged batch payload scanned for `document.begin` (it is the first record). */
const SOURCE_HEAD_BYTES = 64 * 1024;
/** Staged batches (in seq order) scanned for `document.begin` before giving up. */
const SOURCE_HEAD_MAX_BATCHES = 4;
/** Records per payload head inspected before giving up (document.begin comes first). */
const SOURCE_HEAD_MAX_RECORDS = 8;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Extract `document.begin.source.sha256` from the head of a staged NDJSON batch
 * payload (contract v2). Tolerates a truncated trailing line (the head is a
 * byte prefix) and non-JSON noise; returns null unless a `document.begin`
 * record with a lowercase hex sha256 is found in the first few records.
 */
export function sourceSha256FromPayloadHead(head: Buffer | string | null | undefined): string | null {
  if (head === null || head === undefined) return null;
  const text = typeof head === "string" ? head : head.toString("utf-8");
  const lines = text.split("\n");
  let inspected = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (++inspected > SOURCE_HEAD_MAX_RECORDS) break;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const r = record as { type?: unknown; source?: { sha256?: unknown } };
    if (r.type !== "document.begin") continue;
    const sha = r.source?.sha256;
    return typeof sha === "string" && SHA256_HEX.test(sha) ? sha : null;
  }
  return null;
}

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
  /** Per-list RRF weights (task 3.4, Req 12.3). All default to 1.0 (unchanged ranking). */
  rrfWeightDense?: number;
  rrfWeightFts?: number;
  rrfWeightIdentifier?: number;
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

// ─── v2 navigation tool support (task 3.9) ──────────────────────────────────
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
    validAt?: string,
    /** v2-only options (identifier list); omitted by v1 callers → unchanged v1 behaviour. */
    searchOptions?: SearchOptions,
  ): Promise<PostgresResponse<SearchResult[]>>;
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
   * paginated (design §6.6 — a single huge document's outline). `reference` is
   * the document base_ref. Ordered by page then section path.
   */
  getOutline(
    collection: string,
    scope: AccessScope,
    reference: string,
    options?: NavReadOptions & { depth?: number; limit?: number; offset?: number },
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
   * The units overlapping a page range of one document (task 3.9), in reading
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
   * The reading-order neighbours of a unit (task 3.9): the unit itself plus up
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
  ): Promise<PostgresResponse<{ before: NavUnitRow[]; unit: NavUnitRow | null; after: NavUnitRow[] }>>;

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
   * by `table_id` (task 3.9), in reading order. Bounded by `rows` (row-group
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
    options?: NavReadOptions & { limit?: number; offset?: number; pathPrefix?: string },
  ): Promise<PostgresResponse<{ occurrences: IdentifierOccurrence[]; total: number }>>;

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
    options?: { pathPrefix?: string; limit?: number; maxChars?: number; validAt?: string },
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
    options?: { pathPrefix?: string; limit?: number; offset?: number; validAt?: string },
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
 * For a set of revision ids appearing in a search result, return the ones whose
 * revision is only partially visible (`status='partial'`, a `progressive`
 * revision still ingesting) together with the human-readable committed page span
 * so a hit can carry `revision_state=partial` + `pages_available` (Req 6.4).
 *
 * A committed revision (status='committed') is fully visible and is NOT tagged.
 * The page span is the merged min–max of the revision's committed segments,
 * formatted like "1–2750" (en dash), matching design §9a.3.
 */
async function annotatePartialRevisions(
  client: PoolClient,
  revisionIds: string[],
): Promise<Map<string, { pagesAvailable: string }>> {
  const out = new Map<string, { pagesAvailable: string }>();
  const partial = await client.query<{ revision_id: string }>(
    `SELECT revision_id FROM vs_revisions
      WHERE revision_id = ANY($1) AND status = 'partial'`,
    [revisionIds],
  );
  if (partial.rows.length === 0) return out;
  const partialIds = partial.rows.map((r) => r.revision_id);
  const segments = await client.query<{ revision_id: string; page_start: number; page_end: number }>(
    `SELECT revision_id, page_start, page_end FROM vs_segments
      WHERE revision_id = ANY($1)
      ORDER BY revision_id, page_start`,
    [partialIds],
  );
  const spanByRevision = new Map<string, { from: number; to: number }>();
  for (const seg of segments.rows) {
    const span = spanByRevision.get(seg.revision_id);
    if (!span) {
      spanByRevision.set(seg.revision_id, { from: seg.page_start, to: seg.page_end });
    } else {
      span.from = Math.min(span.from, seg.page_start);
      span.to = Math.max(span.to, seg.page_end);
    }
  }
  for (const revId of partialIds) {
    const span = spanByRevision.get(revId);
    // A partial revision with no committed segment yet exposes no pages; still
    // tag it partial so a caller knows the revision is incomplete.
    out.set(revId, { pagesAvailable: span ? `${span.from}\u2013${span.to}` : "" });
  }
  return out;
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

/**
 * The rows that form a document's text. A v1 row has no `unit_type`; of the v2
 * units only `chunk`/`table`/`figure` carry the document's own content — the
 * `section`/`page`/`document` units are Extract's summaries, which must never be
 * read back as the original.
 */
export const DOCUMENT_BODY_SQL = `(unit_type IS NULL OR unit_type IN ('chunk', 'table', 'figure'))`;

/**
 * Reading order of a document's rows. A v1 row orders by its chunk index; v2
 * units carry no chunk JSON, so they order by page, then by the position of
 * their first source block on the page (`p{page}-b{n}`), then by their ordinal
 * within that block group (the row-groups of a table, the pieces of a long
 * text group). `id` only breaks ties — it is insertion order, which follows
 * batch processing, not the document.
 */
export const DOCUMENT_ORDER_SQL =
  `COALESCE((chunk->>'chunk_index')::int, 0) ASC, page_start ASC NULLS FIRST, ` +
  `NULLIF(substring(block_ids[1] from '-b([0-9]+)$'), '')::int ASC NULLS FIRST, ` +
  `CASE WHEN unit_type IS NOT NULL AND metadata->>'ordinal' ~ '^[0-9]+$' ` +
  `THEN (metadata->>'ordinal')::int END ASC NULLS FIRST, id ASC`;

/**
 * The text a row contributes to its document. A v1 row is its content. A v2
 * `table` unit's content also holds the row-wise "Spalte: Wert" lines for
 * full-text search; only the grid part (`display_len`) is document text. A v2
 * `figure` unit is marked as a figure with its ids, so a reader knows the text
 * is a transcription and can fetch the image.
 */
export function documentBodyText(row: {
  content: string;
  unit_type?: string | null;
  metadata?: Metadata | null;
}): string {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  // A table's row-wise lines, and a chunk's carried continuation from the
  // next page (contract 2.3), are indexed but are not this unit's text.
  if (row.unit_type === "table" || row.unit_type === "chunk") {
    const len = meta.display_len;
    return typeof len === "number" && len > 0 && len < row.content.length
      ? row.content.slice(0, len)
      : row.content;
  }
  if (row.unit_type === "figure") {
    const label = [
      typeof meta.figure_id === "string" ? meta.figure_id : undefined,
      typeof meta.figure_kind === "string" ? meta.figure_kind : undefined,
      typeof meta.asset_id === "string" ? `asset_id=${meta.asset_id}` : undefined,
    ].filter((p): p is string => p !== undefined);
    return `[Abbildung${label.length > 0 ? ` ${label.join(" · ")}` : ""}]\n${row.content}`;
  }
  return row.content;
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
  unit_type?: string | null;
}>(chunks: T[]): { content: string; coordinates: Array<MergedChunkCoordinate<T>> } {
  if (chunks.length === 0) return { content: "", coordinates: [] };
  let merged = "";
  const coordinates: Array<MergedChunkCoordinate<T>> = [];
  for (let index = 0; index < chunks.length; index++) {
    const item = chunks[index]!;
    // A v2 unit is a whole block group with no overlap: it is joined as its
    // own paragraph, never suffix-trimmed (a table row-group repeats its
    // header, which the probe would otherwise eat), and the reassembled text
    // is its own coordinate system.
    if (item.unit_type != null) {
      if (index > 0) merged += "\n\n";
      const returnedStart = merged.length;
      merged += item.content;
      coordinates.push({
        item,
        returnedStart,
        returnedEnd: merged.length,
        originalStart: returnedStart,
        originalEnd: merged.length,
      });
      continue;
    }
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
  /**
   * The version gate plus the access predicate for a whole-document read: the
   * current revision (the v2 pointer, not only `is_latest`), or with `validAt`
   * the version valid at that instant — the same rule the search applies, so a
   * `valid_at` hit can be read in full.
   */
  const versionedWhere = (
    table: string,
    collection: string,
    scope: AccessScope,
    params: unknown[],
    validAt?: string,
  ): { sql: string; params: unknown[] } => {
    const p = new SqlParams();
    p.values.push(...params);
    const temporal = buildTemporalFilterSql(p, table, false, validAt, "", collection);
    return { sql: temporal + buildAccessSql(p, scope), params: p.values };
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
    rrfWeightDense = 1.0,
    rrfWeightFts = 1.0,
    rrfWeightIdentifier = 1.0,
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
          params.push(point.tenantId);
          const tenantParam = params.length;

          const result = await client.query<{
            id: string;
            was_insert: boolean;
          }>(
            `INSERT INTO "${table}"
               (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                prefix, source, link, title, tags, allowed_users, allowed_groups, valid_from, modified${sql.sparseCol}${sql.binaryCol}, tenant_id)
             VALUES ($1, $2, TRUE, $3, $4::${vecType}, to_tsvector('${lang}', $${ftsParam}), $5, $6,
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
            params.push(point.tenantId);
            const tenantParam = params.length;

            const result = await client.query<{ id: string }>(
              `INSERT INTO "${table}"
                 (reference, base_ref, is_latest, content, vector, ts_search, metadata, chunk,
                  prefix, source, link, title, tags, allowed_users, allowed_groups, valid_from${sql.sparseCol}${sql.binaryCol}, tenant_id)
               VALUES ($1, $2, TRUE, $3, $4::${vecType}, to_tsvector('${lang}', $${ftsParam}), $5, $6,
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
        if (expectedEmbeddingModel !== undefined && meta.embeddingModel !== expectedEmbeddingModel) {
          // A collection that does not exist has no provenance either; say
          // what is actually wrong instead of reporting a model mismatch.
          const exists = await client.query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [`"${table}"`]);
          if (!exists.rows[0]?.t) {
            throw new AppError("COLLECTION_NOT_FOUND", `Collection "${collection}" not found`);
          }
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
              ? queryIdentifierValueNorms(query, searchOptions.identifiers ?? [])
              : [];
          const identifierUnitIds =
            identifierNorms.length > 0
              ? await lookupIdentifierUnitIds(client, identifierNorms, scope.tenantId, collection, logger)
              : [];
          const identifierTsQuery = buildIdentifierTsQuery(identifierNorms);

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
                validAt,
                collection,
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
                  validAt,
                  collection,
                  {
                    weightDense: rrfWeightDense,
                    weightFts: rrfWeightFts,
                    weightIdentifier: rrfWeightIdentifier,
                    identifierUnitIds,
                    identifierTsQuery,
                  },
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
                    tags,
                    scope,
                    undefined,
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
                ...(chunk?.char_start !== undefined ? { char_start: chunk.char_start } : {}),
                ...(chunk?.char_end !== undefined ? { char_end: chunk.char_end } : {}),
                ...(chunk?.page_start !== undefined ? { page_start: chunk.page_start } : {}),
                ...(chunk?.page_end !== undefined ? { page_end: chunk.page_end } : {}),
                ...(chunk?.section_path ? { section_path: chunk.section_path } : {}),
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
            ...((row.chunk as ChunkInfo | null)?.asset_id
              ? { asset_url: `/document-assets/${encodeURIComponent((row.chunk as ChunkInfo).asset_id!)}?collection=${encodeURIComponent(collection)}` }
              : {}),
            created: row.created as Date,
            modified: row.modified as Date,
            valid_from: (row.valid_from as Date | null) ?? null,
            effective_valid_from: row.effective_valid_from as Date,
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
                .filter((id): id is string => typeof id === "string" && id.length > 0),
            ),
          ];
          if (revisionIds.length > 0) {
            const partial = await annotatePartialRevisions(client, revisionIds);
            if (partial.size > 0) {
              for (let i = 0; i < searchResults.length; i++) {
                const revId = (result.rows[i] as { revision_id?: string | null }).revision_id;
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

    async expandUnit(
      collection: string,
      scope: AccessScope,
      mode: ExpandMode,
      coords: ExpandUnitCoords,
      options?: { includeAllVersions?: boolean; validAt?: string },
    ): Promise<PostgresResponse<ExpandUnitRow[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const baseRef = coords.baseRef?.trim();
      if (!baseRef) return { ok: true, result: [] };

      // Build the mode-specific target predicate. Every mode is additionally
      // scoped to the hit's document (base_ref) so expansion never crosses into
      // another document, and runs under the SAME temporal/revision-visibility
      // (buildTemporalFilterSql, with the collection so the current-revision
      // pointer is honoured) and tenant/ACL (buildAccessSql) predicates as the
      // search query. That is what keeps expansion from surfacing a unit the
      // searcher could not retrieve directly, or one from a non-current revision.
      const p = new SqlParams();
      const temporalFilter = buildTemporalFilterSql(
        p,
        table,
        options?.includeAllVersions ?? false,
        options?.validAt,
        "",
        collection,
      );
      const accessSql = buildAccessSql(p, scope);

      if (mode === "document") {
        const tenantId = scope.tenantId;
        return withClient(async (client) => {
          // The documents to read: the hit's thread in chronological order, or
          // just the hit's document.
          const groups = await resolveDocumentGroups(client, {
            tenantId,
            collection,
            references: [baseRef],
          });
          const group = groups.get(baseRef);
          const members =
            group?.kind === "email_thread"
              ? await groupMemberReferences(client, { tenantId, collection, groupId: group.id })
              : [];
          const refs = members.length > 0 ? members : [baseRef];
          const refsPh = p.add(refs);
          const res = await client.query<{
            unit_id: string | null;
            content: string | null;
            page_start: number | null;
            page_end: number | null;
          }>(
            `SELECT unit_id, content, page_start, page_end
               FROM "${table}"
              WHERE base_ref = ANY(${refsPh}::text[])
                AND (unit_type IS NULL OR unit_type NOT IN ('section', 'page', 'document'))${temporalFilter}${accessSql}
              ORDER BY array_position(${refsPh}::text[], base_ref),
                       page_start ASC NULLS FIRST, page_end ASC NULLS FIRST, id ASC`,
            p.values,
          );
          return res.rows.map((row) => ({
            unit_id: row.unit_id,
            content: row.content ?? "",
            page_start: row.page_start,
            page_end: row.page_end,
          }));
        });
      }

      const baseRefPh = p.add(baseRef);

      let targetSql: string;
      if (mode === "neighbors") {
        // The hit plus whichever of its prev/next reading-order siblings exist.
        // With no sibling ids there is nothing to expand to; return the hit's
        // own row set (which dedupes to empty in the assembler), i.e. [].
        const ids = [coords.unitId, coords.prevUnitId, coords.nextUnitId].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
        if (ids.length === 0) return { ok: true, result: [] };
        const idsPh = p.add(ids);
        targetSql = `unit_id = ANY(${idsPh}::text[])`;
      } else if (mode === "section") {
        const sectionId = coords.sectionId?.trim();
        if (!sectionId) return { ok: true, result: [] };
        const secPh = p.add(sectionId);
        targetSql = `section_id = ${secPh}`;
      } else {
        // page: every unit overlapping the hit's page range in this document.
        const start = coords.pageStart;
        const end = coords.pageEnd ?? coords.pageStart;
        if (start == null || end == null) return { ok: true, result: [] };
        const startPh = p.add(start);
        const endPh = p.add(end);
        // Overlap test: unit.page_start <= hit.page_end AND unit.page_end >= hit.page_start.
        targetSql = `page_start IS NOT NULL AND page_end IS NOT NULL AND page_start <= ${endPh} AND page_end >= ${startPh}`;
      }

      const sql = `
        SELECT unit_id, content, page_start, page_end
        FROM "${table}"
        WHERE base_ref = ${baseRefPh}
          AND (${targetSql})${temporalFilter}${accessSql}
        ORDER BY ${DOCUMENT_ORDER_SQL}
      `;

      return withClient(async (client) => {
        const res = await client.query<{
          unit_id: string | null;
          content: string | null;
          page_start: number | null;
          page_end: number | null;
        }>(sql, p.values);
        return res.rows.map((row) => ({
          unit_id: row.unit_id,
          content: row.content ?? "",
          page_start: row.page_start,
          page_end: row.page_end,
        }));
      });
    },

    async resolveDocumentGroups(
      collection: string,
      scope: AccessScope,
      references: string[],
    ): Promise<PostgresResponse<Map<string, DocumentGroup>>> {
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const tenantId = scope.tenantId;
      return withClient((client) =>
        resolveDocumentGroups(client, { tenantId, collection, references }),
      );
    },

    async listThreadMembers(
      collection: string,
      scope: AccessScope,
      threadId: string,
    ): Promise<PostgresResponse<string[]>> {
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const tenantId = scope.tenantId;
      return withClient((client) => groupMemberReferences(client, { tenantId, collection, groupId: threadId }));
    },

    async lookupFigureUnits(
      collection: string,
      scope: AccessScope,
      baseRef: string,
      figureIds: string[],
      options?: { includeAllVersions?: boolean; validAt?: string },
    ): Promise<PostgresResponse<FigureUnitInfo[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const ref = baseRef?.trim();
      const ids = [...new Set(figureIds.filter((id) => typeof id === "string" && id.length > 0))];
      if (!ref || ids.length === 0) return { ok: true, result: [] };

      // Same document + tenant/ACL + temporal/revision-visibility gates as a
      // search, so a referenced figure can never leak a figure the searcher
      // could not have retrieved directly. Match on the `figure_id` mirrored
      // into metadata (the batch worker writes it there for figure units); the
      // metadata GIN index and the base_ref index back the lookup.
      const p = new SqlParams();
      const temporalFilter = buildTemporalFilterSql(
        p,
        table,
        options?.includeAllVersions ?? false,
        options?.validAt,
        "",
        collection,
      );
      const accessSql = buildAccessSql(p, scope);
      const baseRefPh = p.add(ref);
      const idsPh = p.add(ids);
      const sql = `
        SELECT
          content,
          page_start,
          figure_kind,
          metadata->>'figure_id' AS figure_id,
          metadata->>'asset_id'  AS asset_id,
          metadata->'bbox'       AS bbox
        FROM "${table}"
        WHERE base_ref = ${baseRefPh}
          AND metadata->>'figure_id' = ANY(${idsPh}::text[])${temporalFilter}${accessSql}
        ORDER BY page_start ASC NULLS FIRST, id ASC
      `;
      return withClient(async (client) => {
        const res = await client.query<{
          content: string | null;
          page_start: number | null;
          figure_kind: string | null;
          figure_id: string | null;
          asset_id: string | null;
          bbox: unknown;
        }>(sql, p.values);
        // One row per figure id; the ORDER BY makes the first row deterministic
        // if a figure is somehow indexed twice.
        const byFigure = new Map<string, FigureUnitInfo>();
        for (const row of res.rows) {
          if (!row.figure_id || byFigure.has(row.figure_id)) continue;
          const bbox =
            Array.isArray(row.bbox) && row.bbox.length === 4 && row.bbox.every((n) => typeof n === "number")
              ? (row.bbox as [number, number, number, number])
              : null;
          byFigure.set(row.figure_id, {
            figure_id: row.figure_id,
            asset_id: row.asset_id ?? null,
            figure_kind: row.figure_kind ?? null,
            caption: figureCaption(row.content),
            page: row.page_start ?? null,
            bbox,
          });
        }
        return [...byFigure.values()];
      });
    },

    // ── v2 navigation reads (task 3.9) ──────────────────────────────────────
    // These mirror expandUnit/lookupFigureUnits: every read is gated by the
    // SAME buildTemporalFilterSql (current-revision pointer) + buildAccessSql
    // (tenant/ACL) predicates as search, and scoped to one document by base_ref
    // or document_id (or, for find_identifier, joined to a visible unit), so a
    // navigation call can never surface a unit the caller could not retrieve.

    async getOutline(
      collection: string,
      scope: AccessScope,
      reference: string,
      options?: NavReadOptions & { depth?: number; limit?: number; offset?: number },
    ): Promise<PostgresResponse<{ entries: OutlineEntry[]; total: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const ref = normalizeReference(reference);
      const depth = options?.depth != null && options.depth > 0 ? options.depth : null;
      const limit = clampInt(options?.limit, 200, 1, 2000);
      const offset = clampInt(options?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p,
          table,
          options?.includeAllVersions ?? false,
          options?.validAt,
          "",
          collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        const depthClause =
          depth !== null
            ? ` AND COALESCE(array_length(section_path, 1), 0) <= ${p.add(depth)}`
            : "";
        const where = `base_ref = ${refPh} AND unit_type = 'section'${depthClause}${temporalFilter}${accessSql}`;
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM "${table}" WHERE ${where}`,
          p.values,
        );
        const total = Number(countRes.rows[0]?.n ?? "0");
        const limitPh = p.add(limit);
        const offsetPh = p.add(offset);
        const res = await client.query<{
          unit_id: string | null;
          section_id: string | null;
          section_path: string[] | null;
          page_start: number | null;
          page_end: number | null;
        }>(
          `SELECT unit_id, section_id, section_path, page_start, page_end
             FROM "${table}"
            WHERE ${where}
            ORDER BY page_start ASC NULLS FIRST, section_path ASC NULLS FIRST, id ASC
            LIMIT ${limitPh} OFFSET ${offsetPh}`,
          p.values,
        );
        const entries: OutlineEntry[] = res.rows.map((row) => {
          const path = Array.isArray(row.section_path) ? row.section_path : [];
          return {
            unit_id: row.unit_id ?? "",
            section_id: row.section_id,
            section_path: path,
            depth: path.length,
            heading: path.at(-1) ?? row.section_id ?? "",
            // Section units carry a sentinel page range; expose null instead of 0.
            page_start: row.page_start && row.page_start > 0 ? row.page_start : null,
            page_end: row.page_end && row.page_end > 0 ? row.page_end : null,
          };
        });
        return { entries, total };
      });
    },

    async getSectionUnits(
      collection: string,
      scope: AccessScope,
      reference: string,
      selector: { sectionId?: string; sectionPath?: string[] },
      options?: NavReadOptions,
    ): Promise<PostgresResponse<NavUnitRow[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const ref = normalizeReference(reference);
      const sectionId = selector.sectionId?.trim();
      const sectionPath = selector.sectionPath?.filter((s) => typeof s === "string" && s.length > 0);
      if (!sectionId && (!sectionPath || sectionPath.length === 0)) {
        return { ok: true, result: [] };
      }
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p, table, options?.includeAllVersions ?? false, options?.validAt, "", collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        // Prefer the explicit section id; else match a section-path PREFIX so a
        // caller can pass "4 Wareneingang" and get every unit under it.
        let targetSql: string;
        if (sectionId) {
          targetSql = `section_id = ${p.add(sectionId)}`;
        } else {
          const pathPh = p.add(sectionPath as string[]);
          targetSql = `section_path IS NOT NULL AND section_path[1:${(sectionPath as string[]).length}] = ${pathPh}::text[]`;
        }
        const res = await client.query<NavRowShape>(
          `${NAV_ROW_SELECT}
             FROM "${table}"
            WHERE base_ref = ${refPh} AND (${targetSql})${temporalFilter}${accessSql}
            ORDER BY ${DOCUMENT_ORDER_SQL}
            LIMIT ${NAV_MAX_UNITS}`,
          p.values,
        );
        return res.rows.map(navRow);
      });
    },

    async getPageUnits(
      collection: string,
      scope: AccessScope,
      reference: string,
      from: number,
      to: number,
      options?: NavReadOptions,
    ): Promise<PostgresResponse<NavUnitRow[]>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const start = Math.max(1, Math.min(from, to));
      const end = Math.max(from, to);
      const ref = normalizeReference(reference);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p, table, options?.includeAllVersions ?? false, options?.validAt, "", collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        const startPh = p.add(start);
        const endPh = p.add(end);
        // Overlap test, and exclude the section-unit sentinel (page 0). page/
        // chunk/table/figure units carry real page ranges.
        const res = await client.query<NavRowShape>(
          `${NAV_ROW_SELECT}
             FROM "${table}"
            WHERE base_ref = ${refPh}
              AND page_start IS NOT NULL AND page_end IS NOT NULL
              AND page_start > 0 AND page_end > 0
              AND page_start <= ${endPh} AND page_end >= ${startPh}${temporalFilter}${accessSql}
            ORDER BY ${DOCUMENT_ORDER_SQL}
            LIMIT ${NAV_MAX_UNITS}`,
          p.values,
        );
        return res.rows.map(navRow);
      });
    },

    async getContextUnits(
      collection: string,
      scope: AccessScope,
      unitId: string,
      before: number,
      after: number,
      options?: NavReadOptions,
    ): Promise<PostgresResponse<{ before: NavUnitRow[]; unit: NavUnitRow | null; after: NavUnitRow[] }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const target = unitId?.trim();
      if (!target) return { ok: true, result: { before: [], unit: null, after: [] } };
      const beforeN = clampInt(before, 1, 0, 50);
      const afterN = clampInt(after, 1, 0, 50);
      return withClient(async (client) => {
        // Resolve the target under the visibility gates, and walk its prev/next
        // graph within the same document. Each hop re-checks visibility, so a
        // neighbour the caller cannot see terminates the walk (never leaks).
        const load = async (id: string): Promise<(NavUnitRow & { prev_unit_id: string | null; next_unit_id: string | null }) | null> => {
          const p = new SqlParams();
          const temporalFilter = buildTemporalFilterSql(
            p, table, options?.includeAllVersions ?? false, options?.validAt, "", collection,
          );
          const accessSql = buildAccessSql(p, scope);
          const idPh = p.add(id);
          const res = await client.query<NavRowShape & { prev_unit_id: string | null; next_unit_id: string | null }>(
            `${NAV_ROW_SELECT}, prev_unit_id, next_unit_id
               FROM "${table}"
              WHERE unit_id = ${idPh}${temporalFilter}${accessSql}
              LIMIT 1`,
            p.values,
          );
          const row = res.rows[0];
          if (!row) return null;
          return { ...navRow(row), prev_unit_id: row.prev_unit_id, next_unit_id: row.next_unit_id };
        };
        const center = await load(target);
        if (!center) return { before: [], unit: null, after: [] };
        const beforeRows: NavUnitRow[] = [];
        let cursor: string | null = center.prev_unit_id;
        for (let i = 0; i < beforeN && cursor; i++) {
          const row = await load(cursor);
          if (!row) break;
          beforeRows.push(stripLinks(row));
          cursor = row.prev_unit_id;
        }
        beforeRows.reverse();
        const afterRows: NavUnitRow[] = [];
        cursor = center.next_unit_id;
        for (let i = 0; i < afterN && cursor; i++) {
          const row = await load(cursor);
          if (!row) break;
          afterRows.push(stripLinks(row));
          cursor = row.next_unit_id;
        }
        return { before: beforeRows, unit: stripLinks(center), after: afterRows };
      });
    },

    async listFigureUnits(
      collection: string,
      scope: AccessScope,
      reference: string,
      options?: NavReadOptions & { fromPage?: number; toPage?: number; kind?: string; limit?: number; offset?: number },
    ): Promise<PostgresResponse<{ figures: FigureUnitInfo[]; total: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const ref = normalizeReference(reference);
      const limit = clampInt(options?.limit, 50, 1, 500);
      const offset = clampInt(options?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p, table, options?.includeAllVersions ?? false, options?.validAt, "", collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const refPh = p.add(ref);
        let rangeSql = "";
        if (options?.fromPage != null && options?.toPage != null) {
          const from = Math.max(1, Math.min(options.fromPage, options.toPage));
          const to = Math.max(options.fromPage, options.toPage);
          rangeSql = ` AND page_start IS NOT NULL AND page_start >= ${p.add(from)} AND page_start <= ${p.add(to)}`;
        }
        // An alias (`process`, `drawing`, …) covers the stored kinds it names.
        const kindValue = options?.kind?.trim() ?? "";
        const kindSql =
          kindValue !== ""
            ? ` AND figure_kind = ANY(${p.add([...new Set([kindValue, ...(resolveFigureKinds(kindValue) ?? [])])])}::text[])`
            : "";
        const where = `base_ref = ${refPh} AND unit_type = 'figure'${rangeSql}${kindSql}${temporalFilter}${accessSql}`;
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM "${table}" WHERE ${where}`,
          p.values,
        );
        const total = Number(countRes.rows[0]?.n ?? "0");
        const limitPh = p.add(limit);
        const offsetPh = p.add(offset);
        const res = await client.query<{
          content: string | null;
          page_start: number | null;
          figure_kind: string | null;
          figure_id: string | null;
          asset_id: string | null;
          bbox: unknown;
        }>(
          `SELECT content, page_start, figure_kind,
                  metadata->>'figure_id' AS figure_id,
                  metadata->>'asset_id'  AS asset_id,
                  metadata->'bbox'       AS bbox
             FROM "${table}"
            WHERE ${where}
            ORDER BY page_start ASC NULLS FIRST, id ASC
            LIMIT ${limitPh} OFFSET ${offsetPh}`,
          p.values,
        );
        const figures: FigureUnitInfo[] = res.rows
          .filter((row) => row.figure_id)
          .map((row) => {
            const bbox =
              Array.isArray(row.bbox) && row.bbox.length === 4 && row.bbox.every((n) => typeof n === "number")
                ? (row.bbox as [number, number, number, number])
                : null;
            return {
              figure_id: row.figure_id as string,
              asset_id: row.asset_id ?? null,
              figure_kind: row.figure_kind ?? null,
              caption: figureCaption(row.content),
              page: row.page_start ?? null,
              bbox,
            };
          });
        return { figures, total };
      });
    },

    async getTableUnits(
      collection: string,
      scope: AccessScope,
      tableId: string,
      options?: NavReadOptions & { limit?: number },
    ): Promise<PostgresResponse<{ units: NavUnitRow[]; total: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const id = tableId?.trim();
      if (!id) return { ok: true, result: { units: [], total: 0 } };
      const limit = clampInt(options?.limit, 200, 1, 2000);
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p, table, options?.includeAllVersions ?? false, options?.validAt, "", collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const idPh = p.add(id);
        const where = `table_id = ${idPh}${temporalFilter}${accessSql}`;
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM "${table}" WHERE ${where}`,
          p.values,
        );
        const total = Number(countRes.rows[0]?.n ?? "0");
        const limitPh = p.add(limit);
        const res = await client.query<NavRowShape>(
          `${NAV_ROW_SELECT}
             FROM "${table}"
            WHERE ${where}
            ORDER BY ${DOCUMENT_ORDER_SQL}
            LIMIT ${limitPh}`,
          p.values,
        );
        return { units: res.rows.map(navRow), total };
      });
    },

    async getUnitById(
      collection: string,
      scope: AccessScope,
      unitId: string,
      options?: NavReadOptions,
    ): Promise<PostgresResponse<NavUnitRow | null>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const id = unitId?.trim();
      if (!id) return { ok: true, result: null };
      return withClient(async (client) => {
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p, table, options?.includeAllVersions ?? false, options?.validAt, "", collection,
        );
        const accessSql = buildAccessSql(p, scope);
        const idPh = p.add(id);
        const res = await client.query<NavRowShape & { base_ref: string; figure_refs: string[] | null }>(
          `${NAV_ROW_SELECT}, base_ref, figure_refs
             FROM "${table}"
            WHERE unit_id = ${idPh}${temporalFilter}${accessSql}
            LIMIT 1`,
          p.values,
        );
        const row = res.rows[0];
        if (!row) return null;
        const unit = navRow(row);
        // Surface figure_refs (figure ids the unit references) on the metadata
        // mirror so follow_ref can resolve them via lookupFigureUnits.
        if (Array.isArray(row.figure_refs) && row.figure_refs.length > 0) {
          unit.metadata = { ...unit.metadata, base_ref: row.base_ref, figure_refs: row.figure_refs };
        } else {
          unit.metadata = { ...unit.metadata, base_ref: row.base_ref };
        }
        return unit;
      });
    },

    async lookupRevisionSourceSha256(
      collection: string,
      tenantId: string,
      revisionId: string,
    ): Promise<PostgresResponse<string | null>> {
      const tenant = tenantId.trim();
      if (tenant === "" || revisionId.trim() === "") return { ok: true, result: null };
      return withClient(async (client) => {
        // Only the HEAD of each staged payload is read: `document.begin` is the
        // first record of the NDJSON stream, so a bounded prefix is enough and a
        // multi-MB page batch is never pulled into memory. The join to
        // vs_revisions pins the batch to a revision that still exists for this
        // tenant + collection.
        const res = await client.query<{ head: Buffer | null }>(
          `SELECT substring(b.payload FROM 1 FOR $4) AS head
             FROM vs_ingest_batches b
             JOIN vs_revisions r
               ON r.tenant_id = b.tenant_id
              AND r.collection = b.collection
              AND r.revision_id = b.revision_id
            WHERE b.tenant_id = $1 AND b.collection = $2 AND b.revision_id = $3
              AND b.payload IS NOT NULL
            ORDER BY b.seq ASC
            LIMIT $5`,
          [tenant, collection, revisionId, SOURCE_HEAD_BYTES, SOURCE_HEAD_MAX_BATCHES],
        );
        for (const row of res.rows) {
          const sha = sourceSha256FromPayloadHead(row.head);
          if (sha !== null) return sha;
        }
        return null;
      });
    },

    async findIdentifierOccurrences(
      collection: string,
      scope: AccessScope,
      valueNorm: string,
      options?: NavReadOptions & { limit?: number; offset?: number; pathPrefix?: string },
    ): Promise<PostgresResponse<{ occurrences: IdentifierOccurrence[]; total: number }>> {
      const table = collectionTableName(collection);
      if (!scope.tenantId?.trim()) {
        return { ok: false, error: { code: "POSTGRES_INVALID_RESPONSE", message: "TENANT_REQUIRED" } };
      }
      const norm = valueNorm?.trim();
      if (!norm) return { ok: true, result: { occurrences: [], total: 0 } };
      const limit = clampInt(options?.limit, 50, 1, 500);
      const offset = clampInt(options?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return withClient(async (client) => {
        // Join vs_identifiers to the collection table on unit_id, gated by the
        // per-unit visibility predicates so an occurrence surfaces only when its
        // unit is visible to the caller in the current revision.
        const p = new SqlParams();
        const temporalFilter = buildTemporalFilterSql(
          p, table, options?.includeAllVersions ?? false, options?.validAt, "d", collection,
        );
        const access = buildAccessSql(p, scope, "d");
        const tenantPh = p.add(scope.tenantId);
        const collPh = p.add(collection);
        const normPh = p.add(norm);
        // A folder scope (a project) keeps occurrences from other folders out.
        const prefix = normalizePathPrefix(options?.pathPrefix);
        const prefixSql = prefix === "" ? "" : ` AND d.base_ref LIKE ${p.add(escapeLikeLiteral(prefix) + "/%")} ESCAPE '\\'`;
        const where =
          `i.tenant_id = ${tenantPh} AND i.collection = ${collPh} AND i.value_norm = ${normPh}` +
          ` AND d.tenant_id = i.tenant_id AND d.unit_id = i.unit_id${prefixSql}${temporalFilter}${access}`;
        const countRes = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n
             FROM vs_identifiers i JOIN "${table}" d ON d.unit_id = i.unit_id
            WHERE ${where}`,
          p.values,
        );
        const total = Number(countRes.rows[0]?.n ?? "0");
        const limitPh = p.add(limit);
        const offsetPh = p.add(offset);
        const res = await client.query<{
          value_norm: string;
          unit_id: string;
          page: number | null;
          kind: string | null;
          reference: string;
          base_ref: string;
          section_path: string[] | null;
          content: string | null;
        }>(
          `SELECT i.value_norm, i.unit_id, i.page, i.kind,
                  d.reference, d.base_ref, d.section_path, d.content
             FROM vs_identifiers i JOIN "${table}" d ON d.unit_id = i.unit_id
            WHERE ${where}
            ORDER BY d.base_ref ASC, i.page ASC, d.id ASC
            LIMIT ${limitPh} OFFSET ${offsetPh}`,
          p.values,
        );
        const occurrences: IdentifierOccurrence[] = res.rows.map((row) => ({
          value_norm: row.value_norm,
          unit_id: row.unit_id,
          page: row.page ?? null,
          kind: row.kind ?? null,
          reference: row.reference,
          base_ref: row.base_ref,
          section_path: Array.isArray(row.section_path) ? row.section_path : [],
          excerpt: navExcerpt(row.content),
        }));
        return { occurrences, total };
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
          if (reference && scope.tenantId) {
            // A deleted document must not linger as a revision pointer, a source
            // a re-ingest would be a "duplicate" of, or a thread member.
            await forgetDocument(client, {
              tenantId: scope.tenantId,
              collection,
              reference: normalizeReference(reference),
            });
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
                  point.validFrom ?? null,
                );
                const extraBase = params.length; // 14 fixed params pushed
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
                return `($${n}, $${n + 1}, TRUE, $${n + 2}, $${n + 3}::${vecType}, to_tsvector('${lang}', $${ftsIdx}), $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, $${n + 9}, $${n + 10}, $${n + 11}, $${n + 12}, $${n + 13}::timestamptz, NOW()${sparsePh}${binaryPh}, $${tenantIdx})`;
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
            // Version mode. A private group id binds every chunk/chapter row of
            // one ingest revision, so as-of selection never returns half a version
            // and equal valid_from values can still be broken by created/id.
            const versionGroups = new Map<string, string>();
            points = points.map((point) => {
              const root = point.chunk?.root_document_id ?? point.baseRef ?? point.reference;
              let group = versionGroups.get(root);
              if (!group) {
                group = uuidv4();
                versionGroups.set(root, group);
              }
              return { ...point, metadata: { ...point.metadata, _atf_version_group: group } };
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
                params.push(point.tenantId);
                const tenantIdx = params.length;
                const n = base + 1;
                const sparsePh = sql.sparseVal(extraBase);
                const binaryPh = sql.binaryVal(
                  extraBase + (meta.sparseEnabled ? 1 : 0),
                );
                return `($${n}, $${n + 1}, TRUE, $${n + 2}, $${n + 3}::${vecType}, to_tsvector('${lang}', $${ftsIdx}), $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7}, $${n + 8}, $${n + 9}, $${n + 10}, $${n + 11}, $${n + 12}, $${n + 13}::timestamptz${sparsePh}${binaryPh}, $${tenantIdx})`;
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
        const resolveAccess = versionedWhere(table, collection, scope, [reference], options?.validAt);
        const resolve = await client.query<{ base_ref: string }>(
          `SELECT base_ref FROM "${table}"
            WHERE (base_ref = $1 OR reference = $1)${resolveAccess.sql}
            LIMIT 1`,
          resolveAccess.params,
        );
        if (resolve.rows.length === 0) return null;
        const baseRef = resolve.rows[0]!.base_ref;
        const chunkAccess = versionedWhere(table, collection, scope, [baseRef], options?.validAt);

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
          rows.map((r) => (r.unit_type != null ? { ...r, content: documentBodyText(r) } : r)),
        );
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
          const unit = coordinate.item;
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
            ...(unit.unit_id ? { unit_id: unit.unit_id } : {}),
            ...(unit.unit_type ? { unit_type: unit.unit_type } : {}),
            ...(chunk?.page_start !== undefined
              ? { page_start: chunk.page_start }
              : unit.page_start != null ? { page_start: unit.page_start } : {}),
            ...(chunk?.page_end !== undefined
              ? { page_end: chunk.page_end }
              : unit.page_end != null ? { page_end: unit.page_end } : {}),
            ...(chunk?.section_path
              ? { section_path: chunk.section_path }
              : unit.section_path && unit.section_path.length > 0 ? { section_path: unit.section_path } : {}),
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
      options?: { pathPrefix?: string; limit?: number; maxChars?: number; validAt?: string },
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
        const access = versionedWhere(table, collection, scope, prefixParams, options?.validAt);
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
        const chunkAccess = versionedWhere(table, collection, scope, [baseRefs], options?.validAt);
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
        const resolveAccess = versionedWhere(table, collection, scope, [reference], options?.validAt);
        const resolve = await client.query<{ base_ref: string }>(
          `SELECT base_ref FROM "${table}"
            WHERE (base_ref = $1 OR reference = $1)${resolveAccess.sql}
            LIMIT 1`,
          resolveAccess.params,
        );
        if (resolve.rows.length === 0) return null;
        const baseRef = resolve.rows[0]!.base_ref;
        const summaryAccess = versionedWhere(table, collection, scope, [baseRef], options?.validAt);

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
      options?: { pathPrefix?: string; limit?: number; offset?: number; validAt?: string },
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

        const access = versionedWhere(table, collection, scope, prefixParams, options?.validAt);
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
