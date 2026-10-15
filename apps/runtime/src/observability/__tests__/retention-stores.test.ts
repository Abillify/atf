// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for store-level retention (purgeOlderThan / eraseSubject) on the
 * in-memory stores, plus the RetentionTarget adapters.
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryReplayStore,
  type ExecutionSnapshot,
} from "../../graph/replay.js";
import { InMemoryExecutionStore } from "../../monitoring/execution-store.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import {
  replayRetentionTarget,
  executionHistoryRetentionTarget,
  memoryRetentionTarget,
  RETENTION_TARGET,
} from "../retention-targets.js";
import type { MemoryStore, MemoryScope } from "../../graph/memory-store.js";
import type { RetentionTarget, ErasureSubject } from "../retention.js";

/** `target.purgeOlderThan`, asserting the target implements age-purge. */
function mustPurgeOlderThan(target: RetentionTarget, cutoffIso: string): Promise<number> {
  if (target.purgeOlderThan === undefined) throw new Error("expected purgeOlderThan to be implemented");
  return target.purgeOlderThan(cutoffIso);
}

/** `target.eraseSubject`, asserting the target implements subject-erasure. */
function mustEraseSubject(target: RetentionTarget, subject: ErasureSubject): Promise<number> {
  if (target.eraseSubject === undefined) throw new Error("expected eraseSubject to be implemented");
  return target.eraseSubject(subject);
}

function snap(over: Partial<ExecutionSnapshot>): ExecutionSnapshot {
  return {
    executionId: over.executionId ?? crypto.randomUUID(),
    flowId: over.flowId ?? "flow",
    messages: over.messages ?? [{ role: "user", content: "hi" }],
    responseText: over.responseText ?? "ok",
    createdAt: over.createdAt ?? new Date().toISOString(),
    ...(over.metadata !== undefined ? { metadata: over.metadata } : {}),
    ...(over.tenantId !== undefined ? { tenantId: over.tenantId } : {}),
    ...(over.userId !== undefined ? { userId: over.userId } : {}),
  };
}

