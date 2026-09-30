// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sync_Run orchestration for one source (requirements 3.8, 6.12, 6.17, 6.18,
 * 7.3–7.10, 8.1–8.12, 9.1–9.11, 10.6, 10.7, 11.1).
 *
 * Order per run: resolve the source credential FRESH (6.17) — a source that
 * needs authorization ends immediately without listing, deleting, or
 * touching the state (6.18), warning once per status change. Then the
 * listing (already filtered by the adapter), item processing bounded by the
 * `maxConcurrentUploads` semaphore (8.12, pause/resume per 10.6), and — only
 * after a COMPLETE listing — the delete plan (9.4). Any interruption leaves
 * in-flight items without an outcome (7.10); the run is then `incomplete`
 * and plans no deletions. Rotated provider tokens are written back to the
 * CredentialStore after the run (6.17).
 */

import type { Logger } from "pino";
import type { OutpostConfig, SourceConfig } from "../config/schema.js";
import type { Env } from "../config/secrets-file.js";
import type { CredentialStore } from "../credentials/store.js";
import { sourceOauthRefreshKey } from "../credentials/keys.js";
import type { ExtractHttpClient } from "../http/client.js";
import { ReauthRequiredError } from "../http/client.js";
import { retryDecision, type RetryOutcome } from "../http/retry.js";
import { DeleteForbiddenError, deleteByReference } from "../extract/delete.js";
import { ExtractApiError } from "../extract/api-error.js";
import type { SyncStateStore } from "../state/store.js";
import {
  SourceNeedsAuthorizationError,
  SourceRejectedError,
  collectListing,
  type SourceAdapter,
} from "../sources/types.js";
import { isAborted, Semaphore } from "./concurrency.js";
import {
  countOutcome,
  newCounters,
  type RunCounters,
} from "./counters.js";
import {
  JournalWriter,
  processItem,
  runCollection,
  type ItemContext,
} from "./executor.js";
import {
  computeCandidateSetHash,
  planDeletes,
} from "./delete-planner.js";
import { deriveReference } from "./reference.js";
import type { NowIso } from "./reducer.js";
import type { UploadLimits } from "./planner.js";

/** How the source reached (or left) the needs-authorization state (6.18). */
export class NeedsAuthTracker {
  readonly #announced = new Set<string>();

