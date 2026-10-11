// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { DatabaseToolExecutor } from "../../src/tools/database-tool.ts";
import { DatabaseToolSchema } from "../../src/config/schema.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import type { DbProvider, QueryRunner } from "../../src/db/manager.ts";
import type { AuthContext } from "../../src/auth/context.ts";

// Req 6.7: "WHEN authorizationEnabled=false, THE Gate SHALL evaluate privileged
// conditions as false." A scopes-based condition guards privileged SQL
// branches ({{if:privileged}}); with business authorization disabled there is
// no verified scope set, so the privileged branch must stay hidden even for a
// caller whose (unverified) context carries the admin scope.

const adminScopeCtx: AuthContext = {
  method: "static",
  subject: "s",
  username: "alice",
  scopes: ["timesheets:admin"],
  claims: { role: "support" },
  headers: {},
  rawToken: "t",
};

interface Recorded {
  sql: string;
  bindings: unknown;
}

function fakeDb(rows: unknown[] = []): { db: DbProvider; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const runner: QueryRunner = {
    raw: async (sql: string, bindings?: unknown) => {
      calls.push({ sql, bindings });
      return { rows };
    },
  };
  const db: DbProvider = {
    get: () => runner,
    names: () => ["main"],
    clientName: () => "pg",
    healthcheck: async () => true,
    destroyAll: async () => {},
  };
  return { db, calls };
}

const privilegedCfg = DatabaseToolSchema.parse({
  name: "t",
  type: "database",
  database: "main",
  query:
    "SELECT {{if:privileged}}secret_col FROM admin_tbl{{else}}public_col FROM public_tbl{{endif}}",
  conditions: {
    privileged: { all: [{ context: "scopes", containsAny: ["timesheets:admin"] }] },
  },
});

describe("DatabaseToolExecutor · privileged conditions with authorizationEnabled=false (Req 6.7)", () => {
  it("does NOT render the privileged SQL branch, even with the admin scope in the context", async () => {
    const { db, calls } = fakeDb();
    const exec = new DatabaseToolExecutor(privilegedCfg, {
      db,
      bus: new MonitorBus(),
      authorizationEnabled: false,
    });
    await exec.execute({}, adminScopeCtx);
    expect(calls[0]?.sql).toContain("public_col FROM public_tbl");
    expect(calls[0]?.sql).not.toContain("secret_col");
    expect(calls[0]?.sql).not.toContain("admin_tbl");
  });

  it("keeps redaction guards active even if their condition would be false (fail closed)", async () => {
    const rows = [{ id: 1, email: "a@example.com" }];
    const { db } = fakeDb(rows);
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "select 1",
      // isAdmin is FALSE for this support role → with authorization enabled
      // nothing is masked; with it disabled the guard stays active to be safe
      // (over-redaction instead of a data leak, as before).
      conditions: { isAdmin: { all: [{ context: "claims.role", equals: "admin" }] } },
      redact: [{ column: "email", when: "isAdmin", strategy: "mask", placeholder: "[redacted]" }],
    });
    const exec = new DatabaseToolExecutor(cfg, {
      db,
      bus: new MonitorBus(),
      authorizationEnabled: false,
    });
    const res = await exec.execute({}, adminScopeCtx);
    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.rows[0].email).toBe("[redacted]");
    // Comparison point: with authorization enabled isAdmin=false → unmasked.
    const execOn = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus() });
    const resOn = await execOn.execute({}, adminScopeCtx);
    expect(JSON.parse(resOn.content[0]!.text).rows[0].email).toBe("a@example.com");
  });

  it("explain() shows privileged conditions as false", async () => {
    const { db } = fakeDb();
    const exec = new DatabaseToolExecutor(privilegedCfg, {
      db,
      bus: new MonitorBus(),
      authorizationEnabled: false,
    });
    const res = await exec.explain({}, adminScopeCtx);
    const plan = JSON.parse(res.content[0]!.text);
    expect(plan.conditions.privileged).toBe(false);
    expect(plan.sql).toContain("public_col");
    expect(plan.sql).not.toContain("secret_col");
  });

  it("keeps evaluating non-privileged conditions normally", async () => {
    const { db, calls } = fakeDb();
    const cfg = DatabaseToolSchema.parse({
      name: "t",
      type: "database",
      database: "main",
      query: "SELECT {{if:isSupport}}support_view{{else}}other_view{{endif}}",
      // Claim based, reads no scopes → not a privileged guard in the sense of
      // ADR-0002; evaluated normally with authorization disabled.
      conditions: { isSupport: { all: [{ context: "claims.role", equals: "support" }] } },
    });
    const exec = new DatabaseToolExecutor(cfg, {
      db,
      bus: new MonitorBus(),
      authorizationEnabled: false,
    });
    await exec.execute({}, adminScopeCtx);
    expect(calls[0]?.sql).toContain("support_view");
  });

  it("with authorization enabled the admin scope renders the privileged branch", async () => {
    const { db, calls } = fakeDb();
    const exec = new DatabaseToolExecutor(privilegedCfg, { db, bus: new MonitorBus() });
    await exec.execute({}, adminScopeCtx);
    expect(calls[0]?.sql).toContain("secret_col FROM admin_tbl");
  });
});
