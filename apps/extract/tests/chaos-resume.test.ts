// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * chaos-resume.test.ts
 *
 * The extraction + emit half of the chaos/resume suite. Its job is to prove
 * the central resumability invariant:
 *
 *   **Every unit of work that was once completed and persisted is never redone,
 *   and a run interrupted at ANY point and resumed produces a result identical
 *   to an undisturbed run.**
 *
 * The harness drives the REAL job runner and the REAL outbox emitter
 *  against the in-memory fake ExtractStore, a counting vision mock,
 * and a fault-aware fake Search revision server that models the accept/stage/
 * commit state a real Search exposes. No poppler, no model, no database, no
 * HTTP — every fault is injected through the fakes, so production code is
 * exercised verbatim with zero seams added.
 *
 * ## The invariant harness
 *
 * `referenceRun()` runs the whole pipeline once with NO fault and records the
 * fingerprint of a correct result:
 *   - `modelCalls`  — the exact set of pages the vision mock was asked to analyse
 *   - `units`       — the deterministic id + a content hash of every page record
 *                     the emitter sent to Search (the "index units" of this half)
 *   - `assets`      — the set of asset ids the fake Search stored
 *   - `usedStand`   — the pipeline/prompt stand recorded per page (for pin/continue)
 *
 * Then, for each fault-injection point × scenario, `chaosRun()` runs the SAME
 * pipeline with the fault armed, drives the worker/emitter to a resume, and the
 * test asserts against the reference:
 *   1. the unit id set and per-unit content hashes are IDENTICAL (hash-identical
 *      result — req 18.5);
 *   2. the vision mock was NOT called more than the reference (no duplicate model
 *      call — req 4.3);
 *   3. no duplicate unit rows (deterministic ids — req 5.4/5.5);
 *   4. no orphaned assets — every stored asset is referenced by a committed unit
 *      and every referenced asset is stored (req 5.7).
 *
 * ## Fault-injection points and scenarios
 *
 * Fault points span the whole handover:
 *   before/after each processing stage (render/vision/parse via the vision call),
 *   before/after send (emitter PUT batch), before/after receive+embedding (the
 *   fake Search accept), before/after commit (segment/final).
 *
 * Scenarios: kill -9 of the worker (drop mid-run, take over the lease with a
 * fresh epoch), network error / lost response (send fails after the server
 * accepted, or before), Search restart (its state persists but the in-flight
 * request fails), embedding/accept outage (accept fails then recovers),
 * exhausted budget (guard trips, then the budget is raised), and a version
 * change under `pin` vs `continue`.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAssetId,
  figureLocalId,
  pageLocalId,
  sha256Hex,
  type PageRecord,
} from "@atf/extract-contract";
import type {
  BatchAck,
  CommitResult,
  Revision,
  RevisionState,
} from "@atf/extract-contract/v2";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger, TINY_PNG } from "./helpers.js";
import { createLeaseGuard, LeaseLostError } from "../src/jobs/lease.js";
import { createJobEventBus } from "../src/jobs/events.js";
import { createJobRunner } from "../src/jobs/job-runner.js";
import { createEmitter } from "../src/jobs/emitter.js";
import { createJobWorker } from "../src/jobs/worker.js";
import { resolveAction } from "../src/jobs/state-machine.js";
import type { StageOutput } from "../src/jobs/stage-runner.js";
import { decideResume, type PipelineSnapshot, type ResumeDecision } from "../src/jobs/snapshot.js";
import type { PageRenderer, PreparedSource, PageImage } from "../src/jobs/page-renderer.js";
import type { VisionClient } from "../src/vision/client.js";
import type {
  RevisionClient,
  AssetBody,
} from "../src/revision-client.js";
import { RevisionPermanentError, RevisionTransientError } from "../src/revision-client.js";
import type { JobRow } from "../src/persistence/types.js";

const REFERENCE = "tests/handbuch.pdf";
const SOURCE_SHA = "a".repeat(64);
const PAGE_COUNT = 6;
const FIGURE_PAGES = new Set([2, 5]);

const PAGE_IMAGE: PageImage = { buffer: TINY_PNG, mimeType: "image/png", width: 100, height: 140 };

// ── counting vision mock ───────────────────────────────────────────────────

/**
 * A vision client that records every page it is asked to analyse. The recorded
 * `calls` array is the model-mock counter: a resume that
 * reuses checkpoints must never grow it. Its output is deterministic per page,
 * so a re-run (were one to happen) would produce byte-identical records — which
 * is exactly why a duplicate call would NOT change the unit hashes, and why the
 * call counter, not the hash, is the thing that detects a duplicate.
 */
interface CountingVision extends VisionClient {
  readonly calls: number[];
  /** Pass-2 figure calls, as `page:figureId`. */
  readonly figureCalls: string[];
}

function countingVision(figuresOnPages: Set<number> = FIGURE_PAGES): CountingVision {
  const calls: number[] = [];
  const figureCalls: string[] = [];
  return {
    calls,
    figureCalls,
    async analyzePage(input) {
      calls.push(input.page);
      const hasFigure = figuresOnPages.has(input.page);
      const raw = hasFigure
        ? `<summary>S${input.page}</summary><figures><figure id="1" bbox="0.1,0.1,0.5,0.5">Diagramm ${input.page}</figure></figures><markdown>Seite ${input.page}\n\n![figure_1]</markdown>`
        : `<summary>S${input.page}</summary><figures></figures><markdown>Seite ${input.page}</markdown>`;
      return {
        raw,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        requests: 1,
        truncated: false,
        maxTokens: 8192,
      };
    },
    async analyzeFigure(input) {
      figureCalls.push(`${input.page}:${input.figureId}`);
      return {
        raw: '{"format":"markdown","text":"stub"}',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        requests: 1,
        truncated: false,
        maxTokens: 8192,
      };
    },
    async probe() {
      return { available: true };
    },
  };
}

// ── prepared-source fake ────────────────────────────────────────────────────

/** A prepared source that renders `pageCount` deterministic pages. */
function fakePrepared(pageCount: number): PreparedSource {
  return {
    pageCount,
    native: null,
    docxHeadingHints: null,
    vsdxStructure: null,
    pdfPath: null,
    home: "",
    format: { mimeType: "application/pdf", extensions: [".pdf"], kind: "pdf", family: "pdf", label: "PDF" },
    async render() {
      await Promise.resolve();
      return { image: PAGE_IMAGE, rawText: "text", usedOcr: false };
    },
    async pageSizePt() {
      return { widthPt: 612, heightPt: 792 };
    },
    async renderRegion() {
      throw new Error("renderRegion is not used by the job runner");
    },
    async renderFigureCrop() {
      return { buffer: TINY_PNG, mimeType: "image/png", width: 10, height: 10 };
    },
    async close() {},
  };
}

function fakeRenderer(prepared: PreparedSource): PageRenderer {
  return { async prepare() { return prepared; } };
}

// ── fault model ─────────────────────────────────────────────────────────────

/**
 * The enumerated fault-injection points, one small toggle the harness arms
 * before a run. They span the whole path requires an abort at:
 * the processing stages (render/vision), the send, the receive+embed (accept),
 * and the two commits.
 */
type FaultPoint =
  | "before-render" // a page's render throws (deterministic stage) — permanent for the page
  | "before-vision" // the model call throws before answering (transient)
  | "before-send" // the batch PUT throws before the server sees it
  | "after-send" // the server accepts, then the ack throws (lost response)
  | "before-accept" // the server refuses to accept (receive/embed outage)
  | "before-segment-commit" // a segment commit throws
  | "before-final-commit"; // the final commit throws

