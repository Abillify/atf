// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/stage-runner.ts
 *
 * The stage-execution primitive (design §4.2 S2–S8, §9b.2; requirements 4.2,
 * 4.3, 4.6, 4.9, 4.10, 4.12).
 *
 * A "stage" is one unit of work on one unit of a document — render/text/vision/
 * parse on a page, pass-2 on a figure, transcription of a tile. Every stage
 * result is a checkpoint addressed by `(job, page, [figure|tile], stage,
 * input_hash)`. This module owns the small set of rules that make those
 * checkpoints resumable, idempotent and cheap to re-parse; it does NOT know
 * what any particular stage does.
 *
 * The guarantees this provides:
 *
 *   1. **Checkpoint reuse by input_hash** — `runStage` looks up the existing
 *      checkpoint first. A `done` row with the SAME `input_hash` is returned
 *      verbatim, and `fn` is never called (no model call, requirement 4.3). A
 *      run under `resume_policy=continue` / `restart-stage` may additionally
 *      reuse a `done` row whatever its hash, per stage, via
 *      {@link StageRunnerDeps.reuseDoneRegardlessOfHash} (requirement 4.12).
 *      A permanently `failed` row is replayed as failed, not recomputed — only
 *      `retry-failed` (which resets it to `pending`) runs it again.
 *
 *   2. **Backoff is honoured** — a unit in a transient-failure backoff
 *      (`failed` with `next_attempt_at` in the future) is not run early; the
 *      runner raises {@link StageNotDueError} without touching the row.
 *
 *   3. **A transient/permanent error taxonomy** — a stage's work throws
 *      {@link TransientStageError} (retry with backoff; the checkpoint stays
 *      retryable with `next_attempt_at` set) or {@link PermanentStageError}
 *      (the unit is marked `failed` with a warning and the job keeps going,
 *      requirement 4.10). An unclassified throw is transient — unless a model
 *      response was already received in this attempt, in which case the fault
 *      lies in deterministic post-processing, retrying would repeat the paid
 *      call, and the unit is failed permanently with the response kept.
 *
 *   4. **Raw responses are always persisted** — a stage that calls a model
 *      returns both the model's raw bytes and the parsed result, persisted under
 *      distinct keys. Model responses are also captured while `fn` runs (the
 *      runner's model clients call {@link recordModelResponse}), so a stage that
 *      FAILS after the model answered still persists the raw response.
 *      {@link StageRunner.reparse} re-applies a fixed parser to it with ZERO
 *      model calls (requirement 4.6).
 *
 *   5. **Atomic budget reservation** — before a stage that calls a model runs
 *      `fn`, its estimate is reserved atomically against the job's budget. An
 *      insufficient budget raises {@link BudgetExhaustedError} before any call
 *      (requirement 4.9). After the call the reservation is released and the
 *      actual spend booked — in the same transaction as the checkpoint write
 *      when the ledger supports it, so a crash never separates result and cost.
 *
 * Every persistent write carries the lease fence, so a zombie worker cannot
 * overwrite a taken-over (or cancelled) job's checkpoints. A model stage also
 * confirms the lease once right before its call, so a takeover or an operator
 * cancel/pause stops the next model call rather than only its write.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";
import type { ExtractStore } from "../persistence/index.js";
import {
  LeaseLostError,
  type JobRow,
  type PageStageRow,
  type StageUnit,
  type TokenSettlement,
} from "../persistence/types.js";
import type { StageKey } from "../persistence/extract-queries.js";
import type { LeaseGuard } from "./lease.js";
import type { PipelineSnapshot } from "./snapshot.js";

/**
 * The persisted shape of a stage checkpoint's `output` column. Keeping the raw
 * model response beside the parsed result is what makes {@link reparse}
 * possible: a parser fix re-runs `parse(raw)` without ever calling the model.
 *
 * `raw` is `null` for deterministic stages that call no model (they have
 * nothing to re-parse); `parsed` holds whatever the stage's parser produced
 * (`null` for a failed unit whose raw response was kept).
 */
export interface StageOutput<Parsed = unknown, Raw = unknown> {
  /** The model's unparsed response, or `null` for a model-free stage. */
  raw: Raw | null;
  /** The parsed, structured result of the stage. */
  parsed: Parsed;
  /**
   * The pipeline/prompt stand that produced this output (requirement 4.12).
   * Under `resume_policy=continue` a document mixes stands; this records which
   * one each unit came from.
   */
  stand?: PipelineSnapshot;
  /** Usage metadata of the captured response(s), kept for a failed unit. */
  response?: CapturedModelResponse;
}

/** True when a value looks like a persisted {@link StageOutput}. */
export function isStageOutput(value: unknown): value is StageOutput {
  return (
    typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    "parsed" in value
  );
}

/** A stage whose work reached a permanent, unit-level failure. */
export class PermanentStageError extends Error {
  /** A human-facing warning recorded on the job (requirement 4.10). */
  readonly warning: string;
  /**
   * The raw model response, when the failure happened after the model
   * answered (e.g. no parser could read it). Persisted for `reparse`.
   */
  readonly raw: string | undefined;
  constructor(message: string, warning?: string, raw?: string) {
    super(message);
    this.name = "PermanentStageError";
    this.warning = warning ?? message;
    this.raw = raw;
  }
}

/** A stage whose work failed transiently and should be retried with backoff. */
export class TransientStageError extends Error {
  /** Optional cause, preserved for logs. */
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TransientStageError";
    this.cause = cause;
  }
}

