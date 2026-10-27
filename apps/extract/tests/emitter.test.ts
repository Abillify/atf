// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * emitter.test.ts
 *
 * The outbox emitter (task 1.12, requirements 5.7, 6.3): it streams a job's
 * staged pages and crops to Search's revision API, records the outbox
 * `pending → sent → acked`, and reconciles against the server's revision state
 * on resume so it re-sends exactly the missing parts.
 *
 * Driven against the in-memory fake store and a fake RevisionClient that models
 * Search's acceptance state — no HTTP, no database, no model.
 *
 * Covers:
 *  - batches recorded pending → sent → acked in seq order; final commit
 *  - a resume GETs the revision state and re-sends ONLY the missing batches and
 *    assets (an accepted seq is skipped, a present asset is skipped)
 *  - asset upload respects ASSET_UPLOAD_CONCURRENCY
 *  - a segment commit fires every SEGMENT_PAGES pages; the final commit closes
 *  - a mid-emit failure leaves the outbox in a state a resume completes without
 *    duplicates or loss
 */

import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAssetId, figureLocalId, pageLocalId, type PageRecord } from "@atf/extract-contract";
import type {
  BatchAck,
  CommitResult,
  Revision,
  RevisionState,
} from "@atf/extract-contract/v2";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger } from "./helpers.js";
import { createLeaseGuard } from "../src/jobs/lease.js";
import { contentDigestHeader, createEmitter, type AssetLoader } from "../src/jobs/emitter.js";
import type { RevisionClient, AssetBody } from "../src/revision-client.js";
import { RevisionTransientError } from "../src/revision-client.js";
import type { JobRow, AssetOutboxRow } from "../src/persistence/types.js";

const REFERENCE = "tests/handbuch.pdf";
const SOURCE_SHA = "a".repeat(64);

/** A fake Search revision server, modelling the acceptance state the emitter reconciles against. */
interface FakeSearch extends RevisionClient {
  /** Batch seqs the server has accepted. */
  accepted: Set<number>;
  /** Asset ids the server has stored. */
  storedAssets: Set<string>;
  /** Segment numbers committed. */
  committedSegments: number[];
  /** Whether the final commit succeeded. */
  finalCommitted: boolean;
  /** Recorded PUT batch calls, in order. */
  batchPuts: number[];
  /** Recorded asset PUT calls, in order. */
  assetPuts: string[];
  /** Peak concurrent asset uploads observed. */
  peakAssetConcurrency: number;
  /** Everything the server saw, in order: `put:<seq>`, `asset:<id>`, `segment:<n>`, `commit`. */
  timeline: string[];
  /** The NDJSON body of each accepted batch seq, decoded. */
  bodies: Map<number, Record<string, unknown>[]>;
}

interface FakeSearchOptions {
  /** Batch seqs pre-accepted (a resume scenario). */
  preAccepted?: number[];
  /** Asset ids the server already holds (a resume scenario). */
  preStored?: string[];
  /** A hook to fail the first N batch PUTs transiently. */
  failBatchPutsBefore?: number;
  /** Delay each asset PUT so overlap is observable, in ms. */
  assetDelayMs?: number;
  /** All asset ids the server would report missing until stored. */
  knownAssets?: string[];
}

