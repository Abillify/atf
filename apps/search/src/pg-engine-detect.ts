// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pg-engine-detect.ts
 *
 * BM25 extension detection (Req 4.7) and the pgvector iterative-scan version
 * gate (Req 4.2), extracted verbatim from postgres-client.ts (Requirement
 * 13.6). The cached verdicts live in this closure — one instance per
 * PostgresClient, exactly as before the split.
 */

import type pino from "pino";
import type { Pool, PoolClient } from "pg";
import type { Bm25EngineName } from "./query-builder.js";
import type { HnswIterativeScanMode } from "./pg-types.js";
import { pgvectorVersionAtLeast } from "./pg-helpers.js";

export interface EngineDetection {
  detectBm25Engine(
    exec?: Pick<PoolClient, "query">,
    table?: string,
  ): Promise<Bm25EngineName | null>;
  checkPgvectorVersion(
    exec?: Pick<PoolClient, "query">,
  ): Promise<boolean | null>;
  effectiveIterativeScan(
    client: PoolClient,
  ): Promise<HnswIterativeScanMode>;
}

export function createEngineDetection(deps: {
  pool: Pool;
  logger: pino.Logger;
  hnswIterativeScan: HnswIterativeScanMode;
}): EngineDetection {
  const { pool, logger, hnswIterativeScan } = deps;

  // ── BM25 extension detection (Req 4.7, task 6.9) ─────────────────────────
  // FTS_RANKER=bm25 is honoured only when a BM25 extension is actually
  // installed: ParadeDB `pg_search` (preferred) or VectorChord-bm25.
  // Detected once per process, lazily on the first search that needs the
  // lexical ranker. `undefined` = not checked yet; a result (including
  // `null` = none installed) is cached — these extensions are never created
  // by this service, so a restart is required after installing one anyway.
  // When bm25 was requested but no extension exists, a single warning is
  // logged and queries keep the `ts_rank_cd` default (fail-safe).
  let bm25Engine: Bm25EngineName | null | undefined;
  let bm25FallbackWarned = false;

  async function detectBm25EngineByExtension(
    exec?: Pick<PoolClient, "query">,
  ): Promise<Bm25EngineName | null> {
    if (bm25Engine !== undefined) return bm25Engine;
    try {
      const res = await (exec ?? pool).query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('pg_search', 'vchord_bm25')",
      );
      const installed = new Set(res.rows.map((r) => r.extname));
      bm25Engine = installed.has("pg_search")
        ? "pg_search"
        : installed.has("vchord_bm25")
          ? "vchord_bm25"
          : null;
    } catch (err) {
      // Fail safe: an unreadable extension list means no BM25, never a
      // broken query — ts_rank_cd works on every PostgreSQL.
      bm25Engine = null;
      logger.warn({ err }, "BM25 extension detection failed");
    }
    if (bm25Engine === null && !bm25FallbackWarned) {
      bm25FallbackWarned = true;
      logger.warn(
        "FTS_RANKER=bm25 requested but neither pg_search nor vchord_bm25 is installed; falling back to ts_rank_cd",
      );
    }
    return bm25Engine;
  }
  // An installed extension is not enough: `content ||| q` / `bm25_score(id)`
  // only work against a `USING bm25` index on the collection table, which
  // this service never creates. Without it every lexical query would fail
  // instead of falling back, so the engine counts as usable for a table only
  // when such an index exists. A positive answer is cached for the process; a
  // negative one for a minute, so creating the index takes effect without a
  // restart.
  const BM25_INDEX_RECHECK_MS = 60_000;
  const bm25IndexByTable = new Map<string, { present: boolean; checkedAt: number }>();
  const bm25IndexWarned = new Set<string>();
  async function hasBm25Index(
    table: string,
    exec?: Pick<PoolClient, "query">,
  ): Promise<boolean> {
    const known = bm25IndexByTable.get(table);
    if (
      known !== undefined &&
      (known.present || Date.now() - known.checkedAt < BM25_INDEX_RECHECK_MS)
    ) {
      return known.present;
    }
    let present = false;
    try {
      const res = await (exec ?? pool).query(
        `SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema() AND tablename = $1
            AND indexdef ~* 'USING bm25'
          LIMIT 1`,
        [table],
      );
      present = (res.rows?.length ?? 0) > 0;
    } catch (err) {
      logger.warn({ err, table }, "BM25 index detection failed");
    }
    bm25IndexByTable.set(table, { present, checkedAt: Date.now() });
    return present;
  }
  async function detectBm25Engine(
    exec?: Pick<PoolClient, "query">,
    table?: string,
  ): Promise<Bm25EngineName | null> {
    const engine = await detectBm25EngineByExtension(exec);
    if (engine === null || table === undefined) {
      if (engine !== null) {
        logger.info({ engine }, "BM25 lexical ranking enabled");
      }
      return engine;
    }
    if (await hasBm25Index(table, exec)) return engine;
    if (!bm25IndexWarned.has(table)) {
      bm25IndexWarned.add(table);
      logger.warn(
        { engine, table },
        "FTS_RANKER=bm25 requested and the extension is installed, but the collection table has no `USING bm25` index; falling back to ts_rank_cd for it",
      );
    }
    return null;
  }

  // ── pgvector version gate (Req 4.2) ───────────────────────────────────────
  // `hnsw.iterative_scan` / `hnsw.max_scan_tuples` exist only from pgvector
  // 0.8. Checked once per process — lazily on the first dense search, or
  // eagerly at startup via the exported ensurePgvectorVersion() on the
  // client. A version < 0.8 forces iterative scans off (setting the GUC
  // would abort every query) and logs a single warning.
  // `null` = not checked yet, `true`/`false` = cached verdict.
  let pgvectorSupportsIterativeScan: boolean | null = null;

  /**
   * Read `extversion` of the installed `vector` extension once (on the given
   * connection, defaulting to the pool) and cache whether it supports
   * iterative HNSW scans (≥ 0.8). Never throws: an unreadable version is
   * treated as unsupported — plain scans work on every version, so this
   * fails safe. Returns null when the extension is not installed yet (fresh
   * database; the first ensureCollection creates it) so the verdict stays
   * uncached and the next call re-checks.
   */
  async function checkPgvectorVersion(
    exec?: Pick<PoolClient, "query">,
  ): Promise<boolean | null> {
    if (pgvectorSupportsIterativeScan !== null)
      return pgvectorSupportsIterativeScan;
    try {
      const res = await (exec ?? pool).query<{ extversion: string | null }>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      const version = res.rows[0]?.extversion ?? null;
      if (version === null) {
        logger.debug(
          "pgvector extension not installed yet; deferring iterative-scan version check",
        );
        return null;
      }
      pgvectorSupportsIterativeScan = pgvectorVersionAtLeast(version, 0, 8);
      if (!pgvectorSupportsIterativeScan) {
        logger.warn(
          { version },
          "pgvector < 0.8: hnsw.iterative_scan is unavailable; iterative scans disabled (selective filters may return fewer than `limit` hits)",
        );
      }
      return pgvectorSupportsIterativeScan;
    } catch (err) {
      pgvectorSupportsIterativeScan = false;
      logger.warn(
        { err },
        "pgvector version check failed; disabling iterative scans",
      );
      return false;
    }
  }

  /**
   * Effective iterative-scan mode for a dense/binary search: the configured
   * mode, or `off` when pgvector is too old (Req 4.2). Runs the version
   * check on the current transaction's connection on first use only.
   */
  async function effectiveIterativeScan(
    client: PoolClient,
  ): Promise<HnswIterativeScanMode> {
    if (hnswIterativeScan === "off") return "off";
    if (pgvectorSupportsIterativeScan === null) {
      const supported = await checkPgvectorVersion(client);
      // Extension not installed yet (fresh database): the verdict stays
      // uncached and this search optimistically uses the configured mode —
      // pgvector is created together with the first collection, so a search
      // that reaches an HNSW index almost certainly runs against ≥ 0.8.
      if (supported === null) return hnswIterativeScan;
    }
    return pgvectorSupportsIterativeScan ? hnswIterativeScan : "off";
  }

  return {
    detectBm25Engine,
    checkPgvectorVersion,
    effectiveIterativeScan,
  };
}