/**
 * Raised when a unit is still inside its backoff window. Nothing is written
 * and no model is called; the scheduler picks the unit up once it is due.
 */
export class StageNotDueError extends TransientStageError {
  readonly retryAt: Date;
  constructor(retryAt: Date) {
    super(`stage not due before ${retryAt.toISOString()}`);
    this.name = "StageNotDueError";
    this.retryAt = retryAt;
  }
}

/**
 * Raised by the budget guard when a stage that would call a model has no budget
 * left. The worker catches this and parks the job in `paused(reason=budget)`;
 * the stage's checkpoint is left untouched so the resume recomputes in place.
 */
export class BudgetExhaustedError extends Error {
  readonly needed: number;
  readonly remaining: number;
  constructor(needed: number, remaining: number) {
    super(`Token budget exhausted: needed ${needed}, ${remaining} remaining`);
    this.name = "BudgetExhaustedError";
    this.needed = needed;
    this.remaining = remaining;
  }
}

/**
 * The token-budget seam. `reserve()` atomically claims an estimate before a
 * model call and `release()` returns it; `consume()` books actual spend. A
 * ledger whose counters live on the job row sets {@link settleInCheckpoint}, and
 * the runner then releases + books in the SAME transaction as the checkpoint.
 *
 * `reserve`/`release` are optional for simple ledgers (tests); without them the
 * runner falls back to a `remaining()` check, which is not race-free.
 */
export interface BudgetLedger {
  /** Remaining tokens (budget − used − reserved), or `null` when uncapped. */
  remaining(): Promise<number | null>;
  /** Record `tokens` as spent after a successful model call. */
  consume(tokens: number): Promise<void>;
  /** Atomically reserve `tokens`; false when the budget cannot cover them. */
  reserve?(tokens: number): Promise<boolean>;
  /** Return a reservation that was not settled through a checkpoint. */
  release?(tokens: number): Promise<void>;
  /**
   * Present when the settlement can be folded into the checkpoint transaction.
   * `onSettled` receives the updated job row (for the 80 % warning).
   */
  settleInCheckpoint?: { onSettled(job: JobRow, used: number): Promise<void> };
}