function createFakeSearch(options: FakeSearchOptions = {}): FakeSearch {
  const accepted = new Set<number>(options.preAccepted ?? []);
  const storedAssets = new Set<string>(options.preStored ?? []);
  const knownAssets = new Set<string>(options.knownAssets ?? []);
  const committedSegments: number[] = [];
  const timeline: string[] = [];
  const bodies = new Map<number, Record<string, unknown>[]>();
  const batchPuts: number[] = [];
  const assetPuts: string[] = [];
  let inFlightAssets = 0;
  let peakAssetConcurrency = 0;
  let batchPutCount = 0;
  const revisionId = "rev-fixed";

  const fake: FakeSearch = {
    accepted,
    storedAssets,
    committedSegments,
    finalCommitted: false,
    batchPuts,
    assetPuts,
    peakAssetConcurrency: 0,
    timeline,
    bodies,
    async createRevision(): Promise<Revision> {
      return {
        revisionId,
        reference: REFERENCE,
        status: "staging",
        visibility: "progressive",
        createdAt: new Date().toISOString(),
      };
    },

    async getState(): Promise<RevisionState> {
      const missingAssets = [...knownAssets].filter((id) => !storedAssets.has(id));
      return {
        revisionId,
        reference: REFERENCE,
        status: "staging",
        visibility: "progressive",
        acceptedBatches: [...accepted].sort((a, b) => a - b),
        processedPages: [],
        missingAssets,
        committedSegments: [...committedSegments],
      };
    },

    async putBatch(args): Promise<BatchAck> {
      batchPutCount++;
      if (options.failBatchPutsBefore !== undefined && batchPutCount <= options.failBatchPutsBefore) {
        throw new RevisionTransientError("simulated network error");
      }
      batchPuts.push(args.seq);
      timeline.push(`put:${args.seq}`);
      bodies.set(
        args.seq,
        new TextDecoder()
          .decode(args.body)
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
      const noop = accepted.has(args.seq);
      accepted.add(args.seq);
      return { seq: args.seq, digest: args.contentDigest, status: "received", noop };
    },

    async headAsset(args): Promise<boolean> {
      return storedAssets.has(args.assetId);
    },

    async putAsset(args): Promise<void> {
      inFlightAssets++;
      peakAssetConcurrency = Math.max(peakAssetConcurrency, inFlightAssets);
      fake.peakAssetConcurrency = peakAssetConcurrency;
      if (options.assetDelayMs) await new Promise((r) => setTimeout(r, options.assetDelayMs));
      assetPuts.push(args.asset.assetId);
      timeline.push(`asset:${args.asset.assetId}`);
      storedAssets.add(args.asset.assetId);
      inFlightAssets--;
    },

    async commitSegment(args): Promise<CommitResult> {
      committedSegments.push(args.segment);
      timeline.push(`segment:${args.segment}`);
      return {
        reference: REFERENCE,
        revisionId,
        committed: true,
        segment: args.segment,
        missingRanges: [],
      };
    },

    async commit(): Promise<CommitResult> {
      fake.finalCommitted = true;
      timeline.push("commit");
      return { reference: REFERENCE, revisionId, committed: true, isLatest: true, missingRanges: [] };
    },
  };
  return fake;
}

/** An AssetLoader that returns plausible bytes for every requested row. */
function fakeAssetLoader(): AssetLoader {
  return {
    async load(row: AssetOutboxRow): Promise<AssetBody> {
      const buffer = new TextEncoder().encode(`bytes:${row.asset_id}`);
      return {
        assetId: row.asset_id,
        buffer,
        mimeType: row.mime_type ?? "image/png",
        checksum: row.checksum ?? "0".repeat(64),
        kind: row.variant === "page" ? "page" : "figure",
      };
    },
  };
}

/** Seed a claimed, emitting-ready job with `pageCount` staged pages. */
async function seedEmittingJob(
  store: FakeJobStore,
  pageCount: number,
  options: {
    figuresOnPages?: number[];
    /** First staged page (a `pages` window); `pageCount` pages are staged from it. */
    firstPage?: number;
    config?: Record<string, unknown>;
    revisionId?: string;
  } = {},
): Promise<JobRow> {
  const id = randomUUID();
  const firstPage = options.firstPage ?? 1;
  await store.createJob({
    id,
    reference: REFERENCE,
    source_sha256: SOURCE_SHA,
    collection: "documents",
    config: {
      ...(firstPage > 1 ? { pageWindow: { first: firstPage, last: firstPage + pageCount - 1 } } : {}),
      ...(options.config ?? {}),
    },
  });
  const claimed = await store.claimNextJob("worker-1", 60);
  if (claimed === null) throw new Error("expected a claim");
  await store.setJobPageCount(id, pageCount);
  await store.setJobStatus(id, "emitting");

  const figures = new Set(options.figuresOnPages ?? []);
  if (options.revisionId !== undefined) await store.setJobRevision(id, options.revisionId, { jobId: id, holder: "worker-1", epoch: Number(claimed.lease_epoch) });
  for (let page = firstPage; page < firstPage + pageCount; page++) {
    const record = buildPageRecord(page, figures.has(page));
    const payload = { type: "page", page, record };
    await store.stageEmitBatch({
      job_id: id,
      seq: page,
      digest: `d${page}`,
      page_from: page,
      page_to: page,
      payload,
    });
    // Page image asset, always.
    await store.stageAsset({
      job_id: id,
      asset_id: buildAssetId(REFERENCE, pageLocalId(page)),
      variant: "page",
      mime_type: "image/png",
      checksum: "0".repeat(64),
      page,
    });
    if (figures.has(page)) {
      await store.stageAsset({
        job_id: id,
        asset_id: buildAssetId(REFERENCE, figureLocalId(`p${page}-f1`)),
        variant: null,
        mime_type: "image/png",
        checksum: "1".repeat(64),
        page,
      });
    }
  }
  const fresh = await store.getJob(id);
  if (fresh === null) throw new Error("job vanished");
  return fresh;
}

function buildPageRecord(page: number, hasFigure: boolean): PageRecord {
  const assets: PageRecord["assets"] = [
    { assetId: buildAssetId(REFERENCE, pageLocalId(page)), kind: "page", localId: pageLocalId(page), page },
  ];
  if (hasFigure) {
    assets.unshift({
      assetId: buildAssetId(REFERENCE, figureLocalId(`p${page}-f1`)),
      kind: "figure",
      localId: figureLocalId(`p${page}-f1`),
      page,
    });
  }
  return {
    type: "page",
    page,
    size: { wPt: 100, hPt: 140 },
    class: "text",
    blocks: [{ id: `p${page}-b0`, page, type: "paragraph", source: "text-layer", text: `Seite ${page}` }],
    assets,
    warnings: [],
  };
}

function makeEmitter(
  store: FakeJobStore,
  search: RevisionClient,
  emitBatchPages = 2,
  segmentPages = 4,
  finalizePass = true,
) {
  return createEmitter({
    store,
    revisions: search,
    config: {
      emitBatchPages,
      segmentPages,
      assetUploadConcurrency: 2,
      finalizePass,
      contract: "atf-extract/2.0.0",
      visionModel: "test-vlm",
      renderDpi: 200,
    },
    logger: testLogger,
  });
}

function leaseFor(store: FakeJobStore, job: JobRow) {
  return createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
}

describe("emitter · batches recorded pending → sent → acked", () => {
  it("sends every batch in seq order, acks the outbox, and commits", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 5);
    const search = createFakeSearch();
    const emitter = makeEmitter(store, search, 2);

    const outcome = await emitter.emit(job, leaseFor(store, job), fakeAssetLoader());

    expect(outcome).toEqual({ status: "committed", revisionId: "rev-fixed" });
    // 5 pages / 2 per batch → page batch seqs 0,1,2, then the trailing
    // document.end batch at seq 3, all sent in order.
    expect(search.batchPuts).toEqual([0, 1, 2, 3]);
    // Every emit-outbox page row ended acked.
    const emitRows = store.peekEmitBatches(job.id);
    expect(emitRows.map((r) => r.status)).toEqual(["acked", "acked", "acked", "acked", "acked"]);
    // The revision id was recorded on the job.
    expect(store.peek(job.id)?.revision_id).toBe("rev-fixed");
    expect(search.finalCommitted).toBe(true);
  });

  it("acks every staged asset after upload", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 3, { figuresOnPages: [2] });
    const search = createFakeSearch();
    const emitter = makeEmitter(store, search, 2);

    await emitter.emit(job, leaseFor(store, job), fakeAssetLoader());

    const assets = store.peekAssets(job.id);
    expect(assets.every((a) => a.status === "acked")).toBe(true);
    // 3 page images + 1 figure crop = 4 assets uploaded.
    expect(search.assetPuts.length).toBe(4);
  });
});

