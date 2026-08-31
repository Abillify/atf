// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the compliance / data-retention admin routes.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createComplianceRouter } from "../compliance.js";
import {
  RetentionService,
  type RetentionTarget,
  type ErasureSubject,
} from "../../observability/retention.js";
import { InMemoryAuditLog } from "../../observability/audit-log.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";

const adminAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "admin-tok", role: "admin", name: "alice" },
    { token: "viewer-tok", role: "viewer" },
  ],
});

class FakeTarget implements RetentionTarget {
  cutoffs: string[] = [];
  subjects: ErasureSubject[] = [];
  constructor(
    public readonly name: string,
    private readonly counts = { age: 2, erase: 3 },
  ) {}
  purgeOlderThan = async (c: string): Promise<number> => {
    this.cutoffs.push(c);
    return this.counts.age;
  };
  eraseSubject = async (s: ErasureSubject): Promise<number> => {
    this.subjects.push(s);
    return this.counts.erase;
  };
}

function buildApp() {
  const target = new FakeTarget("snapshots");
  const auditLog = new InMemoryAuditLog();
  const retention = new RetentionService([target], {
    maxAgeDaysByTarget: { snapshots: 30 },
  });
  const app = new Hono();
  app.route(
    "/",
    createComplianceRouter({ retention, operatorAuth: adminAuth, auditLog }),
  );
  return { app, target, auditLog };
}

const authed = (body?: unknown, token = "admin-tok") => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe("GET /admin/compliance/status", () => {
  it("returns target capabilities for an admin", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/status", {
      headers: { Authorization: "Bearer admin-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: Array<{ name: string; maxAgeDays: number | null }>;
    };
    expect(body.targets[0]).toMatchObject({
      name: "snapshots",
      agePurge: true,
      maxAgeDays: 30,
    });
  });

  it("rejects a non-admin (viewer) with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/status", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /admin/compliance/sweep", () => {
  it("runs a sweep and records an audit entry", async () => {
    const { app, target, auditLog } = buildApp();
    const res = await app.request("/admin/compliance/sweep", authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: number };
    expect(body.purged).toBe(2);
    expect(target.cutoffs).toHaveLength(1);
    const audit = await auditLog.list();
    expect(audit[0]).toMatchObject({
      action: "compliance.sweep",
      actor: "alice",
    });
  });
});

describe("POST /admin/compliance/forget", () => {
  it("erases a subject and records an audit entry", async () => {
    const { app, target, auditLog } = buildApp();
    const res = await app.request(
      "/admin/compliance/forget",
      authed({ tenantId: "acme", userId: "u@x.de" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      erased: number;
      subject: ErasureSubject;
    };
    expect(body.erased).toBe(3);
    expect(body.subject).toEqual({ tenantId: "acme", userId: "u@x.de" });
    expect(target.subjects[0]).toEqual({ tenantId: "acme", userId: "u@x.de" });
    const audit = await auditLog.list();
    expect(audit[0]).toMatchObject({
      action: "compliance.forget",
      target: "acme",
    });
  });

  it("rejects an empty subject with 400", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/forget", authed({}));
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON with 400", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/forget", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-tok",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "acme" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/compliance/dossier", () => {
  it("returns a JSON dossier for an admin and records an audit entry", async () => {
    const { app, auditLog } = buildApp();
    const res = await app.request("/admin/compliance/dossier", {
      headers: { Authorization: "Bearer admin-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auditIntegrity: { chainVerification: { valid: boolean } };
      retentionPosture: { targets: unknown[] };
      architecturalGuarantees: unknown[];
    };
    expect(body.auditIntegrity.chainVerification.valid).toBe(true);
    expect(body.retentionPosture.targets).toHaveLength(1);
    expect(body.architecturalGuarantees.length).toBeGreaterThan(0);

    const audit = await auditLog.list();
    expect(audit[0]).toMatchObject({ action: "compliance.dossier.generate" });
  });

  it("returns a markdown dossier when format=markdown", async () => {
    const { app } = buildApp();
    const res = await app.request(
      "/admin/compliance/dossier?format=markdown",
      { headers: { Authorization: "Bearer admin-tok" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("# Compliance Dossier");
  });

  it("rejects a non-admin (viewer) with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/admin/compliance/dossier", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(401);
  });
});
