// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * emitter-subdoc.test.ts
 *
 * Contract 2.5 emitter behaviour: the sub-document split (one independent
 * Search revision per chapter range, frozen plan) and Late Chunking
 * (documentText + alpha on document.begin, alpha header on the revision).
 *
 * Same harness style as emitter.test.ts — fake store, fake RevisionClient —
 * but the fake records every call PER REFERENCE, because a split emit drives
 * several revisions of one job at once.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAssetId,
  figureLocalId,
  pageLocalId,
  validateRecord,
  type OutlineNode,
  type PageRecord,
} from "@atf/extract-contract";
import type { BatchAck, CommitResult, Revision, RevisionState } from "@atf/extract-contract/v2";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger } from "./helpers.js";
import { createLeaseGuard } from "../src/jobs/lease.js";
import { createEmitter, revisionIdempotencyKey, type AssetLoader } from "../src/jobs/emitter.js";
import { SUBDOC_SPLIT_KEY } from "../src/jobs/subdoc-split.js";
import type { RevisionClient, AssetBody } from "../src/revision-client.js";
import type { JobRow, AssetOutboxRow } from "../src/persistence/types.js";

const REFERENCE = "tests/handbuch.pdf";
const SOURCE_SHA = "a".repeat(64);

interface RevisionCall {
  reference: string;
  idempotencyKey: string;
  lateChunkingAlpha?: number;
}

interface PerReferenceState {
  accepted: Set<number>;
  committedSegments: number[];
  finalCommitted: boolean;
}

/** A fake Search that models one acceptance state per document reference. */
interface FakeSearch extends RevisionClient {
  revisionCalls: RevisionCall[];
  /** Batch PUT seqs per reference, in call order. */
  batchPuts: Map<string, number[]>;
  /** Decoded NDJSON bodies per `${reference}:${seq}`. */
  bodies: Map<string, Record<string, unknown>[]>;
  assetPuts: Map<string, string[]>;
  states: Map<string, PerReferenceState>;
}

function createFakeSearch(): FakeSearch {
  const revisionCalls: RevisionCall[] = [];
  const batchPuts = new Map<string, number[]>();
  const bodies = new Map<string, Record<string, unknown>[]>();
  const assetPuts = new Map<string, string[]>();
  const states = new Map<string, PerReferenceState>();
  const stateOf = (reference: string): PerReferenceState => {
    let s = states.get(reference);
    if (s === undefined) {
      s = { accepted: new Set<number>(), committedSegments: [], finalCommitted: false };
      states.set(reference, s);
    }
    return s;
  };
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };

  const fake: FakeSearch = {
    revisionCalls,
    batchPuts,
    bodies,
    assetPuts,
    states,
    async createRevision(args): Promise<Revision> {
      revisionCalls.push({
        reference: args.reference,
        idempotencyKey: args.idempotencyKey,
        ...(args.lateChunkingAlpha !== undefined ? { lateChunkingAlpha: args.lateChunkingAlpha } : {}),
      });
      return {
        revisionId: `rev-${args.reference}`,
        reference: args.reference,
        status: "staging",
        visibility: "progressive",
        createdAt: new Date().toISOString(),
      };
    },
    async getState(args): Promise<RevisionState> {
      const s = stateOf(args.reference);
      return {
        revisionId: `rev-${args.reference}`,
        reference: args.reference,
        status: "staging",
        visibility: "progressive",
        acceptedBatches: [...s.accepted].sort((a, b) => a - b),
        processedPages: [],
        missingAssets: [],
        committedSegments: [...s.committedSegments],
      };
    },
    async putBatch(args): Promise<BatchAck> {
      const puts = batchPuts.get(args.reference);
      if (puts === undefined) batchPuts.set(args.reference, [args.seq]);
      else puts.push(args.seq);
      bodies.set(
        `${args.reference}:${args.seq}`,
        new TextDecoder()
          .decode(args.body)
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
      stateOf(args.reference).accepted.add(args.seq);
      return { seq: args.seq, digest: args.contentDigest, status: "received", noop: false };
    },
    async headAsset(): Promise<boolean> {
      return false;
    },
    async putAsset(args): Promise<void> {
      push(assetPuts, args.reference, args.asset.assetId);
    },
    async commitSegment(args): Promise<CommitResult> {
      stateOf(args.reference).committedSegments.push(args.segment);
      return {
        reference: args.reference,
        revisionId: `rev-${args.reference}`,
        committed: true,
        segment: args.segment,
        missingRanges: [],
      };
    },
    async commit(args): Promise<CommitResult> {
      stateOf(args.reference).finalCommitted = true;
      return {
        reference: args.reference,
        revisionId: `rev-${args.reference}`,
        committed: true,
        isLatest: true,
        missingRanges: [],
      };
    },
  };
  return fake;
}

