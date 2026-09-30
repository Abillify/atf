// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Feature: extract-outpost, Property 25: Begrenzung der Nebenläufigkeit
 *
 * Für jede Menge von Upload-Aufgaben mit beliebigen Laufzeiten und jedes
 * Limit k >= 1 sind zu keinem Zeitpunkt mehr als k Übertragungen gleichzeitig
 * aktiv, und alle Aufgaben werden abgeschlossen. Nach einer Pause startet
 * keine neue Übertragung, bis fortgesetzt wird.
 *
 * **Validates: Requirements 8.12, 10.6**
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Semaphore } from "../../src/sync/concurrency.js";

/** Resolve after `ms` of simulated work (real timers, tiny values). */
const work = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface TaskSpec {
  id: number;
  durationMs: number;
}

const taskSpecArb = (count: number): fc.Arbitrary<TaskSpec[]> =>
  fc.array(
    fc.record({
      id: fc.nat(),
      durationMs: fc.constantFrom(0, 1, 2, 3),
    }),
    { minLength: count, maxLength: count },
  );

/**
 * Run `tasks` through a semaphore with `k` permits, tracking the number of
 * concurrently active transfers. Returns the peak and the completion count.
 */
async function runTracked(
  tasks: readonly TaskSpec[],
  k: number,
): Promise<{ peak: number; done: number }> {
  const semaphore = new Semaphore(k);
  let active = 0;
  let peak = 0;
  let done = 0;

  await Promise.all(
    tasks.map(async (task) => {
      await semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await work(task.durationMs);
        active -= 1;
        done += 1;
      });
    }),
  );
  return { peak, done };
}

describe("Property 25: Begrenzung der Nebenläufigkeit", () => {
  it("nie mehr als k aktive Übertragungen und alle Aufgaben fertig", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 12 }),
        async (k, taskCount) => {
          const tasks = Array.from({ length: taskCount }, (_, i) => ({
            id: i,
            durationMs: i % 4,
          }));
          const { peak, done } = await runTracked(tasks, k);
          expect(peak).toBeLessThanOrEqual(k);
          expect(done).toBe(taskCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("generierte Aufgaben mit beliebigen Laufzeiten bleiben begrenzt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        taskSpecArb(8),
        async (k, tasks) => {
          const { peak, done } = await runTracked(tasks, k);
          expect(peak).toBeLessThanOrEqual(k);
          expect(done).toBe(tasks.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("nach pause() startet keine neue Übertragung bis resume()", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (k) => {
        const semaphore = new Semaphore(k);
        let active = 0;
        let peak = 0;
        const started: number[] = [];

        const task = (id: number): Promise<void> =>
          semaphore.run(async () => {
            started.push(id);
            active += 1;
            peak = Math.max(peak, active);
            await work(1);
            active -= 1;
          });

        // Fill all permits, then queue more work and pause.
        const running: Promise<void>[] = [];
        for (let i = 0; i < k; i++) running.push(task(i));
        await Promise.resolve();
        semaphore.pause();
        const queued: Promise<void>[] = [];
        for (let i = k; i < k + 3; i++) queued.push(task(i));
        await work(3);

        // While paused: only the initial k started, none of the queued ones.
        expect(started.length).toBe(k);
        expect(peak).toBeLessThanOrEqual(k);

        semaphore.resume();
        await Promise.all([...running, ...queued]);
        expect(started.length).toBe(k + 3);
        expect(peak).toBeLessThanOrEqual(k);
      }),
      { numRuns: 100 },
    );
  });

  it("ein bereits abortedes Signal erwirbt nie ein Permit", async () => {
    const semaphore = new Semaphore(2);
    const controller = new AbortController();
    controller.abort("logout");
    await expect(semaphore.acquire(controller.signal)).rejects.toThrow();
    expect(semaphore.active).toBe(0);
  });

  it("gibt ein Permit bei Abbruch eines Wartenden nicht doppelt frei", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (k) => {
        const semaphore = new Semaphore(k);
        // Occupy every permit.
        const held: (() => void)[] = [];
        for (let i = 0; i < k; i++) {
          await semaphore.acquire();
          held.push(() => semaphore.release());
        }
        // Two waiters; one aborts, one must still get a permit on release.
        const aborter = new AbortController();
        const abortedWait = semaphore.acquire(aborter.signal);
        const survivorWait = semaphore.acquire();
        await Promise.resolve();
        expect(semaphore.waiting).toBe(2);
        aborter.abort("shutdown");
        await expect(abortedWait).rejects.toThrow();
        for (const release of held) release();
        await survivorWait;
        expect(semaphore.active).toBe(1);
      }),
      { numRuns: 100 },
    );
  });
});
