// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for verifyRls() — the RLS startup verification function.
 */

import { describe, test, expect } from "bun:test";
import { verifyRls } from "../persistence.js";
import type { Database } from "../../db/database.js";
import type { Logger } from "../../observability/logger.js";

function createFakeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => createFakeLogger(),
  } as unknown as Logger;
}

function createFakeDb(
  rows: Array<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>,
): Database {
  return {
    query: async () => rows,
    close: async () => {},
    withOperator: async <T>(cb: (db: Database) => Promise<T>) =>
      cb({} as Database),
  } as unknown as Database;
}

const ALL_TABLES = [
  "cost_ledger",
  "token_usage_log",
  "billing_usage",
  "executions",
  "execution_snapshots",
  "tenant_provider_keys",
  "pii_vault_entries",
  "assistant_rocketchat_bindings",
  "assistant_rocketchat_outbox",
  "rocketchat_connect_requests",
  "analysis_artifacts",
];

describe("verifyRls", () => {
  test("returns true when all tenant tables have RLS enabled and forced", async () => {
    const rows = ALL_TABLES.map((t) => ({
      relname: t,
      relrowsecurity: true,
      relforcerowsecurity: true,
    }));
    const result = await verifyRls(createFakeDb(rows), createFakeLogger());
    expect(result).toBe(true);
  });

  test("returns false when a table has relrowsecurity=false", async () => {
    const rows = ALL_TABLES.map((t) => ({
      relname: t,
      relrowsecurity: t !== "executions",
      relforcerowsecurity: true,
    }));
    const result = await verifyRls(createFakeDb(rows), createFakeLogger());
    expect(result).toBe(false);
  });

  test("returns false when a table has relforcerowsecurity=false", async () => {
    const rows = ALL_TABLES.map((t) => ({
      relname: t,
      relrowsecurity: true,
      relforcerowsecurity: t !== "billing_usage",
    }));
    const result = await verifyRls(createFakeDb(rows), createFakeLogger());
    expect(result).toBe(false);
  });

  test("returns false when a table is missing from pg_class results", async () => {
    // Omit cost_ledger from results
    const rows = ALL_TABLES.filter((t) => t !== "cost_ledger").map((t) => ({
      relname: t,
      relrowsecurity: true,
      relforcerowsecurity: true,
    }));
    const result = await verifyRls(createFakeDb(rows), createFakeLogger());
    expect(result).toBe(false);
  });

  test("returns false when database query throws", async () => {
    const db = {
      query: async () => {
        throw new Error("connection lost");
      },
      close: async () => {},
      withOperator: async <T>(cb: (db: Database) => Promise<T>) =>
        cb({} as Database),
    } as unknown as Database;
    // verifyRls itself throws — the caller in buildPersistence catches it.
    await expect(verifyRls(db, createFakeLogger())).rejects.toThrow(
      "connection lost",
    );
  });

  test("returns false when no tables are returned at all (empty result)", async () => {
    const result = await verifyRls(createFakeDb([]), createFakeLogger());
    expect(result).toBe(false);
  });
});
