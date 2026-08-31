// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * metrics.ts
 *
 * GET /metrics — Prometheus text-format endpoint.
 *
 * Exposes process-level, application-level, and circuit-breaker counters that
 * Prometheus can scrape periodically.  No external library is required; the
 * Prometheus text exposition format is simple enough to generate by hand.
 *
 * Metrics exposed
 * ───────────────
 * vectorsearch_ingest_total                  counter  Total ingest operations recorded
 * vectorsearch_search_total                  counter  Total search operations recorded
 * vectorsearch_stats_flush_errors            counter  Failed stats-flush attempts since startup
 * vectorsearch_circuit_breaker_state         gauge    Circuit-breaker state per service (0=CLOSED, 1=HALF_OPEN, 2=OPEN)
 * vectorsearch_circuit_breaker_failures      gauge    Consecutive failure count per service
 * vectorsearch_process_uptime_seconds        gauge    Process uptime in seconds
 * vectorsearch_nodejs_heap_used_bytes        gauge    V8 heap used (bytes)
 * vectorsearch_nodejs_heap_total_bytes       gauge    V8 heap total (bytes)
 * vectorsearch_nodejs_rss_bytes              gauge    Resident set size (bytes)
 *
 * Authentication
 * ──────────────
 * The endpoint is protected by the same auth middleware as all other routes
 * (wired in index.ts).  If you want Prometheus to scrape without a token,
 * remove the authMiddleware from the /metrics route in index.ts and restrict
 * access at the network level instead.
 */

import type { RequestHandler } from "express";
import type { PostgresClient } from "../postgres-client.js";
import type { HttpMetrics } from "../http-metrics.js";
import type { QueryEmbeddingCache } from "../query-cache.js";

const CIRCUIT_STATE_VALUES = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 } as const;

function gauge(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
}

function counter(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name}_total ${value}\n`;
}

/**
 * Emit a labelled gauge for each circuit breaker.
 * Example output:
 *   # HELP vectorsearch_circuit_breaker_state Circuit breaker state …
 *   # TYPE vectorsearch_circuit_breaker_state gauge
 *   vectorsearch_circuit_breaker_state{service="embedding"} 0
 *   vectorsearch_circuit_breaker_state{service="reranker"} 2
 */
function circuitBreakerGauges(
  statuses: Array<{ name: string; state: string; failures: number }>,
): string {
  if (statuses.length === 0) return "";

  const stateLines = statuses
    .map((s) => {
      const val =
        CIRCUIT_STATE_VALUES[s.state as keyof typeof CIRCUIT_STATE_VALUES] ?? 0;
      return `vectorsearch_circuit_breaker_state{service="${s.name}"} ${val}`;
    })
    .join("\n");

  const failureLines = statuses
    .map(
      (s) =>
        `vectorsearch_circuit_breaker_failures{service="${s.name}"} ${s.failures}`,
    )
    .join("\n");

  return (
    `# HELP vectorsearch_circuit_breaker_state Circuit breaker state per downstream service (0=CLOSED, 1=HALF_OPEN, 2=OPEN)\n` +
    `# TYPE vectorsearch_circuit_breaker_state gauge\n` +
    `${stateLines}\n` +
    `# HELP vectorsearch_circuit_breaker_failures Consecutive failure count for each circuit breaker\n` +
    `# TYPE vectorsearch_circuit_breaker_failures gauge\n` +
    `${failureLines}\n`
  );
}

export function createMetricsHandler(
  postgresClient: PostgresClient,
  httpMetrics?: HttpMetrics,
  queryCache?: QueryEmbeddingCache | null,
): RequestHandler {
  return (_req, res) => {
    const counters = postgresClient.getStatsCounters();
    const circuitStatuses = postgresClient.getCircuitBreakerStatuses();
    const mem = process.memoryUsage();
    const uptime = process.uptime();

    const lines: string[] = [
      counter(
        "vectorsearch_ingest",
        "Total number of ingest operations recorded since startup",
        counters.ingestTotal,
      ),
      counter(
        "vectorsearch_search",
        "Total number of search operations recorded since startup",
        counters.searchTotal,
      ),
      ...(httpMetrics ? [httpMetrics.render()] : []),
      gauge(
        "vectorsearch_query_embedding_cache_entries",
        "Current number of cached query embeddings (no query labels)",
        queryCache?.size ?? 0,
      ),
      counter(
        "vectorsearch_stats_flush_errors",
        "Number of failed stats-flush attempts since startup",
        counters.flushErrors,
      ),
      circuitBreakerGauges(circuitStatuses),
      gauge(
        "vectorsearch_process_uptime_seconds",
        "Process uptime in seconds",
        Math.floor(uptime),
      ),
      gauge(
        "vectorsearch_nodejs_heap_used_bytes",
        "V8 heap memory currently used (bytes)",
        mem.heapUsed,
      ),
      gauge(
        "vectorsearch_nodejs_heap_total_bytes",
        "V8 heap memory total allocated (bytes)",
        mem.heapTotal,
      ),
      gauge(
        "vectorsearch_nodejs_rss_bytes",
        "Resident set size — total memory allocated for the process (bytes)",
        mem.rss,
      ),
    ];

    res
      .status(200)
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(lines.join("\n"));
  };
}
