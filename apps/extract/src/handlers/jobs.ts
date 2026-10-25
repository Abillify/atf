// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/jobs.ts
 *
 * The v2 Job API.
 *
 *   POST /v2/jobs                     create a job from an already-uploaded
 *                                     source; returns the queued job.
 *   GET  /v2/jobs                     list jobs newest-first, paginated, for the
 * overview UI; cheap, no
 *                                     per-stage progress join.
 *   GET  /v2/jobs/{id}                status with per-stage progress, warnings,
 *                                     cost and an ETA.
 *   POST /v2/jobs/{id}/pause          hold a running/queued job (state kept).
 *   POST /v2/jobs/{id}/resume         re-queue a paused job.
 *   POST /v2/jobs/{id}/cancel         abandon a non-terminal job.
 *   POST /v2/jobs/{id}/retry-failed   re-queue only the failed units of a job.
 *   POST /v2/jobs/{id}/reparse        re-apply the parser to persisted model raw
 *                                     responses, with no new model calls.
 *   GET  /v2/jobs/{id}/figures        the figures of the staged page records
 *                                     (id, page, bbox, kind, description), for
 *                                     the console's gallery; the crops render
 *                                     on demand via /v2/render.
 *
 * Creation snapshots the config and the pipeline/prompt hash onto the row so a
 * later resume can compare against it. All mutations run the
 * status transition through the state machine, so an illegal move (resuming a
 * completed job, cancelling a failed one) is a clean 409 rather than a corrupt
 * row. Every mutation also REVOKES the lease atomically with the status change
 * (the epoch is bumped, the holder cleared): a worker still running the job
 * fails its next fenced write and stops, so it can never overwrite a
 * `cancelled`/`paused` status or keep spending model calls. The router is mounted behind the same auth chain as the other write
 * routes by `index.ts`; the read scope is applied to GET there too.
 */

import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";
import type { Logger } from "pino";
import { jobRequestSchema, parsePageSelection, resumePolicySchema } from "@atf/extract-contract/v2";
import { conflict, notFound, validationError } from "../errors.js";
import { canReadJob } from "../authorize.js";
import type { ExtractStore } from "../persistence/index.js";
import type { JobRow, OperatorTransition } from "../persistence/types.js";
import type { SourceStore } from "../source-store.js";
import { toJobView } from "../jobs/job-view.js";
import { getPrincipal } from "../request-principal.js";
import { sanitizeFilename } from "../upload.js";
import { resolveAcl } from "./ingest.js";
import { stageOrderIndex, type PipelineSnapshot } from "../jobs/snapshot.js";
import {
  CROPS_STAGE,
  DOCPASS_STAGE,
  EMITTED_STAGE,
} from "../jobs/job-runner.js";
import {
  isTerminal,
  resolveAction,
  resolveRequeue,
  type JobAction,
  type RequeueAction,
} from "../jobs/state-machine.js";

/**
 * Optimistic retries of an operator action whose `expectedStatus` guard lost a
 * race against a concurrent transition (e.g. the worker moved the job from
 * `processing` to `emitting` between the read and the write).
 */
const ACTION_RETRIES = 3;

export interface JobsHandlerDeps {
  store: ExtractStore;
  sourceStore: SourceStore;
  logger: Logger;
  /** The snapshot frozen onto every new job; the current pipeline/prompt stand. */
  snapshot: PipelineSnapshot;
  /** Default target collection when a request omits one. */
  defaultCollection: string;
  /**
   * Whether scope enforcement is on. With it off (`AUTHZ_ENABLED=false`) every
   * read is allowed and the E3 owner check is skipped — matching the bypass
   * every other guard here applies.
   */
  authzEnabled: boolean;
}

/** Read a route parameter as a single string (Express 5 types it widely). */
function readParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the `{id}` route parameter as a job id. Job ids are UUIDs (the `jobs.id`
 * column is typed `uuid`), so anything else cannot name a job: it is a 404
 * here rather than a Postgres cast error surfacing as a 500.
 */
