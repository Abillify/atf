// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for cluster-wide approval coordination. A shared in-memory fake Redis
 * (command store + pub/sub bus) backs two DistributedApprovalRegistry instances
 * standing in for two replicas. Verifies:
 *   - a pending approval raised on replica A is listed from replica B,
 *   - a decision POSTed to replica B settles the waiter parked on replica A,
 *   - resolving an unknown id returns false,
 *   - the mirror entry is removed once the approval settles.
 */

import { describe, expect, it } from "bun:test";
import { createApprovalGate } from "../approval-gate.js";
import type { ApprovalGateConfig, ApprovalRegistry } from "../approval-gate.js";
import {
  DistributedApprovalRegistry,
  type ApprovalRedis,
  type ApprovalRedisCommand,
} from "../distributed-approval.js";

/** `createApprovalGate` for a config known to enable the gate (never undefined). */
function mustCreateApprovalGate(config: ApprovalGateConfig): ApprovalRegistry {
  const gate = createApprovalGate(config);
  if (gate === undefined)
    throw new Error("expected the approval gate to be enabled");
  return gate;
}

/** Shared backing store + pub/sub bus for all fake clients in one test. */
class FakeRedisBus {
  readonly store = new Map<string, string>();
  readonly subscribers = new Map<string, ((msg: string) => void)[]>();

  command(): ApprovalRedisCommand {
    return {
      send: async (command: string, args: string[]): Promise<unknown> => {
        const cmd = command.toUpperCase();
        const [key, value] = args;
        if (key === undefined)
          throw new Error(`${command}: expected a key argument`);
        if (cmd === "SET") {
          if (value === undefined)
            throw new Error("SET: expected a value argument");
          this.store.set(key, value);
          return "OK";
        }
        if (cmd === "GET") return this.store.get(key) ?? null;
        if (cmd === "DEL") return this.store.delete(key) ? 1 : 0;
        if (cmd === "EXISTS") return this.store.has(key) ? 1 : 0;
        if (cmd === "SCAN") {
          // args: [cursor, "MATCH", pattern, "COUNT", n] — return all in one pass.
          const prefix = (args[2] ?? "*").replace(/\*$/, "");
          const keys = [...this.store.keys()].filter((k) =>
            k.startsWith(prefix),
          );
          return ["0", keys];
        }
        throw new Error(`unsupported ${command}`);
      },
    };
  }

  redis(): ApprovalRedis {
    const command = this.command() as ApprovalRedisCommand & {
      publish?: unknown;
    };
    return {
      command,
      publish: async (channel: string, message: string): Promise<unknown> => {
        for (const cb of this.subscribers.get(channel) ?? []) cb(message);
        return 1;
      },
      subscribe: async (
        channel: string,
        handler: (msg: string) => void,
      ): Promise<void> => {
        const list = this.subscribers.get(channel) ?? [];
        list.push(handler);
        this.subscribers.set(channel, list);
      },
      close: async (): Promise<void> => {},
    };
  }
}

function makeReplica(bus: FakeRedisBus): DistributedApprovalRegistry {
  const local = mustCreateApprovalGate({ enabled: true, timeoutMs: 60_000 });
  return new DistributedApprovalRegistry(local, bus.redis(), 90);
}

