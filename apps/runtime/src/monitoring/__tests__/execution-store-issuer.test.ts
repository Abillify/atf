// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Issuer-scoped self-service erasure (DSAR) in PostgresExecutionStore.
 *
 * Query-shape tests against a recording fake `Database`: the real SQL
 * semantics (two issuers with a colliding `sub`, legacy `iss IS NULL` rows) are
 * covered by the Postgres integration test in db/__tests__/pg-integration.test.ts,
 * which only runs with TEST_POSTGRES_URL.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "../../db/database.js";
import { PostgresExecutionStore } from "../execution-store.js";

interface Call {
  sql: string;
  params: readonly unknown[];
}

function fakeDb(ownedIds: string[] = ["e-1"]): { db: Database; calls: Call[] } {
  const calls: Call[] = [];
  const db: Database = {
    query: (async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT execution_id FROM token_usage_log")) {
        return ownedIds.map((execution_id) => ({ execution_id }));
      }
      if (sql.includes("DELETE FROM executions")) {
        return ownedIds.map((execution_id) => ({ execution_id }));
      }
      return [];
    }) as Database["query"],
    close: async () => {},
    withOperator: async <T>(cb: (d: Database) => Promise<T>) => cb(db),
  };
  return { db, calls };
}

const lookup = (calls: Call[]): Call => {
  const call = calls.find((c) =>
    c.sql.includes("SELECT execution_id FROM token_usage_log"),
  );
  if (call === undefined) throw new Error("ownership lookup not issued");
  return call;
};

describe("PostgresExecutionStore — issuer-scoped erasure", () => {
  test("a subject issuer limits both ownership branches to (iss = issuer OR iss IS NULL)", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db);
    const erased = await store.eraseSubject({
      tenantId: "acme",
      userId: "u-1",
      issuer: "https://idp-a.example/",
    });
    expect(erased).toBe(1);
    const call = lookup(calls);
    expect(call.params).toEqual([
      JSON.stringify(["u-1"]),
      "acme",
      "https://idp-a.example/",
    ]);
    // Once per branch of the UNION (usage log + executions).
    expect(call.sql.match(/\(iss = \$3 OR iss IS NULL\)/g)).toHaveLength(2);
    expect(call.sql.match(/tenant_id = \$2/g)).toHaveLength(2);
  });

  test("the issuer placeholder follows the tenant-less parameter list", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db);
    await store.executionIdsForSubject({
      userId: "u-1",
      issuer: "https://idp-a.example/",
    });
    const call = lookup(calls);
    expect(call.params).toEqual([JSON.stringify(["u-1"]), "https://idp-a.example/"]);
    expect(call.sql).toContain("(iss = $2 OR iss IS NULL)");
    expect(call.sql).not.toContain("tenant_id");
  });

  test("without an issuer the match is by identifier alone (operator and legacy callers)", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db);
    await store.eraseSubject({ tenantId: "acme", userId: "u-1" });
    const call = lookup(calls);
    expect(call.params).toEqual([JSON.stringify(["u-1"]), "acme"]);
    expect(call.sql).not.toContain("iss");
  });

  test("the request boundary persists the issuer on executions and the usage log", async () => {
    const { db, calls } = fakeDb();
    const store = new PostgresExecutionStore(db);
    store.recordEvent(
      {
        execution_id: "e-1",
        node_id: "__request__",
        status: "running",
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        latency_ms: 0,
        user_id: "u-1",
      },
      { tenantId: "acme", issuer: "https://idp-a.example/" },
    );
    await store.flush();
    const inserts = calls.filter(
      (c) =>
        c.sql.includes("INSERT INTO executions") ||
        c.sql.includes("INSERT INTO token_usage_log"),
    );
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      expect(insert.params).toContain("https://idp-a.example/");
      expect(insert.sql).toContain("iss");
    }
  });
});
