// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cancellation and bounded waiting.
 *
 * Three defects are pinned here, all facets of one problem: the execution
 * deadline was not actually a deadline.
 *
 *   1. `Semaphore.acquire()` waited forever. A stalled run held its slot, every
 *      later caller queued behind it — including clients that had already
 *      disconnected — so a freed slot got spent on a flow nobody was reading.
 *   2. `InProcessThreadLock.acquire()` waited forever, so one stuck turn on a
 *      conversation blocked every later turn of that thread indefinitely, each
 *      blocked turn holding a concurrency slot while it waited.
 *   3. The flow's `AbortSignal` reached `graph.stream()` only. Handlers that set
 *      their own `abortSignal` REPLACED it, so the provider call outlived the
 *      timeout: the engine released the slot and sent `[DONE]` while tokens kept
 *      arriving.
 */

import { describe, test, expect } from "bun:test";
import {
  Semaphore,
  QueueFullError,
  AcquireTimeoutError,
} from "../semaphore.js";
import { InProcessThreadLock } from "../thread-lock.js";
import { combineAbortSignals } from "../exec-runtime.js";

/** `combineAbortSignals` for two defined signals (always returns a combined signal). */
function combineDefined(a: AbortSignal, b: AbortSignal): AbortSignal {
  const combined = combineAbortSignals(a, b);
  if (combined === undefined) throw new Error("expected a combined signal");
  return combined;
}

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