  /** True exactly once per transition INTO needs-authorization. */
  shouldAnnounce(sourceId: string, isNeedsAuth: boolean): boolean {
    if (!isNeedsAuth) {
      this.#announced.delete(sourceId);
      return false;
    }
    if (this.#announced.has(sourceId)) return false;
    this.#announced.add(sourceId);
    return true;
  }

  /** Currently announced sources — surfaced through health/status (11.3). */
  isAnnounced(sourceId: string): boolean {
    return this.#announced.has(sourceId);
  }

  forget(sourceId: string): void {
    this.#announced.delete(sourceId);
  }
}

/** Outcome classification of one Sync_Run. */
export type RunOutcomeKind =
  /** Listing complete, all items reached a terminal outcome. */
  | "ok"
  /** Listing or run interrupted (abort, provider error) — no deletions (9.4). */
  | "incomplete"
  /** Source needs authorization — no listing, state untouched (6.18). */
  | "needs-authorization"
  /** Extract re-authentication required mid-run (4.4) — caller pauses. */
  | "reauth-required";

/** What one run did. */
export interface RunReport {
  outcome: RunOutcomeKind;
  /** For `needs-authorization`: why (6.18). */
  reason?: "missing" | "rejected";
  counters: RunCounters;
  /** Mirror-delete phase result for status/health (11.3). */
  deletePhase:
    | "none"
    | "deleted"
    | "marked"
    | "awaiting-confirmation"
    | "skipped-incomplete";
  /** Candidates awaiting user confirmation (9.5). */
  awaitingConfirmation?: { count: number; total: number };
  /** First fatal error, when the run did not finish cleanly. */
  error?: unknown;
}

/** Adapters may expose a rotated refresh token (6.17). */
interface RotatingAdapter {
  rotatedRefreshToken(): string | undefined;
}

export interface RunSourceDeps {
  src: SourceConfig;
  cfg: OutpostConfig;
  store: SyncStateStore;
  client: ExtractHttpClient;
  credentialStore: CredentialStore;
  env: Env;
  /** Sources whose stored token the provider rejected last time (6.18). */
  rejectedIds?: ReadonlySet<string>;
  /** Build the provider adapter for a resolved credential (task 14 factories). */
  makeAdapter: (
    src: SourceConfig,
    credential: Exclude<SourceCredentialUnion, { kind: "needs-authorization" }>,
  ) => SourceAdapter | Promise<SourceAdapter>;
  /** Resolve the credential — injectable for tests; defaults to resolve.ts. */
  resolveCredential?: (
    src: SourceConfig,
    store: CredentialStore,
    env: Env,
    rejectedIds: ReadonlySet<string>,
  ) => Promise<SourceCredentialUnion>;
  limits: UploadLimits;
  logger: Logger;
  needsAuth: NeedsAuthTracker;
  signal: AbortSignal;
  /**
   * Hash of the candidate set the user has explicitly confirmed (9.5, 9.11).
   * Supplied by the runtime from `/data/state/<id>.confirm` or
   * `OUTPOST_CONFIRM_DELETES`; a run deletes an over-threshold set ONLY when
   * this equals the current candidate-set hash. The stored
   * `state.candidateSetHash` is a display/confirmation reference, never a
   * self-confirmation — otherwise the next interval run would delete without
   * the user ever deciding.
   */
  deleteConfirmation?: string;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  now?: NowIso;
  nowMs?: () => number;
}

/** The credential union from resolve.ts, re-exported shape for deps. */
export type SourceCredentialUnion =
  | { kind: "service-account"; keyJson: string }
  | { kind: "refresh-token"; token: string }
  | { kind: "static" }
  | { kind: "needs-authorization"; reason: "missing" | "rejected" };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Orchestrate one full Sync_Run over one source. Never throws. */
export async function runSourceOnce(deps: RunSourceDeps): Promise<RunReport> {
  const { src, cfg, store, client, logger, signal } = deps;
  const counters = newCounters();
  const sleep = deps.sleep ?? defaultSleep;
  const rand = deps.rand ?? Math.random;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const nowMs = deps.nowMs ?? ((): number => Date.now());

  // ── 1. credential, resolved FRESH at run start (6.17) ────────────────────
  const rejected = deps.rejectedIds ?? new Set<string>();
  const resolve =
    deps.resolveCredential ??
    (async (
      s: SourceConfig,
      cs: CredentialStore,
      e: Env,
      r: ReadonlySet<string>,
    ): Promise<SourceCredentialUnion> => {
      const { resolveSourceCredential } = await import("../auth/source-oauth/resolve.js");
      return (await resolveSourceCredential(s, cs, e, r)) as SourceCredentialUnion;
    });
  let credential: SourceCredentialUnion;
  try {
    credential = await resolve(src, deps.credentialStore, deps.env, rejected);
  } catch (error) {
    logger.error({
      event: "source.credential_error",
      sourceId: src.id,
      error: errorMessage(error),
    });
    return {
      outcome: "incomplete",
      counters,
      deletePhase: "skipped-incomplete",
      error,
    };
  }
  if (credential.kind === "needs-authorization") {
    announceNeedsAuth(logger, deps.needsAuth, src.id, credential.reason);
    return { outcome: "needs-authorization", reason: credential.reason, counters, deletePhase: "none" };
  }

  let adapter: SourceAdapter;
  try {
    adapter = await deps.makeAdapter(src, credential);
  } catch (error) {
    if (error instanceof SourceNeedsAuthorizationError) {
      announceNeedsAuth(logger, deps.needsAuth, src.id, error.reason);
      return { outcome: "needs-authorization", reason: error.reason, counters, deletePhase: "none" };
    }
    throw error;
  }

  const journal = new JournalWriter();
  const semaphore = new Semaphore(cfg.maxConcurrentUploads);
  const ctx: ItemContext = {
    src,
    cfg,
    limits: deps.limits,
    client,
    adapter,
    store,
    journal,
    logger,
    sleep,
    rand,
    now,
    nowMs,
    signal,
    ...(deps.deleteConfirmation !== undefined
      ? { deleteConfirmation: deps.deleteConfirmation }
      : {}),
    // Uploads and deletions share the permits (8.12); hashing runs outside.
    withPermit: <T>(fn: () => Promise<T>): Promise<T> => semaphore.run(fn, signal),
  };

  let fatal:
    | { kind: "reauth-required" | "aborted" | "rejected" | "needs-authorization"; error: unknown }
    | undefined;

  // ── 2. listing → filtered items → bounded concurrent processing ──────────
  const seen = new Set<string>();
  const listing = await collectListing(adapter, signal);
  for (const item of listing.items) seen.add(item.quellId);

  // Worker pool: at most maxConcurrentUploads items are in flight; transfers
  // additionally take a semaphore permit (8.12), hashing runs outside it.
  const queue = [...listing.items];
  let nextIndex = 0;
  const processOne = async (item: (typeof queue)[number]): Promise<void> => {
    try {
      const itemResult = await processItem(item, ctx);
      if (itemResult.kind === "skip") {
        counters.skipped += 1;
      } else {
        countOutcome(counters, itemResult.outcome, itemResult.isNewVersion);
        if (
          itemResult.outcome.kind === "client-error" ||
          itemResult.outcome.kind === "read-error" ||
          itemResult.outcome.kind === "retries-exhausted" ||
          (itemResult.outcome.kind === "job-final" &&
            itemResult.outcome.jobStatus !== "completed")
        ) {
          logger.warn({
            event: "item.failed",
            sourceId: src.id,
            quellId: item.quellId,
            error: outcomeMessage(itemResult.outcome),
          });
        }
      }
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        fatal = { kind: "reauth-required", error };
        return;
      }
      if (error instanceof SourceNeedsAuthorizationError) {
        fatal = { kind: "needs-authorization", error };
        return;
      }
      if (error instanceof SourceRejectedError) {
        // Provider refused the stored token mid-run (6.18).
        fatal = { kind: "rejected", error };
        return;
      }
      if (isAborted(signal)) {
        fatal = fatal ?? { kind: "aborted", error };
        return;
      }
      // Unexpected per-item error: count as failed without a state write.
      counters.failed += 1;
      logger.error({
        event: "item.unexpected_error",
        sourceId: src.id,
        quellId: item.quellId,
        error: errorMessage(error),
      });
    }
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      if (fatal !== undefined || isAborted(signal)) return;
      const index = nextIndex;
      nextIndex += 1;
      const item = queue[index];
      if (item === undefined) return;
      await processOne(item);
    }
  };
  const workerCount = Math.min(cfg.maxConcurrentUploads, Math.max(1, queue.length));
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  await journal.drain();

  const listingIncomplete = listing.kind === "incomplete";
  const listingError = listing.kind === "incomplete" ? listing.error : undefined;

  // ── 3. rotated provider tokens back to the store (6.17) ──────────────────
  await persistRotatedToken(adapter, src, deps.credentialStore, logger);

  // ── 4. interruptions end the run without deletions (7.10, 9.4) ───────────
  if (fatal?.kind === "reauth-required") {
    await flushQuietly(store, logger, src.id);
    return { outcome: "reauth-required", counters, deletePhase: "skipped-incomplete", error: fatal.error };
  }
  const rejectedError =
    fatal?.kind === "rejected" || fatal?.kind === "needs-authorization"
      ? fatal.error
      : listingError instanceof SourceRejectedError ||
          listingError instanceof SourceNeedsAuthorizationError
        ? listingError
        : undefined;
  if (rejectedError !== undefined) {
    // Provider refused the stored token during this run (6.18).
    announceNeedsAuth(logger, deps.needsAuth, src.id, "rejected");
    await flushQuietly(store, logger, src.id);
    return {
      outcome: "needs-authorization",
      reason: "rejected",
      counters,
      deletePhase: "skipped-incomplete",
      error: rejectedError,
    };
  }
  if (isAborted(signal) || fatal !== undefined) {
    await flushQuietly(store, logger, src.id);
    return {
      outcome: "incomplete",
      counters,
      deletePhase: "skipped-incomplete",
      error: fatal?.error ?? listingError ?? new Error("run abgebrochen"),
    };
  }
  if (listingIncomplete) {
    logger.warn({
      event: "listing.incomplete",
      sourceId: src.id,
      error: errorMessage(listingError),
      processed: counters.new + counters.updated + counters.skipped + counters.failed,
    });
    await flushQuietly(store, logger, src.id);
    return { outcome: "incomplete", counters, deletePhase: "skipped-incomplete", error: listingError };
  }

  // ── 5. delete planning — only after a COMPLETE listing (9.4) ─────────────
  const deletePhase = await runDeletePhase(ctx, seen, counters);
  await journal.drain();
  await flushQuietly(store, logger, src.id);

  // Needs-authorization cleared: a successful run releases the tracker.
  deps.needsAuth.shouldAnnounce(src.id, false);

  const awaiting = deletePhase.kind === "awaiting-confirmation" ? deletePhase : undefined;
  return {
    outcome: "ok",
    counters,
    deletePhase:
      deletePhase.kind === "delete"
        ? "deleted"
        : deletePhase.kind === "awaiting-confirmation"
          ? "awaiting-confirmation"
          : deletePhase.reason === "mirror-disabled-marked"
            ? "marked"
            : "none",
    ...(awaiting !== undefined
      ? { awaitingConfirmation: { count: awaiting.count, total: awaiting.total } }
      : {}),
  };
}

