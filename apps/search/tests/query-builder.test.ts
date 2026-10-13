// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * query-builder.ts — SQL construction, ACL predicates and pagination.
 *
 * This module was previously at 0% coverage while containing two silent
 * correctness bugs in pagination. The tests below are written to pin the
 * *behaviour that was wrong*, so a regression is caught rather than rediscovered
 * months later from a "search misses documents" report:
 *
 *   1. A keyset cursor filtered on `(created, id)` while the query ordered by
 *      relevance, dropping highly-ranked older documents from page 2 onward.
 *   2. The first-stage candidate pool was sized from `limit` alone, so any
 *      offset beyond the pool returned an empty page instead of the next hits.
 *
 * The assertions deliberately inspect the generated SQL and parameter list.
 * That is coupling to an implementation detail, but the alternative — asserting
 * only on results from a live database — is exactly what let both bugs through:
 * each produced a *plausible* result set.
 */

import { afterEach, describe, expect, it } from "vitest";
import { setDocumentAclDefault } from "../src/acl-default.js";
import {
  SqlParams,
  buildDenseQuery,
  buildBinaryDenseQuery,
  buildFtsQuery,
  buildHybridQuery,
  candidatePoolSize,
  CursorNotSupportedError,
  AccessScopeRequiredError,
  buildAccessSql,
  type LexicalRanker,
} from "../src/query-builder.js";
import type { SearchCursor, SearchFilter } from "../src/postgres-client.js";
import { operatorScope, type AccessScope } from "../src/access-scope.js";
import { UNIT_FILTER_V2, type UnitFilterV2 } from "../src/metadata.js";

const aclScope = (userId: string | undefined, userGroups: string[]): AccessScope => ({
  principal: { userId, userGroups, tenantId: "tenant-a", source: "jwt" },
  userId,
  userGroups,
  tenantId: "tenant-a",
  scopes: [],
  service: false,
});

/** Tenant-bound service scope: buildAccessSql returns only the tenant predicate. */
const serviceScope: AccessScope = {
  principal: { userId: undefined, userGroups: undefined, tenantId: "tenant-a", source: "service" },
  userId: undefined,
  userGroups: [],
  tenantId: "tenant-a",
  scopes: [],
  service: true,
};

const TABLE = "documents";
const VEC_TYPE = "vector(768)";
const VECTOR_JSON = "[0.1,0.2,0.3]";

/** Collapse whitespace so SQL assertions are not formatting-sensitive. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const rankedCursor: SearchCursor = {
  created: "2026-01-15T10:00:00.000Z",
  id: "42",
  score: 0.83,
};

const legacyCursor: SearchCursor = {
  created: "2026-01-15T10:00:00.000Z",
  id: "42",
};

// ---------------------------------------------------------------------------
// SqlParams
// ---------------------------------------------------------------------------

describe("SqlParams", () => {
  it("assigns sequential placeholders and collects values in order", () => {
    const p = new SqlParams();
    expect(p.add("a")).toBe("$1");
    expect(p.add(2)).toBe("$2");
    expect(p.add(null)).toBe("$3");
    expect(p.values).toEqual(["a", 2, null]);
  });
});

describe("ACL SQL", () => {
  it("keeps tenant isolation but omits row ACLs for an authorization bypass", () => {
    const params = new SqlParams();
    const sql = buildAccessSql(params, {
      principal: {
        userId: "alice",
        userGroups: ["legal"],
        tenantId: "tenant-a",
        source: "jwt",
        authorizationBypass: true,
      },
      userId: "alice",
      userGroups: ["legal"],
      tenantId: "tenant-a",
      scopes: [],
      service: false,
      authorizationBypass: true,
    });

    expect(sql).toContain("tenant_id = $1");
    expect(sql).not.toContain("allowed_users");
    expect(sql).not.toContain("allowed_groups");
    expect(params.values).toEqual(["tenant-a"]);
  });

  it("includes public rows and isolates two users and their groups", () => {
    const alice = new SqlParams();
    const aliceSql = buildAccessSql(alice, {
      principal: {
        userId: "alice",
        userGroups: ["legal"],
        tenantId: "tenant-a",
        source: "jwt",
      },
      userId: "alice",
      userGroups: ["legal"],
      tenantId: "tenant-a",
      service: false,
    });
    const bob = new SqlParams();
    const _bobSql = buildAccessSql(bob, {
      principal: {
        userId: "bob",
        userGroups: ["finance"],
        tenantId: "tenant-b",
        source: "jwt",
      },
      userId: "bob",
      userGroups: ["finance"],
      tenantId: "tenant-b",
      service: false,
    });
    expect(aliceSql).toContain("cardinality(allowed_users)");
    expect(aliceSql).toContain("allowed_users @>");
    expect(aliceSql).toContain("allowed_groups &&");
    expect(alice.values).toEqual(["tenant-a", "alice", ["legal"]]);
    expect(bob.values).toEqual(["tenant-b", "bob", ["finance"]]);
    expect(alice.values).not.toEqual(bob.values);
  });

  /**
   * Req 3.2: DOCUMENT_ACL_DEFAULT=deny removes the empty-ACL (public rows)
   * disjunct for end users — only service/bypass principals (handled above)
   * still see such rows.
   */
  describe("DOCUMENT_ACL_DEFAULT=deny", () => {
    afterEach(() => setDocumentAclDefault("allow"));

    it("drops the public-rows disjunct but keeps explicit user/group matches", () => {
      setDocumentAclDefault("deny");
      const params = new SqlParams();
      const sql = buildAccessSql(params, aclScope("alice", ["staff"]));
      expect(sql).toContain("tenant_id = $1");
      expect(sql).not.toContain("cardinality(allowed_users)");
      expect(sql).toContain("allowed_users @>");
      expect(sql).toContain("allowed_groups &&");
      expect(params.values).toEqual(["tenant-a", "alice", ["staff"]]);
    });

    it("fails closed for an end-user scope without any identity", () => {
      setDocumentAclDefault("deny");
      const params = new SqlParams();
      const sql = buildAccessSql(params, aclScope(undefined, []));
      expect(sql).toContain("tenant_id = $1");
      expect(sql).toContain("AND FALSE");
      expect(sql).not.toContain("AND ()");
      expect(params.values).toEqual(["tenant-a"]);
    });

    it("still lets service principals through untouched", () => {
      setDocumentAclDefault("deny");
      const params = new SqlParams();
      const sql = buildAccessSql(params, serviceScope);
      expect(sql).toBe(" AND tenant_id = $1");
      expect(sql).not.toContain("FALSE");
    });
  });
});

