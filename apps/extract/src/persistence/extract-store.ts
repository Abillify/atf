// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * extract-store.ts
 *
 * The typed data-access layer over the `extract` schema. This is intentionally
 * thin: it owns the connection pool, runs the forward-only migrations once on
 * first use, and exposes the small set of CRUD operations the job worker, stage
 * framework and emitter build their business logic on. No state-machine or
 * scheduling logic lives here.
 *
 * Lazy initialisation is the point. Extract has historically had no database
 * dependency, and the v1 synchronous ingest/convert paths must keep working
 * with none. So the store is only constructed when `EXTRACT_DATABASE_URL` is
 * configured, and even then the pool is opened and migrated lazily the first
 * time a caller touches it — a deployment that never starts a v2 job never
 * opens a connection.
 *
 * ## Fenced writes
 *
 * Every mutating method a worker calls takes an optional {@link Fence} (its
 * lease token). With a fence, the write is only applied while the job still
 * carries that holder and epoch — checked in SQL, atomically with the write:
 * `jobs`-row updates carry the fence in their WHERE clause; child-table writes
 * run in a transaction that locks the job row (`FOR SHARE`, or `FOR NO KEY
 * UPDATE` when the transaction also updates the job row) before writing. A
 * failed fence raises {@link LeaseLostError}. Without a fence the write is an
 * operator/API write and applies unconditionally.
 */

import { Pool, type PoolClient } from "pg";
import type { Logger } from "pino";
import { sha256Hex } from "@atf/extract-contract";
import type { ExtractDatabaseConfig } from "../config.js";
import {
  EXTRACT_SCHEMA,
  runExtractMigrations,
  type MigrationLogger,
} from "./extract-ddl.js";
import * as q from "./extract-queries.js";
import type { StageKey } from "./extract-queries.js";
import {
  LeaseLostError,
  type AssetOutboxRow,
  type DocpassStateRow,
  type DownstreamInvalidation,
  type EmitOutboxRow,
  type Fence,
  type JobRow,
  type NewJob,
  type OperatorTransition,
  type OutboxStatus,
  type PageStageRow,
  type StageUnit,
  type StageUpsert,
  type TokenSettlement,
  type UploadAppend,
  type UploadAppendResult,
  type UploadRow,
} from "./types.js";

/** The payload of an emit-outbox row staged for one page. */
export interface EmitStageRow {
  job_id: string;
  seq: number;
  digest: string;
  page_from: number;
  page_to: number;
  payload?: unknown;
  payload_ref?: string | null;
}

/** An asset-outbox row to stage. */
export interface AssetStageRow {
  job_id: string;
  asset_id: string;
  page?: number | null;
  checksum?: string | null;
  variant?: string | null;
  mime_type?: string | null;
}

/** The three writes of one document-pass page, committed together. */
export interface DocpassPageCommit {
  page: number;
  /** The enriched emit-outbox payload, or null when the page had no record. */
  payload: unknown | null;
  /** The running document-pass state AFTER this page. */
  state: unknown;
  /** The per-page `docpass` checkpoint. */
  checkpoint: StageUpsert;
}

/** The typed data-access surface. All methods run against the `extract` schema. */
export interface ExtractStore {
  /** Open the pool (if needed) and run pending migrations. Idempotent. */
  init(): Promise<void>;
  /** Liveness probe used by /health. */
  ping(): Promise<boolean>;

