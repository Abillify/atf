// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ingest-v2.ts
 *
 * `POST /v1/ingest` — the v2 wrapper (task 1.14, requirement 17.2).
 *
 * This is what `/v1/ingest` becomes once a deployment has enabled the v2 job
 * model: instead of the ad-hoc convert→forward-Markdown path, the upload is
 * stored in the content-addressed {@link SourceStore} and a v2 job is created
 * and driven through the very same render → vision → parse → emit machinery a
 * `POST /v2/jobs` caller gets — so figure *assets* are stored by the emitter,
 * not dropped.
 *
 * ## Why the sync contract is preserved
 *
 * The historical `/v1/ingest` answers a single request with a completed result:
 * a caller POSTs a document and gets back "indexed, N pages, M figures". That
 * contract is kept for a *small* document — the handler drives the freshly
 * created job to a terminal state inline and returns the same JSON shape. A
 * caller who wants to poll instead can always use `POST /v2/jobs` directly; this
 * route exists precisely so an existing v1 client keeps working unchanged.
 *
 * Driving the job inline reuses the job worker's own `tick()`: it claims the
 * next runnable job (the one just created, in the common single-writer case),
 * runs it through the staged pipeline and the emitter, and finalises it. The
 * handler ticks until *its* job reaches a terminal state, so the same code path
 * a background worker would take is exercised — no second pipeline.
 *
 * ## Fallback
 *
 * This handler is only wired when BOTH a database and a Search target are
 * configured (`config.database !== null && config.search !== null`); the emitter
 * needs both. Without a database, `index.ts` keeps the original synchronous
 * `createIngestHandler`, so a v1-only deployment behaves exactly as before.
 *
 * ## ACL / auth
 *
 * The auth chain and the ACL narrowing are identical to the v1 handler: the
 * route sits behind the same rate-limit → authenticate → authorise → upload
 * middleware in `index.ts`, and the resolved ACL is passed to the job so the
 * emitter's revision carries it.
 */

import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Request, RequestHandler } from "express";
import type { Logger } from "pino";
import { validationError } from "../errors.js";
import { readHeader, readListHeader } from "../header-utils.js";
import { getPrincipal } from "../request-principal.js";
import { readUpload, sanitizeFilename } from "../upload.js";
import { resolveAcl } from "./ingest.js";
import type { ExtractStore } from "../persistence/index.js";
import type { SourceStore } from "../source-store.js";
import type { PipelineSnapshot } from "../jobs/snapshot.js";
import { isTerminal } from "../jobs/state-machine.js";
import type { JobRow } from "../persistence/types.js";
import { identityOf } from "../jobs/identity.js";

export interface IngestV2Metrics {
  recordDocument(mimeType: string, outcome: "ok" | "error"): void;
}

/** How often the handler polls a job's status while a background worker runs. */
const POLL_INTERVAL_MS = 100;

/**
 * Drive one runnable job (the worker's `tick`). Returns true when a job was
 * processed, false when the queue was empty.
 *
 * `null` means a background worker loop is already draining the queue, so the
 * handler must NOT tick itself (that would double-drive the same job): it just
 * polls the job's status. In a test — where no loop runs — a `tick` is passed
 * so the handler advances the job deterministically. Either way the SAME staged
 * pipeline + emitter processes the job; the handler never runs a second one.
 */
export type RunOneJob = (() => Promise<boolean>) | null;

export interface IngestV2HandlerDeps {
  store: ExtractStore;
  sourceStore: SourceStore;
  /** Drives a job through the staged pipeline + emitter (the worker's tick). */
  runOneJob: RunOneJob;
  logger: Logger;
  metrics: IngestV2Metrics;
  /** The pipeline/prompt snapshot frozen onto every new job. */
  snapshot: PipelineSnapshot;
  /** Collection used when the request does not name one. */
  defaultCollection: string;
  /**
   * A document with at most this many pages is driven inline and answered
   * synchronously; a larger one returns 202 with the job id to poll. The page
   * count is only known after the source is prepared, so the split is applied
   * once the job records its page count. Default 50.
   */
  syncPageLimit: number;
  /**
   * How long the inline drive may run before the handler gives up waiting and
   * returns 202 with the job id (the job keeps running in the background).
   * Milliseconds. Default 120 000.
   */
  syncTimeoutMs: number;
}

