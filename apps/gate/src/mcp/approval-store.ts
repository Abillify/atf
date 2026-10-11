// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { logger } from "../logger.ts";

/**
 * Store for redeemed approval-token JTIs (Req 6.1).
 *
 * `consume` returns `true` for the first redemption of a JTI and `false` for
 * every later one, so an approval token can only ever be spent once. With
 * Redis configured the reservation is atomic across replicas (`SET NX`); the
 * memory implementation is the explicit single-process fallback.
 */
export interface ApprovalConsumptionStore {
  readonly backing: "memory" | "redis";
  /** Atomically mark `jti` as consumed until `exp` (epoch ms). False means it was already redeemed. */
  consume(jti: string, exp: number): Promise<boolean>;
  healthcheck?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Single-process fallback. Expired JTIs are dropped on every access; when the
 * map is at capacity the entry closest to expiry is evicted (min-heap on
 * `exp`), never an arbitrary FIFO victim — evicting a live JTI would let its
 * approval token be redeemed twice, and the soonest-expiring one is the
 * reservation that protects the least time anyway (Req 6.1: evict by `exp`,
 * not FIFO).
 */
export class MemoryApprovalConsumptionStore implements ApprovalConsumptionStore {
  readonly backing = "memory" as const;
  private readonly used = new Map<string, number>();
  /** Binary min-heap ordered by `exp`; entries are removed lazily via the map. */
  private readonly heap: Array<{ jti: string; exp: number }> = [];

  constructor(private readonly maxEntries = 10_000) {}

  async consume(jti: string, exp: number): Promise<boolean> {
    const now = Date.now();
    for (let top = this.heap[0]; top !== undefined && top.exp <= now; top = this.heap[0]) {
      const popped = this.popHeap();
      if (popped !== undefined && this.used.get(popped.jti) === popped.exp)
        this.used.delete(popped.jti);
    }
    if (this.used.has(jti)) return false;
    while (this.used.size >= this.maxEntries && this.evictOne());
    this.used.set(jti, exp);
    this.pushHeap(jti, exp);
    return true;
  }

  /** Remove the live entry with the smallest `exp`. False when none is left. */
  private evictOne(): boolean {
    for (;;) {
      const top = this.popHeap();
      if (top === undefined) return false;
      if (this.used.get(top.jti) === top.exp) {
        this.used.delete(top.jti);
        return true;
      }
    }
  }

  private pushHeap(jti: string, exp: number): void {
    const heap = this.heap;
    heap.push({ jti, exp });
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const a = heap[parent];
      const b = heap[i];
      if (a === undefined || b === undefined || a.exp <= b.exp) break;
      heap[parent] = b;
      heap[i] = a;
      i = parent;
    }
  }

  private popHeap(): { jti: string; exp: number } | undefined {
    const heap = this.heap;
    const top = heap[0];
    if (top === undefined) return undefined;
    const last = heap.pop() as { jti: string; exp: number };
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        const current = heap[smallest] as { jti: string; exp: number };
        const leftEntry = heap[left];
        if (leftEntry !== undefined && leftEntry.exp < current.exp) smallest = left;
        const rightEntry = heap[right];
        if (rightEntry !== undefined && rightEntry.exp < (heap[smallest] as { jti: string; exp: number }).exp)
          smallest = right;
        if (smallest === i) break;
        const swapWith = heap[smallest] as { jti: string; exp: number };
        heap[smallest] = current;
        heap[i] = swapWith;
        i = smallest;
      }
    }
    return top;
  }
}

interface RedisLike {
  connect(): Promise<unknown>;
  set(key: string, value: string, options: { NX: true; PXAT: number }): Promise<string | null>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  on?(event: string, listener: (error: Error) => void): void;
}

/**
 * Shared cross-replica implementation: `SET atf:approval:{jti} 1 PXAT exp NX`
 * reserves the JTI atomically and lets Redis drop the key at `exp`, so the
 * reservation lives exactly as long as the token could still be replayed.
 */
export class RedisApprovalConsumptionStore implements ApprovalConsumptionStore {
  readonly backing = "redis" as const;
  constructor(
    private readonly client: RedisLike,
    private readonly prefix: string,
  ) {}

  async consume(jti: string, exp: number): Promise<boolean> {
    return (await this.client.set(`${this.prefix}${jti}`, "1", { NX: true, PXAT: exp })) === "OK";
  }

  async healthcheck(): Promise<void> {
    if ((await this.client.ping()) !== "PONG")
      throw new Error("Approval Redis did not return PONG");
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * Redis-backed when a URL is available; otherwise the single-process memory
 * map. Unlike the webhook replay store this does NOT throw in production
 * without Redis: a single-replica production deployment is safe with the
 * memory map, and the production-readiness gate turns multi-replica-without-
 * Redis into a fatal startup error (`MCPGATE_REPLICAS`, Req 6.1).
 */
export async function createApprovalConsumptionStore(
  redisUrl: string | undefined,
  environment: string,
  prefix = "atf:approval:",
): Promise<ApprovalConsumptionStore> {
  if (!redisUrl) {
    if (environment === "production") {
      logger.warn(
        "approval consumption store using the single-process memory map — safe only " +
          "with MCPGATE_REPLICAS=1 (the production-readiness gate enforces this)",
      );
    }
    return new MemoryApprovalConsumptionStore();
  }
  const redis = await import("redis");
  const client = redis.createClient({ url: redisUrl }) as unknown as RedisLike;
  client.on?.("error", (error) => logger.error(`approval redis error: ${error.message}`));
  await client.connect();
  return new RedisApprovalConsumptionStore(client, prefix);
}

/**
 * Process-wide fallback used by `GovernancePolicy` when no store is injected
 * (tests, auxiliary dispatch paths). The application wires the real store
 * through `McpServerDeps.approvalStore`.
 */
export const defaultApprovalConsumptionStore: ApprovalConsumptionStore =
  new MemoryApprovalConsumptionStore();
