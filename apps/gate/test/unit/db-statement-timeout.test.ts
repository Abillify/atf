// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-dialect statement timeout.
 *
 * Without a cap, one pathological tool query holds a connection-pool slot until
 * the client goes away — and since tool calls arrive over long-lived MCP
 * sessions, "the client goes away" can be never. The mapping from Knex client
 * name to SQL is the entire substance of the feature: a wrong or missing dialect
 * name leaves the cap silently off, which is why it is tested directly rather
 * than only through a live database.
 */

import { describe, expect, test } from "bun:test";
import { statementTimeoutHook, statementTimeoutSql } from "../../src/db/manager.ts";
import { DatabaseConfigSchema } from "../../src/config/schema.ts";

describe("statementTimeoutSql · postgres family", () => {
  test("emits SET statement_timeout in milliseconds", () => {
    expect(statementTimeoutSql("pg", 30_000)).toBe("SET statement_timeout = 30000");
  });

  test("covers the common Knex aliases", () => {
    for (const client of ["pg", "postgres", "postgresql", "PG", "CockroachDB"]) {
      expect(statementTimeoutSql(client, 5_000)).toBe("SET statement_timeout = 5000");
    }
  });
});

describe("statementTimeoutSql · mysql family", () => {
  test("emits MAX_EXECUTION_TIME in milliseconds", () => {
    expect(statementTimeoutSql("mysql2", 10_000)).toBe(
      "SET SESSION MAX_EXECUTION_TIME = 10000",
    );
  });

  test("covers mysql and mariadb aliases", () => {
    for (const client of ["mysql", "mysql2", "mariadb"]) {
      expect(statementTimeoutSql(client, 1_000)).toContain("MAX_EXECUTION_TIME");
    }
  });
});

describe("statementTimeoutSql · sql server", () => {
  test("emits LOCK_TIMEOUT in milliseconds", () => {
    expect(statementTimeoutSql("mssql", 15_000)).toBe("SET LOCK_TIMEOUT 15000");
  });
});

describe("statementTimeoutSql · dialects without a session cap", () => {
  test("returns undefined rather than inventing SQL", () => {
    for (const client of ["sqlite3", "better-sqlite3", "oracledb"]) {
      expect(statementTimeoutSql(client, 30_000)).toBeUndefined();
    }
  });
});

describe("statementTimeoutSql · disabling", () => {
  test("0 disables the timeout", () => {
    expect(statementTimeoutSql("pg", 0)).toBeUndefined();
  });

  test("a negative or non-finite value disables it rather than emitting garbage", () => {
    expect(statementTimeoutSql("pg", -1)).toBeUndefined();
    expect(statementTimeoutSql("pg", Number.NaN)).toBeUndefined();
    expect(statementTimeoutSql("pg", Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test("a fractional value is floored to an integer (no decimal in SQL)", () => {
    expect(statementTimeoutSql("pg", 1500.9)).toBe("SET statement_timeout = 1500");
  });
});

describe("DatabaseConfigSchema", () => {
  test("defaults the timeout to 30s so an unmodified config is capped", () => {
    const parsed = DatabaseConfigSchema.parse({
      client: "pg",
      connection: "postgres://app@db/app",
    });
    expect(parsed.statementTimeoutMs).toBe(30_000);
  });

  test("accepts an explicit override, including 0 to opt out", () => {
    expect(
      DatabaseConfigSchema.parse({
        client: "pg",
        connection: "x",
        statementTimeoutMs: 0,
      }).statementTimeoutMs,
    ).toBe(0);
    expect(
      DatabaseConfigSchema.parse({
        client: "pg",
        connection: "x",
        statementTimeoutMs: "5000",
      }).statementTimeoutMs,
    ).toBe(5_000);
  });

  test("rejects a negative timeout", () => {
    expect(() =>
      DatabaseConfigSchema.parse({
        client: "pg",
        connection: "x",
        statementTimeoutMs: -5,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The pool hook — the actual enforcement path
// ---------------------------------------------------------------------------

describe("statementTimeoutHook", () => {
  test("returns no hook for a dialect without a session cap", () => {
    expect(statementTimeoutHook("sqlite3", 30_000).afterCreate).toBeUndefined();
  });

  test("returns no hook when the timeout is disabled", () => {
    expect(statementTimeoutHook("pg", 0).afterCreate).toBeUndefined();
  });

  test("runs the dialect SQL on a freshly created connection", async () => {
    const hook = statementTimeoutHook("pg", 7_500).afterCreate;
    const executed: string[] = [];
    const conn = {
      query(sql: string, cb: (err?: unknown) => void) {
        executed.push(sql);
        cb();
      },
    };

    const passedBack = await new Promise<unknown>((resolve) => {
      hook(conn, (_err, c) => resolve(c));
    });

    expect(executed).toEqual(["SET statement_timeout = 7500"]);
    // The connection must be handed back, or the pool stalls.
    expect(passedBack).toBe(conn);
  });

  /**
   * A database user without permission to change the setting must not take the
   * pool down. The cap is a safety net, not a prerequisite — but the failure has
   * to be visible rather than assumed, hence the warning in the implementation.
   */
  test("a failing SET is non-fatal and still yields the connection", async () => {
    const hook = statementTimeoutHook("pg", 1_000).afterCreate;
    const conn = {
      query(_sql: string, cb: (err?: unknown) => void) {
        cb(new Error("permission denied to set parameter"));
      },
    };

    const result = await new Promise<{ err: unknown; conn: unknown }>((resolve) => {
      hook(conn, (err, c) => resolve({ err, conn: c }));
    });

    expect(result.err).toBeUndefined();
    expect(result.conn).toBe(conn);
  });

  test("a driver without query() is skipped rather than crashing the pool", async () => {
    const hook = statementTimeoutHook("pg", 1_000).afterCreate;
    const conn = { notAQuery: true };

    const result = await new Promise<{ err: unknown; conn: unknown }>((resolve) => {
      hook(conn, (err, c) => resolve({ err, conn: c }));
    });

    expect(result.err).toBeUndefined();
    expect(result.conn).toBe(conn);
  });
});
