// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it, vi } from "vitest";
import { QueueSaturatedError, createWorkQueue, mapOrdered } from "../src/queue.js";

/** A task that resolves when the test tells it to. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createWorkQueue", () => {
  it("runs up to the concurrency limit at once", async () => {
    const queue = createWorkQueue({ concurrency: 2, maxDepth: 10 });
    const first = deferred();
    const second = deferred();
    const third = deferred();
    let started = 0;

    const tasks = [first, second, third].map((gate) =>
      queue.submit(async () => {
        started++;
        await gate.promise;
      }),
    );

    await vi.waitFor(() => expect(started).toBe(2));
    expect(queue.state()).toMatchObject({ active: 2, depth: 1 });

    // Releasing a slot must promote the queued task.
    first.resolve();
    await vi.waitFor(() => expect(started).toBe(3));

    second.resolve();
    third.resolve();
    await Promise.all(tasks);
    expect(queue.state()).toMatchObject({ active: 0, depth: 0 });
  });

  it("rejects immediately once the queue is full", async () => {
    // Refusing work you cannot do soon is more useful than accepting it and being
    // slow forever — and the rejection happens before the upload is processed.
    const queue = createWorkQueue({ concurrency: 1, maxDepth: 1 });
    const running = deferred();
    const queued = deferred();

    const first = queue.submit(async () => {
      await running.promise;
    });
    const second = queue.submit(async () => {
      await queued.promise;
    });

    await expect(queue.submit(async () => undefined)).rejects.toBeInstanceOf(QueueSaturatedError);

    running.resolve();
    queued.resolve();
    await Promise.all([first, second]);
  });

  it("reports the saturated state on the error", async () => {
    const queue = createWorkQueue({ concurrency: 1, maxDepth: 1 });
    const gate = deferred();
    const first = queue.submit(async () => {
      await gate.promise;
    });
    const second = queue.submit(async () => {
      await gate.promise;
    });

    try {
      await queue.submit(async () => undefined);
      expect.unreachable("should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(QueueSaturatedError);
      expect((error as QueueSaturatedError).state).toMatchObject({ depth: 1, maxDepth: 1 });
    }

    gate.resolve();
    await Promise.all([first, second]);
  });

  it("releases the slot when a task throws", async () => {
    const queue = createWorkQueue({ concurrency: 1, maxDepth: 1 });
    await expect(
      queue.submit(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A leaked slot would wedge the service after the first failed conversion.
    expect(queue.state()).toMatchObject({ active: 0, depth: 0 });
    await expect(queue.submit(async () => "ok")).resolves.toBe("ok");
  });

  it("reports queued position and start timing", async () => {
    const queue = createWorkQueue({ concurrency: 1, maxDepth: 2 });
    const gate = deferred();
    const first = queue.submit(async () => gate.promise);
    const queued: number[] = [];
    const started: number[] = [];
    const second = queue.submit(async () => undefined, {
      onQueued: (state) => queued.push(state.position),
      onStarted: (state) => started.push(state.queueMs),
    });

    expect(queued).toEqual([1]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toHaveLength(1);
    expect(started[0]).toBeGreaterThanOrEqual(0);
  });

  it.each(["onQueued", "onStarted"] as const)(
    "restores capacity when %s throws for an immediate task",
    async (hookName) => {
      const queue = createWorkQueue({ concurrency: 1, maxDepth: 1 });
      await expect(
        queue.submit(async () => undefined, {
          [hookName]: () => {
            throw new Error(`${hookName} failed`);
          },
        }),
      ).rejects.toThrow(`${hookName} failed`);
      expect(queue.state()).toMatchObject({ active: 0, depth: 0 });
      await expect(queue.submit(async () => "ok")).resolves.toBe("ok");
    },
  );

  it("removes a waiting task when its onQueued hook throws", async () => {
    const queue = createWorkQueue({ concurrency: 1, maxDepth: 2 });
    const gate = deferred();
    const running = queue.submit(async () => gate.promise);

    await expect(
      queue.submit(async () => undefined, {
        onQueued: () => {
          throw new Error("queued hook failed");
        },
      }),
    ).rejects.toThrow("queued hook failed");
    expect(queue.state()).toMatchObject({ active: 1, depth: 0 });

    gate.resolve();
    await running;
    expect(queue.state()).toMatchObject({ active: 0, depth: 0 });
  });

  it("reports state changes for metrics", async () => {
    const states: Array<{ depth: number; active: number }> = [];
    const queue = createWorkQueue({
      concurrency: 1,
      maxDepth: 4,
      onStateChange: (state) => states.push({ depth: state.depth, active: state.active }),
    });
    await queue.submit(async () => undefined);
    expect(states.length).toBeGreaterThan(0);
  });
});

describe("mapOrdered", () => {
  it("emits results in input order despite out-of-order completion", async () => {
    // A reader watching a document appear needs page 3 after page 2, regardless of
    // which model call finished first.
    const emitted: number[] = [];
    const delays = [40, 5, 20, 1];

    const results = await mapOrdered(
      delays,
      4,
      async (delay, index) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return index;
      },
      (value) => {
        emitted.push(value);
      },
    );

    expect(results).toEqual([0, 1, 2, 3]);
    expect(emitted).toEqual([0, 1, 2, 3]);
  });

  it("respects the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapOrdered(Array.from({ length: 10 }, (_, i) => i), 3, async (item) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return item;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("propagates the first failure", async () => {
    await expect(
      mapOrdered([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("page 2 failed");
        return item;
      }),
    ).rejects.toThrow("page 2 failed");
  });

  it("handles an empty input", async () => {
    await expect(mapOrdered([], 4, async () => 1)).resolves.toEqual([]);
  });

  it("runs a single item without a pool", async () => {
    await expect(mapOrdered([7], 4, async (item) => item * 2)).resolves.toEqual([14]);
  });
});
