// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the Semaphore + bounded wait-queue (backpressure).
 */

import { describe, test, expect } from "bun:test";
import { Semaphore, QueueFullError } from "../semaphore.js";

describe("Semaphore — concurrency", () => {
  test("grants up to maxConcurrent slots immediately", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.available).toBe(0);
    expect(sem.active).toBe(2);
  });

  test("queues waiters beyond the limit and hands off slots on release", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    let acquired = false;
    const pending = sem.acquire().then(() => {
      acquired = true;
    });
    expect(sem.waiting).toBe(1);
    expect(acquired).toBe(false);
    sem.release();
    await pending;
    expect(acquired).toBe(true);
  });

    test("serves higher-priority waiters first and keeps FIFO for ties", async () => {
      const sem = new Semaphore(1);
      await sem.acquire();
      const order: string[] = [];
      const low = sem.acquire({ priority: 10 }).then(() => order.push("low"));
      const high = sem.acquire({ priority: 90 }).then(() => order.push("high"));
      const tied = sem.acquire({ priority: 90 }).then(() => order.push("tied"));

      sem.release();
      await high;
      sem.release();
      await tied;
      sem.release();
      await low;

      expect(order).toEqual(["high", "tied", "low"]);
    });
});

describe("Semaphore — bounded queue (backpressure)", () => {
  test("rejects with QueueFullError when the wait-queue is full", async () => {
    const sem = new Semaphore(1, 1); // 1 concurrent, 1 queued
    await sem.acquire(); // holds the only slot
    const queued = sem.acquire(); // fills the queue (1 waiting)
    expect(sem.waiting).toBe(1);

    await expect(sem.acquire()).rejects.toBeInstanceOf(QueueFullError);

    // Drain
    sem.release();
    await queued;
  });

  test("unbounded queue (0) never rejects", async () => {
    const sem = new Semaphore(1, 0);
    await sem.acquire();
    const a = sem.acquire();
    const b = sem.acquire();
    expect(sem.waiting).toBe(2);
    sem.release();
    sem.release();
    await Promise.all([a, b]);
    expect(sem.queueLimit).toBe(0);
  });

  test("exposes active/waiting/available state", async () => {
    const sem = new Semaphore(2, 5);
    await sem.acquire();
    expect(sem.active).toBe(1);
    expect(sem.available).toBe(1);
    expect(sem.queueLimit).toBe(5);
  });
});