// ---------------------------------------------------------------------------
// candidatePoolSize
// ---------------------------------------------------------------------------

describe("candidatePoolSize", () => {
  it("scales with limit when there is no offset", () => {
    expect(candidatePoolSize(10, 0, 4, 4000)).toBe(40);
  });

  /**
   * The regression: with the old `limit * multiplier` formula this was 40, so a
   * page at offset 50 fell entirely outside the pool and came back empty.
   */
  it("includes the offset so a deep page is still reachable", () => {
    const pool = candidatePoolSize(10, 50, 4, 4000);
    expect(pool).toBeGreaterThan(60);
    expect(pool).toBe(240); // (10 + 50) * 4
  });

  it("honours a minimum multiplier of 4 even when a smaller one is configured", () => {
    expect(candidatePoolSize(10, 0, 1, 4000)).toBe(40);
  });

  it("respects the hard cap so a pathological offset cannot scan the table", () => {
    expect(candidatePoolSize(10, 1_000_000, 4, 4000)).toBe(4000);
  });

  it("never returns zero for a zero limit", () => {
    expect(candidatePoolSize(0, 0, 4, 4000)).toBeGreaterThan(0);
  });

  it("treats a negative offset as zero rather than shrinking the pool", () => {
    expect(candidatePoolSize(10, -100, 4, 4000)).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Dense query
// ---------------------------------------------------------------------------

describe("buildDenseQuery", () => {
  it("orders by similarity with a deterministic tie-break", () => {
    const { sql } = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      false,
      0,
      VECTOR_JSON,
      serviceScope,
    );
    // Sorts by the RAW distance ASC (mathematically identical to
    // vector_similarity DESC) so the planner can use the HNSW index —
    // the similarity expression is not index-order-compatible.
    expect(flat(sql)).toContain(
      `ORDER BY (vector <=> $1::${VEC_TYPE}) ASC, id ASC`,
    );
    expect(flat(sql)).toContain(
      `1 - (vector <=> $1::${VEC_TYPE}) AS vector_similarity`,
    );
  });

  it("restricts to the latest version unless all versions are requested", () => {
    const latest = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      false,
      0,
      VECTOR_JSON,
      serviceScope,
    );
    expect(latest.sql).toContain("is_latest = TRUE");
    const all = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      true,
      0,
      VECTOR_JSON,
      serviceScope,
    );
    expect(all.sql).not.toContain("is_latest = TRUE");
  });

  it("parameterises the metadata filter instead of interpolating it", () => {
    const { sql, params } = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      { tenant: "acme" },
      false,
      0,
      VECTOR_JSON,
      serviceScope,
    );
    expect(sql).toContain("metadata @>");
    expect(params).toContain(JSON.stringify({ tenant: "acme" }));
    // The value must never appear inline in the SQL text.
    expect(sql).not.toContain("acme");
  });

  it("omits the filter clause entirely for an empty filter object", () => {
    const { sql } = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      {},
      false,
      0,
      VECTOR_JSON,
      serviceScope,
    );
    expect(sql).not.toContain("metadata @>");
  });

  describe("row-level ACL predicate", () => {
    it("is absent for a service context (no identity)", () => {
      const { sql } = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        serviceScope,
      );
      expect(sql).not.toContain("allowed_users @>");
      expect(sql).not.toContain("allowed_groups");
      // The tenant predicate still applies — a service scope is tenant-bound.
      expect(sql).toContain("tenant_id =");
    });

    it("matches the user against allowed_users", () => {
      const { sql, params } = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        aclScope("alice", []),
      );
      expect(sql).toContain("allowed_users @>");
      expect(params).toContain("alice");
    });

    it("ORs user and group membership rather than requiring both", () => {
      const { sql } = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        aclScope("alice", ["staff", "legal"]),
      );
      const f = flat(sql);
      expect(f).toContain("allowed_users @>");
      expect(f).toContain("allowed_groups &&");
      expect(f).toContain("COALESCE(cardinality(allowed_users), 0) = 0");
      expect(f).toMatch(
        /allowed_users @> ARRAY\[\$\d+\]::text\[\] OR allowed_groups && \$\d+::text\[\]/,
      );
    });

    it("matches groups alone when only groups are known", () => {
      const { sql, params } = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        aclScope(undefined, ["staff"]),
      );
      expect(sql).toContain("allowed_groups &&");
      expect(sql).not.toContain("allowed_users @>");
      expect(params).toContainEqual(["staff"]);
    });

    it("refuses to build without an explicit scope (Req 3.1)", () => {
      expect(() =>
        buildDenseQuery(
          TABLE,
          VEC_TYPE,
          10,
          undefined,
          false,
          0,
          VECTOR_JSON,
          undefined as unknown as AccessScope,
        ),
      ).toThrow(AccessScopeRequiredError);
      expect(() =>
        buildDenseQuery(
          TABLE,
          VEC_TYPE,
          10,
          undefined,
          false,
          0,
          VECTOR_JSON,
          undefined as unknown as AccessScope,
        ),
      ).toThrow(/ACCESS_SCOPE_REQUIRED/);
    });

    it("drops the tenant predicate only for an explicit cross-tenant operator scope", () => {
      const { sql, params } = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        operatorScope(),
      );
      expect(sql).not.toContain("tenant_id");
      expect(sql).not.toContain("allowed_users");
      expect(params).not.toContain("tenant-a");
      // With a tenant the operator scope is restricted to it again.
      const scoped = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        operatorScope("tenant-x"),
      );
      expect(scoped.sql).toContain("tenant_id =");
      expect(scoped.params).toContain("tenant-x");
    });
  });

  describe("keyset cursor", () => {
    /**
     * The core regression. The predicate must lead with the SCORE, because that
     * is what the ORDER BY leads with. A `created`-only predicate excludes every
     * older document regardless of how relevant it is.
     */
    it("compares the score first, then the numeric id", () => {
      const { sql, params } = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        serviceScope,
        undefined,
        rankedCursor,
      );
      const f = flat(sql);
      // Score comparison present, using the same expression as the ORDER BY.
      // ($2 is the tenant bind of the mandatory scope; the cursor follows at $3/$4.)
      expect(f).toContain("(1 - (vector <=> $1::vector(768))) < $3::float8");
      expect(f).toContain("(1 - (vector <=> $1::vector(768))) = $3::float8");
      // Tie-break on the BIGSERIAL id, compared NUMERICALLY so it matches
      // `ORDER BY ... id ASC` (a text compare would order 10 before 9).
      expect(f).toContain("id > $4::bigint");
      // `created` is deliberately NOT in the predicate: it round-trips through a
      // JS Date at millisecond precision while PostgreSQL stores microseconds,
      // so the boundary row satisfied `created > cursor.created` and came back
      // again on every page. Verified against real pgvector.
      expect(f).not.toContain("timestamptz");
      expect(params[2]).toBe(0.83);
      expect(params[3]).toBe("42");
    });

    it("falls back to (created, id) for a legacy cursor without a score", () => {
      const { sql } = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        serviceScope,
        undefined,
        legacyCursor,
      );
      const where = flat(sql).slice(flat(sql).indexOf("WHERE"));
      expect(where).toContain("created > ");
      // No score comparison in the predicate — a v1 cursor carries no score.
      expect(where).not.toContain("::float8");
    });

    it("adds no cursor predicate when no cursor is given", () => {
      const { sql } = buildDenseQuery(
        TABLE,
        VEC_TYPE,
        10,
        undefined,
        false,
        0,
        VECTOR_JSON,
        serviceScope,
      );
      expect(sql).not.toContain("timestamptz");
    });
  });

  it("escapes the path prefix LIKE pattern so literal % is matched verbatim", () => {
    const { sql, params } = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      false,
      0,
      VECTOR_JSON,
      serviceScope,
      undefined,
      undefined,
      "/Akte 100%/%",
    );
    // (after scope: tags, cursor, then pathLike.)
    expect(sql).toContain("base_ref LIKE");
    expect(sql).toContain("ESCAPE '\\'");
    expect(params).toContain("/Akte 100%/%");
  });

  it("parameterises tags as a text array", () => {
    const { sql, params } = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      false,
      0,
      VECTOR_JSON,
      serviceScope,
      ["urgent"],
    );
    expect(sql).toContain("tags @>");
    expect(params).toContainEqual(["urgent"]);
  });
});