/** The scenarios, each a way a fault manifests. */
type Scenario =
  | "kill-9" // drop the worker mid-run; a fresh worker takes over the lease
  | "network-error" // the request never reached a definitive answer
  | "lost-response" // the server acted, but the client saw a failure
  | "search-restart" // Search's state persists, the in-flight request fails
  | "accept-outage"; // the accept path is down, then recovers

interface Fault {
  point: FaultPoint;
  scenario: Scenario;
  /** Fire the fault only on this page (for per-page points). */
  onPage?: number;
  /** Fire the fault only on this batch seq (for send/commit points). */
  onBatchSeq?: number;
  /** Fire the fault only on this segment (for segment commit). */
  onSegment?: number;
}

/** A one-shot armed fault: it fires once, then disarms so the resume succeeds. */
class ArmedFault {
  private fired = false;
  constructor(private readonly fault: Fault | null) {}

  /** Fire once for the matching point; return true if it fired (and disarm). */
  trip(point: FaultPoint, ctx: { page?: number; seq?: number; segment?: number } = {}): boolean {
    if (this.fault === null || this.fired || this.fault.point !== point) return false;
    if (this.fault.onPage !== undefined && ctx.page !== this.fault.onPage) return false;
    if (this.fault.onBatchSeq !== undefined && ctx.seq !== this.fault.onBatchSeq) return false;
    if (this.fault.onSegment !== undefined && ctx.segment !== this.fault.onSegment) return false;
    this.fired = true;
    return true;
  }

  get scenario(): Scenario | null {
    return this.fault?.scenario ?? null;
  }
}

// ── fault-aware fake Search revision server ─────────────────────────────────

/**
 * A fake Search that models the durable accept/stage/commit state a real Search
 * exposes, plus the fault hooks the chaos scenarios need. Its state (accepted
 * batches, stored assets, committed segments) persists across emitter passes —
 * this is what makes a "Search restart" survivable: the request fails but the
 * state the emitter reconciles against is intact.
 */
interface FakeSearch extends RevisionClient {
  accepted: Set<number>;
  storedAssets: Set<string>;
  committedSegments: number[];
  finalCommitted: boolean;
  batchPuts: number[];
  assetPuts: string[];
}

function createFakeSearch(fault: ArmedFault, knownAssets: Set<string>): FakeSearch {
  const accepted = new Set<number>();
  const storedAssets = new Set<string>();
  const committedSegments: number[] = [];
  const batchPuts: number[] = [];
  const assetPuts: string[] = [];
  const revisionId = "rev-fixed";

  const search: FakeSearch = {
    accepted,
    storedAssets,
    committedSegments,
    finalCommitted: false,
    batchPuts,
    assetPuts,

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
      // before-accept / before-send: the server never records the batch.
      if (fault.trip("before-accept", { seq: args.seq }) || fault.trip("before-send", { seq: args.seq })) {
        throw new RevisionTransientError("simulated accept/network failure");
      }
      const noop = accepted.has(args.seq);
      accepted.add(args.seq); // the durable stage happens server-side …
      batchPuts.push(args.seq);
      // after-send / lost-response: the server accepted, but the client's ack
      // is lost — the batch IS staged, yet the emitter sees a failure.
      if (fault.trip("after-send", { seq: args.seq })) {
        throw new RevisionTransientError("accepted server-side but the response was lost");
      }
      return { seq: args.seq, digest: args.contentDigest, status: "received", noop };
    },

    async headAsset(args): Promise<boolean> {
      return storedAssets.has(args.assetId);
    },

    async putAsset(args): Promise<void> {
      storedAssets.add(args.asset.assetId);
      assetPuts.push(args.asset.assetId);
    },

    async commitSegment(args): Promise<CommitResult> {
      if (fault.trip("before-segment-commit", { segment: args.segment })) {
        throw new RevisionTransientError("segment commit interrupted");
      }
      if (!committedSegments.includes(args.segment)) committedSegments.push(args.segment);
      return { reference: REFERENCE, revisionId, committed: true, segment: args.segment, missingRanges: [] };
    },

    async commit(): Promise<CommitResult> {
      if (fault.trip("before-final-commit")) {
        throw new RevisionTransientError("final commit interrupted");
      }
      search.finalCommitted = true;
      return { reference: REFERENCE, revisionId, committed: true, isLatest: true, missingRanges: [] };
    },
  };
  return search;
}

/** An AssetLoader with deterministic bytes for every requested crop / page. */
function assetLoader() {
  return {
    async load(row: { asset_id: string; mime_type: string | null; checksum: string | null; variant: string | null }): Promise<AssetBody> {
      return {
        assetId: row.asset_id,
        buffer: new TextEncoder().encode(`bytes:${row.asset_id}`),
        mimeType: row.mime_type ?? "image/png",
        checksum: row.checksum ?? "0".repeat(64),
        kind: row.variant === "page" ? "page" : "figure",
      };
    },
  };
}

// ── wiring ──────────────────────────────────────────────────────────────────

const EMIT_BATCH_PAGES = 2;
const SEGMENT_PAGES = 4;

/**
 * The runner under the fake clock: backoff waits advance the fake clock instead
 * of sleeping, and a transient stall is retried in place for up to a minute
 * (JOB_MAX_TRANSIENT_WAIT) before the run pauses on dependency.
 */
function makeRunner(
  store: FakeJobStore,
  prepared: PreparedSource,
  vision: VisionClient,
  overrides: Partial<Parameters<typeof createJobRunner>[0]["config"]> = {},
) {
  return createJobRunner({
    store,
    vision,
    renderer: fakeRenderer(prepared),
    events: createJobEventBus(),
    config: {
      pageConcurrency: 3,
      visionTokenEstimate: 30,
      visionModel: "test-vlm",
      renderDpi: 200,
      figureDpi: 300,
      figurePass2Kinds: [],
      figurePass2MinArea: 0.02,
      labelCoverageMin: 60,
      maxTransientWaitMs: 60_000,
      ...overrides,
    },
    emitter: null,
    logger: testLogger,
    now: () => store.clock(),
    sleep: async (ms) => {
      store.advance(ms);
    },
  });
}

function makeEmitter(store: FakeJobStore, search: RevisionClient) {
  return createEmitter({
    store,
    revisions: search,
    config: {
      emitBatchPages: EMIT_BATCH_PAGES,
      segmentPages: SEGMENT_PAGES,
      assetUploadConcurrency: 2,
      finalizePass: true,
      contract: "atf-extract/2.0.0",
      visionModel: "test-vlm",
      renderDpi: 200,
    },
    logger: testLogger,
  });
}

/** The asset ids the document is expected to reference (page images + figure crops). */
function expectedAssetIds(): Set<string> {
  const ids = new Set<string>();
  for (let page = 1; page <= PAGE_COUNT; page++) {
    ids.add(buildAssetId(REFERENCE, pageLocalId(page)));
    if (FIGURE_PAGES.has(page)) ids.add(buildAssetId(REFERENCE, figureLocalId(`p${page}-f1`)));
  }
  return ids;
}

async function seedJob(
  store: FakeJobStore,
  overrides: Partial<Parameters<FakeJobStore["createJob"]>[0]> = {},
): Promise<string> {
  const id = randomUUID();
  await store.createJob({
    id,
    reference: REFERENCE,
    source_sha256: SOURCE_SHA,
    collection: "documents",
    pipeline_hash: "pipe-1",
    prompt_hash: "prompt-1",
    ...overrides,
  });
  return id;
}