type DeletePhaseResult =
  | { kind: "delete" }
  | { kind: "awaiting-confirmation"; count: number; total: number }
  | { kind: "none"; reason: "mirror-disabled-marked" | "nothing-missing" };

async function runDeletePhase(
  ctx: ItemContext,
  seen: ReadonlySet<string>,
  counters: RunCounters,
): Promise<DeletePhaseResult> {
  const { src, cfg, store, logger, signal } = ctx;
  const state = store.state;
  const candidates = Object.keys(state.items)
    .filter((quellId) => !seen.has(quellId))
    .sort();
  const candidateHash = computeCandidateSetHash(candidates);
  // 9.5/9.11: only an EXPLICIT user confirmation (file/env) unlocks an
  // over-threshold delete pass — never the hash stored by a previous run.
  const confirmed =
    ctx.deleteConfirmation !== undefined &&
    ctx.deleteConfirmation === candidateHash &&
    candidates.length > 0;
  const plan = planDeletes({
    listing: "complete",
    seen,
    state,
    mirrorDelete: cfg.mirrorDelete,
    thresholdPercent: cfg.deleteThresholdPercent,
    confirmed,
  });

  if (plan.kind === "awaiting-confirmation") {
    // 9.5/9.11: no reduce for candidates — only the hash is stored.
    await ctx.journal.enqueue(async () => {
      await store.setMeta({ candidateSetHash: candidateHash });
    });
    logger.warn({
      event: "deletes.awaiting_confirmation",
      sourceId: src.id,
      count: plan.count,
      total: plan.total,
      thresholdPercent: cfg.deleteThresholdPercent,
    });
    return { kind: "awaiting-confirmation", count: plan.count, total: plan.total };
  }

  if (plan.kind === "none" && plan.reason === "mirror-disabled-marked") {
    // 9.2: mark instead of delete — documents stay in the collection.
    for (const quellId of candidates) {
      if (isAborted(signal)) break;
      const prev = store.state.items[quellId];
      if (prev === undefined || prev.status === "deleted-in-source") continue;
      const reference = prev.reference;
      await ctx.journal.enqueue(async () => {
        await store.upsert(quellId, { ...prev, reference, status: "deleted-in-source", jobId: undefined, pendingUpload: undefined });
      });
    }
    return { kind: "none", reason: "mirror-disabled-marked" };
  }

  if (plan.kind !== "delete") {
    // Nothing missing — clear a stale confirmation hash if one exists.
    if (store.state.candidateSetHash !== undefined) {
      await ctx.journal.enqueue(async () => {
        await store.setMeta({ candidateSetHash: null });
      });
    }
    return { kind: "none", reason: "nothing-missing" };
  }

  // 9.1/9.6: delete exactly the recorded references, under the semaphore.
  const byReference = new Map<string, string>();
  for (const quellId of candidates) {
    const entry = store.state.items[quellId];
    if (entry !== undefined) byReference.set(entry.reference, quellId);
  }
  let deletedAny = false;
  for (const reference of plan.references) {
    if (isAborted(signal)) break;
    const quellId = byReference.get(reference);
    if (quellId === undefined) continue;
    try {
      await ctx.withPermit(async () => await deleteWithRetry(reference, ctx));
      await ctx.journal.enqueue(async () => {
        await store.deleteItem(quellId);
      });
      counters.deleted += 1;
      deletedAny = true;
    } catch (error) {
      if (isAborted(signal)) break;
      if (error instanceof DeleteForbiddenError) {
        // 9.8/9.10: missing scope — configuration problem, states stay.
        logger.error({
          event: "deletes.forbidden",
          sourceId: src.id,
          error: error.message,
        });
        return deletedAny ? { kind: "delete" } : { kind: "none", reason: "nothing-missing" };
      }
      logger.warn({
        event: "deletes.item_failed",
        sourceId: src.id,
        quellId,
        error: errorMessage(error),
      });
    }
  }
  // Confirmation (if any) was consumed by this delete pass.
  if (store.state.candidateSetHash !== undefined) {
    await ctx.journal.enqueue(async () => {
      await store.setMeta({ candidateSetHash: null });
    });
  }
  return { kind: "delete" };
}