describe("InMemoryReplayStore retention", () => {
  it("purges snapshots older than the cutoff and keeps newer ones", async () => {
    const store = new InMemoryReplayStore();
    await store.save(
      snap({ executionId: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    await store.save(
      snap({ executionId: "new", createdAt: "2026-02-01T00:00:00.000Z" }),
    );

    const removed = await store.purgeOlderThan("2026-01-15T00:00:00.000Z");

    expect(removed).toBe(1);
    expect(await store.get("old")).toBeUndefined();
    expect(await store.get("new")).toBeDefined();
    expect((await store.list()).map((s) => s.executionId)).toEqual(["new"]);
  });

  it("erases by tenant and narrows by user", async () => {
    const store = new InMemoryReplayStore();
    await store.save(
      snap({ executionId: "a", tenantId: "acme", userId: "u1" }),
    );
    await store.save(
      snap({ executionId: "b", tenantId: "acme", userId: "u2" }),
    );
    await store.save(
      snap({ executionId: "c", tenantId: "other", userId: "u1" }),
    );

    expect(await store.eraseSubject({ tenantId: "acme", userId: "u1" })).toBe(
      1,
    );
    expect(await store.get("a")).toBeUndefined();
    expect(await store.get("b")).toBeDefined();

    expect(await store.eraseSubject({ tenantId: "acme" })).toBe(1); // b
    expect(await store.get("b")).toBeUndefined();
    expect(await store.get("c")).toBeDefined();
  });

  it("matches subject via metadata fallback when dedicated fields are absent", async () => {
    const store = new InMemoryReplayStore();
    await store.save(
      snap({ executionId: "m", metadata: { tenant: "acme", user_id: "u9" } }),
    );
    expect(await store.eraseSubject({ tenantId: "acme", userId: "u9" })).toBe(
      1,
    );
    expect(await store.get("m")).toBeUndefined();
  });
});

function ev(over: Partial<NodeExecutionEvent>): NodeExecutionEvent {
  return {
    execution_id: over.execution_id ?? "e",
    node_id: over.node_id ?? "n",
    status: over.status ?? "completed",
    start_time: over.start_time ?? new Date().toISOString(),
    end_time: over.end_time ?? new Date().toISOString(),
    latency_ms: over.latency_ms ?? 10,
  };
}

describe("InMemoryExecutionStore retention", () => {
  it("purges executions started before the cutoff", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(
      ev({ execution_id: "old", start_time: "2026-01-01T00:00:00.000Z" }),
    );
    store.recordEvent(
      ev({ execution_id: "new", start_time: "2026-02-01T00:00:00.000Z" }),
    );

    const removed = await store.purgeOlderThan("2026-01-15T00:00:00.000Z");
    expect(removed).toBe(1);
    expect((await store.listRecent(10)).map((e) => e.execution_id)).toEqual([
      "new",
    ]);
  });

  it("erases executions by tenant for a subject without user identifiers", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev({ execution_id: "a" }), { tenantId: "acme" });
    store.recordEvent(ev({ execution_id: "b" }), { tenantId: "other" });

    expect(await store.eraseSubject({ userId: "someone" })).toBe(0); // owns nothing
    expect(await store.eraseSubject({ tenantId: "acme" })).toBe(1);
    expect((await store.listRecent(10)).map((e) => e.execution_id)).toEqual([
      "b",
    ]);
  });

  it("erases only the user's executions for a user-scoped subject (DSAR)", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent({ ...ev({ execution_id: "mine-sub" }), user_id: "u-1" }, { tenantId: "acme" });
    store.recordEvent({ ...ev({ execution_id: "mine-mail" }), user_name: "u@x.de" }, { tenantId: "acme" });
    store.recordEvent({ ...ev({ execution_id: "colleague" }), user_id: "u-2" }, { tenantId: "acme" });
    store.recordEvent({ ...ev({ execution_id: "anonymous" }) }, { tenantId: "acme" });
    store.recordEvent({ ...ev({ execution_id: "elsewhere" }), user_id: "u-1" }, { tenantId: "other" });

    const subject = { tenantId: "acme", userId: "u@x.de", userAliases: ["u-1"] };
    expect((await store.executionIdsForSubject(subject)).sort()).toEqual([
      "mine-mail",
      "mine-sub",
    ]);
    expect(await store.eraseSubject(subject)).toBe(2);
    expect((await store.listRecent(10)).map((e) => e.execution_id).sort()).toEqual([
      "anonymous",
      "colleague",
      "elsewhere",
    ]);
    // A tenant-only subject still has no user to resolve.
    expect(await store.executionIdsForSubject({ tenantId: "acme" })).toEqual([]);
  });
});

describe("retention target adapters", () => {
  it("exposes age-purge + subject-erase for replay snapshots", async () => {
    const store = new InMemoryReplayStore();
    await store.save(
      snap({
        executionId: "x",
        tenantId: "acme",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const target = replayRetentionTarget(store);
    expect(target.name).toBe(RETENTION_TARGET.replaySnapshots);
    expect(await mustPurgeOlderThan(target, "2021-01-01T00:00:00.000Z")).toBe(1);
  });

  it("exposes age-purge + tenant-erase for execution history", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev({ execution_id: "a" }), { tenantId: "acme" });
    const target = executionHistoryRetentionTarget(store);
    expect(target.name).toBe(RETENTION_TARGET.executionHistory);
    expect(await mustEraseSubject(target, { tenantId: "acme" })).toBe(1);
  });

  it("erases a user's long-term memory scope and ignores tenant-only subjects", async () => {
    const cleared: MemoryScope[] = [];
    const fakeMemory = {
      clear: async (scope: MemoryScope) => {
        cleared.push(scope);
        return 4;
      },
    } as unknown as MemoryStore;

    const target = memoryRetentionTarget(fakeMemory);
    expect(target.name).toBe(RETENTION_TARGET.longTermMemory);
    expect(target.purgeOlderThan).toBeUndefined(); // no cross-scope age purge

    expect(await mustEraseSubject(target, { tenantId: "acme" })).toBe(0); // no user → skipped
    expect(cleared).toHaveLength(0);

    expect(
      await mustEraseSubject(target, { tenantId: "acme", userId: "u@x.de" }),
    ).toBe(4);
    expect(cleared[0]).toEqual({ userId: "u@x.de", tenantId: "acme" });
  });
});
