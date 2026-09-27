// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * query-builder.ts
 *
 * SQL query builders for the three search modes:
 *   - Dense (pure vector cosine similarity)
 *   - Binary-first dense (Hamming ANN → float32 rerank)
 *   - Hybrid (RRF over dense + PostgreSQL FTS/ts_rank + optional SPLADE sparse)
 *
 * Extracted from postgres-client.ts.
 *
 * Sort order
 * ──────────
 * Every ranked mode sorts by **(score DESC, id ASC)**:
 *   - dense / binary-dense: score = `vector_similarity`
 *   - FTS-only:             score = `text_score` (ts_rank)
 *   - hybrid:               score = `rrf_score`
 * `id` (BIGSERIAL) makes ties deterministic, which a keyset cursor requires and
 * which the FTS and hybrid queries previously lacked entirely.
 *
 * Keyset pagination
 * ─────────────────
 * A cursor encodes the sort key `(score, id)` of the last row of the previous
 * page, and the predicate is the lexicographic "strictly after" comparison on
 * that key (see `buildScoreCursorSql`).
 *
 * This is a correctness fix, not a refinement. The cursor used to hold only
 * `(created, id)` while the queries ranked by relevance, so page 2 filtered on
 * `created > cursor.created` and silently DROPPED every highly-ranked document
 * older than the last row of page 1. Pages looked full; hits were simply gone.
 *
 * Two modes refuse a cursor outright rather than pretending
 * (`CursorNotSupportedError`):
 *   - **hybrid (RRF)** — reciprocal-rank fusion scores are pool-relative, so
 *     filtering the candidate pool changes the ranking of everything left in it.
 *     No tie-breaker can make that stable.
 *   - **base_ref fetch** — ordered by chunk index, so there is no score to page.
 * Both are correctly served by limit/offset.
 *
 * Offset pagination
 * ─────────────────
 * For the two-stage modes (binary-dense, hybrid) the first-stage candidate pool
 * is sized from `limit + offset` (`candidatePoolSize`). Sizing it from `limit`
 * alone — as it was — meant any offset beyond the pool returned an EMPTY page
 * instead of the next hits: a silent, premature end of results.
 */

import { resolveFigureKinds } from "./figure-kinds.js";
import type { AccessScope } from "./access-scope.js";
import type { SearchFilter, SearchCursor } from "./postgres-client.js";
import {
  FILTER_V2,
  type FilterV2,
  UNIT_FILTER_V2,
  type UnitFilterV2,
} from "./metadata.js";

// ─── SQL param accumulator ────────────────────────────────────────────────────
// Assigns sequential $N placeholders so query builders never need to track
// indices manually — just call p.add(value) and embed the returned token.

