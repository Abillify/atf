// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Simple promise-based semaphore for concurrency limiting, with a bounded
 * wait-queue (backpressure) and a bounded WAIT (liveness).
 *
 * Usage:
 *   const sem = new Semaphore(10, 100); // max 10 concurrent, max 100 queued
 *   await sem.acquire({ timeoutMs: 30_000, signal });
 *   try { ... } finally { sem.release(); }
 *
 * ## Why the wait must be bounded
 *
 * `acquire()` used to wait forever. Combined with a provider call that ignores
 * the execution timeout, that produced a cascade: a stalled run holds its slot
 * indefinitely, every subsequent caller queues behind it, and clients that
 * already disconnected still hold their place — so when a slot finally frees, it
 * is spent running a flow nobody is listening to. The queue drains slower than
 * it fills and the replica saturates.
 *
 * A bounded wait turns that into a clean, observable rejection: the caller is
 * told the server is at capacity (HTTP 503 + `Retry-After`) instead of hanging.
 */

/** Thrown by `acquire()` when the wait-queue is full (backpressure limit hit). */
export class QueueFullError extends Error {
  constructor(public readonly maxQueueDepth: number) {
    super(`Concurrency wait-queue is full (max ${maxQueueDepth} waiting).`);
    this.name = "QueueFullError";
  }
}

/**
 * Thrown by `acquire()` when the caller waited longer than its budget, or when
 * its `AbortSignal` fired while queued.
 *
 * Semantically equivalent to {@link QueueFullError} for the caller — the server
 * is saturated — so HTTP handlers should map both to 503 + `Retry-After`. Kept
 * as a distinct type so metrics/logs can tell "queue was already full" apart
 * from "we queued but never got a turn in time".
 */
export class AcquireTimeoutError extends Error {
  constructor(
    public readonly waitedMs: number,
    public readonly aborted: boolean = false,
  ) {
    super(
      aborted
        ? `Aborted while waiting ${waitedMs}ms for a concurrency slot.`
        : `Timed out after ${waitedMs}ms waiting for a concurrency slot.`,
    );
    this.name = "AcquireTimeoutError";
  }
}

export interface AcquireOptions {
  /** Max time to wait for a slot. Omitted/0 = wait indefinitely (legacy). */
  timeoutMs?: number;
  /** Abort the wait when this fires (e.g. the flow's execution-timeout signal). */
  signal?: AbortSignal;
}

/** A queued caller. `settled` guards against handing a slot to a gone waiter. */
interface Waiter {
  resolve: () => void;
  settled: boolean;
}

export class Semaphore {
  private count: number;
  private readonly queue: Waiter[] = [];

  /**
   * @param maxConcurrent Maximum number of slots held concurrently.
   * @param maxQueueDepth Maximum number of callers allowed to WAIT for a slot.
   *                      0 (default) means an unbounded queue.
   */
  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueueDepth: number = 0,
  ) {
    this.count = maxConcurrent;
  }

  async acquire(opts: AcquireOptions = {}): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    if (this.maxQueueDepth > 0 && this.queue.length >= this.maxQueueDepth) {
      throw new QueueFullError(this.maxQueueDepth);
    }

    // Already-aborted signal: fail immediately rather than joining the queue.
    if (opts.signal?.aborted === true) {
      throw new AcquireTimeoutError(0, true);
    }

    const timeoutMs = opts.timeoutMs ?? 0;
    const startedAt = Date.now();
    const waiter: Waiter = { resolve: () => {}, settled: false };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        waiter.resolve = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          resolve();
        };
        this.queue.push(waiter);

        const fail = (err: Error): void => {
          if (waiter.settled) return;
          waiter.settled = true;
          // Leave the settled entry for `release()` to skip rather than
          // splicing here: an O(n) splice per timeout would be quadratic under
          // a mass timeout, which is exactly when the queue is longest.
          reject(err);
        };

        if (timeoutMs > 0) {
          timer = setTimeout(
            () => fail(new AcquireTimeoutError(Date.now() - startedAt, false)),
            timeoutMs,
          );
        }
        if (opts.signal !== undefined) {
          onAbort = (): void =>
            fail(new AcquireTimeoutError(Date.now() - startedAt, true));
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined && opts.signal !== undefined) {
        opts.signal.removeEventListener("abort", onAbort);
      }
      // Drop settled entries that have bubbled to the front so `waiting`
      // reflects real waiters and the array does not grow without bound.
      this.pruneSettled();
    }
  }

  release(): void {
    // Skip callers that timed out / aborted while queued — handing the slot to
    // one of them would lose it permanently (nobody is left to release it).
    for (;;) {
      const next = this.queue.shift();
      if (next === undefined) {
        this.count++;
        return;
      }
      if (next.settled) continue;
      next.resolve();
      return;
    }
  }

  /** Removes already-settled waiters from the head of the queue. */
  private pruneSettled(): void {
    while (true) {
      const head = this.queue[0];
      if (head === undefined || !head.settled) break;
      this.queue.shift();
    }
  }

  /** Current number of available slots. */
  get available(): number {
    return this.count;
  }

  /** Number of requests genuinely waiting for a slot (settled ones excluded). */
  get waiting(): number {
    let n = 0;
    for (const w of this.queue) if (!w.settled) n++;
    return n;
  }

  /** Number of slots currently held (in flight). */
  get active(): number {
    return this.maxConcurrent - this.count;
  }

  /** Configured max wait-queue depth (0 = unbounded). */
  get queueLimit(): number {
    return this.maxQueueDepth;
  }
}