/**
 * Resolve the ACL and the Search-bound options a caller may narrow. Reuses the
 * v1 handler's ACL intersection so the two routes attribute a document
 * identically.
 */
function resolveRequestAcl(req: Request): { allowedUsers: string[]; allowedGroups: string[] } {
  const principal = getPrincipal(req);
  return resolveAcl(principal, {
    users: readListHeader(req, "x-allowed-users"),
    groups: readListHeader(req, "x-allowed-groups"),
  });
}

/**
 * The identity inputs a `/v1/ingest` caller may pass as headers:
 *
 *   X-Version          explicit document version (skips detection)
 *   X-Source-Modified  the file's modification time, RFC 3339 — the last
 *                      version fallback
 *   X-Dedup            auto (default) | exact | off
 */
export function readIdentityHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const version = readHeader(req, "x-version")?.trim();
  if (version !== undefined && version !== "") {
    if (version.length > 200) throw validationError("X-Version must be at most 200 characters");
    out.version = version;
  }
  const modified = readHeader(req, "x-source-modified")?.trim();
  if (modified !== undefined && modified !== "") {
    if (!RFC3339.test(modified) || Number.isNaN(Date.parse(modified))) {
      throw validationError("X-Source-Modified must be an RFC 3339 timestamp with a time zone");
    }
    out.sourceModifiedAt = modified;
  }
  const dedup = readHeader(req, "x-dedup")?.trim().toLowerCase();
  if (dedup !== undefined && dedup !== "") {
    if (dedup !== "auto" && dedup !== "exact" && dedup !== "off") {
      throw validationError("X-Dedup must be one of: auto, exact, off");
    }
    out.dedup = dedup;
  }
  return out;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export function createIngestV2Handler(deps: IngestV2HandlerDeps): RequestHandler {
  const {
    store,
    sourceStore,
    runOneJob,
    logger,
    metrics,
    snapshot,
    defaultCollection,
    syncPageLimit,
    syncTimeoutMs,
  } = deps;

  return (req, res, next) => {
    void (async () => {
      const upload = readUpload(req);

      // The reference is the document identity Search stores under; defaulting
      // it to a filename would make two uploads of "scan.pdf" collide.
      const reference = readHeader(req, "x-reference")?.trim();
      if (reference === undefined || reference === "") {
        throw validationError("X-Reference is required for ingest and identifies the document");
      }

      const titleRaw = readHeader(req, "x-title")?.trim();
      const collection = readHeader(req, "x-collection")?.trim() || defaultCollection;
      const acl = resolveRequestAcl(req);
      const identityInputs = readIdentityHeaders(req);

      // ── 1. store the source in the content-addressed store ────────────────
      // Idempotent by sha256, so a re-uploaded document dedupes for free and a
      // job can always re-render deterministically from the one durable copy.
      const stored = await sourceStore.putStream(Readable.from(upload.buffer), {
        maxBytes: upload.buffer.length,
      });

      // ── 2. create the v2 job ──────────────────────────────────────────────
      const id = randomUUID();
      const source = {
        filename: upload.filename,
        mimeType: upload.declaredMimeType ?? "application/octet-stream",
        bytes: stored.size,
      };
      await store.createJob({
        id,
        reference,
        source_sha256: stored.sha256,
        status: "queued",
        collection,
        config: {
          collection,
          snapshot,
          source,
          // The revision the emitter opens carries the caller's narrowed ACL.
          acl: { allowedUsers: acl.allowedUsers, allowedGroups: acl.allowedGroups },
          ...(titleRaw !== undefined && titleRaw !== ""
            ? { title: sanitizeFilename(titleRaw) }
            : {}),
          ...identityInputs,
        },
        pipeline_hash: snapshot.pipelineHash,
        prompt_hash: snapshot.promptHash,
      });
      logger.info({ jobId: id, reference, collection }, "v1/ingest created a v2 job");

      // ── 3. drive the job inline for a small document ──────────────────────
      // Tick the worker until *this* job reaches a terminal state, the queue
      // drains, the page count reveals the document is too large for the sync
      // contract, or the sync budget elapses. Whatever the reason we stop
      // ticking, the job keeps its state in the store and a background worker
      // (production) or a later tick finishes it.
      const deadline = Date.now() + syncTimeoutMs;
      let job: JobRow | null = await store.getJob(id);
      let tooLarge = false;
      while (job !== null && !isTerminal(job.status)) {
        if (Date.now() > deadline) break;
        if (job.page_count !== null && job.page_count > syncPageLimit) {
          // Once the source is prepared and the page count is known to exceed
          // the sync ceiling, stop waiting inline and answer async — a large
          // document is polled, not held on a single request.
          tooLarge = true;
          break;
        }
        if (runOneJob !== null) {
          // No background loop: drive the job ourselves.
          const processed = await runOneJob();
          job = await store.getJob(id);
          if (!processed && job !== null && !isTerminal(job.status)) {
            // Nothing was runnable and our job is not terminal: either a worker
            // elsewhere holds it or it is parked. Stop spinning; answer async.
            break;
          }
        } else {
          // A background worker loop is draining the queue; poll until the job
          // finishes or the sync budget elapses.
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          job = await store.getJob(id);
        }
      }

      if (res.writableEnded) return;

      job = (await store.getJob(id)) ?? job;
      if (job === null) throw new Error(`ingest job ${id} vanished`);

      // ── 4a. large / still-running: answer async with the job id ───────────
      if (tooLarge || !isTerminal(job.status)) {
        logger.info(
          { jobId: id, status: job.status, pageCount: job.page_count },
          "v1/ingest returning async job handle",
        );
        res.status(202).location(`/v2/jobs/${id}`).json({
          status: "accepted",
          job_id: id,
          reference,
          collection,
          page_count: job.page_count ?? undefined,
          poll: `/v2/jobs/${id}`,
        });
        return;
      }

      // ── 4b. terminal failure ──────────────────────────────────────────────
      if (job.status === "failed" || job.status === "cancelled") {
        metrics.recordDocument(source.mimeType, "error");
        logger.warn({ jobId: id, status: job.status }, "v1/ingest job did not complete");
        res.status(502).json({
          error: `Ingest job ${job.status}`,
          code: "INGEST_JOB_FAILED",
          job_id: id,
          reference,
          warnings: job.warnings,
        });
        return;
      }

      // ── 4c. skipped as a duplicate: nothing was indexed ───────────────────
      const identity = identityOf(job.config as Record<string, unknown>);
      const resolvedReference =
        identity !== undefined && identity.canonicalReference !== reference
          ? { resolved_reference: identity.canonicalReference }
          : {};
      if (identity?.decision === "duplicate") {
        metrics.recordDocument(source.mimeType, "ok");
        logger.info(
          { reference, collection, jobId: id, duplicateOf: identity.duplicateOf },
          "Document skipped as a duplicate",
        );
        res.status(200).json({
          status: "skipped",
          reason: "duplicate",
          reference,
          ...resolvedReference,
          collection,
          job_id: id,
          ...(identity.duplicateOf !== undefined ? { duplicate_of: identity.duplicateOf } : {}),
          warnings: job.warnings,
        });
        return;
      }

      // ── 4d. small document completed: the historical synchronous shape ────
      metrics.recordDocument(source.mimeType, "ok");
      const assets = await store.allAssets(id).catch(() => []);
      // A figure asset is staged with a null `variant`; a page image carries
      // `variant: "page"` (see the job runner's asset staging). The figure_count
      // in the v1-shaped response is the figure assets, and assets_stored counts
      // the acked figure assets so it means the same thing it did on v1: figure
      // crops that made it into Search (page images are an implementation detail
      // the old response never reported).
      const figureAssets = assets.filter((a) => a.variant !== "page");
      const figureCount = figureAssets.length;
      const assetsStored = figureAssets.filter((a) => a.status === "acked").length;
      const assetsFailed = figureAssets.filter((a) => a.status === "failed").length;

      logger.info(
        {
          reference,
          collection,
          jobId: id,
          pageCount: job.page_count,
          revisionId: job.revision_id,
          assetsStored,
          assetsFailed,
        },
        "Document ingested via v2 job",
      );

      res.status(200).json({
        status: "ok",
        reference,
        ...resolvedReference,
        ...(identity?.version !== undefined ? { version: identity.version } : {}),
        collection,
        page_count: job.page_count ?? 0,
        figure_count: figureCount,
        assets_stored: assetsStored,
        assets_failed: assetsFailed,
        job_id: id,
        ...(job.revision_id !== null ? { revision_id: job.revision_id } : {}),
        warnings: job.warnings,
      });
    })().catch((error: unknown) => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      next(error);
    });
  };
}