describe("emitter · resume reconciliation sends only the missing parts", () => {
  it("skips an already-accepted batch and a present asset on resume", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 5, { figuresOnPages: [1] });

    // The server already accepted batch 0 (pages 1-2) and already holds page 1's
    // image — as a prior interrupted run would have left it.
    const page1Image = buildAssetId(REFERENCE, pageLocalId(1));
    const search = createFakeSearch({
      preAccepted: [0],
      preStored: [page1Image],
      knownAssets: [
        buildAssetId(REFERENCE, pageLocalId(1)),
        buildAssetId(REFERENCE, pageLocalId(2)),
        buildAssetId(REFERENCE, pageLocalId(3)),
        buildAssetId(REFERENCE, pageLocalId(4)),
        buildAssetId(REFERENCE, pageLocalId(5)),
        buildAssetId(REFERENCE, figureLocalId("p1-f1")),
      ],
    });
    const emitter = makeEmitter(store, search, 2);

    const outcome = await emitter.emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(outcome.status).toBe("committed");

    // Batch 0 was already accepted → NOT re-sent. Batches 1 and 2 go out, then
    // the trailing document.end batch at seq 3.
    expect(search.batchPuts).toEqual([1, 2, 3]);
    // Page 1's image was already present → NOT re-uploaded.
    expect(search.assetPuts).not.toContain(page1Image);
    // But everything ended acked locally (reconciled + sent).
    expect(store.peekEmitBatches(job.id).every((r) => r.status === "acked")).toBe(true);
    expect(store.peekAssets(job.id).every((a) => a.status === "acked")).toBe(true);
  });
});

