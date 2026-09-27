// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * revision-ttl-cleaner.ts
 *
 * A background reaper that periodically removes uncommitted revisions whose TTL
 * has expired (Requirement 5.10). It complements the heartbeat path: a paused
 * or slow Extract job keeps its staged revision alive by extending the TTL via
 * `POST …/revisions/{rev}/heartbeat`; a job that dies without heartbeating lets
 * its revision expire and this cleaner reaps it, cascading to its batches,
 * segments, revision-bound assets, the unit rows it already wrote (plus their
 * vs_identifiers entries) and a document pointer that named it. A revision
 * whose final commit was accepted is never reaped: the commit clears its TTL.
 * Each candidate is re-checked under its row lock, so a heartbeat or commit
 * that races the sweep wins.
 *
 * The reaper is deliberately dumb — it delegates the "which rows and how to
 * delete them" decision to {@link RevisionStore.reapExpired} so the TTL policy
 * lives in exactly one place. It only owns the timer and its lifecycle.
 */

import type { Logger } from "pino";
import type { RevisionStore } from "./revision-store.js";

export interface RevisionTtlCleaner {
  /** Reap once immediately; returns the number of revisions removed. */
  runOnce(): Promise<number>;
  /** Stop the interval timer. Safe to call more than once. */
  stop(): void;
}

export interface RevisionTtlCleanerOptions {
  /** How often to sweep, in milliseconds. Default: 1 hour. 0 disables the timer. */
  intervalMs?: number;
  logger?: Logger;
}

export function createRevisionTtlCleaner(
  store: RevisionStore,
  options: RevisionTtlCleanerOptions = {},
): RevisionTtlCleaner {
  const intervalMs = options.intervalMs ?? 3_600_000;
  const logger = options.logger;

  async function runOnce(): Promise<number> {
    const result = await store.reapExpired();
    if (!result.ok) {
      logger?.warn({ error: result.error }, "Revision TTL sweep failed");
      return 0;
    }
    if (result.result.reaped > 0) {
      logger?.info({ reaped: result.result.reaped }, "Reaped expired uncommitted revisions");
    }
    return result.result.reaped;
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  if (intervalMs > 0) {
    timer = setInterval(() => {
      // A slow sweep must not overlap the next one.
      if (running) return;
      running = true;
      void runOnce().finally(() => {
        running = false;
      });
    }, intervalMs);
    // Do not keep the event loop alive for the sweep alone.
    timer.unref?.();
  }

  return {
    runOnce,
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
