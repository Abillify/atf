// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * queue.ts
 *
 * A bounded work queue for conversions, and an ordered concurrency helper for
 * the pages within one conversion.
 *
 * ## Why a queue at all
 *
 * A conversion holds a LibreOffice process, a page image in memory and a model
 * slot, for minutes. Without admission control, ten simultaneous uploads do not
 * take ten times as long — they exhaust memory, thrash the model endpoint, and
 * every one of them times out. Bounding concurrency makes the service slower
 * under load and *correct* under load, which is the trade worth making.
 *
 * The depth bound matters as much as the concurrency bound. An unbounded queue
 * turns overload into an ever-growing latency nobody can act on; a bounded one
 * turns it into a 503 with `Retry-After`, which a caller can. Refusing work you
 * cannot do soon is more useful than accepting it and being slow forever.
 */

/** Snapshot for `/metrics` and `/health`. */
export interface QueueState {
  /** Tasks waiting for a slot. */
  depth: number;
  /** Tasks currently running. */
  active: number;
  /** Configured parallelism. */
  concurrency: number;
  /** Configured maximum depth. */
  maxDepth: number;
}

export class QueueSaturatedError extends Error {
  constructor(readonly state: QueueState) {
    super(`The conversion queue is full (${state.depth}/${state.maxDepth} waiting)`);
    this.name = "QueueSaturatedError";
  }
}

export interface WorkQueue {
  /** Run `task` when a slot is free. Rejects immediately when the queue is full. */
  submit<T>(task: () => Promise<T>): Promise<T>;
  state(): QueueState;
}

interface Waiter {
  run: () => void;
}

export function createWorkQueue(options: {
  concurrency: number;
  maxDepth: number;
  /** Called whenever depth or active changes, for metrics. */
  onStateChange?: (state: QueueState) => void;
}): WorkQueue {
  const { concurrency, maxDepth } = options;
  const waiting: Waiter[] = [];
  let active = 0;

  const state = (): QueueState => ({
    depth: waiting.length,
    active,
    concurrency,
    maxDepth,
  });

  const notify = (): void => options.onStateChange?.(state());

  const release = (): void => {
    active--;
    const next = waiting.shift();
    if (next !== undefined) {
      active++;
      next.run();
    }
    notify();
  };

  async function submit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency && waiting.length >= maxDepth) {
      // Reject before reading the upload into the pipeline, so an overloaded
      // service spends nothing on work it is about to refuse.
      throw new QueueSaturatedError(state());
    }

    if (active < concurrency) {
      active++;
      notify();
    } else {
      await new Promise<void>((resolve) => {
        waiting.push({ run: resolve });
        notify();
      });
    }

    try {
      return await task();
    } finally {
      release();
    }
  }

  return { submit, state };
}

/**
 * Map over items with bounded concurrency, invoking `onResult` in *input order*.
 *
 * Order is the point. Pages are converted in parallel because each one is a
 * multi-second model call, but a page must not be streamed to an SSE client
 * before the pages ahead of it — a reader watching a document appear needs page
 * 3 after page 2, and an assembled document has to be in reading order
 * regardless of which model call happened to finish first.
 *
 * A rejected item stops the run: `onError` decides whether that ends everything
 * or the item is replaced by a placeholder, which is how one unconvertible page
 * in a 200-page document avoids discarding the other 199.
 */
export async function mapOrdered<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  worker: (item: TIn, index: number) => Promise<TOut>,
  onResult?: (result: TOut, index: number) => void | Promise<void>,
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  const settled = new Array<boolean>(items.length).fill(false);
  let nextToStart = 0;
  let nextToEmit = 0;
  let failure: unknown = null;

  /** Emit every completed prefix that has not been emitted yet. */
  async function drain(): Promise<void> {
    while (nextToEmit < items.length && settled[nextToEmit] === true) {
      const index = nextToEmit;
      nextToEmit++;
      if (onResult !== undefined) {
        const value = results[index];
        if (value !== undefined) await onResult(value, index);
      }
    }
  }

  async function runLane(): Promise<void> {
    for (;;) {
      if (failure !== null) return;
      const index = nextToStart++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await worker(item, index);
        settled[index] = true;
        await drain();
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  }

  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, runLane);
  await Promise.all(lanes);

  if (failure !== null) throw failure;
  return results;
}