describe("emitter · bounded asset upload concurrency", () => {
  it("never exceeds ASSET_UPLOAD_CONCURRENCY concurrent uploads", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 8);
    const search = createFakeSearch({ assetDelayMs: 5 });
    const emitter = makeEmitter(store, search, 4); // assetUploadConcurrency is 2

    await emitter.emit(job, leaseFor(store, job), fakeAssetLoader());

    expect(search.peakAssetConcurrency).toBeLessThanOrEqual(2);
    expect(search.peakAssetConcurrency).toBeGreaterThan(1); // and it did overlap
    expect(search.assetPuts.length).toBe(8);
  });
});

describe("emitter · segment commits", () => {
  it("commits a segment every SEGMENT_PAGES pages, then the final commit", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 10);
    const search = createFakeSearch();
    // segmentPages 4 → full segments 0 (pages 1-4) and 1 (pages 5-8); pages 9-10
    // are the tail, committed by the final commit.
    const emitter = makeEmitter(store, search, 2, 4);

    await emitter.emit(job, leaseFor(store, job), fakeAssetLoader());

    expect(search.committedSegments).toEqual([0, 1]);
    expect(search.finalCommitted).toBe(true);
  });
});

describe("emitter · progressive visibility (segments commit while later batches are still being sent)", () => {
  it("commits each full segment right after its batches and assets, before the next batch goes out", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 10);
    const search = createFakeSearch();
    // 2 pages per batch, 4 per segment: segment 0 = pages 1-4 = batches 0,1.
    await makeEmitter(store, search, 2, 4).emit(job, leaseFor(store, job), fakeAssetLoader());
    const order = search.timeline.filter((e) => e.startsWith("put:") || e.startsWith("segment:") || e === "commit");
    expect(order).toEqual([
      "put:0", "put:1", "segment:0", "put:2", "put:3", "segment:1", "put:4",
      "put:5", // the trailing document.end batch
      "commit",
    ]);
  });
  it("uploads a segment's assets before committing it, the later pages' assets after", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 8);
    const search = createFakeSearch();
    await makeEmitter(store, search, 2, 4).emit(job, leaseFor(store, job), fakeAssetLoader());
    const at = (entry: string): number => search.timeline.indexOf(entry);
    const image = (page: number): string => `asset:${buildAssetId(REFERENCE, pageLocalId(page))}`;
    for (const page of [1, 2, 3, 4]) expect(at(image(page))).toBeLessThan(at("segment:0"));
    // Page 5's image is not part of segment 0: it goes out with segment 1's assets.
    expect(at(image(5))).toBeGreaterThan(at("segment:0"));
    expect(at(image(5))).toBeLessThan(at("segment:1"));
  });
  it("on a resume commits only the segments Search does not already hold", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 10);
    const search = createFakeSearch();
    search.committedSegments.push(0);
    await makeEmitter(store, search, 2, 4).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(search.committedSegments).toEqual([0, 1]);
    expect(search.timeline.filter((e) => e.startsWith("segment:"))).toEqual(["segment:1"]);
  });
  it("retries a rejected segment commit once after the send phase, not once per batch", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 8);
    const search = createFakeSearch();
    let calls = 0;
    search.commitSegment = async (args) => {
      calls++;
      search.timeline.push(`segment:${args.segment}`);
      return { reference: REFERENCE, revisionId: "rev-fixed", committed: false, segment: args.segment, missingRanges: [{ from: 1, to: 1 }] };
    };
    const outcome = await makeEmitter(store, search, 2, 4).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(outcome.status).toBe("committed");
    // Segments 0 and 1: one attempt each while sending, one more each in the sweep.
    expect(calls).toBe(4);
  });
});
describe("emitter · a pages window (contract 2.4)", () => {
  it("streams [5, 9]: absolute batch seqs, document.begin in the FIRST sent batch, firstPage on begin and end", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 5, { firstPage: 5 });
    const search = createFakeSearch();
    const outcome = await makeEmitter(store, search, 2, 4).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(outcome.status).toBe("committed");
    // pages 5,6 → seq 2; 7,8 → seq 3; 9 → seq 4; document.end at seq 5.
    expect(search.batchPuts).toEqual([2, 3, 4, 5]);
    const first = search.bodies.get(2) ?? [];
    expect(first[0]).toMatchObject({ type: "document.begin", firstPage: 5, pageCount: 9 });
    for (const seq of [3, 4]) {
      expect((search.bodies.get(seq) ?? []).some((r) => r.type === "document.begin")).toBe(false);
    }
    expect((search.bodies.get(2) ?? []).filter((r) => r.type === "page").map((r) => r.page)).toEqual([5, 6]);
    expect(search.bodies.get(5)?.[0]).toMatchObject({ type: "document.end", firstPage: 5, pageCount: 9 });
    // Segments count from the first page: pages 5-8 are segment 0, so one full segment.
    expect(search.committedSegments).toEqual([0]);
  });
  it("a window from page 1 carries no firstPage (a 2.3-shaped stream)", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 3);
    const search = createFakeSearch();
    await makeEmitter(store, search, 2, 4).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(search.bodies.get(0)?.[0]).toMatchObject({ type: "document.begin", pageCount: 3 });
    expect(search.bodies.get(0)?.[0]).not.toHaveProperty("firstPage");
    expect(search.bodies.get(2)?.[0]).not.toHaveProperty("firstPage");
  });
  it("resumes a window: the accepted absolute seqs map back to their pages", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 5, { firstPage: 5 });
    const search = createFakeSearch({ preAccepted: [2] });
    await makeEmitter(store, search, 2, 4).emit(job, leaseFor(store, job), fakeAssetLoader());
    // seq 2 (pages 5-6, with document.begin) was already there: only 3, 4 and the end are sent.
    expect(search.batchPuts).toEqual([3, 4, 5]);
    expect(store.peekEmitBatches(job.id).every((r) => r.status === "acked")).toBe(true);
  });
});
describe("emitter · the batch size is frozen per job", () => {
  const batchPages = (store: FakeJobStore, id: string): unknown =>
    (store.peek(id)?.config as { emitBatchPages?: unknown } | undefined)?.emitBatchPages;

  it("freezes the current EMIT_BATCH_PAGES into the job config before the first batch", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 6);
    const search = createFakeSearch();
    await makeEmitter(store, search, 3, 6).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(batchPages(store, job.id)).toBe(3);
    expect(search.batchPuts).toEqual([0, 1, 2]);
  });
  it("keeps the frozen size when the setting changes between runs (a resume never re-maps batches)", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 6, { config: { emitBatchPages: 3 } });
    const search = createFakeSearch({ preAccepted: [0] });
    // The deployment now says 2, the job says 3: pages 1-3 are batch 0 and already accepted.
    await makeEmitter(store, search, 2, 4).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(search.batchPuts).toEqual([1, 2]);
  });
  it("a job that predates the freeze (revision already open) takes the current size and freezes it", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 6, { revisionId: "rev-fixed" });
    // Batch 0 (pages 1-3 at 3 per batch) was accepted by the release before the freeze existed.
    const search = createFakeSearch({ preAccepted: [0] });
    await makeEmitter(store, search, 3, 6).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(batchPages(store, job.id)).toBe(3);
    expect(search.batchPuts).toEqual([1, 2]);
    // A later run with a different setting keeps the frozen size.
    const fresh = await store.getJob(job.id);
    if (fresh === null) throw new Error("job vanished");
    const again = createFakeSearch({ preAccepted: [0, 1, 2] });
    await makeEmitter(store, again, 2, 6).emit(fresh, leaseFor(store, fresh), fakeAssetLoader());
    expect(again.batchPuts).toEqual([2]);
  });
});
describe("emitter · a mid-emit failure resumes without duplicates or loss", () => {
  it("a transient batch failure pauses, and a resume completes cleanly", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 6);

    // First pass: the very first batch PUT fails transiently.
    const search = createFakeSearch({ failBatchPutsBefore: 1 });
    const emitter = makeEmitter(store, search, 2);
    const first = await emitter.emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(first.status).toBe("transient");
    expect(search.finalCommitted).toBe(false);

    // Second pass with the SAME fake server (its accepted set persists): the
    // emitter reconciles and finishes. No batch is sent twice.
    const fresh = await store.getJob(job.id);
    if (fresh === null) throw new Error("job vanished");
    const resumed = await emitter.emit(fresh, leaseFor(store, fresh), fakeAssetLoader());

    expect(resumed.status).toBe("committed");
    // Batches were each accepted exactly once across the two passes.
    const counts = new Map<number, number>();
    for (const seq of search.batchPuts) counts.set(seq, (counts.get(seq) ?? 0) + 1);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    // Page batch seqs 0,1,2 plus the trailing document.end batch at seq 3, each
    // accepted exactly once across the two passes.
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    // Every page ended acked exactly once.
    expect(store.peekEmitBatches(job.id).every((r) => r.status === "acked")).toBe(true);
  });
});

