// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Item pipeline of a Sync_Run (requirements 7.3–7.10, 8.1–8.12).
 *
 * `processItem` runs the full decision chain for one source item:
 * `planItem` → hashing (cloud sources download EXACTLY ONCE into a temp
 * file; the resumable path always materializes so chunk reads are random
 * access) → `planAfterHash` → direct ingest or resumable upload + job
 * polling → `reduce` → journal write per item (7.8). Transfers are wrapped
 * in the retry policy of `http/retry.ts` (429/5xx/network, `Retry-After`
 * honoured, 8.9); a permanent 4xx becomes a `client-error` outcome while
 * the last synced sha256/marker stay untouched (8.10). An abort (any
 * reason — logout, shutdown, network loss, crash) leaves in-flight items
 * WITHOUT an outcome (7.10); only fully processed items reach the journal.
 *
 * Journal writes are serialized through {@link JournalWriter} so concurrent
 * item processing (bounded by the semaphore, 8.12) can never interleave
 * records. A freshly opened resumable session is persisted IMMEDIATELY via
 * the `onSession` callback (3.8, 8.6) so a crash loses no session.
 */

import { createHash } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import type { JobStatus } from "@atf/extract-contract/v2";
import type { OutpostConfig, SourceConfig } from "../config/schema.js";
import { effectiveCollection } from "../config/validate.js";
import type { ExtractHttpClient } from "../http/client.js";
import { ReauthRequiredError } from "../http/client.js";
import { retryDecision, type RetryOutcome } from "../http/retry.js";
import { ExtractApiError } from "../extract/api-error.js";
import { ingest, readFileBytes } from "../extract/ingest.js";
import { createJob, pollJob } from "../extract/jobs.js";
import {
  runResumableUpload,
  type ChunkReader,
  type PendingUpload,
} from "../extract/uploads.js";
import type { SyncStateStore } from "../state/store.js";
import type { ItemState } from "../state/schema.js";
import type { SourceAdapter, SourceItem } from "../sources/types.js";
import {
  buildIngestHeaders,
  effectiveAclDigest,
  toJobRequest,
} from "./headers.js";
import { planAfterHash, planItem, type UploadLimits } from "./planner.js";
import { deriveReference } from "./reference.js";
import { reduce, type NowIso, type Outcome } from "./reducer.js";
import { isAborted } from "./concurrency.js";

/** Serialize journal mutations so concurrent items never interleave writes. */
export class JournalWriter {
  #chain: Promise<void> = Promise.resolve();


