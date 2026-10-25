// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/throughput-tuning.ts
 *
 * The PURE core of the `PAGE_CONCURRENCY` throughput-tuning tool (task 5.3,
 * ). No I/O lives here — every function is a deterministic
 * transform so the whole thing is unit-testable offline, with no vLLM/GPU
 * cluster in reach. The thin executable that actually drives real jobs and
 * scrapes a live vLLM `/metrics` endpoint is `scripts/throughput-sweep.ts`; it
 * imports these functions and adds only the network/process side-effects.
 *
 * Why this exists
 * ---------------
 * `PAGE_CONCURRENCY` is the number of pages of ONE job that Extract keeps in
 * flight against the vision model at once (config.ts; consumed by the DB-backed
 * ordered scheduler in `job-runner.ts` and by `mapOrdered(..., pageConcurrency,
 * …)` in `pipeline/extract.ts`). Each in-flight page is one request against the
 * OpenAI-compatible vLLM endpoint. vLLM does *continuous batching*: it packs
 * concurrent requests into one running batch bounded by its `--max-num-seqs`.
 * So `PAGE_CONCURRENCY` is really "how many sequences this one job offers vLLM
 * to batch". Set it too low and the batch is under-filled (GPU idle between
 * decode steps, low pages/minute); set it too high and requests queue
 * (`num_requests_waiting` climbs) and per-request latency rises with no
 * throughput gain — the classic saturation knee. Design §9a.4 pins the
 * intent: "`PAGE_CONCURRENCY` follows the batch capacity of the
 * vLLM server (continuous batching, guideline 8–16), not a fixed
 * value of 4."
 *
 * This module turns that qualitative guidance into a repeatable measurement an
 * operator runs on their OWN hardware:
 *   1. {@link planSweep} — the ordered set of `PAGE_CONCURRENCY` values to try.
 *   2. {@link parseVllmMetrics} + {@link summarizeVllmSamples} — read the
 *      server-side batch signals from vLLM's Prometheus `/metrics`.
 *   3. {@link recommendConcurrency} — pick the saturation knee from the
 *      measured rows (never from invented numbers).
 *   4. {@link formatResultsMarkdown} / {@link formatResultsCsv} — the operator
 *      report.
 *
 * IMPORTANT — no fabricated data. Nothing here invents a throughput or latency.
 * Every {@link SweepRow} is fed in by the caller from a real run, or the caller
 * is in dry-run mode and prints only the PLAN (the concurrency values and the
 * columns it *would* fill), never numbers.
 */

// ─── Sweep planning ────────────────────────────────────────────────────────────

/** Inputs that shape the set of `PAGE_CONCURRENCY` values a sweep visits. */
export interface SweepPlanInput {
  /**
   * Explicit concurrency values to test. When provided, these are used
   * verbatim (deduplicated, sorted, positive-only). Overrides the geometric
   * default. Example: `[1, 2, 4, 8, 16]`.
   */
  values?: readonly number[];
  /**
   * The vLLM server's `--max-num-seqs` (its running-batch ceiling), when the
   * operator knows it. The default sweep is anchored around it: the knee is
   * expected at or a little below `maxNumSeqs / concurrentJobs`, so the sweep
   * brackets that point. Optional — without it the sweep is a plain geometric
   * ladder.
   */
  maxNumSeqs?: number;
  /**
   * How many Extract jobs are expected to hit the same vLLM at once (e.g. the
   * normal lane plus the large-job lane, task 5.2). The per-job batch share is
   * `maxNumSeqs / concurrentJobs`, so more concurrent jobs means a lower
   * per-job knee. Default 1.
   */
  concurrentJobs?: number;
  /** Hard ceiling — never test above this. Mirrors config's max (64). Default 64. */
  maxConcurrency?: number;
}

/** The default geometric ladder when nothing else is specified. */
const DEFAULT_LADDER = [1, 2, 4, 8, 16] as const;

/** config.ts pins `PAGE_CONCURRENCY` to [1, 64]; the sweep respects that. */
export const PAGE_CONCURRENCY_MIN = 1;
export const PAGE_CONCURRENCY_MAX = 64;