describe("emitter · document.begin pipeline stand and backlog gauge (requirements 18.1, 18.2)", () => {
  it("carries contract, pipelineVersion and promptHash on document.begin.pipeline", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 2);
    const search = createFakeSearch();
    const bodies: string[] = [];
    const putBatch = search.putBatch.bind(search);
    search.putBatch = async (args) => {
      bodies.push(new TextDecoder().decode(args.body));
      return putBatch(args);
    };
    const backlog: number[] = [];
    const emitter = createEmitter({
      store,
      revisions: search,
      config: {
        emitBatchPages: 1,
        segmentPages: 4,
        assetUploadConcurrency: 2,
        finalizePass: true,
        contract: "atf-extract/2.0.0",
        pipelineVersion: "pipe-fallback",
        promptHash: "prompt-fallback",
        visionModel: "test-vlm",
        renderDpi: 200,
      },
      metrics: { setEmitBacklog: (n) => backlog.push(n) },
      logger: testLogger,
    });

    const outcome = await emitter.emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(outcome.status).toBe("committed");

    const begin = JSON.parse(bodies[0]?.split("\n")[0] ?? "{}") as {
      type: string;
      contract: string;
      pipeline: Record<string, unknown>;
    };
    expect(begin.type).toBe("document.begin");
    expect(begin.contract).toBe("atf-extract/2.0.0");
    // The job carries no frozen snapshot here, so the deployment stand is used.
    expect(begin.pipeline).toMatchObject({
      contract: "atf-extract/2.0.0",
      pipelineVersion: "pipe-fallback",
      promptHash: "prompt-fallback",
    });

    // The backlog gauge starts at the unacked row count and drains to 0.
    expect(backlog[0]).toBe(2);
    expect(backlog.at(-1)).toBe(0);
  });

  it("prefers the job's frozen pipeline/prompt hashes over the deployment fallback", async () => {
    const store = createFakeJobStore();
    const id = randomUUID();
    await store.createJob({
      id,
      reference: REFERENCE,
      source_sha256: SOURCE_SHA,
      collection: "documents",
      pipeline_hash: "pipe-frozen",
      prompt_hash: "prompt-frozen",
    });
    const claimed = await store.claimNextJob("worker-1", 60);
    if (claimed === null) throw new Error("expected a claim");
    await store.setJobPageCount(id, 1);
    await store.stageEmitBatch({
      job_id: id,
      seq: 1,
      digest: "d1",
      page_from: 1,
      page_to: 1,
      payload: { type: "page", page: 1, record: buildPageRecord(1, false) },
    });
    const job = await store.getJob(id);
    if (job === null) throw new Error("job vanished");
    const search = createFakeSearch();
    const bodies: string[] = [];
    const putBatch = search.putBatch.bind(search);
    search.putBatch = async (args) => {
      bodies.push(new TextDecoder().decode(args.body));
      return putBatch(args);
    };
    const emitter = createEmitter({
      store,
      revisions: search,
      config: {
        emitBatchPages: 1,
        segmentPages: 4,
        assetUploadConcurrency: 2,
        finalizePass: true,
        contract: "atf-extract/2.0.0",
        pipelineVersion: "pipe-fallback",
        promptHash: "prompt-fallback",
        visionModel: "test-vlm",
        renderDpi: 200,
      },
      logger: testLogger,
    });
    await emitter.emit(job, leaseFor(store, job), fakeAssetLoader());
    const begin = JSON.parse(bodies[0]?.split("\n")[0] ?? "{}") as { pipeline: Record<string, unknown> };
    expect(begin.pipeline).toMatchObject({
      contract: "atf-extract/2.0.0",
      pipelineVersion: "pipe-frozen",
      promptHash: "prompt-frozen",
    });
  });
});

