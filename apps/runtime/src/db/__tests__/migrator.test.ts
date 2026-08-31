// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the automatic schema migrator (src/db/migrator.ts).
 *
 * Uses a fake Database that interprets just enough SQL to exercise the
 * migrator's bookkeeping: version detection, applying only pending migrations
 * in order, recording applied versions, and idempotency across reruns.
 */

import { describe, test, expect } from "bun:test";
import type { Database } from "../database.js";
import { runMigrations } from "../migrator.js";
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from "../migrations.js";

/** In-memory fake that tracks applied versions and executed DDL statements. */
function makeFakeDb(): Database & {
  applied: number[];
  ddl: string[];
} {
  const applied: number[] = [];
  const ddl: string[] = [];

  const db: Database & { applied: number[]; ddl: string[] } = {
    applied,
    ddl,
    async query<T = Record<string, unknown>>(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      const sql = text.trim();
      if (sql.startsWith("SELECT pg_advisory")) return [] as T[];
      if (sql.startsWith("SELECT 1")) return [{}] as T[];
      if (sql.includes("max(version)")) {
        const max = applied.length > 0 ? Math.max(...applied) : null;
        return [{ version: max }] as unknown as T[];
      }
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations"))
        return [] as T[];
      if (
        sql.startsWith("BEGIN") ||
        sql.startsWith("COMMIT") ||
        sql.startsWith("ROLLBACK")
      )
        return [] as T[];
      if (sql.startsWith("INSERT INTO schema_migrations")) {
        const version = params[0] as number;
        if (!applied.includes(version)) applied.push(version);
        return [] as T[];
      }
      // Any other statement is migration DDL.
      ddl.push(sql);
      return [] as T[];
    },
    async close(): Promise<void> {},
    async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
      return cb(this);
    },
  };
  return db;
}

describe("runMigrations", () => {
  test("applies all migrations on a fresh database", async () => {
    const db = makeFakeDb();
    const result = await runMigrations(db);

    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toEqual(MIGRATIONS.map((m) => m.version));
    // Every migration's statements were executed.
    const totalStatements = MIGRATIONS.reduce(
      (n, m) => n + m.statements.length,
      0,
    );
    expect(db.ddl.length).toBe(totalStatements);
  });

  test("is idempotent — a second run applies nothing", async () => {
    const db = makeFakeDb();
    await runMigrations(db);
    const ddlAfterFirst = db.ddl.length;

    const second = await runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.fromVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(second.toVersion).toBe(LATEST_SCHEMA_VERSION);
    // No further DDL executed on the second run.
    expect(db.ddl.length).toBe(ddlAfterFirst);
  });

  test("applies only pending migrations when partially up to date", async () => {
    const db = makeFakeDb();
    // Pretend version 1 is already applied.
    db.applied.push(1);

    const result = await runMigrations(db);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(result.applied).toEqual(
      MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version),
    );
  });

  test("acquires and releases the advisory lock", async () => {
    const locks: string[] = [];
    const base = makeFakeDb();
    const db: Database = {
      async query<T = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        if (text.includes("pg_advisory_lock")) locks.push("lock");
        if (text.includes("pg_advisory_unlock")) locks.push("unlock");
        return base.query<T>(text, params);
      },
      close: base.close,
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    await runMigrations(db);
    expect(locks).toEqual(["lock", "unlock"]);
  });

  test("rolls back transaction on failed DDL statement", async () => {
    const ddlExecuted: string[] = [];
    const db: Database = {
      async query<T = Record<string, unknown>>(
        text: string,
        _params?: readonly unknown[],
      ): Promise<T[]> {
        const sql = text.trim();
        ddlExecuted.push(sql);
        if (sql.includes("CREATE TABLE IF NOT EXISTS executions")) {
          throw new Error("Simulated DDL failure");
        }
        return [] as T[];
      },
      async close(): Promise<void> {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };

    await expect(runMigrations(db)).rejects.toThrow("Simulated DDL failure");
    expect(ddlExecuted).toContain("BEGIN");
    expect(ddlExecuted).toContain("ROLLBACK");
    expect(ddlExecuted).not.toContain("COMMIT");
  });
});