  // jobs
  createJob(job: NewJob): Promise<JobRow>;
  getJob(id: string): Promise<JobRow | null>;
  /**
   * List jobs newest-first for the overview UI, paginated with `limit`/`offset`
   * (requirement 18.6). Reads only the `jobs` table — no per-stage join — so the
   * list stays cheap regardless of the page count of each job.
   */
  listJobs(limit: number, offset: number): Promise<JobRow[]>;
  /**
   * Which of `messageIds` a (non-failed) job of the collection has recorded as
   * its e-mail's Message-ID — i.e. which messages the corpus already holds.
   * Decides whether a reply's quoted history may be dropped.
   */
  knownEmailMessageIds(collection: string | null, messageIds: string[]): Promise<Set<string>>;
  /** Set status (+ pause reason). With a fence, a lost lease throws. */
  setJobStatus(
    id: string,
    status: JobRow["status"],
    pauseReason?: JobRow["pause_reason"],
    fence?: Fence,
  ): Promise<JobRow | null>;
  /**
   * Park a job in `paused(reason)`. `autoResumeAt` arms the automatic re-claim
   * of a dependency pause; `null` leaves the job for an operator.
   */
  pauseJob(
    id: string,
    reason: NonNullable<JobRow["pause_reason"]>,
    autoResumeAt: Date | null,
    configPatch?: Record<string, unknown>,
    fence?: Fence,
  ): Promise<JobRow | null>;
  /** Record the page count once the source is prepared into a document. */
  setJobPageCount(id: string, pageCount: number, fence?: Fence): Promise<JobRow | null>;
  /** Record (or clear) the Search revision id the emitter opened for this job. */
  setJobRevision(id: string, revisionId: string | null, fence?: Fence): Promise<JobRow | null>;
  /** Re-point the job at its canonical document reference (before preparation). */
  setJobReference(id: string, reference: string, fence?: Fence): Promise<JobRow | null>;
  /** Atomically add to `tokens_used`, returning the updated row (budget ledger). */
  consumeJobTokens(id: string, tokens: number, fence?: Fence): Promise<JobRow | null>;
  /**
   * Atomically reserve `tokens` of the job's budget. Returns the updated row,
   * or null when the budget cannot cover the reservation. Throws
   * {@link LeaseLostError} when fenced and the lease is gone.
   */
  reserveJobTokens(id: string, tokens: number, fence?: Fence): Promise<JobRow | null>;
  /** Release a reservation and book the actual spend (outside a checkpoint). */
  settleJobTokens(id: string, settlement: TokenSettlement, fence?: Fence): Promise<JobRow | null>;
  /** Merge a JSON patch into a job's config (e.g. the reparse flag). */
  patchJobConfig(id: string, patch: Record<string, unknown>, fence?: Fence): Promise<JobRow | null>;
  /** Append a warning to a job's `warnings` array (permanent unit failure). */
  appendJobWarning(id: string, warning: string, fence?: Fence): Promise<JobRow | null>;
  /** Re-queue a job (operator action): revokes the lease by bumping the epoch. */
  requeueJob(id: string): Promise<JobRow | null>;
  /**
   * Apply an operator action atomically with a lease revocation. Returns null
   * when the job does not exist or its status is no longer `expectedStatus`.
   */
  operatorTransition(id: string, transition: OperatorTransition): Promise<JobRow | null>;
  /**
   * retry-failed (requirement 4.10), in one transaction: move every failed
   * unit back to `pending`, reset the crop/emit checkpoints of the affected
   * pages and the document pass from the first affected page on, start a new
   * emit generation, and re-queue the job with a lease revocation. Returns null
   * when the job's status is no longer `expectedStatus`.
   */
  retryFailedUnits(
    id: string,
    expectedStatus: JobRow["status"],
    downstream: { cropStages: string[]; emitStage: string; docpassStage: string },
  ): Promise<{ job: JobRow; reset: number } | null>;
  /**
   * Claim the next runnable job with a fresh lease, honouring the large-job
   * lane cap (requirement 6.6). A job with more than `largeJobPageThreshold`
   * pages runs in the large lane; no more than `largeJobMaxConcurrency` large
   * jobs are ever leased at once across the fleet, so a worker at the cap falls
   * through to the next normal job. An unsized job (null page count) is treated
   * as normal until `preparing` sizes it. A `paused` job with `auto_resume`
   * armed and due is claimed too (and moved back to `queued`).
   */
  claimNextJob(
    leaseHolder: string,
    leaseSeconds: number,
    largeJobPageThreshold?: number,
    largeJobMaxConcurrency?: number,
  ): Promise<JobRow | null>;
  heartbeat(id: string, leaseHolder: string, epoch: number, leaseSeconds: number): Promise<JobRow | null>;