describe("emitter · document identity on document.begin (contract 2.1)", () => {
  it("carries title, version, e-mail headers and parent, and the source claim", async () => {
    const store = createFakeJobStore();
    const seeded = await seedEmittingJob(store, 1);
    await store.patchJobConfig(seeded.id, {
      title: "AW: Angebot",
      identity: {
        requestedReference: REFERENCE,
        canonicalReference: REFERENCE,
        decision: "new",
        registered: true,
        complete: true,
        version: { label: "2.1", source: "page_label" },
      },
      email: { messageId: "m1@x", inReplyTo: [], references: ["m0@x"], to: [], cc: [], attachments: [] },
      parent: { reference: "mail/root.eml", jobId: "j0" },
      acl: { allowedUsers: ["anna"], allowedGroups: [] },
      tags: ["kunde-a"],
      metadata: { projekt: "Alpha" },
      link: "https://dms.example/1",
      sourceLabel: "DMS",
    });
    const job = await store.getJob(seeded.id);
    if (job === null) throw new Error("job vanished");
    const search = createFakeSearch();
    const created: Array<{ sourceId?: string }> = [];
    const bodies = new Map<number, string>();
    const createRevision = search.createRevision.bind(search);
    const putBatch = search.putBatch.bind(search);
    search.createRevision = async (args) => {
      created.push(args);
      return createRevision(args);
    };
    search.putBatch = async (args) => {
      bodies.set(args.seq, new TextDecoder().decode(args.body));
      return putBatch(args);
    };

    const outcome = await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(outcome.status).toBe("committed");
    expect(created[0]?.sourceId).toBe(job.id);
    expect((created[0] as { acl?: unknown }).acl).toEqual({ allowedUsers: ["anna"], allowedGroups: [] });
    const begin = JSON.parse((bodies.get(0) ?? "").split("\n")[0] ?? "{}") as Record<string, unknown>;
    expect(begin).toMatchObject({
      type: "document.begin",
      title: "AW: Angebot",
      version: { label: "2.1", source: "page_label" },
      email: { messageId: "m1@x", references: ["m0@x"] },
      parentReference: "mail/root.eml",
      // Contract 2.2 document attributes.
      tags: ["kunde-a"],
      metadata: { projekt: "Alpha" },
      link: "https://dms.example/1",
      sourceLabel: "DMS",
    });
  });

  it("sends no source claim for an unidentified job", async () => {
    const store = createFakeJobStore();
    const job = await seedEmittingJob(store, 1);
    const search = createFakeSearch();
    const created: Array<{ sourceId?: string }> = [];
    const createRevision = search.createRevision.bind(search);
    search.createRevision = async (args) => {
      created.push(args);
      return createRevision(args);
    };
    await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(created[0]?.sourceId).toBeUndefined();
  });
});

describe("contentDigestHeader", () => {
  it("is the RFC 9530 structured form with a base64 sha-256, as Search decodes it", () => {
    const body = new TextEncoder().encode('{"type":"page","page":1}\n');
    const header = contentDigestHeader(body);
    const match = /^sha-256=:([A-Za-z0-9+/=]+):$/.exec(header);
    expect(match).not.toBeNull();
    // Search: base64-decode the structured value and compare it to the body's sha-256.
    const decoded = Buffer.from(match?.[1] ?? "", "base64").toString("hex");
    expect(decoded).toBe(createHash("sha256").update(body).digest("hex"));
  });
});
