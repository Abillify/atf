// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { invocationFingerprint, MemoryInvocationLedger, PostgresInvocationLedger, type PostgresInvocationExecutor } from "../src/invocation-ledger.js";

describe("InvocationLedger", () => {
  it("creates stable fingerprints independent of object key order", () => {
    expect(invocationFingerprint("ingest", { b: 2, a: { y: 2, x: 1 } }, "exec"))
      .toBe(invocationFingerprint("ingest", { a: { x: 1, y: 2 }, b: 2 }, "exec"));
    expect(invocationFingerprint("ingest", { a: 1 }, "exec")).not.toBe(invocationFingerprint("delete_document", { a: 1 }, "exec"));
  });

  it("atomically claims, rejects in-flight reuse, and replays committed results", async () => {
    const ledger = new MemoryInvocationLedger();
    const [first, second] = await Promise.all([ledger.claim("key", "fp"), ledger.claim("key", "fp")]);
    expect([first.kind, second.kind].sort()).toEqual(["claimed", "in_flight"]);
    await ledger.transition("key", "fp", "running");
    await ledger.transition("key", "fp", "committed", { value: 42 });
    await expect(ledger.claim("key", "fp")).resolves.toMatchObject({ kind: "replay", record: { result: { value: 42 } } });
  });

  it("reports payload mismatch and terminal unknown outcomes", async () => {
    const ledger = new MemoryInvocationLedger();
    await ledger.claim("key", "original");
    await expect(ledger.claim("key", "different")).resolves.toMatchObject({ kind: "mismatch" });
    await ledger.transition("key", "original", "outcome_unknown");
    await expect(ledger.claim("key", "original")).resolves.toMatchObject({ kind: "terminal", record: { state: "outcome_unknown" } });
  });

  it("initializes and classifies durable PostgreSQL claims", async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const responses = [
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 2 },
      { rows: [{ key: "key", fingerprint: "fp", state: "pending", result: null, updated_at: new Date(), inserted: true }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ key: "key", fingerprint: "fp", state: "committed", result: { value: 42 }, updated_at: new Date() }], rowCount: 1 },
    ];
    const executor: PostgresInvocationExecutor = {
      async queryInvocationLedger(sql, params) {
        calls.push({ sql, params });
        return responses.shift();
      },
    };
    const ledger = new PostgresInvocationLedger(executor, 60_000);
    expect(ledger.durability).toBe("postgres");
    await ledger.initialize();
    await expect(ledger.claim("key", "fp")).resolves.toMatchObject({ kind: "claimed" });
    await expect(ledger.claim("key", "fp")).resolves.toMatchObject({ kind: "replay", record: { result: { value: 42 } } });
    expect(calls[0].sql).toContain("CREATE TABLE IF NOT EXISTS vs_invocation_ledger");
    expect(calls[2].sql).toContain("expires_at <= now()");
    expect(calls[3].sql).toContain("ON CONFLICT (key) DO UPDATE");
  });

  it("uses fingerprint/state compare-and-transition and fails on conflicts", async () => {
    const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const executor: PostgresInvocationExecutor = {
      async queryInvocationLedger(sql, params) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    const ledger = new PostgresInvocationLedger(executor);
    await expect(ledger.transition("key", "fp", "committed", { ok: true }))
      .rejects.toThrow("transition conflict");
    expect(calls[0].sql).toContain("fingerprint = $2");
    expect(calls[0].sql).toContain("state IN ('pending', 'running')");
    expect(calls[0].params?.[3]).toBe(JSON.stringify({ ok: true }));
  });
});
