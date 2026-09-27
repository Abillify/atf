// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * types.ts
 *
 * Row shapes for the extract persistence layer.
 *
 * The status/reason/policy/visibility vocabularies are imported straight from
 * `@atf/extract-contract/v2` so the database representation and the wire
 * contract cannot drift: if the contract adds a job status, this file fails to
 * compile until the DB layer acknowledges it.
 */

import type {
  JobStatus,
  PauseReason,
  ResumePolicy,
  Visibility,
} from "@atf/extract-contract/v2";

/** Which stage table a checkpoint lives in. */
export type StageUnit = "page" | "figure" | "tile";

/** Lifecycle of a single stage checkpoint. */
export type StageStatus = "pending" | "running" | "done" | "failed";

/** Lifecycle of an outbox row: staged, sent, acknowledged by Search. */
export type OutboxStatus = "pending" | "sent" | "acked" | "failed";

/**
 * The lease fencing token a worker presents with every persistent write
 * (design §9b.2, requirement 4.5). The store executes a fenced write only when
 * `extract.jobs` still carries `lease_holder = holder AND lease_epoch = epoch`,
 * checked in SQL inside the same transaction as the write — so the check and
 * the act cannot be separated by a takeover or an operator action.
 */
export interface Fence {
  jobId: string;
  holder: string;
  epoch: number;
}

/**
 * Raised when a fenced write is attempted after the lease was lost: another
 * worker took the job over (the claim bumped the epoch) or an operator paused,
 * cancelled or re-queued it (operator actions bump the epoch too). Defined in
 * the persistence layer because the store raises it; `jobs/lease.ts`
 * re-exports it for the worker-facing API.
 */
export class LeaseLostError extends Error {
  readonly jobId: string;
  readonly holder: string;
  readonly epoch: number;
  constructor(token: Fence) {
    super(
      `Lease lost for job ${token.jobId}: epoch ${token.epoch} held by ${token.holder} is no longer current`,
    );
    this.name = "LeaseLostError";
    this.jobId = token.jobId;
    this.holder = token.holder;
    this.epoch = token.epoch;
  }
}

/**
 * Token accounting folded into a checkpoint transaction (requirement 4.9): the
 * reservation taken before the model call is released and the actual spend is
 * booked in the same transaction that persists the stage result, so a crash
 * can never record the checkpoint without its cost (or vice versa).
 */
export interface TokenSettlement {
  /** Tokens reserved before the call; released by this settlement. */
  reserved: number;
  /** Tokens actually consumed; added to `tokens_used`. */
  used: number;
}

/**
 * What an invalidation of the downstream stages resets (reparse, restart-stage,
 * retry-failed). Everything happens in one fenced transaction so a crash never
 * leaves a half-invalidated job.
 */
export interface DownstreamInvalidation {
  /** Pages at or after this one have their listed page stages reset. */
  fromPage: number;
  /** Page-stage names reset to `pending` (e.g. crops, emitted, docpass). */
  stages: string[];
  /**
   * Delete the asset-outbox rows (they are re-staged by the re-driven crop and
   * tile stages). When false they are only moved back to `pending`.
   */
  deleteAssets: boolean;
  /** Merged into the job's config in the same transaction (e.g. reparse=false). */
  configPatch?: Record<string, unknown>;
}

/** An operator action's effect on the job row (pause, cancel, resume, requeue). */
export interface OperatorTransition {
  /** The status the handler read; the update only applies if it is unchanged. */
  expectedStatus: JobStatus;
  status: JobStatus;
  pauseReason: PauseReason | null;
  /** Merged into the job's config (e.g. `{ reparse: true }`). */
  configPatch?: Record<string, unknown>;
  /** Optionally switch the resume policy (e.g. resume with `continue`). */
  resumePolicy?: ResumePolicy;
}

/**
 * A row in `extract.jobs`. `snake_case` throughout because it maps 1:1 onto the
 * table; the API layer (task 1.5) is responsible for translating to the
 * camelCase `Job` contract type.
 */
