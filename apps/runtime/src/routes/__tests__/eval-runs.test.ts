// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the eval-run-history admin routes
 * (`src/routes/eval-runs.ts`).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createEvalRunsRouter } from "../eval-runs.js";
import { InMemoryEvalRunHistory } from "../../eval/eval-run-history.js";
import { InMemoryAuditLog } from "../../observability/audit-log.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type { EvalReport } from "../../eval/eval-runner.js";

const adminAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "admin-tok", role: "admin", name: "alice" },
    { token: "viewer-tok", role: "viewer" },
  ],
});

function buildApp() {
  const history = new InMemoryEvalRunHistory();
  const auditLog = new InMemoryAuditLog();
  const app = new Hono();
  app.route("/", createEvalRunsRouter({ history, operatorAuth: adminAuth, auditLog }));
  return { app, history, auditLog };
}

const VALID_REPORT: EvalReport = {
  name: "ds-a",
  total: 4,
  passed: 3,
  failed: 1,
  passRate: 0.75,
  totalCost: 0.02,
  avgLatencyMs: 250,
  cases: [],
};

describe("POST /admin/eval/runs", () => {
  it("records a valid eval report and audits the action", async () => {
    const { app, history, auditLog } = buildApp();
    const res = await app.request("/admin/eval/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-tok" },
      body: JSON.stringify({ report: VALID_REPORT, source: "ci" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: { name: string; source: string } };
    expect(body.record.name).toBe("ds-a");
    expect(body.record.source).toBe("ci");

    const list = await history.listRecent();
    expect(list).toHaveLength(1);

    const audit = await auditLog.list();
    expect(audit[0]).toMatchObject({ action: "eval.run.record", target: "ds-a" });
  });

  it("defaults source to 'manual' when omitted", async () => {
    const { app, history } = buildApp();
    await app.request("/admin/eval/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-tok" },
      body: JSON.stringify({ report: VALID_REPORT }),
    });
    const list = await history.listRecent();
    const first = list[0];
    if (first === undefined) throw new Error("expected a recorded run");
    expect(first.source).toBe("manual");
  });

  it("rejects a malformed report body with 400", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/eval/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-tok" },
      body: JSON.stringify({ report: { not: "a report" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/eval/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer admin-tok" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a viewer (needs monitoring:write) with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/eval/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer viewer-tok" },
      body: JSON.stringify({ report: VALID_REPORT }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/eval/runs", () => {
  it("lists recorded runs for a viewer", async () => {
    const { app, history } = buildApp();
    await history.record({ name: "ds-a", source: "ci", report: VALID_REPORT });
    const res = await app.request("/admin/eval/runs", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ name: string }> };
    expect(body.runs).toHaveLength(1);
    const first = body.runs[0];
    if (first === undefined) throw new Error("expected a run");
    expect(first.name).toBe("ds-a");
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/eval/runs");
    expect(res.status).toBe(401);
  });
});
