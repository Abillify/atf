// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the durable autopilot run history
 * (`src/autopilot/autopilot-run-history.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  PostgresAutopilotRunHistory,
  createAutopilotRunHistory,
} from "../autopilot-run-history.js";
import { InMemoryAutopilotRunHistory, type AutopilotRun } from "../autopilot-engine.js";
import type { Database } from "../../db/database.js";

function makeRun(overrides: Partial<AutopilotRun> = {}): AutopilotRun {
  return {
    id: "ap-1",
    flowId: "flow-a",
    trigger: "manual",
    startedAt: new Date(0).toISOString(),
    status: "done",
    ...overrides,
  };
}

describe("PostgresAutopilotRunHistory", () => {
  it("writes through to the database and maps rows back", async () => {
    const inserts: unknown[][] = [];
    const db: Database = {
      async query<T = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        if (/^INSERT/i.test(text.trim())) {
          inserts.push([...(params ?? [])]);
          return [] as T[];
        }
        return [
          {
            id: "ap-1",
            flow_id: "flow-a",
            trigger: "manual",
            started_at: new Date(0),
            finished_at: new Date(1000),
            status: "done",
            bypass_rate: 0.3,
            optimizer_run_id: "opt-1",
            canary_registered: true,
            promoted_version: 2,
            optimization_goal: "improve robustness",
            trigger_signal: "error-rate",
            measured_error_rate: 0.2,
            measured_p95_ms: 4000,
            measured_quality_score: 0.7,
            error: null,
          },
        ] as unknown as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };

    const history = new PostgresAutopilotRunHistory(db);
    await history.record(
      makeRun({
        bypassRate: 0.3,
        optimizerRunId: "opt-1",
        canaryRegistered: true,
        promotedVersion: 2,
        optimizationGoal: "improve robustness",
        triggerSignal: "error-rate",
        measuredErrorRate: 0.2,
        measuredP95Ms: 4000,
        measuredQualityScore: 0.7,
        finishedAt: new Date(1000).toISOString(),
      }),
    );

    expect(inserts).toHaveLength(1);
    const insert0 = inserts[0];
    if (insert0 === undefined) throw new Error("expected an insert call");
    expect(insert0[0]).toBe("ap-1");
    expect(insert0[1]).toBe("flow-a");

    const list = await history.listByFlow("flow-a");
    expect(list).toHaveLength(1);
    const run0 = list[0];
    if (run0 === undefined) throw new Error("expected a run");
    expect(run0.id).toBe("ap-1");
    expect(run0.canaryRegistered).toBe(true);
    expect(run0.promotedVersion).toBe(2);
    expect(run0.measuredErrorRate).toBe(0.2);
  });

  it("falls back to the in-memory mirror when the query fails, and never throws on write failure", async () => {
    const db: Database = {
      async query<T = Record<string, unknown>>(text: string): Promise<T[]> {
        if (/^INSERT/i.test(text.trim())) throw new Error("db down");
        throw new Error("db down");
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    const history = new PostgresAutopilotRunHistory(db);
    // record() must not throw even though the underlying insert fails.
    await history.record(makeRun());
    const list = await history.listByFlow("flow-a");
    const run0 = list[0];
    if (run0 === undefined) throw new Error("expected a run");
    expect(run0.id).toBe("ap-1"); // served from mirror
  });

  it("respects the per-flow filter and limit", async () => {
    const db: Database = {
      async query<T = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        if (/^INSERT/i.test(text.trim())) return [] as T[];
        // Verify the flow_id and limit params are forwarded.
        expect(params?.[0]).toBe("flow-a");
        expect(params?.[1]).toBe(5);
        return [] as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    const history = new PostgresAutopilotRunHistory(db);
    await history.listByFlow("flow-a", 5);
  });
});

describe("createAutopilotRunHistory", () => {
  it("returns in-memory when no db is given", () => {
    expect(createAutopilotRunHistory()).toBeInstanceOf(
      InMemoryAutopilotRunHistory,
    );
  });

  it("returns a Postgres-backed history when a db is given", () => {
    const db = {} as Database;
    expect(createAutopilotRunHistory(db)).toBeInstanceOf(
      PostgresAutopilotRunHistory,
    );
  });
});

describe("InMemoryAutopilotRunHistory", () => {
  it("returns entries for a flow, newest first, bounded by limit", async () => {
    const history = new InMemoryAutopilotRunHistory();
    await history.record(makeRun({ id: "1" }));
    await history.record(makeRun({ id: "2" }));
    await history.record(makeRun({ id: "3", flowId: "flow-b" }));

    const flowA = await history.listByFlow("flow-a");
    expect(flowA.map((r) => r.id)).toEqual(["2", "1"]);

    const flowB = await history.listByFlow("flow-b");
    expect(flowB.map((r) => r.id)).toEqual(["3"]);

    expect(await history.listByFlow("flow-a", 1)).toHaveLength(1);
  });

  it("evicts the oldest entries beyond maxEntries", async () => {
    const history = new InMemoryAutopilotRunHistory(2);
    await history.record(makeRun({ id: "1" }));
    await history.record(makeRun({ id: "2" }));
    await history.record(makeRun({ id: "3" }));
    const all = await history.listByFlow("flow-a", 100);
    // Only the 2 most recent survive.
    expect(all.map((r) => r.id).sort()).toEqual(["2", "3"]);
  });
});
