// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { DatabaseToolExecutor } from "../../src/tools/database-tool.ts";
import { DatabaseToolSchema } from "../../src/config/schema.ts";
import { MonitorBus } from "../../src/monitor/events.ts";
import { FakeDb } from "../helpers/fake-db.ts";
import type { AuthContext } from "../../src/auth/context.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "u",
  username: "dev-user",
  scopes: [],
  claims: {},
  headers: {},
  rawToken: "",
};

describe("DatabaseToolExecutor.explain (dry-run)", () => {
  it("compiles SQL + bindings without querying the database", async () => {
    const db = new FakeDb({ main: [{ id: 1 }] });
    const cfg = DatabaseToolSchema.parse({
      name: "orders",
      type: "database",
      database: "main",
      query: "SELECT id FROM orders WHERE owner = :ctx.username AND id = :param.id",
      inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    });
    const exec = new DatabaseToolExecutor(cfg, { db, bus: new MonitorBus(10) });

    const res = await exec.explain({ id: 7 }, ctx);
    expect(res.meta?.dryRun).toBe(true);
    const plan = JSON.parse(res.content[0].text);
    expect(plan.sql).toContain("SELECT id FROM orders");
    expect(plan.bindings).toEqual(["dev-user", 7]);
    // No query was actually run.
    expect(db.calls).toHaveLength(0);
  });
});