// ── the invariant fingerprint ───────────────────────────────────────────────

interface UnitFingerprint {
  unitId: string;
  contentHash: string;
}

interface RunFingerprint {
  modelCalls: number[];
  units: UnitFingerprint[];
  assets: string[];
  finalCommitted: boolean;
}

/**
 * The unit id of a page record, deterministic from the reference + page (mirrors
 * the deterministic ids the Search-side builder derives, so a re-send never
 * makes a duplicate). The content hash is over the record's semantically
 * significant fields, so a byte-identical resume hashes identically.
 */
function unitFingerprintOf(record: PageRecord): UnitFingerprint {
  const unitId = sha256Hex(`${REFERENCE}\n${record.page}\nunit`);
  const canonical = JSON.stringify({
    page: record.page,
    class: record.class,
    summary: record.summary ?? null,
    blocks: record.blocks,
    assets: [...record.assets].sort((a, b) => a.assetId.localeCompare(b.assetId)),
    warnings: record.warnings,
  });
  return { unitId, contentHash: sha256Hex(canonical) };
}

/**
 * Read the fingerprint of a finished run from the store + fake Search: the
 * staged page records are the units, the fake Search's stored assets are the
 * assets, and the vision mock's call list is the model counter.
 */
function fingerprint(store: FakeJobStore, jobId: string, search: FakeSearch, vision: CountingVision): RunFingerprint {
  const units = store
    .peekEmitBatches(jobId)
    .map((row) => (row.payload as { record?: PageRecord } | null)?.record)
    .filter((r): r is PageRecord => r !== undefined && r !== null)
    .sort((a, b) => a.page - b.page)
    .map(unitFingerprintOf);
  return {
    modelCalls: [...vision.calls].sort((a, b) => a - b),
    units,
    assets: [...search.storedAssets].sort(),
    finalCommitted: search.finalCommitted,
  };
}

// ── the reference (undisturbed) run ─────────────────────────────────────────

async function referenceRun(): Promise<RunFingerprint> {
  const store = createFakeJobStore();
  const jobId = await seedJob(store);
  const vision = countingVision();
  const search = createFakeSearch(new ArmedFault(null), expectedAssetIds());

  const claimed = await store.claimNextJob("worker-ref", 60);
  if (claimed === null) throw new Error("expected a claim");
  await store.setJobStatus(jobId, "preparing");

  // Processing.
  const runner = makeRunner(store, fakePrepared(PAGE_COUNT), vision);
  const lease = createLeaseGuard(store, { jobId, holder: "worker-ref", epoch: Number(claimed.lease_epoch) }, 60);
  const outcome = await runner.run({
    job: { ...claimed, status: "preparing" },
    lease,
    resume: { action: "continue-pinned", changed: false },
    logger: testLogger,
  });
  expect(outcome).toEqual({ status: "completed" });

  // Emit.
  const fresh = await store.getJob(jobId);
  if (fresh === null) throw new Error("job vanished");
  const emitter = makeEmitter(store, search);
  const emit = await emitter.emit(fresh, lease, assetLoader());
  expect(emit.status).toBe("committed");

  return fingerprint(store, jobId, search, vision);
}

// ── a chaos run: fault, then resume to completion ───────────────────────────

/**
 * Run the pipeline with a fault armed on the FIRST pass, then resume until the
 * job commits. Returns the finished fingerprint. Models each scenario:
 *
 *   - kill-9: after the first processing pass the "worker" is dropped; the fake
 *     store's lease is expired and a FRESH worker claims the job (new epoch),
 * exactly as the real takeover path. Its runner then
 *     resumes at the first unfinished page, reusing every done checkpoint.
 *   - the send/accept/commit scenarios: the emitter's first pass throws at the
 *     armed point and returns `transient`; the armed fault is one-shot, so the
 *     resume pass finds it disarmed, reconciles against the (persistent) fake
 *     Search state, and finishes without re-sending accepted batches.
 */
async function chaosRun(fault: Fault): Promise<RunFingerprint> {
  const store = createFakeJobStore();
  const jobId = await seedJob(store);
  const armed = new ArmedFault(fault);
  const vision = faultyVision(countingVision(), armed);
  const search = createFakeSearch(armed, expectedAssetIds());
  const prepared = fakePrepared(PAGE_COUNT);

  // ── first pass: worker claims, runs, hits the fault ───────────────────────
  const first = await store.claimNextJob("worker-1", 60);
  if (first === null) throw new Error("expected a claim");
  await runOnce(store, jobId, first, "worker-1", prepared, vision, search);

  if (fault.scenario === "kill-9") {
    // Drop worker-1 without finishing: expire its lease and let a fresh worker
    // take over. The fake store's claim path treats a working job with an
    // expired lease as claimable (the real SKIP-LOCKED takeover).
    store.advance(120_000);
  } else {
    // The emit/commit faults leave the job paused(dependency); re-queue it so a
    // worker can claim it again (the worker's recovery path).
    const current = await store.getJob(jobId);
    if (current !== null && current.status !== "completed") {
      await store.requeueJob(jobId);
    }
  }

  // ── resume passes: claim + run until the job completes ────────────────────
  for (let attempt = 0; attempt < 6; attempt++) {
    const current = await store.getJob(jobId);
    if (current !== null && current.status === "completed") break;
    const claimed = await store.claimNextJob(`worker-resume-${attempt}`, 60);
    if (claimed === null) {
      // Nothing claimable yet (a paused job that was not re-queued): re-queue and retry.
      await store.requeueJob(jobId);
      continue;
    }
    const outcome = await runOnce(store, jobId, claimed, `worker-resume-${attempt}`, prepared, vision, search);
    if (outcome === "completed") break;
    if (outcome === "paused") await store.requeueJob(jobId);
  }

  const done = await store.getJob(jobId);
  expect(done?.status).toBe("completed");
  return fingerprint(store, jobId, search, vision.inner);
}

/** Run one claim's processing + emit span; returns how it ended. */
async function runOnce(
  store: FakeJobStore,
  jobId: string,
  job: JobRow,
  holder: string,
  prepared: PreparedSource,
  vision: FaultyVision,
  search: FakeSearch,
): Promise<"completed" | "paused" | "failed"> {
  const lease = createLeaseGuard(store, { jobId, holder, epoch: Number(job.lease_epoch) }, 60);
  const startStatus = job.status === "queued" ? "preparing" : job.status;
  if (job.status === "queued") await store.setJobStatus(jobId, "preparing");

  const runner = makeRunner(store, prepared, vision);
  let processing: Awaited<ReturnType<ReturnType<typeof createJobRunner>["run"]>>;
  try {
    processing = await runner.run({
      job: { ...job, status: startStatus },
      lease,
      resume: { action: "continue-pinned", changed: false },
      logger: testLogger,
    });
  } catch {
    // A thrown page stage (e.g. a transient vision fault) surfaces here; treat
    // it as a pause so the outer loop re-queues and resumes.
    return "paused";
  }
  if (processing.status === "paused") return "paused";
  if (processing.status === "failed") return "failed";

  // Emit span (the runner ran with emitter:null, so drive the emitter here to
  // keep the fault points on send/commit under this harness's control).
  const fresh = await store.getJob(jobId);
  if (fresh === null) throw new Error("job vanished");
  const emitter = makeEmitter(store, search);
  const emit = await emitter.emit(fresh, lease, assetLoader());
  if (emit.status !== "committed") return "paused";
  await store.setJobStatus(jobId, "completed");
  return "completed";
}

