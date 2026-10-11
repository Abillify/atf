// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RingBuffer } from "../lib/ring-buffer";
import {
  DEFAULT_FLUSH_INTERVAL_MS,
  MonitoringEventStore,
} from "../lib/monitoring-event-store";

describe("RingBuffer", () => {
  test("rejects a non-positive capacity", () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-3)).toThrow(RangeError);
    expect(() => new RingBuffer(1.5)).toThrow(RangeError);
  });

  test("keeps insertion order below capacity", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  test("drops the oldest element once full", () => {
    const buf = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) buf.push(n);
    expect(buf.size).toBe(3);
    expect(buf.toArray()).toEqual([3, 4, 5]);
  });

  test("wraps around the internal array correctly over many pushes", () => {
    const capacity = 4;
    const buf = new RingBuffer<number>(capacity);
    for (let n = 0; n < 100; n += 1) buf.push(n);
    expect(buf.toArray()).toEqual([96, 97, 98, 99]);
  });

  test("pushMany appends in order", () => {
    const buf = new RingBuffer<string>(3);
    buf.pushMany(["a", "b", "c", "d"]);
    expect(buf.toArray()).toEqual(["b", "c", "d"]);
  });

  test("clear resets size and order", () => {
    const buf = new RingBuffer<number>(2);
    buf.pushMany([1, 2, 3]);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toEqual([]);
    buf.push(7);
    expect(buf.toArray()).toEqual([7]);
  });
});

describe("MonitoringEventStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("events are invisible to React until the flush interval elapses", () => {
    const store = new MonitoringEventStore<number>(10);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    store.push(1);
    store.push(2);
    expect(store.getSnapshot()).toEqual([]);
    expect(notifications).toBe(0);

    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
    expect(store.getSnapshot()).toEqual([1, 2]);
    expect(notifications).toBe(1);
    store.destroy();
  });

  test("a burst within one window produces exactly one flush", () => {
    const store = new MonitoringEventStore<number>(100);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });

    for (let i = 0; i < 50; i += 1) {
      store.push(i);
      // Timer never completes inside the window.
      vi.advanceTimersByTime(1);
    }
    expect(notifications).toBe(0);

    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
    expect(notifications).toBe(1);
    expect(store.getSnapshot()).toHaveLength(50);
    store.destroy();
  });

  test("snapshot reference is stable between flushes", () => {
    const store = new MonitoringEventStore<number>(10);
    const first = store.getSnapshot();
    store.push(1);
    expect(store.getSnapshot()).toBe(first); // pending, not flushed
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    // Further reads without new events keep the same reference.
    expect(store.getSnapshot()).toBe(second);
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS * 5);
    expect(store.getSnapshot()).toBe(second);
    store.destroy();
  });

  test("flush() delivers immediately and is a no-op when empty", () => {
    const store = new MonitoringEventStore<number>(10);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.flush();
    expect(notifications).toBe(0);
    store.push(1);
    store.flush();
    expect(store.getSnapshot()).toEqual([1]);
    expect(notifications).toBe(1);
    // The scheduled flush must not fire a second notification afterwards.
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS * 2);
    expect(notifications).toBe(1);
    store.destroy();
  });

  test("snapshot respects the ring capacity (oldest dropped)", () => {
    const store = new MonitoringEventStore<number>(3);
    for (const n of [1, 2, 3, 4, 5]) store.push(n);
    store.flush();
    expect(store.getSnapshot()).toEqual([3, 4, 5]);
    store.destroy();
  });

  test("clear empties everything and notifies once", () => {
    const store = new MonitoringEventStore<number>(10);
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.push(1);
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
    expect(store.getSnapshot()).toEqual([1]);

    store.clear();
    expect(store.getSnapshot()).toEqual([]);
    expect(notifications).toBe(2);
    // Clearing an already-empty store does not notify again.
    store.clear();
    expect(notifications).toBe(2);
    store.destroy();
  });

  test("clear also drops the not-yet-flushed pending batch", () => {
    const store = new MonitoringEventStore<number>(10);
    store.push(1);
    store.push(2);
    store.clear();
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS * 2);
    expect(store.getSnapshot()).toEqual([]);
    store.destroy();
  });

  test("unsubscribe stops notifications, destroy detaches all", () => {
    const store = new MonitoringEventStore<number>(10);
    let a = 0;
    let b = 0;
    const unsubA = store.subscribe(() => {
      a += 1;
    });
    store.subscribe(() => {
      b += 1;
    });
    unsubA();
    store.push(1);
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
    expect(a).toBe(0);
    expect(b).toBe(1);
    store.destroy();
    store.push(2);
    vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
    expect(b).toBe(1);
  });
});
