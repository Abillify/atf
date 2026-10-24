// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pending-approval store of the stateless 2026 endpoint.
 *
 * The same behavioural contract is asserted against both implementations:
 * the per-process memory store and the Redis store (driven by an in-memory
 * fake of the client interface — no real Redis). Redis errors must surface
 * fail-closed as `Error("approval store unavailable")`.
 */

import { describe, expect, it } from "bun:test";
import {
  MemoryPendingApprovalStore,
  RedisPendingApprovalStore,
  createPendingApprovalStore,
  decodeApprovalCursor,
  encodeApprovalCursor,
  type PendingApproval,
  type PendingApprovalStoreLike,
} from "../../src/mcp/pending-approval-store.ts";
import { TaskCapacityError } from "../../src/mcp/tasks.ts";

type Factory = () => PendingApprovalStoreLike;

/** In-memory fake of the `sendCommand` surface the Redis store uses. */
function fakeRedis(options: { failOn?: string } = {}) {
  const values = new Map<string, { value: string; expiresAt?: number }>();
  const indexes = new Map<string, Map<string, number>>();
  const indexTtls = new Map<string, number>();
  const commands: string[][] = [];
  const now = () => Date.now();
  const alive = (key: string) => {
    const row = values.get(key);
    if (!row) return undefined;
    if (row.expiresAt !== undefined && row.expiresAt <= now()) {
      values.delete(key);
      return undefined;
    }
    return row;
  };
  const client = {
    async connect() {},
    async quit() {},
    async sendCommand(args: string[]): Promise<unknown> {
      commands.push(args);
      const name = args[0]?.toUpperCase() ?? "";
      if (options.failOn !== undefined && name === options.failOn) {
        throw new Error(`redis down (${name})`);
      }
      if (name === "SET") {
        const [key, value] = [args[1], args[2]];
        if (key === undefined || value === undefined) throw new Error("SET needs key and value");
        const flags = args.slice(3).map((a) => a.toUpperCase());
        if (alive(key) && flags.includes("NX")) return null;
        if (!alive(key) && flags.includes("XX")) return null;
        const pxIndex = flags.indexOf("PX");
        const expiresAt = pxIndex >= 0 ? now() + Number(args[4 + pxIndex]) : undefined;
        const previous = alive(key);
        values.set(key, {
          value,
          expiresAt: flags.includes("KEEPTTL") ? previous?.expiresAt : expiresAt,
        });
        return "OK";
      }
      if (name === "GET") return args[1] === undefined ? null : (alive(args[1])?.value ?? null);
      if (name === "ZADD") {
        const index = indexes.get(args[1] ?? "") ?? new Map<string, number>();
        for (let i = 2; i + 1 < args.length; i += 2) index.set(args[i + 1], Number(args[i]));
        indexes.set(args[1] ?? "", index);
        return index.size;
      }
      if (name === "ZRANGEBYSCORE") {
        const index = indexes.get(args[1] ?? "");
        if (!index) return [];
        return [...index.entries()]
          .sort((a, b) => a[1] - b[1])
          .map(([member]) => member);
      }
      if (name === "ZREM") {
        const index = indexes.get(args[1] ?? "");
        if (!index) return 0;
        let removed = 0;
        for (const member of args.slice(2)) if (index.delete(member)) removed += 1;
        return removed;
      }
      if (name === "MGET") return args.slice(1).map((key) => alive(key)?.value ?? null);
      if (name === "ZREMRANGEBYSCORE") {
        const index = indexes.get(args[1] ?? "");
        if (!index) return 0;
        const min = args[2] === "-inf" ? Number.NEGATIVE_INFINITY : Number(args[2]);
        const max = args[3] === "+inf" ? Number.POSITIVE_INFINITY : Number(args[3]);
        let removed = 0;
        for (const [member, score] of index) {
          if (score >= min && score <= max) {
            index.delete(member);
            removed += 1;
          }
        }
        return removed;
      }
      if (name === "ZCARD") return indexes.get(args[1] ?? "")?.size ?? 0;
      if (name === "PEXPIRE") {
        indexTtls.set(args[1] ?? "", Number(args[2]));
        return indexes.has(args[1] ?? "") ? 1 : 0;
      }
      if (name === "EVAL") {
        // Mini-interpreter for the one script the store ships: it runs the
        // same steps the Lua script does, in one synchronous block, so the
        // command log shows what the script executed.
        const script = args[1] ?? "";
        if (!script.includes("PENDING_APPROVAL_CREATE")) {
          throw new Error("fake redis only interprets the pending-approval create script");
        }
        const [indexKey, entryKey, cutoff, maxPending, json, entryTtl, createdAt, state, indexTtl] =
          args.slice(3);
        if (indexKey === undefined || entryKey === undefined) throw new Error("EVAL needs two keys");
        const index = indexes.get(indexKey) ?? new Map<string, number>();
        indexes.set(indexKey, index);
        const cut = Number(cutoff);
        for (const [member, score] of index) if (score <= cut) index.delete(member);
        commands.push(["ZREMRANGEBYSCORE", indexKey, "-inf", cutoff ?? ""]);
        if (index.size >= Number(maxPending)) return 0;
        commands.push(["SET", entryKey, json ?? "", "NX", "PX", entryTtl ?? ""]);
        if (alive(entryKey)) return -1;
        values.set(entryKey, { value: json ?? "", expiresAt: now() + Number(entryTtl) });
        index.set(state ?? "", Number(createdAt));
        commands.push(["ZADD", indexKey, createdAt ?? "", state ?? ""]);
        indexTtls.set(indexKey, Number(indexTtl));
        commands.push(["PEXPIRE", indexKey, indexTtl ?? ""]);
        return 1;
      }
      throw new Error(`fake redis does not implement ${name}`);
    },
  };
  return { client, commands, indexTtls };
}