function fakeAssetLoader(): AssetLoader {
  return {
    async load(row: AssetOutboxRow): Promise<AssetBody> {
      const buffer = new TextEncoder().encode(`bytes:${row.asset_id}`);
      return {
        assetId: row.asset_id,
        buffer,
        mimeType: row.mime_type ?? "image/png",
        checksum: row.checksum ?? "0".repeat(64),
        kind: "page",
      };
    },
  };
}

/**
 * Seed an emitting job with `pageCount` pages of `charsPerPage` plain text.
 * With `figures: true` every page also carries a figure block plus its crop
 * asset (and a page-image asset), all with ids derived from {@link REFERENCE}
 * — the shape a real staging pass produces for a split parent document.
 */
async function seedJob(
  store: FakeJobStore,
  pageCount: number,
  options: {
    config?: Record<string, unknown>;
    charsPerPage?: number;
    outline?: OutlineNode[];
    figures?: boolean;
  } = {},
): Promise<JobRow> {
  const id = randomUUID();
  const chars = options.charsPerPage ?? 4_000;
  await store.createJob({
    id,
    reference: REFERENCE,
    source_sha256: SOURCE_SHA,
    collection: "documents",
    config: { ...(options.config ?? {}) },
  });
  const claimed = await store.claimNextJob("worker-1", 60);
  if (claimed === null) throw new Error("expected a claim");
  await store.setJobPageCount(id, pageCount);
  await store.setJobStatus(id, "emitting");
  for (let page = 1; page <= pageCount; page++) {
    const figureId = `p${page}-f1`;
    const figureAssetId = buildAssetId(REFERENCE, figureLocalId(figureId));
    const pageAssetId = buildAssetId(REFERENCE, pageLocalId(page));
    const record: PageRecord = {
      type: "page",
      page,
      size: { wPt: 100, hPt: 140 },
      class: "text",
      blocks: [
        { id: `p${page}-b0`, page, type: "paragraph", source: "text-layer", text: "x".repeat(chars) },
        ...(options.figures === true
          ? [
              {
                id: `p${page}-fb0`,
                page,
                type: "figure" as const,
                figureId,
                kind: "diagram" as const,
                description: "Ein Diagramm.",
                bbox: [0.1, 0.1, 0.9, 0.9] as [number, number, number, number],
                assetId: figureAssetId,
              },
            ]
          : []),
      ],
      assets: [
        { assetId: pageAssetId, kind: "page", localId: pageLocalId(page), page },
        ...(options.figures === true
          ? [
              {
                assetId: figureAssetId,
                kind: "figure" as const,
                localId: figureLocalId(figureId),
                page,
                bbox: [0.1, 0.1, 0.9, 0.9] as [number, number, number, number],
              },
            ]
          : []),
      ],
      warnings: [],
    };
    await store.stageEmitBatch({
      job_id: id,
      seq: page,
      digest: `d${page}`,
      page_from: page,
      page_to: page,
      payload: { type: "page", page, record },
    });
    await store.stageAsset({
      job_id: id,
      asset_id: pageAssetId,
      variant: "page",
      mime_type: "image/png",
      checksum: "0".repeat(64),
      page,
    });
    if (options.figures === true) {
      await store.stageAsset({
        job_id: id,
        asset_id: figureAssetId,
        variant: "figure",
        mime_type: "image/png",
        checksum: "0".repeat(64),
        page,
      });
    }
  }
  if (options.outline !== undefined) {
    await store.saveDocpassState(id, pageCount, {
      version: 1,
      outline: {
        version: 1,
        stack: [],
        heights: [],
        seq: options.outline.length,
        closed: options.outline.map((n, i) => ({ ...n, sectionId: n.sectionId ?? `s${i}` })),
      },
      lastPage: pageCount,
    });
  }
  const fresh = await store.getJob(id);
  if (fresh === null) throw new Error("job vanished");
  return fresh;
}

