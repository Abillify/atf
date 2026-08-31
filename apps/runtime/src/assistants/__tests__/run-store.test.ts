// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { Database } from "../../db/database.js";
import { nextCronOccurrence } from "../cron-schedule.js";
import {
  AssistantRunRecoverySweeper,
  PostgresAssistantRunStore,
  type AssistantRun,
} from "../run-store.js";

const ROW = {
  id: "00000000-0000-4000-8000-000000000001", tenant_id: "tenant", user_id: "user",
  assistant_id: "assistant", status: "running", origin: "internal", attempt: 1, max_attempts: 2,
  resume_payload: { flowId: "flow", message: "hello" }, created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z", lease_expires_at: "2026-01-01T00:01:00.000Z",
};

function database(onQuery: (sql: string) => Record<string, unknown>[]): Database {
  const db: Database = {
    query: async <T>(sql: string) => onQuery(sql) as T[],
    close: async () => {},
    withOperator: async <T>(callback: (inner: Database) => Promise<T>) => callback(db),
  };
  return db;
}

describe("assistant cron scheduling", () => {
  test("calculates the next standard five-field UTC occurrence", () => {
    expect(nextCronOccurrence("*/15 9-10 * * 1-5", new Date("2026-08-07T09:07:30.000Z")).toISOString())
      .toBe("2026-08-07T09:15:00.000Z");
  });

  test("uses standard OR semantics when day-of-month and day-of-week are both restricted", () => {
    expect(nextCronOccurrence("0 0 1 * 1", new Date("2026-08-01T00:00:00.000Z")).toISOString())
      .toBe("2026-08-03T00:00:00.000Z");
  });
});

describe("PostgresAssistantRunStore", () => {
  test("atomically claims queued work and returns its dispatch scope", async () => {
    const queries: string[] = [];
    const store = new PostgresAssistantRunStore(database((sql) => {
      queries.push(sql);
      return sql.includes("WITH candidates") ? [ROW] : [];
    }));
    const runs = await store.claimQueued();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.scope).toEqual({ tenantId: "tenant", userId: "user", assistantId: "assistant" });
    expect(queries[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(queries[0]).toContain("attempt=r.attempt+1");
  });

  test("requeues recoverable expired leases and fails exhausted leases in one guarded update", async () => {
    let recoverySql = "";
    const store = new PostgresAssistantRunStore(database((sql) => { recoverySql = sql; return []; }));
    await store.recoverExpired();
    expect(recoverySql).toContain("attempt<max_attempts THEN 'queued'");
    expect(recoverySql).toContain("ELSE 'failed'");
    expect(recoverySql).toContain("lease_expires_at<=now()");
  });

  test("uses a transaction and the schedule idempotency fence when materializing due schedules", async () => {
    const queries: string[] = [];
    const store = new PostgresAssistantRunStore(database((sql) => { queries.push(sql); return []; }));
    await store.claimDue();
    const scheduleSql = queries.join("\n");
    expect(scheduleSql).toContain("BEGIN");
    expect(scheduleSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(scheduleSql).toContain("COMMIT");
  });
});

describe("AssistantRunRecoverySweeper", () => {
  test("dispatches only claimed runs and settles success and failure", async () => {
    const calls: string[] = [];
    const claimed: AssistantRun[] = [
      { id: "ok", scope: { tenantId: "t", userId: "u", assistantId: "a" }, status: "running", origin: "internal", attempt: 1, maxAttempts: 2, resumePayload: {}, createdAt: "", updatedAt: "" },
      { id: "bad", scope: { tenantId: "t", userId: "u", assistantId: "a" }, status: "running", origin: "internal", attempt: 1, maxAttempts: 2, resumePayload: {}, createdAt: "", updatedAt: "" },
    ];
    const store = {
      recoverExpired: async () => { calls.push("recover"); },
      claimDue: async () => { calls.push("schedules"); return []; },
      claimQueued: async () => { calls.push("claim"); return claimed; },
      settle: async (_scope: unknown, id: string, succeeded: boolean) => { calls.push(`settle:${id}:${succeeded}`); },
    } as unknown as PostgresAssistantRunStore;
    const sweeper = new AssistantRunRecoverySweeper(store, async (run) => {
      calls.push(`dispatch:${run.id}`);
      if (run.id === "bad") throw new Error("engine failed");
    });
    await sweeper.tick();
    expect(calls).toEqual([
      "recover", "schedules", "claim", "dispatch:ok", "settle:ok:true", "dispatch:bad", "settle:bad:false",
    ]);
  });
});