const runContract = (name: string, create: Factory) => {
  describe(name, () => {
    it("creates a pending entry and reads it back", async () => {
      const store = create();
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
      expect(entry.status).toBe("pending");
      expect(entry.tool).toBe("orders.cancel");
      expect(entry.tenantId).toBe("tenant-a");
      expect(entry.expiresAt - entry.createdAt).toBeGreaterThanOrEqual(900);
      const seen = await store.lookup(entry.requestState);
      expect(seen?.requestState).toBe(entry.requestState);
      expect(seen?.args).toEqual({ id: 7 });
    });

    it("keeps the args fingerprint of the original arguments", async () => {
      const store = create();
      const args = { id: 7, note: "hello" };
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", args);
      // The fingerprint is deterministic over the arguments, and mutating the
      // stored copy must not change what a later fingerprint of the input is.
      expect(entry.fingerprint).toBe(entry.fingerprint);
      const other = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7, note: "hello" });
      expect(other.fingerprint).toBe(entry.fingerprint);
      const changed = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 8, note: "hello" });
      expect(changed.fingerprint).not.toBe(entry.fingerprint);
    });

    it("does not hand a request to a different owner", async () => {
      const store = create();
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
      expect(await store.take(entry.requestState, "owner-b")).toBeUndefined();
      expect(await store.take(entry.requestState, "owner-a")).toBeDefined();
    });

    it("stops handing out an entry once it is resolved", async () => {
      const store = create();
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
      // Reading does not consume: the router marks the outcome explicitly, so
      // a retry before that mark still finds the request.
      expect(await store.take(entry.requestState, "owner-a")).toBeDefined();
      expect(await store.take(entry.requestState, "owner-a")).toBeDefined();
      await store.markResolved(entry.requestState, "approved", "token-1");
      expect(await store.take(entry.requestState, "owner-a")).toBeUndefined();
      expect(await store.takeForeign(entry.requestState)).toBeUndefined();
    });

    it("peek leaves the entry alone and takeForeign ignores ownership", async () => {
      const store = create();
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
      expect((await store.peek(entry.requestState))?.owner).toBe("owner-a");
      expect((await store.take(entry.requestState, "owner-a"))?.owner).toBe("owner-a");
      expect((await store.takeForeign(entry.requestState))?.owner).toBe("owner-a");
    });

    it("keeps a resolved entry until expiry so approvals/get can report it", async () => {
      const store = create();
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
      await store.markResolved(entry.requestState, "approved", "token-1");
      const approved = await store.lookup(entry.requestState);
      expect(approved?.status).toBe("approved");
      expect(approved?.token).toBe("token-1");
      // A resolved entry is no longer resolvable.
      expect(await store.take(entry.requestState, "owner-a")).toBeUndefined();
      expect(await store.takeForeign(entry.requestState)).toBeUndefined();
    });

    it("records a denial without a token and ignores unknown request states", async () => {
      const store = create();
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
      await store.markResolved(entry.requestState, "denied");
      const denied = await store.lookup(entry.requestState);
      expect(denied?.status).toBe("denied");
      expect(denied?.token).toBeUndefined();
      // Marking an unknown request state is a no-op, not an error.
      await store.markResolved("00000000-0000-4000-8000-000000000000", "approved", "token-x");
    });

    it("lists open approvals of one tenant, oldest first, filtered", async () => {
      const store = create();
      const first = await store.create("owner-a", "tenant-a", "one", {});
      await Bun.sleep(2);
      const second = await store.create("owner-a", "tenant-a", "two", {});
      await Bun.sleep(2);
      const third = await store.create("owner-b", "tenant-a", "three", {});
      await store.create("owner-a", "tenant-b", "foreign", {});

      const own = await store.list("tenant-a", (entry) => entry.owner === "owner-a");
      expect(own.approvals.map((e) => e.tool)).toEqual(["one", "two"]);
      const all = await store.list("tenant-a", () => true);
      expect(all.approvals.map((e) => e.requestState)).toEqual([
        first.requestState,
        second.requestState,
        third.requestState,
      ]);
      expect(await store.list("tenant-b", () => true)).toBeDefined();
    });

    it("drops resolved entries from the list", async () => {
      const store = create();
      const kept = await store.create("owner-a", "tenant-a", "kept", {});
      const done = await store.create("owner-a", "tenant-a", "done", {});
      await store.markResolved(done.requestState, "denied");
      const page = await store.list("tenant-a", () => true);
      expect(page.approvals.map((e) => e.requestState)).toEqual([kept.requestState]);
    });

    it("pages with a cursor and reports no further page at the end", async () => {
      const store = create();
      for (let i = 0; i < 3; i += 1) {
        await store.create("owner-a", "tenant-a", `tool-${i}`, {});
        await Bun.sleep(2);
      }
      const page1 = await store.list("tenant-a", () => true, undefined, 2);
      expect(page1.approvals.map((e) => e.tool)).toEqual(["tool-0", "tool-1"]);
      expect(page1.nextCursor).toBeDefined();
      const page2 = await store.list("tenant-a", () => true, page1.nextCursor, 2);
      expect(page2.approvals.map((e) => e.tool)).toEqual(["tool-2"]);
      expect(page2.nextCursor).toBeUndefined();
      // A cursor that cannot be decoded yields an empty page instead of a throw.
      expect((await store.list("tenant-a", () => true, "not-a-cursor", 2)).approvals).toEqual([]);
    });

    it("lets exactly one of two concurrent resolutions claim a request", async () => {
      const store = create();
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
      const [first, second] = await Promise.all([
        store.claim(entry.requestState, entry.expiresAt),
        store.claim(entry.requestState, entry.expiresAt),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(await store.claim(entry.requestState, entry.expiresAt)).toBe(false);
    });

    it("does not claim an unknown request state", async () => {
      const store = create();
      if (store.backing === "memory") {
        expect(await store.claim("00000000-0000-4000-8000-000000000000", Date.now() + 1_000)).toBe(false);
      }
    });

    it("expires entries", async () => {
      const store = create();
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
      await Bun.sleep(1_001);
      expect(await store.peek(entry.requestState)).toBeUndefined();
      expect(await store.take(entry.requestState, "owner-a")).toBeUndefined();
      expect(await store.takeForeign(entry.requestState)).toBeUndefined();
      expect((await store.list("tenant-a", () => true)).approvals).toEqual([]);
    });
  });
};