  // stage checkpoints
  getStage(unit: StageUnit, key: StageKey): Promise<PageStageRow | null>;
  upsertStage(unit: StageUnit, row: StageUpsert, fence?: Fence): Promise<PageStageRow>;
  /**
   * Persist a successful stage checkpoint and settle its token reservation in
   * ONE transaction (requirement 4.9), so the result and its cost are recorded
   * together or not at all. Returns the checkpoint and, when a settlement was
   * applied, the updated job row.
   */
  completeStage(
    unit: StageUnit,
    row: StageUpsert,
    fence: Fence | undefined,
    settlement?: TokenSettlement,
  ): Promise<{ stage: PageStageRow; job: JobRow | null }>;
  listStagesByStatus(unit: StageUnit, jobId: string, status: string): Promise<PageStageRow[]>;
  /** One stage's checkpoints over the page window `[fromPage, toPage]`. */
  listStagesWindow(
    unit: StageUnit,
    jobId: string,
    stage: string,
    fromPage: number,
    toPage: number,
  ): Promise<PageStageRow[]>;
  /**
   * The next `limit` unfinished, due page numbers of `[1..pageCount]`, in strict
   * ascending order, keyed off the `cursorStage` checkpoint. A page with any
   * unit in a transient-failure backoff is not due. The LIMIT bounds the result
   * so the scheduler never materialises a full-document array (requirement 6.1).
   */
  nextRunnablePages(
    jobId: string,
    pageCount: number,
    cursorStage: string,
    limit: number,
    now?: Date,
  ): Promise<number[]>;
  /** The earliest future retry instant of any transiently-failed unit, or null. */
  earliestRetryAt(jobId: string, now?: Date): Promise<Date | null>;
  /** How many pages have a finished (`done`/permanently `failed`) cursor stage. */
  finishedPageCount(jobId: string, cursorStage: string): Promise<number>;
  /**
   * Invalidate the downstream stages in one fenced transaction (reparse,
   * restart-stage): reset the listed page stages from `fromPage` on, drop the
   * document-pass states and emit-outbox rows from there, drop (or reset) the
   * asset outbox, and start a new emit generation.
   */
  invalidateDownstream(jobId: string, invalidation: DownstreamInvalidation, fence?: Fence): Promise<JobRow | null>;

  // document-pass state
  saveDocpassState(jobId: string, page: number, state: unknown, fence?: Fence): Promise<void>;
  latestDocpassState(jobId: string): Promise<DocpassStateRow | null>;
  /**
   * Commit one document-pass page atomically: the enriched emit payload, the
   * running state after the page, and the page's `docpass` checkpoint. A crash
   * can therefore never leave an enriched payload without its state (which
   * would re-enrich it on resume).
   */
  commitDocpassPage(jobId: string, commit: DocpassPageCommit, fence?: Fence): Promise<void>;