// ---------------------------------------------------------------------------
// Binary-first dense query
// ---------------------------------------------------------------------------

describe("buildBinaryDenseQuery", () => {
  const build = (limit: number, offset: number, cursor?: SearchCursor) =>
    buildBinaryDenseQuery(
      TABLE,
      VEC_TYPE,
      768,
      limit,
      undefined,
      false,
      offset,
      VECTOR_JSON,
      "101010",
      4,
      serviceScope,
      undefined,
      cursor,
    );

  it("sizes the Hamming candidate pool from limit + offset", () => {
    const shallow = build(10, 0);
    const deep = build(10, 100);
    // The pool size is a bound parameter; the deep page must ask for more.
    expect(deep.params).toContain(440); // (10 + 100) * 4
    expect(shallow.params).toContain(40);
  });

  /**
   * The candidate CTE is ordered by Hamming distance, NOT by the final float32
   * similarity. Applying the score cursor there would compare against the wrong
   * ordering, so it must land on the outer query where the sort key lives.
   */
  it("applies the score cursor on the outer query, not the candidate CTE", () => {
    const { sql } = build(10, 0, rankedCursor);
    const candidateCte = sql.slice(sql.indexOf("bin_cands AS"), sql.indexOf("SELECT\n        d.id"));
    expect(candidateCte).not.toContain("float8");
    // ...but the outer query does carry it, qualified with the table alias.
    expect(flat(sql)).toContain("(1 - (d.vector <=> $1::vector(768))) < ");
    expect(flat(sql)).toContain("d.id > ");
  });

  it("orders by similarity with a deterministic tie-break", () => {
    expect(flat(build(10, 0).sql)).toContain(
      "ORDER BY vector_similarity DESC, d.id ASC",
    );
  });

  it("caps the candidate pool at the hard limit", () => {
    const { params } = build(10, 100_000);
    expect(params).toContain(4000);
  });
});

// ---------------------------------------------------------------------------
// FTS-only query
// ---------------------------------------------------------------------------