/**
 * Decide the ordered `PAGE_CONCURRENCY` values a sweep will test. PURE.
 *
 * Precedence:
 *  1. Explicit `values` — sanitised (integer, ≥1, ≤ ceiling), deduped, sorted.
 *  2. Otherwise a geometric ladder 1,2,4,8,… bracketing the per-job batch
 *     share (`maxNumSeqs / concurrentJobs`) when `maxNumSeqs` is given, so the
 *     sweep straddles the expected knee rather than stopping short of it.
 *  3. Otherwise the plain {@link DEFAULT_LADDER}.
 *
 * The result is always non-empty, ascending, unique, and within
 * `[PAGE_CONCURRENCY_MIN, ceiling]`. It never invents timing — it only chooses
 * *which* settings to measure.
 */
export function planSweep(input: SweepPlanInput = {}): number[] {
  const ceiling = clampInt(
    input.maxConcurrency ?? PAGE_CONCURRENCY_MAX,
    PAGE_CONCURRENCY_MIN,
    PAGE_CONCURRENCY_MAX,
  );

  if (input.values !== undefined && input.values.length > 0) {
    return sanitizeValues(input.values, ceiling);
  }

  const concurrentJobs = Math.max(1, Math.floor(input.concurrentJobs ?? 1));
  if (input.maxNumSeqs !== undefined && input.maxNumSeqs > 0) {
    const perJobShare = Math.max(1, Math.floor(input.maxNumSeqs / concurrentJobs));
    // Bracket the knee: geometric ladder up to and one step past the share, so
    // the operator sees throughput on both sides of the expected saturation.
    const ladder: number[] = [];
    for (let v = 1; v <= perJobShare && v <= ceiling; v *= 2) ladder.push(v);
    // Ensure the share itself is present (it may not be a power of two).
    if (perJobShare <= ceiling) ladder.push(perJobShare);
    // One step past the share to reveal over-subscription, capped at ceiling.
    const past = Math.min(perJobShare * 2, ceiling);
    ladder.push(past);
    return sanitizeValues(ladder, ceiling);
  }

  return sanitizeValues(DEFAULT_LADDER, ceiling);
}

function sanitizeValues(values: readonly number[], ceiling: number): number[] {
  const cleaned = new Set<number>();
  for (const raw of values) {
    if (!Number.isFinite(raw)) continue;
    const v = clampInt(Math.floor(raw), PAGE_CONCURRENCY_MIN, ceiling);
    cleaned.add(v);
  }
  const out = [...cleaned].sort((a, b) => a - b);
  return out.length > 0 ? out : [PAGE_CONCURRENCY_MIN];
}

function clampInt(value: number, min: number, max: number): number {
  const v = Math.floor(value);
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// ─── vLLM /metrics parsing ─────────────────────────────────────────────────────

/**
 * A single scrape of the server-side batch signals from a vLLM Prometheus
 * `/metrics` body. Every field is optional: a given vLLM build/version may not
 * expose all of them, and the tool must degrade to "column not available"
 * rather than guess. Values are the raw gauge readings at scrape time.
 */
export interface VllmMetricsSample {
  /** `vllm:num_requests_running` — sequences in the running batch right now. */
  numRequestsRunning?: number;
  /** `vllm:num_requests_waiting` — requests queued for a batch slot. */
  numRequestsWaiting?: number;
  /** `vllm:num_requests_swapped` — requests swapped out (KV-cache pressure). */
  numRequestsSwapped?: number;
  /** `vllm:gpu_cache_usage_perc` — fraction of KV-cache blocks in use (0–1). */
  gpuCacheUsagePerc?: number;
}

/** The gauge names this module reads, keyed to the sample field they fill. */
const VLLM_GAUGES: ReadonlyArray<readonly [string, keyof VllmMetricsSample]> = [
  ["vllm:num_requests_running", "numRequestsRunning"],
  ["vllm:num_requests_waiting", "numRequestsWaiting"],
  ["vllm:num_requests_swapped", "numRequestsSwapped"],
  ["vllm:gpu_cache_usage_perc", "gpuCacheUsagePerc"],
];

/**
 * Parse a vLLM Prometheus `/metrics` text body into a {@link VllmMetricsSample}.
 * PURE — takes the already-fetched text, does no network I/O.
 *
 * The Prometheus text format is one sample per line: `name{labels} value
 * [timestamp]`, with `#`-prefixed HELP/TYPE lines interleaved. vLLM labels the
 * gauges with `model_name` (and in multi-replica setups an `engine` index), so
 * a metric may appear on several lines. We take the LAST occurrence of each
 * gauge (a later replica/engine line wins) — the executable is expected to hit
 * a single model endpoint, so at most a handful of lines share a name.
 *
 * A gauge that never appears stays `undefined`, which the formatter renders as
 * `n/a` with a note — the tool NEVER substitutes a placeholder number for a
 * missing server metric.
 */
export function parseVllmMetrics(body: string): VllmMetricsSample {
  const sample: VllmMetricsSample = {};
  const lines = body.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    for (const [gauge, field] of VLLM_GAUGES) {
      if (!line.startsWith(gauge)) continue;
      // The character right after the name must be a `{` (labels), whitespace,
      // or the value — this rejects a longer metric that merely shares a prefix
      // (e.g. `vllm:num_requests_running_total` would not clobber the gauge).
      const next = line.charAt(gauge.length);
      if (next !== "" && next !== "{" && next !== " " && next !== "\t") continue;
      const value = parseMetricValue(line);
      if (value !== undefined) sample[field] = value;
    }
  }
  return sample;
}

