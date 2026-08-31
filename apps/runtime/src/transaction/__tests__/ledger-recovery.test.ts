// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  CompensationRegistry,
  InMemoryInvocationLedger,
  RedisInvocationLedger,
  compensateInvocation,
  recoverStaleInvocations,
  type InvocationSideEffectDescriptor,
} from "../index.js";
import type { RedisClientLike } from "../../util/redis-client.js";

const readOnly = { tool: "records/read", semantics: "read_only" as const };
const write = { tool: "payments/charge", semantics: "non_idempotent" as const };

class ScriptRedis implements RedisClientLike {
  readonly values = new Map<string, string>();
  readonly scores = new Map<string, number>();
  async send(command: string, args: string[]): Promise<unknown> {
    if (command === "GET") return this.values.get(args[0] ?? "") ?? null;
    if (command === "ZRANGEBYSCORE") {
      const before = Number(args[2]);
      return [...this.scores].filter(([, score]) => score <= before).map(([id]) => id);
    }
    if (command !== "EVAL") throw new Error(`unsupported ${command}`);
    const key = args[3] ?? "";
    const index = args[4] ?? "";
    if (String(args[0]).includes("EXISTS")) {
      const existing = this.values.get(key);
      if (existing) return [0, existing];
      const raw = args[5] ?? "";
      this.values.set(key, raw);
      this.scores.set(args[7] ?? "", Number(args[6]));
      return [1, raw];
    }
    const raw = this.values.get(key);
    if (!raw) return [0, "missing"];
    const current = JSON.parse(raw) as { state: string };
    const allowed = (args[5] ?? "").split(",");
    if (!allowed.includes(current.state)) return [0, current.state];
    const next = args[6] ?? "";
    this.values.set(key, next);
    const parsed = JSON.parse(next) as { invocationId: string; updatedAt: number };
    this.scores.set(parsed.invocationId, parsed.updatedAt);
    void index;
    return [1, next];
  }
}

function input(invocationId: string, sideEffect: InvocationSideEffectDescriptor = readOnly) {
  return { invocationId, payloadFingerprint: `fp-${invocationId}`, sideEffect };
}

describe("durable invocation ledger", () => {
  test("atomically deduplicates concurrent claims through a shared Redis backend", async () => {
    const redis = new ScriptRedis();
    const replicas = [new RedisInvocationLedger(redis), new RedisInvocationLedger(redis)];
    const claims = await Promise.all(replicas.map((ledger) => ledger.claim(input("same"))));
    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.acquired)).toHaveLength(1);
  });

  test("rejects replay with the same invocation id", async () => {
    const ledger = new InMemoryInvocationLedger();
    expect(ledger.claim(input("replay")).acquired).toBe(true);
    expect(ledger.claim(input("replay")).acquired).toBe(false);
  });
});

describe("invocation recovery", () => {
  test("marks stale safe work retryable but leaves non-idempotent outcome unknown", async () => {
    let now = 10;
    const ledger = new InMemoryInvocationLedger(() => now);
    ledger.claim(input("read"));
    ledger.transition("read", "running");
    ledger.claim(input("write", write));
    ledger.transition("write", "running");
    now = 100;

    const recovered = await recoverStaleInvocations(ledger, 50);
    expect(recovered).toEqual({ retryable: ["read"], outcomeUnknown: ["write"] });
    expect(ledger.get("read")).toMatchObject({ state: "failed", retryable: true });
    expect(ledger.get("write")).toMatchObject({ state: "outcome_unknown", retryable: false });
  });

  test("does not classify a fresh running invocation as crashed", async () => {
    let now = 100;
    const ledger = new InMemoryInvocationLedger(() => now);
    ledger.claim(input("fresh"));
    ledger.transition("fresh", "running");
    now = 101;
    expect(await recoverStaleInvocations(ledger, 99)).toEqual({ retryable: [], outcomeUnknown: [] });
    expect(ledger.get("fresh")?.state).toBe("running");
  });
});

describe("compensation", () => {
  test("uses an explicit compensation id and records evidence", async () => {
    const ledger = new InMemoryInvocationLedger();
    ledger.claim(input("charge", { ...write, reversible: true }));
    ledger.transition("charge", "running");
    ledger.transition("charge", "committed");
    const registry = new CompensationRegistry();
    registry.register("payments/charge", async ({ compensationInvocationId }) => ({ reversedBy: compensationInvocationId }));

    const record = await compensateInvocation(ledger, registry, "charge", "comp-1");
    expect(record).toMatchObject({ state: "compensated", compensationInvocationId: "comp-1" });
    expect(record.resultEvidence?.summary).toContain("comp-1");
  });

  test("never compensates an irreversible action", async () => {
    const ledger = new InMemoryInvocationLedger();
    ledger.claim(input("irreversible", write));
    ledger.transition("irreversible", "running");
    ledger.transition("irreversible", "committed");
    await expect(compensateInvocation(ledger, new CompensationRegistry(), "irreversible", "comp-2")).rejects.toThrow("not declared reversible");
  });
});
