// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { InMemoryEvalRunHistory, PostgresEvalRunHistory, createEvalRunHistory } from "../eval-run-history.js";
import type { EvalReport } from "../eval-runner.js";
import type { Database } from "../../db/database.js";

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`expected an element at index ${index}`);
  return value;
}
function makeReport(name: string, passRate: number): EvalReport {
  const passed = Math.round(passRate * 10);
  return { name, total: 10, passed, failed: 10 - passed, passRate, totalCost: 0.01, avgLatencyMs: 100, cases: [] };
}

describe("InMemoryEvalRunHistory", () => {
  it("records and lists newest-first", async () => {
    const history = new InMemoryEvalRunHistory();
    await history.record({ name: "ds-a", source: "ci", report: makeReport("ds-a", 1) });
    await history.record({ name: "ds-b", source: "manual", report: makeReport("ds-b", 0.5) });
    const list = await history.listRecent();
    expect(at(list, 0).name).toBe("ds-b");
    expect(at(list, 1).name).toBe("ds-a");
  });
  it("latestFor returns the most recent run for a given dataset name", async () => {
    const history = new InMemoryEvalRunHistory();
    await history.record({ name: "ds-a", source: "ci", report: makeReport("ds-a", 0.5) });
    await history.record({ name: "ds-a", source: "manual", report: makeReport("ds-a", 0.9) });
    expect((await history.latestFor("ds-a"))?.report.passRate).toBe(0.9);
  });
  it("latestFor returns undefined for an unknown dataset", async () => {
    expect(await new InMemoryEvalRunHistory().latestFor("nope")).toBeUndefined();
  });
  it("evicts the oldest entry beyond maxEntries", async () => {
    const history = new InMemoryEvalRunHistory(2);
    for (const name of ["a", "b", "c"]) await history.record({ name, source: "ci", report: makeReport(name, 1) });
    expect((await history.listRecent(100)).map((record) => record.name)).toEqual(["c", "b"]);
  });
});

function fakeDb(overrides: Partial<Database> = {}): Database {
  const database: Database = {
    query: (async () => []) as Database["query"],
    close: async () => {},
    withOperator: async <T>(callback: (db: Database) => Promise<T>) => callback(database),
    ...overrides,
  };
  return database;
}

describe("PostgresEvalRunHistory", () => {
  it("writes through to the database on record()", async () => {
    const inserts: unknown[][] = [];
    const database = fakeDb({ query: (async (text: string, params?: readonly unknown[]) => {
      if (/^INSERT/i.test(text.trim())) inserts.push([...(params ?? [])]);
      return [];
    }) as Database["query"] });
    await new PostgresEvalRunHistory(database).record({ name: "ds-a", source: "ci", report: makeReport("ds-a", 1) });
    expect(inserts).toHaveLength(1);
    expect(at(at(inserts, 0), 1)).toBe("ds-a");
  });
  it("falls back to the in-memory mirror when the insert fails", async () => {
    const history = new PostgresEvalRunHistory(fakeDb({ query: (async () => { throw new Error("db down"); }) as Database["query"] }));
    const record = await history.record({ name: "ds-a", source: "manual", report: makeReport("ds-a", 0.7) });
    expect(record.name).toBe("ds-a");
    const list = await history.listRecent();
    expect(list).toHaveLength(1);
    expect(at(list, 0).name).toBe("ds-a");
  });
  it("latestFor falls back to the mirror on query failure", async () => {
    const database = fakeDb({ query: (async (text: string) => {
      if (/^INSERT/i.test(text.trim())) return [];
      throw new Error("db down");
    }) as Database["query"] });
    const history = new PostgresEvalRunHistory(database);
    await history.record({ name: "ds-a", source: "ci", report: makeReport("ds-a", 1) });
    expect((await history.latestFor("ds-a"))?.name).toBe("ds-a");
  });
});

describe("createEvalRunHistory", () => {
  it("returns in-memory when no db is given", () => expect(createEvalRunHistory()).toBeInstanceOf(InMemoryEvalRunHistory));
  it("returns Postgres-backed when a db is given", () => expect(createEvalRunHistory(fakeDb())).toBeInstanceOf(PostgresEvalRunHistory));
});

describe("PostgresEvalRunHistory mirror reconciliation", () => {
  it("keeps a mirrored record visible after a failed insert even when reads recover", async () => {
    let failInsert = true;
    const database = fakeDb({ query: (async (text: string) => {
      if (/^INSERT/i.test(text.trim()) && failInsert) {
        failInsert = false;
        throw new Error("temporary outage");
      }
      return [];
    }) as Database["query"] });
    const history = new PostgresEvalRunHistory(database);
    await history.record({ name: "ds-a", source: "ci", report: makeReport("ds-a", 1) });
    expect((await history.listRecent()).map((record) => record.name)).toEqual(["ds-a"]);
    expect((await history.latestFor("ds-a"))?.name).toBe("ds-a");
  });
});