function makeEmitter(store: FakeJobStore, search: RevisionClient) {
  return createEmitter({
    store,
    revisions: search,
    config: {
      emitBatchPages: 2,
      segmentPages: 4,
      assetUploadConcurrency: 2,
      finalizePass: true,
      contract: "atf-extract/2.5.0",
      visionModel: "test-vlm",
      renderDpi: 200,
    },
    logger: testLogger,
  });
}

function leaseFor(store: FakeJobStore, job: JobRow) {
  return createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
}

const OUTLINE: OutlineNode[] = [
  { sectionId: "sA", level: 1, title: "Kapitel A", pageStart: 1, pageEnd: 3 },
  { sectionId: "sB", level: 1, title: "Kapitel B", pageStart: 4, pageEnd: 6 },
];

describe("emitter · sub-document split (contract 2.5)", () => {
  it("opens one revision per sub-document with its own reference and key", async () => {
    const store = createFakeJobStore();
    // 6 pages × 4 000 chars ≈ 15 chunks; budget 8 → split at the chapter gap.
    const job = await seedJob(store, 6, {
      config: { subdocumentMaxChunks: 8 },
      outline: OUTLINE,
    });
    const search = createFakeSearch();

    const outcome = await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(outcome.status).toBe("committed");

    expect(search.revisionCalls.map((c) => c.reference)).toEqual([`${REFERENCE}/Kapitel A`, `${REFERENCE}/Kapitel B`]);
    const key = revisionIdempotencyKey(job);
    expect(search.revisionCalls.map((c) => c.idempotencyKey)).toEqual([`${key}:s0`, `${key}:s1`]);

    // Each revision holds exactly its own pages: A = pages 1-3 (seqs 0,1 + end 2),
    // B = pages 4-6 (absolute seqs 1,2 + end 3).
    expect(search.batchPuts.get(`${REFERENCE}/Kapitel A`)).toEqual([0, 1, 2]);
    expect(search.batchPuts.get(`${REFERENCE}/Kapitel B`)).toEqual([1, 2, 3]);
    const aPages = [...search.bodies.entries()]
      .filter(([k]) => k.startsWith(`${REFERENCE}/Kapitel A`))
      .flatMap(([, body]) => body.filter((r) => r.type === "page").map((r) => r.page));
    expect(aPages.sort()).toEqual([1, 2, 3]);
    const bPages = [...search.bodies.entries()]
      .filter(([k]) => k.startsWith(`${REFERENCE}/Kapitel B`))
      .flatMap(([, body]) => body.filter((r) => r.type === "page").map((r) => r.page));
    expect(bPages.sort((x, y) => Number(x) - Number(y))).toEqual([4, 5, 6]);

    // begin/end carry the sub-document's own range.
    expect(search.bodies.get(`${REFERENCE}/Kapitel A:0`)?.[0]).toMatchObject({
      type: "document.begin",
      reference: `${REFERENCE}/Kapitel A`,
      pageCount: 3,
    });
    expect(search.bodies.get(`${REFERENCE}/Kapitel A:0`)?.[0]).not.toHaveProperty("firstPage");
    expect(search.bodies.get(`${REFERENCE}/Kapitel B:1`)?.[0]).toMatchObject({
      type: "document.begin",
      reference: `${REFERENCE}/Kapitel B`,
      firstPage: 4,
      pageCount: 6,
    });
    expect(search.bodies.get(`${REFERENCE}/Kapitel A:2`)?.[0]).toMatchObject({ type: "document.end", pageCount: 3 });
    expect(search.bodies.get(`${REFERENCE}/Kapitel B:3`)?.[0]).toMatchObject({
      type: "document.end",
      firstPage: 4,
      pageCount: 6,
    });
  });

  it("scopes the document graph of each sub-document to its page range", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, 6, { config: { subdocumentMaxChunks: 8 }, outline: OUTLINE });
    const search = createFakeSearch();
    await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());

    const endA = search.bodies.get(`${REFERENCE}/Kapitel A:2`)?.[0] as { outline: OutlineNode[] };
    expect(endA.outline.map((n) => n.title)).toEqual(["Kapitel A"]);
    const endB = search.bodies.get(`${REFERENCE}/Kapitel B:3`)?.[0] as { outline: OutlineNode[] };
    expect(endB.outline.map((n) => n.title)).toEqual(["Kapitel B"]);
  });

  it("freezes the plan into the job config and reuses it on a later run", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, 6, { config: { subdocumentMaxChunks: 8 }, outline: OUTLINE });
    const search = createFakeSearch();
    await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());

    const frozen = store.peek(job.id)?.config as Record<string, unknown>;
    expect(frozen[SUBDOC_SPLIT_KEY]).toEqual({
      maxChunks: 8,
      subdocuments: [
        { suffix: "Kapitel A", firstPage: 1, lastPage: 3 },
        { suffix: "Kapitel B", firstPage: 4, lastPage: 6 },
      ],
    });

    // A second run (e.g. a new emit generation) reuses the frozen plan even
    // though the docpass state is gone: same references, same keys.
    const again = createFakeSearch();
    const fresh = await store.getJob(job.id);
    if (fresh === null) throw new Error("job vanished");
    await makeEmitter(store, again).emit(fresh, leaseFor(store, fresh), fakeAssetLoader());
    expect(again.revisionCalls.map((c) => c.reference)).toEqual([
      `${REFERENCE}/Kapitel A`,
      `${REFERENCE}/Kapitel B`,
    ]);
  });

  it("without a budget the job stays one document and no plan is written", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, 6, { outline: OUTLINE });
    const search = createFakeSearch();
    await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(search.revisionCalls.map((c) => c.reference)).toEqual([REFERENCE]);
    const cfg = store.peek(job.id)?.config as Record<string, unknown>;
    expect(cfg[SUBDOC_SPLIT_KEY]).toBeUndefined();
  });

  it("a document that fits the budget is not split even with an outline", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, 6, {
      config: { subdocumentMaxChunks: 100 },
      charsPerPage: 100,
      outline: OUTLINE,
    });
    const search = createFakeSearch();
    await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(search.revisionCalls.map((c) => c.reference)).toEqual([REFERENCE]);
  });

  it("records the first stream's revision on the job", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, 6, { config: { subdocumentMaxChunks: 8 }, outline: OUTLINE });
    const search = createFakeSearch();
    const outcome = await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(outcome).toEqual({ status: "committed", revisionId: `rev-${REFERENCE}/Kapitel A` });
    const fresh = store.peek(job.id);
    expect(fresh?.revision_id).toBe(`rev-${REFERENCE}/Kapitel A`);
  });

  it("re-derives every asset id against the sub-document's reference (422 regression)", async () => {
    // Staging derives asset ids from the JOB's reference; Search validates
    // them against the revision's reference. A sub-document batch that still
    // carried the parent's ids was refused with 422 BATCH_VALIDATION_FAILED.
    const store = createFakeJobStore();
    const job = await seedJob(store, 6, {
      config: { subdocumentMaxChunks: 8 },
      outline: OUTLINE,
      figures: true,
    });
    const search = createFakeSearch();
    const outcome = await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());
    expect(outcome.status).toBe("committed");

    const subRefs = [`${REFERENCE}/Kapitel A`, `${REFERENCE}/Kapitel B`];
    expect(search.revisionCalls.map((c) => c.reference)).toEqual(subRefs);

    for (const [key, body] of search.bodies) {
      const reference = key.split(":")[0];
      if (!subRefs.includes(reference)) continue;
      for (const record of body) {
        const result = validateRecord(record, { reference });
        if (!result.ok) {
          throw new Error(`${key}: record failed Search's batch validation: ${JSON.stringify(result.issues)}`);
        }
      }
    }

    // Every page record's assets and figure blocks carry the sub-document's ids.
    for (const subRef of subRefs) {
      const pages = [...search.bodies.entries()]
        .filter(([k]) => k.startsWith(`${subRef}:`))
        .flatMap(([, body]) => body.filter((r) => r.type === "page"));
      expect(pages.length).toBe(3);
      for (const page of pages) {
        const p = page as unknown as PageRecord;
        for (const asset of p.assets) {
          expect(asset.assetId).toBe(buildAssetId(subRef, asset.localId));
        }
        for (const block of p.blocks) {
          if (block.type === "figure" && block.assetId !== undefined) {
            expect(block.assetId).toBe(buildAssetId(subRef, block.figureId));
          }
        }
      }
    }

    // The uploads go to the sub-document's revision under the re-derived ids.
    for (const subRef of subRefs) {
      const uploaded = search.assetPuts.get(subRef) ?? [];
      expect(uploaded).toHaveLength(6); // 3 pages × (page image + figure crop)
      // Every uploaded id is derivable from this sub-document's reference.
      const pages = [...search.bodies.entries()]
        .filter(([k]) => k.startsWith(`${subRef}:`))
        .flatMap(([, body]) => body.filter((r) => r.type === "page"))
        .map((r) => (r as unknown as PageRecord).page);
      const expected = new Set<string>();
      for (const p of pages) {
        expected.add(buildAssetId(subRef, pageLocalId(p)));
        expected.add(buildAssetId(subRef, figureLocalId(`p${p}-f1`)));
      }
      expect(new Set(uploaded)).toEqual(expected);
    }
    // The parent reference itself receives nothing.
    expect(search.assetPuts.get(REFERENCE)).toBeUndefined();
    expect(search.batchPuts.get(REFERENCE)).toBeUndefined();
  });
});

