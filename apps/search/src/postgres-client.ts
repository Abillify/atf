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
import type { AccessScope } from "./access-scope.js";
import { setDocumentAclDefault } from "./acl-default.js";
import { AppError, collectionTableName, ensureCollectionConfigTable, loadCollectionMeta, validateFtsLanguage, type CollectionMeta } from "./collection-ddl.js";
import { SqlParams, buildAccessSql, buildTemporalFilterSql } from "./query-builder.js";
import { createStatsBuffer } from "./stats-buffer.js";
import { Pool, type PoolClient } from "pg";
import type { PostgresClient, PostgresClientConfig, PostgresResponse } from "./pg-types.js";
import { createEngineDetection } from "./pg-engine-detect.js";
import type { PgFactoryCtx } from "./pg-factory-ctx.js";
import { createCollectionsMethods } from "./pg-methods-collections.js";
import { createCoreMethods } from "./pg-methods-core.js";
import { createDocsMethods } from "./pg-methods-docs.js";
import { createNavMethods } from "./pg-methods-nav.js";
import { createSearchMethods } from "./pg-methods-search.js";

export * from "./pg-types.js";
export * from "./pg-helpers.js";
export { validateFtsLanguage, collectionTableName };

// ─── Client factory ───────────────────────────────────────────────────────────

export function createPostgresClient(
  config: PostgresClientConfig,
): PostgresClient {
  // Req 3.2: resolve DOCUMENT_ACL_DEFAULT once per process so the SQL builder
  // and the row-ACL helper agree on the empty-ACL rule.
  setDocumentAclDefault(config.documentAclDefault ?? "allow");
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
    const temporal = buildTemporalFilterSql(
      p,
      table,
      false,
      validAt,
      "",
      collection,
    );
    return { sql: temporal + buildAccessSql(p, scope), params: p.values };
  };
  const {
    connectionString,
    logger,
    efSearch = 100,
    hnswIterativeScan = "relaxed_order",
    hnswMaxScanTuples = 20_000,
    efConstruction = 128,
    hnswM = 16,
    halfPrecision = false,
    defaultFtsLanguage = "simple",
    statsRetentionDays = 90,
    statsStoreRawQuery = false,
    statsQueryPepper = null,
    rrfK = 60,
    rrfWeightDense = 1.0,
    rrfWeightFts = 1.0,
    rrfWeightIdentifier = 1.0,
    rrfWeightSparse = 1.0,
    rrfMissingZero = true,
    ftsRanker = "ts_rank_cd",
    ftsContextualHeader = false,
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

  // ── Engine detection (BM25 + pgvector version gate, Req 4.2/4.7) ─────
  // Implementation in pg-engine-detect.ts (Requirement 13.6 split); the
  // cached verdicts live in that closure, one per client instance.
  const {
    detectBm25Engine,
    checkPgvectorVersion,
    effectiveIterativeScan,
  } = createEngineDetection({ pool, logger, hnswIterativeScan });

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
      if (
        cause instanceof AppError &&
        cause.code === "EMBEDDING_PROVENANCE_MISMATCH"
      ) {
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
  const ctx: PgFactoryCtx = {
    pool,
    logger,
    withClient,
    getOrLoadCollectionMeta,
    scopedWhere,
    versionedWhere,
    escapeRegex,
    ensuredCollections,
    ensureCollectionLocks,
    statsBuffer,
    detectBm25Engine,
    checkPgvectorVersion,
    effectiveIterativeScan,
    efSearch,
    hnswMaxScanTuples,
    defaultFtsLanguage,
    statsStoreRawQuery,
    statsQueryPepper,
    rrfK,
    rrfWeightDense,
    rrfWeightFts,
    rrfWeightIdentifier,
    rrfWeightSparse,
    rrfMissingZero,
    ftsRanker,
    ftsContextualHeader,
    quantizationConfig,
    expectedEmbeddingModel,
    expectedEmbeddingModelRevision,
    circuitBreakerGetters,
    vecType,
    ddlConfig,
  };

  return {
    ...createCoreMethods(ctx),
    ...createSearchMethods(ctx),
    ...createNavMethods(ctx),
    ...createCollectionsMethods(ctx),
    ...createDocsMethods(ctx),
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