/** Extract the numeric value (the last whitespace-separated token, sans an optional trailing timestamp). */
function parseMetricValue(line: string): number | undefined {
  // Value is the token after the `}` of the label set, or after the name when
  // there are no labels. Prometheus allows an optional trailing timestamp, so
  // parse the token that immediately follows the labels/name, not the last.
  const afterLabels = line.includes("}") ? line.slice(line.lastIndexOf("}") + 1) : line;
  const tokens = afterLabels.trim().split(/\s+/).filter((t) => t.length > 0);
  // When there were no labels the name itself is the first token; the value is
  // then the second. With labels, the sliced remainder's first token is value.
  const candidate = line.includes("}") ? tokens[0] : tokens[1];
  if (candidate === undefined) return undefined;
  const num = Number.parseFloat(candidate);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Reduce a series of scrapes taken WHILE a setting ran into the batch-health
 * summary a sweep row carries. PURE.
 *
 * - running/waiting/swapped → mean over the samples (rounded to 1 dp), the
 *   steady-state batch occupancy and backlog for that setting.
 * - gpuCacheUsagePerc → the PEAK (max), because KV-cache thrash is a
 *   worst-case signal: a momentary spike to full is what precedes swapping,
 *   even if the mean looks calm.
 *
 * Returns an empty object when there are no samples (offline/no-metrics), so
 * the row simply carries no server columns.
 */
export function summarizeVllmSamples(
  samples: readonly VllmMetricsSample[],
): VllmMetricsSample {
  if (samples.length === 0) return {};
  const summary: VllmMetricsSample = {};
  const meanOf = (field: keyof VllmMetricsSample): number | undefined => {
    const present = samples
      .map((s) => s[field])
      .filter((v): v is number => typeof v === "number");
    if (present.length === 0) return undefined;
    const sum = present.reduce((a, b) => a + b, 0);
    return round1(sum / present.length);
  };
  const maxOf = (field: keyof VllmMetricsSample): number | undefined => {
    const present = samples
      .map((s) => s[field])
      .filter((v): v is number => typeof v === "number");
    if (present.length === 0) return undefined;
    return round1(Math.max(...present) * 1000) / 1000;
  };
  const running = meanOf("numRequestsRunning");
  const waiting = meanOf("numRequestsWaiting");
  const swapped = meanOf("numRequestsSwapped");
  const cache = maxOf("gpuCacheUsagePerc");
  if (running !== undefined) summary.numRequestsRunning = running;
  if (waiting !== undefined) summary.numRequestsWaiting = waiting;
  if (swapped !== undefined) summary.numRequestsSwapped = swapped;
  if (cache !== undefined) summary.gpuCacheUsagePerc = cache;
  return summary;
}

// ─── Result rows and per-setting throughput ────────────────────────────────────

/**
 * The measured outcome of running the fixed corpus at ONE `PAGE_CONCURRENCY`.
 * The caller (the executable) fills this from a real run — this module never
 * synthesises it.
 */
export interface SweepRow {
  /** The `PAGE_CONCURRENCY` this row was measured at. */
  concurrency: number;
  /** Pages fully processed in the run (the terminal `emitted` cursor stage). */
  pagesProcessed: number;
  /** Wall-clock of the run, milliseconds. */
  wallMs: number;
  /** Per-page vision-latency samples (ms), one per completed page. */
  pageLatenciesMs: readonly number[];
  /** Server-side batch summary for this setting, or `{}` when unavailable. */
  vllm?: VllmMetricsSample;
}

/** The derived, display-ready metrics for one setting. */
export interface SweepRowMetrics {
  concurrency: number;
  /** End-to-end job throughput: pages per minute. */
  pagesPerMinute: number;
  /** Mean per-page vision latency, seconds. */
  meanLatencySec: number;
  /** 95th-percentile per-page vision latency, seconds. */
  p95LatencySec: number;
  vllm: VllmMetricsSample;
}

/**
 * Derive the display metrics for one measured row. PURE.
 *
 * throughput = pagesProcessed / wallMinutes; latency mean and p95 from the
 * per-page samples (nearest-rank p95). All zero/empty inputs yield zeros rather
 * than NaN, so a degenerate row (e.g. a run that processed nothing) is still a
 * valid, honest row.
 */
export function computeRowMetrics(row: SweepRow): SweepRowMetrics {
  const wallMinutes = row.wallMs > 0 ? row.wallMs / 60_000 : 0;
  const pagesPerMinute =
    wallMinutes > 0 ? round2(row.pagesProcessed / wallMinutes) : 0;
  const latencies = [...row.pageLatenciesMs]
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const meanLatencySec = latencies.length
    ? round2(latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000)
    : 0;
  const p95LatencySec = latencies.length
    ? round2(percentileNearestRank(latencies, 95) / 1000)
    : 0;
  return {
    concurrency: row.concurrency,
    pagesPerMinute,
    meanLatencySec,
    p95LatencySec,
    vllm: row.vllm ?? {},
  };
}

/** Nearest-rank percentile over an ASCENDING-sorted array. */
function percentileNearestRank(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index] ?? 0;
}

