// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/lease.ts
 *
 * The lease and its fencing token (design §9b.2, requirements 4.4, 4.5).
 *
 * A worker claims a job and holds a lease: `(lease_holder, lease_epoch,
 * lease_expires_at)`. The claim query bumps the epoch, so at any moment exactly
 * one epoch is current; operator actions (pause, cancel, resume, retry-failed,
 * reparse) bump it too. The danger this guards against is a *zombie*: a worker
 * that was partitioned off the network, believed it still owned a job, and
 * comes back to write results after another worker has already taken the job
 * over — or a worker that keeps running after an operator cancelled the job.
 * Its epoch is now stale, and every one of its writes must be refused.
 *
 * ## Fencing is in SQL, not in this module
 *
 * The guard hands out its token as {@link LeaseGuard.fence}; every persistent
 * write passes it to the store, which checks `lease_holder = holder AND
 * lease_epoch = epoch` in the SAME statement or transaction as the write and
 * raises {@link LeaseLostError} when it no longer matches. That is atomic: there
 * is no window between a check and the write in which a takeover could slip,
 * and it costs no extra heartbeat round-trip per write.
 *
 * `ensureHeld()` is the heartbeat: it renews the lease and reports a loss. The
 * worker runs it on an interval and aborts the run (via an AbortSignal) the
 * moment it fails, so in-flight model calls stop instead of finishing into
 * writes that would be refused anyway.
 */

import type { ExtractStore } from "../persistence/index.js";
import { LeaseLostError, type Fence } from "../persistence/types.js";

export { LeaseLostError };

/** Identifies a held lease. The epoch is the fencing token. */
export type LeaseToken = Fence;

/**
 * A lease bound to one claimed job: its fencing token for writes plus the
 * heartbeat that keeps it alive.
 */
export interface LeaseGuard {
  readonly token: LeaseToken;
  /** The fence every persistent write of this worker passes to the store. */
  readonly fence: Fence;
  /**
   * Renew the lease and confirm it is still held. Throws {@link LeaseLostError}
   * when the epoch has been superseded (a takeover or an operator action).
   * Called on the heartbeat interval.
   */
  ensureHeld(): Promise<void>;
  /**
   * Run `write` after confirming the lease. Kept for callers that write through
   * a surface without a fence parameter; it is only a pre-check. Pipeline
   * writes pass {@link fence} to the store instead, which is atomic.
   */
  guard<T>(write: () => Promise<T>): Promise<T>;
}

/** Create a guard for a freshly claimed lease. */
export function createLeaseGuard(
  store: ExtractStore,
  token: LeaseToken,
  leaseSeconds: number,
): LeaseGuard {
  async function ensureHeld(): Promise<void> {
    const row = await store.heartbeat(token.jobId, token.holder, token.epoch, leaseSeconds);
    if (row === null) throw new LeaseLostError(token);
  }
  return {
    token,
    fence: token,
    ensureHeld,
    async guard(write) {
      await ensureHeld();
      return write();
    },
  };
}