/** A ledger that never limits and never records — for stages with no model. */
export const unlimitedBudget: BudgetLedger = {
  async remaining() {
    return null;
  },
  async consume() {
    /* no-op */
  },
  async reserve() {
    return true;
  },
  async release() {
    /* no-op */
  },
};

/** What a stage's `fn` produces: the raw model response and its parsed form. */
export interface StageWork<Parsed = unknown, Raw = unknown> {
  /** The model's raw response, or `null` for a deterministic stage. */
  raw: Raw | null;
  /** The parsed, structured result. */
  parsed: Parsed;
  /**
   * Tokens actually consumed by this stage's model call, recorded against the
   * budget after success. Omit or `0` for a model-free stage.
   */
  tokensUsed?: number;
}

/** The work a stage performs when its checkpoint must be (re)computed. */
export type StageFn<Parsed = unknown, Raw = unknown> = () => Promise<StageWork<Parsed, Raw>>;

/**
 * A parser re-applied to a persisted raw response by {@link reparse}. It may be
 * async (e.g. it re-renders the page deterministically to re-snap bboxes) and
 * receives the existing row for context. Returning `undefined` means the raw
 * response still cannot be parsed; the checkpoint is then left untouched.
 */
export type StageParser<Parsed = unknown, Raw = unknown> = (
  raw: Raw,
  existing: PageStageRow,
) => Parsed | undefined | Promise<Parsed | undefined>;

/** Tunables for the backoff applied to a transient failure's `next_attempt_at`. */
export interface BackoffPolicy {
  /** First retry delay in ms. */
  baseMs: number;
  /** The delay ceiling in ms; the exponential curve is clamped to it. */
  maxMs: number;
  /** Multiplier per attempt (2 = double each time). */
  factor: number;
}

/** A sensible default: 1s → 2s → 4s … capped at 5 minutes. */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 300_000,
  factor: 2,
};

/**
 * Compute the backoff delay (ms) for a given attempt number (1-based). The
 * curve is `base * factor^(attempt-1)`, clamped to `maxMs`. Deterministic (no
 * jitter) so tests can assert the exact `next_attempt_at`; the worker adds
 * jitter at the poll layer, not here.
 */
export function backoffMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = policy.baseMs * policy.factor ** (n - 1);
  return Math.min(policy.maxMs, Math.round(raw));
}

// ─── model-response capture ───────────────────────────────────────────────

/** What is kept of the model responses received during one stage attempt. */
export interface CapturedModelResponse {
  /** The last raw response text. */
  raw: string;
  /** Total tokens over every response of the attempt (retries included). */
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  truncated: boolean;
}

const captureScope = new AsyncLocalStorage<{ response: CapturedModelResponse | null }>();

/**
 * Record a model response against the stage attempt currently running (no-op
 * outside a stage). The job runner wraps its vision client so every response
 * lands here; the runner then persists the raw response even when the stage
 * fails afterwards, and books the actual tokens against the budget.
 */
export function recordModelResponse(response: {
  raw: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  requests?: number;
  truncated?: boolean;
}): void {
  const scope = captureScope.getStore();
  if (scope === undefined) return;
  const prev = scope.response;
  scope.response = {
    raw: response.raw,
    totalTokens: (prev?.totalTokens ?? 0) + (response.usage?.totalTokens ?? 0),
    promptTokens: (prev?.promptTokens ?? 0) + (response.usage?.promptTokens ?? 0),
    completionTokens: (prev?.completionTokens ?? 0) + (response.usage?.completionTokens ?? 0),
    requests: (prev?.requests ?? 0) + (response.requests ?? 1),
    truncated: response.truncated ?? false,
  };
}

// ─── runner ───────────────────────────────────────────────────────────────