  // outboxes
  stageEmitBatch(row: EmitStageRow, fence?: Fence): Promise<EmitOutboxRow | null>;
  setEmitStatus(jobId: string, seq: number, status: OutboxStatus, fence?: Fence): Promise<EmitOutboxRow | null>;
  /**
   * Replace a staged emit-outbox row's payload and recompute its digest in
   * place. Returns null when no row matches the seq (a skipped page).
   */
  updateEmitPayload(jobId: string, seq: number, payload: unknown, fence?: Fence): Promise<EmitOutboxRow | null>;
  /** One emit-outbox row (with payload) by seq. */
  getEmitBatch(jobId: string, seq: number): Promise<EmitOutboxRow | null>;
  /** Every emit-outbox row in seq order WITHOUT payloads (payload is null). */
  listEmitBatchMeta(jobId: string): Promise<EmitOutboxRow[]>;
  /** The emit-outbox rows (with payloads) of the seq window `[fromSeq, toSeq]`. */
  emitBatchesInRange(jobId: string, fromSeq: number, toSeq: number): Promise<EmitOutboxRow[]>;
  pendingEmitBatches(jobId: string): Promise<EmitOutboxRow[]>;
  /** Every emit-outbox row in seq order (all statuses, with payloads). */
  allEmitBatches(jobId: string): Promise<EmitOutboxRow[]>;
  /**
   * Start a new emit generation (fenced, one transaction): bump the job's
   * `emit_generation`, clear its `revision_id`, and move every emit- and
   * asset-outbox row back to `pending` so the next emit sends everything to a
   * fresh revision.
   */
  resetEmitGeneration(jobId: string, fence?: Fence): Promise<JobRow | null>;
  stageAsset(row: AssetStageRow, fence?: Fence): Promise<AssetOutboxRow | null>;
  setAssetStatus(jobId: string, assetId: string, status: OutboxStatus, fence?: Fence): Promise<AssetOutboxRow | null>;
  /** Every asset-outbox row for a job, in a stable order. */
  allAssets(jobId: string): Promise<AssetOutboxRow[]>;

  // resumable uploads
  createUpload(row: {
    upload_id: string;
    reference: string;
    expected_sha256?: string | null;
    size?: number | null;
  }): Promise<UploadRow>;
  getUpload(uploadId: string): Promise<UploadRow | null>;
  /**
   * Set the confirmed offset, and optionally the status and the source digest
   * (recorded at completion, so a repeated complete can answer idempotently).
   */
  updateUploadOffset(
    uploadId: string,
    receivedOffset: number,
    status?: string,
    sha256?: string,
  ): Promise<UploadRow | null>;
  /**
   * Append one chunk and advance the confirmed offset atomically across
   * replicas: lock the session row, re-check `open` + `expectedOffset`, run
   * `append` while holding the lock, then advance with a conditional update —
   * all in one transaction ({@link advanceUploadOffsetInTx}). A stale offset
   * or a closed/vanished session is a `conflict` and nothing is appended.
   */
  advanceUploadOffset(commit: UploadAppend): Promise<UploadAppendResult>;