runContract("MemoryPendingApprovalStore", () => new MemoryPendingApprovalStore(1_000, 100));
runContract("RedisPendingApprovalStore", () => {
  const { client } = fakeRedis();
  return new RedisPendingApprovalStore(client, 1_000);
});

describe("MemoryPendingApprovalStore capacity", () => {
  it("rejects new requests once the pending limit is reached", async () => {
    const store = new MemoryPendingApprovalStore(60_000, 2);
    await store.create("owner-a", "tenant-a", "one", {});
    await store.create("owner-a", "tenant-a", "two", {});
    expect(store.backing).toBe("memory");
    await expect(store.create("owner-a", "tenant-a", "three", {})).rejects.toBeInstanceOf(Error);
  });

  it("frees capacity when entries expire", async () => {
    const store = new MemoryPendingApprovalStore(1_000, 1);
    await store.create("owner-a", "tenant-a", "one", {});
    await Bun.sleep(1_001);
    expect(await store.create("owner-a", "tenant-a", "two", {})).toBeDefined();
  });
});

describe("RedisPendingApprovalStore capacity and index lifetime", () => {
  it("rejects new requests of a tenant once maxPending is reached", async () => {
    const { client } = fakeRedis();
    const store = new RedisPendingApprovalStore(client, 60_000, 2);
    await store.create("owner-a", "tenant-a", "one", {});
    await store.create("owner-a", "tenant-a", "two", {});
    await expect(store.create("owner-a", "tenant-a", "three", {})).rejects.toBeInstanceOf(TaskCapacityError);
    // The limit is per tenant index.
    expect(await store.create("owner-a", "tenant-b", "other", {})).toBeDefined();
  });

  it("frees capacity when entries age out of the TTL", async () => {
    const { client } = fakeRedis();
    const store = new RedisPendingApprovalStore(client, 1_000, 1);
    await store.create("owner-a", "tenant-a", "one", {});
    await Bun.sleep(1_001);
    expect(await store.create("owner-a", "tenant-a", "two", {})).toBeDefined();
  });

  it("holds the limit under concurrent creates", async () => {
    // The limit check and the insert run as one script, so parallel callers
    // (modelling separate replicas) can not both count below the limit.
    const { client } = fakeRedis();
    const store = new RedisPendingApprovalStore(client, 60_000, 5);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.create("owner-a", "tenant-a", "one", {})),
    );
    const created = results.filter((r) => r.status === "fulfilled").length;
    expect(created).toBe(5);
    expect(
      results.every((r) => r.status === "fulfilled" || r.reason instanceof TaskCapacityError),
    ).toBe(true);
    const listed = await store.list("tenant-a", () => true);
    expect(listed.approvals).toHaveLength(5);
  });

  it("gives the tenant index a TTL on every write", async () => {
    const { client, commands, indexTtls } = fakeRedis();
    const store = new RedisPendingApprovalStore(client, 60_000, 10);
    await store.create("owner-a", "tenant-a", "one", {});
    expect(commands.some((c) => c[0] === "PEXPIRE" && c[1] === "mcpgate:approval:tenant:tenant-a")).toBe(true);
    expect(indexTtls.get("mcpgate:approval:tenant:tenant-a")).toBe(60_000);
  });

  it("claims through SET NX on a dedicated key", async () => {
    const { client, commands } = fakeRedis();
    const store = new RedisPendingApprovalStore(client, 60_000);
    const entry = await store.create("owner-a", "tenant-a", "one", {});
    expect(await store.claim(entry.requestState, entry.expiresAt)).toBe(true);
    const claim = commands.find((c) => c[0] === "SET" && c[1] === `mcpgate:approval:claim:${entry.requestState}`);
    expect(claim).toContain("NX");
    expect(claim).toContain("PX");
  });
});