/** The runner's collaborators, injected so it stays testable and composable. */
export interface StageRunnerDeps {
  store: ExtractStore;
  lease: LeaseGuard;
  logger: Logger;
  /** How `next_attempt_at` grows after a transient failure. */
  backoff?: BackoffPolicy;
  /** The wall clock, injectable so tests can assert `next_attempt_at` exactly. */
  now?: () => Date;
  /** The stand this run executes under; recorded on every computed output. */
  stand?: PipelineSnapshot;
  /**
   * Reuse a `done` checkpoint of `stage` even when its input hash differs
   * (resume_policy continue / restart-stage, reparse). Default: never.
   */
  reuseDoneRegardlessOfHash?: (stage: string, unit: StageUnit) => boolean;
  /** Aborted when the lease is lost; no stage starts after that. */
  signal?: AbortSignal;
  /**
   * Observability hook (requirement 18.1), called once per stage execution
   * that reached an outcome: `reused` (a checkpoint was replayed, `fn` not
   * run), `done`, `failed_transient` or `failed_permanent`, with the wall-clock
   * duration of the execution and the model tokens it consumed. Not called for
   * a unit still in backoff, a budget stop or a lost lease (nothing executed).
   * A throwing hook never affects the stage.
   */
  onStage?: (observation: StageExecution) => void;
}

/** One stage execution, as reported to {@link StageRunnerDeps.onStage}. */
export interface StageExecution {
  stage: string;
  unit: StageUnit;
  outcome: "done" | "reused" | "failed_transient" | "failed_permanent";
  durationMs: number;
  tokens: number;
}

/** Options for a single {@link StageRunner.runStage} call. */
export interface RunStageOptions<Parsed = unknown, Raw = unknown> {
  unit: StageUnit;
  key: StageKey;
  inputHash: string;
  /** The work to run when the checkpoint must be (re)computed. */
  fn: StageFn<Parsed, Raw>;
  /**
   * The budget consumed by this stage. Provide a ledger and an estimate for a
   * stage that calls a model; omit both for a deterministic stage. When the
   * estimate cannot be reserved, {@link BudgetExhaustedError} is raised BEFORE
   * `fn` runs, so no model call happens on an exhausted budget.
   */
  budget?: { ledger: BudgetLedger; estimatedTokens: number };
}

/** The result of a stage: the checkpoint row and whether it was reused. */
export interface StageResult<Parsed = unknown> {
  row: PageStageRow;
  parsed: Parsed;
  /** True when an existing checkpoint was reused without running `fn`. */
  reused: boolean;
}

/** The stage-execution surface later tasks compose. */
export interface StageRunner {
  /**
   * Run one stage to a persisted checkpoint, reusing an identical-hash result
   * without calling `fn`. See the module header for the guarantees.
   */
  runStage<Parsed, Raw>(opts: RunStageOptions<Parsed, Raw>): Promise<StageResult<Parsed>>;
  /**
   * Re-apply `parser` to a checkpoint's persisted raw response and rewrite its
   * parsed output (marking it `done`), WITHOUT running the stage's `fn` or any
   * model call. Works on `failed` units that kept their raw response too.
   * Returns `null` when there is no checkpoint, no raw response, or the parser
   * still cannot read it.
   */
  reparse<Parsed, Raw>(
    unit: StageUnit,
    key: StageKey,
    parser: StageParser<Parsed, Raw>,
  ): Promise<StageResult<Parsed> | null>;
  /** Same as {@link reparse} for an already-loaded row (windowed walks). */
  reparseRow<Parsed, Raw>(
    unit: StageUnit,
    row: PageStageRow,
    parser: StageParser<Parsed, Raw>,
  ): Promise<StageResult<Parsed> | null>;
}

/**
 * Create a stage runner bound to one job's lease. All writes carry the lease
 * fence, so a zombie worker's persist is refused after takeover.
 */