/** Delete with the retry policy; 403 is final (scope problem, not transient). */
async function deleteWithRetry(reference: string, ctx: ItemContext): Promise<void> {
  const collection = runCollection(ctx.src, ctx.cfg);
  let attempt = 0;
  for (;;) {
    try {
      await deleteByReference(ctx.client, collection, reference, ctx.signal);
      return;
    } catch (error) {
      if (isAborted(ctx.signal)) throw error;
      if (error instanceof DeleteForbiddenError) throw error;
      const outcome: RetryOutcome =
        error instanceof ExtractApiError
          ? { kind: "http", status: error.status }
          : { kind: "network" };
      const decision = retryDecision(attempt, outcome, ctx.nowMs(), ctx.rand);
      if (!decision.retry) throw error;
      attempt += 1;
      await ctx.sleep(decision.delayMs);
    }
  }
}

function announceNeedsAuth(
  logger: Logger,
  tracker: NeedsAuthTracker,
  sourceId: string,
  reason: "missing" | "rejected",
): void {
  if (!tracker.shouldAnnounce(sourceId, true)) return;
  logger.warn({
    event: "source.needs_authorization",
    sourceId,
    reason,
    hint: `atf-outpost source-login ${sourceId}`,
  });
}

async function persistRotatedToken(
  adapter: SourceAdapter,
  src: SourceConfig,
  credentialStore: CredentialStore,
  logger: Logger,
): Promise<void> {
  const rotating = adapter as Partial<RotatingAdapter>;
  if (typeof rotating.rotatedRefreshToken !== "function") return;
  const rotated = rotating.rotatedRefreshToken();
  if (rotated === undefined || rotated === "") return;
  try {
    await credentialStore.set(sourceOauthRefreshKey(src.id), rotated);
  } catch (error) {
    logger.error({
      event: "source.token_rotate_failed",
      sourceId: src.id,
      error: errorMessage(error),
    });
  }
}

async function flushQuietly(store: SyncStateStore, logger: Logger, sourceId: string): Promise<void> {
  try {
    await store.flush();
  } catch (error) {
    logger.error({ event: "state.flush_failed", sourceId, error: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outcomeMessage(outcome: { kind: string; message?: string; status?: number }): string {
  if (outcome.message !== undefined) return outcome.message;
  return `${outcome.kind}${outcome.status !== undefined ? ` (${outcome.status})` : ""}`;
}

/** The reference an item would get — exposed for status output (11.5). */
export const itemReference = (sourceId: string, quellId: string): string =>
  deriveReference(sourceId, quellId);
