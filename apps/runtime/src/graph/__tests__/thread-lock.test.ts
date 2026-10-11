// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the conversation thread lock.
 *
 * Verifies the in-process keyed mutex serialises same-key holders, allows
 * different keys to run concurrently, releases cleanly (bounded memory), and
 * that the Redis lock implementation issues the expected SET NX PX / EVAL
 * commands against a fake client.
 */

import { describe, test, expect } from "bun:test";
import {
  InProcessThreadLock,
  RedisThreadLock,
  type LockRedisClient,
} from "../thread-lock.js";
import { createMetrics } from "../../observability/metrics.js";

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("InProcessThreadLock", () => {
  test("serialises holders of the same key (no interleaving)", async () => {
    const lock = new InProcessThreadLock();
    const order: string[] = [];

    const run = async (tag: string): Promise<void> => {
      const h = await lock.acquire("conv-1");
      order.push(`${tag}:start`);
      await tick(10);
      order.push(`${tag}:end`);
      await h.release();
    };

    await Promise.all([run("A"), run("B")]);

    // Whichever ran first must fully finish before the other starts.
    const aStart = order.indexOf("A:start");
    const aEnd = order.indexOf("A:end");
    const bStart = order.indexOf("B:start");
    const bEnd = order.indexOf("B:end");
    const serialised = aEnd < bStart || bEnd < aStart;
    expect(serialised).toBe(true);
  });

  test("different keys run concurrently", async () => {
    const lock = new InProcessThreadLock();
    const h1 = await lock.acquire("k1");
    // A second key should acquire without waiting on k1.
    const h2 = await lock.acquire("k2");
    expect(lock.size).toBe(2);
    await h1.release();
    await h2.release();
    expect(lock.size).toBe(0);
  });

  test("releases drain the key map (bounded memory)", async () => {
    const lock = new InProcessThreadLock();
    const h = await lock.acquire("k");
    expect(lock.size).toBe(1);
    await h.release();
    expect(lock.size).toBe(0);
  });

  test("double release is a no-op", async () => {
    const lock = new InProcessThreadLock();
    const h = await lock.acquire("k");
    await h.release();
    await h.release(); // must not throw
    expect(lock.size).toBe(0);
  });
});

describe("RedisThreadLock", () => {
  function fakeClient(): {
    client: LockRedisClient;
    calls: Array<{ cmd: string; args: string[] }>;
  } {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let held = false;
    const client: LockRedisClient = {
      async send(cmd: string, args: string[]): Promise<unknown> {
        calls.push({ cmd, args });
        if (cmd === "SET") {
          if (held) return null; // NX fails while held
          held = true;
          return "OK";
        }
        if (cmd === "EVAL") {
          held = false;
          return 1;
        }
        return null;
      },
    };
    return { client, calls };
  }

  test("acquire issues SET NX PX and release issues EVAL", async () => {
    const { client, calls } = fakeClient();
    const lock = new RedisThreadLock(client);
    const h = await lock.acquire("conv-x");

    const setCall = calls.find((c) => c.cmd === "SET");
    expect(setCall).toBeDefined();
    if (setCall === undefined) throw new Error("expected a SET call");
    expect(setCall.args).toContain("NX");
    expect(setCall.args).toContain("PX");

    await h.release();
    expect(calls.some((c) => c.cmd === "EVAL")).toBe(true);
  });

  test("fails open (proceeds) when Redis throws", async () => {
    const client: LockRedisClient = {
      async send(): Promise<unknown> {
        throw new Error("redis down");
      },
    };
    const lock = new RedisThreadLock(client);
    // Must resolve (not hang / not throw) so traffic is never blocked.
    const h = await lock.acquire("conv-y");
    await h.release();
    expect(true).toBe(true);
  });

  test("fail-open on a Redis error counts aiperator_degraded_total (Req 7.8)", async () => {
    const m = createMetrics(true);
    const client: LockRedisClient = {
      async send(): Promise<unknown> {
        throw new Error("redis down");
      },
    };
    const lock = new RedisThreadLock(client, undefined, undefined, m);
    const h = await lock.acquire("conv-z");
    await h.release();
    expect(m.render()).toContain(
      'aiperator_degraded_total{component="thread_lock"} 1',
    );
  });
});
