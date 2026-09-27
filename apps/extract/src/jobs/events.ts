// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/events.ts
 *
 * The job-event seam that feeds SSE and the callback (design §9b, task 1.7,
 * requirement 6.1).
 *
 * In v1 the SSE stream and the callback delivery read directly from the
 * in-memory convert pipeline: the extractor called `onPage`/`onProgress` and the
 * handler turned those into events. A v2 job has no such in-process pipeline to
 * observe — it runs on a worker, possibly a different process, driving pages
 * through persisted stages. So the progress signal has to come from the *job*:
 * as each page's stages complete the runner publishes an event, and whatever is
 * watching the job (an SSE handler tailing it, the callback deliverer) consumes
 * those events instead of the pipeline's own callbacks.
 *
 * This module is deliberately tiny: an in-process pub/sub keyed by job id, with
 * no persistence and no ordering guarantees beyond "delivered in publish order
 * to each subscriber". The runner already emits pages in strict page order, so
 * subscribers see page 1 before page 2. A subscriber that joins late misses the
 * events published before it subscribed — that is fine for SSE (the handler
 * reconciles the current job state on connect) and for the callback (which is
 * driven by the worker that owns the job, so it subscribes before the run
 * starts).
 *
 * The bus is intentionally decoupled from the store: it carries the small,
 * already-parsed shapes a consumer needs (a completed page's record-ish view, a
 * staged crop's id, a terminal outcome), never a raw row and never image bytes.
 */

import type { PageRecord } from "@atf/extract-contract/v2";

/** A page finished all its per-page stages and its emit row was staged. */
export interface PageCompletedEvent {
  type: "page";
  jobId: string;
  page: number;
  pageCount: number | null;
  /** The v2 page record produced from the parsed stages. */
  record: PageRecord;
  /** Asset ids staged for this page (figure crops, page image), in order. */
  assetIds: string[];
  /** Cumulative token usage after this page. */
  usage: { requests: number; promptTokens: number; completionTokens: number; totalTokens: number };
}

/** The source was prepared into a page-addressable document. */
export interface PreparedEvent {
  type: "prepared";
  jobId: string;
  pageCount: number;
}

/** A single figure crop (or page image) was written to the asset staging area. */
export interface AssetStagedEvent {
  type: "asset";
  jobId: string;
  page: number;
  assetId: string;
  kind: "figure" | "page" | "tile";
}

/** The job reached a terminal-ish outcome. */
export interface JobDoneEvent {
  type: "done";
  jobId: string;
  status: "completed" | "failed" | "paused";
  reason?: string;
}

export type JobEvent = PreparedEvent | PageCompletedEvent | AssetStagedEvent | JobDoneEvent;

/** A subscriber callback. Errors thrown by it are isolated per subscriber. */
export type JobEventListener = (event: JobEvent) => void;

/** The publish/subscribe surface. */
export interface JobEventBus {
  /** Publish an event to every current subscriber of its job. */
  publish(event: JobEvent): void;
  /**
   * Subscribe to one job's events. Returns an unsubscribe function; call it
   * when the SSE connection closes or the callback delivery finishes so the
   * listener set does not leak.
   */
  subscribe(jobId: string, listener: JobEventListener): () => void;
}

/**
 * Create an in-process event bus. A single instance is shared by the worker
 * (publisher) and any SSE handler / callback deliverer (subscribers) within one
 * process. A multi-process deployment fans SSE out per process; a job's own
 * worker always publishes in the same process that drives it, so the callback —
 * which the worker owns — always sees every event.
 */
export function createJobEventBus(): JobEventBus {
  const listeners = new Map<string, Set<JobEventListener>>();

  return {
    publish(event) {
      const set = listeners.get(event.jobId);
      if (set === undefined) return;
      // Snapshot so a listener that unsubscribes during delivery does not mutate
      // the set we are iterating.
      for (const listener of [...set]) {
        try {
          listener(event);
        } catch {
          // A misbehaving subscriber must not stop the others or the run.
        }
      }
    },
    subscribe(jobId, listener) {
      let set = listeners.get(jobId);
      if (set === undefined) {
        set = new Set();
        listeners.set(jobId, set);
      }
      set.add(listener);
      return () => {
        const current = listeners.get(jobId);
        if (current === undefined) return;
        current.delete(listener);
        if (current.size === 0) listeners.delete(jobId);
      };
    },
  };
}
