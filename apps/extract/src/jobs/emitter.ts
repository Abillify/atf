// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/emitter.ts
 *
 * The outbox emitter: it streams a job's staged pages and crops to Search's
 * revision API and reconciles the local outbox against the server on resume
 * (design §5 S8, §9b.3; task 1.12, requirements 5.1, 5.2, 5.7, 5.9, 6.3).
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
 *      the missing parts: no duplicates, no loss (requirement 5.7).
 *   3. Send batches. Group the staged pages into batches of `EMIT_BATCH_PAGES`
 *      (batch 0 carries the `document.begin` record), encode each to NDJSON,
 *      compute the Content-Digest, and PUT at the batch seq. Search answers a
 *      replay of the same seq+digest with `noop`; a DIFFERENT digest at an
 *      accepted seq is a `409` (requirement 5.2), surfaced as `conflict` so the
 *      runner can start a new emit generation rather than pause forever.
 *   4. Upload assets with bounded concurrency (`ASSET_UPLOAD_CONCURRENCY`). Each
 *      asset is idempotent on its checksum; a present asset is skipped.
 *   5. Commit. A segment commit every `SEGMENT_PAGES` pages (progressive
 *      visibility), then the final commit. A final commit rejected with `409`
 *      (batches missing, requirement 5.9) triggers a reconcile-and-resend round
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
 * seq back to its page range. The mapping is deterministic from
 * `EMIT_BATCH_PAGES`, so a resume groups identically.
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

/** Tunables for the emitter, from `config.emitter` plus pipeline identity. */
export interface EmitterConfig {
  /** Pages per NDJSON batch sent to Search. */
  emitBatchPages: number;
  /** Pages between segment commits. */
  segmentPages: number;
  /** Assets uploaded to Search in parallel. */
  assetUploadConcurrency: number;
  /**
   * Run the optional finalize pass on `document.end` (task 5.4, requirement
   * 9.6): a deterministic, model-free correction of the outline metadata once
   * the whole document is known. When false the streaming outline is emitted
   * as-is.
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
   * Observability (requirement 18.1): the hand-over backlog gauge, set to the
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

/** Raised by `sendBatch` when Search answers 409 for a batch PUT. */
class BatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchConflictError";
  }
}

