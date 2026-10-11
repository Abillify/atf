// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property 16 (SSE buffer, Requirement 9.1):
 * "For arbitrary event sequences the rendered list after the flush equals
 * the last `maxEvents` events in arrival order."
 *
 * The store is exercised directly (no React needed — `useSyncExternalStore`
 * hands `useMonitoringEvents` exactly `getSnapshot()`), with arbitrary event
 * sequences, arbitrary capacities, and flushes interleaved at arbitrary
 * points, including mid-batch flushes and clears.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as fc from "fast-check";
import {
  DEFAULT_FLUSH_INTERVAL_MS,
  MonitoringEventStore,
} from "../lib/monitoring-event-store";
import { RingBuffer } from "../lib/ring-buffer";

describe("RingBuffer (property)", () => {
  test("toArray is always the last `capacity` pushed items in order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.array(fc.integer(), { minLength: 0, maxLength: 500 }),
        (capacity, items) => {
          const buf = new RingBuffer<number>(capacity);
          for (const item of items) buf.push(item);
          expect(buf.size).toBe(Math.min(items.length, capacity));
          expect(buf.toArray()).toEqual(items.slice(-capacity));
        },
      ),
      { numRuns: 300 },
    );
  });

  test("interleaved push/clear rounds preserve the invariant per round", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.array(fc.array(fc.integer(), { maxLength: 100 }), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.boolean(),
        (capacity, rounds, clearBetween) => {
          const buf = new RingBuffer<number>(capacity);
          let live: number[] = [];
          for (const round of rounds) {
            for (const item of round) {
              buf.push(item);
              live = [...live, item].slice(-capacity);
            }
            expect(buf.toArray()).toEqual(live);
            if (clearBetween) {
              buf.clear();
              live = [];
              expect(buf.toArray()).toEqual([]);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("MonitoringEventStore (property 16)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("after a flush the snapshot equals the last maxEvents events in input order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.array(fc.integer(), { maxLength: 40 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (maxEvents, batches) => {
          const store = new MonitoringEventStore<number>(maxEvents);
          const received: number[] = [];
          for (const batch of batches) {
            for (const event of batch) {
              store.push(event);
              received.push(event);
            }
            // Flush at an arbitrary point in the sequence — the rendered
            // list must always be the suffix of everything pushed so far.
            store.flush();
            expect(store.getSnapshot()).toEqual(
              received.slice(-maxEvents),
            );
          }
          store.destroy();
        },
      ),
      { numRuns: 300 },
    );
  });

  test("time-based flushes deliver the same suffix as an explicit flush", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.array(
          fc.record({
            events: fc.array(fc.integer(), { maxLength: 30 }),
            // ms advanced between bursts — may or may not cross the window
            waitMs: fc.integer({ min: 0, max: 600 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (maxEvents, bursts) => {
          const store = new MonitoringEventStore<number>(maxEvents);
          const received: number[] = [];
          // Model of the store's flush timing: the timer starts on the first
          // push after an empty pending batch and fires 200 ms later.
          let pushed = 0;
          let flushed = 0;
          let scheduledAt: number | null = null;
          let clock = 0;
          for (const burst of bursts) {
            for (const event of burst.events) {
              store.push(event);
              received.push(event);
              pushed += 1;
              if (scheduledAt === null)
                scheduledAt = clock + DEFAULT_FLUSH_INTERVAL_MS;
            }
            clock += burst.waitMs;
            vi.advanceTimersByTime(burst.waitMs);
            if (scheduledAt !== null && clock >= scheduledAt) {
              flushed = pushed;
              scheduledAt = null;
            }
            // At every point the rendered list must equal the last maxEvents
            // of exactly the events flushed so far — never more, never fewer.
            expect(store.getSnapshot()).toEqual(
              received.slice(0, flushed).slice(-maxEvents),
            );
          }
          // After a final explicit flush everything is visible.
          store.flush();
          expect(store.getSnapshot()).toEqual(received.slice(-maxEvents));
          store.destroy();
        },
      ),
      { numRuns: 300 },
    );
  });

  test("clear resets the suffix baseline for subsequent events", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(
          fc.record({
            events: fc.array(fc.integer(), { maxLength: 25 }),
            thenClear: fc.boolean(),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (maxEvents, rounds) => {
          const store = new MonitoringEventStore<number>(maxEvents);
          let baseline: number[] = [];
          for (const round of rounds) {
            for (const event of round.events) {
              store.push(event);
              baseline = [...baseline, event].slice(-maxEvents);
            }
            store.flush();
            expect(store.getSnapshot()).toEqual(baseline);
            if (round.thenClear) {
              store.clear();
              baseline = [];
              expect(store.getSnapshot()).toEqual([]);
            }
          }
          store.destroy();
        },
      ),
      { numRuns: 200 },
    );
  });

  test("React is notified at most once per flush window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.integer({ min: 0, max: 50 }), {
          minLength: 1,
          maxLength: 60,
        }),
        (maxEvents, gapsMs) => {
          const store = new MonitoringEventStore<number>(maxEvents);
          let notifications = 0;
          store.subscribe(() => {
            notifications += 1;
          });
          for (const [i, gap] of gapsMs.entries()) {
            store.push(i);
            vi.advanceTimersByTime(gap);
          }
          // Drain all timers so every scheduled flush runs.
          vi.runOnlyPendingTimers();
          // Never more notifications than pushed events — bursts inside one
          // 200 ms window always coalesce into a single flush.
          expect(notifications).toBeLessThanOrEqual(gapsMs.length);
          store.destroy();
        },
      ),
      { numRuns: 200 },
    );
  });
});
