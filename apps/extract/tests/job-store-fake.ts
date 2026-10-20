// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * job-store-fake.ts
 *
 * An in-memory ExtractStore that faithfully models the job + stage semantics
 * the worker loop, the stage runner, the job runner and the Job API depend on:
 * lease claim with SKIP-LOCKED-style single-claim, epoch bump on claim/takeover
 * and on every operator action, epoch-FENCED writes (a write carrying a stale
 * fence throws LeaseLostError, exactly like the SQL fence), expired-lease
 * takeover, auto-resume of `paused(dependency)` jobs, atomic token
 * reservations, the backoff-aware page scheduler, downstream invalidation and
 * the emit generation. It is NOT a general Postgres emulator; the upload
 * surface throws.
 *
 * A controllable clock (`now`) lets a test expire a lease or a backoff
 * deterministically without sleeping.
 */

import type { ErasureJobTargetFilter } from "../src/persistence/extract-queries.js";
import type { ExtractStore } from "../src/persistence/index.js";
import {
  type AssetOutboxRow,
  type DocpassStateRow,
  type EmitOutboxRow,
  type ErasureJobTargetRow,
  type ErasureLedgerRecord,
  type ErasureLedgerState,
  type Fence,
  type JobRow,
  LeaseLostError,
  type NewJob,
  type PageStageRow,
  type StageStatus,
  type StageUnit,
  type StageUpsert,
} from "../src/persistence/types.js";

export interface FakeJobStore extends ExtractStore {
  /** Seed an upload session row (the erasure surface; uploads have no real store here). */
  seedUpload(uploadId: string, reference: string, status?: string): void;
  /** The remaining upload sessions, for assertions after an erasure. */
  peekUploads(): Array<{ upload_id: string; reference: string }>;
  /** Directly read a ledger record for assertions. */
  peekErasureLedger(key: string): ErasureLedgerRecord | undefined;
  /** Advance the fake clock by `ms`, so leases can expire deterministically. */
  advance(ms: number): void;
  /** The fake clock's current instant. */
  clock(): Date;
  /** Directly read a job for assertions. */
  peek(id: string): JobRow | undefined;
  /** All staged emit-outbox rows for a job, ordered by seq. */
  peekEmitBatches(jobId: string): EmitOutboxRow[];
  /** All staged asset-outbox rows for a job. */
  peekAssets(jobId: string): AssetOutboxRow[];
  /**
   * Arm a one-shot fault: after `skip` successful calls, the next call of
   * `method` throws `error` BEFORE it has any effect (a crash between writes).
   */
  failNext(method: keyof ExtractStore, error?: Error, skip?: number): void;
  /** The tenant daily vision-page counter for one UTC day (task 7.7). */
  peekVisionDailyUsage(tenantId: string, day: string): number;
}

/**
 * The 32-bit signed INTEGER maximum (2^31 − 1), used as the "effectively no
 * cap" default for the large-job lane parameters. Mirrors the real
 * `claimNextJobQuery` default so the fake store's lane accounting agrees with
 * the Postgres-backed query.
 */
const NO_LANE_CAP = 2_147_483_647;