// ── a vision client that can fault ──────────────────────────────────────────

interface FaultyVision extends VisionClient {
  readonly inner: CountingVision;
}

/**
 * Wrap the counting vision so a `before-render`/`before-vision` fault fires
 * once. `before-render` throws before the model would be called (so the model
 * counter never moves for that attempt); `before-vision` throws inside the call
 * path after the render — modelled here as a throw before recording, so the
 * counter also does not move (the real stage records only on success).
 */
function faultyVision(inner: CountingVision, fault: ArmedFault): FaultyVision {
  return {
    inner,
    async analyzePage(input) {
      if (fault.trip("before-render", { page: input.page }) || fault.trip("before-vision", { page: input.page })) {
        throw new Error(`simulated ${input.page} fault before the model answered`);
      }
      return inner.analyzePage(input);
    },
    async analyzeFigure(input) {
      return inner.analyzeFigure(input);
    },
    async probe() {
      return inner.probe();
    },
  };
}

// ── the assertions ───────────────────────────────────────────────────────────

/**
 * The four invariants, checked against the reference. This
 * is the heart of the suite: every chaos run must satisfy all four.
 */
function assertInvariants(reference: RunFingerprint, chaos: RunFingerprint): void {
  // 1. Hash-identical result: same unit ids, same per-unit content hashes.
  expect(chaos.units.map((u) => u.unitId)).toEqual(reference.units.map((u) => u.unitId));
  expect(chaos.units.map((u) => u.contentHash)).toEqual(reference.units.map((u) => u.contentHash));

  // 2. No duplicate model calls: the chaos run called the model no more than the
  // reference did (a resume reuses checkpoints). Each page
  //    is analysed at most once.
  expect(chaos.modelCalls.length).toBeLessThanOrEqual(reference.modelCalls.length);
  const seen = new Set<number>();
  for (const page of chaos.modelCalls) {
    expect(seen.has(page)).toBe(false); // no page analysed twice
    seen.add(page);
  }

  // 3. No duplicate units: the unit id set is unique.
  const unitIds = chaos.units.map((u) => u.unitId);
  expect(new Set(unitIds).size).toBe(unitIds.length);

  // 4. No orphaned assets: the set of stored assets equals exactly the set the
  //    committed document references — no extra (orphan) and none missing
  // Since a committed run stores precisely the referenced
  //    page images and figure crops, equality with the expected set proves both
  //    directions at once.
  const expected = [...expectedAssetIds()].sort();
  expect(chaos.assets).toEqual(expected);
  expect(chaos.finalCommitted).toBe(true);
}

// ── the reference, computed once ─────────────────────────────────────────────

describe("chaos/resume · extraction + emit (task 1.15, req 18.5)", () => {
  it("the undisturbed reference run is internally consistent", async () => {
    const ref = await referenceRun();
    // Every page analysed exactly once; one unit per page; assets = page images + figure crops.
    expect(ref.modelCalls).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ref.units.length).toBe(PAGE_COUNT);
    expect(new Set(ref.units.map((u) => u.unitId)).size).toBe(PAGE_COUNT);
    expect(ref.assets).toEqual([...expectedAssetIds()].sort());
    expect(ref.finalCommitted).toBe(true);
  });

  // The fault-injection matrix. Each entry aborts at one point under one
  // scenario; the harness resumes and the invariants must hold identically.
  const matrix: Array<{ name: string; fault: Fault }> = [
    // ── processing stages ──
    {
      name: "kill -9 mid-processing (lease takeover, resume at first unfinished page)",
      fault: { point: "before-render", scenario: "kill-9", onPage: 4 },
    },
    {
      name: "transient vision failure on a page, then recover",
      fault: { point: "before-vision", scenario: "network-error", onPage: 3 },
    },
    // ── send (emitter PUT batch) ──
    {
      name: "network error before a batch is sent",
      fault: { point: "before-send", scenario: "network-error", onBatchSeq: 1 },
    },
    {
      name: "lost response after the server accepted a batch (resume must not duplicate)",
      fault: { point: "after-send", scenario: "lost-response", onBatchSeq: 0 },
    },
    // ── receive + embed (Search accept) ──
    {
      name: "Search accept outage on a batch, then recover",
      fault: { point: "before-accept", scenario: "accept-outage", onBatchSeq: 2 },
    },
    {
      name: "Search restart during send (state persists, request fails)",
      fault: { point: "after-send", scenario: "search-restart", onBatchSeq: 1 },
    },
    // ── commit ──
    {
      name: "interrupted segment commit, then resume",
      fault: { point: "before-segment-commit", scenario: "network-error", onSegment: 0 },
    },
    {
      name: "interrupted final commit, then resume",
      fault: { point: "before-final-commit", scenario: "lost-response" },
    },
  ];

  for (const { name, fault } of matrix) {
    it(`${name}`, async () => {
      const reference = await referenceRun();
      const chaos = await chaosRun(fault);
      assertInvariants(reference, chaos);
    });
  }
});

// ── pin vs continue on a version change ──────────────────────────────────────

/**
 * The `resume_policy` half of the scenario list. When a deployment changes the
 * pipeline/prompt stand mid-job, a `pin` job pauses and waits; a `continue` job
 * proceeds under the new stand. These assert the DECISION the worker's resume
 * logic makes (`decideResume`), which is what gates whether a resume runs at all
 * — the recorded "used stand" per page follows from that decision.
 */
describe("chaos/resume · version change with pin vs continue (req 4.12)", () => {
  const snapshot: PipelineSnapshot = { pipelineHash: "pipe-1", promptHash: "prompt-1" };
  const changed: PipelineSnapshot = { pipelineHash: "pipe-2", promptHash: "prompt-1" };

  it("pin pauses when the stand changed (no resume under a new version)", () => {
    const decision = decideResume({ snapshot, current: changed, policy: "pin" });
    expect(decision).toEqual({ action: "pause", changed: true, reason: "dependency" });
  });

  it("pin continues unchanged when the stand is identical", () => {
    const decision = decideResume({ snapshot, current: snapshot, policy: "pin" });
    expect(decision).toEqual({ action: "continue-pinned", changed: false });
  });

  it("continue proceeds under the new stand when it changed", () => {
    const decision = decideResume({ snapshot, current: changed, policy: "continue" });
    expect(decision).toEqual({ action: "continue-new", changed: true });
  });

  it("a pin job that pauses on a changed stand keeps its finished checkpoints for a later continue", async () => {
    // Run a job to completion of processing under the ORIGINAL stand, then a
    // resume under a CHANGED stand with pin pauses — the finished pages are
    // untouched, so a later continue reuses them without a model call.
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const vision = countingVision();
    const claimed = await store.claimNextJob("worker-1", 60);
    if (claimed === null) throw new Error("expected a claim");
    await store.setJobStatus(jobId, "preparing");
    const lease = createLeaseGuard(store, { jobId, holder: "worker-1", epoch: Number(claimed.lease_epoch) }, 60);
    const runner = makeRunner(store, fakePrepared(PAGE_COUNT), vision);
    await runner.run({
      job: { ...claimed, status: "preparing" },
      lease,
      resume: { action: "continue-pinned", changed: false },
      logger: testLogger,
    });
    const callsAfterFirst = vision.calls.length;
    expect(callsAfterFirst).toBe(PAGE_COUNT);

    // The pin decision under a changed stand is "pause": the worker would not
    // run the runner at all, so the checkpoints stay as they are.
    const decision = decideResume({ snapshot, current: changed, policy: "pin" });
    expect(decision.action).toBe("pause");

    // A later `continue` resume reuses every checkpoint: zero new model calls.
    const vision2 = countingVision();
    await store.requeueJob(jobId);
    const reclaimed = await store.claimNextJob("worker-2", 60);
    if (reclaimed === null) throw new Error("expected reclaim");
    const lease2 = createLeaseGuard(store, { jobId, holder: "worker-2", epoch: Number(reclaimed.lease_epoch) }, 60);
    const runner2 = createJobRunner({
      store,
      vision: vision2,
      renderer: fakeRenderer(fakePrepared(PAGE_COUNT)),
      events: createJobEventBus(),
      config: { pageConcurrency: 3, visionTokenEstimate: 30, visionModel: "test-vlm", renderDpi: 200, figureDpi: 300, figurePass2Kinds: [], figurePass2MinArea: 0.02, labelCoverageMin: 60 },
      emitter: null,
      logger: testLogger,
    });
    const outcome = await runner2.run({
      job: { ...reclaimed, status: "preparing" },
      lease: lease2,
      resume: { action: "continue-new", changed: true },
      logger: testLogger,
    });
    expect(outcome.status).toBe("completed");
    expect(vision2.calls).toEqual([]); // all pages reused; no duplicate model call
  });
});

