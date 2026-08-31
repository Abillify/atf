// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for RedisIdempotencyStore's result parsing + fail-open behaviour.
 * The Lua script's atomicity is covered by the real-Redis integration suite;
 * here a fake client returns canned EVAL replies so the JS decoding of each
 * outcome (claimed / inflight / mismatch / replay) and the fail-open path are
 * deterministic and offline.
 */

import { describe, test, expect } from "bun:test";
import {
  RedisIdempotencyStore,
  type IdempotencyRedisClient,
  type IdempotencyRecord,
} from "../idempotency-store.js";

function clientReturning(
  reply: unknown | (() => unknown),
): IdempotencyRedisClient & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    send: async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return typeof reply === "function" ? (reply as () => unknown)() : reply;
    },
  };
}

const record: IdempotencyRecord = {
  model: "flow-x",
  responseText: "hello",
  finishReason: "stop",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("RedisIdempotencyStore.claim", () => {
  test("decodes 'claimed'", async () => {
    const store = new RedisIdempotencyStore(clientReturning("claimed"));
    expect(await store.claim("k", "fp")).toEqual({ status: "claimed" });
  });

  test("decodes 'inflight'", async () => {
    const store = new RedisIdempotencyStore(clientReturning("inflight"));
    expect(await store.claim("k", "fp")).toEqual({ status: "inflight" });
  });

  test("decodes 'mismatch'", async () => {
    const store = new RedisIdempotencyStore(clientReturning("mismatch"));
    expect(await store.claim("k", "fp")).toEqual({ status: "mismatch" });
  });

  test("decodes a completed record into a replay", async () => {
    const stored = JSON.stringify({
      fp: "fp",
      state: "done",
      record: JSON.stringify(record),
    });
    const store = new RedisIdempotencyStore(clientReturning(stored));
    const outcome = await store.claim("k", "fp");
    expect(outcome.status).toBe("replay");
    if (outcome.status === "replay") {
      expect(outcome.record).toEqual(record);
    }
  });

  test("fails open (claimed) on a Redis error", async () => {
    const store = new RedisIdempotencyStore(
      clientReturning(() => {
        throw new Error("redis down");
      }),
    );
    expect(await store.claim("k", "fp")).toEqual({ status: "claimed" });
  });
});

describe("RedisIdempotencyStore.complete / release", () => {
  test("complete issues an EVAL with the serialised record", async () => {
    const client = clientReturning(1);
    const store = new RedisIdempotencyStore(client);
    await store.complete("k", record);
    const call0 = client.calls[0];
    if (call0 === undefined) throw new Error("expected a client call");
    expect(call0[0]).toBe("EVAL");
    expect(call0).toContain(JSON.stringify(record));
  });

  test("release swallows Redis errors", async () => {
    const store = new RedisIdempotencyStore(
      clientReturning(() => {
        throw new Error("redis down");
      }),
    );
    // Must not throw.
    await store.release("k");
    expect(true).toBe(true);
  });
});