describe("buildFtsQuery", () => {
  const build = (cursor?: SearchCursor, baseRef?: string) =>
    buildFtsQuery(
      TABLE,
      "german",
      10,
      undefined,
      false,
      0,
      "mietvertrag",
      serviceScope,
      undefined,
      cursor,
      baseRef,
    );
  const buildLexical = (lexical: LexicalRanker) =>
    buildFtsQuery(
      TABLE,
      "german",
      10,
      undefined,
      false,
      0,
      "mietvertrag",
      serviceScope,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lexical,
    );

  /**
   * The FTS query previously had NO secondary sort key at all, so two documents
   * with an equal ts_rank could come back in either order between calls — which
   * makes any pagination unstable regardless of the cursor predicate.
   */
  it("adds a deterministic tie-break to the relevance ordering", () => {
    expect(flat(build().sql)).toContain("ORDER BY text_score DESC, id ASC");
  });

  it("uses the ts_rank_cd expression in the cursor predicate", () => {
    const f = flat(build(rankedCursor).sql);
    // $2 is the tenant bind of the mandatory scope; the cursor score is $3.
    expect(f).toContain(
      "ts_rank_cd(ts_search, websearch_to_tsquery('german', $1), 32) < $3::float8",
    );
  });

  it("returns only rows that actually match the query", () => {
    expect(build().sql).toContain("ts_search @@ websearch_to_tsquery");
  });

  // FTS_RANKER (task 6.9, Requirement 4.7): the lexical list ranker is
  // configurable; bm25 only with a detected extension, else ts_rank_cd.
  describe("lexical ranker (FTS_RANKER)", () => {
    it("defaults to ts_rank_cd with length normalisation (32)", () => {
      const f = flat(build().sql);
      expect(f).toContain(
        "ts_rank_cd(ts_search, websearch_to_tsquery('german', $1), 32) AS text_score",
      );
      expect(f).toContain("ts_search @@ websearch_to_tsquery('german', $1)");
    });

    it("keeps the legacy ts_rank expression for ranker ts_rank", () => {
      const f = flat(buildLexical({ ranker: "ts_rank", bm25Engine: null }).sql);
      expect(f).toContain(
        "ts_rank(ts_search, websearch_to_tsquery('german', $1)) AS text_score",
      );
      expect(f).not.toContain("ts_rank_cd");
    });

    it("uses paradedb.score and the ||| operator for bm25 via pg_search", () => {
      const f = flat(
        buildLexical({ ranker: "bm25", bm25Engine: "pg_search" }).sql,
      );
      expect(f).toContain("paradedb.score(id) AS text_score");
      expect(f).toContain("content ||| $1");
      expect(f).not.toContain("ts_rank");
    });

    it("uses bm25_score for bm25 via vchord_bm25", () => {
      const f = flat(
        buildLexical({ ranker: "bm25", bm25Engine: "vchord_bm25" }).sql,
      );
      expect(f).toContain("bm25_score(id) AS text_score");
      expect(f).toContain("content ||| $1");
      expect(f).not.toContain("ts_rank");
    });

    it("falls back to ts_rank_cd when bm25 is requested but no extension was detected", () => {
      const f = flat(buildLexical({ ranker: "bm25", bm25Engine: null }).sql);
      expect(f).toContain(
        "ts_rank_cd(ts_search, websearch_to_tsquery('german', $1), 32) AS text_score",
      );
      expect(f).not.toContain("paradedb");
      expect(f).not.toContain("|||");
    });
  });

  describe("base_ref branch", () => {
    it("orders by chunk index for a whole-document fetch", () => {
      const { sql } = build(undefined, "/akten/123");
      expect(flat(sql)).toContain(
        "ORDER BY (chunk->>'chunk_index')::int ASC NULLS FIRST, id ASC",
      );
      expect(sql).not.toContain("ts_rank");
      expect(sql).toContain("valid_from");
      expect(sql).toContain("effective_valid_from");
    });

    it("refuses a cursor, because chunk order has no score to page by", () => {
      expect(() => build(rankedCursor, "/akten/123")).toThrow(
        CursorNotSupportedError,
      );
      expect(() => build(rankedCursor, "/akten/123")).toThrow(/chunk index/);
    });
  });
});

// ---------------------------------------------------------------------------
// Hybrid query
// ---------------------------------------------------------------------------