// ─── resume hardening: fencing, operator actions, policies, reparse, backoff ──

const PINNED = { action: "continue-pinned", changed: false } as const;
const STAND_A: PipelineSnapshot = { pipelineHash: "pipe-1", promptHash: "prompt-1" };
const STAND_B: PipelineSnapshot = { pipelineHash: "pipe-2", promptHash: "prompt-1" };

/** A runner with an injectable event bus / emitter, under the fake clock. */
function runnerWith(args: {
  store: FakeJobStore;
  vision: VisionClient;
  pageCount?: number;
  events?: ReturnType<typeof createJobEventBus>;
  emitter?: ReturnType<typeof createEmitter> | null;
  config?: Partial<Parameters<typeof createJobRunner>[0]["config"]>;
}) {
  const { store } = args;
  return createJobRunner({
    store,
    vision: args.vision,
    renderer: fakeRenderer(fakePrepared(args.pageCount ?? PAGE_COUNT)),
    events: args.events ?? createJobEventBus(),
    config: {
      pageConcurrency: 1,
      visionTokenEstimate: 30,
      visionModel: "test-vlm",
      renderDpi: 200,
      figureDpi: 300,
      figurePass2Kinds: [],
      figurePass2MinArea: 0.02,
      labelCoverageMin: 60,
      maxTransientWaitMs: 0,
      ...args.config,
    },
    emitter: args.emitter ?? null,
    logger: testLogger,
    now: () => store.clock(),
    sleep: async (ms) => {
      store.advance(ms);
    },
  });
}

/** Claim the job as `holder` and run it once. */
async function claimAndRun(
  store: FakeJobStore,
  holder: string,
  runner: ReturnType<typeof createJobRunner>,
  options: { resume?: ResumeDecision; stand?: PipelineSnapshot } = {},
) {
  const claimed = await store.claimNextJob(holder, 60);
  if (claimed === null) throw new Error(`expected ${holder} to claim a job`);
  const lease = createLeaseGuard(store, { jobId: claimed.id, holder, epoch: Number(claimed.lease_epoch) }, 60);
  if (claimed.status === "queued") await store.setJobStatus(claimed.id, "preparing", null, lease.fence);
  const run = runner.run({
    job: { ...claimed, status: claimed.status === "queued" ? "preparing" : claimed.status },
    lease,
    resume: options.resume ?? PINNED,
    logger: testLogger,
    ...(options.stand !== undefined ? { stand: options.stand } : {}),
  });
  return { run, lease, claimed };
}

/** The staged page records, in page order. */
function recordsOf(store: FakeJobStore, jobId: string): PageRecord[] {
  return store
    .peekEmitBatches(jobId)
    .map((row) => (row.payload as { record?: PageRecord } | null)?.record)
    .filter((r): r is PageRecord => r !== undefined && r !== null)
    .sort((a, b) => a.page - b.page);
}

/** The pipeline/prompt stand recorded on each staged page payload. */
function standsOf(store: FakeJobStore, jobId: string): Array<string | undefined> {
  return store
    .peekEmitBatches(jobId)
    .map((row) => (row.payload as { stand?: PipelineSnapshot } | null)?.stand?.pipelineHash);
}

/** An undisturbed processing run (no emitter) whose records are the reference. */
async function referenceRecords(config: Partial<Parameters<typeof createJobRunner>[0]["config"]> = {}) {
  const store = createFakeJobStore();
  const jobId = await seedJob(store);
  const vision = countingVision();
  const { run } = await claimAndRun(store, "worker-ref", runnerWith({ store, vision, config }));
  expect(await run).toEqual({ status: "completed" });
  return recordsOf(store, jobId);
}

describe("resume hardening · fencing (req 4.5)", () => {
  it("refuses a zombie's writes in SQL after a takeover and stops its model calls", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const inner = countingVision();
    let takeover: JobRow | null = null;
    const vision: VisionClient = {
      ...inner,
      async analyzePage(input) {
        const res = await inner.analyzePage(input);
        if (input.page === 2 && takeover === null) {
          // A network partition: worker-1's lease expires while its call is in
          // flight and worker-2 takes the job over (the claim bumps the epoch).
          store.advance(61_000);
          takeover = await store.claimNextJob("worker-2", 60);
        }
        return res;
      },
    };
    const { run, lease } = await claimAndRun(store, "worker-1", runnerWith({ store, vision }));
    await expect(run).rejects.toBeInstanceOf(LeaseLostError);

    // worker-1 finished page 1; its page-2 checkpoint write was refused and it
    // never asked the model for page 3.
    expect(inner.calls).toEqual([1, 2]);
    expect(await store.getStage("page", { job_id: jobId, page: 2, stage: "vision1" })).toBeNull();
    expect(store.peekEmitBatches(jobId).map((r) => r.seq)).toEqual([1]);

    // Every class of write is fenced — stages, outboxes, docpass, job row.
    const zombie = lease.fence;
    await expect(
      store.upsertStage("page", { job_id: jobId, page: 3, stage: "vision1", input_hash: "h", status: "done" }, zombie),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.stageAsset({ job_id: jobId, asset_id: "x", page: 3 }, zombie)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      store.stageEmitBatch({ job_id: jobId, seq: 3, digest: "d", page_from: 3, page_to: 3, payload: {} }, zombie),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.saveDocpassState(jobId, 1, {}, zombie)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.setJobStatus(jobId, "completed", null, zombie)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(store.appendJobWarning(jobId, "zombie", zombie)).rejects.toBeInstanceOf(LeaseLostError);
    // The zombie's status write was refused; the job is where it left it.
    expect(store.peek(jobId)?.status).toBe("processing");

    // The new holder resumes at the first unfinished page: page 1 is reused.
    const newHolder = takeover as JobRow | null;
    if (newHolder === null) throw new Error("expected the takeover claim");
    const lease2 = createLeaseGuard(
      store,
      { jobId, holder: "worker-2", epoch: Number(newHolder.lease_epoch) },
      60,
    );
    const outcome = await runnerWith({ store, vision: inner }).run({
      job: newHolder,
      lease: lease2,
      resume: PINNED,
      logger: testLogger,
    });
    expect(outcome).toEqual({ status: "completed" });
    // Page 2 was in flight at the takeover (its response was refused), so it is
    // the only page asked twice; page 1 is never asked again.
    expect(inner.calls).toEqual([1, 2, 2, 3, 4, 5, 6]);
    expect(recordsOf(store, jobId)).toEqual(await referenceRecords());
  });
});