  /** Run a callback inside a single transaction, for multi-write atomicity. */
  withTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/** A pino logger satisfies the migration runner's minimal logger shape. */
function toMigrationLogger(logger: Logger): MigrationLogger {
  return {
    info: (obj, msg) => logger.info(obj as object, msg),
    debug: (obj, msg) => logger.debug(obj as object, msg),
  };
}

/** The digest of an emit payload, as stored on the outbox row. */
export function emitPayloadDigest(payload: unknown): string {
  return sha256Hex(JSON.stringify(payload));
}

/**
 * The body of {@link ExtractStore.advanceUploadOffset}, run on a client that
 * is already inside a transaction: row lock (`SELECT … FOR UPDATE`), re-check
 * of `status = 'open'` and `received_offset = expectedOffset`, the append while
 * holding the lock, then the conditional offset update. Exported so the SQL
 * sequence can be tested against a fake client.
 */
export async function advanceUploadOffsetInTx(
  client: Pick<PoolClient, "query">,
  commit: UploadAppend,
): Promise<UploadAppendResult> {
  const { uploadId, expectedOffset, newOffset, append } = commit;
  const lock = q.lockUploadForAppendQuery(uploadId);
  const locked = await client.query<UploadRow>(lock.text, lock.values as unknown[]);
  const current = locked.rows[0] ?? null;
  if (
    current === null ||
    current.status !== "open" ||
    Number(current.received_offset) !== expectedOffset
  ) {
    return { status: "conflict", current };
  }

  await append();

  const advance = q.advanceUploadOffsetQuery(uploadId, expectedOffset, newOffset);
  const updated = await client.query<UploadRow>(advance.text, advance.values as unknown[]);
  const row = updated.rows[0];
  if (row === undefined) {
    // Unreachable while the row lock is held; fail loudly so the transaction
    // rolls back rather than reporting a phantom success.
    throw new Error(`Upload ${uploadId}: conditional offset update matched no row`);
  }
  return { status: "committed", row };
}

/**
 * Create the store. This does NOT open a connection — the pool is created and
 * migrations run on the first `init()` (or the first operation, which calls
 * `init()` for you). That keeps the "database is optional" guarantee: importing
 * and constructing the store is free.
 */
export function createExtractStore(
  config: ExtractDatabaseConfig,
  logger: Logger,
): ExtractStore {
  let pool: Pool | null = null;
  let initPromise: Promise<void> | null = null;

  function getPool(): Pool {
    if (pool === null) {
      pool = new Pool({
        connectionString: config.url,
        max: config.poolMax,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
      pool.on("error", (err) => {
        logger.error({ err }, "Unexpected idle extract PostgreSQL client error");
      });
    }
    return pool;
  }

  /** Open + migrate exactly once, even under concurrent first calls. */
  async function init(): Promise<void> {
    if (initPromise === null) {
      initPromise = (async () => {
        const version = await runExtractMigrations(getPool(), toMigrationLogger(logger));
        logger.info({ schemaVersion: version }, "Extract persistence ready");
      })().catch((err) => {
        // Reset so a transient startup failure can be retried on the next call
        // rather than being cached forever.
        initPromise = null;
        throw err;
      });
    }
    return initPromise;
  }

  /** Acquire a client, applying the per-query statement timeout. */
  async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await init();
    const client = await getPool().connect();
    try {
      if (config.statementTimeoutMs > 0) {
        await client.query(`SET statement_timeout = ${config.statementTimeoutMs}`);
      }
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async function run<Row>(query: q.Query): Promise<Row[]> {
    return withClient(async (client) => {
      const res = await client.query(query.text, query.values as unknown[]);
      return res.rows as Row[];
    });
  }

  async function one<Row>(query: q.Query): Promise<Row | null> {
    const rows = await run<Row>(query);
    return rows[0] ?? null;
  }

  /**
   * A jobs-row update that carries the fence in its WHERE clause. Zero rows
   * under a fence means the lease is gone (or the job vanished — equally a
   * reason to stop writing).
   */
  async function oneFenced<Row>(query: q.Query, fence: Fence | undefined): Promise<Row | null> {
    const row = await one<Row>(query);
    if (row === null && fence !== undefined) throw new LeaseLostError(fence);
    return row;
  }

  async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Run `fn` in a transaction whose first statement verifies (and locks) the
   * lease. Unfenced callers get a plain transaction. The fence check and the
   * writes share one transaction, so the check-then-act gap of a separate
   * heartbeat is gone.
   */
  async function fencedTx<T>(
    fence: Fence | undefined,
    lock: "share" | "update",
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return tx(async (client) => {
      if (fence !== undefined) {
        const check = q.fenceCheckQuery(fence, lock);
        const res = await client.query(check.text, check.values as unknown[]);
        if (res.rowCount === 0) throw new LeaseLostError(fence);
      }
      return fn(client);
    });
  }

  async function exec<Row>(client: PoolClient, query: q.Query): Promise<Row[]> {
    const res = await client.query(query.text, query.values as unknown[]);
    return res.rows as Row[];
  }

  /** A single child-table write, fenced when a fence is given. */
  async function childWrite<Row>(query: q.Query, fence: Fence | undefined): Promise<Row | null> {
    if (fence === undefined) return one<Row>(query);
    return fencedTx(fence, "share", async (client) => (await exec<Row>(client, query))[0] ?? null);
  }

  return {
    init,

    async ping() {
      try {
        await withClient((client) => client.query("SELECT 1"));
        return true;
      } catch (err) {
        logger.error({ err }, "Extract persistence ping failed");
        return false;
      }
    },

    // ── jobs ────────────────────────────────────────────────────────────────
    async createJob(job) {
      const row = await one<JobRow>(q.insertJobQuery(job));
      if (row === null) throw new Error("createJob: insert returned no row");
      return row;
    },
    getJob: (id) => one<JobRow>(q.getJobQuery(id)),
    listJobs: (limit, offset) => run<JobRow>(q.listJobsQuery(limit, offset)),
    async knownEmailMessageIds(collection, messageIds) {
      if (messageIds.length === 0) return new Set();
      const rows = await run<{ message_id: string }>(q.knownEmailMessageIdsQuery(collection, messageIds));
      return new Set(rows.map((r) => r.message_id));
    },
    setJobStatus: (id, status, pauseReason = null, fence) =>
      oneFenced<JobRow>(q.updateJobStatusQuery(id, status, pauseReason, fence), fence),
    pauseJob: (id, reason, autoResumeAt, configPatch = {}, fence) =>
      oneFenced<JobRow>(q.pauseJobQuery(id, reason, autoResumeAt, configPatch, fence), fence),
    setJobPageCount: (id, pageCount, fence) =>
      oneFenced<JobRow>(q.setJobPageCountQuery(id, pageCount, fence), fence),
    setJobRevision: (id, revisionId, fence) =>
      oneFenced<JobRow>(q.setJobRevisionQuery(id, revisionId, fence), fence),
    setJobReference: (id, reference, fence) =>
      oneFenced<JobRow>(q.setJobReferenceQuery(id, reference, fence), fence),
    consumeJobTokens: (id, tokens, fence) =>
      oneFenced<JobRow>(q.consumeJobTokensQuery(id, tokens, fence), fence),
    reserveJobTokens: (id, tokens, fence) =>
      fencedTx(fence, "update", async (client) => {
        const rows = await exec<JobRow>(client, q.reserveJobTokensQuery(id, tokens));
        return rows[0] ?? null;
      }),
    settleJobTokens: (id, settlement, fence) =>
      fencedTx(fence, "update", async (client) => {
        const rows = await exec<JobRow>(
          client,
          q.settleJobTokensQuery(id, settlement.reserved, settlement.used),
        );
        return rows[0] ?? null;
      }),
    patchJobConfig: (id, patch, fence) =>
      oneFenced<JobRow>(q.patchJobConfigQuery(id, patch, fence), fence),
    appendJobWarning: (id, warning, fence) =>
      oneFenced<JobRow>(q.appendJobWarningQuery(id, warning, fence), fence),
    requeueJob: (id) => one<JobRow>(q.requeueJobQuery(id)),
    operatorTransition: (id, transition) => one<JobRow>(q.operatorTransitionQuery(id, transition)),
    async retryFailedUnits(id, expectedStatus, downstream) {
      return tx(async (client) => {
        // Lock the job row first so a concurrent claim/operator action waits.
        const locked = await exec<JobRow>(client, {
          text: `SELECT * FROM ${EXTRACT_SCHEMA}.jobs WHERE id = $1 AND status = $2 FOR UPDATE`,
          values: [id, expectedStatus],
        });
        if (locked.length === 0) return null;
        const pages = new Set<number>();
        let reset = 0;
        for (const unit of ["page", "figure", "tile"] as const) {
          const rows = await exec<{ page: number }>(client, q.retryFailedStagesQuery(unit, id));
          reset += rows.length;
          for (const r of rows) pages.add(Number(r.page));
        }
        if (pages.size > 0) {
          const affected = [...pages].sort((a, b) => a - b);
          const first = affected[0] ?? 1;
          // The affected pages rebuild their crops and base record; the ordered
          // document pass rebuilds from the first affected page on.
          await exec(
            client,
            q.resetPageStagesForPagesQuery(id, [...downstream.cropStages, downstream.emitStage], affected),
          );
          await exec(
            client,
            q.resetPageStagesFromQuery(id, [downstream.emitStage, downstream.docpassStage], first),
          );
          await exec(client, q.deleteDocpassStateFromQuery(id, first));
          // The revision content changes: a new emit generation re-sends all.
          await exec(client, q.bumpEmitGenerationQuery(id));
          await exec(client, q.resetEmitOutboxQuery(id));
          await exec(client, q.resetAssetOutboxQuery(id));
        }
        const job = (await exec<JobRow>(client, q.requeueJobQuery(id)))[0];
        if (job === undefined) return null;
        return { job, reset };
      });
    },
    claimNextJob: (leaseHolder, leaseSeconds, largeJobPageThreshold, largeJobMaxConcurrency) =>
      one<JobRow>(
        q.claimNextJobQuery(
          leaseHolder,
          leaseSeconds,
          largeJobPageThreshold,
          largeJobMaxConcurrency,
        ),
      ),
    heartbeat: (id, leaseHolder, epoch, leaseSeconds) =>
      one<JobRow>(q.heartbeatJobQuery(id, leaseHolder, epoch, leaseSeconds)),

    // ── stage checkpoints ─────────────────────────────────────────────────
    getStage: (unit, key) => one<PageStageRow>(q.getStageQuery(unit, key)),
    async upsertStage(unit, row, fence) {
      const result = await childWrite<PageStageRow>(q.upsertStageQuery(unit, row), fence);
      if (result === null) throw new Error("upsertStage: returned no row");
      return result;
    },
    async completeStage(unit, row, fence, settlement) {
      const lock = settlement !== undefined ? "update" : "share";
      return fencedTx(fence, lock, async (client) => {
        const stage = (await exec<PageStageRow>(client, q.upsertStageQuery(unit, row)))[0];
        if (stage === undefined) throw new Error("completeStage: returned no row");
        let job: JobRow | null = null;
        if (settlement !== undefined) {
          job =
            (await exec<JobRow>(
              client,
              q.settleJobTokensQuery(row.job_id, settlement.reserved, settlement.used),
            ))[0] ?? null;
        }
        return { stage, job };
      });
    },
    listStagesByStatus: (unit, jobId, status) =>
      run<PageStageRow>(q.listStagesByStatusQuery(unit, jobId, status)),
    listStagesWindow: (unit, jobId, stage, fromPage, toPage) =>
      run<PageStageRow>(q.listStagesWindowQuery(unit, jobId, stage, fromPage, toPage)),
    async nextRunnablePages(jobId, pageCount, cursorStage, limit, now = new Date()) {
      if (pageCount <= 0 || limit <= 0) return [];
      const rows = await run<{ page: number }>(
        q.nextRunnablePagesQuery(jobId, pageCount, cursorStage, limit, now),
      );
      return rows.map((r) => Number(r.page));
    },
    async earliestRetryAt(jobId, now = new Date()) {
      const row = await one<{ at: Date | null }>(q.earliestRetryAtQuery(jobId, now));
      return row?.at ?? null;
    },
    async finishedPageCount(jobId, cursorStage) {
      const row = await one<{ count: number }>(q.finishedPageCountQuery(jobId, cursorStage));
      return Number(row?.count ?? 0);
    },
    invalidateDownstream: (jobId, inv, fence) =>
      fencedTx(fence, "update", async (client) => {
        await exec(client, q.resetPageStagesFromQuery(jobId, inv.stages, inv.fromPage));
        await exec(client, q.deleteDocpassStateFromQuery(jobId, inv.fromPage));
        await exec(client, q.deleteEmitOutboxFromQuery(jobId, inv.fromPage));
        await exec(client, q.resetEmitOutboxQuery(jobId));
        await exec(
          client,
          inv.deleteAssets ? q.deleteAssetOutboxQuery(jobId) : q.resetAssetOutboxQuery(jobId),
        );
        await exec(client, q.bumpEmitGenerationQuery(jobId));
        if (inv.configPatch !== undefined) {
          await exec(client, q.patchJobConfigQuery(jobId, inv.configPatch));
        }
        return (await exec<JobRow>(client, q.getJobQuery(jobId)))[0] ?? null;
      }),

    // ── document-pass state ───────────────────────────────────────────────
    async saveDocpassState(jobId, page, state, fence) {
      await childWrite(q.upsertDocpassStateQuery(jobId, page, state), fence);
    },
    latestDocpassState: (jobId) => one<DocpassStateRow>(q.latestDocpassStateQuery(jobId)),
    async commitDocpassPage(jobId, commit, fence) {
      await fencedTx(fence, "share", async (client) => {
        if (commit.payload !== null) {
          await exec(
            client,
            q.updateEmitOutboxPayloadQuery(jobId, commit.page, commit.payload, emitPayloadDigest(commit.payload)),
          );
        }
        await exec(client, q.upsertDocpassStateQuery(jobId, commit.page, commit.state));
        await exec(client, q.upsertStageQuery("page", commit.checkpoint));
      });
    },

    // ── outboxes ──────────────────────────────────────────────────────────
    stageEmitBatch: (row, fence) => childWrite<EmitOutboxRow>(q.insertEmitOutboxQuery(row), fence),
    setEmitStatus: (jobId, seq, status, fence) =>
      childWrite<EmitOutboxRow>(q.setEmitOutboxStatusQuery(jobId, seq, status), fence),
    updateEmitPayload: (jobId, seq, payload, fence) =>
      childWrite<EmitOutboxRow>(
        q.updateEmitOutboxPayloadQuery(jobId, seq, payload, emitPayloadDigest(payload)),
        fence,
      ),
    getEmitBatch: (jobId, seq) => one<EmitOutboxRow>(q.getEmitOutboxQuery(jobId, seq)),
    listEmitBatchMeta: (jobId) => run<EmitOutboxRow>(q.emitOutboxMetaQuery(jobId)),
    emitBatchesInRange: (jobId, fromSeq, toSeq) =>
      run<EmitOutboxRow>(q.emitOutboxRangeQuery(jobId, fromSeq, toSeq)),
    pendingEmitBatches: (jobId) => run<EmitOutboxRow>(q.pendingEmitOutboxQuery(jobId)),
    allEmitBatches: (jobId) => run<EmitOutboxRow>(q.allEmitOutboxQuery(jobId)),
    resetEmitGeneration: (jobId, fence) =>
      fencedTx(fence, "update", async (client) => {
        const job = (await exec<JobRow>(client, q.bumpEmitGenerationQuery(jobId)))[0] ?? null;
        await exec(client, q.resetEmitOutboxQuery(jobId));
        await exec(client, q.resetAssetOutboxQuery(jobId));
        return job;
      }),
    stageAsset: (row, fence) => childWrite<AssetOutboxRow>(q.insertAssetOutboxQuery(row), fence),
    setAssetStatus: (jobId, assetId, status, fence) =>
      childWrite<AssetOutboxRow>(q.setAssetOutboxStatusQuery(jobId, assetId, status), fence),
    allAssets: (jobId) => run<AssetOutboxRow>(q.allAssetOutboxQuery(jobId)),

    // ── resumable uploads ─────────────────────────────────────────────────
    async createUpload(row) {
      const result = await one<UploadRow>(q.insertUploadQuery(row));
      if (result === null) throw new Error("createUpload: returned no row");
      return result;
    },
    getUpload: (uploadId) => one<UploadRow>(q.getUploadQuery(uploadId)),
    updateUploadOffset: (uploadId, receivedOffset, status, sha256) =>
      one<UploadRow>(q.updateUploadOffsetQuery(uploadId, receivedOffset, status, sha256)),
    advanceUploadOffset: (commit) => tx((client) => advanceUploadOffsetInTx(client, commit)),

    // ── transaction ───────────────────────────────────────────────────────
    withTransaction: (fn) => tx(fn),

    async close() {
      if (pool !== null) {
        await pool.end();
        pool = null;
        initPromise = null;
      }
    },
  };
}