describe("buildHybridQuery", () => {
  const build = (
    limit: number,
    offset: number,
    cursor?: SearchCursor,
    sparse = false,
    lexical?: LexicalRanker,
  ) =>
    buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "german",
      limit,
      undefined,
      false,
      4,
      offset,
      sparse,
      sparse ? 30000 : null,
      VECTOR_JSON,
      "mietvertrag",
      sparse ? "{1:0.5}" : undefined,
      undefined,
      null,
      serviceScope,
      undefined,
      cursor,
      undefined,
      undefined,
      undefined,
      undefined,
      lexical,
    );

  /**
   * RRF ranks are pool-relative: filtering the pool changes every remaining
   * document's rank. There is no tie-breaker that makes keyset pagination stable
   * here, so refusing is the only correct answer. Previously the cursor was
   * accepted and quietly applied as a pool pre-filter, which reranked the pool
   * on every page.
   */
  it("refuses a cursor outright", () => {
    expect(() => build(10, 0, rankedCursor)).toThrow(CursorNotSupportedError);
    expect(() => build(10, 0, rankedCursor)).toThrow(/candidate pool/);
  });

  it("accepts offset pagination", () => {
    expect(() => build(10, 100)).not.toThrow();
  });

  it("sizes the candidate pool from limit + offset", () => {
    expect(build(10, 0).params).toContain(40);
    expect(build(10, 100).params).toContain(440);
  });

  it("caps the pool at the hybrid hard limit", () => {
    expect(build(10, 100_000).params).toContain(1000);
  });

  it("orders by the fused score with a deterministic tie-break", () => {
    expect(flat(build(10, 0).sql)).toContain(
      "ORDER BY r.rrf_score DESC, d.id ASC",
    );
  });

  it("fuses dense and text ranks with the configured k", () => {
    const f = flat(build(10, 0).sql);
    // Req 4.4 (RRF_MISSING_ZERO default true): a missing list contributes 0,
    // not the legacy 1/(k+1000) pseudo-rank — the NULL rank propagates and the
    // whole term is COALESCEd to 0.
    expect(f).toContain("COALESCE((1.0 / (60 + v.vrank)), 0)");
    expect(f).toContain("COALESCE((1.0 / (60 + t.trank)), 0)");
    expect(f).not.toContain("COALESCE(v.vrank, 1000)");
    expect(f).not.toContain("COALESCE(t.trank, 1000)");
  });

  it("keeps documents found by only one branch (full outer join)", () => {
    expect(build(10, 0).sql).toContain("FULL OUTER JOIN");
  });

  // SQL-Snapshot (task 6.7): pin the exact emitted SQL for the DEFAULT
  // weights (dense+fts and dense+fts+sparse). Any unintended change to the
  // RRF formula — weight rendering, k handling, missing-zero semantics, join
  // shape — now fails loudly here instead of silently shifting ranking in
  // production. The property test (rrf-monotonicity.property.test.ts) covers
  // the numeric behaviour; this snapshot covers the SQL shape.
  it("snapshots the fused-score SQL for the default weights", () => {
    expect(flat(build(10, 0).sql)).toMatchSnapshot();
    expect(flat(build(10, 0, undefined, true).sql)).toMatchSnapshot();
  });

  it("omits the sparse branch when sparse search is off", () => {
    const { sql } = build(10, 0);
    expect(sql).not.toContain("sparse_vector");
    expect(sql).toContain("NULL::float8 AS sparse_score");
  });

  it("adds the sparse branch and its rank contribution when enabled", () => {
    const { sql } = build(10, 0, undefined, true);
    expect(sql).toContain("sparse_vector");
    expect(flat(sql)).toContain("COALESCE((1.0 / (60 + spr.sprrank)), 0)");
  });

  // Req 4.3: the sparse list must FULL OUTER JOIN into the fusion. A LEFT JOIN
  // silently dropped documents found ONLY by sparse — they never got a chance
  // at the fused score. The join key is the id coalesced over the preceding
  // lists (vec, txt).
  it("full-outer-joins the sparse list so sparse-only hits survive (Req 4.3)", () => {
    const { sql } = build(10, 0, undefined, true);
    expect(sql).toContain(
      "FULL OUTER JOIN spr_ranked spr ON spr.id = COALESCE(v.id, t.id)",
    );
    expect(sql).not.toContain("LEFT JOIN spr_ranked");
  });

  // FTS_RANKER (task 6.9, Requirement 4.7): the txt CTE ranks with
  // ts_rank_cd + length normalisation by default; bm25 only with a detected
  // engine. The identifier lexical branch stays ts_rank on ts_ident — it is
  // an identifier list, not the lexical list.
  it("ranks the txt CTE with ts_rank_cd and length normalisation by default", () => {
    const f = flat(build(10, 0).sql);
    expect(f).toContain(
      "ts_rank_cd(ts_search, websearch_to_tsquery('german', $2), 32) AS tscore",
    );
    expect(f).toContain("ts_search @@ websearch_to_tsquery('german', $2)");
  });

  it("ranks the txt CTE with paradedb.score for bm25 via pg_search", () => {
    const f = flat(
      build(10, 0, undefined, false, {
        ranker: "bm25",
        bm25Engine: "pg_search",
      }).sql,
    );
    expect(f).toContain("paradedb.score(id) AS tscore");
    expect(f).toContain("content ||| $2");
  });

  it("falls back to ts_rank_cd in the txt CTE when bm25 has no engine", () => {
    const f = flat(
      build(10, 0, undefined, false, { ranker: "bm25", bm25Engine: null }).sql,
    );
    expect(f).toContain(
      "ts_rank_cd(ts_search, websearch_to_tsquery('german', $2), 32) AS tscore",
    );
    expect(f).not.toContain("paradedb");
  });

  // ── Identifier RRF list (task 3.4, Requirement 12.3) ──────────────────────

  const buildWithOpts = (opts: Parameters<typeof buildHybridQuery>[22]) =>
    buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "german",
      10,
      undefined,
      false,
      4,
      0,
      false,
      null,
      VECTOR_JSON,
      "mietvertrag",
      undefined,
      undefined,
      null,
      serviceScope,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      opts,
    );

  it("emits no identifier branch and bare unit weights at defaults", () => {
    // Regression guard: a no-identifier, default-weight call adds no
    // identifier CTE/join/term and renders no multiplier for weight 1.0. The
    // per-term shape is the Req 4.4 missing-zero form (COALESCE(term, 0)),
    // which is the intentional new default — see the legacy test below for
    // the pre-4.4 form restored via missingZero=false.
    const f = flat(build(10, 0).sql);
    expect(f).toContain("COALESCE((1.0 / (60 + v.vrank)), 0)");
    expect(f).toContain("COALESCE((1.0 / (60 + t.trank)), 0)");
    expect(f).not.toContain("ident_ranked");
    expect(f).not.toContain("COALESCE(v.id, t.id, i.id)");
    // No multiplier is rendered for a weight of 1.0.
    expect(f).not.toMatch(/\d \* \(1\.0 \/ \(60 \+ v\.vrank/);
  });

  it("includes the identifier RRF branch when the query resolved to unit ids", () => {
    const f = flat(
      buildWithOpts({ identifierUnitIds: ["unit-a", "unit-b"] }).sql,
    );
    expect(f).toContain("ident AS (");
    expect(f).toContain("ident_ranked");
    expect(f).toContain("WITH ORDINALITY");
    // Third list fused via FULL OUTER JOIN and its reciprocal-rank term.
    expect(f).toContain("FULL OUTER JOIN ident_ranked i");
    expect(f).toContain("COALESCE((1.0 / (60 + i.identrank)), 0)");
    // Fused key now coalesces all three list ids.
    expect(f).toContain("COALESCE(v.id, t.id, i.id) AS id");
  });

  it("binds the identifier unit ids as a text[] parameter", () => {
    const { params } = buildWithOpts({ identifierUnitIds: ["unit-a", "unit-b"] });
    expect(params).toContainEqual(["unit-a", "unit-b"]);
  });

  it("omits the identifier branch when the unit id list is empty", () => {
    const f = flat(buildWithOpts({ identifierUnitIds: [] }).sql);
    expect(f).not.toContain("ident_ranked");
    expect(f).toContain("COALESCE(v.id, t.id) AS id");
  });

  it("applies the configured per-list weights to the reciprocal-rank terms", () => {
    const f = flat(
      buildWithOpts({
        weightDense: 2,
        weightFts: 0.5,
        weightIdentifier: 3,
        identifierUnitIds: ["unit-a"],
      }).sql,
    );
    expect(f).toContain("COALESCE((2 * (1.0 / (60 + v.vrank))), 0)");
    expect(f).toContain("COALESCE((0.5 * (1.0 / (60 + t.trank))), 0)");
    expect(f).toContain("COALESCE((3 * (1.0 / (60 + i.identrank))), 0)");
  });

  // Req 4.3: the sparse list gets its own configurable weight too.
  it("applies RRF_WEIGHT_SPARSE to the sparse reciprocal-rank term", () => {
    const { sql } = buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "german",
      10,
      undefined,
      false,
      4,
      0,
      true,
      30000,
      VECTOR_JSON,
      "mietvertrag",
      "{1:0.5}",
      undefined,
      null,
      serviceScope,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { weightSparse: 2.5 },
    );
    expect(flat(sql)).toContain(
      "COALESCE((2.5 * (1.0 / (60 + spr.sprrank))), 0)",
    );
  });

  // Req 4.4: the flag must restore the legacy behaviour verbatim when false.
  it("restores the legacy 1/(k+1000) pseudo-rank when missingZero is false", () => {
    const f = flat(
      buildHybridQuery(
        TABLE,
        VEC_TYPE,
        60,
        "german",
        10,
        undefined,
        false,
        4,
        0,
        true,
        30000,
        VECTOR_JSON,
        "mietvertrag",
        "{1:0.5}",
        undefined,
        null,
        serviceScope,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { missingZero: false },
      ).sql,
    );
    expect(f).toContain("(1.0 / (60 + COALESCE(v.vrank, 1000)))");
    expect(f).toContain("(1.0 / (60 + COALESCE(t.trank, 1000)))");
    expect(f).toContain("(1.0 / (60 + COALESCE(spr.sprrank, 1000)))");
    expect(f).not.toContain("COALESCE((1.0 / (60 + v.vrank)), 0)");
  });

  // Req 4.5: weight literals must never reach the SQL in exponential notation
  // (JS toString() switches to 1e-7 below 1e-6).
  it("renders tiny weights as plain decimals, never exponents (Req 4.5)", () => {
    const f = flat(
      buildWithOpts({ weightDense: 1e-7, weightFts: 0.000001 }).sql,
    );
    expect(f).toContain("0.0000001 * (1.0 / (60 + v.vrank))");
    expect(f).toContain("0.000001 * (1.0 / (60 + t.trank))");
    expect(f).not.toMatch(/1e-\d/);
  });

  it("adds the lexical ts_ident branch when an identifier tsquery is given (Req 12.1)", () => {
    const { sql, params } = buildWithOpts({ identifierTsQuery: "'WE01A' | 'DINEN10902'" });
    const f = flat(sql);
    expect(f).toContain("ts_ident @@ to_tsquery('simple', $");
    expect(f).toContain("ts_rank(ts_ident, to_tsquery('simple', $");
    expect(f).toContain("ident_ranked");
    expect(f).toContain("COALESCE(v.id, t.id, i.id) AS id");
    // Lexical-only: no exact unnest branch.
    expect(f).not.toContain("WITH ORDINALITY");
    // The tsquery is a bound parameter, never interpolated.
    expect(params).toContain("'WE01A' | 'DINEN10902'");
    expect(sql).not.toContain("WE01A");
  });
  it("unions exact vs_identifiers hits and ts_ident matches, keeping the best rank", () => {
    const f = flat(
      buildWithOpts({ identifierUnitIds: ["unit-a"], identifierTsQuery: "'WE01A'" }).sql,
    );
    expect(f).toContain("WITH ORDINALITY");
    expect(f).toContain("ts_ident @@ to_tsquery('simple', $");
    expect(f).toContain("UNION ALL");
    expect(f).toContain("MIN(identrank)");
    // One identifier term only, however many sources matched.
    expect(f.match(/60 \+ i\.identrank/g)).toHaveLength(1);
  });
  it("omits the lexical branch for an empty/blank tsquery", () => {
    for (const q of [null, "", "   "]) {
      const f = flat(buildWithOpts({ identifierTsQuery: q }).sql);
      expect(f).not.toContain("ts_ident");
      expect(f).not.toContain("ident_ranked");
    }
  });
  it("drops the weight multiplier when a weight is exactly 1.0 (unchanged ranking)", () => {
    const f = flat(
      buildWithOpts({ weightDense: 1, weightFts: 1, identifierUnitIds: [] }).sql,
    );
    expect(f).toContain("COALESCE((1.0 / (60 + v.vrank)), 0)");
    expect(f).not.toContain("1 * (1.0 / (60 + v.vrank");
  });
});