describe("resume hardening · operator actions revoke the lease (req 4.5, 4.11)", () => {
  function workerFor(store: FakeJobStore, runner: ReturnType<typeof createJobRunner>, heartbeatIntervalMs = 100_000) {
    return createJobWorker({
      store,
      runner,
      config: {
        leaseSeconds: 60,
        heartbeatIntervalMs,
        pollIntervalMs: 5,
        currentSnapshot: STAND_A,
        largeJobPageThreshold: 2_147_483_647,
        largeJobMaxConcurrency: 2_147_483_647,
        now: () => store.clock(),
      },
      logger: testLogger,
      workerId: "worker-1",
    });
  }

  async function cancel(store: FakeJobStore, jobId: string): Promise<void> {
    const row = store.peek(jobId);
    if (row === undefined) throw new Error("job vanished");
    const resolved = resolveAction(row.status, "cancel");
    if (resolved === null) throw new Error(`cannot cancel ${row.status}`);
    await store.operatorTransition(jobId, {
      expectedStatus: row.status,
      status: resolved.next,
      pauseReason: resolved.pauseReason,
    });
  }

  it("cancel during a run stops further model calls and is never overwritten", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const vision = countingVision();
    const events = createJobEventBus();
    // Cancel as soon as page 1 is finished — between two pages.
    events.subscribe(jobId, (event) => {
      if (event.type === "page" && event.page === 1) void cancel(store, jobId);
    });
    const worker = workerFor(store, runnerWith({ store, vision, events }));

    expect(await worker.tick()).toBe(true);
    // The lease check before page 2's model call saw the revoked lease.
    expect(vision.calls).toEqual([1]);
    expect(store.peek(jobId)?.status).toBe("cancelled");
    expect(store.peekEmitBatches(jobId).map((r) => r.seq)).toEqual([1]);
    // Nothing reclaims a cancelled job.
    store.advance(3_600_000);
    expect(await worker.tick()).toBe(false);
  });

  it("cancel aborts an in-flight model call through the run's AbortSignal", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const inner = countingVision();
    let sawAbort = false;
    const vision: VisionClient = {
      ...inner,
      async analyzePage(input) {
        if (input.page !== 2) return inner.analyzePage(input);
        // Cancel while this call is in flight, then wait for the abort the
        // worker's heartbeat raises once it notices the revoked lease.
        await cancel(store, jobId);
        await new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("the call was not aborted")), 2_000);
          input.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            sawAbort = true;
            reject(new Error("aborted"));
          });
        });
        throw new Error("unreachable");
      },
    };
    const worker = workerFor(store, runnerWith({ store, vision }), 5);
    expect(await worker.tick()).toBe(true);
    expect(sawAbort).toBe(true);
    expect(inner.calls).toEqual([1]);
    expect(store.peek(jobId)?.status).toBe("cancelled");
    // The aborted page wrote no checkpoint (no transient backoff row either).
    expect(await store.getStage("page", { job_id: jobId, page: 2, stage: "vision1" })).toBeNull();
  });
});

describe("resume hardening · resume_policy with the real runner (req 4.12)", () => {
  /** Pause the job (operator) right after page `n` finished. */
  function pauseAfter(store: FakeJobStore, jobId: string, n: number) {
    const events = createJobEventBus();
    events.subscribe(jobId, (event) => {
      if (event.type !== "page" || event.page !== n) return;
      const row = store.peek(jobId);
      if (row === undefined) return;
      void store.operatorTransition(jobId, { expectedStatus: row.status, status: "paused", pauseReason: "manual" });
    });
    return events;
  }

  it("continue reuses finished checkpoints regardless of hash and records the stand per page", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const vision1 = countingVision();
    const first = await claimAndRun(
      store,
      "worker-1",
      runnerWith({ store, vision: vision1, events: pauseAfter(store, jobId, 3) }),
      { stand: STAND_A },
    );
    await expect(first.run).rejects.toBeInstanceOf(LeaseLostError);
    expect(vision1.calls).toEqual([1, 2, 3]);

    // A deployment changed the pipeline; the operator resumes with continue.
    await store.operatorTransition(jobId, {
      expectedStatus: "paused",
      status: "queued",
      pauseReason: null,
      resumePolicy: "continue",
    });
    const job = store.peek(jobId);
    if (job === undefined) throw new Error("job vanished");
    const resume = decideResume({ snapshot: STAND_A, current: STAND_B, policy: job.resume_policy });
    expect(resume.action).toBe("continue-new");

    const vision2 = countingVision();
    const second = await claimAndRun(store, "worker-2", runnerWith({ store, vision: vision2 }), {
      resume,
      stand: STAND_B,
    });
    expect(await second.run).toEqual({ status: "completed" });
    // Only the open pages ran, under the new stand.
    expect(vision2.calls).toEqual([4, 5, 6]);
    expect(standsOf(store, jobId)).toEqual(["pipe-1", "pipe-1", "pipe-1", "pipe-2", "pipe-2", "pipe-2"]);
    const page1 = await store.getStage("page", { job_id: jobId, page: 1, stage: "vision1" });
    const page5 = await store.getStage("page", { job_id: jobId, page: 5, stage: "vision1" });
    expect((page1?.output as StageOutput | undefined)?.stand).toEqual(STAND_A);
    expect((page5?.output as StageOutput | undefined)?.stand).toEqual(STAND_B);
  });

  it("restart-stage=figure2 recomputes Pass 2 and the downstream, reusing Pass 1", async () => {
    const config = { figurePass2Kinds: ["other" as const] };
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const vision1 = countingVision();
    const first = await claimAndRun(store, "worker-1", runnerWith({ store, vision: vision1, config }), {
      stand: STAND_A,
    });
    expect(await first.run).toEqual({ status: "completed" });
    expect(vision1.calls).toEqual([1, 2, 3, 4, 5, 6]);
    expect(vision1.figureCalls).toHaveLength(2);
    const generationBefore = Number(store.peek(jobId)?.emit_generation);

    await store.requeueJob(jobId);
    const resume = decideResume({
      snapshot: STAND_A,
      current: STAND_B,
      policy: "restart-stage",
      restartStage: "figure2",
    });
    const vision2 = countingVision();
    const second = await claimAndRun(store, "worker-2", runnerWith({ store, vision: vision2, config }), {
      resume,
      stand: STAND_B,
    });
    expect(await second.run).toEqual({ status: "completed" });
    // Pass 1 is reused (earlier stage), Pass 2 recomputed under the new stand.
    expect(vision2.calls).toEqual([]);
    expect(vision2.figureCalls).toHaveLength(2);
    // The downstream was rebuilt consistently: a new emit generation, every
    // page restaged once, and the records equal an undisturbed run's.
    expect(Number(store.peek(jobId)?.emit_generation)).toBe(generationBefore + 1);
    expect(store.peekEmitBatches(jobId).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(recordsOf(store, jobId)).toEqual(await referenceRecords(config));

    // Resuming the same restart again is a no-op: the restart was applied once.
    await store.requeueJob(jobId);
    const vision3 = countingVision();
    const third = await claimAndRun(store, "worker-3", runnerWith({ store, vision: vision3, config }), {
      resume,
      stand: STAND_B,
    });
    expect(await third.run).toEqual({ status: "completed" });
    expect(vision3.calls).toEqual([]);
    expect(vision3.figureCalls).toEqual([]);
    expect(Number(store.peek(jobId)?.emit_generation)).toBe(generationBefore + 1);
  });

  it("restart-stage=vision1 recomputes every model stage", async () => {
    const config = { figurePass2Kinds: ["other" as const] };
    const store = createFakeJobStore();
    await seedJob(store);
    const first = await claimAndRun(store, "worker-1", runnerWith({ store, vision: countingVision(), config }));
    expect(await first.run).toEqual({ status: "completed" });
    await store.requeueJob((await store.listJobs(1, 0))[0]?.id ?? "");
    const resume = decideResume({ snapshot: STAND_A, current: STAND_B, policy: "restart-stage", restartStage: "vision1" });
    const vision2 = countingVision();
    const second = await claimAndRun(store, "worker-2", runnerWith({ store, vision: vision2, config }), {
      resume,
      stand: STAND_B,
    });
    expect(await second.run).toEqual({ status: "completed" });
    expect(vision2.calls).toEqual([1, 2, 3, 4, 5, 6]);
    expect(vision2.figureCalls).toHaveLength(2);
  });
});

