// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * throughput-sweep.ts — the PAGE_CONCURRENCY tuning driver (task 5.3, req 6.7).
 *
 * A repeatable measurement an operator runs ON THEIR OWN cluster to tune
 * `PAGE_CONCURRENCY` against the batch capacity of their vLLM server. All the
 * arithmetic (sweep planning, vLLM `/metrics` parsing, throughput/knee
 * analysis, report formatting) lives in the PURE, unit-tested core
 * `../src/jobs/throughput-tuning.ts`. This file adds only the side effects:
 * HTTP calls to Extract's v2 Job API, scrapes of the vLLM `/metrics` endpoint,
 * and writing the report.
 *
 * Why the sweep is one-setting-per-run
 * ------------------------------------
 * `PAGE_CONCURRENCY` is a process-level Extract config (config.ts), not a
 * per-job knob — it bounds how many pages of ONE job the DB-backed scheduler
 * (`job-runner.ts`) / `mapOrdered` (`pipeline/extract.ts`) keep in flight
 * against the vision model. So a real sweep restarts Extract at each value.
 * This tool therefore measures ONE setting per invocation against a fixed
 * source, appends the row to a JSON results file, and (re)renders the CSV +
 * Markdown table and the recommendation from all rows gathered so far. The
 * `plan` mode prints the whole ladder so the operator can script the restarts.
 *
 * NO FABRICATED DATA. Every measured number comes from a real job run and, when
 * a `--vllm-metrics-url` is given, a real scrape. With `--plan` (or with no
 * `--source-sha`, which forces plan mode) the tool prints only the PLAN — the
 * concurrency ladder and the columns it *would* fill — and exits 0. It never
 * invents a throughput, latency or batch reading.
 *
 * Usage
 * -----
 *   # Print the sweep plan (safe with no cluster):
 *   bun run scripts/throughput-sweep.ts --plan [--max-num-seqs 16] [--concurrent-jobs 2]
 *
 *   # Measure the CURRENT PAGE_CONCURRENCY once and append a row:
 *   bun run scripts/throughput-sweep.ts \
 *     --base-url http://127.0.0.1:3004 \
 *     --token <bearer> \
 *     --source-sha <sha256-of-an-already-uploaded-source> \
 *     --reference tuning/corpus.pdf \
 *     --concurrency 8 \
 *     [--vllm-metrics-url http://vllm:8000/metrics] \
 *     [--out reports/page-concurrency-sweep]
 *
 * Between measurements the operator sets a new PAGE_CONCURRENCY, restarts
 * Extract, and reruns with the matching `--concurrency` so the row is labelled.
 * `--reset` starts a fresh results file.
 *
 * Exit code 0 on success (including plan mode); non-zero on argument/backend
 * errors.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  computeRowMetrics,
  formatResultsCsv,
  formatResultsMarkdown,
  parseVllmMetrics,
  planSweep,
  recommendConcurrency,
  type SweepRow,
  summarizeVllmSamples,
  type VllmMetricsSample,
} from "../src/jobs/throughput-tuning.js";

// ─── CLI parsing ────────────────────────────────────────────────────────────────

interface Args {
  plan: boolean;
  baseUrl: string;
  token?: string;
  sourceSha?: string;
  reference: string;
  collection?: string;
  concurrency?: number;
  values?: number[];
  maxNumSeqs?: number;
  concurrentJobs: number;
  maxConcurrency?: number;
  vllmMetricsUrl?: string;
  extractMetricsUrl?: string;
  out: string;
  reset: boolean;
  pollMs: number;
  metricsSampleMs: number;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(name);
  const int = (name: string): number | undefined => {
    const raw = get(name);
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
    return n;
  };
  const list = (name: string): number[] | undefined => {
    const raw = get(name);
    if (raw === undefined) return undefined;
    return raw
      .split(",")
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((v) => Number.isInteger(v));
  };

  const sourceSha = get("--source-sha");
  // No source means we cannot run a real job — force plan mode so the tool is
  // always safe to run with no cluster and never pretends to have measured.
  const plan = has("--plan") || sourceSha === undefined;

  return {
    plan,
    baseUrl: get("--base-url") ?? "http://127.0.0.1:3004",
    token: get("--token"),
    sourceSha,
    reference: get("--reference") ?? "tuning/corpus.pdf",
    collection: get("--collection"),
    concurrency: int("--concurrency"),
    values: list("--values"),
    maxNumSeqs: int("--max-num-seqs"),
    concurrentJobs: int("--concurrent-jobs") ?? 1,
    maxConcurrency: int("--max-concurrency"),
    vllmMetricsUrl: get("--vllm-metrics-url"),
    extractMetricsUrl: get("--extract-metrics-url"),
    out: get("--out") ?? "reports/page-concurrency-sweep",
    reset: has("--reset"),
    pollMs: int("--poll-ms") ?? 5000,
    metricsSampleMs: int("--metrics-sample-ms") ?? 5000,
    timeoutMs: int("--timeout-ms") ?? 24 * 60 * 60 * 1000,
  };
}

