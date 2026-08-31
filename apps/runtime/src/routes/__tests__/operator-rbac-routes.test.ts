// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for operator RBAC + audit on the flows and monitoring
 * routers — role enforcement and audit recording.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createFlowsRouter } from "../flows.js";
import { createMonitoringRouter } from "../../monitoring/monitoring-service.js";
import { InMemoryFlowStore } from "../../graph/flow-store.js";
import { InMemoryAuditLog } from "../../observability/audit-log.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";

function fileRegistry(...flows: FlowDefinition[]): FlowRegistry {
  const m = new Map(flows.map((f) => [f.id, f]));
  return { get: (id) => m.get(id), list: () => [...m.values()] };
}

const def = (id: string): FlowDefinition => ({
  id,
  name: id,
  nodes: [
    { id: "n", type: "llm", llm: { provider: "openai", model: "gpt-4o-mini" } },
  ],
  edges: [],
});

const authorizer = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "viewer-tok", role: "viewer", name: "vicky" },
    { token: "admin-tok", role: "admin", name: "alice" },
  ],
});

const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

describe("flows RBAC", () => {
  async function seededApp() {
    const store = new InMemoryFlowStore();
    await store.saveDraft("f", def("f"));
    await store.publish("f");
    await store.saveDraft("f", def("f")); // a fresh draft to publish
    const audit = new InMemoryAuditLog();
    const app = new Hono();
    app.route(
      "/",
      createFlowsRouter({
        fileRegistry: fileRegistry(),
        store,
        operatorAuth: authorizer,
        auditLog: audit,
      }),
    );
    return { app, audit };
  }

  it("lets a viewer read flows", async () => {
    const { app } = await seededApp();
    const res = await app.request("/flows", bearer("viewer-tok"));
    expect(res.status).toBe(200);
  });

  it("forbids a viewer from publishing", async () => {
    const { app, audit } = await seededApp();
    const res = await app.request("/flows/f/publish", {
      method: "POST",
      ...bearer("viewer-tok"),
    });
    expect(res.status).toBe(401);
    expect(await audit.list()).toHaveLength(0); // nothing recorded for a denied write
  });

  it("lets an admin publish and records an audit entry", async () => {
    const { app, audit } = await seededApp();
    const res = await app.request("/flows/f/publish", {
      method: "POST",
      ...bearer("admin-tok"),
    });
    expect(res.status).toBe(200);
    const entries = await audit.list();
    const entry0 = entries[0];
    if (entry0 === undefined) throw new Error("expected an audit entry");
    expect(entry0.action).toBe("flows.publish");
    expect(entry0.actor).toBe("alice");
    expect(entry0.target).toBe("f");
  });

  it("rejects an unknown token", async () => {
    const { app } = await seededApp();
    expect((await app.request("/flows", bearer("nope"))).status).toBe(401);
  });
});

describe("monitoring/audit RBAC", () => {
  const fakeService = {
    getHistory: async () => [],
    getHistoryPage: async () => ({ executions: [], total: 0 }),
    getHistoryFacets: async () => ({ flows: [], users: [] }),
    getUsageLog: async () => [],
    getExecutionEvents: async () => [],
    getTransportType: () => "sse",
    hasConnectionCapacity: () => true,
    subscribe: () => () => {},
    emitNodeEvent: () => {},
  } as unknown as MonitoringServiceInterface;

  function app() {
    const audit = new InMemoryAuditLog();
    audit.record({
      actor: "alice",
      role: "admin",
      action: "flows.publish",
      target: "f",
    });
    const a = new Hono();
    a.route(
      "/",
      createMonitoringRouter(fakeService, {
        operatorAuth: authorizer,
        auditLog: audit,
      }),
    );
    return a;
  }

  it("lets an admin read the audit log", async () => {
    const res = await app().request("/monitoring/audit", bearer("admin-tok"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ action: string }> };
    const bodyEntry0 = body.entries[0];
    if (bodyEntry0 === undefined) throw new Error("expected an audit entry");
    expect(bodyEntry0.action).toBe("flows.publish");
  });

  it("forbids a viewer from reading the audit log (admin-only)", async () => {
    const res = await app().request("/monitoring/audit", bearer("viewer-tok"));
    expect(res.status).toBe(401);
  });

  it("lets an admin verify the audit chain and reports it valid", async () => {
    const res = await app().request(
      "/monitoring/audit/verify",
      bearer("admin-tok"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; checked: number };
    expect(body.valid).toBe(true);
    expect(body.checked).toBeGreaterThan(0);
  });

  it("forbids a viewer from verifying the audit chain (admin-only)", async () => {
    const res = await app().request(
      "/monitoring/audit/verify",
      bearer("viewer-tok"),
    );
    expect(res.status).toBe(401);
  });

  it("lets a viewer read monitoring history", async () => {
    const res = await app().request(
      "/monitoring/history",
      bearer("viewer-tok"),
    );
    expect(res.status).toBe(200);
  });
});
