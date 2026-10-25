// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * throughput-tuning.test.ts
 *
 * Unit + property tests for the PURE core of the PAGE_CONCURRENCY tuning tool
 * the sweep planner, the vLLM `/metrics` parser,
 * the per-setting throughput/latency derivation, the saturation-knee
 * recommender, and the CSV/Markdown formatters. Everything here runs offline —
 * no cluster, no network — which is exactly the guarantee the tool must uphold.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeRowMetrics,
  formatResultsCsv,
  formatResultsMarkdown,
  PAGE_CONCURRENCY_MAX,
  parseVllmMetrics,
  planSweep,
  recommendConcurrency,
  RESULTS_COLUMNS,
  type SweepRow,
  type SweepRowMetrics,
  summarizeVllmSamples,
  type VllmMetricsSample,
} from "../src/jobs/throughput-tuning.js";

describe("planSweep", () => {
  it("uses the default geometric ladder with no input", () => {
    expect(planSweep()).toEqual([1, 2, 4, 8, 16]);
  });

  it("honours explicit values, sanitised, deduped and sorted", () => {
    expect(planSweep({ values: [8, 2, 2, 4, 1] })).toEqual([1, 2, 4, 8]);
  });

  it("clamps explicit values into [1, ceiling]", () => {
    expect(planSweep({ values: [0, -5, 3, 999], maxConcurrency: 32 })).toEqual([1, 3, 32]);
  });

  it("never exceeds the config ceiling of 64", () => {
    expect(planSweep({ values: [128] })).toEqual([PAGE_CONCURRENCY_MAX]);
  });

  it("brackets the per-job batch share when maxNumSeqs is known", () => {
    // 16 seqs / 1 job → share 16: ladder 1,2,4,8,16 plus one step past (32).
    expect(planSweep({ maxNumSeqs: 16 })).toEqual([1, 2, 4, 8, 16, 32]);
  });

  it("divides the batch share across concurrent jobs", () => {
    // 16 seqs / 2 jobs → share 8: ladder 1,2,4,8 plus one step past (16).
    expect(planSweep({ maxNumSeqs: 16, concurrentJobs: 2 })).toEqual([1, 2, 4, 8, 16]);
  });

  it("includes a non-power-of-two share and its one-step-past value", () => {
    // 12 seqs / 1 job → share 12: powers 1,2,4,8 + share 12 + past 24.
    expect(planSweep({ maxNumSeqs: 12 })).toEqual([1, 2, 4, 8, 12, 24]);
  });

  it("always returns a non-empty ascending unique plan (property)", () => {
    fc.assert(
      fc.property(
        fc.record({
          values: fc.option(fc.array(fc.integer({ min: -10, max: 200 }), { maxLength: 12 }), {
            nil: undefined,
          }),
          maxNumSeqs: fc.option(fc.integer({ min: 1, max: 256 }), { nil: undefined }),
          concurrentJobs: fc.option(fc.integer({ min: 1, max: 8 }), { nil: undefined }),
          maxConcurrency: fc.option(fc.integer({ min: 1, max: 64 }), { nil: undefined }),
        }),
        (input) => {
          const plan = planSweep(input);
          expect(plan.length).toBeGreaterThan(0);
          const ceiling = input.maxConcurrency ?? PAGE_CONCURRENCY_MAX;
          for (let i = 0; i < plan.length; i++) {
            const v = plan[i] as number;
            expect(Number.isInteger(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(1);
            expect(v).toBeLessThanOrEqual(ceiling);
            if (i > 0) expect(v).toBeGreaterThan(plan[i - 1] as number);
          }
        },
      ),
    );
  });
});

describe("parseVllmMetrics", () => {
  it("reads the four batch gauges from a Prometheus body with labels", () => {
    const body = [
      "# HELP vllm:num_requests_running Number of requests currently running.",
      "# TYPE vllm:num_requests_running gauge",
      'vllm:num_requests_running{model_name="Qwen2-VL"} 12',
      'vllm:num_requests_waiting{model_name="Qwen2-VL"} 0',
      'vllm:num_requests_swapped{model_name="Qwen2-VL"} 0',
      'vllm:gpu_cache_usage_perc{model_name="Qwen2-VL"} 0.63',
    ].join("\n");
    expect(parseVllmMetrics(body)).toEqual({
      numRequestsRunning: 12,
      numRequestsWaiting: 0,
      numRequestsSwapped: 0,
      gpuCacheUsagePerc: 0.63,
    });
  });

  it("reads gauges without labels", () => {
    const body = ["vllm:num_requests_running 8", "vllm:num_requests_waiting 3"].join("\n");
    expect(parseVllmMetrics(body)).toEqual({
      numRequestsRunning: 8,
      numRequestsWaiting: 3,
    });
  });

  it("ignores a longer metric that merely shares a prefix", () => {
    const body = [
      "vllm:num_requests_running_total 999",
      'vllm:num_requests_running{model_name="m"} 5',
    ].join("\n");
    expect(parseVllmMetrics(body).numRequestsRunning).toBe(5);
  });

  it("ignores an optional trailing timestamp", () => {
    const body = 'vllm:num_requests_waiting{model_name="m"} 4 1700000000000';
    expect(parseVllmMetrics(body).numRequestsWaiting).toBe(4);
  });

  it("leaves absent gauges undefined (never fabricates)", () => {
    const body = "vllm:num_requests_running 2";
    const sample = parseVllmMetrics(body);
    expect(sample.numRequestsRunning).toBe(2);
    expect(sample.numRequestsWaiting).toBeUndefined();
    expect(sample.gpuCacheUsagePerc).toBeUndefined();
  });

  it("returns an empty sample for an empty or comment-only body", () => {
    expect(parseVllmMetrics("")).toEqual({});
    expect(parseVllmMetrics("# HELP foo bar\n# TYPE foo gauge")).toEqual({});
  });
});

describe("summarizeVllmSamples", () => {
  it("means running/waiting/swapped and peaks the cache", () => {
    const samples: VllmMetricsSample[] = [
      { numRequestsRunning: 8, numRequestsWaiting: 0, gpuCacheUsagePerc: 0.5 },
      { numRequestsRunning: 12, numRequestsWaiting: 2, gpuCacheUsagePerc: 0.8 },
      { numRequestsRunning: 10, numRequestsWaiting: 1, gpuCacheUsagePerc: 0.6 },
    ];
    const summary = summarizeVllmSamples(samples);
    expect(summary.numRequestsRunning).toBe(10);
    expect(summary.numRequestsWaiting).toBe(1);
    expect(summary.gpuCacheUsagePerc).toBe(0.8); // peak, not mean
  });

  it("returns {} for no samples", () => {
    expect(summarizeVllmSamples([])).toEqual({});
  });

  it("skips a field that is absent from every sample", () => {
    const summary = summarizeVllmSamples([{ numRequestsRunning: 4 }, { numRequestsRunning: 6 }]);
    expect(summary.numRequestsRunning).toBe(5);
    expect(summary.numRequestsWaiting).toBeUndefined();
  });
});

describe("computeRowMetrics", () => {
  it("derives pages/min and latency percentiles", () => {
    const row: SweepRow = {
      concurrency: 8,
      pagesProcessed: 60,
      wallMs: 120_000, // 2 minutes → 30 pages/min
      pageLatenciesMs: [1000, 2000, 3000, 4000, 100_000],
    };
    const m = computeRowMetrics(row);
    expect(m.pagesPerMinute).toBe(30);
    expect(m.meanLatencySec).toBe(22); // (110000/5)/1000
    expect(m.p95LatencySec).toBe(100); // nearest-rank p95 of 5 samples = max
  });

  it("yields zeros (not NaN) for a degenerate empty run", () => {
    const m = computeRowMetrics({
      concurrency: 1,
      pagesProcessed: 0,
      wallMs: 0,
      pageLatenciesMs: [],
    });
    expect(m.pagesPerMinute).toBe(0);
    expect(m.meanLatencySec).toBe(0);
    expect(m.p95LatencySec).toBe(0);
  });

  it("carries the vLLM summary through untouched", () => {
    const m = computeRowMetrics({
      concurrency: 4,
      pagesProcessed: 10,
      wallMs: 60_000,
      pageLatenciesMs: [5000],
      vllm: { numRequestsRunning: 4, numRequestsWaiting: 0 },
    });
    expect(m.vllm).toEqual({ numRequestsRunning: 4, numRequestsWaiting: 0 });
  });
});

// A small helper to build metrics rows for the recommender tests.
function metric(
  concurrency: number,
  pagesPerMinute: number,
  vllm: VllmMetricsSample = {},
): SweepRowMetrics {
  return { concurrency, pagesPerMinute, meanLatencySec: 0, p95LatencySec: 0, vllm };
}

describe("recommendConcurrency", () => {
  it("returns no-data for an empty set", () => {
    const rec = recommendConcurrency([]);
    expect(rec.concurrency).toBeNull();
    expect(rec.reason).toBe("no-data");
  });

  it("flags a single measured setting as insufficient", () => {
    const rec = recommendConcurrency([metric(4, 20)]);
    expect(rec.concurrency).toBe(4);
    expect(rec.reason).toBe("single-setting");
  });

  it("picks the knee where throughput plateaus", () => {
    // 1→10, 2→19 (+90%), 4→30 (+58%), 8→32 (+7% < 10% → plateau at 4).
    const rec = recommendConcurrency([
      metric(1, 10),
      metric(2, 19),
      metric(4, 30),
      metric(8, 32),
    ]);
    expect(rec.concurrency).toBe(4);
    expect(rec.reason).toBe("peak-throughput-plateau");
  });

  it("stops before a setting whose vLLM queue backs up", () => {
    const rec = recommendConcurrency([
      metric(4, 20, { numRequestsWaiting: 0 }),
      metric(8, 38, { numRequestsWaiting: 0 }),
      metric(16, 41, { numRequestsWaiting: 6 }), // backlog
    ]);
    expect(rec.concurrency).toBe(8);
    expect(rec.reason).toBe("waiting-backlog");
  });

  it("stops before KV-cache thrash even if throughput still climbs", () => {
    const rec = recommendConcurrency([
      metric(4, 20, { gpuCacheUsagePerc: 0.5 }),
      metric(8, 40, { gpuCacheUsagePerc: 0.7 }),
      metric(16, 60, { gpuCacheUsagePerc: 0.95 }), // over 0.9
    ]);
    expect(rec.concurrency).toBe(8);
    expect(rec.reason).toBe("cache-pressure");
  });

  it("recommends the top setting when throughput keeps climbing cleanly", () => {
    const rec = recommendConcurrency([
      metric(1, 10),
      metric(2, 20),
      metric(4, 40),
    ]);
    expect(rec.concurrency).toBe(4);
    expect(rec.reason).toBe("peak-throughput-plateau");
  });
});

describe("formatters", () => {
  const rows: SweepRowMetrics[] = [
    {
      concurrency: 8,
      pagesPerMinute: 38,
      meanLatencySec: 12.5,
      p95LatencySec: 20,
      vllm: { numRequestsRunning: 8, numRequestsWaiting: 0, gpuCacheUsagePerc: 0.7 },
    },
    {
      concurrency: 4,
      pagesPerMinute: 20,
      meanLatencySec: 11,
      p95LatencySec: 18,
      vllm: {},
    },
  ];

  it("renders a markdown table sorted by concurrency with n/a for missing metrics", () => {
    const md = formatResultsMarkdown(rows);
    const lines = md.split("\n");
    expect(lines[0]).toContain(RESULTS_COLUMNS[0]);
    // First data row is concurrency 4 (sorted), with n/a server columns.
    expect(lines[2]).toBe("| 4 | 20 | 11 | 18 | n/a | n/a | n/a |");
    // Second data row is concurrency 8 with a 70% cache cell.
    expect(lines[3]).toBe("| 8 | 38 | 12.5 | 20 | 8 | 0 | 70% |");
  });

  it("renders CSV with the same column order", () => {
    const csv = formatResultsCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(RESULTS_COLUMNS.join(","));
    expect(lines[1]).toBe("4,20,11,18,n/a,n/a,n/a");
    expect(lines[2]).toBe("8,38,12.5,20,8,0,70%");
  });
});