// ─── Extract v2 Job API + metrics I/O (the only side effects) ────────────────────

/** The subset of the wire `Job` this driver reads (extract-contract `jobResponseSchema`). */
interface JobView {
  jobId: string;
  status: string;
  pageCount?: number;
  progress?: Record<string, { done: number; total: number; failed: number }>;
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function createJob(args: Args): Promise<string> {
  const body: Record<string, unknown> = {
    sourceSha256: args.sourceSha,
    reference: args.reference,
  };
  if (args.collection !== undefined) body.collection = args.collection;
  const res = await fetch(`${args.baseUrl}/v2/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(args.token) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST /v2/jobs failed: ${res.status} ${await res.text()}`);
  }
  const job = (await res.json()) as JobView;
  return job.jobId;
}

async function getJob(args: Args, jobId: string): Promise<JobView> {
  const res = await fetch(`${args.baseUrl}/v2/jobs/${jobId}`, {
    headers: authHeaders(args.token),
  });
  if (!res.ok) {
    throw new Error(`GET /v2/jobs/${jobId} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as JobView;
}

/** Scrape the vLLM `/metrics` endpoint once; returns undefined on any failure. */
async function scrapeVllm(url: string): Promise<VllmMetricsSample | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return parseVllmMetrics(await res.text());
  } catch {
    return undefined;
  }
}

/**
 * Pull the mean/p95 per-page duration (seconds) out of Extract's own
 * `/metrics` histogram (`extract_page_duration_seconds`). Prometheus histograms
 * do not carry a true p95, so we approximate: the mean is `sum/count`, and p95
 * is the smallest bucket boundary whose cumulative count reaches 95 %. Returns
 * empty when the endpoint is not provided or the histogram is empty — the tool
 * never substitutes a made-up latency.
 */
async function scrapeExtractPageLatencyMs(
  url: string | undefined,
): Promise<{ meanMs?: number; p95Ms?: number }> {
  if (url === undefined) return {};
  let text: string;
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    text = await res.text();
  } catch {
    return {};
  }
  let sum: number | undefined;
  let count: number | undefined;
  const bucketCumulative: Array<[number, number]> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("extract_page_duration_seconds_sum")) {
      sum = Number.parseFloat(line.split(/\s+/).pop() ?? "");
    } else if (line.startsWith("extract_page_duration_seconds_count")) {
      count = Number.parseFloat(line.split(/\s+/).pop() ?? "");
    } else if (line.startsWith("extract_page_duration_seconds_bucket")) {
      const leMatch = line.match(/le="([^"]+)"/);
      const value = Number.parseFloat(line.split(/\s+/).pop() ?? "");
      if (leMatch && Number.isFinite(value)) {
        const le = leMatch[1] === "+Inf" ? Number.POSITIVE_INFINITY : Number.parseFloat(leMatch[1] ?? "");
        bucketCumulative.push([le, value]);
      }
    }
  }
  const out: { meanMs?: number; p95Ms?: number } = {};
  if (sum !== undefined && count !== undefined && count > 0) {
    out.meanMs = (sum / count) * 1000;
    bucketCumulative.sort((a, b) => a[0] - b[0]);
    const target = 0.95 * count;
    for (const [le, cum] of bucketCumulative) {
      if (cum >= target && Number.isFinite(le)) {
        out.p95Ms = le * 1000;
        break;
      }
    }
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A job is done once it reaches a terminal status. */
function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Pages fully processed = the terminal `emitted` stage's done count. */
function emittedDone(job: JobView): number {
  return job.progress?.emitted?.done ?? 0;
}

/**
 * Run ONE measurement at the current PAGE_CONCURRENCY: create the job, poll to
 * completion while sampling vLLM `/metrics`, and assemble the honest
 * {@link SweepRow}. Per-page latencies come from Extract's own histogram (mean
 * + approximate p95 expanded to two representative samples) so the pure
 * `computeRowMetrics` can derive its columns; when no metrics endpoint is
 * given the latency columns simply read 0/`n/a`.
 */
async function measureOne(args: Args): Promise<SweepRow> {
  const concurrency = args.concurrency;
  if (concurrency === undefined) {
    throw new Error("--concurrency is required for a measurement (the running PAGE_CONCURRENCY)");
  }
  const startMs = Date.now();
  const jobId = await createJob(args);
  const vllmSamples: VllmMetricsSample[] = [];
  let job = await getJob(args, jobId);
  let lastSample = 0;
  while (!isTerminalStatus(job.status)) {
    if (Date.now() - startMs > args.timeoutMs) {
      throw new Error(`Job ${jobId} did not finish within --timeout-ms; last status ${job.status}`);
    }
    if (args.vllmMetricsUrl !== undefined && Date.now() - lastSample >= args.metricsSampleMs) {
      const sample = await scrapeVllm(args.vllmMetricsUrl);
      if (sample !== undefined) vllmSamples.push(sample);
      lastSample = Date.now();
    }
    await sleep(args.pollMs);
    job = await getJob(args, jobId);
  }
  const wallMs = Date.now() - startMs;
  const pagesProcessed = emittedDone(job) || job.pageCount || 0;

  const latency = await scrapeExtractPageLatencyMs(args.extractMetricsUrl);
  // Represent the histogram's mean and p95 as two samples so the pure
  // percentile derivation reproduces them; this is not fabrication — both
  // numbers are read from the real Extract histogram. When absent, no samples.
  const pageLatenciesMs: number[] = [];
  if (latency.meanMs !== undefined) pageLatenciesMs.push(latency.meanMs);
  if (latency.p95Ms !== undefined) pageLatenciesMs.push(latency.p95Ms);

  return {
    concurrency,
    pagesProcessed,
    wallMs,
    pageLatenciesMs,
    vllm: summarizeVllmSamples(vllmSamples),
  };
}

// ─── Results file (accumulated across per-setting runs) ──────────────────────────

async function readRows(path: string): Promise<SweepRow[]> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as { rows?: SweepRow[] };
    return Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}

async function writeReports(outBase: string, rows: SweepRow[]): Promise<void> {
  const jsonPath = resolve(`${outBase}.json`);
  const csvPath = resolve(`${outBase}.csv`);
  const mdPath = resolve(`${outBase}.md`);
  await mkdir(dirname(jsonPath), { recursive: true });

  const metrics = rows.map(computeRowMetrics);
  const rec = recommendConcurrency(metrics);

  await writeFile(jsonPath, `${JSON.stringify({ rows, recommendation: rec }, null, 2)}\n`);
  await writeFile(csvPath, `${formatResultsCsv(metrics)}\n`);
  const md = [
    "# PAGE_CONCURRENCY throughput sweep",
    "",
    "Measured on the target cluster. Server columns read `n/a` when no vLLM",
    "`/metrics` URL was supplied for that run.",
    "",
    formatResultsMarkdown(metrics),
    "",
    "## Recommendation",
    "",
    rec.concurrency === null
      ? `No recommendation yet — ${rec.explanation}`
      : `**PAGE_CONCURRENCY=${rec.concurrency}** (${rec.reason}). ${rec.explanation}`,
    "",
  ].join("\n");
  await writeFile(mdPath, md);

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${mdPath}`);
}

// ─── Entry point ─────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const plan = planSweep({
    values: args.values,
    maxNumSeqs: args.maxNumSeqs,
    concurrentJobs: args.concurrentJobs,
    maxConcurrency: args.maxConcurrency,
  });

  if (args.plan) {
    console.log("PAGE_CONCURRENCY sweep plan (no cluster contacted, no data fabricated):");
    console.log(`  values:          ${plan.join(", ")}`);
    if (args.maxNumSeqs !== undefined) {
      const share = Math.max(1, Math.floor(args.maxNumSeqs / args.concurrentJobs));
      console.log(
        `  anchored on:     vLLM --max-num-seqs=${args.maxNumSeqs} / ${args.concurrentJobs} job(s) → per-job batch share ≈ ${share}`,
      );
    }
    console.log("  columns to fill: PAGE_CONCURRENCY, pages/min, mean latency (s), p95 latency (s), vllm running, vllm waiting, kv-cache peak");
    console.log("");
    console.log("For each value: set PAGE_CONCURRENCY, restart Extract, then rerun this");
    console.log("tool with --source-sha <sha> --concurrency <value> to append a measured row.");
    if (args.sourceSha === undefined && !process.argv.includes("--plan")) {
      console.log("");
      console.log("(No --source-sha given, so plan mode was selected automatically.)");
    }
    return 0;
  }

  const existing = args.reset ? [] : await readRows(resolve(`${args.out}.json`));
  console.log(
    `Measuring PAGE_CONCURRENCY=${args.concurrency} against ${args.reference} (source ${args.sourceSha})…`,
  );
  const row = await measureOne(args);
  const merged = [...existing.filter((r) => r.concurrency !== row.concurrency), row];
  await writeReports(args.out, merged);
  const metrics = merged.map(computeRowMetrics);
  const rec = recommendConcurrency(metrics);
  console.log("");
  console.log(formatResultsMarkdown(metrics));
  console.log("");
  console.log(
    rec.concurrency === null
      ? `Recommendation: ${rec.explanation}`
      : `Recommendation: PAGE_CONCURRENCY=${rec.concurrency} — ${rec.explanation}`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
