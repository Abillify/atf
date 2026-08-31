// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the RLS onboarding helper (`src/db/rls-onboarding.ts`).
 *
 * All I/O is faked via a minimal `Database` stub that dispatches on the SQL
 * text — no real Postgres is needed to exercise the decision logic.
 */

import { describe, test, expect } from "bun:test";
import {
  checkRlsOnboarding,
  applyRlsOnboarding,
  RLS_TENANT_TABLES,
} from "../rls-onboarding.js";
import type { Database } from "../database.js";

type RlsRow = {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
};

interface FakeDbState {
  rlsRows: RlsRow[];
  tenantsTableExists: boolean;
  tenantCount: number;
  rolesPresent: string[];
  queries: string[];
}

function createFakeDb(state: FakeDbState): Database {
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      _params?: readonly unknown[],
    ): Promise<T[]> {
      state.queries.push(text.trim());
      const t = text.trim();

      if (t.startsWith("SELECT c.relname")) {
        return state.rlsRows as unknown as T[];
      }
      if (t.includes("information_schema.tables")) {
        return [{ exists: state.tenantsTableExists }] as unknown as T[];
      }
      if (t.startsWith("SELECT COUNT(*)")) {
        return [{ count: state.tenantCount }] as unknown as T[];
      }
      if (t.startsWith("SELECT rolname")) {
        return state.rolesPresent.map((rolname) => ({ rolname })) as unknown as T[];
      }
      // DDL statements (CREATE ROLE / GRANT / DO $$ ... $$) — no rows.
      return [] as T[];
    },
    async close(): Promise<void> {},
    async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
      return cb(this as unknown as Database);
    },
  };
}

function allTablesEnforced(): RlsRow[] {
  return RLS_TENANT_TABLES.map((table) => ({
    relname: table,
    relrowsecurity: true,
    relforcerowsecurity: true,
  }));
}

describe("checkRlsOnboarding", () => {
  test("reports fullyEnforced=true when every table is enabled + forced", async () => {
    const db = createFakeDb({
      rlsRows: allTablesEnforced(),
      tenantsTableExists: false,
      tenantCount: 0,
      rolesPresent: ["aiperator_app", "aiperator_operator"],
      queries: [],
    });
    const status = await checkRlsOnboarding(db);
    expect(status.fullyEnforced).toBe(true);
    expect(status.tables).toHaveLength(RLS_TENANT_TABLES.length);
    expect(status.tables.every((t) => t.exists && t.enabled && t.forced)).toBe(
      true,
    );
    expect(status.rolesConfigured).toBe(true);
  });

  test("reports fullyEnforced=false when a table is missing RLS enforcement", async () => {
    const rows = allTablesEnforced();
    const row0 = rows[0];
    if (row0 === undefined) throw new Error("expected a first row");
    row0.relforcerowsecurity = false; // one table only ENABLEd, not FORCEd
    const db = createFakeDb({
      rlsRows: rows,
      tenantsTableExists: false,
      tenantCount: 0,
      rolesPresent: [],
      queries: [],
    });
    const status = await checkRlsOnboarding(db);
    expect(status.fullyEnforced).toBe(false);
    const affected = status.tables.find((t) => t.table === row0.relname);
    if (affected === undefined) throw new Error("expected the affected table entry");
    expect(affected.enabled).toBe(true);
    expect(affected.forced).toBe(false);
  });

  test("reports a table as not existing when pg_class has no matching row", async () => {
    const db = createFakeDb({
      rlsRows: [], // no rows at all — nothing exists yet
      tenantsTableExists: false,
      tenantCount: 0,
      rolesPresent: [],
      queries: [],
    });
    const status = await checkRlsOnboarding(db);
    expect(status.fullyEnforced).toBe(false);
    expect(status.tables.every((t) => !t.exists)).toBe(true);
  });

  test("detects multi-tenant deployment when the tenants table has >1 row", async () => {
    const db = createFakeDb({
      rlsRows: allTablesEnforced(),
      tenantsTableExists: true,
      tenantCount: 5,
      rolesPresent: ["aiperator_app", "aiperator_operator"],
      queries: [],
    });
    const status = await checkRlsOnboarding(db);
    expect(status.multiTenantDetected).toBe(true);
    expect(status.tenantCount).toBe(5);
  });

  test("does not flag multi-tenant when tenants table has 0 or 1 rows", async () => {
    const db = createFakeDb({
      rlsRows: allTablesEnforced(),
      tenantsTableExists: true,
      tenantCount: 1,
      rolesPresent: [],
      queries: [],
    });
    const status = await checkRlsOnboarding(db);
    expect(status.multiTenantDetected).toBe(false);
  });

  test("leaves multiTenantDetected undefined when the tenants table does not exist", async () => {
    const db = createFakeDb({
      rlsRows: allTablesEnforced(),
      tenantsTableExists: false,
      tenantCount: 0,
      rolesPresent: [],
      queries: [],
    });
    const status = await checkRlsOnboarding(db);
    expect(status.multiTenantDetected).toBeUndefined();
    expect(status.tenantCount).toBeUndefined();
  });

  test("rolesConfigured is false when only one of the two roles exists", async () => {
    const db = createFakeDb({
      rlsRows: allTablesEnforced(),
      tenantsTableExists: false,
      tenantCount: 0,
      rolesPresent: ["aiperator_app"],
      queries: [],
    });
    const status = await checkRlsOnboarding(db);
    expect(status.rolesConfigured).toBe(false);
  });
});

describe("applyRlsOnboarding", () => {
  test("refuses to run without explicit confirm: true", async () => {
    const db = createFakeDb({
      rlsRows: [],
      tenantsTableExists: false,
      tenantCount: 0,
      rolesPresent: [],
      queries: [],
    });
    await expect(
      applyRlsOnboarding(db, { confirm: false as unknown as true }),
    ).rejects.toThrow("confirm");
  });

  test("executes the setup statements and re-verifies when confirmed", async () => {
    const state: FakeDbState = {
      rlsRows: [],
      tenantsTableExists: false,
      tenantCount: 0,
      rolesPresent: [],
      queries: [],
    };
    const db = createFakeDb(state);

    // After the DDL "runs" (no-op in the fake), simulate the tables becoming
    // enforced so the post-apply verification reflects a real Postgres.
    const originalQuery = db.query.bind(db);
    let ddlRan = 0;
    db.query = (async (text: string, params?: readonly unknown[]) => {
      if (text.trim().startsWith("SELECT c.relname") && ddlRan > 0) {
        return allTablesEnforced() as unknown as never;
      }
      if (!text.trim().startsWith("SELECT")) ddlRan++;
      return originalQuery(text, params);
    }) as typeof db.query;

    const result = await applyRlsOnboarding(db, { confirm: true });
    expect(result.statementsApplied).toBeGreaterThan(0);
    expect(result.status.fullyEnforced).toBe(true);
  });

  test("reports fullyEnforced=false in the result when verification still finds gaps", async () => {
    const db = createFakeDb({
      rlsRows: [], // stays empty even after "applying" — simulates a failure
      tenantsTableExists: false,
      tenantCount: 0,
      rolesPresent: [],
      queries: [],
    });
    const result = await applyRlsOnboarding(db, { confirm: true });
    expect(result.status.fullyEnforced).toBe(false);
  });
});
