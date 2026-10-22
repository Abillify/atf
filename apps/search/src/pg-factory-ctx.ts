// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pg-factory-ctx.ts
 *
 * Shared state handed from the postgres-client factory to the method-group
 * modules (Requirement 13.6 module split). Every member keeps the exact name
 * and semantics it had as a factory-local before the split.
 */

import type pino from "pino";
import type { Pool, PoolClient } from "pg";
import type { AccessScope } from "./access-scope.js";
import type { CollectionDDLConfig, CollectionMeta } from "./collection-ddl.js";
import type { EngineDetection } from "./pg-engine-detect.js";
import type {
  CircuitBreakerStatus,
  PostgresResponse,
} from "./pg-types.js";
import type { StatsBuffer } from "./stats-buffer.js";

export interface PgFactoryCtx {
  pool: Pool;
  logger: pino.Logger;
  withClient<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<PostgresResponse<T>>;
  getOrLoadCollectionMeta(
    client: PoolClient,
    table: string,
  ): Promise<CollectionMeta>;
  scopedWhere(
    scope: AccessScope,
    params: unknown[],
    alias?: string,
  ): { sql: string; params: unknown[] };
  versionedWhere(
    table: string,
    collection: string,
    scope: AccessScope,
    params: unknown[],
    validAt?: string,
  ): { sql: string; params: unknown[] };
  escapeRegex(s: string): string;
  ensuredCollections: Map<string, CollectionMeta>;
  ensureCollectionLocks: Map<string, Promise<PostgresResponse<void>>>;
  statsBuffer: StatsBuffer;
  detectBm25Engine: EngineDetection["detectBm25Engine"];
  checkPgvectorVersion: EngineDetection["checkPgvectorVersion"];
  effectiveIterativeScan: EngineDetection["effectiveIterativeScan"];
  efSearch: number;
  hnswMaxScanTuples: number;
  defaultFtsLanguage: string;
  statsStoreRawQuery: boolean;
  statsQueryPepper: string | null;
  rrfK: number;
  rrfWeightDense: number;
  rrfWeightFts: number;
  rrfWeightIdentifier: number;
  rrfWeightSparse: number;
  rrfMissingZero: boolean;
  ftsRanker: "ts_rank_cd" | "bm25";
  /** FTS_CONTEXTUAL_HEADER=on: weight-D header (title + section path) in ts_search. */
  ftsContextualHeader: boolean;
  quantizationConfig: "none" | "binary";
  expectedEmbeddingModel: string | undefined;
  expectedEmbeddingModelRevision: string | undefined;
  circuitBreakerGetters: Array<() => CircuitBreakerStatus>;
  vecType: string;
  ddlConfig: CollectionDDLConfig;
}