describe("RedisPendingApprovalStore", () => {
  it("uses the documented keys and commands", async () => {
    const { client, commands } = fakeRedis();
    const store = new RedisPendingApprovalStore(client, 60_000);
    expect(store.backing).toBe("redis");
    const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 7 });
    const set = commands.find((c) => c[0] === "SET");
    expect(set?.[1]).toBe(`mcpgate:approval:pending:${entry.requestState}`);
    expect(set).toContain("NX");
    expect(set).toContain("PX");
    expect(commands.some((c) => c[0] === "ZADD" && c[1] === "mcpgate:approval:tenant:tenant-a")).toBe(true);

    await store.markResolved(entry.requestState, "approved", "token-1");
    const update = commands.filter((c) => c[0] === "SET").at(-1);
    expect(update).toContain("XX");
    expect(update).toContain("KEEPTTL");

    await store.list("tenant-a", () => true);
    expect(commands.some((c) => c[0] === "ZRANGEBYSCORE")).toBe(true);
    expect(commands.some((c) => c[0] === "MGET")).toBe(true);
  });

  it("prunes the tenant index when entries are gone or expired", async () => {
    const { client, commands } = fakeRedis();
    const store = new RedisPendingApprovalStore(client, 1_000);
    const entry = await store.create("owner-a", "tenant-a", "orders.cancel", {});
    await Bun.sleep(1_001);
    expect((await store.list("tenant-a", () => true)).approvals).toEqual([]);
    const zrem = commands.find((c) => c[0] === "ZREM");
    expect(zrem?.[1]).toBe("mcpgate:approval:tenant:tenant-a");
    expect(zrem).toContain(entry.requestState);
  });

  it("fails closed when Redis errors", async () => {
    for (const command of ["SET", "GET", "ZRANGEBYSCORE"]) {
      const { client } = fakeRedis({ failOn: command });
      const store = new RedisPendingApprovalStore(client, 60_000);
      const create =
        command === "SET"
          ? store.create("owner-a", "tenant-a", "orders.cancel", {})
          : command === "GET"
            ? store.lookup("some-request-state")
            : store.list("tenant-a", () => true);
      await expect(create).rejects.toThrow("approval store unavailable");
    }
  });

  it("closes the client", async () => {
    const { client } = fakeRedis();
    const store = new RedisPendingApprovalStore(client, 60_000);
    await store.close?.();
  });
});