export interface JobRow {
  id: string;
  reference: string;
  status: JobStatus;
  pause_reason: PauseReason | null;
  config: Record<string, unknown>;
  pipeline_hash: string | null;
  prompt_hash: string | null;
  resume_policy: ResumePolicy;
  visibility: Visibility;
  priority: number;
  token_budget: number | null;
  tokens_used: number;
  /**
   * Tokens reserved by in-flight model calls (schema v2). Reserved atomically
   * before a call and released when it settles, so concurrent pages cannot
   * overdraw the budget. Reset on every claim: a new holder owns no calls.
   */
  tokens_reserved: number;
  /**
   * The emit generation (schema v2). Bumped when the revision content must be
   * rebuilt (reparse, restart-stage, retry-failed, digest conflict); the
   * emitter's Idempotency-Key includes it, so a new generation opens a new
   * revision instead of colliding with a committed one.
   */
  emit_generation: number;
  /**
   * True when a `paused(dependency)` job is picked up again automatically by
   * the claim once `next_attempt_at` is due (schema v2). Budget, manual and
   * pin pauses leave it false and wait for an operator.
   */
  auto_resume: boolean;
  cost_usd: number;
  page_count: number | null;
  source_sha256: string;
  collection: string | null;
  revision_id: string | null;
  callback_url: string | null;
  warnings: string[];
  lease_holder: string | null;
  lease_epoch: number;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  next_attempt_at: Date;
  created_at: Date;
  updated_at: Date;
}

/** The fields a caller supplies to create a job; the rest take DB defaults. */
export interface NewJob {
  id: string;
  reference: string;
  source_sha256: string;
  status?: JobStatus;
  config?: Record<string, unknown>;
  pipeline_hash?: string | null;
  prompt_hash?: string | null;
  resume_policy?: ResumePolicy;
  visibility?: Visibility;
  priority?: number;
  token_budget?: number | null;
  collection?: string | null;
  callback_url?: string | null;
}

/** A row in one of the `*_stages` tables. */
export interface PageStageRow {
  job_id: string;
  page: number;
  stage: string;
  figure_id?: string;
  tile_id?: string;
  input_hash: string;
  status: StageStatus;
  output: unknown;
  attempts: number;
  next_attempt_at: Date | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The payload for upserting a stage checkpoint. */
export interface StageUpsert {
  job_id: string;
  page: number;
  stage: string;
  /** Present for `figure` units. */
  figure_id?: string;
  /** Present for `tile` units. */
  tile_id?: string;
  input_hash: string;
  status?: StageStatus;
  output?: unknown;
  attempts?: number;
  next_attempt_at?: Date | null;
  error?: string | null;
}

/** A row in `extract.docpass_state`. */
export interface DocpassStateRow {
  job_id: string;
  page: number;
  state: unknown;
  created_at: Date;
  updated_at: Date;
}

/** A row in `extract.emit_outbox`. */
export interface EmitOutboxRow {
  job_id: string;
  seq: number;
  digest: string;
  page_from: number;
  page_to: number;
  status: OutboxStatus;
  payload: unknown;
  payload_ref: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A row in `extract.asset_outbox`. */
export interface AssetOutboxRow {
  job_id: string;
  asset_id: string;
  /**
   * The page the asset belongs to (schema v2), so the emitter and the crop
   * loader can resolve an asset without loading every page payload. Null for
   * rows staged before the column existed.
   */
  page?: number | null;
  status: OutboxStatus;
  checksum: string | null;
  variant: string | null;
  mime_type: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A row in `extract.uploads`. */
export interface UploadRow {
  upload_id: string;
  reference: string;
  expected_sha256: string | null;
  size: number | null;
  received_offset: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/** One chunk append to a resumable upload session (requirement 4.14). */
export interface UploadAppend {
  uploadId: string;
  /** The confirmed offset the chunk was validated against. */
  expectedOffset: number;
  /** The offset after the chunk (`expectedOffset + chunk length`). */
  newOffset: number;
  /**
   * Durably append the verified chunk to the session file at
   * `expectedOffset`. Runs only while the session row is locked and only when
   * the stored offset still equals `expectedOffset`. Must roll the file back
   * to `expectedOffset` itself when it fails.
   */
  append: () => Promise<void>;
}

export type UploadAppendResult =
  | { status: "committed"; row: UploadRow }
  /** The session moved on (or closed) meanwhile; `current` is its state now. */
  | { status: "conflict"; current: UploadRow | null };
