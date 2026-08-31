// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * stats-buffer.ts
 *
 * In-memory write buffer for ingest and search statistics.
 *
 * Stats are accumulated in memory and flushed to PostgreSQL in batches to
 * avoid a DB round-trip on every request.  The flush is triggered either by
 * a periodic timer or when the buffer reaches STATS_FLUSH_BATCH_SIZE entries.
 *
 * Concurrency model
 * ─────────────────
 * Only one flush can be in-flight at a time.  A second trigger (timer or
 * batch-size) joins the already-running flush promise instead of starting a
 * new one.
 *
 * On flush, we snapshot the current buffer length *before* any await.  Items
 * pushed during the async write land at higher indices and are NOT removed on
 * success — they will be included in the next flush.  On failure, the
 * snapshot rows are also kept and retried on the next interval.  This means
 * a partial DB write (e.g. connection dropped mid-INSERT) could theoretically
 * produce duplicate rows, but stats are best-effort and the window is tiny.
 *
 * In-memory counters
 * ──────────────────
 * The buffer also maintains running totals (ingestTotal, searchTotal,
 * errorTotal) that are never reset — they are exposed via getCounters() for
 * the Prometheus /metrics endpoint without requiring a DB query.
 */

import type { Pool, PoolClient } from "pg";
import type pino from "pino";
import { ensureStatsTables } from "./collection-ddl.js";

const STATS_FLUSH_BATCH_SIZE = 100;

export interface PendingIngestStat {
  tenant_id: string;
  collection: string;
  operation: string;
  reference: string;
  duration_ms: number;
  chunks_processed: number;
}

export interface PendingSearchStat {
  tenant_id: string;
  collection: string;
  /** SHA-256 of the query; raw search terms are never persisted in statistics. */
  query: string;
  duration_ms: number;
  results_count: number;
  hybrid_search: boolean;
  reranked: boolean;
}

/** Running totals exposed to the Prometheus metrics endpoint. */
export interface StatsCounters {
  ingestTotal: number;
  searchTotal: number;
  /** Number of failed flush attempts since startup. */
  flushErrors: number;
}

export interface StatsBuffer {
  recordIngest(stat: PendingIngestStat): void;
  recordSearch(stat: PendingSearchStat): void;
  flush(): Promise<void>;
  getCounters(): StatsCounters;
  /** Flush pending rows and stop the periodic timer. */
  close(): Promise<void>;
}

export function createStatsBuffer(
  pool: Pool,
  logger: pino.Logger,
  statsRetentionDays: number,
  statsFlushIntervalMs: number,
): StatsBuffer {
  const ingestBuffer: PendingIngestStat[] = [];
  const searchBuffer: PendingSearchStat[] = [];

  // Running totals — never reset, used by /metrics.
  let ingestTotal = 0;
  let searchTotal = 0;
  let flushErrors = 0;

  let statsTablesReady = false;

  // ── Flush guard ───────────────────────────────────────────────────────────
  let flushInFlight: Promise<void> | null = null;

  function flush(): Promise<void> {
    if (flushInFlight) return flushInFlight;
    flushInFlight = doFlush().finally(() => {
      flushInFlight = null;
    });
    return flushInFlight;
  }

  async function ensureStatsTablesOnce(client: PoolClient): Promise<void> {
    if (statsTablesReady) return;
    await ensureStatsTables(client);
    statsTablesReady = true;
  }

  async function doFlush(): Promise<void> {
    if (ingestBuffer.length === 0 && searchBuffer.length === 0) return;

    // Snapshot current length before any awaits.
    // Items pushed during the async write survive the splice on success.
    const ingestCount = ingestBuffer.length;
    const searchCount = searchBuffer.length;
    const ingestRows = ingestBuffer.slice(0, ingestCount);
    const searchRows = searchBuffer.slice(0, searchCount);

    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await ensureStatsTablesOnce(client);

      if (ingestRows.length > 0) {
        const values: unknown[] = [];
        const placeholders = ingestRows.map((r, i) => {
          const base = i * 6;
          values.push(
            r.tenant_id,
            r.collection,
            r.operation,
            r.reference,
            r.duration_ms,
            r.chunks_processed,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        });
        await client.query(
          `INSERT INTO vs_ingest_stats
             (tenant_id, collection, operation, reference, duration_ms, chunks_processed)
           VALUES ${placeholders.join(", ")}`,
          values,
        );
      }

      if (searchRows.length > 0) {
        const values: unknown[] = [];
        const placeholders = searchRows.map((r, i) => {
          const base = i * 7;
          values.push(
            r.tenant_id,
            r.collection,
            r.query,
            r.duration_ms,
            r.results_count,
            r.hybrid_search,
            r.reranked,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        });
        await client.query(
          `INSERT INTO vs_search_stats
             (tenant_id, collection, query, duration_ms, results_count, hybrid_search, reranked)
           VALUES ${placeholders.join(", ")}`,
          values,
        );
      }

      // Only remove from buffer after a successful write.
      ingestBuffer.splice(0, ingestCount);
      searchBuffer.splice(0, searchCount);

      logger.debug(
        { ingest: ingestRows.length, search: searchRows.length },
        "Stats flushed to database",
      );
    } catch (err) {
      flushErrors++;
      logger.warn(
        { err },
        "Failed to flush stats; will retry on next flush interval",
      );
    } finally {
      client?.release();
    }
  }

  // ── Stats retention pruning ───────────────────────────────────────────────
  async function pruneStats(): Promise<void> {
    if (statsRetentionDays <= 0) return;
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await ensureStatsTablesOnce(client);
      await client.query(
        `DELETE FROM vs_ingest_stats WHERE timestamp < NOW() - ($1 * INTERVAL '1 day')`,
        [statsRetentionDays],
      );
      await client.query(
        `DELETE FROM vs_search_stats WHERE timestamp < NOW() - ($1 * INTERVAL '1 day')`,
        [statsRetentionDays],
      );
      logger.debug({ retentionDays: statsRetentionDays }, "Stats pruned");
    } catch (err) {
      logger.warn({ err }, "Stats pruning failed");
    } finally {
      client?.release();
    }
  }

  // ── Timers ────────────────────────────────────────────────────────────────
  const flushTimer = setInterval(() => {
    flush().catch((err) => logger.warn({ err }, "Periodic stats flush error"));
  }, statsFlushIntervalMs);
  flushTimer.unref();

  // Weekly stats pruning.
  const pruneTimer = setInterval(
    () => {
      pruneStats().catch(() => {});
    },
    7 * 24 * 60 * 60 * 1000,
  );
  pruneTimer.unref();

  // ── Public interface ──────────────────────────────────────────────────────
  return {
    recordIngest(stat: PendingIngestStat): void {
      ingestBuffer.push(stat);
      ingestTotal++;
      if (ingestBuffer.length >= STATS_FLUSH_BATCH_SIZE) {
        flush().catch((err) => logger.warn({ err }, "Batch stats flush error"));
      }
    },

    recordSearch(stat: PendingSearchStat): void {
      searchBuffer.push(stat);
      searchTotal++;
      if (searchBuffer.length >= STATS_FLUSH_BATCH_SIZE) {
        flush().catch((err) => logger.warn({ err }, "Batch stats flush error"));
      }
    },

    flush,

    getCounters(): StatsCounters {
      return { ingestTotal, searchTotal, flushErrors };
    },

    async close(): Promise<void> {
      clearInterval(flushTimer);
      clearInterval(pruneTimer);
      await flush();
    },
  };
}