function readJobId(req: Request): string {
  const id = readParam(req, "id");
  if (!UUID_RE.test(id)) throw notFound(`Job ${id} does not exist`);
  return id;
}

/**
 * Build the router mounting the job routes. Returned rather than mounted so
 * `index.ts` wraps it in the shared rate-limit → authenticate → authorise
 * chain, applying `extract.ingest` to the mutations and the read scope to the
 * status read.
 */
export function createJobsRouter(deps: JobsHandlerDeps): Router {
  const { store, sourceStore, logger, snapshot, authzEnabled } = deps;
  const router = express.Router();

  // ── POST /v2/jobs ─────────────────────────────────────────────────────────
  const createHandler: RequestHandler = (req, res, next) => {
    void createJob(req, res).catch(next);
  };

  async function createJob(req: Request, res: Response): Promise<void> {
    const parsed = jobRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw validationError(`Invalid job request: ${parsed.error.issues[0]?.message ?? "bad body"}`, {
        issues: parsed.error.issues,
      });
    }
    const body = parsed.data;

    // The source must already be in the content-addressed store — a job renders
    // from it on demand, so a missing source is a create-time error, not a
    // failure discovered pages later.
    if (!(await sourceStore.has(body.sourceSha256))) {
      throw validationError(
        `No stored source for sha256 ${body.sourceSha256}; upload it first via /v2/uploads`,
        { sourceSha256: body.sourceSha256 },
      );
    }

    const id = randomUUID();
    const row = await store.createJob({
      id,
      reference: body.reference,
      source_sha256: body.sourceSha256,
      status: "queued",
      // Freeze the snapshot: the config that governs this job plus the stand it
      // was created under, so a resume can compare.
      config: {
        // Normalised window `{from?, to?}` in source page numbers (contract
        // 2.4); the schema already rejected anything that does not parse.
        pages: body.pages !== undefined ? parsePageSelection(body.pages) : null,
        collection: body.collection ?? deps.defaultCollection,
        snapshot,
        // The filename types the source (the runner falls back to the
        // reference); only the basename is kept.
        ...(body.filename !== undefined ? { source: { filename: sanitizeFilename(body.filename) } } : {}),
        // Identity inputs (see jobs/identity.ts): an explicit version skips
        // detection, the file time is the last version fallback, and dedup
        // governs whether a duplicate is skipped.
        ...(body.version !== undefined ? { version: body.version } : {}),
        ...(body.sourceModifiedAt !== undefined ? { sourceModifiedAt: body.sourceModifiedAt } : {}),
        ...(body.dedup !== undefined ? { dedup: body.dedup } : {}),
        // Document attributes (contract 2.2), stored on every unit by Search.
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.tags !== undefined && body.tags.length > 0 ? { tags: body.tags } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        ...(body.link !== undefined ? { link: body.link } : {}),
        ...(body.sourceLabel !== undefined ? { sourceLabel: body.sourceLabel } : {}),
        // The document's readers, narrowed to the caller exactly like
        // /v1/ingest; the emitter opens the Search revision with it.
        acl: resolveAcl(getPrincipal(req), {
          users: body.allowedUsers ?? [],
          groups: body.allowedGroups ?? [],
        }),
      },
      pipeline_hash: snapshot.pipelineHash,
      prompt_hash: snapshot.promptHash,
      // E3: record who created this job, so the originator can poll it later
      // without `extract.admin` (requirements 8.7, 8.13).
      created_by_subject: getPrincipal(req).userId ?? null,
      created_by_tenant: getPrincipal(req).tenantId ?? null,
      ...(body.resumePolicy !== undefined ? { resume_policy: body.resumePolicy } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.tokenBudget !== undefined ? { token_budget: body.tokenBudget } : {}),
      ...(body.collection !== undefined ? { collection: body.collection } : {}),
      ...(body.callbackUrl !== undefined ? { callback_url: body.callbackUrl } : {}),
    });
    logger.info({ jobId: id, reference: body.reference }, "Job created");
    res.status(201).location(`/v2/jobs/${id}`).json(toJobView(row));
  }

  // ── GET /v2/jobs ──────────────────────────────────────────────────────────
  // The overview list: newest-first, paginated. Cheap by
  // design — it reads only the `jobs` table and returns each row through
  // `toJobView` WITHOUT the per-stage progress join, so a long list stays a
  // single indexed scan. The detail read (`GET /:id`) is the one that pays for
  // progress/eta. Response shape: `{ jobs: Job[], limit, offset }`.
  const listHandler: RequestHandler = (req, res, next) => {
    void listJobs(req, res).catch(next);
  };

  /** Clamp a query-string integer to `[min, max]`, falling back to `fallback`. */
  function readIntParam(
    req: Request,
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = req.query[name];
    const value = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  async function listJobs(req: Request, res: Response): Promise<void> {
    const limit = readIntParam(req, "limit", 25, 1, 100);
    const offset = readIntParam(req, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = await store.listJobs(limit, offset);
    res.status(200).json({ jobs: rows.map((row) => toJobView(row)), limit, offset });
  }

  // ── GET /v2/jobs/{id} ─────────────────────────────────────────────────────
  const getHandler: RequestHandler = (req, res, next) => {
    void getJob(req, res).catch(next);
  };

  async function getJob(req: Request, res: Response): Promise<void> {
    const id = readJobId(req);
    const row = await store.getJob(id);
    if (row === null) throw notFound(`Job ${id} does not exist`);
    // E3 (requirements 8.7, 8.13, 8.14): the originator may read their own
    // job without `extract.admin`. A foreign job answers with the *same* 404
    // an unknown id gets — a 403 here would confirm the id exists. Only a
    // caller with neither `extract.admin` nor `extract.ingest` gets a 403.
    // A credential with *no* scopes configured at all keeps the documented
    // `API_SERVICE_SCOPES` default of `createRequireScope`: it passes, because
    // the gate flags the missing configuration rather than failing every
    // request in a way that looks like a bug.
    const principal = getPrincipal(req);
    const scopes = principal.scopes ?? [];
    if (authzEnabled && scopes.length > 0) {
      const decision = canReadJob(
        {
          createdBySubject: row.created_by_subject ?? null,
          createdByTenant: row.created_by_tenant ?? null,
        },
        {
          ...(principal.userId !== undefined ? { subject: principal.userId } : {}),
          ...(principal.tenantId !== undefined ? { tenantId: principal.tenantId } : {}),
          scopes: new Set(scopes),
        },
      );
      if (decision === "not-found") throw notFound(`Job ${id} does not exist`);
      if (decision === "forbidden") {
        res.status(403).json({
          error: "Scope extract.ingest is required",
          code: "FORBIDDEN",
          retryable: false,
        });
        return;
      }
    }
    // Join the page-stage checkpoints so progress/eta are populated.
    const stages = await store.listStagesByStatus("page", id, "done").catch(() => []);
    const running = await store.listStagesByStatus("page", id, "running").catch(() => []);
    const failed = await store.listStagesByStatus("page", id, "failed").catch(() => []);
    const pending = await store.listStagesByStatus("page", id, "pending").catch(() => []);
    res.status(200).json(toJobView(row, [...stages, ...running, ...failed, ...pending]));
  }

  // ── GET /v2/jobs/{id}/figures ─────────────────────────────────────────────
  // The figure blocks of the job's staged page records, in page order. The
  // crop bytes are not stored (they re-render from the source), so a client
  // shows them through POST /v2/render with the figure's normalised bbox.
  const figuresHandler: RequestHandler = (req, res, next) => {
    void listFigures(req, res).catch(next);
  };

  async function listFigures(req: Request, res: Response): Promise<void> {
    const id = readJobId(req);
    const row = await store.getJob(id);
    if (row === null) throw notFound(`Job ${id} does not exist`);
    const batches = await store.allEmitBatches(id);
    const figures: Array<Record<string, unknown>> = [];
    for (const batch of [...batches].sort((a, b) => a.page_from - b.page_from || a.seq - b.seq)) {
      const record = (batch.payload as { record?: { blocks?: unknown } } | null)?.record;
      const blocks = Array.isArray(record?.blocks) ? (record.blocks as Array<Record<string, unknown>>) : [];
      for (const block of blocks) {
        if (block["type"] !== "figure") continue;
        figures.push({
          figureId: block["figureId"],
          page: block["page"],
          ...(Array.isArray(block["bbox"]) ? { bbox: block["bbox"] } : {}),
          kind: block["kind"],
          ...(typeof block["caption"] === "string" ? { caption: block["caption"] } : {}),
          description: block["description"],
          ...(typeof block["assetId"] === "string" ? { assetId: block["assetId"] } : {}),
        });
      }
    }
    res.status(200).json({ jobId: id, sourceSha256: row.source_sha256, figures });
  }

  // ── POST /v2/jobs/{id}/{pause|resume|cancel} ──────────────────────────────
  function actionHandler(action: JobAction): RequestHandler {
    return (req, res, next) => {
      void applyAction(req, res, action).catch(next);
    };
  }

  /**
   * Read the optional `resume` body: `{ resumePolicy?, restartStage? }` lets an
   * operator answer a pin pause by switching to `continue` or
   * `restart-stage=<stage>` in the same atomic step.
   */
  function readResumeOptions(req: Request): Pick<OperatorTransition, "resumePolicy" | "configPatch"> {
    const body = (req.body ?? {}) as { resumePolicy?: unknown; restartStage?: unknown };
    const out: Pick<OperatorTransition, "resumePolicy" | "configPatch"> = {};
    if (body.resumePolicy !== undefined) {
      const parsed = resumePolicySchema.safeParse(body.resumePolicy);
      if (!parsed.success) throw validationError("Invalid resumePolicy", { resumePolicy: body.resumePolicy });
      out.resumePolicy = parsed.data;
    }
    if (body.restartStage !== undefined) {
      if (typeof body.restartStage !== "string" || stageOrderIndex(body.restartStage) < 0) {
        throw validationError("Invalid restartStage", { restartStage: body.restartStage });
      }
      out.configPatch = { restartStage: body.restartStage };
    }
    return out;
  }

  /**
   * Apply an operator transition atomically with a lease revocation (the store
   * bumps the epoch and clears the holder), guarded on the status the state
   * machine validated. A lost race re-reads and re-validates, so a running
   * worker can neither overwrite `cancelled`/`paused` nor be missed.
   */
  async function transitionWithRevocation(
    id: string,
    resolve: (row: JobRow) => Omit<OperatorTransition, "expectedStatus"> | "idempotent" | null,
    describe: string,
  ): Promise<JobRow> {
    for (let attempt = 0; attempt < ACTION_RETRIES; attempt++) {
      const row = await store.getJob(id);
      if (row === null) throw notFound(`Job ${id} does not exist`);
      const next = resolve(row);
      if (next === "idempotent") return row;
      if (next === null) throw conflict(`Cannot ${describe} a job in status ${row.status}`);
      const updated = await store.operatorTransition(id, { ...next, expectedStatus: row.status });
      if (updated !== null) return updated;
      // The status moved under us; re-read and re-validate.
    }
    throw conflict(`Job ${id} changed concurrently; retry the ${describe} request`);
  }

  async function applyAction(req: Request, res: Response, action: JobAction): Promise<void> {
    const id = readJobId(req);
    const options = action === "resume" ? readResumeOptions(req) : {};
    const updated = await transitionWithRevocation(
      id,
      (row) => {
        const resolved = resolveAction(row.status, action);
        if (resolved === null) {
          // Idempotent no-op reads as success: pausing an already-paused job,
          // resuming a job that is already running (not paused, not terminal),
          // or cancelling an already-cancelled job. Acting on a terminal job
          // otherwise (e.g. resuming a completed one) is a 409.
          const idempotent =
            (action === "pause" && row.status === "paused") ||
            (action === "resume" && !isTerminal(row.status)) ||
            (action === "cancel" && row.status === "cancelled");
          return idempotent ? "idempotent" : null;
        }
        return { status: resolved.next, pauseReason: resolved.pauseReason, ...options };
      },
      action,
    );
    logger.info({ jobId: id, action, status: updated.status }, "Job action applied");
    res.status(200).json(toJobView(updated));
  }

  function requeueGuard(row: JobRow, action: RequeueAction): boolean {
    return resolveRequeue(row.status, action) !== null;
  }

  // ── POST /v2/jobs/{id}/retry-failed ───────────────────────────────────────
  // Reset the failed page-stage checkpoints to pending and re-queue the job, so
  // only the failed units are recomputed. Units that
  // succeeded keep their checkpoint and are reused without a model call.
  const retryFailedHandler: RequestHandler = (req, res, next) => {
    void retryFailed(req, res).catch(next);
  };

  async function retryFailed(req: Request, res: Response): Promise<void> {
    const id = readJobId(req);
    for (let attempt = 0; attempt < ACTION_RETRIES; attempt++) {
      const row = await store.getJob(id);
      if (row === null) throw notFound(`Job ${id} does not exist`);
      // A permanent unit failure keeps the job running to completion, so
      // retry-failed targets a completed, failed or paused job; a live or
      // cancelled job is a conflict.
      if (!requeueGuard(row, "retry-failed")) {
        throw conflict(`Cannot retry a job in status ${row.status}; it is still active`);
      }
      // One transaction: failed units → pending, the affected pages' crops and
      // base record plus the ordered document pass from the first affected page
      // are rebuilt, a new emit generation starts, and the job is re-queued with
      // a lease revocation. Succeeded units keep their checkpoints and are
      // reused without a model call.
      const result = await store.retryFailedUnits(id, row.status, {
        cropStages: [CROPS_STAGE],
        emitStage: EMITTED_STAGE,
        docpassStage: DOCPASS_STAGE,
      });
      if (result === null) continue; // status moved concurrently; re-validate
      logger.info({ jobId: id, reset: result.reset }, "retry-failed: reset failed units and re-queued");
      res.status(200).json({ ...toJobView(result.job), retriedUnits: result.reset });
      return;
    }
    throw conflict(`Job ${id} changed concurrently; retry the retry-failed request`);
  }

  // ── POST /v2/jobs/{id}/reparse ────────────────────────────────────────────
  // Re-apply the parser to the persisted model raw responses, WITHOUT any new
  // model calls. The staged pipeline does
  // the actual reparse; here we flag the job and re-queue it so a worker runs
  // the parse-only path.
  const reparseHandler: RequestHandler = (req, res, next) => {
    void reparse(req, res).catch(next);
  };

  async function reparse(req: Request, res: Response): Promise<void> {
    const id = readJobId(req);
    // Flag the reparse and re-queue in ONE statement with a lease revocation:
    // the runner then re-applies the parsers to the persisted raw responses,
    // rebuilds crops/records/document pass/outbox, and emits a new generation —
    // with no model call for any unit that already has a response.
    const requeued = await transitionWithRevocation(
      id,
      (row) =>
        requeueGuard(row, "reparse")
          ? { status: "queued", pauseReason: null, configPatch: { reparse: true } }
          : null,
      "reparse",
    );
    logger.info({ jobId: id }, "reparse: re-queued for parse-only run");
    res.status(200).json({ ...toJobView(requeued), reparse: true });
  }

  router.post("/", createHandler);
  router.get("/", listHandler);
  router.get("/:id", getHandler);
  router.get("/:id/figures", figuresHandler);
  router.post("/:id/pause", actionHandler("pause"));
  router.post("/:id/resume", actionHandler("resume"));
  router.post("/:id/cancel", actionHandler("cancel"));
  router.post("/:id/retry-failed", retryFailedHandler);
  router.post("/:id/reparse", reparseHandler);

  return router;
}
