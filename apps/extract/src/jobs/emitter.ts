// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/emitter.ts
 *
 * The outbox emitter: it streams a job's staged pages and crops to Search's
 * revision API and reconciles the local outbox against the server on resume
 *
 * ## The outbox is the source of truth, the server is the checkpoint
 *
 * The job runner stages one `emit_outbox` row per page (its payload is the
 * page's v2 record) and one `asset_outbox` row per crop and page image, both in
 * page order. This emitter turns that durable ledger into HTTP:
 *
 *   1. Open the revision. The `Idempotency-Key` is derived from the job id and
 *      the job's emit generation, so re-opening on a resume returns the same
 *      revision, while a new generation (reparse, restart-stage, retry-failed,
 *      digest conflict) opens a fresh one instead of colliding with a revision
 *      whose content no longer matches.
 *   2. Reconcile. GET the revision state and mark every already-accepted batch
 *      and every already-present asset `acked` locally — and move a batch the
 *      server does NOT hold back to `pending` — so the send phase sends exactly
 * the missing parts: no duplicates, no loss.
 *   3. Send batches. Group the staged pages into batches of `EMIT_BATCH_PAGES`
 *      (the first batch carries the `document.begin` record), encode each to NDJSON,
 *      compute the Content-Digest, and PUT at the batch seq. Search answers a
 *      replay of the same seq+digest with `noop`; a DIFFERENT digest at an
 * accepted seq is a `409`, surfaced as `conflict` so the
 *      runner can start a new emit generation rather than pause forever.
 *   4. Upload assets with bounded concurrency (`ASSET_UPLOAD_CONCURRENCY`). Each
 *      asset is idempotent on its checksum; a present asset is skipped.
 *   5. Commit. A segment commit every `SEGMENT_PAGES` pages (progressive
 *      visibility) — issued as soon as the batches and assets of the segment
 *      are acknowledged, while later batches are still being sent, so the first
 *      pages are searchable long before the document is complete — then the
 *      final commit. A final commit rejected with `409`
 * (batches missing) triggers a reconcile-and-resend round
 *      and a re-commit instead of an endless pause.
 *
 * ## Memory stays flat
 *
 * The emitter plans from outbox METADATA only (no payloads) and loads the page
 * records of one batch at a time; assets resolve their page from the outbox's
 * `page` column. A 10 000-page job emits in `10 000 / EMIT_BATCH_PAGES` bounded
 * steps without ever holding every page record.
 *
 * ## Batch seq ↔ page range
 *
 * The staged rows are keyed by page (seq = page). The *batch* seq is derived:
 * batch `b` (0-based) covers pages `[b·N + 1 … b·N + N]`. Search's
 * `acceptedBatches` are batch seqs, so reconciliation maps an accepted batch
 * seq back to its page range. The mapping is deterministic from `N`, so a
 * resume groups identically.
 *
 * `N` is FROZEN per job (`config.emitBatchPages`, written before the first
 * batch is sent): a changed `EMIT_BATCH_PAGES` value must never re-map the
 * batches an open revision already holds. A job that predates the freeze takes
 * the current setting, which is what the release before it used.
 *
 * ## Page windows
 *
 * A job with a `pages` window (contract 2.4) stages only `[first … last]`. Batch
 * seqs stay ABSOLUTE (`floor((page − 1) / N)`), so the first batch seq is not 0:
 * `document.begin` goes into the first batch actually sent, and carries
 * `firstPage` so Search checks completeness over `[first … last]`.
 */

import type { Logger } from "pino";
import {
  encodeRecords,
  sha256Hex,
  type DocumentBeginRecord,
  type DocumentEndRecord,
  type ExtractRecord,
  type IdentifierEntry,
  type OutlineNode,
  type PageRecord,
  type Ref,
  type SummaryNode,
} from "@atf/extract-contract";
import {
  createDocumentPass,
  parseDocpassState,
} from "./docpass/document-pass.js";
import type { ExtractStore } from "../persistence/index.js";
import {
  LeaseLostError,
  type AssetOutboxRow,
  type EmitOutboxRow,
  type JobRow,
} from "../persistence/types.js";
import type { LeaseGuard } from "./lease.js";
import type { RevisionClient, AssetBody } from "../revision-client.js";
import { RevisionPermanentError } from "../revision-client.js";
import { mapOrdered } from "../queue.js";
import {
  chunkingOptionsOf,
  documentAttributesOf,
  emailOf,
  identityOf,
  ingestOptionsOf,
  jobAcl,
} from "./identity.js";
import { firstPageOf, lastPageOf } from "./page-window.js";
import { pageRecordText } from "./page-renderer.js";
import { planSubdocSplit, subdocSplitPlanOf, SUBDOC_SPLIT_KEY } from "./subdoc-split.js";

/** Tunables for the emitter, from `config.emitter` plus pipeline identity. */

/**
 * The `Content-Digest` header of a batch body, RFC 9530 structured form:
 * `sha-256=:<base64>:`. Search decodes the part between the colons as base64,
 * so a hex digest there is read as different bytes and every batch is refused
 * with CONTENT_DIGEST_MISMATCH.
 */
export function contentDigestHeader(body: Uint8Array): string {
  return `sha-256=:${Buffer.from(sha256Hex(body), "hex").toString("base64")}:`;
}

export interface EmitterConfig {
  /** Pages per NDJSON batch sent to Search (frozen per job at its first emit). */
  emitBatchPages: number;
  /** Pages between segment commits. */
  segmentPages: number;
  /** Assets uploaded to Search in parallel. */
  assetUploadConcurrency: number;
  /**
   * Run the optional finalize pass on `document.end`: a deterministic,
   * model-free correction of the outline metadata once the whole document is
   * known. When false the streaming outline is emitted as-is.
   */
  finalizePass: boolean;
  /**
   * `atf-extract/<semver>` — the contract string on the document.begin record,
   * both top-level (`contract`) and on `pipeline.contract`.
   */
  contract: string;
  /**
   * The deployment's current pipeline hash, used for `pipeline.pipelineVersion`
   * when a job carries no frozen `pipeline_hash` of its own.
   */
  pipelineVersion?: string | undefined;
  /** Likewise the current prompt hash, for `pipeline.promptHash`. */
  promptHash?: string | undefined;
  /** Recorded on the document.begin pipeline descriptor. */
  visionModel: string;
  /** Recorded on the document.begin source descriptor / pipeline. */
  renderDpi: number;
  /**
   * How many reconcile-and-resend rounds a final commit rejected with `409`
   * gets within one emit before it is reported `incomplete`. Default 2.
   */
  commitRepairRounds?: number;
}

/**
 * Resolves an asset id to its bytes at send time. Production wiring re-renders
 * the crop deterministically from the source (the bytes were never persisted —
 * only the checksum was — to keep storage flat); tests supply a map. Returning
 * null means the asset cannot be produced and is skipped with a warning rather
 * than failing the job, exactly as a missing v1 crop did.
 */
export interface AssetLoader {
  load(row: AssetOutboxRow): Promise<AssetBody | null>;
}

export interface EmitterDeps {
  store: ExtractStore;
  revisions: RevisionClient;
  config: EmitterConfig;
  logger: Logger;
  /**
   * Observability: the hand-over backlog gauge, set to the
   * number of this job's emit-outbox rows not yet acknowledged by Search after
   * each reconcile/send pass. Optional; absent in tests without metrics.
   */
  metrics?: { setEmitBacklog(pending: number): void } | null;
}

/** `{ [key]: value }` for a non-empty string, else `{}`. */
function optionalString<K extends string>(key: K, value: string | null | undefined): Partial<Record<K, string>> {
  return typeof value === "string" && value !== "" ? ({ [key]: value } as Record<K, string>) : {};
}

/** The outcome of an emit run, for the job runner to act on. */
export type EmitOutcome =
  | { status: "committed"; revisionId: string }
  | { status: "incomplete"; revisionId: string; reason: string }
  | { status: "transient"; revisionId: string | null; reason: string }
  /**
   * Search refused a batch with `409`: the seq was already accepted with a
   * different digest (the staged content changed under the same revision), or
   * the revision no longer accepts batches. The runner starts a new emit
   * generation (a fresh revision) and emits again.
   */
  | { status: "conflict"; revisionId: string; reason: string };

export interface Emitter {
  /**
   * Emit the job's staged outbox to Search and reconcile on resume. The
   * {@link AssetLoader} resolves each staged asset to its bytes at send time.
   * Every persistent write carries the lease fence. Returns `committed` when
   * the final commit succeeded, `incomplete` when the server still reports a
   * gap after the repair rounds, `transient` when Search was unreachable, or
   * `conflict` when a batch digest clashed with the revision.
   */
  emit(job: JobRow, lease: LeaseGuard, assets: AssetLoader): Promise<EmitOutcome>;
}

/**
 * The revision Idempotency-Key for a job's emit generation. Generation 0 keeps
 * the bare job id so revisions opened before generations existed are still
 * found on resume; every later generation is `${jobId}:${generation}`.
 */
export function revisionIdempotencyKey(job: Pick<JobRow, "id" | "emit_generation">): string {
  const generation = Number(job.emit_generation ?? 0);
  return generation > 0 ? `${job.id}:${generation}` : job.id;
}

/** A derived batch: its seq and the page rows it carries, in page order. */
interface Batch {
  seq: number;
  pageFrom: number;
  pageTo: number;
  rows: EmitOutboxRow[];
}

/** What one emit run needs to know about the job's page range and batching. */
interface EmitPlan {
  /** Pages per batch for this job (frozen). */
  n: number;
  /** The reference this stream indexes — the job's own, or a sub-document's. */
  reference: string;
  /** First and last page of the stream, in source page numbers. */
  firstPage: number;
  lastPage: number;
  /** Per-run progress: segments already committed, and segments tried in this pass. */
  committedSegments: Set<number>;
  /**
   * Late Chunking (contract 2.5): the document's full plain text, assembled
   * windowed from the staged page records before the first send. Present only
   * when the job requests late chunking; goes on `document.begin` so Search
   * can embed the document-level vector once per revision.
   */
  documentText?: string;
  /** True when this stream is one sub-document of a split parent document. */
  subdocument?: boolean;
  /**
   * Assets whose page could not be resolved are uploaded by the LAST stream
   * only, so exactly one revision ends up holding them.
   */
  includeUnknownAssets?: boolean;
}

/**
 * One revision stream of an emit run: a reference (the job's own document, or
 * one sub-document of a split) with the page range it indexes and the
 * Idempotency-Key that opens its revision.
 */
interface EmitStream {
  reference: string;
  firstPage: number;
  lastPage: number;
  idempotencyKey: string;
  subdocument?: boolean;
  includeUnknownAssets?: boolean;
}

/** Job-config key under which the batch size is frozen. */
const BATCH_PAGES_KEY = "emitBatchPages";

/**
 * Upper bound on the assembled document text (characters). A generous cap —
 * the batch body limit is far above it — so one oversized document can never
 * bloat the first batch past what Search accepts.
 */
const DOCUMENT_TEXT_MAX_CHARS = 4_000_000;

/** Raised by `sendBatch` when Search answers 409 for a batch PUT. */
class BatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchConflictError";
  }
}

