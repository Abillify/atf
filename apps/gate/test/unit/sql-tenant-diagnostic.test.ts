// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { diagnoseSqlTenantBinding } from "../../src/config/sql-tenant-diagnostic.ts";

describe("diagnoseSqlTenantBinding", () => {
  test.each([
    ["SELECT * FROM orders WHERE tenant_id = :ctx.tenantId", "safe"],
    ["SELECT * FROM orders o JOIN accounts a ON a.tenant_id = :ctx.tenantId", "safe"],
    ["UPDATE orders SET state = 'done' WHERE tenant_id = :ctx.tenantId", "safe"],
    ["DELETE FROM orders WHERE :ctx.tenantId = tenant_id", "safe"],
    ["INSERT INTO orders (tenant_id, title) VALUES (:ctx.tenantId, 'x')", "safe"],
    ["INSERT INTO orders (tenant_id, title) VALUES (:ctx.tenantId, 'x'), (:ctx.tenantId, 'y')", "safe"],
    ["INSERT INTO orders (title, tenant_id) SELECT title, :ctx.tenantId FROM staged", "safe"],
  ])("recognises meaningful tenant binding in %s", (sql, status) => {
    expect(diagnoseSqlTenantBinding(sql).status).toBe(status);
  });

  test.each([
    "SELECT ':ctx.tenantId' AS tenant FROM orders",
    "SELECT * FROM orders -- :ctx.tenantId\nWHERE active = true",
    "SELECT :ctx.tenantId AS tenant FROM orders",
    "SELECT * FROM orders WHERE :ctx.tenantId IS NOT NULL",
    "SELECT * FROM orders WHERE status = :ctx.tenantId",
    "SELECT * FROM orders WHERE tenant_id = :ctx.tenantId OR TRUE",
    "SELECT * FROM orders o JOIN accounts a ON a.tenant_id = :ctx.tenantId OR TRUE",
    "UPDATE orders SET state = 'done' WHERE tenant_id = :ctx.tenantId OR TRUE",
    "DELETE FROM orders WHERE tenant_id = :ctx.tenantId OR TRUE",
    "UPDATE orders SET tenant_id = :ctx.tenantId",
    "DELETE FROM orders WHERE tenant_id != :ctx.tenantId",
    "INSERT INTO orders (title, tenant_id) VALUES (:ctx.tenantId, 'fixed')",
    "INSERT INTO orders (tenant_id, title) VALUES (:ctx.tenantId, 'ok'), ('other', 'unsafe')",
  ])("does not accept non-filtering tenant presence in %s", (sql) => {
    expect(diagnoseSqlTenantBinding(sql).status).toBe("unsafe");
  });

  test("reports unsupported statements as unknown", () => {
    expect(diagnoseSqlTenantBinding("MERGE INTO orders USING x ON orders.tenant_id = :ctx.tenantId").status)
      .toBe("unknown");
  });

  test("reports malformed SQL as parse-error", () => {
    expect(diagnoseSqlTenantBinding("SELECT * FROM orders WHERE tenant_id = :ctx.tenantId /*").status)
      .toBe("parse-error");
  });
});