// ─── Recommendation (the saturation knee) ──────────────────────────────────────

/** Tunables for the knee heuristic, all with sane defaults. */
export interface RecommendInput {
  /**
   * A setting is "over-subscribed" once mean waiting exceeds this. Past that,
   * requests are queuing for a batch slot: more concurrency buys latency, not
   * throughput. Default 1 (any sustained backlog is a warning sign).
   */
  waitingThreshold?: number;
  /**
   * Peak KV-cache usage above which the setting risks thrash/swap. vLLM starts
   * pre-empting near full. Default 0.9 (90 %).
   */
  cacheThreshold?: number;
  /**
   * The relative throughput gain below which a further concurrency step is
   * "not worth it" — the knee. A step from row A to row B that adds less than
   * this fraction of A's throughput is diminishing returns. Default 0.1 (10 %).
   */
  minRelativeGain?: number;
}

export type RecommendReason =
  | "peak-throughput-plateau"
  | "waiting-backlog"
  | "cache-pressure"
  | "single-setting"
  | "no-data";

/** The tool's recommendation: which setting, and the plain-language why. */
export interface Recommendation {
  /** The recommended `PAGE_CONCURRENCY`, or null when there is no usable data. */
  concurrency: number | null;
  reason: RecommendReason;
  /** One-line human explanation grounded in the measured rows. */
  explanation: string;
}

/**
 * Pick the saturation knee from the MEASURED rows. PURE — reads only the
 * numbers the caller measured; if there are none it returns `no-data` rather
 * than inventing a recommendation.
 *
 * The knee is the largest concurrency that still pays its way:
 *  - Walk the rows in ascending concurrency.
 *  - Stop BEFORE a row that shows over-subscription: mean waiting over the
 *    threshold, or peak KV-cache over the threshold. The previous row is the
 *    recommendation (server is saturated but not thrashing).
 *  - Otherwise stop where throughput plateaus: the step to the next row adds
 *    less than `minRelativeGain` — the previous, cheaper setting is preferred.
 *  - If throughput keeps climbing cleanly to the top, recommend the top row.
 *
 * This mirrors the design's "start at the batch share, sweep, watch
 * `num_requests_waiting`/latency, pick the knee".
 */