  /** Run `fn` after all previously enqueued writes finished. */
  enqueue(fn: () => Promise<void>): Promise<void> {
    const run = (): Promise<void> => fn();
    const next = this.#chain.then(run, run);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** Wait until every queued write has settled. */
  drain(): Promise<void> {
    return this.#chain;
  }
}

/** Everything one item needs — built once per run by `runSourceOnce`. */
export interface ItemContext {
  src: SourceConfig;
  cfg: OutpostConfig;
  limits: UploadLimits;
  client: ExtractHttpClient;
  adapter: SourceAdapter;
  store: SyncStateStore;
  journal: JournalWriter;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  rand: () => number;
  now: NowIso;
  nowMs: () => number;
  signal: AbortSignal;
  /**
   * Hash of the user-confirmed delete-candidate set (9.5). Present only when
   * the runtime read an explicit confirmation for this source.
   */
  deleteConfirmation?: string;
  /**
   * Bound a transfer to one semaphore permit (8.12). Defaults to running
   * unbounded — the run supplies the real semaphore.
   */
  withPermit: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** Result of processing one item in this run. */
export type ItemResult =
  /** Marker matched a synced state — nothing transferred (7.3). */
  | { kind: "skip" }
  /** A terminal outcome was reduced and journaled. */
  | { kind: "processed"; outcome: Outcome; isNewVersion: boolean };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrow a terminal job status onto the reducer's `job-final` variants. */
function terminalJobStatus(status: JobStatus): "completed" | "failed" | "cancelled" {
  if (status === "completed" || status === "cancelled") return status;
  return "failed";
}

interface Materialized {
  sha256: string;
  /** Actual bytes read (may differ from the listed size on races). */
  size: number;
  /** The temp file holding the exact hashed bytes. */
  tempPath: string;
}

/**
 * Stream the item EXACTLY once: hash while teeing into a temp file, so the
 * upload sends the very bytes that were hashed — no second download for
 * cloud sources (design: „ein Download“) and no race between hash and
 * upload for local ones. The caller removes the temp file in `finally`.
 */
async function hashAndSave(
  item: SourceItem,
  ctx: ItemContext,
): Promise<Materialized> {
  const dir = await mkdtemp(path.join(tmpdir(), "atf-outpost-"));
  const tempPath = path.join(dir, "content");
  const hash = createHash("sha256");
  let handle: FileHandle | undefined;
  let size = 0;
  try {
    const stream = await ctx.adapter.open(item, ctx.signal);
    handle = await open(tempPath, "w");
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      hash.update(bytes);
      size += bytes.byteLength;
      await handle.write(bytes);
    }
    return { sha256: hash.digest("hex"), size, tempPath };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Random-access reader over a materialized temp file. */
function chunkReaderFrom(tempPath: string): ChunkReader {
  return async (offset: number, length: number): Promise<Uint8Array> => {
    const handle = await open(tempPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(
          `Temp-Datei kürzer als erwartet: ${bytesRead} von ${length} bei ${offset}`,
        );
      }
      return new Uint8Array(buffer); // copy — independent of the pooled buffer
    } finally {
      await handle.close();
    }
  };
}

/** Reduce an outcome for one item and journal it atomically (7.8). */
export async function applyOutcome(
  item: SourceItem,
  reference: string,
  outcome: Outcome,
  ctx: Pick<ItemContext, "store" | "journal" | "now">,
): Promise<void> {
  const prev = ctx.store.state.items[item.quellId];
  const next = reduce(prev, reference, outcome, ctx.now);
  await ctx.journal.enqueue(async () => {
    if (next === null) await ctx.store.deleteItem(item.quellId);
    else await ctx.store.upsert(item.quellId, next);
  });
}

/** Persist a (new or discarded) resumable session without moving marker/sha (3.8). */
async function persistSession(
  item: SourceItem,
  reference: string,
  session: PendingUpload | undefined,
  ctx: Pick<ItemContext, "store" | "journal">,
): Promise<void> {
  const prev = ctx.store.state.items[item.quellId];
  const base: ItemState = prev ?? {
    reference,
    marker: "",
    size: 0,
    status: "failed",
  };
  await ctx.journal.enqueue(async () => {
    await ctx.store.upsert(item.quellId, { ...base, reference, pendingUpload: session });
  });
}

/** Direct path: `POST /v1/ingest`; a 202 becomes accepted + poll (8.7). */
async function transferDirect(
  item: SourceItem,
  reference: string,
  sha256: string,
  materialized: Materialized,
  ctx: ItemContext,
  digest: string | undefined,
): Promise<Outcome> {
  const headers = buildIngestHeaders(item, ctx.src, ctx.cfg);
  const source = await readFileBytes(materialized.tempPath);
  const result = await ingest(
    ctx.client,
    headers,
    source,
    item.name,
    item.mimeType,
    ctx.signal,
  );
  if (result.kind === "ingested") {
    return {
      kind: "ingested",
      status: result.status,
      sha256,
      marker: item.marker,
      ...(digest !== undefined ? { aclDigest: digest } : {}),
    };
  }
  // 202: persist the pending job BEFORE polling so a crash keeps the jobId (8.7).
  await applyOutcome(
    item,
    reference,
    {
      kind: "accepted",
      jobId: result.jobId,
      sha256,
      marker: item.marker,
      ...(digest !== undefined ? { aclDigest: digest } : {}),
    },
    ctx,
  );
  const job = await pollJob(ctx.client, result.jobId, {
    sleep: ctx.sleep,
    signal: ctx.signal,
  });
  return {
    kind: "job-final",
    jobStatus: terminalJobStatus(job.status),
    sha256,
    marker: item.marker,
    ...(digest !== undefined ? { aclDigest: digest } : {}),
  };
}

/** Resumable path: `/v2/uploads` + `POST /v2/jobs` (8.5, 8.6). */
async function transferResumable(
  item: SourceItem,
  reference: string,
  sha256: string,
  materialized: Materialized,
  ctx: ItemContext,
  digest: string | undefined,
): Promise<Outcome> {
  // Read the state FRESH per attempt: a previous attempt in this very run may
  // have persisted a session (onSession) that the retry must resume (8.6).
  const prev = ctx.store.state.items[item.quellId];
  // A stored session belongs to its sha256 only — a different content starts fresh.
  const pending =
    prev?.pendingUpload !== undefined && prev.sha256 === sha256
      ? prev.pendingUpload
      : undefined;
  await runResumableUpload(
    ctx.client,
    {
      reference,
      sha256,
      size: materialized.size,
      readChunk: chunkReaderFrom(materialized.tempPath),
      ...(pending !== undefined ? { pending } : {}),
      onSession: async (session): Promise<void> => {
        await persistSession(item, reference, session, ctx);
      },
    },
    ctx.signal,
  );
  const job = await createJob(
    ctx.client,
    toJobRequest(item, ctx.src, ctx.cfg, sha256),
    ctx.signal,
  );
  if (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    return {
      kind: "job-final",
      jobStatus: terminalJobStatus(job.status),
      sha256,
      marker: item.marker,
      ...(digest !== undefined ? { aclDigest: digest } : {}),
    };
  }
  await applyOutcome(
    item,
    reference,
    {
      kind: "accepted",
      jobId: job.jobId,
      sha256,
      marker: item.marker,
      ...(digest !== undefined ? { aclDigest: digest } : {}),
    },
    ctx,
  );
  const final = await pollJob(ctx.client, job.jobId, {
    sleep: ctx.sleep,
    signal: ctx.signal,
  });
  return {
    kind: "job-final",
    jobStatus: terminalJobStatus(final.status),
    sha256,
    marker: item.marker,
    ...(digest !== undefined ? { aclDigest: digest } : {}),
  };
}

/**
 * Run one transfer under the retry policy (8.9): 429/5xx/network retry with
 * backoff/`Retry-After`; a permanent 4xx becomes `client-error`; exhausted
 * retries become `retries-exhausted`. Aborts and re-auth propagate.
 */
async function transferWithRetry(
  item: SourceItem,
  reference: string,
  sha256: string,
  mode: "direct" | "resumable",
  materialized: Materialized,
  ctx: ItemContext,
  digest: string | undefined,
): Promise<Outcome> {
  let attempt = 0;
  for (;;) {
    try {
      return await ctx.withPermit(async () =>
        mode === "direct"
          ? await transferDirect(item, reference, sha256, materialized, ctx, digest)
          : await transferResumable(
              item,
              reference,
              sha256,
              materialized,
              ctx,
              digest,
            ),
      );
    } catch (error) {
      if (isAborted(ctx.signal)) throw error;
      if (error instanceof ReauthRequiredError) throw error;
      const outcome: RetryOutcome =
        error instanceof ExtractApiError
          ? {
              kind: "http",
              status: error.status,
              ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
            }
          : { kind: "network" };
      const decision = retryDecision(attempt, outcome, ctx.nowMs(), ctx.rand);
      if (!decision.retry) {
        if (error instanceof ExtractApiError) {
          return { kind: "client-error", status: error.status, message: error.message };
        }
        return { kind: "retries-exhausted", message: errorMessage(error) };
      }
      attempt += 1;
      ctx.logger.warn({
        event: "transfer.retry",
        sourceId: ctx.src.id,
        quellId: item.quellId,
        attempt,
        delayMs: decision.delayMs,
        reason: outcome.kind === "http" ? `HTTP ${outcome.status}` : "netzwerk",
      });
      await ctx.sleep(decision.delayMs);
    }
  }
}

/**
 * Process one item end-to-end. Throws on abort or re-auth (the run decides);
 * every other failure ends in a journaled failure outcome (8.10, 8.11).
 */
export async function processItem(
  item: SourceItem,
  ctx: ItemContext,
): Promise<ItemResult> {
  if (isAborted(ctx.signal)) throw new Error("run abgebrochen");
  const reference = deriveReference(ctx.src.id, item.quellId);
  const prev = ctx.store.state.items[item.quellId];
  // Effective ACL of this item (item > source); its digest makes an ACL
  // change re-upload otherwise unchanged content (undefined = no ACL).
  const digest = effectiveAclDigest(item, ctx.src);

  const pre = planItem(item, prev, digest);
  if (pre.kind === "skip") return { kind: "skip" };

  let materialized: Materialized;
  try {
    materialized = await hashAndSave(item, ctx);
  } catch (error) {
    if (isAborted(ctx.signal)) throw error;
    if (error instanceof ReauthRequiredError) throw error;
    // Unreadable/vanished source: a failure for THIS item, others unaffected.
    const outcome: Outcome = { kind: "read-error", message: errorMessage(error) };
    await applyOutcome(item, reference, outcome, ctx);
    return { kind: "processed", outcome, isNewVersion: prev !== undefined };
  }

  try {
    if (materialized.size > ctx.limits.maxUploadBytes) {
      const outcome: Outcome = {
        kind: "client-error",
        status: 413,
        message: `Datei größer als maxUploadBytes (${materialized.size} > ${ctx.limits.maxUploadBytes})`,
      };
      await applyOutcome(item, reference, outcome, ctx);
      return { kind: "processed", outcome, isNewVersion: prev !== undefined };
    }
    const plan = planAfterHash(
      item,
      prev,
      materialized.sha256,
      ctx.limits,
      digest,
    );
    if (plan.kind === "update-marker") {
      const outcome: Outcome = {
        kind: "marker-only",
        marker: item.marker,
        ...(digest !== undefined ? { aclDigest: digest } : {}),
      };
      await applyOutcome(item, reference, outcome, ctx);
      return { kind: "processed", outcome, isNewVersion: false };
    }
    if (plan.kind === "reject-too-large") {
      const outcome: Outcome = {
        kind: "client-error",
        status: 413,
        message: `Datei größer als maxUploadBytes (${item.size} > ${ctx.limits.maxUploadBytes})`,
      };
      await applyOutcome(item, reference, outcome, ctx);
      return { kind: "processed", outcome, isNewVersion: prev !== undefined };
    }
    const outcome = await transferWithRetry(
      item,
      reference,
      materialized.sha256,
      plan.mode,
      materialized,
      ctx,
      digest,
    );
    await applyOutcome(item, reference, outcome, ctx);
    return { kind: "processed", outcome, isNewVersion: plan.isNewVersion };
  } finally {
    await rm(path.dirname(materialized.tempPath), { recursive: true, force: true });
  }
}

/** The effective collection of the source — used by the run for deletes. */
export const runCollection = (src: SourceConfig, cfg: OutpostConfig): string =>
  effectiveCollection(src, cfg);