export class SqlParams {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

function temporalRoot(alias: string): string {
  return `COALESCE(${alias}.chunk->>'root_document_id', ${alias}.base_ref)`;
}

/**
 * The key all rows of one version share. A v2 unit has no `version` or
 * `valid_from` of its own, and its `created` differs per unit, so without the
 * revision id every unit would be its own "version" and a `valid_at` read
 * would keep exactly one unit per document.
 */
function temporalVersionKey(alias: string): string {
  return `COALESCE(${alias}.metadata->>'_atf_version_group', ${alias}.revision_id, ${alias}.metadata->>'version', ${alias}.valid_from::text, ${alias}.created::text, regexp_replace(${alias}.reference, '_chunk_[0-9]+$', ''))`;
}

/**
 * A v2 row belongs to a revision that was committed (current or since
 * superseded) — never to one still being ingested or aborted, whose units a
 * `valid_at` read must not see. Legacy rows carry no revision.
 */
function committedRevisionSql(alias: string): string {
  return (
    `(${alias}.revision_id IS NULL OR EXISTS (SELECT 1 FROM vs_revisions vr` +
    ` WHERE vr.tenant_id = ${alias}.tenant_id AND vr.revision_id = ${alias}.revision_id` +
    ` AND vr.status IN ('committed', 'superseded')))`
  );
}

/**
 * Build the same parameterized temporal scope for every retrieval branch.
 *
 * The "latest only" predicate (no `validAt`) is the v2 revision-visibility gate
 * (task 1.13): a row is visible iff
 *   - it is a LEGACY row (revision_id IS NULL) that is is_latest = TRUE — v1
 *     ingest and non-revision data keep working unchanged; OR
 *   - it belongs to the revision the per-document pointer
 *     (`vs_document_revisions`) currently names AND is is_latest = TRUE.
 * The pointer is authoritative, so search never sees two revisions of one
 * document at once (Requirement 6.5). The extra `is_latest = TRUE` gate on the
 * pointer branch is what keeps a `progressive` partial revision visible only for
 * its committed segments (Requirement 6.4): the revision store flips only those
 * rows' is_latest to TRUE. `collection` is required to scope the pointer lookup;
 * when omitted the plain is_latest predicate is used (legacy call sites / tests).
 */
export function buildTemporalFilterSql(
  p: SqlParams,
  table: string,
  includeAllVersions: boolean,
  validAt?: string,
  alias = "",
  collection?: string,
): string {
  const row = alias ? alias : `"${table}"`;
  if (!validAt) {
    if (includeAllVersions) return "";
    if (!collection) return ` AND ${row}.is_latest = TRUE`;
    const collPh = p.add(collection);
    // Legacy rows gate on is_latest alone; v2 rows must additionally match the
    // document's current-revision pointer so two revisions are never both visible.
    return (
      ` AND ${row}.is_latest = TRUE` +
      ` AND (${row}.revision_id IS NULL OR ${row}.revision_id = (` +
      `SELECT dr.current_revision_id FROM vs_document_revisions dr` +
      ` WHERE dr.tenant_id = ${row}.tenant_id AND dr.collection = ${collPh}` +
      ` AND dr.reference = ${row}.document_id))`
    );
  }
  const validAtPh = p.add(validAt);
  const effective = `COALESCE(${row}.valid_from, ${row}.created)`;
  if (includeAllVersions) {
    return ` AND ${effective} <= ${validAtPh}::timestamptz AND ${committedRevisionSql(row)}`;
  }

  return ` AND ${effective} <= ${validAtPh}::timestamptz
    AND ${committedRevisionSql(row)}
    AND ${temporalVersionKey(row)} = (
      SELECT ${temporalVersionKey("tv")}
      FROM "${table}" tv
      WHERE tv.tenant_id = ${row}.tenant_id
        AND ${temporalRoot("tv")} = ${temporalRoot(row)}
        AND COALESCE(tv.valid_from, tv.created) <= ${validAtPh}::timestamptz
        AND ${committedRevisionSql("tv")}
      ORDER BY COALESCE(tv.valid_from, tv.created) DESC, tv.created DESC, tv.id DESC
      LIMIT 1
    )`;
}

// ─── Shared filter helpers ────────────────────────────────────────────────────

function buildFilterSql(
  p: SqlParams,
  filter: SearchFilter | undefined,
): string {
  if (!filter) return "";
  const legacy = Object.fromEntries(Object.entries(filter));
  const filterV2 = (filter as SearchFilter & { [FILTER_V2]?: FilterV2 })[FILTER_V2];
  const unitFilter = (filter as SearchFilter & { [UNIT_FILTER_V2]?: UnitFilterV2 })[UNIT_FILTER_V2];
  const unitSql = buildUnitFilterSql(p, unitFilter);
  if (Object.keys(legacy).length === 0 && !filterV2) return unitSql;
  let sql = Object.keys(legacy).length > 0
    ? ` AND metadata @> ${p.add(JSON.stringify(legacy))}`
    : "";
  if (!filterV2) return sql + unitSql;
  const path = (field: string): string => `{${field}}`;
  for (const [field, value] of Object.entries(filterV2.eq ?? {})) {
    sql += ` AND metadata #> ${p.add(path(field))} = ${p.add(JSON.stringify(value))}::jsonb`;
  }
  for (const [field, values] of Object.entries(filterV2.in ?? {})) {
    const predicates = values.map((value) => `metadata #> ${p.add(path(field))} = ${p.add(JSON.stringify(value))}::jsonb`);
    sql += ` AND (${predicates.join(" OR ")})`;
  }
  for (const [field, bounds] of Object.entries(filterV2.range ?? {})) {
    const textExpr = `metadata #>> ${p.add(path(field))}`;
    for (const [operator, value] of Object.entries(bounds)) {
      const sqlOperator = operator === "gt" ? ">" : operator === "gte" ? ">=" : operator === "lt" ? "<" : "<=";
      const numeric = typeof value === "number";
      sql += numeric
        ? ` AND CASE WHEN (${textExpr}) ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (${textExpr})::numeric ${sqlOperator} ${p.add(value)}::numeric ELSE FALSE END`
        : ` AND (${textExpr}) ${sqlOperator} ${p.add(value)}`;
    }
  }
  return sql + unitSql;
}

/**
 * v2 unit-column filter (task 3.7, Requirement 13.3). Emits index-backed
 * predicates on the REAL unit columns (task 1.8) rather than the metadata JSON:
 *
 *   unit_type    — exact match
 *   figure_kind  — the stored kinds the value names (figure-kinds.ts)
 *   pageStart/End— page-range OVERLAP: a unit whose [page_start, page_end]
 *                  intersects the requested [pageStart, pageEnd]. A one-sided
 *                  bound (only start, or only end) is treated as an open range.
 *   sectionPrefix— `section_path` array-prefix match: the unit's section_path
 *                  begins with the given path (so "4 / 4.2" matches
 *                  "4 / 4.2 / 4.2.1" and "4 / 4.2"). Uses the slice-equality
 *                  `section_path[1:n] = prefix`, which the GIN/array indexes and
 *                  the planner handle; the length guard avoids matching a
 *                  shorter path.
 *
 * Column names are unqualified because every caller (dense/fts/hybrid CTEs and
 * the base-ref branch) evaluates this against the base table with no alias.
 * Inputs are parameterised; nothing here is interpolated.
 */
function buildUnitFilterSql(
  p: SqlParams,
  unit: UnitFilterV2 | undefined,
): string {
  if (!unit) return "";
  let sql = "";
  if (unit.unitType !== undefined) {
    sql += ` AND unit_type = ${p.add(unit.unitType)}`;
  }
  if (unit.figureKind !== undefined) {
    // An alias (`process`, `drawing`, …) covers the stored kinds it names; the
    // raw value stays in the set so an exact stored kind always matches.
    const kinds = [...new Set([unit.figureKind, ...(resolveFigureKinds(unit.figureKind) ?? [])])];
    sql += ` AND figure_kind = ANY(${p.add(kinds)}::text[])`;
  }
  // Page-range overlap. Only units that actually carry a page range participate;
  // a unit with NULL pages never matches a page filter (it has no page to be on).
  if (unit.pageStart !== undefined || unit.pageEnd !== undefined) {
    sql += ` AND page_start IS NOT NULL AND page_end IS NOT NULL`;
    if (unit.pageEnd !== undefined) {
      sql += ` AND page_start <= ${p.add(unit.pageEnd)}`;
    }
    if (unit.pageStart !== undefined) {
      sql += ` AND page_end >= ${p.add(unit.pageStart)}`;
    }
  }
  if (Array.isArray(unit.sectionPrefix) && unit.sectionPrefix.length > 0) {
    // `n` is section_path.length — a trusted small integer computed here, never
    // user text — so it is safe to interpolate as the array-slice upper bound
    // (PostgreSQL does not accept a bind parameter for a slice bound).
    const n = Math.max(1, Math.floor(unit.sectionPrefix.length));
    // section_path is a 1-based TEXT[]; compare its first n elements to the
    // prefix, requiring the path to be at least that long.
    sql +=
      ` AND section_path IS NOT NULL` +
      ` AND array_length(section_path, 1) >= ${n}` +
      ` AND section_path[1:${n}] = ${p.add(unit.sectionPrefix)}::text[]`;
  }
  return sql;
}

/**
 * Restrict results to documents whose `base_ref` matches a folder path.
 * `pathLike` is a ready-to-use LIKE pattern (already normalised and
 * wildcard-escaped by the caller, e.g. `/Unterlagen Teil 1/%`). Uses
 * `ESCAPE '\'` so literal `%`/`_` in folder names are matched verbatim.
 */
function buildPathPrefixSql(
  p: SqlParams,
  pathLike: string | undefined,
): string {
  if (!pathLike) return "";
  return ` AND base_ref LIKE ${p.add(pathLike)} ESCAPE '\\'`;
}

function buildTagsSql(p: SqlParams, tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  return ` AND tags @> ${p.add(tags)}::text[]`;
}

function normalizeBuilderScope(
  scopeOrUserId: AccessScope | string | undefined,
  userGroups: string[] | undefined,
): AccessScope | undefined {
  if (typeof scopeOrUserId !== "string") {
    if (scopeOrUserId) return scopeOrUserId;
    if (!userGroups || userGroups.length === 0) return undefined;
    return {
      principal: { userId: undefined, userGroups, scopes: [], source: "asserted" },
      userId: undefined,
      userGroups,
      tenantId: undefined,
      scopes: [],
      service: false,
    };
  }
  return {
    principal: { userId: scopeOrUserId, userGroups, scopes: [], source: "asserted" },
    userId: scopeOrUserId,
    userGroups: userGroups ?? [],
    tenantId: undefined,
    scopes: [],
    service: false,
  };
}

export function buildAccessSql(
  p: SqlParams,
  scope: AccessScope | undefined,
  tableAlias = "",
): string {
  if (scope === undefined) return "";
  const tenantId = scope.tenantId?.trim();
  if (!tenantId) throw new Error("TENANT_REQUIRED");
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const tenantSql = ` AND ${prefix}tenant_id = ${p.add(tenantId)}`;
  if (scope.authorizationBypass || scope.service) return tenantSql;
  const conds = [
    `(COALESCE(cardinality(${prefix}allowed_users), 0) = 0 AND COALESCE(cardinality(${prefix}allowed_groups), 0) = 0)`,
  ];
  if (scope.userId) {
    conds.push(`${prefix}allowed_users @> ARRAY[${p.add(scope.userId)}]::text[]`);
  }
  if (scope.userGroups.length > 0) {
    conds.push(`${prefix}allowed_groups && ${p.add(scope.userGroups)}::text[]`);
  }
  return `${tenantSql} AND (${conds.join(" OR ")})`;
}

/**
 * Keyset cursor filter for a NON-ranked ordering, i.e. plain
 * `(created ASC, id ASC)`.
 *
 * Only correct when the query's ORDER BY actually leads with `created`. It is
 * kept for legacy v1 cursors (which carry no score) and for the base-ref branch
 * of the FTS query, which is not score-ordered.
 *
 * `created` is immutable (set once at INSERT), so concurrent updates to
 * already-returned rows cannot shift them into or out of the cursor window.
 */
function buildTimeCursorSql(
  p: SqlParams,
  cursor: SearchCursor | undefined,
  tableAlias = "",
): string {
  if (!cursor) return "";
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const crPh = p.add(cursor.created);
  const idPh = p.add(cursor.id);
  // Rows strictly after the cursor: either a later created timestamp,
  // or the same timestamp with a higher id.
  return ` AND (${prefix}created > ${crPh}::timestamptz OR (${prefix}created = ${crPh}::timestamptz AND ${prefix}id::text > ${idPh}))`;
}

/**
 * Keyset cursor filter for a SCORE-ordered query:
 * `ORDER BY <score> DESC, id ASC`.
 *
 * Emits the lexicographic "strictly after" predicate for that composite key:
 *
 *   score < s
 *   OR (score = s AND id > i)
 *
 * `scoreExpr` must be the *same* SQL expression the ORDER BY uses. It has to be
 * repeated rather than referenced by alias, because a SELECT alias is not
 * visible in WHERE.
 *
 * Why the tie-break is `id` and not `created`
 * ───────────────────────────────────────────
 * `created` cannot be compared reliably through this cursor: PostgreSQL stores
 * `timestamptz` at microsecond precision, but the value reaches the client as a
 * JavaScript `Date` (millisecond precision) and goes back as an ISO string. The
 * boundary row therefore satisfies `created > cursor.created` — it is genuinely
 * later than its own truncated timestamp — and gets returned AGAIN on the next
 * page. Verified against real PostgreSQL: paging repeated the last row of every
 * page. The same truncation affected the original `(created, id)` cursor.
 *
 * `id` is BIGSERIAL: unique, immutable, and exact across the wire. It needs no
 * companion key, so the ambiguity disappears rather than being narrowed.
 *
 * Why this replaced a `(created, id)` filter
 * ──────────────────────────────────────────
 * The old filter compared only `created` while the query ranked by relevance.
 * Page 2 therefore excluded every document older than the last row of page 1 —
 * including highly relevant ones. Results were lost silently, with no error and
 * no gap in the returned count, which is why it survived unnoticed.
 *
 * A cursor without a score (legacy v1) falls back to the time-only predicate;
 * the caller decides whether that is acceptable for the mode in question.
 */
function buildScoreCursorSql(
  p: SqlParams,
  cursor: SearchCursor | undefined,
  scoreExpr: string,
  tableAlias = "",
): string {
  if (!cursor) return "";
  if (cursor.score === undefined) {
    return buildTimeCursorSql(p, cursor, tableAlias);
  }
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const scorePh = p.add(cursor.score);
  const idPh = p.add(cursor.id);
  // `id` (BIGSERIAL) is the tie-break, compared NUMERICALLY to match
  // `ORDER BY ... id ASC`. A text comparison would order 10 before 9.
  return (
    ` AND (${scoreExpr} < ${scorePh}::float8` +
    ` OR (${scoreExpr} = ${scorePh}::float8` +
    ` AND ${prefix}id > ${idPh}::bigint))`
  );
}

/**
 * Size the first-stage candidate pool so it can still satisfy the requested
 * window after OFFSET is applied.
 *
 * The pool used to be derived from `limit` alone. With `limit=10, multiplier=4`
 * that is 40 candidates, so `offset=50` returned an EMPTY page rather than the
 * next hits — a silent end-of-results for any deep page. Including the offset in
 * the requirement fixes that; `hardCap` keeps a pathological offset from turning
 * into an unbounded scan.
 */
export function candidatePoolSize(
  limit: number,
  offset: number,
  multiplier: number,
  hardCap: number,
): number {
  const needed = Math.max(1, limit + Math.max(0, offset));
  return Math.min(needed * Math.max(4, multiplier), hardCap);
}

/**
 * Raised when a cursor is supplied for a search mode whose ranking cannot be
 * paginated by keyset.
 */
export class CursorNotSupportedError extends Error {
  constructor(mode: string, reason: string) {
    super(`Keyset cursor pagination is not supported for ${mode}: ${reason}`);
    this.name = "CursorNotSupportedError";
  }
}

// ─── Dense query ──────────────────────────────────────────────────────────────

export function buildDenseQuery(
  table: string,
  vecType: string,
  limit: number,
  filter: SearchFilter | undefined,
  includeAllVersions: boolean,
  offset: number,
  vectorJson: string,
  tags?: string[],
  scopeOrUserId?: AccessScope | string,
  userGroups?: string[],
  cursor?: SearchCursor,
  pathLike?: string,
  validAt?: string,
  collection?: string,
): { sql: string; params: unknown[] } {
  const p = new SqlParams();
  const vecPh = p.add(vectorJson);
  const temporalFilter = buildTemporalFilterSql(p, table, includeAllVersions, validAt, "", collection);
  const filterSql = buildFilterSql(p, filter);
  const pathSql = buildPathPrefixSql(p, pathLike);
  const tagsSql = buildTagsSql(p, tags);
  const accessSql = buildAccessSql(p, normalizeBuilderScope(scopeOrUserId, userGroups));
  // The cursor predicate repeats the similarity expression exactly as the
  // ORDER BY uses it, so the keyset key matches the sort key.
  const scoreExpr = `(1 - (vector <=> ${vecPh}::${vecType}))`;
  const cursorSql = buildScoreCursorSql(p, cursor, scoreExpr);
  const limitPh = p.add(limit);
  const offsetPh = p.add(offset);

  return {
    sql: `
      SELECT
        id::text,
        reference,
        base_ref,
        content,
        prefix,
        metadata,
        chunk,
        source,
        link,
        title,
        tags,
        created,
        modified,
        valid_from,
        revision_id,
        COALESCE(valid_from, created) AS effective_valid_from,
        1 - (vector <=> ${vecPh}::${vecType}) AS vector_similarity,
        NULL::float8                           AS text_score,
        NULL::float8                           AS sparse_score
      FROM "${table}"
      WHERE TRUE${temporalFilter}${filterSql}${pathSql}${tagsSql}${accessSql}${cursorSql}
      ORDER BY vector_similarity DESC, id ASC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    `,
    params: p.values,
  };
}

// ─── Binary-first dense query ─────────────────────────────────────────────────

/**
 * Binary-first dense search: HNSW ANN on bit_vector for fast first-stage
 * recall, then re-ranked by exact float32 cosine similarity.
 */
export function buildBinaryDenseQuery(
  table: string,
  vecType: string,
  vectorSize: number,
  limit: number,
  filter: SearchFilter | undefined,
  includeAllVersions: boolean,
  offset: number,
  vectorJson: string,
  binaryStr: string,
  candidateMultiplier: number,
  tags?: string[],
  scopeOrUserId?: AccessScope | string,
  userGroups?: string[],
  cursor?: SearchCursor,
  pathLike?: string,
  validAt?: string,
  collection?: string,
): { sql: string; params: unknown[] } {
  const p = new SqlParams();
  const vecPh = p.add(vectorJson);
  const binPh = p.add(binaryStr);
  // Pool must cover limit + offset, or a deep page silently comes back empty.
  const candidateLimit = candidatePoolSize(
    limit,
    offset,
    candidateMultiplier,
    4000,
  );
  const candPh = p.add(candidateLimit);
  const temporalFilter = buildTemporalFilterSql(p, table, includeAllVersions, validAt, "", collection);
  const filterSql = buildFilterSql(p, filter);
  const pathSql = buildPathPrefixSql(p, pathLike);
  const tagsSql = buildTagsSql(p, tags);
  const accessSql = buildAccessSql(p, normalizeBuilderScope(scopeOrUserId, userGroups));
  // The candidate CTE is ordered by Hamming distance, not by the final float32
  // similarity, so the cursor cannot be applied there. It is applied on the
  // outer, similarity-ordered query where the sort key actually lives.
  const outerCursorSql = buildScoreCursorSql(
    p,
    cursor,
    `(1 - (d.vector <=> ${vecPh}::${vecType}))`,
    "d",
  );
  const limitPh = p.add(limit);
  const offsetPh = p.add(offset);

  return {
    sql: `
      WITH bin_cands AS (
        SELECT id
        FROM "${table}"
        WHERE TRUE${temporalFilter}${filterSql}${pathSql}${tagsSql}${accessSql}
          AND bit_vector IS NOT NULL
        ORDER BY bit_vector <~> ${binPh}::bit(${vectorSize})
        LIMIT ${candPh}
      )
      SELECT
        d.id::text,
        d.reference,
        d.base_ref,
        d.content,
        d.prefix,
        d.metadata,
        d.chunk,
        d.source,
        d.link,
        d.title,
        d.tags,
        d.created,
        d.modified,
        d.valid_from,
        d.revision_id,
        COALESCE(d.valid_from, d.created) AS effective_valid_from,
        1 - (d.vector <=> ${vecPh}::${vecType}) AS vector_similarity,
        NULL::float8                             AS text_score,
        NULL::float8                             AS sparse_score
      FROM "${table}" d
      WHERE d.id IN (SELECT id FROM bin_cands)${outerCursorSql}
      ORDER BY vector_similarity DESC, d.id ASC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    `,
    params: p.values,
  };
}

// ─── FTS-only query ───────────────────────────────────────────────────────────

/**
 * Pure full-text search: ranks by ts_rank only, no vector involved.
 * Returns only documents that actually match the FTS query (no vector fallback).
 */
export function buildFtsQuery(
  table: string,
  language: string,
  limit: number,
  filter: SearchFilter | undefined,
  includeAllVersions: boolean,
  offset: number,
  queryText: string,
  tags?: string[],
  scopeOrUserId?: AccessScope | string,
  userGroups?: string[],
  cursor?: SearchCursor,
  baseRef?: string,
  pathLike?: string,
  validAt?: string,
  collection?: string,
): { sql: string; params: unknown[] } {
  // ── baseRef-only branch: skip FTS entirely, filter by base_ref column directly ──
  // Uses a fresh SqlParams so $1 is never an untyped query-text parameter.
  if (baseRef) {
    const p2 = new SqlParams();
    const temporalFilter2 = buildTemporalFilterSql(p2, table, includeAllVersions, validAt, "", collection);
    const filterSql2 = buildFilterSql(p2, filter);
    const pathSql2 = buildPathPrefixSql(p2, pathLike);
    const tagsSql2 = buildTagsSql(p2, tags);
    const accessSql2 = buildAccessSql(p2, normalizeBuilderScope(scopeOrUserId, userGroups));
    const baseRefPh = p2.add(baseRef);
    // This branch orders by chunk_index, not by relevance, so a keyset cursor
    // over (score, created, id) is meaningless here. Offset pagination is the
    // correct mechanism and is what the branch already uses.
    if (cursor) {
      throw new CursorNotSupportedError(
        "a base_ref (whole-document) fetch",
        "results are ordered by chunk index, not by relevance, so there is no " +
          "score to page by. Use limit/offset.",
      );
    }
    const limitPh2 = p2.add(limit);
    const offsetPh2 = p2.add(offset);
    return {
      sql: `
        SELECT
          id::text,
          reference,
          base_ref,
          content,
          prefix,
          metadata,
          chunk,
          source,
          link,
          title,
          tags,
          created,
          modified,
          valid_from,
          revision_id,
          COALESCE(valid_from, created) AS effective_valid_from,
          NULL::float8 AS vector_similarity,
          1.0::float8  AS text_score,
          NULL::float8 AS sparse_score
        FROM "${table}"
        WHERE TRUE${temporalFilter2}${filterSql2}${pathSql2}${tagsSql2}${accessSql2}
          AND base_ref = ${baseRefPh}
        ORDER BY (chunk->>'chunk_index')::int ASC NULLS FIRST, id ASC
        LIMIT ${limitPh2} OFFSET ${offsetPh2}
      `,
      params: p2.values,
    };
  }

  const p = new SqlParams();
  const queryPh = p.add(queryText);
  const temporalFilter = buildTemporalFilterSql(p, table, includeAllVersions, validAt, "", collection);
  const filterSql = buildFilterSql(p, filter);
  const pathSql = buildPathPrefixSql(p, pathLike);
  const tagsSql = buildTagsSql(p, tags);
  const accessSql = buildAccessSql(p, normalizeBuilderScope(scopeOrUserId, userGroups));
  const rankExpr = `ts_rank(ts_search, websearch_to_tsquery('${language}', ${queryPh}))`;
  const cursorSql = buildScoreCursorSql(p, cursor, rankExpr);
  const limitPh = p.add(limit);
  const offsetPh = p.add(offset);

  // language is validated via ALLOWED_FTS_LANGUAGES; interpolation intentional.
  return {
    sql: `
      SELECT
        id::text,
        reference,
        base_ref,
        content,
        prefix,
        metadata,
        chunk,
        source,
        link,
        title,
        tags,
        created,
        modified,
        valid_from,
        revision_id,
        COALESCE(valid_from, created) AS effective_valid_from,
        NULL::float8                                                          AS vector_similarity,
        ts_rank(ts_search, websearch_to_tsquery('${language}', ${queryPh}))  AS text_score,
        NULL::float8                                                          AS sparse_score
      FROM "${table}"
      WHERE TRUE${temporalFilter}${filterSql}${pathSql}${tagsSql}${accessSql}${cursorSql}
        AND ts_search @@ websearch_to_tsquery('${language}', ${queryPh})
      ORDER BY text_score DESC, id ASC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    `,
    params: p.values,
  };
}

/**
 * Configurable per-list RRF weights and the optional identifier list (task 3.4,
 * Requirement 12.3).
 *
 * `weightDense`/`weightFts`/`weightIdentifier` scale each list's
 * `1/(rrfK + rank)` reciprocal-rank contribution; all default to 1.0 so an
 * unweighted call ranks EXACTLY as before. `identifierUnitIds` are the unit ids
 * the query's recognised identifier(s) resolved to (an exact lookup against
 * `vs_identifiers`); when non-empty they form a THIRD ranked list fused into the
 * RRF. When empty/omitted the identifier branch is not emitted at all, so a
 * query with no identifier produces the same SQL as before.
 */
export interface HybridRrfOptions {
  weightDense?: number;
  weightFts?: number;
  weightIdentifier?: number;
  /** Unit ids matched by the query's identifiers, in exact-match (best-first) order. */
  identifierUnitIds?: string[];
  /**
   * Lexical identifier match (Requirement 12.1): a `to_tsquery('simple', …)`
   * text (see `buildIdentifierTsQuery` in identifier.ts) matched against the
   * unit's `ts_ident` vector. When set, rows whose `ts_ident @@ tsquery` join
   * the identifier list alongside the `vs_identifiers` exact hits; a row found
   * by both keeps its BEST (lowest) rank — i.e. the union with max reciprocal
   * rank. Omitted/empty → no lexical branch.
   */
  identifierTsQuery?: string | null;
}

/** Hybrid search: RRF over dense + full-text + optional SPLADE sparse + optional identifier list. */
export function buildHybridQuery(
  table: string,
  vecType: string,
  rrfK: number,
  language: string,
  limit: number,
  filter: SearchFilter | undefined,
  includeAllVersions: boolean,
  candidateMultiplier: number,
  offset: number,
  sparseEnabled: boolean,
  sparseVocabSize: number | null,
  vectorJson: string,
  queryText: string,
  sparseJson: string | undefined,
  binaryStr: string | undefined,
  binaryDim: number | null,
  tags?: string[],
  scopeOrUserId?: AccessScope | string,
  userGroups?: string[],
  cursor?: SearchCursor,
  pathLike?: string,
  validAt?: string,
  collection?: string,
  rrfOptions?: HybridRrfOptions,
): { sql: string; params: unknown[] } {
  // RRF ranks are POOL-RELATIVE: a document's rrf_score depends on which other
  // documents are in the candidate set. Filtering the pool by a cursor changes
  // every remaining document's rank, so a keyset cursor cannot produce a stable
  // page sequence here — no amount of tie-breaking fixes that. Refusing is the
  // honest answer; offset pagination over a pool sized for limit+offset is
  // correct and is what this builder now does.
  if (cursor) {
    throw new CursorNotSupportedError(
      "hybrid (RRF) search",
      "reciprocal-rank fusion scores depend on the candidate pool, so filtering " +
        "the pool by a cursor changes the ranking of the remaining documents. " +
        "Use limit/offset for hybrid search.",
    );
  }

  const p = new SqlParams();
  const vecPh = p.add(vectorJson);
  const queryPh = p.add(queryText);
  // Pool must cover limit + offset, or a deep page silently comes back empty.
  const candidateLimit = candidatePoolSize(
    limit,
    offset,
    candidateMultiplier,
    1000,
  );
  const candPh = p.add(candidateLimit);

  const sparsePh = sparseEnabled && sparseJson ? p.add(sparseJson) : null;

  let binPh: string | null = null;
  let binCandPh: string | null = null;
  if (binaryStr && binaryDim) {
    binPh = p.add(binaryStr);
    binCandPh = p.add(Math.min(candidateLimit * 4, 4000));
  }


  const filterSql = buildFilterSql(p, filter);
  const pathSql = buildPathPrefixSql(p, pathLike);
  const tagsSql = buildTagsSql(p, tags);
  const accessSql = buildAccessSql(p, normalizeBuilderScope(scopeOrUserId, userGroups));
  const extraSql = pathSql + tagsSql + accessSql;

  const limitPh = p.add(limit);
  const offsetPh = p.add(offset);
  const temporalFilter = buildTemporalFilterSql(p, table, includeAllVersions, validAt, "", collection);

  // Per-list RRF weights (task 3.4, Req 12.3). Defaults are 1.0, which makes the
  // weighted terms identical to the previous unweighted ones — a no-identifier,
  // default-weight call is byte-for-byte the same ranking as before. The weights
  // are numeric config (not user input); sanitise to a finite positive float and
  // render as a literal because they multiply an interpolated arithmetic term.
  const weightLit = (w: number | undefined, fallback = 1.0): string => {
    const v = typeof w === "number" && Number.isFinite(w) && w > 0 ? w : fallback;
    // A plain decimal literal; no exponent/NaN/Infinity can reach the SQL.
    return v.toString();
  };
  const wDense = weightLit(rrfOptions?.weightDense);
  const wFts = weightLit(rrfOptions?.weightFts);
  const wIdent = weightLit(rrfOptions?.weightIdentifier);

  // Render a weighted reciprocal-rank term. When the weight is exactly 1.0 the
  // multiplier is omitted so a default-weight call emits the identical SQL text
  // it did before this change (regression guard) — `1 * x` and `x` rank the same
  // but only the bare form is byte-for-byte unchanged.
  const rrfTerm = (weight: string, rankExpr: string): string =>
    weight === "1" ? `(1.0 / (${rankExpr}))` : `(${weight} * (1.0 / (${rankExpr})))`;

  // Identifier list (Req 12.3): only when the query resolved to at least one
  // unit id. Empty/omitted → no ident CTE, no join, no term, so the emitted SQL
  // is exactly the previous dense+fts(+sparse) query. The unit ids arrive in
  // best-first order; we carry that order as the exact-match rank.
  const identUnitIds = rrfOptions?.identifierUnitIds ?? [];
  const identTsQuery =
    typeof rrfOptions?.identifierTsQuery === "string" && rrfOptions.identifierTsQuery.trim() !== ""
      ? rrfOptions.identifierTsQuery
      : null;
  const hasExactIdent = identUnitIds.length > 0;
  const hasLexIdent = identTsQuery !== null;
  const hasIdent = hasExactIdent || hasLexIdent;
  const identPh = hasExactIdent ? p.add(identUnitIds) : null;
  const identTsPh = hasLexIdent ? p.add(identTsQuery) : null;

  // language is validated via ALLOWED_FTS_LANGUAGES; PostgreSQL does not support
  // regconfig as a bind parameter, so string interpolation is intentional here.
  const sparseCTE =
    sparseEnabled && sparseVocabSize && sparsePh
      ? `
    spr AS (
      SELECT id, (sparse_vector <#> ${sparsePh}::sparsevec(${sparseVocabSize})) * -1 AS sprscore
      FROM "${table}"
      WHERE TRUE${temporalFilter}${filterSql}${extraSql}
        AND sparse_vector IS NOT NULL
      ORDER BY sparse_vector <#> ${sparsePh}::sparsevec(${sparseVocabSize})
      LIMIT ${candPh}
    ),
    spr_ranked AS (
      SELECT id, sprscore, ROW_NUMBER() OVER (ORDER BY sprscore DESC) AS sprrank
      FROM spr
    ),`
      : "";

  // The fused key is the coalesce of every participating list's id. Sparse and
  // identifier both LEFT JOIN onto it, so their key must include the ident id
  // when the ident branch is present.
  const fusedId = hasIdent ? `COALESCE(v.id, t.id, i.id)` : `COALESCE(v.id, t.id)`;
  const sprJoin = sparsePh
    ? `\n        LEFT JOIN spr_ranked spr ON spr.id = ${fusedId}`
    : "";
  const sprRrf = sparsePh
    ? `+ (1.0 / (${rrfK} + COALESCE(spr.sprrank, 1000)))`
    : "";
  const sprScore = sparsePh
    ? `COALESCE(spr.sprscore, 0) AS sparse_score,`
    : `NULL::float8 AS sparse_score,`;

  // ── Identifier list (Req 12.3) ──────────────────────────────────────────────
  // Resolve the matched unit ids to row ids through the SAME visibility/ACL/
  // filter predicates the other lists use, so an identifier hit can never leak a
  // row a dense/fts hit would be denied. The exact-match rank is the position in
  // the caller-supplied ordered array (WITH ORDINALITY), so the best exact match
  // gets rank 1 and the strongest reciprocal-rank contribution.
  //
  // The lexical branch (Req 12.1) matches `ts_ident` (the `simple`-config
  // identifier vector written at ingest) against the normalized query
  // identifiers, ranked by ts_rank and bounded by the same candidate pool size
  // as the other lists. It is UNION-ed with the exact branch and each row keeps
  // its best (MIN) rank, so an identifier found by either source contributes
  // one reciprocal-rank term — never two.
  //
  // The exact branch joins the collection table WITHOUT an alias: the shared
  // temporal/visibility filter qualifies columns with the table name, which an
  // alias would hide ("invalid reference to FROM-clause entry"). The unnest
  // column is named `ident_unit_id` so an unqualified `unit_id` in the shared
  // filters stays unambiguous.
  const identExactSelect = hasExactIdent
    ? `
      SELECT "${table}".id, u.ord AS identrank
      FROM unnest(${identPh}::text[]) WITH ORDINALITY AS u(ident_unit_id, ord)
      JOIN "${table}" ON "${table}".unit_id = u.ident_unit_id
      WHERE TRUE${temporalFilter}${filterSql}${extraSql}`
    : "";
  const identLexSelect = hasLexIdent
    ? `
      SELECT id, ROW_NUMBER() OVER (ORDER BY lscore DESC, id ASC) AS identrank
      FROM (
        SELECT id, ts_rank(ts_ident, to_tsquery('simple', ${identTsPh})) AS lscore
        FROM "${table}"
        WHERE TRUE${temporalFilter}${filterSql}${extraSql}
          AND ts_ident @@ to_tsquery('simple', ${identTsPh})
        ORDER BY lscore DESC, id ASC
        LIMIT ${candPh}
      ) ident_lex`
    : "";
  const identUnion = [identExactSelect, identLexSelect]
    .filter((s) => s !== "")
    .join("\n      UNION ALL");
  const identCTE = hasIdent
    ? `
    ident AS (${identUnion}
    ),
    ident_ranked AS (
      SELECT id, MIN(identrank) AS identrank
      FROM ident
      GROUP BY id
    ),`
    : "";
  const identJoin = hasIdent
    ? `\n        FULL OUTER JOIN ident_ranked i ON i.id = COALESCE(v.id, t.id)`
    : "";
  const identRrf = hasIdent
    ? `+ ${rrfTerm(wIdent, `${rrfK} + COALESCE(i.identrank, 1000)`)}`
    : "";

  const binCTE =
    binPh && binaryDim
      ? `
    bin_pre AS (
      SELECT id FROM "${table}"
      WHERE TRUE${temporalFilter}${filterSql}${extraSql}
        AND bit_vector IS NOT NULL
      ORDER BY bit_vector <~> ${binPh}::bit(${binaryDim})
      LIMIT ${binCandPh}
    ),`
      : "";
  const vecIdFilter = binPh ? " AND id IN (SELECT id FROM bin_pre)" : "";

  return {
    sql: `
      WITH
      ${binCTE}
      vec AS (
        SELECT id, 1 - (vector <=> ${vecPh}::${vecType}) AS vscore
        FROM "${table}"
        WHERE TRUE${temporalFilter}${filterSql}${extraSql}${vecIdFilter}
        ORDER BY vector <=> ${vecPh}::${vecType}
        LIMIT ${candPh}
      ),
      txt AS (
        SELECT id, ts_rank(ts_search, websearch_to_tsquery('${language}', ${queryPh})) AS tscore
        FROM "${table}"
        WHERE TRUE${temporalFilter}${filterSql}${extraSql}
          AND ts_search @@ websearch_to_tsquery('${language}', ${queryPh})
        ORDER BY tscore DESC
        LIMIT ${candPh}
      ),
      ${sparseCTE}
      ${identCTE}
      vec_ranked AS (
        SELECT id, vscore, ROW_NUMBER() OVER (ORDER BY vscore DESC) AS vrank
        FROM vec
      ),
      txt_ranked AS (
        SELECT id, tscore, ROW_NUMBER() OVER (ORDER BY tscore DESC) AS trank
        FROM txt
      ),
      rrf AS (
        SELECT
          ${fusedId} AS id,
          COALESCE(v.vscore, 0) AS vector_similarity,
          COALESCE(t.tscore, 0) AS text_score,
          ${sprScore}
          ${rrfTerm(wDense, `${rrfK} + COALESCE(v.vrank, 1000)`)} +
          ${rrfTerm(wFts, `${rrfK} + COALESCE(t.trank, 1000)`)}
          ${sprRrf}
          ${identRrf} AS rrf_score
        FROM vec_ranked v
        FULL OUTER JOIN txt_ranked t ON v.id = t.id
        ${identJoin}
        ${sprJoin}
      )
      SELECT
        d.id::text,
        d.reference,
        d.base_ref,
        d.content,
        d.prefix,
        d.metadata,
        d.chunk,
        d.source,
        d.link,
        d.title,
        d.tags,
        d.created,
        d.modified,
        d.valid_from,
        d.revision_id,
        COALESCE(d.valid_from, d.created) AS effective_valid_from,
        r.vector_similarity,
        r.text_score,
        r.sparse_score,
        r.rrf_score
      FROM rrf r
      JOIN "${table}" d ON d.id = r.id
      ORDER BY r.rrf_score DESC, d.id ASC
      LIMIT ${limitPh} OFFSET ${offsetPh}
    `,
    params: p.values,
  };
}