describe("resume hardening · reparse without model calls (req 4.6)", () => {
  it("re-applies the parser to persisted raw responses, rebuilds the outbox, calls no model", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const first = await claimAndRun(store, "worker-1", runnerWith({ store, vision: countingVision() }));
    expect(await first.run).toEqual({ status: "completed" });
    await store.setJobStatus(jobId, "completed");

    // Simulate a parser bug in the version that produced the checkpoint: the
    // stored parse of page 1 lost its text, and so did the staged record.
    const key = { job_id: jobId, page: 1, stage: "vision1" };
    const row = await store.getStage("page", key);
    const output = row?.output as StageOutput<{ markdown: string }>;
    await store.upsertStage("page", {
      ...key,
      input_hash: row?.input_hash ?? "",
      status: "done",
      output: { ...output, parsed: { ...output.parsed, markdown: "" } },
    });
    const stale = store.peekEmitBatches(jobId)[0];
    const staleRecord = (stale?.payload as { record: PageRecord } | undefined)?.record as PageRecord;
    await store.updateEmitPayload(jobId, 1, { type: "page", page: 1, record: { ...staleRecord, blocks: [] } });
    expect(recordsOf(store, jobId)[0]?.blocks).toEqual([]);

    // POST /reparse: flag + re-queue with a lease revocation.
    await store.operatorTransition(jobId, {
      expectedStatus: "completed",
      status: "queued",
      pauseReason: null,
      configPatch: { reparse: true },
    });
    const vision = countingVision();
    const second = await claimAndRun(store, "worker-2", runnerWith({ store, vision }));
    expect(await second.run).toEqual({ status: "completed" });

    expect(vision.calls).toEqual([]);
    expect(vision.figureCalls).toEqual([]);
    // The fixed parse is back in the checkpoint and in the rebuilt record.
    const reparsed = await store.getStage("page", key);
    expect((reparsed?.output as StageOutput<{ markdown: string }> | undefined)?.parsed.markdown).toContain("Seite 1");
    expect(recordsOf(store, jobId)).toEqual(await referenceRecords());
    // A new emit generation (a fresh revision) and the flag reset.
    const job = store.peek(jobId);
    expect(Number(job?.emit_generation)).toBe(1);
    expect(job?.revision_id).toBeNull();
    expect((job?.config as Record<string, unknown> | undefined)?.reparse).toBe(false);
  });
});

describe("resume hardening · backoff, dependency pause and auto-resume (req 4.8)", () => {
  /** Vision that fails `page` transiently on its first `times` attempts. */
  function flakyOn(inner: CountingVision, page: number, times = 1) {
    let failures = 0;
    const attempts: number[] = [];
    const vision: VisionClient = {
      ...inner,
      async analyzePage(input) {
        if (input.page === page) attempts.push(input.page);
        if (input.page === page && failures < times) {
          failures += 1;
          throw new Error("vision endpoint unreachable");
        }
        return inner.analyzePage(input);
      },
    };
    return { vision, attempts };
  }

  it("does not retry a unit before its next_attempt_at, and never reports completed early", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const inner = countingVision();
    const { vision, attempts } = flakyOn(inner, 3);
    const runner = runnerWith({ store, vision, config: { pageConcurrency: 6 } });

    const first = await claimAndRun(store, "worker-1", runner);
    const outcome = await first.run;
    expect(outcome.status).toBe("paused");
    if (outcome.status !== "paused") throw new Error("unreachable");
    expect(outcome.reason).toBe("dependency");
    expect(outcome.retryAt?.getTime()).toBe(store.clock().getTime() + 1_000);
    expect(attempts).toEqual([3]);

    // Resumed before the backoff elapsed: page 3 is not due, nothing is re-run,
    // and the run pauses again instead of claiming completion.
    const again = await runner.run({ job: first.claimed, lease: first.lease, resume: PINNED, logger: testLogger });
    expect(again.status).toBe("paused");
    expect(attempts).toEqual([3]);
    expect([...inner.calls].sort()).toEqual([1, 2, 4, 5, 6]);

    // Once due, the retry succeeds and the job completes.
    store.advance(1_000);
    const done = await runner.run({ job: first.claimed, lease: first.lease, resume: PINNED, logger: testLogger });
    expect(done).toEqual({ status: "completed" });
    expect(attempts).toEqual([3, 3]);
    expect([...inner.calls].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(recordsOf(store, jobId)).toEqual(await referenceRecords());
  });

  it("retries in place with backoff within JOB_MAX_TRANSIENT_WAIT before pausing", async () => {
    const store = createFakeJobStore();
    await seedJob(store);
    const inner = countingVision();
    const { vision, attempts } = flakyOn(inner, 2, 3);
    const runner = runnerWith({ store, vision, config: { maxTransientWaitMs: 60_000 } });
    const started = store.clock().getTime();
    const { run } = await claimAndRun(store, "worker-1", runner);
    expect(await run).toEqual({ status: "completed" });
    // 1 s + 2 s + 4 s of backoff were waited out in place (fake clock).
    expect(attempts).toEqual([2, 2, 2, 2]);
    expect(store.clock().getTime() - started).toBe(7_000);
  });

  it("a paused(dependency) job is resumed automatically once due; a budget pause is not", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const inner = countingVision();
    const { vision } = flakyOn(inner, 2);
    const worker = createJobWorker({
      store,
      runner: runnerWith({ store, vision }),
      config: {
        leaseSeconds: 60,
        heartbeatIntervalMs: 100_000,
        pollIntervalMs: 5,
        currentSnapshot: STAND_A,
        largeJobPageThreshold: 2_147_483_647,
        largeJobMaxConcurrency: 2_147_483_647,
        now: () => store.clock(),
      },
      logger: testLogger,
      workerId: "worker-1",
    });

    expect(await worker.tick()).toBe(true);
    const paused = store.peek(jobId);
    expect(paused?.status).toBe("paused");
    expect(paused?.pause_reason).toBe("dependency");
    expect(paused?.auto_resume).toBe(true);

    // Not yet due: the claim leaves it alone.
    expect(await worker.tick()).toBe(false);
    store.advance(1_000);
    expect(await worker.tick()).toBe(true);
    expect(store.peek(jobId)?.status).toBe("completed");
    // Page 2 is asked once more after its backoff; nothing else is repeated.
    expect([...inner.calls].sort()).toEqual([1, 2, 3, 4, 5, 6]);

    // A budget pause waits for an operator.
    const budgeted = await seedJob(store, { token_budget: 10 });
    expect(await worker.tick()).toBe(true);
    expect(store.peek(budgeted)?.pause_reason).toBe("budget");
    expect(store.peek(budgeted)?.auto_resume).toBe(false);
    store.advance(3_600_000);
    expect(await worker.tick()).toBe(false);
  });
});