describe("Semaphore — bounded wait", () => {
  test("an uncontended acquire is immediate and unaffected", async () => {
    const sem = new Semaphore(2);
    await sem.acquire({ timeoutMs: 50 });
    await sem.acquire({ timeoutMs: 50 });
    expect(sem.available).toBe(0);
    expect(sem.active).toBe(2);
  });

  test("a waiter that exceeds its budget rejects instead of hanging", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    await expect(sem.acquire({ timeoutMs: 20 })).rejects.toBeInstanceOf(
      AcquireTimeoutError,
    );
  });

  test("an aborted signal rejects the wait", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const controller = new AbortController();
    const pending = sem.acquire({ signal: controller.signal });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcquireTimeoutError);
    expect((err as AcquireTimeoutError).aborted).toBe(true);
  });

  test("an ALREADY-aborted signal fails fast without queueing", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const controller = new AbortController();
    controller.abort();
    await expect(
      sem.acquire({ signal: controller.signal }),
    ).rejects.toBeInstanceOf(AcquireTimeoutError);
    expect(sem.waiting).toBe(0);
  });

  test("a slot is NOT lost when its intended waiter already timed out", async () => {
    // The regression this guards: `release()` handed the slot directly to the
    // head of the queue. If that waiter had given up, the slot went to a caller
    // that would never release it — permanently shrinking capacity.
    const sem = new Semaphore(1);
    await sem.acquire();

    await expect(sem.acquire({ timeoutMs: 10 })).rejects.toBeInstanceOf(
      AcquireTimeoutError,
    );
    sem.release();

    // Capacity must be fully restored.
    expect(sem.available).toBe(1);
    await sem.acquire({ timeoutMs: 20 });
    expect(sem.active).toBe(1);
  });

  test("a live waiter still gets the slot ahead of a timed-out one", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const doomed = sem.acquire({ timeoutMs: 10 }).catch(() => "timed-out");
    await tick(30); // let it expire while still queued
    let liveAcquired = false;
    const live = sem.acquire({ timeoutMs: 500 }).then(() => {
      liveAcquired = true;
    });

    expect(await doomed).toBe("timed-out");
    sem.release();
    await live;
    expect(liveAcquired).toBe(true);
  });

  test("`waiting` excludes callers that have given up", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    const a = sem.acquire({ timeoutMs: 10 }).catch(() => undefined);
    const b = sem.acquire({ timeoutMs: 10_000 }).catch(() => undefined);
    await tick(5);
    expect(sem.waiting).toBe(2);
    await a;
    // The expired waiter no longer counts toward observed backpressure.
    expect(sem.waiting).toBe(1);
    sem.release();
    await b;
  });

  test("a full queue still rejects with QueueFullError, not a timeout", async () => {
    const sem = new Semaphore(1, 1);
    await sem.acquire();
    const queued = sem.acquire({ timeoutMs: 10_000 }).catch(() => undefined);
    await tick(5);
    await expect(sem.acquire({ timeoutMs: 10_000 })).rejects.toBeInstanceOf(
      QueueFullError,
    );
    sem.release();
    await queued;
  });

  test("no timeout and no signal preserves the legacy unbounded wait", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    let resolved = false;
    const pending = sem.acquire().then(() => {
      resolved = true;
    });
    await tick(30);
    expect(resolved).toBe(false);
    sem.release();
    await pending;
    expect(resolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// InProcessThreadLock
// ---------------------------------------------------------------------------

describe("InProcessThreadLock — bounded wait", () => {
  test("serialises holders on the same key when uncontended by timeouts", async () => {
    const lock = new InProcessThreadLock();
    const order: string[] = [];

    const first = await lock.acquire("conv-1");
    const second = lock.acquire("conv-1").then(async (h) => {
      order.push("second");
      await h.release();
    });

    await tick(10);
    expect(order).toEqual([]); // still blocked behind the first holder
    order.push("first");
    await first.release();
    await second;
    expect(order).toEqual(["first", "second"]);
  });

  test("different keys never block each other", async () => {
    const lock = new InProcessThreadLock();
    const a = await lock.acquire("conv-a");
    const b = await lock.acquire("conv-b"); // must not wait on `a`
    await a.release();
    await b.release();
    expect(lock.size).toBe(0);
  });

  test("a wait that exceeds its budget proceeds WITHOUT the lock (fail-open)", async () => {
    // Blocking forever is a guaranteed outage; a missed lock only risks
    // interleaved checkpoint writes. The Redis implementation already made this
    // trade-off, and the in-process one now matches it.
    const lock = new InProcessThreadLock();
    const holder = await lock.acquire("conv-1");

    const started = Date.now();
    const handle = await lock.acquire("conv-1", { maxWaitMs: 20 });
    expect(Date.now() - started).toBeLessThan(500);

    // The returned handle owns nothing, so releasing it is a safe no-op.
    await handle.release();
    await holder.release();
  });

  test("an aborted signal also gives up the wait", async () => {
    const lock = new InProcessThreadLock();
    const holder = await lock.acquire("conv-1");
    const controller = new AbortController();
    const pending = lock.acquire("conv-1", { signal: controller.signal });
    controller.abort();
    const handle = await pending;
    await handle.release();
    await holder.release();
  });

  test("giving up does not strand the waiters queued behind us", async () => {
    // The chain bug this guards: a waiter that abandons its turn must still
    // resolve its own link, or everyone behind it waits on a holder that will
    // never run.
    const lock = new InProcessThreadLock();
    const holder = await lock.acquire("conv-1");

    const giveUp = await lock.acquire("conv-1", { maxWaitMs: 10 });
    await giveUp.release();

    let thirdGotIt = false;
    const third = lock.acquire("conv-1", { maxWaitMs: 2000 }).then(async (h) => {
      thirdGotIt = true;
      await h.release();
    });

    await holder.release();
    await third;
    expect(thirdGotIt).toBe(true);
  });

  test("no budget preserves the legacy unbounded wait", async () => {
    const lock = new InProcessThreadLock();
    const holder = await lock.acquire("conv-1");
    let acquired = false;
    const pending = lock.acquire("conv-1").then(async (h) => {
      acquired = true;
      await h.release();
    });
    await tick(30);
    expect(acquired).toBe(false);
    await holder.release();
    await pending;
    expect(acquired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// combineAbortSignals — the fix for "replaced instead of combined"
// ---------------------------------------------------------------------------

describe("combineAbortSignals", () => {
  test("returns undefined when there is nothing to watch", () => {
    expect(combineAbortSignals()).toBeUndefined();
    expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
  });

  test("returns the single signal unwrapped", () => {
    const c = new AbortController();
    expect(combineAbortSignals(c.signal, undefined)).toBe(c.signal);
    expect(combineAbortSignals(undefined, c.signal)).toBe(c.signal);
  });

  test("fires when the FLOW deadline fires (the regression)", () => {
    // Previously the handler's own controller replaced the flow signal, so the
    // provider call ignored EXECUTION_TIMEOUT_MS entirely.
    const flow = new AbortController();
    const ownGuard = new AbortController();
    const combined = combineDefined(flow.signal, ownGuard.signal);
    expect(combined.aborted).toBe(false);
    flow.abort();
    expect(combined.aborted).toBe(true);
  });

  test("fires when the handler's own guard fires", () => {
    const flow = new AbortController();
    const ownGuard = new AbortController();
    const combined = combineDefined(flow.signal, ownGuard.signal);
    ownGuard.abort();
    expect(combined.aborted).toBe(true);
  });

  test("an already-aborted input yields an already-aborted result", () => {
    const flow = new AbortController();
    flow.abort();
    const combined = combineDefined(flow.signal, new AbortController().signal);
    expect(combined.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withRetry — an aborted run stops retrying MCP calls
// ---------------------------------------------------------------------------

describe("withRetry honours the execution deadline", () => {
  test("stops retrying once the signal fires", async () => {
    const { withRetry } = await import("../../mcp/wrapper/tool-proxy.js");
    const controller = new AbortController();
    let attempts = 0;

    const pending = withRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) controller.abort();
        throw new Error("boom");
      },
      { maxAttempts: 5, delayMs: 1, timeoutMs: 500, serverName: "test-mcp" },
    ).catch((e: unknown) => e);

    // Without a signal this would burn all 5 attempts. With one, the loop is
    // expected to stop — the run is over, so further attempts only cost money.
    const err = await withRetry(
      async () => {
        attempts += 1;
        throw new Error("boom");
      },
      {
        maxAttempts: 5,
        delayMs: 1,
        timeoutMs: 500,
        serverName: "test-mcp",
        signal: controller.signal,
      },
    ).catch((e: unknown) => e);

    await pending;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("aborted");
  });

  test("an already-aborted signal makes zero attempts", async () => {
    const { withRetry } = await import("../../mcp/wrapper/tool-proxy.js");
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;

    const err = await withRetry(
      async () => {
        attempts += 1;
        return "unreachable";
      },
      { serverName: "test-mcp", signal: controller.signal },
    ).catch((e: unknown) => e);

    expect(attempts).toBe(0);
    expect((err as Error).message).toContain("aborted");
  });

  test("cleans up the parent listener and ignores a late rejection after abort", async () => {
    const { withRetry } = await import("../../mcp/wrapper/tool-proxy.js");
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let activeAbortListeners = 0;
    signal.addEventListener = ((type: "abort", listener: () => void, options?: AddEventListenerOptions | boolean) => {
      if (type === "abort") activeAbortListeners += 1;
      originalAdd(type, listener, options);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: "abort", listener: () => void, options?: EventListenerOptions | boolean) => {
      if (type === "abort") activeAbortListeners -= 1;
      originalRemove(type, listener, options);
    }) as typeof signal.removeEventListener;

    let rejectUnderlying: ((error: Error) => void) | undefined;
    const pending = withRetry(
      () => new Promise<string>((_resolve, reject) => { rejectUnderlying = reject; }),
      { maxAttempts: 1, timeoutMs: 10_000, serverName: "test-mcp", signal },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(activeAbortListeners).toBe(0);
    rejectUnderlying?.(new Error("late transport rejection"));
    await Promise.resolve();
  });

  test("clears the attempt timeout after a successful call", async () => {
    const { withRetry } = await import("../../mcp/wrapper/tool-proxy.js");
    let abortedAfterSuccess = false;
    await withRetry(
      async (signal) => {
        signal?.addEventListener("abort", () => { abortedAfterSuccess = true; });
        return "ok";
      },
      { maxAttempts: 1, timeoutMs: 10, serverName: "test-mcp" },
    );
    await Bun.sleep(25);
    expect(abortedAfterSuccess).toBe(false);
  });

  test("without a signal the retry behaviour is unchanged", async () => {
    const { withRetry } = await import("../../mcp/wrapper/tool-proxy.js");
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("transient");
        return "ok";
      },
      { maxAttempts: 3, delayMs: 1, timeoutMs: 500, serverName: "test-mcp" },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});