describe("emitter · Late Chunking (contract 2.5)", () => {
  it("sends the alpha header and the assembled documentText on document.begin", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, 3, { config: { lateChunkingAlpha: 0.7 }, charsPerPage: 50 });
    const search = createFakeSearch();
    await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());

    expect(search.revisionCalls[0]?.lateChunkingAlpha).toBe(0.7);
    const begin = search.bodies.get(`${REFERENCE}:0`)?.[0] as {
      type: string;
      lateChunkingAlpha?: number;
      documentText?: string;
    };
    expect(begin.type).toBe("document.begin");
    expect(begin.lateChunkingAlpha).toBe(0.7);
    // Three pages of 50 chars joined by newlines.
    expect(begin.documentText).toBe(["x".repeat(50), "x".repeat(50), "x".repeat(50)].join("\n"));
  });

  it("assembles documentText per sub-document, not for the whole file", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, 6, {
      config: { lateChunkingAlpha: 0.5, subdocumentMaxChunks: 8 },
      outline: OUTLINE,
    });
    const search = createFakeSearch();
    await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());

    const beginA = search.bodies.get(`${REFERENCE}/Kapitel A:0`)?.[0] as { documentText?: string };
    const beginB = search.bodies.get(`${REFERENCE}/Kapitel B:1`)?.[0] as { documentText?: string };
    // Each sub-document's text covers exactly its three pages.
    expect((beginA.documentText ?? "").split("\n")).toHaveLength(3);
    expect((beginB.documentText ?? "").split("\n")).toHaveLength(3);
    expect(search.revisionCalls.every((c) => c.lateChunkingAlpha === 0.5)).toBe(true);
  });

  it("without an alpha the begin record carries neither field", async () => {
    const store = createFakeJobStore();
    const job = await seedJob(store, 2);
    const search = createFakeSearch();
    await makeEmitter(store, search).emit(job, leaseFor(store, job), fakeAssetLoader());
    const begin = search.bodies.get(`${REFERENCE}:0`)?.[0] as Record<string, unknown>;
    expect(begin).not.toHaveProperty("lateChunkingAlpha");
    expect(begin).not.toHaveProperty("documentText");
    expect(search.revisionCalls[0]).not.toHaveProperty("lateChunkingAlpha");
  });
});