export function createStageRunner(deps: StageRunnerDeps): StageRunner {
  const { store, lease, logger } = deps;
  const fence = lease.fence;
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const now = deps.now ?? (() => new Date());
  const reuseRegardless = deps.reuseDoneRegardlessOfHash ?? (() => false);

  /** Read the parsed value out of a checkpoint's `output`, tolerating legacy shapes. */
  function parsedOf<Parsed>(output: unknown): Parsed {
    return (isStageOutput(output) ? output.parsed : output) as Parsed;
  }

  function assertLive(): void {
    if (deps.signal?.aborted === true) throw new LeaseLostError(lease.token);
  }

  function keyFor(unit: StageUnit, row: PageStageRow): StageKey {
    return {
      job_id: row.job_id,
      page: row.page,
      stage: row.stage,
      ...(unit === "figure" && row.figure_id !== undefined ? { figure_id: row.figure_id } : {}),
      ...(unit === "tile" && row.tile_id !== undefined ? { tile_id: row.tile_id } : {}),
    };
  }

  /** Reserve the estimate; throws BudgetExhaustedError when it does not fit. */
  async function reserve(budget: RunStageOptions["budget"], key: StageKey): Promise<number> {
    if (budget === undefined || budget.estimatedTokens <= 0) return 0;
    const est = budget.estimatedTokens;
    const ok =
      budget.ledger.reserve !== undefined
        ? await budget.ledger.reserve(est)
        : await budget.ledger.remaining().then((rem) => rem === null || rem >= est);
    if (!ok) {
      const remaining = (await budget.ledger.remaining()) ?? 0;
      logger.info(
        { jobId: key.job_id, page: key.page, stage: key.stage, remaining, needed: est },
        "Token budget exhausted before stage; pausing job",
      );
      throw new BudgetExhaustedError(est, remaining);
    }
    return budget.ledger.reserve !== undefined ? est : 0;
  }

  /**
   * Write a checkpoint and settle the budget. With a checkpoint-capable ledger
   * both happen in one transaction; otherwise the spend is booked right after.
   */
  async function persist(
    unit: StageUnit,
    row: Parameters<ExtractStore["upsertStage"]>[1],
    budget: RunStageOptions["budget"],
    reserved: number,
    used: number,
  ): Promise<PageStageRow> {
    const ledger = budget?.ledger;
    if (ledger?.settleInCheckpoint !== undefined && (reserved > 0 || used > 0)) {
      const settlement: TokenSettlement = { reserved, used };
      const { stage, job } = await store.completeStage(unit, row, fence, settlement);
      if (job !== null) await ledger.settleInCheckpoint.onSettled(job, used);
      return stage;
    }
    const { stage } = await store.completeStage(unit, row, fence);
    if (ledger !== undefined) {
      if (used > 0) await ledger.consume(used);
      if (reserved > 0) await ledger.release?.(reserved);
    }
    return stage;
  }

  /** Report one stage execution to the observability hook, never throwing. */
  function observe(
    key: StageKey,
    unit: StageUnit,
    outcome: StageExecution["outcome"],
    startedAt: number,
    tokens: number,
  ): void {
    if (deps.onStage === undefined) return;
    try {
      deps.onStage({ stage: key.stage, unit, outcome, durationMs: Math.max(0, Date.now() - startedAt), tokens });
    } catch (err) {
      logger.debug({ err, stage: key.stage }, "Stage metrics hook threw; ignored");
    }
  }

  async function runStage<Parsed, Raw>(
    opts: RunStageOptions<Parsed, Raw>,
  ): Promise<StageResult<Parsed>> {
    const { unit, key, inputHash, fn, budget } = opts;
    assertLive();
    const startedAt = Date.now();

    // ── 1. Checkpoint reuse (requirements 4.3, 4.12) ─────────────────────
    const existing = await store.getStage(unit, key);
    const hashMatches = existing !== null && existing.input_hash === inputHash;
    const reusable = existing !== null && (hashMatches || reuseRegardless(key.stage, unit));
    if (existing !== null && existing.status === "done" && reusable) {
      logger.debug(
        { jobId: key.job_id, page: key.page, stage: key.stage, hashMatches },
        "Stage checkpoint reused; no model call",
      );
      observe(key, unit, "reused", startedAt, 0);
      return { row: existing, parsed: parsedOf<Parsed>(existing.output), reused: true };
    }
    // A permanent failure is final until retry-failed resets it: replay it
    // instead of calling the model again.
    if (
      existing !== null &&
      existing.status === "failed" &&
      existing.next_attempt_at === null &&
      reusable
    ) {
      observe(key, unit, "reused", startedAt, 0);
      return { row: existing, parsed: undefined as Parsed, reused: true };
    }

    // ── 2. Backoff (requirement 4.8) ──────────────────────────────────────
    if (
      existing !== null &&
      existing.status === "failed" &&
      existing.next_attempt_at !== null &&
      new Date(existing.next_attempt_at).getTime() > now().getTime()
    ) {
      throw new StageNotDueError(new Date(existing.next_attempt_at));
    }

    // ── 3. Budget reservation BEFORE the model call (requirement 4.9) ────
    const reserved = await reserve(budget, key);

    // A model stage confirms the lease right before it spends a call (one
    // heartbeat per model call, not per write): after a takeover or an
    // operator's cancel/pause the next page stops here instead of paying for a
    // response whose checkpoint write would be refused anyway.
    if (budget !== undefined) {
      try {
        await lease.ensureHeld();
      } catch (err) {
        if (reserved > 0 && !(err instanceof LeaseLostError)) await budget.ledger.release?.(reserved);
        throw err;
      }
    }

    // ── 4. Run the work, capturing any model response ─────────────────────
    const capture: { response: CapturedModelResponse | null } = { response: null };
    let work: StageWork<Parsed, Raw>;
    try {
      assertLive();
      work = await captureScope.run(capture, fn);
    } catch (err) {
      const captured = capture.response;
      const used = captured?.totalTokens ?? 0;
      if (err instanceof LeaseLostError || deps.signal?.aborted === true) {
        // The lease is gone: write nothing. The next holder's claim drops the
        // reservation.
        throw err instanceof LeaseLostError ? err : new LeaseLostError(lease.token);
      }
      if (err instanceof BudgetExhaustedError) {
        if (reserved > 0) await budget?.ledger.release?.(reserved);
        throw err;
      }
      const permanent =
        err instanceof PermanentStageError ||
        (!(err instanceof TransientStageError) && captured !== null);
      if (permanent) {
        const perm =
          err instanceof PermanentStageError
            ? err
            : new PermanentStageError(
                `post-processing failed after the model answered: ${errorMessage(err)}`,
                `Die Modellantwort konnte nicht verarbeitet werden (${errorMessage(err)}); sie wurde gespeichert und kann per reparse erneut ausgewertet werden.`,
              );
        const raw = perm.raw ?? captured?.raw ?? null;
        const row = await persist(
          unit,
          {
            ...key,
            input_hash: inputHash,
            status: "failed",
            output:
              raw !== null
                ? {
                    raw,
                    parsed: null,
                    ...(deps.stand !== undefined ? { stand: deps.stand } : {}),
                    ...(captured !== null ? { response: captured } : {}),
                  }
                : null,
            next_attempt_at: null,
            error: perm.message,
          },
          budget,
          reserved,
          used,
        );
        await store.appendJobWarning(key.job_id, unitWarning(unit, key, perm.warning), fence);
        logger.warn(
          { jobId: key.job_id, page: key.page, stage: key.stage, unit, rawKept: raw !== null },
          "Stage permanently failed; unit marked failed, job continues",
        );
        observe(key, unit, "failed_permanent", startedAt, used);
        return { row, parsed: undefined as Parsed, reused: false };
      }
      // Transient (explicit or unclassified without a model answer): persist a
      // retryable checkpoint with backoff and rethrow. `attempts` counts the
      // row's rewrites (0 after the first write), so this failure is attempt
      // `attempts + 2` of an existing row and attempt 1 of a new one.
      const attempt = existing === null ? 1 : existing.attempts + 2;
      const nextAttemptAt = new Date(now().getTime() + backoffMs(attempt, backoff));
      await persist(
        unit,
        {
          ...key,
          input_hash: inputHash,
          status: "failed",
          output: captured !== null ? { raw: captured.raw, parsed: null, response: captured } : null,
          next_attempt_at: nextAttemptAt,
          error: errorMessage(err),
        },
        budget,
        reserved,
        used,
      );
      logger.warn(
        { jobId: key.job_id, page: key.page, stage: key.stage, attempt, nextAttemptAt },
        "Stage transiently failed; scheduled retry with backoff",
      );
      observe(key, unit, "failed_transient", startedAt, used);
      throw err instanceof TransientStageError ? err : new TransientStageError(errorMessage(err), err);
    }

    // ── 5. Persist the checkpoint: raw beside parsed (requirement 4.6) ────
    const output: StageOutput<Parsed, Raw> = {
      raw: work.raw,
      parsed: work.parsed,
      ...(deps.stand !== undefined ? { stand: deps.stand } : {}),
    };
    const used = Math.max(work.tokensUsed ?? 0, 0);
    const row = await persist(
      unit,
      {
        ...key,
        input_hash: inputHash,
        status: "done",
        output,
        next_attempt_at: null,
        error: null,
      },
      budget,
      reserved,
      budget !== undefined ? used : 0,
    );
    observe(key, unit, "done", startedAt, used);
    return { row, parsed: work.parsed, reused: false };
  }

  async function reparseRow<Parsed, Raw>(
    unit: StageUnit,
    existing: PageStageRow,
    parser: StageParser<Parsed, Raw>,
  ): Promise<StageResult<Parsed> | null> {
    assertLive();
    const key = keyFor(unit, existing);
    if (!isStageOutput(existing.output) || existing.output.raw === null) {
      // No raw response to re-parse (deterministic stage, or a pre-raw
      // checkpoint). Reparse is a no-op rather than a model call.
      logger.debug(
        { jobId: key.job_id, page: key.page, stage: key.stage },
        "Reparse skipped: no persisted raw response",
      );
      return null;
    }
    // Re-apply the parser to the STORED raw response — no `fn`, no model call.
    const stored = existing.output;
    const parsed = await parser(stored.raw as Raw, existing);
    if (parsed === undefined) return null;
    const output: StageOutput<Parsed, Raw> = {
      raw: stored.raw as Raw,
      parsed,
      ...(stored.stand !== undefined ? { stand: stored.stand } : {}),
    };
    const row = await store.upsertStage(
      unit,
      {
        ...key,
        input_hash: existing.input_hash,
        status: "done",
        output,
        next_attempt_at: null,
        error: null,
      },
      fence,
    );
    logger.debug(
      { jobId: key.job_id, page: key.page, stage: key.stage },
      "Stage reparsed from persisted raw response; no model call",
    );
    return { row, parsed, reused: false };
  }

  async function reparse<Parsed, Raw>(
    unit: StageUnit,
    key: StageKey,
    parser: StageParser<Parsed, Raw>,
  ): Promise<StageResult<Parsed> | null> {
    const existing = await store.getStage(unit, key);
    if (existing === null) return null;
    return reparseRow(unit, existing, parser);
  }

  return { runStage, reparse, reparseRow };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A stable, human-readable warning line for a failed unit. */
function unitWarning(unit: StageUnit, key: StageKey, warning: string): string {
  const where =
    unit === "figure"
      ? `Seite ${key.page}, Abbildung ${key.figure_id}`
      : unit === "tile"
        ? `Seite ${key.page}, Kachel ${key.tile_id}`
        : `Seite ${key.page}`;
  return `${where} (Stufe ${key.stage}): ${warning}`;
}
