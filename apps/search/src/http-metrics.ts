// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { monitorEventLoopDelay } from "node:perf_hooks";

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, Number.POSITIVE_INFINITY];

interface Histogram {
  buckets: number[];
  count: number;
  sum: number;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** A batch spans an embedding round-trip per unit group: milliseconds to minutes. */
const batchBuckets = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, Number.POSITIVE_INFINITY];

/**
 * The outcome of one batch-worker tick, mirroring `TickOutcome["kind"]` in
 * `batch-worker.ts` (kept as a local union so the registry does not depend on
 * the worker module).
 */
export type BatchTickOutcome = "idle" | "processed" | "empty" | "deferred" | "skipped" | "error";

const BATCH_TICK_OUTCOMES: readonly BatchTickOutcome[] = [
  "idle",
  "processed",
  "empty",
  "deferred",
  "skipped",
  "error",
];

/** One observation for {@link HttpMetrics.recordBatchTick}. */
export interface BatchTickObservation {
  outcome: BatchTickOutcome;
  /** Wall-clock duration of the tick; omitted (or an `idle` tick) → no sample. */
  durationMs?: number;
  /** Retrieval units upserted by a `processed` tick. */
  units?: number;
}

function labels(method: string, route: string): string {
  return `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
}

/** In-process, low-cardinality RED/USE metrics exported by /metrics. */
export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly errors = new Map<string, number>();
  private readonly durations = new Map<string, Histogram>();
  private inFlight = 0;
  // v2 batch processing (requirement 18.1).
  private readonly batchTicks = new Map<BatchTickOutcome, number>();
  private readonly batchDuration: Histogram = { buckets: Array(batchBuckets.length).fill(0), count: 0, sum: 0 };
  private batchUnits = 0;
  private batchBacklog = 0;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  constructor() { this.loop.enable(); }

  begin(): (method: string, route: string, status: number) => void {
    this.inFlight++;
    const start = performance.now();
    let ended = false;
    return (method, route, status) => {
      if (ended) return;
      ended = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.observe(method, route, status, start);
    };
  }

  observe(method: string, route: string, status: number, start: number): void {
    const normalizedMethod = method.toUpperCase();
    const statusClass = `${Math.floor(status / 100)}xx`;
    const key = `${normalizedMethod}|${route}|${statusClass}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    if (status >= 500) this.errors.set(key, (this.errors.get(key) ?? 0) + 1);
    const histogramKey = `${normalizedMethod}|${route}`;
    const histogram = this.durations.get(histogramKey) ?? { buckets: Array(buckets.length).fill(0), count: 0, sum: 0 };
    const seconds = Math.max(0, (performance.now() - start) / 1000);
    for (let i = 0; i < buckets.length; i++) if (seconds <= buckets[i]!) histogram.buckets[i]!++;
    histogram.count++;
    histogram.sum += seconds;
    this.durations.set(histogramKey, histogram);
  }

  /**
   * Record one batch-worker tick: bumps `vectorsearch_batch_ticks_total{outcome}`,
   * observes `vectorsearch_batch_duration_seconds` for non-idle ticks with a
   * finite `durationMs`, and adds `units` to `vectorsearch_batch_units_total`.
   */
  recordBatchTick(observation: BatchTickObservation): void {
    if (!BATCH_TICK_OUTCOMES.includes(observation.outcome)) return;
    this.batchTicks.set(observation.outcome, (this.batchTicks.get(observation.outcome) ?? 0) + 1);
    const { durationMs, units } = observation;
    if (observation.outcome !== "idle" && durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      const seconds = durationMs / 1000;
      for (let i = 0; i < batchBuckets.length; i++) {
        if (seconds <= (batchBuckets[i] ?? Number.POSITIVE_INFINITY)) {
          this.batchDuration.buckets[i] = (this.batchDuration.buckets[i] ?? 0) + 1;
        }
      }
      this.batchDuration.count++;
      this.batchDuration.sum += seconds;
    }
    if (units !== undefined && Number.isFinite(units) && units > 0) this.batchUnits += Math.round(units);
  }

  /** Set `vectorsearch_batch_pending`: staged batches not yet processed. */
  setBatchBacklog(pending: number): void {
    this.batchBacklog = Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0;
  }

  render(): string {
    const lines = ["# HELP vectorsearch_http_requests_total HTTP requests by route and status class", "# TYPE vectorsearch_http_requests_total counter"];
    for (const [key, value] of this.requests) {
      const [method = "", route = "", status = ""] = key.split("|");
      lines.push(`vectorsearch_http_requests_total{${labels(method, route)},status_class="${escapeLabel(status)}"} ${value}`);
    }
    lines.push("# HELP vectorsearch_http_errors_total Server errors by route", "# TYPE vectorsearch_http_errors_total counter");
    for (const [key, value] of this.errors) {
      const [method = "", route = "", status = ""] = key.split("|");
      lines.push(`vectorsearch_http_errors_total{${labels(method, route)},status_class="${escapeLabel(status)}"} ${value}`);
    }
    lines.push("# HELP vectorsearch_http_request_duration_seconds HTTP request duration", "# TYPE vectorsearch_http_request_duration_seconds histogram");
    for (const [key, histogram] of this.durations) {
      const [method = "", route = ""] = key.split("|");
      for (let i = 0; i < buckets.length; i++) {
        const le = Number.isFinite(buckets[i]!) ? String(buckets[i]) : "+Inf";
        lines.push(`vectorsearch_http_request_duration_seconds_bucket{${labels(method, route)},le="${le}"} ${histogram.buckets[i]}`);
      }
      lines.push(`vectorsearch_http_request_duration_seconds_sum{${labels(method, route)}} ${histogram.sum}`);
      lines.push(`vectorsearch_http_request_duration_seconds_count{${labels(method, route)}} ${histogram.count}`);
    }
    lines.push("# HELP vectorsearch_batch_ticks_total Batch-worker ticks by outcome", "# TYPE vectorsearch_batch_ticks_total counter");
    for (const [outcome, value] of this.batchTicks) {
      lines.push(`vectorsearch_batch_ticks_total{outcome="${escapeLabel(outcome)}"} ${value}`);
    }
    lines.push("# HELP vectorsearch_batch_duration_seconds Duration of one non-idle batch-worker tick", "# TYPE vectorsearch_batch_duration_seconds histogram");
    for (let i = 0; i < batchBuckets.length; i++) {
      const edge = batchBuckets[i] ?? Number.POSITIVE_INFINITY;
      const le = Number.isFinite(edge) ? String(edge) : "+Inf";
      lines.push(`vectorsearch_batch_duration_seconds_bucket{le="${le}"} ${this.batchDuration.buckets[i] ?? 0}`);
    }
    lines.push(
      `vectorsearch_batch_duration_seconds_sum ${this.batchDuration.sum}`,
      `vectorsearch_batch_duration_seconds_count ${this.batchDuration.count}`,
      "# HELP vectorsearch_batch_units_total Retrieval units upserted by processed batches",
      "# TYPE vectorsearch_batch_units_total counter",
      `vectorsearch_batch_units_total ${this.batchUnits}`,
      "# HELP vectorsearch_batch_pending Staged batches not yet processed",
      "# TYPE vectorsearch_batch_pending gauge",
      `vectorsearch_batch_pending ${this.batchBacklog}`,
    );
    lines.push(
      "# HELP vectorsearch_http_in_flight_requests Requests currently in flight",
      "# TYPE vectorsearch_http_in_flight_requests gauge",
      `vectorsearch_http_in_flight_requests ${this.inFlight}`,
      "# HELP vectorsearch_nodejs_event_loop_lag_seconds Event loop lag mean",
      "# TYPE vectorsearch_nodejs_event_loop_lag_seconds gauge",
      `vectorsearch_nodejs_event_loop_lag_seconds ${this.loop.mean / 1e9 || 0}`,
    );
    return lines.join("\n") + "\n";
  }
}