export function createFakeJobStore(): FakeJobStore {
  let clock = Date.UTC(2026, 0, 1);
  const jobs = new Map<string, JobRow>();
  // stage rows keyed by unit → natural-key string
  const stages: Record<StageUnit, Map<string, PageStageRow>> = {
    page: new Map(),
    figure: new Map(),
    tile: new Map(),
  };
  const emitOutbox = new Map<string, EmitOutboxRow>();
  const assetOutbox = new Map<string, AssetOutboxRow>();
  // docpass_state rows keyed by `${jobId}|${page}`.
  const docpass = new Map<string, DocpassStateRow>();
  // Tenant daily vision-page counters keyed by `${tenantId}|${day}` (task 7.7).
  const visionDailyUsage = new Map<string, number>();
  const faults = new Map<string, { error: Error; skip: number }>();
  // Upload sessions and the erasure ledger (task 4.6): minimal models of the
  // real tables, faithful to the claim/transition protocol including expiry.
  const uploads = new Map<
    string,
    { upload_id: string; reference: string; status?: string; updatedAtMs?: number }
  >();
  const erasureLedger = new Map<
    string,
    {
      fingerprint: string;
      state: ErasureLedgerState;
      result?: unknown;
      expiresAtMs: number;
    }
  >();
  const ERASURE_TTL_MS = 86_400_000;

  const now = (): Date => new Date(clock);
  const unsupported = () => {
    throw new Error("not implemented in the fake job store");
  };

  function trip(method: string): void {
    const fault = faults.get(method);
    if (fault === undefined) return;
    if (fault.skip > 0) {
      fault.skip -= 1;
      return;
    }
    faults.delete(method);
    throw fault.error;
  }

  /** The SQL fence: holder AND epoch must still match. */
  function checkFence(fence: Fence | undefined): void {
    if (fence === undefined) return;
    const row = jobs.get(fence.jobId);
    if (
      row === undefined ||
      row.lease_holder !== fence.holder ||
      Number(row.lease_epoch) !== fence.epoch
    ) {
      throw new LeaseLostError(fence);
    }
  }

  function copy<T extends object>(row: T): T {
    return { ...row };
  }

  /** The job rows an erasure filter targets (mirrors erasureJobWhere). */
  function targetedJobs(filter: ErasureJobTargetFilter): JobRow[] {
    switch (filter.scope) {
      case "subject":
        return [...jobs.values()].filter(
          (j) =>
            j.created_by_tenant === filter.tenantId &&
            j.created_by_subject !== null &&
            j.created_by_subject !== undefined &&
            filter.identifiers.includes(j.created_by_subject),
        );
      case "tenant":
        return [...jobs.values()].filter(
          (j) => j.created_by_tenant === filter.tenantId,
        );
      case "reference":
        return [...jobs.values()].filter((j) =>
          filter.references.includes(j.reference),
        );
    }
  }

  function targetRow(job: JobRow): ErasureJobTargetRow {
    return {
      id: job.id,
      reference: job.reference,
      source_sha256: job.source_sha256,
    };
  }

  /** Delete job rows with the FK `ON DELETE CASCADE` of the stage/outbox tables. */
  function dropJobs(targets: JobRow[]): ErasureJobTargetRow[] {
    for (const job of targets) {
      jobs.delete(job.id);
      for (const unit of Object.keys(stages) as StageUnit[]) {
        for (const key of [...stages[unit].keys()]) {
          if (key.startsWith(`${job.id}|`)) stages[unit].delete(key);
        }
      }
      for (const key of [...emitOutbox.keys()]) {
        if (emitOutbox.get(key)?.job_id === job.id) emitOutbox.delete(key);
      }
      for (const key of [...assetOutbox.keys()]) {
        if (assetOutbox.get(key)?.job_id === job.id) assetOutbox.delete(key);
      }
      for (const key of [...docpass.keys()]) {
        if (key.startsWith(`${job.id}|`)) docpass.delete(key);
      }
    }
    return targets.map(targetRow);
  }
  function stageKey(
    unit: StageUnit,
    r: {
      job_id: string;
      page: number;
      stage: string;
      figure_id?: string;
      tile_id?: string;
    },
  ): string {
    if (unit === "figure")
      return `${r.job_id}|${r.page}|${r.figure_id}|${r.stage}`;
    if (unit === "tile") return `${r.job_id}|${r.page}|${r.tile_id}|${r.stage}`;
    return `${r.job_id}|${r.page}|${r.stage}`;
  }

  function upsert(unit: StageUnit, r: StageUpsert): PageStageRow {
    const key = stageKey(unit, r);
    const existing = stages[unit].get(key);
    const t = now();
    const row: PageStageRow = {
      job_id: r.job_id,
      page: r.page,
      stage: r.stage,
      ...(r.figure_id !== undefined ? { figure_id: r.figure_id } : {}),
      ...(r.tile_id !== undefined ? { tile_id: r.tile_id } : {}),
      input_hash: r.input_hash,
      status: (r.status ?? "pending") as StageStatus,
      // Round-trip through JSON like the jsonb column does.
      output:
        r.output === undefined || r.output === null
          ? null
          : JSON.parse(JSON.stringify(r.output)),
      attempts: existing ? existing.attempts + 1 : (r.attempts ?? 0),
      next_attempt_at: r.next_attempt_at ?? null,
      error: r.error ?? null,
      created_at: existing?.created_at ?? t,
      updated_at: t,
    };
    stages[unit].set(key, row);
    return copy(row);
  }

  function updateJob(
    id: string,
    fence: Fence | undefined,
    patch: (row: JobRow) => void,
  ): JobRow | null {
    const row = jobs.get(id);
    if (row === undefined) {
      if (fence !== undefined) throw new LeaseLostError(fence);
      return null;
    }
    checkFence(fence);
    patch(row);
    row.updated_at = now();
    return copy(row);
  }

  function revoke(row: JobRow): void {
    row.lease_epoch = Number(row.lease_epoch) + 1;
    row.lease_holder = null;
    row.lease_expires_at = null;
    row.tokens_reserved = 0;
  }

  function stageRowsOf(jobId: string): PageStageRow[] {
    return [
      ...stages.page.values(),
      ...stages.figure.values(),
      ...stages.tile.values(),
    ].filter((s) => s.job_id === jobId);
  }

  function resetPageStages(
    jobId: string,
    names: string[],
    match: (page: number) => boolean,
  ): void {
    for (const row of stages.page.values()) {
      if (
        row.job_id !== jobId ||
        !names.includes(row.stage) ||
        !match(row.page)
      )
        continue;
      row.status = "pending";
      row.output = null;
      row.next_attempt_at = null;
      row.error = null;
      row.updated_at = now();
    }
  }

  function bumpGeneration(jobId: string): void {
    const row = jobs.get(jobId);
    if (row === undefined) return;
    row.emit_generation = Number(row.emit_generation) + 1;
    row.revision_id = null;
    for (const e of emitOutbox.values())
      if (e.job_id === jobId) e.status = "pending";
    for (const a of assetOutbox.values())
      if (a.job_id === jobId) a.status = "pending";
  }

  function emitRowsOf(jobId: string): EmitOutboxRow[] {
    return [...emitOutbox.values()]
      .filter((r) => r.job_id === jobId)
      .sort((a, b) => a.seq - b.seq);
  }

  const store: FakeJobStore = {
    advance(ms) {
      clock += ms;
    },
    clock: now,
    peek(id) {
      return jobs.get(id);
    },
    peekEmitBatches(jobId) {
      return emitRowsOf(jobId).map(copy);
    },
    peekAssets(jobId) {
      return [...assetOutbox.values()]
        .filter((r) => r.job_id === jobId)
        .map(copy);
    },
    failNext(
      method,
      error = new Error(`simulated crash in ${String(method)}`),
      skip = 0,
    ) {
      faults.set(String(method), { error, skip });
    },

    init: async () => {},
    ping: async () => true,

    async createJob(job: NewJob) {
      const t = now();
      const row: JobRow = {
        id: job.id,
        reference: job.reference,
        status: job.status ?? "queued",
        pause_reason: null,
        config: job.config ?? {},
        pipeline_hash: job.pipeline_hash ?? null,
        prompt_hash: job.prompt_hash ?? null,
        resume_policy: job.resume_policy ?? "pin",
        visibility: job.visibility ?? "progressive",
        priority: job.priority ?? 0,
        token_budget: job.token_budget ?? null,
        tokens_used: 0,
        tokens_reserved: 0,
        emit_generation: 0,
        auto_resume: false,
        cost_usd: 0,
        page_count: null,
        source_sha256: job.source_sha256,
        collection: job.collection ?? null,
        revision_id: null,
        callback_url: job.callback_url ?? null,
        created_by_subject: job.created_by_subject ?? null,
        created_by_tenant: job.created_by_tenant ?? null,
        warnings: [],
        lease_holder: null,
        lease_epoch: 0,
        lease_expires_at: null,
        heartbeat_at: null,
        next_attempt_at: t,
        created_at: t,
        updated_at: t,
      };
      jobs.set(row.id, row);
      return copy(row);
    },

    async getJob(id) {
      const row = jobs.get(id);
      return row ? copy(row) : null;
    },

    async knownEmailMessageIds(collection, messageIds) {
      const wanted = new Set(messageIds);
      const known = new Set<string>();
      for (const row of jobs.values()) {
        if (row.collection !== collection || row.status === "failed") continue;
        const email = (row.config as { email?: { messageId?: unknown } }).email;
        if (typeof email?.messageId === "string" && wanted.has(email.messageId))
          known.add(email.messageId);
      }
      return known;
    },

    async listJobs(limit, offset) {
      return [...jobs.values()]
        .sort(
          (a, b) =>
            b.created_at.getTime() - a.created_at.getTime() ||
            (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        )
        .slice(offset, offset + limit)
        .map(copy);
    },

    async sourceDigestsByReference(
      reference,
      collection,
      includeNullCollection = false,
    ) {
      return [
        ...new Set(
          [...jobs.values()]
            .filter(
              (row) =>
                row.reference === reference &&
                (row.collection === collection ||
                  (includeNullCollection && row.collection === null)),
            )
            .map((row) => row.source_sha256)
            .filter((digest) => digest !== ""),
        ),
      ];
    },
    async listActiveJobsByReference(
      reference,
      collection,
      includeNullCollection = false,
    ) {
      return [...jobs.values()]
        .filter(
          (row) =>
            row.reference === reference &&
            (row.collection === collection ||
              (includeNullCollection && row.collection === null)) &&
            row.status !== "completed" &&
            row.status !== "failed" &&
            row.status !== "cancelled",
        )
        .map(copy);
    },

    async setJobStatus(id, status, pauseReason = null, fence) {
      trip("setJobStatus");
      return updateJob(id, fence, (row) => {
        row.status = status;
        row.pause_reason = pauseReason;
        row.auto_resume = false;
      });
    },

    async pauseJob(id, reason, autoResumeAt, configPatch = {}, fence) {
      return updateJob(id, fence, (row) => {
        row.status = "paused";
        row.pause_reason = reason;
        row.auto_resume = autoResumeAt !== null;
        if (autoResumeAt !== null) row.next_attempt_at = autoResumeAt;
        row.config = { ...row.config, ...configPatch };
      });
    },

    async setJobPageCount(id, pageCount, fence) {
      return updateJob(id, fence, (row) => {
        row.page_count = pageCount;
      });
    },

    async setJobRevision(id, revisionId, fence) {
      return updateJob(id, fence, (row) => {
        row.revision_id = revisionId;
      });
    },

    async setJobReference(id, reference, fence) {
      return updateJob(id, fence, (row) => {
        row.reference = reference;
      });
    },

    async consumeJobTokens(id, tokens, fence) {
      return updateJob(id, fence, (row) => {
        row.tokens_used = Number(row.tokens_used) + tokens;
      });
    },

    async reserveJobTokens(id, tokens, fence) {
      checkFence(fence);
      const row = jobs.get(id);
      if (row === undefined) return null;
      if (
        row.token_budget !== null &&
        Number(row.token_budget) -
          Number(row.tokens_used) -
          Number(row.tokens_reserved) <
          tokens
      ) {
        return null;
      }
      row.tokens_reserved = Number(row.tokens_reserved) + tokens;
      row.updated_at = now();
      return copy(row);
    },

    async settleJobTokens(id, settlement, fence) {
      return updateJob(id, fence, (row) => {
        row.tokens_reserved = Math.max(
          0,
          Number(row.tokens_reserved) - settlement.reserved,
        );
        row.tokens_used = Number(row.tokens_used) + settlement.used;
      });
    },

    async consumeVisionDailyPages(tenantId, day, pages, limit) {
      // Mirrors the SQL upsert: the increment lands only when the new total
      // stays within `limit`; a refusal leaves the counter unchanged.
      const key = `${tenantId}|${day}`;
      const current = visionDailyUsage.get(key) ?? 0;
      if (current + pages > limit) return null;
      const next = current + pages;
      visionDailyUsage.set(key, next);
      return next;
    },

    async patchJobConfig(id, patch, fence) {
      return updateJob(id, fence, (row) => {
        row.config = { ...row.config, ...patch };
      });
    },

    async appendJobWarning(id, warning, fence) {
      return updateJob(id, fence, (row) => {
        row.warnings = [...row.warnings, warning];
      });
    },

    async requeueJob(id) {
      return updateJob(id, undefined, (row) => {
        row.status = "queued";
        row.pause_reason = null;
        row.auto_resume = false;
        row.next_attempt_at = now();
        revoke(row);
      });
    },

    async operatorTransition(id, t) {
      const row = jobs.get(id);
      if (row === undefined || row.status !== t.expectedStatus) return null;
      row.status = t.status;
      row.pause_reason = t.pauseReason;
      row.auto_resume = false;
      row.config = { ...row.config, ...(t.configPatch ?? {}) };
      if (t.resumePolicy !== undefined) row.resume_policy = t.resumePolicy;
      if (t.status === "queued") row.next_attempt_at = now();
      revoke(row);
      row.updated_at = now();
      return copy(row);
    },

    async retryFailedUnits(id, expectedStatus, downstream) {
      const row = jobs.get(id);
      if (row === undefined || row.status !== expectedStatus) return null;
      const pages = new Set<number>();
      let reset = 0;
      for (const unit of ["page", "figure", "tile"] as const) {
        for (const s of stages[unit].values()) {
          if (s.job_id !== id || s.status !== "failed") continue;
          s.status = "pending";
          s.next_attempt_at = now();
          s.error = null;
          s.updated_at = now();
          pages.add(s.page);
          reset += 1;
        }
      }
      if (pages.size > 0) {
        const first = Math.min(...pages);
        resetPageStages(
          id,
          [...downstream.cropStages, downstream.emitStage],
          (p) => pages.has(p),
        );
        resetPageStages(
          id,
          [downstream.emitStage, downstream.docpassStage],
          (p) => p >= first,
        );
        for (const [k, d] of docpass)
          if (d.job_id === id && d.page >= first) docpass.delete(k);
        bumpGeneration(id);
      }
      row.status = "queued";
      row.pause_reason = null;
      row.auto_resume = false;
      row.next_attempt_at = now();
      revoke(row);
      row.updated_at = now();
      return { job: copy(row), reset };
    },

    async claimNextJob(
      leaseHolder,
      leaseSeconds,
      largeJobPageThreshold = NO_LANE_CAP,
      largeJobMaxConcurrency = NO_LANE_CAP,
    ) {
      const t = clock;
      const isWorking = (j: JobRow): boolean =>
        ["preparing", "processing", "emitting", "committing"].includes(
          j.status,
        );
      const isLarge = (j: JobRow): boolean =>
        j.page_count !== null && j.page_count > largeJobPageThreshold;
      const activeLarge = [...jobs.values()].filter(
        (j) =>
          isWorking(j) &&
          j.lease_expires_at !== null &&
          j.lease_expires_at.getTime() > t &&
          isLarge(j),
      ).length;
      const largeLaneFull = activeLarge >= largeJobMaxConcurrency;
      // Runnable: queued and due, auto-resumable paused and due, OR working with
      // an expired lease (takeover).
      const candidates = [...jobs.values()].filter((j) => {
        const due = j.next_attempt_at.getTime() <= t;
        const runnable =
          (j.status === "queued" && due) ||
          (j.status === "paused" && j.auto_resume && due) ||
          (isWorking(j) &&
            j.lease_expires_at !== null &&
            j.lease_expires_at.getTime() <= t);
        if (!runnable) return false;
        if (isLarge(j) && largeLaneFull) return false;
        return true;
      });
      candidates.sort(
        (a, b) =>
          b.priority - a.priority ||
          a.next_attempt_at.getTime() - b.next_attempt_at.getTime() ||
          a.created_at.getTime() - b.created_at.getTime() ||
          a.id.localeCompare(b.id),
      );
      const job = candidates[0];
      if (job === undefined) return null;
      job.lease_holder = leaseHolder;
      job.lease_epoch = Number(job.lease_epoch) + 1;
      job.lease_expires_at = new Date(t + leaseSeconds * 1000);
      job.heartbeat_at = now();
      job.tokens_reserved = 0;
      if (job.status === "paused") {
        job.status = "queued";
        job.pause_reason = null;
      }
      job.auto_resume = false;
      job.updated_at = now();
      return copy(job);
    },

    async heartbeat(id, leaseHolder, epoch, leaseSeconds) {
      const row = jobs.get(id);
      if (row === undefined) return null;
      // Fencing: only the current holder+epoch may renew.
      if (row.lease_holder !== leaseHolder || Number(row.lease_epoch) !== epoch)
        return null;
      row.lease_expires_at = new Date(clock + leaseSeconds * 1000);
      row.heartbeat_at = now();
      row.updated_at = now();
      return copy(row);
    },

    async getStage(unit, key) {
      const row = stages[unit].get(stageKey(unit, key));
      return row ? copy(row) : null;
    },

    async upsertStage(unit: StageUnit, r: StageUpsert, fence) {
      trip("upsertStage");
      checkFence(fence);
      return upsert(unit, r);
    },

    async completeStage(unit, r, fence, settlement) {
      trip("completeStage");
      checkFence(fence);
      const stage = upsert(unit, r);
      let job: JobRow | null = null;
      if (settlement !== undefined) {
        const row = jobs.get(r.job_id);
        if (row !== undefined) {
          row.tokens_reserved = Math.max(
            0,
            Number(row.tokens_reserved) - settlement.reserved,
          );
          row.tokens_used = Number(row.tokens_used) + settlement.used;
          row.updated_at = now();
          job = copy(row);
        }
      }
      return { stage, job };
    },

    async listStagesByStatus(unit, jobId, status) {
      return [...stages[unit].values()]
        .filter((s) => s.job_id === jobId && s.status === status)
        .sort((a, b) => a.page - b.page)
        .map(copy);
    },

    async listStagesWindow(unit, jobId, stage, fromPage, toPage) {
      return [...stages[unit].values()]
        .filter(
          (s) =>
            s.job_id === jobId &&
            s.stage === stage &&
            s.page >= fromPage &&
            s.page <= toPage,
        )
        .sort((a, b) => a.page - b.page)
        .map(copy);
    },

    async nextRunnablePages(
      jobId,
      pageCount,
      cursorStage,
      limit,
      when = now(),
      firstPage = 1,
    ) {
      if (pageCount < firstPage || limit <= 0) return [];
      const t = when.getTime();
      // Pages with any unit inside a transient-failure backoff are not due.
      const backingOff = new Set<number>();
      for (const s of stageRowsOf(jobId)) {
        if (
          s.status === "failed" &&
          s.next_attempt_at !== null &&
          s.next_attempt_at.getTime() > t
        ) {
          backingOff.add(s.page);
        }
      }
      const out: number[] = [];
      for (let page = firstPage; page <= pageCount && out.length < limit; page++) {
        if (backingOff.has(page)) continue;
        const row = stages.page.get(
          stageKey("page", { job_id: jobId, page, stage: cursorStage }),
        );
        if (row === undefined) {
          out.push(page);
          continue;
        }
        if (row.status === "done") continue;
        // Permanently failed (no retry scheduled): finished, skip so it never
        // blocks the pages behind it.
        if (row.status === "failed" && row.next_attempt_at === null) continue;
        if (
          row.status === "failed" ||
          row.next_attempt_at === null ||
          row.next_attempt_at.getTime() <= t
        ) {
          out.push(page);
        }
      }
      return out;
    },

    async earliestRetryAt(jobId, when = now()) {
      let min: number | null = null;
      for (const s of stageRowsOf(jobId)) {
        if (s.status !== "failed" || s.next_attempt_at === null) continue;
        const at = s.next_attempt_at.getTime();
        if (at > when.getTime() && (min === null || at < min)) min = at;
      }
      return min === null ? null : new Date(min);
    },

    async finishedPageCount(jobId, cursorStage) {
      let count = 0;
      for (const row of stages.page.values()) {
        if (row.job_id !== jobId || row.stage !== cursorStage) continue;
        if (
          row.status === "done" ||
          (row.status === "failed" && row.next_attempt_at === null)
        ) {
          count += 1;
        }
      }
      return count;
    },

    async invalidateDownstream(jobId, inv, fence) {
      checkFence(fence);
      resetPageStages(jobId, inv.stages, (p) => p >= inv.fromPage);
      for (const [k, d] of docpass)
        if (d.job_id === jobId && d.page >= inv.fromPage) docpass.delete(k);
      for (const [k, e] of emitOutbox)
        if (e.job_id === jobId && e.seq >= inv.fromPage) emitOutbox.delete(k);
      if (inv.deleteAssets) {
        for (const [k, a] of assetOutbox)
          if (a.job_id === jobId) assetOutbox.delete(k);
      }
      bumpGeneration(jobId);
      const row = jobs.get(jobId);
      if (row === undefined) return null;
      if (inv.configPatch !== undefined)
        row.config = { ...row.config, ...inv.configPatch };
      return copy(row);
    },

    async saveDocpassState(jobId, page, state, fence) {
      trip("saveDocpassState");
      checkFence(fence);
      docpass.set(`${jobId}|${page}`, {
        job_id: jobId,
        page,
        state: JSON.parse(JSON.stringify(state ?? null)),
        created_at: now(),
        updated_at: now(),
      });
    },
    async latestDocpassState(jobId) {
      const rows = [...docpass.values()]
        .filter((r) => r.job_id === jobId)
        .sort((a, b) => b.page - a.page);
      return rows[0] ? copy(rows[0]) : null;
    },

    async commitDocpassPage(jobId, commit, fence) {
      // One transaction: the fault fires before anything is written.
      trip("commitDocpassPage");
      checkFence(fence);
      if (commit.payload !== null) {
        const row = emitOutbox.get(`${jobId}|${commit.page}`);
        if (row !== undefined) {
          row.payload = JSON.parse(JSON.stringify(commit.payload));
          row.digest = `sha-${JSON.stringify(commit.payload).length}`;
          row.updated_at = now();
        }
      }
      docpass.set(`${jobId}|${commit.page}`, {
        job_id: jobId,
        page: commit.page,
        state: JSON.parse(JSON.stringify(commit.state ?? null)),
        created_at: now(),
        updated_at: now(),
      });
      upsert("page", commit.checkpoint);
    },

    async stageEmitBatch(row, fence) {
      trip("stageEmitBatch");
      checkFence(fence);
      const k = `${row.job_id}|${row.seq}`;
      const existing = emitOutbox.get(k);
      const payload =
        row.payload === undefined
          ? null
          : JSON.parse(JSON.stringify(row.payload));
      if (existing !== undefined) {
        // Upsert unless acked or unchanged.
        if (existing.status === "acked" || existing.digest === row.digest)
          return null;
        existing.digest = row.digest;
        existing.payload = payload;
        existing.page_from = row.page_from;
        existing.page_to = row.page_to;
        existing.status = "pending";
        existing.updated_at = now();
        return copy(existing);
      }
      const t = now();
      const created: EmitOutboxRow = {
        job_id: row.job_id,
        seq: row.seq,
        digest: row.digest,
        page_from: row.page_from,
        page_to: row.page_to,
        status: "pending",
        payload,
        payload_ref: row.payload_ref ?? null,
        attempts: 0,
        next_attempt_at: null,
        error: null,
        created_at: t,
        updated_at: t,
      };
      emitOutbox.set(k, created);
      return copy(created);
    },

    async setEmitStatus(jobId, seq, status, fence) {
      checkFence(fence);
      const row = emitOutbox.get(`${jobId}|${seq}`);
      if (row === undefined) return null;
      row.status = status;
      row.updated_at = now();
      return copy(row);
    },

    async updateEmitPayload(jobId, seq, payload, fence) {
      trip("updateEmitPayload");
      checkFence(fence);
      const row = emitOutbox.get(`${jobId}|${seq}`);
      if (row === undefined) return null;
      row.payload = payload ?? null;
      row.digest = `sha-${JSON.stringify(payload).length}`;
      row.updated_at = now();
      return copy(row);
    },

    async getEmitBatch(jobId, seq) {
      const row = emitOutbox.get(`${jobId}|${seq}`);
      return row ? copy(row) : null;
    },

    async listEmitBatchMeta(jobId) {
      return emitRowsOf(jobId).map((r) => ({ ...r, payload: null }));
    },

    async emitBatchesInRange(jobId, fromSeq, toSeq) {
      return emitRowsOf(jobId)
        .filter((r) => r.seq >= fromSeq && r.seq <= toSeq)
        .map(copy);
    },

    async pendingEmitBatches(jobId) {
      return emitRowsOf(jobId)
        .filter((r) => r.status !== "acked")
        .map(copy);
    },

    async allEmitBatches(jobId) {
      return emitRowsOf(jobId).map(copy);
    },

    async resetEmitGeneration(jobId, fence) {
      checkFence(fence);
      bumpGeneration(jobId);
      const row = jobs.get(jobId);
      return row ? copy(row) : null;
    },

    async stageAsset(row, fence) {
      checkFence(fence);
      const k = `${row.job_id}|${row.asset_id}`;
      const existing = assetOutbox.get(k);
      if (existing !== undefined) {
        if (
          (existing.page === undefined || existing.page === null) &&
          row.page != null
        ) {
          existing.page = row.page;
          return copy(existing);
        }
        return null; // ON CONFLICT DO NOTHING
      }
      const t = now();
      const created: AssetOutboxRow = {
        job_id: row.job_id,
        asset_id: row.asset_id,
        page: row.page ?? null,
        status: "pending",
        checksum: row.checksum ?? null,
        variant: row.variant ?? null,
        mime_type: row.mime_type ?? null,
        attempts: 0,
        next_attempt_at: null,
        error: null,
        created_at: t,
        updated_at: t,
      };
      assetOutbox.set(k, created);
      return copy(created);
    },

    async setAssetStatus(jobId, assetId, status, fence) {
      checkFence(fence);
      const row = assetOutbox.get(`${jobId}|${assetId}`);
      if (row === undefined) return null;
      row.status = status;
      row.updated_at = now();
      return copy(row);
    },

    async allAssets(jobId) {
      return [...assetOutbox.values()]
        .filter((r) => r.job_id === jobId)
        .sort((a, b) => a.asset_id.localeCompare(b.asset_id))
        .map(copy);
    },

    createUpload: unsupported,
    getUpload: unsupported,
    updateUploadOffset: unsupported,
    advanceUploadOffset: unsupported,

    // ── erasure (task 4.6) ────────────────────────────────────────────────
    async erasureJobTargets(filter) {
      return targetedJobs(filter).map(targetRow);
    },
    async erasureJobCount(filter) {
      return targetedJobs(filter).length;
    },
    async eraseJobs(filter) {
      trip("eraseJobs");
      return dropJobs(targetedJobs(filter));
    },
    async eraseJobsByReference(reference, collection, includeNullCollection = false) {
      trip("eraseJobsByReference");
      return dropJobs(
        [...jobs.values()].filter(
          (row) =>
            row.reference === reference &&
            (row.collection === collection ||
              (includeNullCollection && row.collection === null)),
        ),
      );
    },
    async deleteExpiredJobs(days, limit) {
      trip("deleteExpiredJobs");
      const cutoff = clock - days * 86_400_000;
      return dropJobs(
        [...jobs.values()]
          .filter(
            (row) =>
              ["completed", "failed", "cancelled"].includes(row.status) &&
              new Date(row.updated_at).getTime() < cutoff,
          )
          .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
          .slice(0, limit),
      );
    },
    async deleteExpiredUploads(hours, limit) {
      const cutoff = clock - hours * 3_600_000;
      const removed: string[] = [];
      for (const [id, row] of [...uploads.entries()]) {
        if (removed.length >= limit) break;
        if (row.status === "open" && (row.updatedAtMs ?? clock) < cutoff) {
          uploads.delete(id);
          removed.push(id);
        }
      }
      return removed;
    },
    async eraseUploadsByReferences(references) {
      if (references.length === 0) return [];
      const removed: string[] = [];
      for (const [id, row] of [...uploads.entries()]) {
        if (references.includes(row.reference)) {
          uploads.delete(id);
          removed.push(id);
        }
      }
      return removed;
    },
    async eraseAllUploads() {
      const removed = [...uploads.keys()];
      uploads.clear();
      return removed;
    },
    async countAllUploads() {
      return uploads.size;
    },
    async uploadsByReferences(references) {
      if (references.length === 0) return [];
      return [...uploads.values()]
        .filter((u) => references.includes(u.reference))
        .map((u) => ({ ...u }));
    },
    async remainingSourceRefs(digests) {
      if (digests.length === 0) return [];
      const counts = new Map<string, number>();
      for (const job of jobs.values()) {
        if (digests.includes(job.source_sha256)) {
          counts.set(
            job.source_sha256,
            (counts.get(job.source_sha256) ?? 0) + 1,
          );
        }
      }
      return [...counts.entries()].map(([source_sha256, n]) => ({
        source_sha256,
        n,
      }));
    },
    async claimErasure(key, fingerprint) {
      trip("claimErasure");
      const existing = erasureLedger.get(key);
      if (existing === undefined || existing.expiresAtMs <= clock) {
        // INSERT / expired-row takeover — the claim wins.
        erasureLedger.set(key, {
          fingerprint,
          state: "pending",
          expiresAtMs: clock + ERASURE_TTL_MS,
        });
        return {
          kind: "claimed",
          record: {
            key,
            fingerprint,
            state: "pending",
            updatedAt: now().toISOString(),
          },
        };
      }
      if (existing.fingerprint !== fingerprint) {
        return { kind: "mismatch", record: ledgerRecord(key, existing) };
      }
      if (existing.state === "committed") {
        return { kind: "replay", record: ledgerRecord(key, existing) };
      }
      if (existing.state === "pending" || existing.state === "running") {
        return { kind: "in_flight", record: ledgerRecord(key, existing) };
      }
      return { kind: "terminal", record: ledgerRecord(key, existing) };
    },
    async transitionErasure(key, fingerprint, state, result) {
      trip("transitionErasure");
      const existing = erasureLedger.get(key);
      if (
        existing === undefined ||
        existing.fingerprint !== fingerprint ||
        (existing.state !== "pending" && existing.state !== "running")
      ) {
        throw new Error("Erasure ledger transition conflict");
      }
      existing.state = state;
      if (result !== undefined) existing.result = result;
      existing.expiresAtMs = clock + ERASURE_TTL_MS;
    },

    seedUpload(uploadId, reference, status) {
      uploads.set(uploadId, {
        upload_id: uploadId,
        reference,
        ...(status !== undefined ? { status } : {}),
        updatedAtMs: clock,
      });
    },
    peekUploads() {
      return [...uploads.values()].map((u) => ({
        upload_id: u.upload_id,
        reference: u.reference,
      }));
    },
    peekErasureLedger(key) {
      const row = erasureLedger.get(key);
      return row === undefined ? undefined : ledgerRecord(key, row);
    },
    peekVisionDailyUsage(tenantId, day) {
      return visionDailyUsage.get(`${tenantId}|${day}`) ?? 0;
    },

    withTransaction: unsupported,
    close: async () => {},
  };
  return store;
}

function ledgerRecord(
  key: string,
  row: { fingerprint: string; state: ErasureLedgerState; result?: unknown },
): ErasureLedgerRecord {
  return {
    key,
    fingerprint: row.fingerprint,
    state: row.state,
    ...(row.result !== undefined ? { result: row.result } : {}),
    updatedAt: new Date().toISOString(),
  };
}
