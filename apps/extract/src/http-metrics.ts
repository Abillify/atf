// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * http-metrics.ts
 *
 * In-process RED/USE metrics plus extraction-specific counters, rendered for
 * Prometheus at `/metrics`. No prom-client dependency, matching
 * `apps/search/src/http-metrics.ts`.
 *
 * Cardinality discipline: labels are canonical Express route templates, never
 * raw paths, document references or tenant ids. A metric labelled by document
 * reference would grow without bound — one series per file ever uploaded.
 *
 * Beyond HTTP, this tracks the four numbers that actually describe a converter's
 * health, because request duration alone hides all of them: pages converted,
 * vision calls and their token spend, figure crops produced, and how deep the
 * work queue is. A conversion service that is slow because the model is slow
 * looks identical to one that is slow because the queue is full, unless you
 * measure both.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

const buckets = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, Number.POSITIVE_INFINITY,
];

/** Page conversion spans seconds to minutes, so it needs its own bucket set. */
const pageBuckets = [0.5, 1, 2.5, 5, 10, 20, 40, 80, 160, 320, Number.POSITIVE_INFINITY];

/**
 * A v2 pipeline stage ranges from a millisecond (a deterministic parse) to
 * minutes (a tiled vision pass or the document pass), so its buckets span both.
 */
const stageBuckets = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, Number.POSITIVE_INFINITY,
];

/**
 * How one execution of a v2 pipeline stage ended (requirement 18.1):
 *   - `done`: the stage ran and its checkpoint was written;
 *   - `reused`: an existing checkpoint with the same input hash was reused, so
 *     no work (and no model call) happened;
 *   - `failed_transient`: failed with a retryable error (timeout, 5xx, 429);
 *   - `failed_permanent`: failed for good (invalid input, retries exhausted).
 */
export type StageOutcome = "done" | "reused" | "failed_transient" | "failed_permanent";

export const STAGE_OUTCOMES: readonly StageOutcome[] = [
  "done",
  "reused",
  "failed_transient",
  "failed_permanent",
];

/** One observation for {@link HttpMetrics.recordStage}. */
export interface StageObservation {
  /** Stage name, e.g. `analyzed`, `vision1`, `figure2`, `tiled`, `docpass`, `emitted`. */
  stage: string;
  outcome: StageOutcome;
  /** Wall-clock duration of the stage execution; omitted → no histogram sample. */
  durationMs?: number;
  /** Model tokens (input + output) the stage consumed; omitted/0 → no increment. */
  tokens?: number;
}

/**
 * Stage names become a label, so they are bounded: anything that is not a
 * short lower-case identifier collapses to `other` instead of opening a new
 * series per arbitrary string.
 */
function stageLabel(stage: string): string {
  return /^[a-z][a-z0-9_]{0,31}$/.test(stage) ? stage : "other";
}

interface Histogram {
  buckets: number[];
  count: number;
  sum: number;
}

function emptyHistogram(size: number): Histogram {
  return { buckets: Array(size).fill(0), count: 0, sum: 0 };
}

