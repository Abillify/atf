// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Approval-consumption store (Req 6.1).
 *
 * The contract being pinned: a JTI can be redeemed exactly once until its
 * `exp`, the memory fallback evicts by `exp` (never FIFO), and Redis stores
 * the reservation atomically with `SET NX PXAT` so replicas agree.
 */

import { describe, expect, it } from "bun:test";
import {
  MemoryApprovalConsumptionStore,
  RedisApprovalConsumptionStore,
  createApprovalConsumptionStore,
} from "../../src/mcp/approval-store.ts";

describe("MemoryApprovalConsumptionStore", () => {
  it("redeems a JTI exactly once", async () => {
    const store = new MemoryApprovalConsumptionStore();
    const exp = Date.now() + 60_000;
    expect(await store.consume("jti-1", exp)).toBe(true);
    expect(await store.consume("jti-1", exp)).toBe(false);
    expect(await store.consume("jti-2", exp)).toBe(true);
  });

  it("forgets a JTI once its exp has passed", async () => {
    const store = new MemoryApprovalConsumptionStore();
    const now = Date.now();
    expect(await store.consume("short", now + 5)).toBe(true);
    await Bun.sleep(10);
    // The token itself would be rejected past exp anyway; the reservation is
    // dropped so the map does not grow with dead entries.
    expect(await store.consume("short", now + 5)).toBe(true);
  });

  it("evicts the entry closest to expiry when at capacity, never FIFO", async () => {
    const store = new MemoryApprovalConsumptionStore(3);
    const now = Date.now();
    // Inserted first, but expiring last — a FIFO store would evict it first.
    expect(await store.consume("late", now + 900_000)).toBe(true);
    expect(await store.consume("soon", now + 100_000)).toBe(true);
    expect(await store.consume("middle", now + 500_000)).toBe(true);
    // Capacity reached: the next insert must evict `soon` (smallest exp).
    expect(await store.consume("newer", now + 700_000)).toBe(true);
    // The survivors stay redeemed (checked first — a rejected consume does not
    // mutate the store, while a successful one would evict another entry).
    expect(await store.consume("late", now + 900_000)).toBe(false);
    expect(await store.consume("middle", now + 500_000)).toBe(false);
    expect(await store.consume("newer", now + 700_000)).toBe(false);
    // The evicted `soon` can be reserved again.
    expect(await store.consume("soon", now + 100_000)).toBe(true);
  });

  it("keeps the heap consistent across many inserts past capacity", async () => {
    const store = new MemoryApprovalConsumptionStore(8);
    const now = Date.now();
    const exps = Array.from({ length: 40 }, (_, i) => now + 10_000 * (i + 1));
    for (const [i, exp] of exps.entries()) {
      expect(await store.consume(`jti-${i}`, exp)).toBe(true);
    }
    // Only the 8 largest expirations survive. Check them first (a rejected
    // consume does not mutate), then the evicted ones (each re-insert evicts
    // again, which is fine once the survivors are verified).
    for (let i = exps.length - 1; i >= exps.length - 8; i--) {
      expect(await store.consume(`jti-${i}`, exps[i])).toBe(false);
    }
    for (let i = exps.length - 9; i >= 0; i--) {
      expect(await store.consume(`jti-${i}`, exps[i])).toBe(true);
    }
  });
});

interface SetCall {
  key: string;
  value: string;
  options: { NX: true; PXAT: number };
}

function stubRedis(result: "OK" | null) {
  const calls: SetCall[] = [];
  let pings = 0;
  let quits = 0;
  const client = {
    async connect() {},
    async set(key: string, value: string, options: { NX: true; PXAT: number }) {
      calls.push({ key, value, options });
      return result;
    },
    async ping() {
      pings += 1;
      return "PONG";
    },
    async quit() {
      quits += 1;
    },
  };
  return {
    client,
    calls,
    pingCount: () => pings,
    quitCount: () => quits,
  };
}

describe("RedisApprovalConsumptionStore", () => {
  it("reserves with SET NX PXAT at the token's exp", async () => {
    const stub = stubRedis("OK");
    const store = new RedisApprovalConsumptionStore(stub.client, "atf:approval:");
    const exp = Date.now() + 300_000;
    expect(await store.consume("abc", exp)).toBe(true);
    expect(stub.calls).toEqual([
      { key: "atf:approval:abc", value: "1", options: { NX: true, PXAT: exp } },
    ]);
  });

  it("reports an already-redeemed JTI as false", async () => {
    const stub = stubRedis(null);
    const store = new RedisApprovalConsumptionStore(stub.client, "atf:approval:");
    expect(await store.consume("abc", Date.now() + 1000)).toBe(false);
  });

  it("healthchecks via ping and closes via quit", async () => {
    const stub = stubRedis("OK");
    const store = new RedisApprovalConsumptionStore(stub.client, "atf:approval:");
    await store.healthcheck();
    expect(stub.pingCount()).toBe(1);
    await store.close();
    expect(stub.quitCount()).toBe(1);
  });
});

describe("createApprovalConsumptionStore", () => {
  it("falls back to the memory map without a Redis URL", async () => {
    const store = await createApprovalConsumptionStore(undefined, "development");
    expect(store.backing).toBe("memory");
    expect(store.healthcheck).toBeUndefined();
  });

  it("stays on the memory map in production (the prod gate polices replicas)", async () => {
    // Unlike webhook replay protection, single-replica production is safe on
    // the memory map; MCPGATE_REPLICAS > 1 without Redis is the fatal case.
    const store = await createApprovalConsumptionStore(undefined, "production");
    expect(store.backing).toBe("memory");
  });
});
