// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * RBAC of the autopilot routes: reading runs is a flow read, triggering a
 * cycle (which can promote a flow version) is a flow write.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createAutopilotRouter } from "../autopilot.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type { AutopilotEngine } from "../../autopilot/autopilot-engine.js";

const operatorAuth = createOperatorAuthorizer({
  authRequired: true,
  tokens: [
    { token: "admin-tok", role: "admin", name: "alice" },
    { token: "operator-tok", role: "operator", name: "olga" },
    { token: "viewer-tok", role: "viewer", name: "vic" },
  ],
});

function buildApp() {
  const triggered: string[] = [];
  const autopilot = {
    config: {},
    listAllRuns: () => [],
    listRuns: () => [],
    getRun: () => undefined,
    triggerManual: async (flowId: string) => {
      triggered.push(flowId);
      return { id: "run-1", flowId };
    },
  } as unknown as AutopilotEngine;
  const app = new Hono();
  app.route("/autopilot", createAutopilotRouter({ autopilot, operatorAuth }));
  return { app, triggered };
}

const trigger = (app: Hono, token: string) =>
  app.request("/autopilot/trigger", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ flowId: "helpdesk" }),
  });

describe("autopilot RBAC", () => {
  it("lets every role read runs", async () => {
    const { app } = buildApp();
    for (const token of ["viewer-tok", "operator-tok", "admin-tok"]) {
      const res = await app.request("/autopilot/runs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it("refuses a manual trigger below admin and never starts a cycle", async () => {
    const { app, triggered } = buildApp();
    for (const token of ["viewer-tok", "operator-tok"]) {
      expect((await trigger(app, token)).status).toBe(401);
    }
    expect(triggered).toEqual([]);
    expect((await trigger(app, "admin-tok")).status).toBe(202);
    expect(triggered).toEqual(["helpdesk"]);
  });
});