function observeHistogram(histogram: Histogram, edges: number[], value: number): void {
  for (let i = 0; i < edges.length; i++) {
    if (value <= (edges[i] ?? Number.POSITIVE_INFINITY)) {
      histogram.buckets[i] = (histogram.buckets[i] ?? 0) + 1;
    }
  }
  histogram.count++;
  histogram.sum += value;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labels(method: string, route: string): string {
  return `method="${escapeLabel(method)}",route="${escapeLabel(route)}"`;
}

export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly errors = new Map<string, number>();
  private readonly durations = new Map<string, Histogram>();
  private inFlight = 0;

  // ── Extraction counters ──────────────────────────────────────────────────
  /** Documents converted, keyed by source MIME type and outcome. */
  private readonly documents = new Map<string, number>();
  /** Documents removed via `DELETE /v2/documents/{reference}` (extract-outpost E2). */
  private documentsDeleted = 0;
  /** Pages converted, keyed by source MIME type. */
  private readonly pages = new Map<string, number>();
  private readonly pageDuration = emptyHistogram(pageBuckets.length);
  private visionRequests = 0;
  private visionFailures = 0;
  /** Escalations because the model stopped on `finish_reason: "length"`. */
  private visionTruncations = 0;
  private visionInputTokens = 0;
  private visionOutputTokens = 0;
  private figuresDetected = 0;
  private figuresRendered = 0;
  /** Pages whose text layer was checked against the model output. */
  private textFidelityChecks = 0;
  /** Pages flagged for losing too many risky tokens. */
  private textFidelityDivergences = 0;
  /** Distinct risky tokens that went missing across all flagged pages. */
  private textFidelityMissingTokens = 0;
  /** Pages that took the deterministic text fast-path (no vision call). */
  private fastPathPages = 0;
  /** Pages that took the vision path. Together with the above → "Anteil Fast-Path". */
  private visionPathPages = 0;
  private queueDepth = 0;
  private queueActive = 0;
  private queueRejected = 0;

  // ── v2 stage metrics (requirement 18.1) ──────────────────────────────────
  private readonly stageDurations = new Map<string, Histogram>();
  /** Keyed `stage|outcome`. */
  private readonly stageOutcomes = new Map<string, number>();
  private readonly stageTokens = new Map<string, number>();
  /** Emit-outbox rows staged but not yet acknowledged by Search. */
  private emitBacklog = 0;

  private readonly loop = monitorEventLoopDelay({ resolution: 20 });

  constructor() {
    this.loop.enable();
  }

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
    const histogram = this.durations.get(histogramKey) ?? emptyHistogram(buckets.length);
    observeHistogram(histogram, buckets, Math.max(0, (performance.now() - start) / 1000));
    this.durations.set(histogramKey, histogram);
  }

  recordDocument(mimeType: string, outcome: "ok" | "error"): void {
    const key = `${mimeType}|${outcome}`;
    this.documents.set(key, (this.documents.get(key) ?? 0) + 1);
  }

  /** Count documents Search removed for a delete-by-reference (E2, req 9.7). */
  recordDocumentsDeleted(count: number): void {
    this.documentsDeleted += Math.max(0, count);
  }

  recordPage(mimeType: string, durationMs: number): void {
    this.pages.set(mimeType, (this.pages.get(mimeType) ?? 0) + 1);
    observeHistogram(this.pageDuration, pageBuckets, Math.max(0, durationMs / 1000));
  }

  recordVision(options: {
    ok: boolean;
    truncated: boolean;
    inputTokens: number;
    outputTokens: number;
  }): void {
    this.visionRequests++;
    if (!options.ok) this.visionFailures++;
    if (options.truncated) this.visionTruncations++;
    this.visionInputTokens += options.inputTokens;
    this.visionOutputTokens += options.outputTokens;
  }

  recordFigures(detected: number, rendered: number): void {
    this.figuresDetected += detected;
    this.figuresRendered += rendered;
  }

  recordTextFidelity(options: { flagged: boolean; missingTokens: number }): void {
    this.textFidelityChecks++;
    if (options.flagged) {
      this.textFidelityDivergences++;
      this.textFidelityMissingTokens += options.missingTokens;
    }
  }

  /**
   * Count a page's processing route (task 2.9, requirement 18.1). The share of
   * `route="fast-path"` over the total is the "Anteil Fast-Path" — how many
   * pages skipped the vision model via the deterministic text fast-path.
   */
  recordFastPath(route: "fast-path" | "vision"): void {
    if (route === "fast-path") this.fastPathPages++;
    else this.visionPathPages++;
  }

  setQueue(state: { depth: number; active: number }): void {
    this.queueDepth = state.depth;
    this.queueActive = state.active;
  }

  recordQueueRejection(): void {
    this.queueRejected++;
  }

  /**
   * Record one v2 stage execution: bumps `extract_stage_total{stage,outcome}`,
   * observes `extract_stage_duration_seconds{stage}` when `durationMs` is a
   * finite number, and adds `tokens` to `extract_stage_tokens_total{stage}`.
   * Negative or non-finite values are ignored rather than corrupting a series.
   */
  recordStage(observation: StageObservation): void {
    const stage = stageLabel(observation.stage);
    if (!STAGE_OUTCOMES.includes(observation.outcome)) return;
    const key = `${stage}|${observation.outcome}`;
    this.stageOutcomes.set(key, (this.stageOutcomes.get(key) ?? 0) + 1);
    const { durationMs, tokens } = observation;
    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      const histogram = this.stageDurations.get(stage) ?? emptyHistogram(stageBuckets.length);
      observeHistogram(histogram, stageBuckets, durationMs / 1000);
      this.stageDurations.set(stage, histogram);
    }
    if (tokens !== undefined && Number.isFinite(tokens) && tokens > 0) {
      this.stageTokens.set(stage, (this.stageTokens.get(stage) ?? 0) + Math.round(tokens));
    }
  }

  /**
   * Set the hand-over backlog gauge `extract_emit_outbox_pending`: emit-outbox
   * rows that are staged but not yet acknowledged by Search, across all jobs.
   */
  setEmitBacklog(pending: number): void {
    this.emitBacklog = Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0;
  }

  render(): string {
    const lines: string[] = [
      "# HELP extract_http_requests_total HTTP requests by route and status class",
      "# TYPE extract_http_requests_total counter",
    ];
    for (const [key, value] of this.requests) {
      const [method = "", route = "", status = ""] = key.split("|");
      lines.push(
        `extract_http_requests_total{${labels(method, route)},status_class="${escapeLabel(status)}"} ${value}`,
      );
    }
    lines.push(
      "# HELP extract_http_errors_total Server errors by route",
      "# TYPE extract_http_errors_total counter",
    );
    for (const [key, value] of this.errors) {
      const [method = "", route = "", status = ""] = key.split("|");
      lines.push(
        `extract_http_errors_total{${labels(method, route)},status_class="${escapeLabel(status)}"} ${value}`,
      );
    }
    lines.push(
      "# HELP extract_http_request_duration_seconds HTTP request duration",
      "# TYPE extract_http_request_duration_seconds histogram",
    );
    for (const [key, histogram] of this.durations) {
      const [method = "", route = ""] = key.split("|");
      for (let i = 0; i < buckets.length; i++) {
        const edge = buckets[i] ?? Number.POSITIVE_INFINITY;
        const le = Number.isFinite(edge) ? String(edge) : "+Inf";
        lines.push(
          `extract_http_request_duration_seconds_bucket{${labels(method, route)},le="${le}"} ${histogram.buckets[i] ?? 0}`,
        );
      }
      lines.push(
        `extract_http_request_duration_seconds_sum{${labels(method, route)}} ${histogram.sum}`,
      );
      lines.push(
        `extract_http_request_duration_seconds_count{${labels(method, route)}} ${histogram.count}`,
      );
    }

    lines.push(
      "# HELP extract_documents_total Documents converted by source type and outcome",
      "# TYPE extract_documents_total counter",
    );
    for (const [key, value] of this.documents) {
      const [mimeType = "", outcome = ""] = key.split("|");
      lines.push(
        `extract_documents_total{source_type="${escapeLabel(mimeType)}",outcome="${escapeLabel(outcome)}"} ${value}`,
      );
    }

    lines.push(
      "# HELP extract_documents_deleted_total Documents removed via DELETE /v2/documents/{reference}",
      "# TYPE extract_documents_deleted_total counter",
    );
    lines.push(`extract_documents_deleted_total ${this.documentsDeleted}`);
    lines.push(
      "# HELP extract_pages_total Pages converted by source type",
      "# TYPE extract_pages_total counter",
    );
    for (const [mimeType, value] of this.pages) {
      lines.push(`extract_pages_total{source_type="${escapeLabel(mimeType)}"} ${value}`);
    }

    lines.push(
      "# HELP extract_page_duration_seconds End-to-end duration of one page",
      "# TYPE extract_page_duration_seconds histogram",
    );
    for (let i = 0; i < pageBuckets.length; i++) {
      const edge = pageBuckets[i] ?? Number.POSITIVE_INFINITY;
      const le = Number.isFinite(edge) ? String(edge) : "+Inf";
      lines.push(`extract_page_duration_seconds_bucket{le="${le}"} ${this.pageDuration.buckets[i] ?? 0}`);
    }
    lines.push(
      `extract_page_duration_seconds_sum ${this.pageDuration.sum}`,
      `extract_page_duration_seconds_count ${this.pageDuration.count}`,
      "# HELP extract_vision_requests_total Vision model requests",
      "# TYPE extract_vision_requests_total counter",
      `extract_vision_requests_total ${this.visionRequests}`,
      "# HELP extract_vision_failures_total Vision requests that ultimately failed",
      "# TYPE extract_vision_failures_total counter",
      `extract_vision_failures_total ${this.visionFailures}`,
      "# HELP extract_vision_truncations_total Responses cut off by the token budget, forcing an escalation",
      "# TYPE extract_vision_truncations_total counter",
      `extract_vision_truncations_total ${this.visionTruncations}`,
      "# HELP extract_vision_tokens_total Vision tokens by direction",
      "# TYPE extract_vision_tokens_total counter",
      `extract_vision_tokens_total{direction="input"} ${this.visionInputTokens}`,
      `extract_vision_tokens_total{direction="output"} ${this.visionOutputTokens}`,
      "# HELP extract_figures_total Figures by processing stage",
      "# TYPE extract_figures_total counter",
      `extract_figures_total{stage="detected"} ${this.figuresDetected}`,
      `extract_figures_total{stage="rendered"} ${this.figuresRendered}`,
      "# HELP extract_text_fidelity_checks_total Pages whose text layer was compared against the model output",
      "# TYPE extract_text_fidelity_checks_total counter",
      `extract_text_fidelity_checks_total ${this.textFidelityChecks}`,
      "# HELP extract_text_fidelity_divergences_total Pages flagged for losing too many risky tokens from the text layer",
      "# TYPE extract_text_fidelity_divergences_total counter",
      `extract_text_fidelity_divergences_total ${this.textFidelityDivergences}`,
      "# HELP extract_text_fidelity_missing_tokens_total Distinct risky tokens missing across flagged pages",
      "# TYPE extract_text_fidelity_missing_tokens_total counter",
      `extract_text_fidelity_missing_tokens_total ${this.textFidelityMissingTokens}`,
      "# HELP extract_pages_fast_path_total Pages by processing route (fast-path vs vision); the fast-path share is \"Anteil Fast-Path\"",
      "# TYPE extract_pages_fast_path_total counter",
      `extract_pages_fast_path_total{route="fast-path"} ${this.fastPathPages}`,
      `extract_pages_fast_path_total{route="vision"} ${this.visionPathPages}`,
      "# HELP extract_queue_depth Conversions waiting for a slot",
      "# TYPE extract_queue_depth gauge",
      `extract_queue_depth ${this.queueDepth}`,
      "# HELP extract_queue_active Conversions currently running",
      "# TYPE extract_queue_active gauge",
      `extract_queue_active ${this.queueActive}`,
      "# HELP extract_queue_rejected_total Uploads refused because the queue was full",
      "# TYPE extract_queue_rejected_total counter",
      `extract_queue_rejected_total ${this.queueRejected}`,
      "# HELP extract_emit_outbox_pending Emit-outbox rows staged but not yet acknowledged by Search",
      "# TYPE extract_emit_outbox_pending gauge",
      `extract_emit_outbox_pending ${this.emitBacklog}`,
      "# HELP extract_http_in_flight_requests Requests currently in flight",
      "# TYPE extract_http_in_flight_requests gauge",
      `extract_http_in_flight_requests ${this.inFlight}`,
      "# HELP extract_nodejs_event_loop_lag_seconds Event loop lag mean",
      "# TYPE extract_nodejs_event_loop_lag_seconds gauge",
      `extract_nodejs_event_loop_lag_seconds ${this.loop.mean / 1e9 || 0}`,
    );

    lines.push(
      "# HELP extract_stage_duration_seconds Duration of one v2 pipeline stage execution",
      "# TYPE extract_stage_duration_seconds histogram",
    );
    for (const [stage, histogram] of this.stageDurations) {
      const label = `stage="${escapeLabel(stage)}"`;
      for (let i = 0; i < stageBuckets.length; i++) {
        const edge = stageBuckets[i] ?? Number.POSITIVE_INFINITY;
        const le = Number.isFinite(edge) ? String(edge) : "+Inf";
        lines.push(
          `extract_stage_duration_seconds_bucket{${label},le="${le}"} ${histogram.buckets[i] ?? 0}`,
        );
      }
      lines.push(
        `extract_stage_duration_seconds_sum{${label}} ${histogram.sum}`,
        `extract_stage_duration_seconds_count{${label}} ${histogram.count}`,
      );
    }
    lines.push(
      "# HELP extract_stage_total v2 pipeline stage executions by stage and outcome",
      "# TYPE extract_stage_total counter",
    );
    for (const [key, value] of this.stageOutcomes) {
      const [stage = "", outcome = ""] = key.split("|");
      lines.push(
        `extract_stage_total{stage="${escapeLabel(stage)}",outcome="${escapeLabel(outcome)}"} ${value}`,
      );
    }
    lines.push(
      "# HELP extract_stage_tokens_total Model tokens consumed by v2 pipeline stage",
      "# TYPE extract_stage_tokens_total counter",
    );
    for (const [stage, value] of this.stageTokens) {
      lines.push(`extract_stage_tokens_total{stage="${escapeLabel(stage)}"} ${value}`);
    }

    return `${lines.join("\n")}\n`;
  }
}
