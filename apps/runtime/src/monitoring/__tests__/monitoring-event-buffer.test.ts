// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the shared (Redis) monitoring event buffer.
 *
 * A tiny in-memory fake of the Bun RedisClient `send` surface implements just
 * the commands the buffer uses (INCR + sorted-set ops), so the shared-sequence
 * id assignment and the `since` backfill are verified without a real Redis.
 * (A real-Redis integration test still belongs in the gated integration suite.)
 */

import { describe, test, expect } from "bun:test";
import { RedisEventBuffer } from "../monitoring-service.js";
import type { RedisClientLike } from "../../util/redis-client.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";

/** Minimal in-memory Redis supporting INCR + ZADD/ZREMRANGEBYRANK/ZRANGEBYSCORE. */
function fakeRedis(): RedisClientLike & { counters: Map<string, number> } {
  const counters = new Map<string, number>();
  const zsets = new Map<string, Array<{ score: number; member: string }>>();

  const send = async (command: string, args: string[]): Promise<unknown> => {
    const cmd = command.toUpperCase();
    if (cmd === "INCR") {
      const key = args[0];
      if (key === undefined) throw new Error("INCR requires a key");
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }
    if (cmd === "ZADD") {
      const [key, score, member] = args as [string, string, string];
      const set = zsets.get(key) ?? [];
      set.push({ score: Number(score), member });
      set.sort((a, b) => a.score - b.score);
      zsets.set(key, set);
      return 1;
    }
    if (cmd === "ZREMRANGEBYRANK") {
      const [key, start, stop] = args as [string, string, string];
      const set = zsets.get(key) ?? [];
      // Only the negative-stop trim form used by the buffer is needed here.
      const n = set.length;
      const s = Number(start);
      const e = Number(stop);
      const from = s < 0 ? n + s : s;
      const to = e < 0 ? n + e : e;
      if (from <= to) set.splice(from, to - from + 1);
      zsets.set(key, set);
      return 0;
    }
    if (cmd === "ZRANGEBYSCORE") {
      const [key, min] = args as [string, string, string];
      const set = zsets.get(key) ?? [];
      const exclusive = min.startsWith("(");
      const minScore = Number(exclusive ? min.slice(1) : min);
      return set
        .filter((e) => (exclusive ? e.score > minScore : e.score >= minScore))
        .map((e) => e.member);
    }
    throw new Error(`unexpected command: ${cmd}`);
  };

  return { send, counters };
}

const ev = (nodeId: string): NodeExecutionEvent => ({
  execution_id: "exec-1",
  node_id: nodeId,
  status: "running",
  start_time: "2025-01-01T00:00:00Z",
  end_time: null,
  latency_ms: null,
});

describe("RedisEventBuffer (shared sequence)", () => {
  test("append assigns a monotonic shared id from INCR", async () => {
    const buf = new RedisEventBuffer(fakeRedis(), 100);
    const id1 = await buf.append(ev("a"));
    const id2 = await buf.append(ev("b"));
    const id3 = await buf.append(ev("c"));
    expect([id1, id2, id3]).toEqual(["1", "2", "3"]);
  });

  test("since returns only events after the given id, in order", async () => {
    const buf = new RedisEventBuffer(fakeRedis(), 100);
    await buf.append(ev("a")); // 1
    await buf.append(ev("b")); // 2
    await buf.append(ev("c")); // 3

    const missed = await buf.since("1");
    expect(missed.map((m) => m.id)).toEqual(["2", "3"]);
    expect(missed.map((m) => m.event.node_id)).toEqual(["b", "c"]);
  });

  test("since('0') / invalid returns nothing (fresh connections start live)", async () => {
    const buf = new RedisEventBuffer(fakeRedis(), 100);
    await buf.append(ev("a"));
    expect(await buf.since("0")).toEqual([]);
    expect(await buf.since("nope")).toEqual([]);
  });

  test("a shared client is one sequence across two buffer instances (replicas)", async () => {
    const shared = fakeRedis();
    const replicaA = new RedisEventBuffer(shared, 100);
    const replicaB = new RedisEventBuffer(shared, 100);

    const a1 = await replicaA.append(ev("a")); // 1
    const b1 = await replicaB.append(ev("b")); // 2 — shared counter
    expect([a1, b1]).toEqual(["1", "2"]);

    // A client that was on replica A (last id "1") reconnects to replica B and
    // still sees the event it missed, because the buffer is shared.
    const missedOnB = await replicaB.since("1");
    expect(missedOnB.map((m) => m.event.node_id)).toEqual(["b"]);
  });

  test("preserves events whose JSON contains a colon", async () => {
    const buf = new RedisEventBuffer(fakeRedis(), 100);
    await buf.append(ev("first")); // id 1
    const withColon: NodeExecutionEvent = {
      ...ev("weird"),
      error_message: "boom: at 12:00",
    };
    await buf.append(withColon); // id 2

    const missed = await buf.since("1");
    expect(missed).toHaveLength(1);
    const missed0 = missed[0];
    if (missed0 === undefined) throw new Error("expected a missed event");
    expect(missed0.id).toBe("2");
    expect(missed0.event.node_id).toBe("weird");
    expect(missed0.event.error_message).toBe("boom: at 12:00");
  });
});