export function recommendConcurrency(
  rows: readonly SweepRowMetrics[],
  input: RecommendInput = {},
): Recommendation {
  if (rows.length === 0) {
    return {
      concurrency: null,
      reason: "no-data",
      explanation:
        "No measured rows. Run the sweep against a live cluster before recommending a value.",
    };
  }
  const sorted = [...rows].sort((a, b) => a.concurrency - b.concurrency);
  if (sorted.length === 1) {
    const only = sorted[0] as SweepRowMetrics;
    return {
      concurrency: only.concurrency,
      reason: "single-setting",
      explanation: `Only one setting was measured (PAGE_CONCURRENCY=${only.concurrency}); sweep at least three values to locate the knee.`,
    };
  }

  const waitingThreshold = input.waitingThreshold ?? 1;
  const cacheThreshold = input.cacheThreshold ?? 0.9;
  const minRelativeGain = input.minRelativeGain ?? 0.1;

  let best = sorted[0] as SweepRowMetrics;
  for (let i = 1; i < sorted.length; i++) {
    const row = sorted[i] as SweepRowMetrics;
    const waiting = row.vllm.numRequestsWaiting;
    const cache = row.vllm.gpuCacheUsagePerc;
    if (waiting !== undefined && waiting > waitingThreshold) {
      return {
        concurrency: best.concurrency,
        reason: "waiting-backlog",
        explanation: `At PAGE_CONCURRENCY=${row.concurrency} the vLLM queue backed up (mean num_requests_waiting ${waiting} > ${waitingThreshold}); ${best.concurrency} keeps the batch saturated without oversubscribing.`,
      };
    }
    if (cache !== undefined && cache > cacheThreshold) {
      return {
        concurrency: best.concurrency,
        reason: "cache-pressure",
        explanation: `At PAGE_CONCURRENCY=${row.concurrency} peak KV-cache usage reached ${(cache * 100).toFixed(0)}% (> ${(cacheThreshold * 100).toFixed(0)}%), risking preemption/swap; ${best.concurrency} stays clear of thrash.`,
      };
    }
    const gain =
      best.pagesPerMinute > 0
        ? (row.pagesPerMinute - best.pagesPerMinute) / best.pagesPerMinute
        : row.pagesPerMinute > 0
          ? 1
          : 0;
    if (gain < minRelativeGain) {
      return {
        concurrency: best.concurrency,
        reason: "peak-throughput-plateau",
        explanation: `Throughput plateaus after PAGE_CONCURRENCY=${best.concurrency} (${best.pagesPerMinute} pages/min); PAGE_CONCURRENCY=${row.concurrency} adds only ${(gain * 100).toFixed(0)}% for higher latency.`,
      };
    }
    best = row;
  }
  return {
    concurrency: best.concurrency,
    reason: "peak-throughput-plateau",
    explanation: `Throughput kept climbing across the swept range; PAGE_CONCURRENCY=${best.concurrency} was the highest measured (${best.pagesPerMinute} pages/min). Extend the sweep upward to confirm the knee.`,
  };
}

// ─── Report formatting ──────────────────────────────────────────────────────────

/** Render `undefined` as `n/a`, else the number. Used for the server columns. */
function cell(value: number | undefined): string {
  return value === undefined ? "n/a" : String(value);
}

function pct(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(0)}%`;
}

/**
 * The columns of the results table. Server columns show `n/a` when the vLLM
 * `/metrics` endpoint was not provided or a gauge was absent — never a
 * fabricated value.
 */
export const RESULTS_COLUMNS = [
  "PAGE_CONCURRENCY",
  "pages/min",
  "mean latency (s)",
  "p95 latency (s)",
  "vllm running",
  "vllm waiting",
  "kv-cache peak",
] as const;

function rowCells(m: SweepRowMetrics): string[] {
  return [
    String(m.concurrency),
    String(m.pagesPerMinute),
    String(m.meanLatencySec),
    String(m.p95LatencySec),
    cell(m.vllm.numRequestsRunning),
    cell(m.vllm.numRequestsWaiting),
    pct(m.vllm.gpuCacheUsagePerc),
  ];
}

/** Render the measured rows as a GitHub-flavoured Markdown table. PURE. */
export function formatResultsMarkdown(rows: readonly SweepRowMetrics[]): string {
  const sorted = [...rows].sort((a, b) => a.concurrency - b.concurrency);
  const header = `| ${RESULTS_COLUMNS.join(" | ")} |`;
  const divider = `| ${RESULTS_COLUMNS.map(() => "---").join(" | ")} |`;
  const body = sorted.map((m) => `| ${rowCells(m).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

/** Render the measured rows as CSV (RFC-4180-ish, no quoting needed here). PURE. */
export function formatResultsCsv(rows: readonly SweepRowMetrics[]): string {
  const sorted = [...rows].sort((a, b) => a.concurrency - b.concurrency);
  const header = RESULTS_COLUMNS.join(",");
  const body = sorted.map((m) => rowCells(m).join(","));
  return [header, ...body].join("\n");
}

// ─── Small numeric helpers ──────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