describe("tenant SQL binding", () => {
  it("binds tenant_id server-side before row ACL conditions", () => {
    const params = new SqlParams();
    const sql = buildAccessSql(params, {
      principal: { userId: "alice", userGroups: [], tenantId: "tenant-a", source: "jwt" },
      userId: "alice", userGroups: [], tenantId: "tenant-a", scopes: ["vectorsearch.read"], service: false,
    });
    expect(sql).toContain("tenant_id = $1");
    expect(params.values).toEqual(["tenant-a", "alice"]);
  });
});


describe("temporal version scope", () => {
  const validAt = "2026-03-01T00:00:00.000Z";

  it("implements the four include_all_versions/valid_at combinations with bind parameters", () => {
    const latest = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      false,
      0,
      VECTOR_JSON,
      serviceScope,
    );
    expect(latest.sql).toContain("is_latest = TRUE");

    const all = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      true,
      0,
      VECTOR_JSON,
      serviceScope,
    );
    expect(all.sql).not.toContain("is_latest = TRUE");
    expect(all.sql).not.toContain('valid_from, "documents".created) <=');

    const allAsOf = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      true,
      0,
      VECTOR_JSON,
      serviceScope,
      undefined,
      undefined,
      undefined,
      validAt,
    );
    expect(allAsOf.sql).toContain(
      'COALESCE("documents".valid_from, "documents".created) <=',
    );
    expect(allAsOf.sql).not.toContain(validAt);
    expect(allAsOf.params).toContain(validAt);

    const oneAsOf = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      false,
      0,
      VECTOR_JSON,
      serviceScope,
      undefined,
      undefined,
      undefined,
      validAt,
    );
    expect(oneAsOf.sql).toContain('FROM "documents" tv');
    expect(oneAsOf.sql).toContain(
      "ORDER BY COALESCE(tv.valid_from, tv.created) DESC, tv.created DESC, tv.id DESC",
    );
    expect(oneAsOf.params.filter((value) => value === validAt)).toHaveLength(1);
  });

  it("applies the same temporal predicate before binary, FTS and hybrid candidate limits", () => {
    const binary = buildBinaryDenseQuery(
      TABLE,
      VEC_TYPE,
      768,
      10,
      undefined,
      false,
      0,
      VECTOR_JSON,
      "01",
      4,
      serviceScope,
      undefined,
      undefined,
      undefined,
      validAt,
    );
    const fts = buildFtsQuery(
      TABLE,
      "simple",
      10,
      undefined,
      false,
      0,
      "query",
      serviceScope,
      undefined,
      undefined,
      undefined,
      undefined,
      validAt,
    );
    const hybrid = buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "simple",
      10,
      undefined,
      false,
      4,
      0,
      false,
      null,
      VECTOR_JSON,
      "query",
      undefined,
      undefined,
      null,
      serviceScope,
      undefined,
      undefined,
      undefined,
      validAt,
    );
    for (const built of [binary, fts, hybrid]) {
      expect(built.sql).toContain("COALESCE(");
      expect(built.sql).toContain("valid_from");
      expect(built.params).toContain(validAt);
    }
  });

  // Requirement 4.6: with validAt/includeAllVersions the temporal visibility
  // is computed once per query as a shared `visible` CTE and reused by every
  // rank list instead of repeating the correlated predicate per list.
  it("computes temporal visibility once as a shared visible CTE for validAt", () => {
    const { sql, params } = buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "simple",
      10,
      undefined,
      false,
      4,
      0,
      false,
      null,
      VECTOR_JSON,
      "query",
      undefined,
      undefined,
      null,
      serviceScope,
      undefined,
      undefined,
      undefined,
      validAt,
    );
    const f = flat(sql);
    // The CTE appears exactly once and carries the temporal predicate.
    expect(f.match(/visible AS \(/g)).toHaveLength(1);
    expect(f).toContain('visible AS ( SELECT id FROM "documents" WHERE TRUE');
    expect(f).toContain(
      'COALESCE("documents".valid_from, "documents".created) <=',
    );
    // Both rank lists (vec, txt) filter through the CTE instead of repeating it.
    expect(f.match(/id IN \(SELECT id FROM visible\)/g)).toHaveLength(2);
    // The correlated version subquery now occurs exactly once (was per list).
    expect(f.match(/FROM "documents" tv/g)).toHaveLength(1);
    // validAt is bound exactly once.
    expect(params.filter((value) => value === validAt)).toHaveLength(1);
  });

  it("reuses the visible CTE in the sparse and identifier lists too", () => {
    const { sql } = buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "simple",
      10,
      undefined,
      false,
      4,
      0,
      true,
      30000,
      VECTOR_JSON,
      "query",
      "{1:0.5}",
      undefined,
      null,
      serviceScope,
      undefined,
      undefined,
      undefined,
      validAt,
      undefined,
      { identifierUnitIds: ["unit-a"] },
    );
    const f = flat(sql);
    expect(f.match(/visible AS \(/g)).toHaveLength(1);
    // dense vec, txt, sparse spr, identifier list all filter via the CTE.
    expect((f.match(/id IN \(SELECT id FROM visible\)/g)?.length ?? 0)).toBeGreaterThanOrEqual(4);
    expect(f).toContain("spr AS ( SELECT id, (sparse_vector <#>");
    expect(f).toContain("WITH ORDINALITY");
  });

  it("uses the visible CTE for includeAllVersions without validAt as well", () => {
    const { sql } = buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "simple",
      10,
      undefined,
      true,
      4,
      0,
      false,
      null,
      VECTOR_JSON,
      "query",
      undefined,
      undefined,
      null,
      serviceScope,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    const f = flat(sql);
    expect(f.match(/visible AS \(/g)).toHaveLength(1);
    expect(f).toContain("id IN (SELECT id FROM visible)");
    // All-versions view: no latest-only gate anywhere.
    expect(f).not.toContain("is_latest = TRUE");
  });

  it("keeps the default latest path inline (no visible CTE) for the partial index", () => {
    const { sql } = buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "simple",
      10,
      undefined,
      false,
      4,
      0,
      false,
      null,
      VECTOR_JSON,
      "query",
      undefined,
      undefined,
      null,
      serviceScope,
    );
    const f = flat(sql);
    expect(f).not.toContain("visible AS (");
    expect(f).not.toContain("id IN (SELECT id FROM visible)");
    // Inline latest gate preserved in every rank list (partial HNSW index).
    expect((f.match(/is_latest = TRUE/g)?.length ?? 0)).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// buildTemporalFilterSql — v2 revision visibility gate (task 1.13)
// ---------------------------------------------------------------------------

describe("buildTemporalFilterSql — revision visibility (task 1.13)", () => {
  it("keeps the plain is_latest gate when no collection is given (legacy call sites)", async () => {
    const { buildTemporalFilterSql } = await import("../src/query-builder.js");
    const p = new SqlParams();
    const sql = buildTemporalFilterSql(p, TABLE, false, undefined);
    expect(flat(sql)).toBe(`AND "${TABLE}".is_latest = TRUE`);
    // No pointer subquery, no extra params.
    expect(sql).not.toContain("vs_document_revisions");
    expect(p.values).toHaveLength(0);
  });

  it("emits the pointer-based predicate when a collection is given", async () => {
    const { buildTemporalFilterSql } = await import("../src/query-builder.js");
    const p = new SqlParams();
    const sql = buildTemporalFilterSql(p, TABLE, false, undefined, "", "my_collection");
    const f = flat(sql);
    // Legacy rows gate on is_latest alone; v2 rows must also match the pointer.
    expect(f).toContain("is_latest = TRUE");
    expect(f).toContain("revision_id IS NULL OR");
    expect(f).toContain("SELECT dr.current_revision_id FROM vs_document_revisions dr");
    expect(f).toContain("dr.reference = ");
    // The collection is bound as a parameter, not interpolated.
    expect(p.values).toContain("my_collection");
  });

  it("does not add a version gate at all when includeAllVersions is set", async () => {
    const { buildTemporalFilterSql } = await import("../src/query-builder.js");
    const p = new SqlParams();
    const sql = buildTemporalFilterSql(p, TABLE, true, undefined, "", "my_collection");
    expect(sql).toBe("");
    expect(p.values).toHaveLength(0);
  });

  it("threads the collection into buildDenseQuery so the pointer filter is applied", () => {
    const { sql, params } = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      undefined,
      false,
      0,
      VECTOR_JSON,
      aclScope("u1", ["g1"]),
      undefined,
      undefined,
      undefined,
      undefined,
      "my_collection",
    );
    expect(flat(sql)).toContain("vs_document_revisions dr");
    expect(sql).toContain("revision_id"); // present in the SELECT list too
    expect(params).toContain("my_collection");
  });
});

// ---------------------------------------------------------------------------
// v2 unit-column filter (task 3.7, Requirement 13.3)
// ---------------------------------------------------------------------------

describe("v2 unit-column filter (UNIT_FILTER_V2)", () => {
  const withUnit = (unit: UnitFilterV2): SearchFilter => {
    const filter: SearchFilter = {};
    (filter as SearchFilter & { [UNIT_FILTER_V2]?: UnitFilterV2 })[UNIT_FILTER_V2] = unit;
    return filter;
  };

  const denseWith = (unit: UnitFilterV2) =>
    buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      withUnit(unit),
      false,
      0,
      VECTOR_JSON,
      serviceScope,
    );

  it("filters unit_type as a parameterised equality on the real column", () => {
    const { sql, params } = denseWith({ unitType: "figure" });
    expect(sql).toContain("unit_type = $");
    expect(params).toContain("figure");
    // The value is never interpolated inline.
    expect(sql).not.toContain("'figure'");
  });

  it("filters figure_kind on the real column", () => {
    const { sql, params } = denseWith({ figureKind: "ui_mask" });
    expect(sql).toMatch(/figure_kind = ANY\(\$\d+::text\[\]\)/);
    expect(params).toContainEqual(["ui_mask"]);
  });

  it("resolves a figure_kind alias to the stored kinds it names", () => {
    const { params } = denseWith({ figureKind: "process" });
    expect(params).toContainEqual(["process", "bpmn", "flowchart"]);
  });

  it("filters a page range as an overlap on page_start/page_end", () => {
    const { sql, params } = denseWith({ pageStart: 37, pageEnd: 38 });
    const f = flat(sql);
    expect(f).toContain("page_start IS NOT NULL AND page_end IS NOT NULL");
    expect(f).toContain("page_start <= $");
    expect(f).toContain("page_end >= $");
    expect(params).toContain(37);
    expect(params).toContain(38);
  });

  it("filters a section_path prefix with an array slice-equality", () => {
    const { sql, params } = denseWith({ sectionPrefix: ["4 Wareneingang", "4.2 Anmeldung"] });
    const f = flat(sql);
    expect(f).toContain("section_path IS NOT NULL");
    expect(f).toContain("array_length(section_path, 1) >= 2");
    expect(f).toContain("section_path[1:2] = $");
    expect(params).toContainEqual(["4 Wareneingang", "4.2 Anmeldung"]);
  });

  it("adds no unit predicate for an empty unit filter", () => {
    const { sql } = denseWith({});
    expect(sql).not.toContain("unit_type = $");
    expect(sql).not.toContain("figure_kind = $");
    expect(sql).not.toContain("section_path[");
  });

  it("applies the unit filter in every hybrid CTE (vec + txt)", () => {
    const { sql } = buildHybridQuery(
      TABLE,
      VEC_TYPE,
      60,
      "german",
      10,
      withUnit({ unitType: "table" }),
      false,
      4,
      0,
      false,
      null,
      VECTOR_JSON,
      "kosten",
      undefined,
      undefined,
      null,
      serviceScope,
    );
    // The predicate must appear in both the dense and the fts candidate CTEs so
    // neither list can smuggle in a filtered-out unit type.
    const occurrences = (flat(sql).match(/unit_type = \$/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("composes with a metadata filter (both predicates present)", () => {
    const filter: SearchFilter = { document_type: "spec" };
    (filter as SearchFilter & { [UNIT_FILTER_V2]?: UnitFilterV2 })[UNIT_FILTER_V2] = {
      unitType: "figure",
    };
    const { sql, params } = buildDenseQuery(
      TABLE,
      VEC_TYPE,
      10,
      filter,
      false,
      0,
      VECTOR_JSON,
      serviceScope,
    );
    expect(sql).toContain("metadata @>");
    expect(sql).toContain("unit_type = $");
    expect(params).toContain("figure");
  });
});