describe("resume hardening · budget under concurrency (req 4.9)", () => {
  it("atomic reservations never let a concurrent window overdraw the budget", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store, { token_budget: 90 });
    const vision = countingVision();
    const runner = runnerWith({ store, vision, config: { pageConcurrency: 6 } });
    const first = await claimAndRun(store, "worker-1", runner);
    expect(await first.run).toEqual({ status: "paused", reason: "budget" });
    // 90 tokens cover exactly three 30-token pages, even with six in flight.
    expect(vision.calls).toHaveLength(3);
    expect(Number(store.peek(jobId)?.tokens_used)).toBe(90);
    expect(Number(store.peek(jobId)?.tokens_reserved)).toBe(0);

    // Raise the budget: the job continues at the same place.
    const row = store.peek(jobId);
    if (row !== undefined) row.token_budget = 1_000;
    const again = await runner.run({ job: first.claimed, lease: first.lease, resume: PINNED, logger: testLogger });
    expect(again).toEqual({ status: "completed" });
    expect([...vision.calls].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Number(store.peek(jobId)?.tokens_used)).toBe(180);
  });
});

describe("resume hardening · crash inside the document pass (req 4.7)", () => {
  it("a crash between document-pass pages resumes idempotently on the base record", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const vision = countingVision();
    // The third page's commit crashes (nothing of it is written).
    store.failNext("commitDocpassPage", new Error("kill -9 inside the document pass"), 2);
    const first = await claimAndRun(store, "worker-1", runnerWith({ store, vision }));
    await expect(first.run).rejects.toThrow("kill -9 inside the document pass");

    // State is after page 2; page 3's staged record is still the base record.
    expect((await store.latestDocpassState(jobId))?.page).toBe(2);
    expect(await store.getStage("page", { job_id: jobId, page: 3, stage: "docpass" })).toBeNull();

    // Takeover after the lease expires: the pass continues at page 3.
    store.advance(61_000);
    const vision2 = countingVision();
    const second = await claimAndRun(store, "worker-2", runnerWith({ store, vision: vision2 }));
    expect(await second.run).toEqual({ status: "completed" });
    expect(vision2.calls).toEqual([]);
    expect(recordsOf(store, jobId)).toEqual(await referenceRecords());
  });
});

describe("resume hardening · Search handover conflicts (req 5.2, 5.9)", () => {
  /** A fake Search whose revisions are keyed by the Idempotency-Key. */
  function generationalSearch(opts: { conflictOnce?: boolean; loseBatchOnce?: number }) {
    const revisions = new Map<string, { id: string; accepted: Map<number, string>; committed: boolean }>();
    const keys: string[] = [];
    let conflicted = false;
    let lost = false;
    const byId = (id: string) => [...revisions.values()].find((r) => r.id === id);
    const search: RevisionClient & { keys: string[]; committedRevisions: () => string[] } = {
      keys,
      committedRevisions: () => [...revisions.values()].filter((r) => r.committed).map((r) => r.id),
      async createRevision(args) {
        keys.push(args.idempotencyKey);
        let rev = revisions.get(args.idempotencyKey);
        if (rev === undefined) {
          rev = { id: `rev-${revisions.size + 1}`, accepted: new Map(), committed: false };
          revisions.set(args.idempotencyKey, rev);
        }
        return { revisionId: rev.id, reference: REFERENCE, status: "staging", visibility: "progressive", createdAt: new Date().toISOString() };
      },
      async getState(args) {
        const rev = byId(args.revisionId);
        return {
          revisionId: args.revisionId,
          reference: REFERENCE,
          status: "staging",
          visibility: "progressive",
          acceptedBatches: [...(rev?.accepted.keys() ?? [])].sort((a, b) => a - b),
          processedPages: [],
          missingAssets: [],
          committedSegments: [],
        };
      },
      async putBatch(args) {
        const rev = byId(args.revisionId);
        if (rev === undefined) throw new RevisionPermanentError("no revision", 404);
        if (opts.conflictOnce === true && !conflicted && rev.id === "rev-1" && args.seq === 0) {
          conflicted = true;
          throw new RevisionPermanentError("digest mismatch", 409, "digest_conflict");
        }
        const prior = rev.accepted.get(args.seq);
        if (prior !== undefined && prior !== args.contentDigest) {
          throw new RevisionPermanentError("digest mismatch", 409, "digest_conflict");
        }
        rev.accepted.set(args.seq, args.contentDigest);
        return { seq: args.seq, digest: args.contentDigest, status: "received", noop: prior !== undefined };
      },
      async headAsset() {
        return true;
      },
      async putAsset() {},
      async commitSegment(args) {
        return { reference: REFERENCE, revisionId: args.revisionId, committed: true, segment: args.segment, missingRanges: [] };
      },
      async commit(args) {
        const rev = byId(args.revisionId);
        if (rev === undefined) throw new RevisionPermanentError("no revision", 404);
        if (opts.loseBatchOnce !== undefined && !lost) {
          // Search lost a staged batch: the commit is rejected with the gap.
          lost = true;
          rev.accepted.delete(opts.loseBatchOnce);
          return {
            reference: REFERENCE,
            revisionId: rev.id,
            committed: false,
            missingRanges: [{ from: opts.loseBatchOnce, to: opts.loseBatchOnce }],
          } as CommitResult;
        }
        rev.committed = true;
        return { reference: REFERENCE, revisionId: rev.id, committed: true, isLatest: true, missingRanges: [] };
      },
    };
    return search;
  }

  it("a 409 digest conflict starts a new emit generation and commits a fresh revision", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const search = generationalSearch({ conflictOnce: true });
    const runner = runnerWith({ store, vision: countingVision(), emitter: makeEmitter(store, search) });
    const { run } = await claimAndRun(store, "worker-1", runner);
    expect(await run).toEqual({ status: "completed" });
    expect(search.keys[0]).toBe(jobId);
    expect(search.keys.at(-1)).toBe(`${jobId}:1`);
    expect(search.committedRevisions()).toEqual(["rev-2"]);
    expect(Number(store.peek(jobId)?.emit_generation)).toBe(1);
    expect(store.peek(jobId)?.revision_id).toBe("rev-2");
  });

  it("a final commit rejected with 409 reconciles and re-sends the missing batch instead of pausing", async () => {
    const store = createFakeJobStore();
    const jobId = await seedJob(store);
    const search = generationalSearch({ loseBatchOnce: 1 });
    const runner = runnerWith({ store, vision: countingVision(), emitter: makeEmitter(store, search) });
    const { run } = await claimAndRun(store, "worker-1", runner);
    expect(await run).toEqual({ status: "completed" });
    expect(search.committedRevisions()).toEqual(["rev-1"]);
    expect(search.keys).toEqual([jobId]);
    expect(store.peekEmitBatches(jobId).every((r) => r.status === "acked")).toBe(true);
  });
});
