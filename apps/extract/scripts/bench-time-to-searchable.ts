// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * bench-time-to-searchable.ts — how soon do the first pages become searchable
 * once a job hands its staged document to Search?
 *
 * Runs the REAL emitter (`createEmitter`) against the in-memory job store the
 * tests use and a simulated Search whose calls take a configurable time, then
 * reports, per `EMIT_BATCH_PAGES` / `SEGMENT_PAGES` setting:
 *
 *   first searchable   time from the start of the hand-over to the first
 *                      segment commit Search acknowledged — the moment a
 *                      `progressive` revision's first pages can be found — and
 *                      how many pages that made visible
 *   all searchable     time to the final commit
 *
 * What it does NOT measure: the processing phase before the hand-over (render,
 * vision, document pass). That phase still runs for the whole document first;
 * this benchmark covers the part the emitter owns. Latencies are simulated
 * (defaults below are a plausible LAN Search with a small embedding queue), so
 * absolute milliseconds are illustrative; the point of the benchmark is the
 * comparison between settings under the SAME latencies, and between two
 * emitter versions under the same settings.
 *
 * Usage
 * -----
 *   bun run scripts/bench-time-to-searchable.ts [--pages 600]
 *       [--scenarios 20/250,10/50] [--batch-ms 40] [--page-ms 3]
 *       [--segment-ms 120] [--commit-ms 300] [--asset-ms 15]
 *       [--out report.md]
 *
 * `--scenarios` is a comma list of `<EMIT_BATCH_PAGES>/<SEGMENT_PAGES>`.
 * To compare against an older emitter, run the same command from a checkout of
 * that version (the script uses only `createEmitter`'s public inputs).
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import pino from "pino";
import { createLeaseGuard } from "../src/jobs/lease.js";
import { createEmitter, type AssetLoader } from "../src/jobs/emitter.js";
import type { RevisionClient } from "../src/revision-client.js";
import { createFakeJobStore } from "../tests/job-store-fake.js";

interface Args {
  pages: number;
  scenarios: Array<{ batch: number; segment: number }>;
  batchMs: number;
  pageMs: number;
  segmentMs: number;
  commitMs: number;
  assetMs: number;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    pages: 600,
    scenarios: [{ batch: 20, segment: 250 }, { batch: 10, segment: 50 }],
    batchMs: 40,
    pageMs: 3,
    segmentMs: 120,
    commitMs: 300,
    assetMs: 15,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    const number = (min: number): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${flag} needs a number >= ${min}`);
      return parsed;
    };
    if (flag === "--pages") args.pages = Math.trunc(number(1));
    else if (flag === "--batch-ms") args.batchMs = number(0);
    else if (flag === "--page-ms") args.pageMs = number(0);
    else if (flag === "--segment-ms") args.segmentMs = number(0);
    else if (flag === "--commit-ms") args.commitMs = number(0);
    else if (flag === "--asset-ms") args.assetMs = number(0);
    else if (flag === "--out") args.out = value;
    else if (flag === "--scenarios") {
      args.scenarios = value.split(",").map((part) => {
        const [batch, segment] = part.split("/").map((n) => Number(n.trim()));
        if (!Number.isInteger(batch) || !Number.isInteger(segment) || (batch ?? 0) < 1 || (segment ?? 0) < (batch ?? 1)) {
          throw new Error(`bad scenario "${part}": expected <batch>/<segment> with segment >= batch`);
        }
        return { batch: batch as number, segment: segment as number };
      });
    } else throw new Error(`unknown argument ${flag}`);
    i++;
  }
  return args;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Result {
  batch: number;
  segment: number;
  batches: number;
  segmentCommits: number;
  firstMs: number;
  firstPages: number;
  allMs: number;
}

async function runScenario(args: Args, batch: number, segment: number): Promise<Result> {
  const logger = pino({ level: "silent" });
  const store = createFakeJobStore();
  const reference = "bench/handbuch.pdf";
  const id = randomUUID();
  await store.createJob({ id, reference, source_sha256: "a".repeat(64), collection: "documents" });
  const claimed = await store.claimNextJob("bench", 600);
  if (claimed === null) throw new Error("no claim");
  await store.setJobPageCount(id, args.pages);
  await store.setJobStatus(id, "emitting");
  for (let page = 1; page <= args.pages; page++) {
    await store.stageEmitBatch({
      job_id: id,
      seq: page,
      digest: `d${page}`,
      page_from: page,
      page_to: page,
      payload: {
        type: "page",
        page,
        record: {
          type: "page",
          page,
          size: { wPt: 595, hPt: 842 },
          class: "text",
          blocks: [{ id: `p${page}-b0`, page, type: "paragraph", source: "text-layer", text: `Seite ${page}` }],
          assets: [],
          warnings: [],
        },
      },
    });
    await store.stageAsset({
      job_id: id,
      asset_id: `asset-${page}`,
      variant: "page",
      mime_type: "image/png",
      checksum: "0".repeat(64),
      page,
    });
  }
  const job = await store.getJob(id);
  if (job === null) throw new Error("job vanished");

  // The simulated Search: acceptance state plus per-call latency.
  const accepted = new Set<number>();
  const committed: number[] = [];
  let started = 0;
  let firstMs = Number.NaN;
  let firstPages = 0;
  let segmentCommits = 0;
  let batchPuts = 0;
  let maxAcceptedPage = 0;
  const revisionId = "bench-rev";
  const search: RevisionClient = {
    async createRevision() {
      return { revisionId, reference, status: "staging", visibility: "progressive", createdAt: new Date().toISOString() };
    },
    async getState() {
      return {
        revisionId,
        reference,
        status: "staging",
        visibility: "progressive",
        acceptedBatches: [...accepted].sort((a, b) => a - b),
        processedPages: [],
        missingAssets: [],
        committedSegments: [...committed],
      };
    },
    async putBatch(call) {
      const pages = new TextDecoder().decode(call.body).split("\n").filter((line) => line.includes('"type":"page"')).length;
      await sleep(args.batchMs + args.pageMs * pages);
      batchPuts++;
      accepted.add(call.seq);
      maxAcceptedPage = Math.max(maxAcceptedPage, call.seq * batch + batch);
      return { seq: call.seq, digest: call.contentDigest, status: "received", noop: false };
    },
    async headAsset() {
      return false;
    },
    async putAsset() {
      await sleep(args.assetMs);
    },
    async commitSegment(call) {
      await sleep(args.segmentMs);
      segmentCommits++;
      committed.push(call.segment);
      if (Number.isNaN(firstMs)) {
        firstMs = performance.now() - started;
        // Everything accepted so far is visible under a progressive revision.
        firstPages = Math.min(args.pages, maxAcceptedPage);
      }
      return { reference, revisionId, committed: true, segment: call.segment, missingRanges: [] };
    },
    async commit() {
      await sleep(args.commitMs);
      return { reference, revisionId, committed: true, isLatest: true, missingRanges: [] };
    },
  };
  const assets: AssetLoader = {
    async load(row) {
      return {
        assetId: row.asset_id,
        buffer: new Uint8Array(8),
        mimeType: "image/png",
        checksum: row.checksum ?? "0".repeat(64),
        kind: "page",
      };
    },
  };
  const emitter = createEmitter({
    store,
    revisions: search,
    config: {
      emitBatchPages: batch,
      segmentPages: segment,
      assetUploadConcurrency: 4,
      finalizePass: false,
      contract: "atf-extract/2.4.0",
      visionModel: "bench",
      renderDpi: 200,
    },
    logger,
  });
  const lease = createLeaseGuard(store, { jobId: id, holder: "bench", epoch: Number(job.lease_epoch) }, 600);
  started = performance.now();
  const outcome = await emitter.emit(job, lease, assets);
  const allMs = performance.now() - started;
  if (outcome.status !== "committed") throw new Error(`emit ended ${outcome.status}`);
  // A setting whose segments never complete (SEGMENT_PAGES > pages) is searchable only at the final commit.
  if (Number.isNaN(firstMs)) {
    firstMs = allMs;
    firstPages = args.pages;
  }
  return {
    batch,
    segment,
    batches: batchPuts,
    segmentCommits,
    firstMs,
    firstPages,
    allMs,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const results: Result[] = [];
  for (const scenario of args.scenarios) results.push(await runScenario(args, scenario.batch, scenario.segment));
  const lines = [
    `Time-to-searchable benchmark (hand-over to Search): ${args.pages} pages, 1 asset/page, simulated Search latency:`,
    `batch ${args.batchMs} ms + ${args.pageMs} ms/page, segment commit ${args.segmentMs} ms, final commit ${args.commitMs} ms, asset PUT ${args.assetMs} ms (4 parallel)`,
    "",
    "| EMIT_BATCH_PAGES/SEGMENT_PAGES | batch PUTs | segment commits | first searchable | pages then searchable | all searchable | first / all |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map(
      (r) =>
        `| ${r.batch}/${r.segment} | ${r.batches} | ${r.segmentCommits} | ${r.firstMs.toFixed(0)} ms | ${r.firstPages} | ${r.allMs.toFixed(0)} ms | ${((r.firstMs / r.allMs) * 100).toFixed(0)} % |`,
    ),
    "",
  ];
  const report = lines.join("\n");
  process.stdout.write(`${report}\n`);
  if (args.out !== undefined) await writeFile(args.out, report, "utf8");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