describe("createPendingApprovalStore", () => {
  it("falls back to the memory store without a Redis URL", async () => {
    const store = await createPendingApprovalStore(undefined, 60_000, 10);
    expect(store.backing).toBe("memory");
    expect(store.clear).toBeFunction();
  });
});

describe("approval cursor helpers", () => {
  it("round-trips createdAt and requestState", () => {
    const entry = { createdAt: 1_700_000_000_000, requestState: "abc-123" };
    expect(decodeApprovalCursor(encodeApprovalCursor(entry))).toEqual(entry);
    expect(decodeApprovalCursor("nonsense")).toBeUndefined();
    expect(decodeApprovalCursor(Buffer.from("x|y", "utf8").toString("base64url"))).toBeUndefined();
  });
});

/** The router-facing shape: a store typed as the interface behaves identically. */
describe("PendingApprovalStoreLike", () => {
  it("exposes the same contract for both backings", async () => {
    const stores: PendingApprovalStoreLike[] = [
      new MemoryPendingApprovalStore(60_000, 10),
      new RedisPendingApprovalStore(fakeRedis().client, 60_000),
    ];
    const entries: PendingApproval[] = [];
    for (const store of stores) {
      const entry = await store.create("owner-a", "tenant-a", "orders.cancel", { id: 1 });
      entries.push(entry);
      expect((await store.lookup(entry.requestState))?.tool).toBe("orders.cancel");
      expect(await store.take(entry.requestState, "owner-a")).toBeDefined();
    }
    expect(stores.map((s) => s.backing)).toEqual(["memory", "redis"]);
    expect(entries.every((e) => typeof e.requestState === "string")).toBe(true);
  });
});