export function createEmitter(deps: EmitterDeps): Emitter {
  const { store, revisions, config, logger } = deps;
  const repairRounds = Math.max(0, config.commitRepairRounds ?? 2);
  const metrics = deps.metrics ?? null;

  /** Publish the emit backlog gauge; a metrics failure never affects the emit. */
  function setBacklog(pending: number): void {
    try {
      metrics?.setEmitBacklog(Math.max(0, pending));
    } catch (err) {
      logger.debug({ err }, "Emit backlog gauge update failed; ignored");
    }
  }

  /**
   * The job's batch size: the frozen value, else the current setting, written
   * to the job config before anything is sent so every later run of this job
   * (resume, repair round, new generation) agrees even if the setting changes.
   */
  async function batchPagesOf(job: JobRow, lease: LeaseGuard): Promise<number> {
    const frozen = (job.config as Record<string, unknown>)[BATCH_PAGES_KEY];
    if (typeof frozen === "number" && Number.isInteger(frozen) && frozen >= 1) return frozen;
    const chosen = Math.max(1, config.emitBatchPages);
    await store.patchJobConfig(job.id, { [BATCH_PAGES_KEY]: chosen }, lease.fence);
    return chosen;
  }

  async function emit(job: JobRow, lease: LeaseGuard, assets: AssetLoader): Promise<EmitOutcome> {
    const n = await batchPagesOf(job, lease);
    const jobConfig = job.config as Record<string, unknown>;
    const firstPage = firstPageOf(jobConfig);
    const lastPage =
      lastPageOf(jobConfig, job.page_count) ?? maxPage(await store.listEmitBatchMeta(job.id));
    const base = { n, firstPage, lastPage };
    const assetPages = await indexAssetPages(job.id, {
      ...base,
      reference: job.reference,
      committedSegments: new Set<number>(),
    });
    // Contract 2.5: the sub-document split plan (frozen on the job config),
    // or a single stream over the whole page range when no split applies.
    const streams = await planStreams(job, lease, base);
    const lateChunking = chunkingOptionsOf(jobConfig).lateChunkingAlpha !== undefined;

    let firstRevisionId = "";
    for (const [i, stream] of streams.entries()) {
      const plan: EmitPlan = {
        ...base,
        reference: stream.reference,
        firstPage: stream.firstPage,
        lastPage: stream.lastPage,
        committedSegments: new Set<number>(),
        ...(streams.length > 1 ? { subdocument: true } : {}),
        includeUnknownAssets: stream.includeUnknownAssets === true,
      };
      // Late Chunking (contract 2.5): assemble the (sub-)document text before
      // the first batch is sent — document.begin rides on that batch.
      // Windowed like indexAssetPages, so memory stays flat for a 10 000-page job.
      if (lateChunking) {
        plan.documentText = await collectDocumentText(job.id, plan);
      }
      const outcome = await emitStream(job, stream, plan, assetPages, lease, assets);
      if (outcome.status !== "committed") return outcome;
      if (i === 0) {
        firstRevisionId = outcome.revisionId;
        if (job.revision_id !== outcome.revisionId) {
          await store.setJobRevision(job.id, outcome.revisionId, lease.fence);
        }
      } else {
        logger.info(
          { jobId: job.id, reference: stream.reference, revisionId: outcome.revisionId },
          "Sub-document revision committed",
        );
      }
    }
    return { status: "committed", revisionId: firstRevisionId };
  }

  /**
   * Open (or idempotently re-open) the stream's revision and run one
   * reconcile → send → commit cycle against it.
   */
  async function emitStream(
    job: JobRow,
    stream: EmitStream,
    plan: EmitPlan,
    assetPages: Map<string, number>,
    lease: LeaseGuard,
    assets: AssetLoader,
  ): Promise<EmitOutcome> {
    const reference = stream.reference;
    const collection = job.collection ?? undefined;
    // ── 1. open (or idempotently re-open) the revision ────────────────────
    let revisionId: string;
    try {
      const identity = identityOf(job.config as Record<string, unknown>);
      const acl = jobAcl(job);
      const chunking = chunkingOptionsOf(job.config as Record<string, unknown>);
      const revision = await revisions.createRevision({
        reference,
        idempotencyKey: stream.idempotencyKey,
        // The source claim Search registered for this job: the final switch
        // marks it indexed. Absent when the source was never identified.
        ...(identity?.registered === true ? { sourceId: job.id } : {}),
        // The document's readers, resolved for the uploading caller.
        ...(acl !== undefined ? { acl } : {}),
        visibility: job.visibility,
        collection,
        // Late Chunking (contract 2.5): Search persists this on the revision
        // and blends every chunk vector of the revision with the document
        // vector carried on document.begin.
        ...(chunking.lateChunkingAlpha !== undefined
          ? { lateChunkingAlpha: chunking.lateChunkingAlpha }
          : {}),
      });
      revisionId = revision.revisionId;
    } catch (err) {
      return transientOrThrow(err, null);
    }

    try {
      // ── 2. reconcile, 3. send (+ segment commits), 4. upload, 4b. document.end ─
      await syncOnce(job, revisionId, collection, assetPages, plan, lease, assets);

      // ── 5. sweep up any segment not yet committed, then the final commit ───
      await commitSegments(job, revisionId, collection, plan);
      for (let round = 0; ; round++) {
        const result = await revisions.commit({ reference, revisionId, collection });
        if (result.committed) break;
        if (round >= repairRounds) {
          return {
            status: "incomplete",
            revisionId,
            reason: `final commit rejected; missing ${result.missingRanges.length} range(s) after ${round} repair round(s)`,
          };
        }
        // 409 with missing ranges: reconcile against the server (which moves
        // the missing batches back to pending) and send exactly those again.
        logger.warn(
          { jobId: job.id, revisionId, missing: result.missingRanges.length, round },
          "Final commit incomplete; reconciling and re-sending the missing parts",
        );
        await syncOnce(job, revisionId, collection, assetPages, plan, lease, assets);
      }
      logger.info(
        { jobId: job.id, revisionId, reference, firstPage: plan.firstPage, pageCount: plan.lastPage },
        "Revision committed",
      );
      return { status: "committed", revisionId };
    } catch (err) {
      if (err instanceof BatchConflictError) {
        logger.warn({ jobId: job.id, revisionId, reason: err.message }, "Batch digest conflict");
        return { status: "conflict", revisionId, reason: err.message };
      }
      return transientOrThrow(err, revisionId);
    }
  }

  /**
   * The revision streams of this emit: one over the whole page range, or one
   * per sub-document when the split is active. The plan is derived from the
   * finished docpass outline and the per-page text sizes and FROZEN into the
   * job config before the first revision opens (same contract as
   * `emitBatchPages`): a resume or a new emit generation re-derives exactly
   * the same sub-documents, and a changed `subdocumentMaxChunks` never
   * re-maps an in-flight job.
   */
  async function planStreams(
    job: JobRow,
    lease: LeaseGuard,
    base: { n: number; firstPage: number; lastPage: number },
  ): Promise<EmitStream[]> {
    const cfg = job.config as Record<string, unknown>;
    const maxChunks = chunkingOptionsOf(cfg).subdocumentMaxChunks;
    let plan = subdocSplitPlanOf(cfg);
    if (maxChunks === undefined) {
      // Budget removed after a freeze (e.g. config edit): honour the whole
      // document rather than a split nobody asked for anymore.
      return [wholeDocumentStream(job, base)];
    }
    if (plan === null || plan.maxChunks !== maxChunks) {
      const outline = await documentOutline(job, base.lastPage);
      const charsPerPage = await charsPerPageMap(job.id, base);
      plan = planSubdocSplit({
        outline,
        firstPage: base.firstPage,
        lastPage: base.lastPage,
        maxChunks,
        charsPerPage,
      });
      if (plan !== null) {
        await store.patchJobConfig(job.id, { [SUBDOC_SPLIT_KEY]: plan }, lease.fence);
        logger.info(
          { jobId: job.id, subdocuments: plan.subdocuments.length, maxChunks },
          "Sub-document split planned",
        );
      }
    }
    if (plan === null) return [wholeDocumentStream(job, base)];
    const keyBase = revisionIdempotencyKey(job);
    return plan.subdocuments.map((sub, idx) => ({
      reference: `${job.reference}/${sub.suffix}`,
      firstPage: sub.firstPage,
      lastPage: sub.lastPage,
      idempotencyKey: `${keyBase}:s${idx}`,
      subdocument: true,
      // Assets whose page could not be resolved go to the last stream, so
      // exactly one revision holds them.
      includeUnknownAssets: idx === plan.subdocuments.length - 1,
    }));
  }

  function wholeDocumentStream(
    job: JobRow,
    base: { n: number; firstPage: number; lastPage: number },
  ): EmitStream {
    return {
      reference: job.reference,
      firstPage: base.firstPage,
      lastPage: base.lastPage,
      idempotencyKey: revisionIdempotencyKey(job),
    };
  }

  /** One reconcile → send → upload → document.end pass. */
  async function syncOnce(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    assetPages: Map<string, number>,
    plan: EmitPlan,
    lease: LeaseGuard,
    assets: AssetLoader,
  ): Promise<void> {
    await reconcile(job, revisionId, collection, assetPages, plan, lease);
    // Re-read the (now reconciled) metadata so the send phase sees fresh statuses.
    // A split emit sends only this stream's pages; every page belongs to
    // exactly one stream, so the shared outbox statuses stay consistent.
    const meta = (await store.listEmitBatchMeta(job.id)).filter(
      (r) => r.page_from >= plan.firstPage && r.page_from <= plan.lastPage,
    );
    let pending = meta.filter((r) => r.status !== "acked").length;
    setBacklog(pending);
    const batches = groupIntoBatches(meta, plan.n);
    const tried = new Set<number>();
    for (const batch of batches) {
      if (!batch.rows.every((r) => r.status === "acked")) {
        await sendBatch(job, revisionId, collection, batch, plan, lease, batch === batches[0]);
        pending -= batch.rows.filter((r) => r.status !== "acked").length;
        setBacklog(pending);
      }
      // Every batch up to here is acknowledged (ascending order, an error
      // aborts the pass): commit the segments that are now complete, so their
      // pages are searchable while later batches are still being sent.
      await commitReadySegments(job, revisionId, collection, plan, batch.pageTo, tried, assetPages, lease, assets);
    }
    await uploadAssets(job, revisionId, collection, lease, assets, plan, assetPages);
    // The document.end record (outline, identifiers, refs, the summary
    // hierarchy) is streamed as a dedicated trailing batch just past the page
    // batches. Idempotent on its Content-Digest, so a resend is a no-op.
    await sendDocumentEnd(job, revisionId, collection, batches, plan);
  }

  /**
   * Reconcile local outbox rows with the server's revision state: ack every
   * page whose batch the server already accepted, re-open every page whose
   * batch it does NOT hold (a lost stage server-side, or a row acked for an
   * older revision), and ack every asset the server no longer reports missing.
   */
  async function reconcile(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    assetPages: Map<string, number>,
    plan: EmitPlan,
    lease: LeaseGuard,
  ): Promise<void> {
    const fence = lease.fence;
    const state = await revisions.getState({ reference: plan.reference, revisionId, collection });
    for (const segment of state.committedSegments) plan.committedSegments.add(segment);

    const acceptedBatches = new Set(state.acceptedBatches);
    const pageAccepted = (page: number): boolean => acceptedBatches.has(Math.floor((page - 1) / plan.n));
    for (const row of await store.listEmitBatchMeta(job.id)) {
      // A split emit reconciles ONLY this stream's pages: another stream's
      // rows are acked by that stream's revision, never reset here.
      if (row.page_from < plan.firstPage || row.page_from > plan.lastPage) continue;
      const accepted = pageAccepted(row.page_from);
      if (row.status !== "acked" && accepted) {
        await store.setEmitStatus(job.id, row.seq, "acked", fence);
      } else if (row.status === "acked" && !accepted) {
        await store.setEmitStatus(job.id, row.seq, "pending", fence);
      }
    }

    // Assets: the server lists what is still MISSING among the assets referenced
    // by ACCEPTED batches. So "present" means the asset's page was accepted AND
    // the asset is not in the missing list. An asset whose batch the server has
    // not yet accepted is not confirmable and stays for the upload phase.
    const missing = new Set(state.missingAssets);
    for (const row of await store.allAssets(job.id)) {
      const page = row.page ?? assetPages.get(row.asset_id);
      if (page !== undefined && page !== null && (page < plan.firstPage || page > plan.lastPage)) continue;
      const accepted = page !== undefined && page !== null && pageAccepted(page);
      if (row.status !== "acked" && accepted && !missing.has(row.asset_id)) {
        await store.setAssetStatus(job.id, row.asset_id, "acked", fence);
      } else if (row.status === "acked" && accepted && missing.has(row.asset_id)) {
        await store.setAssetStatus(job.id, row.asset_id, "pending", fence);
      }
    }
  }

  /**
   * Group the staged per-page rows into `EMIT_BATCH_PAGES`-page batches, keyed
   * by a 0-based batch seq derived from the page number. Rows are already in
   * seq (page) order.
   */
  function groupIntoBatches(rows: EmitOutboxRow[], N: number): Batch[] {
    const byBatch = new Map<number, EmitOutboxRow[]>();
    for (const row of rows) {
      const seq = Math.floor((row.page_from - 1) / N);
      const bucket = byBatch.get(seq);
      if (bucket === undefined) byBatch.set(seq, [row]);
      else bucket.push(row);
    }
    return [...byBatch.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seq, batchRows]) => {
        const sorted = [...batchRows].sort((a, b) => a.page_from - b.page_from);
        return {
          seq,
          pageFrom: sorted[0]?.page_from ?? seq * N + 1,
          pageTo: sorted[sorted.length - 1]?.page_to ?? seq * N + N,
          rows: sorted,
        };
      });
  }

  /**
   * Encode one batch to NDJSON, PUT it at its seq (idempotent on the digest),
   * and advance its page rows `pending → sent → acked`. The first batch of the
   * stream (`withBegin`) is prefixed with the `document.begin` record. Only this batch's payloads are loaded.
   */
  async function sendBatch(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    batch: Batch,
    plan: EmitPlan,
    lease: LeaseGuard,
    withBegin: boolean,
  ): Promise<void> {
    const fence = lease.fence;
    const rows = await store.emitBatchesInRange(job.id, batch.pageFrom, batch.pageTo);
    const records: ExtractRecord[] = [];
    if (withBegin) records.push(buildDocumentBegin(job, plan));
    for (const row of rows) {
      const record = pageRecordOf(row);
      if (record !== null) records.push(record);
    }
    const body = new TextEncoder().encode(encodeRecords(records));
    const contentDigest = contentDigestHeader(body);

    // Mark the batch's pages `sent` before the PUT: a crash after the server
    // accepts but before we record the ack is repaired by reconciliation, which
    // sees the accepted batch and moves them to `acked`.
    for (const row of rows) {
      if (row.status === "pending") {
        await store.setEmitStatus(job.id, row.seq, "sent", fence);
      }
    }

    let ack: Awaited<ReturnType<RevisionClient["putBatch"]>>;
    try {
      ack = await revisions.putBatch({
        reference: plan.reference,
        revisionId,
        seq: batch.seq,
        body,
        contentDigest,
        collection,
      });
    } catch (err) {
      if (err instanceof RevisionPermanentError && err.status === 409) {
        throw new BatchConflictError(
          `Search refused batch ${batch.seq} (pages ${batch.pageFrom}-${batch.pageTo}) of revision ${revisionId} with 409: ` +
            "the seq was accepted with a different Content-Digest or the revision no longer accepts batches",
        );
      }
      throw err;
    }

    // The server accepted (or no-op'd) the batch; ack every page it carried.
    for (const row of rows) {
      await store.setEmitStatus(job.id, row.seq, "acked", fence);
    }
    logger.debug(
      { jobId: job.id, seq: batch.seq, pages: `${batch.pageFrom}-${batch.pageTo}`, noop: ack.noop },
      "Emit batch acknowledged",
    );
  }

  /**
   * Upload every not-yet-acked asset with bounded concurrency. With `upToPage`
   * only the assets of pages up to it (a segment about to be committed): its
   * figures must be fetchable by the time its pages become searchable.
   */
  async function uploadAssets(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    lease: LeaseGuard,
    assets: AssetLoader,
    plan: EmitPlan,
    assetPages: Map<string, number>,
    only?: { upToPage: number },
  ): Promise<void> {
    const fence = lease.fence;
    const rows = (await store.allAssets(job.id)).filter((r) => {
      if (r.status === "acked") return false;
      // A split emit uploads only the assets of this stream's pages. An asset
      // whose page could not be resolved belongs to the stream flagged
      // includeUnknownAssets (the last one), so exactly one revision holds it.
      const page = r.page ?? assetPages.get(r.asset_id);
      if (page !== undefined && page !== null) {
        if (Number(page) < plan.firstPage || Number(page) > plan.lastPage) return false;
      } else if (plan.includeUnknownAssets !== true) {
        return false;
      }
      if (only === undefined) return true;
      // An asset whose page is unknown waits for the final upload.
      return page !== undefined && page !== null && Number(page) <= only.upToPage;
    });
    // mapOrdered bounds the in-flight uploads to `assetUploadConcurrency` lanes;
    // the ordering it also provides is harmless here (assets are independent).
    await mapOrdered(rows, config.assetUploadConcurrency, async (row) => {
      const body = await assets.load(row);
      if (body === null) {
        logger.warn({ jobId: job.id, assetId: row.asset_id }, "Asset bytes unavailable; skipping upload");
        return null;
      }
      if (row.status === "pending") {
        await store.setAssetStatus(job.id, row.asset_id, "sent", fence);
      }
      await revisions.putAsset({ asset: body, reference: plan.reference, revisionId, collection });
      await store.setAssetStatus(job.id, row.asset_id, "acked", fence);
      return null;
    });
  }

  /**
   * The segments complete once pages up to `upToPage` are acknowledged. Segment
   * `s` (0-based) covers the `S` pages starting at `firstPage + s·S`; only FULL
   * segments are committed here, the tail is covered by the final commit.
   */
  function fullSegmentsUpTo(plan: EmitPlan, upToPage: number): number {
    const S = Math.max(1, config.segmentPages);
    return Math.max(0, Math.floor((Math.min(upToPage, plan.lastPage) - plan.firstPage + 1) / S));
  }

  /**
   * Commit the segments that have just become complete (progressive
   * visibility). Their assets are uploaded first, so a figure a searcher gets
   * back is already fetchable. A rejected commit (a gap Search still sees) is
   * logged and tried again by the sweep after the send phase, not hammered
   * once per batch; a transient error propagates and the emit resumes.
   */
  async function commitReadySegments(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    plan: EmitPlan,
    upToPage: number,
    tried: Set<number>,
    assetPages: Map<string, number>,
    lease: LeaseGuard,
    assets: AssetLoader,
  ): Promise<void> {
    const S = Math.max(1, config.segmentPages);
    const ready = fullSegmentsUpTo(plan, upToPage);
    for (let segment = 0; segment < ready; segment++) {
      if (plan.committedSegments.has(segment) || tried.has(segment)) continue;
      tried.add(segment);
      const segmentEnd = plan.firstPage + (segment + 1) * S - 1;
      await uploadAssets(job, revisionId, collection, lease, assets, plan, assetPages, { upToPage: segmentEnd });
      if (await commitOneSegment(job, revisionId, collection, plan, segment)) {
        logger.debug({ jobId: job.id, revisionId, segment, upToPage: segmentEnd }, "Segment committed (progressive)");
      }
    }
  }

  async function commitOneSegment(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    plan: EmitPlan,
    segment: number,
  ): Promise<boolean> {
    const result = await revisions.commitSegment({ reference: plan.reference, revisionId, segment, collection });
    if (!result.committed) {
      logger.warn(
        { jobId: job.id, revisionId, segment, missing: result.missingRanges.length },
        "Segment commit rejected; leaving for the next pass",
      );
      return false;
    }
    plan.committedSegments.add(segment);
    return true;
  }

  /**
   * After the send phase: commit every full segment that is still open (all
   * batches are in by now). A 409 with missing ranges is logged and left for
   * the next pass rather than fatal.
   */
  async function commitSegments(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    plan: EmitPlan,
  ): Promise<void> {
    const lastFull = fullSegmentsUpTo(plan, plan.lastPage);
    for (let segment = 0; segment < lastFull; segment++) {
      if (plan.committedSegments.has(segment)) continue;
      await commitOneSegment(job, revisionId, collection, plan, segment);
    }
  }

  /**
   * Send the `document.end` record as a dedicated trailing batch at a seq just
   * past the page batches. It carries the outline, identifier index,
   * cross-references and the summary hierarchy the document pass produced, read
   * from the last persisted `docpass_state`. Idempotent on its Content-Digest.
   */
  async function sendDocumentEnd(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    batches: Batch[],
    plan: EmitPlan,
  ): Promise<void> {
    const record = await buildDocumentEnd(job, plan);
    // A seq strictly greater than every page batch's seq, so it never collides
    // with a page batch and always sorts last.
    const lastSeq = batches.reduce((max, b) => Math.max(max, b.seq), -1);
    const seq = lastSeq + 1;
    const body = new TextEncoder().encode(encodeRecords([record]));
    const contentDigest = contentDigestHeader(body);
    let ack: Awaited<ReturnType<RevisionClient["putBatch"]>>;
    try {
      ack = await revisions.putBatch({
        reference: plan.reference,
        revisionId,
        seq,
        body,
        contentDigest,
        collection,
      });
    } catch (err) {
      if (err instanceof RevisionPermanentError && err.status === 409) {
        throw new BatchConflictError(
          `Search refused the document.end batch ${seq} of revision ${revisionId} with 409 (digest conflict)`,
        );
      }
      throw err;
    }
    logger.debug(
      { jobId: job.id, seq, summaries: record.summaries.length, noop: ack.noop },
      "document.end batch acknowledged",
    );
  }

  /**
   * Build the `document.end` record from the last persisted document-pass state.
   * The outline/identifiers/refs are the finished document graph; the summaries
   * are the RAPTOR-light hierarchy. Rehydrating the pass from state gives the
   * finished outline with correct page ranges.
   */
  async function buildDocumentEnd(job: JobRow, plan: EmitPlan): Promise<DocumentEndRecord> {
    const pageCount = plan.lastPage;
    let { outline, identifiers, refs, summaries } = await readDocumentGraph(job, pageCount);
    if (plan.subdocument === true) {
      // A sub-document's graph covers its own page range: nodes outside it
      // belong to a sibling revision.
      outline = filterOutlineToRange(outline, plan.firstPage, plan.lastPage);
      summaries = summaries.filter(
        (s) =>
          (s.pageStart === undefined || s.pageStart <= plan.lastPage) &&
          (s.pageEnd === undefined || s.pageEnd >= plan.firstPage),
      );
      identifiers = identifiers
        .map((entry) => ({
          ...entry,
          occurrences: entry.occurrences.filter((o) => o.page >= plan.firstPage && o.page <= plan.lastPage),
        }))
        .filter((entry) => entry.occurrences.length > 0);
      refs = [];
    }
    return {
      type: "document.end",
      reference: plan.reference,
      pageCount,
      ...(plan.firstPage > 1 ? { firstPage: plan.firstPage } : {}),
      outline,
      identifiers,
      summaries,
      refs,
      warnings: [],
    };
  }

  /**
   * The finished document graph (outline, identifiers, refs, summaries) from
   * the last persisted document-pass state. The optional finalize pass
   * corrects the outline metadata once the whole document is known —
   * deterministic and model-free.
   */
  async function readDocumentGraph(
    job: JobRow,
    pageCount: number,
  ): Promise<{ outline: OutlineNode[]; identifiers: IdentifierEntry[]; refs: Ref[]; summaries: SummaryNode[] }> {
    const persisted = await store.latestDocpassState(job.id);
    if (persisted === null) return { outline: [], identifiers: [], refs: [], summaries: [] };
    const pass = createDocumentPass(parseDocpassState(persisted.state));
    return {
      outline: config.finalizePass ? pass.finalizeOutline(pageCount).outline : pass.outline(pageCount),
      identifiers: pass.identifiers(),
      refs: pass.documentRefs(),
      summaries: pass.summaries(),
    };
  }

  /**
   * The outline used to plan a sub-document split: the finished graph of the
   * WHOLE document (not a stream range), so chapter boundaries are complete.
   */
  async function documentOutline(job: JobRow, lastPage: number): Promise<OutlineNode[]> {
    return (await readDocumentGraph(job, lastPage)).outline;
  }

  /**
   * Plain-text characters per page, read one batch window at a time. Drives
   * the split's chunk estimate; pages without a staged record count as empty.
   */
  async function charsPerPageMap(
    jobId: string,
    base: { n: number; firstPage: number; lastPage: number },
  ): Promise<Map<number, number>> {
    const sizes = new Map<number, number>();
    for (let from = base.firstPage; from <= base.lastPage; from += base.n) {
      for (const row of await store.emitBatchesInRange(jobId, from, from + base.n - 1)) {
        const record = pageRecordOf(row);
        if (record === null) continue;
        sizes.set(record.page, pageRecordText(record).length);
      }
    }
    return sizes;
  }

  /** Build the document.begin record from the job's config snapshot. */
  function buildDocumentBegin(job: JobRow, plan: EmitPlan): DocumentBeginRecord {
    const cfg = job.config as Record<string, unknown>;
    const source = (cfg as { source?: { filename?: string; mimeType?: string; bytes?: number } }).source ?? {};
    const identity = identityOf(cfg);
    const email = emailOf(cfg);
    const parentReference = ingestOptionsOf(cfg).parentReference;
    const attributes = documentAttributesOf(cfg);
    const title = typeof cfg.title === "string" && cfg.title.trim() !== "" ? cfg.title.trim() : undefined;
    return {
      type: "document.begin",
      contract: config.contract,
      reference: plan.reference,
      ...(title !== undefined ? { title } : {}),
      // Contract 2.1: the version orders the document's revisions in Search,
      // the e-mail headers thread it, the parent groups an attachment.
      ...(identity?.version !== undefined ? { version: identity.version } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(parentReference !== undefined ? { parentReference } : {}),
      // Contract 2.2: the caller's tags, metadata, link and source label.
      ...attributes,
      source: {
        filename: source.filename ?? job.reference,
        mimeType: source.mimeType ?? "application/octet-stream",
        bytes: typeof source.bytes === "number" ? source.bytes : 0,
        sha256: job.source_sha256,
      },
      pipeline: {
        extractor: "atf-extract",
        visionModel: config.visionModel,
        ocr: false,
        dpi: config.renderDpi,
        // The stand Search stamps onto every unit: the
        // contract id, the job's frozen pipeline hash and prompt hash. The
        // job's own snapshot wins; the deployment's current stand is the
        // fallback for a job created without one.
        contract: config.contract,
        ...optionalString("pipelineVersion", job.pipeline_hash ?? config.pipelineVersion),
        ...optionalString("promptHash", job.prompt_hash ?? config.promptHash),
      },
      pageCount: plan.lastPage,
      // Contract 2.4: a `pages` window starts after page 1; `pageCount` above
      // is then the stream's last page.
      ...(plan.firstPage > 1 ? { firstPage: plan.firstPage } : {}),
      // Contract 2.5: Late Chunking. The blend factor rides on the record so
      // a consumer without the revision header still sees it; the assembled
      // full text is the source of Search's document-level vector.
      ...(chunkingOptionsOf(cfg).lateChunkingAlpha !== undefined
        ? { lateChunkingAlpha: chunkingOptionsOf(cfg).lateChunkingAlpha }
        : {}),
      ...(plan.documentText !== undefined && plan.documentText !== ""
        ? { documentText: plan.documentText }
        : {}),
    };
  }

  /**
   * Assemble the document's full plain text from the staged page records,
   * one batch window at a time (mirroring {@link indexAssetPages}) so memory
   * stays flat. Capped at {@link DOCUMENT_TEXT_MAX_CHARS}.
   */
  async function collectDocumentText(jobId: string, plan: EmitPlan): Promise<string> {
    const parts: string[] = [];
    let total = 0;
    for (let from = plan.firstPage; from <= plan.lastPage; from += plan.n) {
      for (const row of await store.emitBatchesInRange(jobId, from, from + plan.n - 1)) {
        const record = pageRecordOf(row);
        // The window may overrun the stream's last page (a sub-document's
        // text must not pick up a sibling's pages).
        if (record === null || record.page < plan.firstPage || record.page > plan.lastPage) continue;
        const text = pageRecordText(record);
        if (text === "") continue;
        if (total + text.length > DOCUMENT_TEXT_MAX_CHARS) {
          parts.push(text.slice(0, DOCUMENT_TEXT_MAX_CHARS - total));
          return parts.join("\n");
        }
        parts.push(text);
        total += text.length;
      }
    }
    return parts.join("\n");
  }

  /**
   * Map each staged asset id to its page. Rows staged with the `page` column
   * need no lookup; only for legacy rows without it are the page records read,
   * one batch window at a time, so memory stays bounded.
   */
  async function indexAssetPages(jobId: string, plan: EmitPlan): Promise<Map<string, number>> {
    const N = plan.n;
    const index = new Map<string, number>();
    const assetRows = await store.allAssets(jobId);
    const legacy = assetRows.filter((r) => r.page === undefined || r.page === null);
    if (legacy.length === 0) return index;
    const wanted = new Set(legacy.map((r) => r.asset_id));
    const meta = await store.listEmitBatchMeta(jobId);
    const last = maxPage(meta);
    for (let from = plan.firstPage; from <= last && wanted.size > 0; from += N) {
      for (const row of await store.emitBatchesInRange(jobId, from, from + N - 1)) {
        const record = pageRecordOf(row);
        if (record === null) continue;
        for (const asset of record.assets) {
          if (!wanted.has(asset.assetId)) continue;
          index.set(asset.assetId, asset.page ?? record.page);
          wanted.delete(asset.assetId);
        }
      }
    }
    return index;
  }

  return { emit };
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Recover the v2 page record from an emit-outbox row's payload. */
function pageRecordOf(row: EmitOutboxRow): PageRecord | null {
  const payload = row.payload as { record?: PageRecord } | null;
  return payload?.record ?? null;
}

/**
 * Keep the outline nodes overlapping `[from, to]`, clamped to it. A node
 * without a recorded end page extends to the range end.
 */
function filterOutlineToRange(outline: OutlineNode[], from: number, to: number): OutlineNode[] {
  return outline
    .filter((n) => n.pageStart <= to && (n.pageEnd ?? to) >= from)
    .map((n) => ({
      ...n,
      pageStart: Math.max(n.pageStart, from),
      ...(n.pageEnd !== undefined ? { pageEnd: Math.min(n.pageEnd, to) } : {}),
    }));
}

/** The highest page number staged, for the page count when none is recorded. */
function maxPage(rows: EmitOutboxRow[]): number {
  let max = 0;
  for (const row of rows) if (row.page_to > max) max = row.page_to;
  return max;
}

/**
 * A revision-client throw is transient when it is a network/timeout/5xx (the
 * client already classified it); a permanent error re-throws so the runner
 * fails the job, and a lost lease re-throws so the worker abandons the run.
 * Anything unexpected is treated as transient — safer to retry and reconcile
 * than to lose the document.
 */
function transientOrThrow(err: unknown, revisionId: string | null): EmitOutcome {
  if (err instanceof RevisionPermanentError) throw err;
  if (err instanceof LeaseLostError) throw err;
  const reason = err instanceof Error ? err.message : String(err);
  return { status: "transient", revisionId, reason };
}
