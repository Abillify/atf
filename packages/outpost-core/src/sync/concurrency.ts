// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Bounded concurrency for uploads and deletions (requirements 8.12, 10.6).
 *
 * A counting semaphore with `maxConcurrentUploads` permits plus a pause flag:
 * while paused no NEW permit is handed out, but transfers that already hold
 * one run to completion (10.6). Waiters can be released early via an
 * `AbortSignal`; an already-aborted signal never acquires. Fairness follows
 * the FIFO order of the internal waiter queue, so no waiter starves.
 */

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

/** A counting semaphore with pause/resume and abortable acquisition. */
export class Semaphore {
  readonly #max: number;
  #active = 0;
  #paused = false;
  readonly #waiters: Waiter[] = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`max muss eine positive ganze Zahl sein: ${max}`);
    }
    this.#max = max;
  }

  /** Permits currently handed out. */
  get active(): number {
    return this.#active;
  }

  /** Waiters blocked on `acquire`. */
  get waiting(): number {
    return this.#waiters.length;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Stop handing out new permits; running transfers finish (10.6). */
  pause(): void {
    this.#paused = true;
  }

  /** Resume handing out permits; queued waiters proceed in FIFO order. */
  resume(): void {
    this.#paused = false;
    this.#drain();
  }

  /**
   * Take a permit. Resolves once one is available; rejects with the abort
   * reason when `signal` fires while waiting (or was already aborted).
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal !== undefined && Boolean(signal.aborted)) {
      return Promise.reject(abortError(signal));
    }
    if (!this.#paused && this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: undefined,
      };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  /** Give a permit back and let the next queued waiter start. */
  release(): void {
    this.#active -= 1;
    if (this.#active < 0) {
      throw new Error("Semaphore über released: mehr releases als acquires");
    }
    this.#drain();
  }

  /** Run `fn` while holding one permit; the permit returns even on error. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  #drain(): void {
    while (!this.#paused && this.#active < this.#max && this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) break;
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.#active += 1;
      waiter.resolve();
    }
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : "aborted");
  error.name = "AbortError";
  return error;
}

/** True when the signal is set — `Boolean` for the TS 7 `false | undefined` typing. */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && Boolean(signal.aborted);
}