export function createEmitter(deps: EmitterDeps): Emitter {
  const { store, revisions, config, logger } = deps;
  const N = Math.max(1, config.emitBatchPages);
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

  async function emit(job: JobRow, lease: LeaseGuard, assets: AssetLoader): Promise<EmitOutcome> {
    const reference = job.reference;
    const collection = job.collection ?? undefined;
    const fence = lease.fence;

    // ── 1. open (or idempotently re-open) the revision ────────────────────
    let revisionId: string;
    try {
      const revision = await revisions.createRevision({
        reference,
        idempotencyKey: revisionIdempotencyKey(job),
        visibility: job.visibility,
        collection,
      });
      revisionId = revision.revisionId;
    } catch (err) {
      return transientOrThrow(err, null);
    }
    if (job.revision_id !== revisionId) {
      await store.setJobRevision(job.id, revisionId, fence);
    }

    const assetPages = await indexAssetPages(job.id);
    const pageCount = job.page_count ?? maxPage(await store.listEmitBatchMeta(job.id));

    try {
      // ── 2. reconcile, 3. send, 4. upload, 4b. document.end ──────────────
      await syncOnce(job, revisionId, collection, assetPages, pageCount, lease, assets);

      // ── 5. commit segments, then the final commit ──────────────────────
      await commitSegments(job, revisionId, collection, pageCount);
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
        await syncOnce(job, revisionId, collection, assetPages, pageCount, lease, assets);
      }
      logger.info({ jobId: job.id, revisionId, pageCount }, "Revision committed");
      return { status: "committed", revisionId };
    } catch (err) {
      if (err instanceof BatchConflictError) {
        logger.warn({ jobId: job.id, revisionId, reason: err.message }, "Batch digest conflict");
        return { status: "conflict", revisionId, reason: err.message };
      }
      return transientOrThrow(err, revisionId);
    }
  }

  /** One reconcile → send → upload → document.end pass. */
  async function syncOnce(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    assetPages: Map<string, number>,
    pageCount: number,
    lease: LeaseGuard,
    assets: AssetLoader,
  ): Promise<void> {
    await reconcile(job, revisionId, collection, assetPages, lease);
    // Re-read the (now reconciled) metadata so the send phase sees fresh statuses.
    const meta = await store.listEmitBatchMeta(job.id);
    let pending = meta.filter((r) => r.status !== "acked").length;
    setBacklog(pending);
    const batches = groupIntoBatches(meta);
    for (const batch of batches) {
      if (batch.rows.every((r) => r.status === "acked")) continue;
      await sendBatch(job, revisionId, collection, batch, pageCount, lease);
      pending -= batch.rows.filter((r) => r.status !== "acked").length;
      setBacklog(pending);
    }
    await uploadAssets(job, revisionId, collection, lease, assets);
    // The document.end record (outline, identifiers, refs, the summary
    // hierarchy) is streamed as a dedicated trailing batch just past the page
    // batches. Idempotent on its Content-Digest, so a resend is a no-op.
    await sendDocumentEnd(job, revisionId, collection, batches, pageCount);
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
    lease: LeaseGuard,
  ): Promise<void> {
    const fence = lease.fence;
    const state = await revisions.getState({ reference: job.reference, revisionId, collection });

    const acceptedBatches = new Set(state.acceptedBatches);
    const pageAccepted = (page: number): boolean => acceptedBatches.has(Math.floor((page - 1) / N));
    for (const row of await store.listEmitBatchMeta(job.id)) {
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
  function groupIntoBatches(rows: EmitOutboxRow[]): Batch[] {
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
   * and advance its page rows `pending → sent → acked`. Batch 0 is prefixed
   * with the `document.begin` record. Only this batch's payloads are loaded.
   */
  async function sendBatch(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    batch: Batch,
    pageCount: number,
    lease: LeaseGuard,
  ): Promise<void> {
    const fence = lease.fence;
    const rows = await store.emitBatchesInRange(job.id, batch.pageFrom, batch.pageTo);
    const records: ExtractRecord[] = [];
    if (batch.seq === 0) records.push(buildDocumentBegin(job, pageCount));
    for (const row of rows) {
      const record = pageRecordOf(row);
      if (record !== null) records.push(record);
    }
    const body = new TextEncoder().encode(encodeRecords(records));
    const contentDigest = `sha-256=:${sha256Hex(body)}:`;

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
        reference: job.reference,
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

  /** Upload every not-yet-acked asset with bounded concurrency. */
  async function uploadAssets(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    lease: LeaseGuard,
    assets: AssetLoader,
  ): Promise<void> {
    const fence = lease.fence;
    const rows = (await store.allAssets(job.id)).filter((r) => r.status !== "acked");
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
      await revisions.putAsset({ asset: body, reference: job.reference, revisionId, collection });
      await store.setAssetStatus(job.id, row.asset_id, "acked", fence);
      return null;
    });
  }

  /**
   * Commit each full segment. Segment `s` (0-based) covers pages
   * `[s·S + 1 … s·S + S]`; a segment is committable once all its pages are
   * present, which by this point they are (batches were sent above). A 409 with
   * missing ranges is logged and left for the next pass rather than fatal.
   */
  async function commitSegments(
    job: JobRow,
    revisionId: string,
    collection: string | undefined,
    pageCount: number,
  ): Promise<void> {
    const S = Math.max(1, config.segmentPages);
    const lastFullSegment = Math.floor(pageCount / S) - 1;
    for (let segment = 0; segment <= lastFullSegment; segment++) {
      const result = await revisions.commitSegment({ reference: job.reference, revisionId, segment, collection });
      if (!result.committed) {
        logger.warn(
          { jobId: job.id, revisionId, segment, missing: result.missingRanges.length },
          "Segment commit rejected; leaving for the next pass",
        );
      }
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
    pageCount: number,
  ): Promise<void> {
    const record = await buildDocumentEnd(job, pageCount);
    // A seq strictly greater than every page batch's seq, so it never collides
    // with a page batch and always sorts last.
    const lastSeq = batches.reduce((max, b) => Math.max(max, b.seq), -1);
    const seq = lastSeq + 1;
    const body = new TextEncoder().encode(encodeRecords([record]));
    const contentDigest = `sha-256=:${sha256Hex(body)}:`;
    let ack: Awaited<ReturnType<RevisionClient["putBatch"]>>;
    try {
      ack = await revisions.putBatch({
        reference: job.reference,
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
  async function buildDocumentEnd(job: JobRow, pageCount: number): Promise<DocumentEndRecord> {
    const persisted = await store.latestDocpassState(job.id);
    let outline: OutlineNode[] = [];
    let identifiers: IdentifierEntry[] = [];
    let refs: Ref[] = [];
    let summaries: SummaryNode[] = [];
    if (persisted !== null) {
      const pass = createDocumentPass(parseDocpassState(persisted.state));
      // The optional finalize pass (task 5.4, requirement 9.6) corrects the
      // outline metadata once the whole document is known — deterministic and
      // model-free.
      if (config.finalizePass) {
        const finalized = pass.finalizeOutline(pageCount);
        outline = finalized.outline;
        if (finalized.changes.length > 0) {
          logger.debug(
            { jobId: job.id, changed: finalized.changes.length },
            "finalize pass corrected outline section paths",
          );
        }
      } else {
        outline = pass.outline(pageCount);
      }
      identifiers = pass.identifiers();
      refs = pass.documentRefs();
      summaries = pass.summaries();
    }
    return {
      type: "document.end",
      reference: job.reference,
      pageCount,
      outline,
      identifiers,
      summaries,
      refs,
      warnings: [],
    };
  }

  /** Build the document.begin record from the job's config snapshot. */
  function buildDocumentBegin(job: JobRow, pageCount: number): DocumentBeginRecord {
    const source = (job.config as { source?: { filename?: string; mimeType?: string; bytes?: number } }).source ?? {};
    return {
      type: "document.begin",
      contract: config.contract,
      reference: job.reference,
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
        // The stand Search stamps onto every unit (requirement 18.2): the
        // contract id, the job's frozen pipeline hash and prompt hash. The
        // job's own snapshot wins; the deployment's current stand is the
        // fallback for a job created without one.
        contract: config.contract,
        ...optionalString("pipelineVersion", job.pipeline_hash ?? config.pipelineVersion),
        ...optionalString("promptHash", job.prompt_hash ?? config.promptHash),
      },
      pageCount,
    };
  }

  /**
   * Map each staged asset id to its page. Rows staged with the `page` column
   * need no lookup; only for legacy rows without it are the page records read,
   * one batch window at a time, so memory stays bounded.
   */
  async function indexAssetPages(jobId: string): Promise<Map<string, number>> {
    const index = new Map<string, number>();
    const assetRows = await store.allAssets(jobId);
    const legacy = assetRows.filter((r) => r.page === undefined || r.page === null);
    if (legacy.length === 0) return index;
    const wanted = new Set(legacy.map((r) => r.asset_id));
    const meta = await store.listEmitBatchMeta(jobId);
    const last = maxPage(meta);
    for (let from = 1; from <= last && wanted.size > 0; from += N) {
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
