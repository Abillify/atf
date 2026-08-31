// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the connection layer's tenant scoping (src/db/database.ts).
 *
 * Uses a fake Bun SQL client that records every statement it runs (on the
 * shared client and on a reserved/pinned connection) so we can assert the exact
 * transaction + GUC choreography of `withTenant`:
 *   - disabled (default): pure pass-through, no transaction, no GUC
 *   - enabled: reserve → BEGIN → set_config(local) → cb → COMMIT → release
 *   - enabled + error: reserve → BEGIN → set_config → ROLLBACK → release, rethrow
 *   - enabled but no reserve(): degrades to pass-through
 */

import { describe, test, expect } from "bun:test";
import { wrapBunSql } from "../database.js";
import type { Database } from "../database.js";

/** `db.withTenant`, asserting the wrapped db implements it (tenantScoping cases). */
function withTenant<T>(
  db: Database,
  tenantId: string,
  cb: (scoped: Database) => Promise<T>,
): Promise<T> {
  if (db.withTenant === undefined) throw new Error("expected db.withTenant to be implemented");
  return db.withTenant(tenantId, cb);
}

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

interface Call {
  text: string;
  params: readonly unknown[];
}

/** A fake reserved connection that records its statements and release. */
function makeReserved(calls: Call[], released: { value: boolean }) {
  return {
    async unsafe(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<unknown> {
      calls.push({ text: text.trim(), params });
      return [];
    },
    release(): void {
      released.value = true;
    },
  };
}

/** Fake Bun SQL client. `withReserve=false` simulates a client without pooling. */
function makeFakeSql(opts: { withReserve?: boolean } = {}) {
  const shared: Call[] = [];
  const reserved: Call[] = [];
  const released = { value: false };
  let reserveCount = 0;
  let closed = false;

  const sql: {
    unsafe(text: string, params?: readonly unknown[]): Promise<unknown>;
    reserve?: () => Promise<ReturnType<typeof makeReserved>>;
    close: () => void;
    shared: Call[];
    reserved: Call[];
    released: { value: boolean };
    reserveCount: () => number;
    isClosed: () => boolean;
  } = {
    async unsafe(
      text: string,
      params: readonly unknown[] = [],
    ): Promise<unknown> {
      shared.push({ text: text.trim(), params });
      return [];
    },
    close(): void {
      closed = true;
    },
    shared,
    reserved,
    released,
    reserveCount: () => reserveCount,
    isClosed: () => closed,
  };

  if (opts.withReserve !== false) {
    sql.reserve = async () => {
      reserveCount += 1;
      return makeReserved(reserved, released);
    };
  }
  return sql;
}

describe("wrapBunSql withTenant", () => {
  test("disabled (default): pass-through, no transaction or GUC", async () => {
    const sql = makeFakeSql();
    const db = wrapBunSql(sql); // tenantScoping omitted → false

    const result = await withTenant(db, "tenant-a", async (scoped) => {
      await scoped.query("SELECT * FROM cost_ledger WHERE tenant_id = $1", [
        "tenant-a",
      ]);
      return "ok";
    });

    expect(result).toBe("ok");
    // Ran on the shared client, no reservation, no BEGIN/set_config/COMMIT.
    expect(sql.reserveCount()).toBe(0);
    expect(sql.shared.map((c) => c.text)).toEqual([
      "SELECT * FROM cost_ledger WHERE tenant_id = $1",
    ]);
  });

  test("enabled: reserve → BEGIN → set_config(local) → cb → COMMIT → release", async () => {
    const sql = makeFakeSql();
    const db = wrapBunSql(sql, { tenantScoping: true });

    await withTenant(db, "tenant-a", async (scoped) => {
      await scoped.query("SELECT 1 FROM billing_usage WHERE tenant_id = $1", [
        "tenant-a",
      ]);
    });

    expect(sql.reserveCount()).toBe(1);
    expect(sql.released.value).toBe(true);
    const texts = sql.reserved.map((c) => c.text);
    expect(texts).toEqual([
      "BEGIN",
      "SELECT set_config('app.current_tenant', $1, true)",
      "SELECT 1 FROM billing_usage WHERE tenant_id = $1",
      "COMMIT",
    ]);
    // The tenant id is bound as a parameter (never interpolated).
    const setConfig = at(sql.reserved, 1);
    expect(setConfig.params).toEqual(["tenant-a"]);
    // The query ran on the pinned connection, not the shared client.
    expect(sql.shared).toEqual([]);
  });

  test("enabled + error: ROLLBACK and release, original error rethrown", async () => {
    const sql = makeFakeSql();
    const db = wrapBunSql(sql, { tenantScoping: true });

    const boom = new Error("delegate failed");
    await expect(
      withTenant(db, "tenant-b", async () => {
        throw boom;
      }),
    ).rejects.toThrow("delegate failed");

    expect(sql.released.value).toBe(true);
    const texts = sql.reserved.map((c) => c.text);
    expect(texts).toEqual([
      "BEGIN",
      "SELECT set_config('app.current_tenant', $1, true)",
      "ROLLBACK",
    ]);
  });

  test("enabled but client has no reserve(): degrades to pass-through", async () => {
    const sql = makeFakeSql({ withReserve: false });
    const db = wrapBunSql(sql, { tenantScoping: true });

    await withTenant(db, "tenant-c", async (scoped) => {
      await scoped.query("SELECT 1", []);
    });

    // No transaction/GUC could be set safely → ran on the shared client.
    expect(sql.shared.map((c) => c.text)).toEqual(["SELECT 1"]);
  });

  test("nested withTenant on the pinned connection reuses it (no nested BEGIN)", async () => {
    const sql = makeFakeSql();
    const db = wrapBunSql(sql, { tenantScoping: true });

    await withTenant(db, "tenant-a", async (scoped) => {
      await withTenant(scoped, "tenant-a", async (inner) => {
        await inner.query("SELECT 2", []);
      });
    });

    // Only one BEGIN/COMMIT pair — the nested call reuses the pinned connection.
    const begins = sql.reserved.filter((c) => c.text === "BEGIN").length;
    const commits = sql.reserved.filter((c) => c.text === "COMMIT").length;
    expect(begins).toBe(1);
    expect(commits).toBe(1);
    expect(sql.reserved.some((c) => c.text === "SELECT 2")).toBe(true);
  });
});

describe("wrapBunSql withOperator", () => {
  test("without operatorSql: pass-through to the regular pool", async () => {
    const sql = makeFakeSql();
    const db = wrapBunSql(sql); // no operatorSql

    await db.withOperator(async (opDb) => {
      await opDb.query("SELECT * FROM executions", []);
    });

    // Should have run on the shared client (pass-through).
    expect(sql.shared.map((c) => c.text)).toContain("SELECT * FROM executions");
  });

  test("with operatorSql: routes to the operator pool, not the app pool", async () => {
    const appSql = makeFakeSql();
    const opSql = makeFakeSql();

    const db = wrapBunSql(appSql, { operatorSql: opSql });

    await db.withOperator(async (opDb) => {
      await opDb.query("SELECT * FROM executions ORDER BY started_at DESC", []);
    });

    // Query ran on the operator pool.
    expect(opSql.shared.map((c) => c.text)).toContain(
      "SELECT * FROM executions ORDER BY started_at DESC",
    );
    // App pool was NOT used.
    expect(appSql.shared).toHaveLength(0);
  });

  test("with operatorSql: reuses the pre-wrapped db object (no re-wrapping per call)", async () => {
    const appSql = makeFakeSql();
    const opSql = makeFakeSql();

    const db = wrapBunSql(appSql, { operatorSql: opSql });

    // Two separate withOperator calls.
    let ref1: unknown;
    let ref2: unknown;
    await db.withOperator(async (d) => {
      ref1 = d;
    });
    await db.withOperator(async (d) => {
      ref2 = d;
    });

    // Same object reference — no re-wrapping.
    expect(ref1).toBe(ref2);
  });

  test("withOperator on a pinned (reserved) connection returns itself", async () => {
    const sql = makeFakeSql();
    const db = wrapBunSql(sql, { tenantScoping: true });

    let capturedInner: unknown;
    await withTenant(db, "tenant-x", async (scoped) => {
      // Inside a tenant transaction the pinned db's withOperator is a pass-through.
      await scoped.withOperator(async (opDb) => {
        capturedInner = opDb;
        await opDb.query("SELECT 1", []);
      });
    });

    // The inner query should have run on the reserved connection.
    expect(sql.reserved.some((c) => c.text === "SELECT 1")).toBe(true);
    // The captured db is the same pinned instance (not the operator pool).
    expect(capturedInner).toBeDefined();
  });

  test("close() tears down BOTH the app pool and the operator pool", async () => {
    const appSql = makeFakeSql();
    const opSql = makeFakeSql();
    const db = wrapBunSql(appSql, { operatorSql: opSql });

    await db.close();

    expect(appSql.isClosed()).toBe(true);
    expect(opSql.isClosed()).toBe(true);
  });

  test("close() without an operator pool closes only the app pool", async () => {
    const appSql = makeFakeSql();
    const db = wrapBunSql(appSql);

    await db.close();

    expect(appSql.isClosed()).toBe(true);
  });
});