describe("DistributedApprovalRegistry", () => {
  it("lists a pending approval raised on another replica", async () => {
    const bus = new FakeRedisBus();
    const a = makeReplica(bus);
    const b = makeReplica(bus);
    await a.start();
    await b.start();

    // Park a request on replica A (do not await — it stays pending).
    const pending = a.request({
      executionId: "exec-1",
      nodeId: "n1",
      tool: "mcp/collections",
      args: { a: 1 },
    });
    // Let the local registry register + mirror to Redis.
    await new Promise((r) => setTimeout(r, 5));

    const listedOnB = await b.listPending();
    expect(listedOnB.length).toBe(1);
    const firstListed = listedOnB[0];
    if (firstListed === undefined)
      throw new Error("expected a first pending approval");
    expect(firstListed.tool).toBe("mcp/collections");

    // Clean up: resolve so the parked promise settles.
    await b.resolve(firstListed.id, { approved: false });
    await pending;
  });

  it("settles a waiter on replica A from a decision POSTed to replica B", async () => {
    const bus = new FakeRedisBus();
    const a = makeReplica(bus);
    const b = makeReplica(bus);
    await a.start();
    await b.start();

    const decisionPromise = a.request({
      executionId: "exec-2",
      nodeId: "n1",
      tool: "mcp/charge",
      args: {},
    });
    await new Promise((r) => setTimeout(r, 5));

    const pending = await b.listPending();
    const firstPending = pending[0];
    if (firstPending === undefined)
      throw new Error("expected a first pending approval");
    const ok = await b.resolve(firstPending.id, {
      approved: true,
      by: "alice",
    });
    expect(ok).toBe(true);

    const decision = await decisionPromise;
    expect(decision.approved).toBe(true);
    expect(decision.by).toBe("alice");

    // Mirror entry removed once settled → no longer listed anywhere.
    expect((await a.listPending()).length).toBe(0);
    const pendingKeys = [...bus.store.keys()].filter((k) =>
      k.startsWith("aiperator:approval:pending"),
    );
    expect(pendingKeys.length).toBe(0);
    // A short-lived resolved marker is retained so the approval widget can
    // re-render the final state from any replica.
    const resolved = await b.getResolved(firstPending.id);
    expect(resolved?.approved).toBe(true);
  });

  it("resolves directly when this replica owns the waiter", async () => {
    const bus = new FakeRedisBus();
    const a = makeReplica(bus);
    await a.start();

    const decisionPromise = a.request({
      executionId: "exec-3",
      nodeId: "n1",
      tool: "mcp/x",
      args: {},
    });
    await new Promise((r) => setTimeout(r, 5));
    const pending = await a.listPending();
    const firstPending = pending[0];
    if (firstPending === undefined)
      throw new Error("expected a first pending approval");
    const ok = await a.resolve(firstPending.id, {
      approved: false,
      reason: "no",
    });
    expect(ok).toBe(true);
    const decision = await decisionPromise;
    expect(decision.approved).toBe(false);
  });

  it("returns false when resolving an unknown approval id", async () => {
    const bus = new FakeRedisBus();
    const a = makeReplica(bus);
    await a.start();
    expect(await a.resolve("does-not-exist", { approved: true })).toBe(false);
  });

  it("sizes the mirror TTL from a per-request timeoutMs override (ADR-0009), not just the registry default", async () => {
    const bus = new FakeRedisBus();
    const sentCommands: { command: string; args: string[] }[] = [];
    const spyRedis: ApprovalRedis = {
      command: {
        send: async (command, args) => {
          sentCommands.push({ command: command.toUpperCase(), args });
          return bus.command().send(command, args);
        },
      },
      publish: bus.redis().publish,
      subscribe: bus.redis().subscribe,
      close: async () => {},
    };
    // Registry default timeoutMs=60_000 → default mirror TTL would be 90s.
    const local = mustCreateApprovalGate({ enabled: true, timeoutMs: 60_000 });
    const registry = new DistributedApprovalRegistry(local, spyRedis, 90);
    await registry.start();

    const pending = registry.request({
      executionId: "exec-ttl",
      nodeId: "n1",
      tool: "mcp/long-review",
      args: {},
      // A compliance-policy.yaml approvalRules[].timeoutMs of 10 minutes —
      // far longer than the registry's 60s default.
      timeoutMs: 600_000,
    });
    await new Promise((r) => setTimeout(r, 5));

    const setCall = sentCommands.find((c) => c.command === "SET");
    expect(setCall).toBeDefined();
    if (setCall === undefined) throw new Error("expected a SET command");
    const exIndex = setCall.args.findIndex((a) => a.toUpperCase() === "EX");
    expect(exIndex).toBeGreaterThan(-1);
    const ttlSeconds = Number(setCall.args[exIndex + 1]);
    // ceil(600_000 / 1000) + 30 = 630 — NOT the registry's fixed 90s, which
    // would let the cluster-wide mirror expire long before this waiter's
    // actual (10-minute) local timeout fires.
    expect(ttlSeconds).toBe(630);

    const listed = await registry.listPending();
    const firstListed = listed[0];
    if (firstListed === undefined)
      throw new Error("expected a first pending approval");
    await registry.resolve(firstListed.id, { approved: true, by: "alice" });
    await pending;
  });
});
